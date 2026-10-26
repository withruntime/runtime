import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { startArgv, zonedTime } from "../src/jobs-import";

/* `runtime jobs import` against a stub API: the plan is what the Rust
   planner (engines/machine/crates/jobs-import) answers for AWS's
   batch-register.json with its EventBridge schedule; the route itself runs
   the binary in packages/cloud/tests/job-import-rust.test.ts. */

const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const PLAN = {
  from: "aws-batch",
  read: ["batch-register.json", "eventbridge-schedule.json"],
  jobs: [
    {
      name: "fetch_and_run",
      file: "batch-register.json",
      sourceImage: "123456789012.dkr.ecr.us-east-1.amazonaws.com/fetch_and_run:latest",
      dockerfile:
        'FROM 123456789012.dkr.ecr.us-east-1.amazonaws.com/fetch_and_run:latest\nENV BATCH_FILE_TYPE="script"\nCMD ["myjob.sh","s3://my-bucket/myjob.sh","full"]\n',
      command: null,
      env: { BATCH_FILE_TYPE: "script" },
      secrets: [{ name: "API_TOKEN", from: "Secrets Manager secret arn:aws:secretsmanager:..." }],
      compute: { vcpu: 1, memoryMib: 1024, diskMib: 30720 },
      timeoutSeconds: 3600,
      retry: { maxAttempts: 3, backoffSeconds: 10 },
      schedule: { kind: "cron", expression: "15 * * * 1-5", timezone: "Europe/Berlin" },
      blocked: null,
    },
    {
      name: "mpi",
      file: "batch-register.json",
      sourceImage: "",
      dockerfile: "",
      command: null,
      env: {},
      secrets: [],
      compute: { vcpu: 1, memoryMib: 2048, diskMib: null },
      timeoutSeconds: 3600,
      retry: { maxAttempts: 1, backoffSeconds: 10 },
      schedule: null,
      blocked: "it is a multi-node parallel job; a Runtime job runs on one machine",
    },
  ],
  notes: [
    {
      level: "changed",
      file: "batch-register.json",
      key: "timeout.attemptDurationSeconds",
      job: "fetch_and_run",
      message: "its timeout of 7200 s is 3600 s, the longest a job's run lasts",
    },
  ],
  importable: true,
};
const SECRET = "33333333-3333-4333-8333-333333333333";
const IMAGE = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "job-fetch_and_run",
  version: 1,
  state: "ready",
  sizeMiB: 5000,
  start: { argv: ["/entry.sh", "myjob.sh", "s3://my-bucket/myjob.sh", "full"] },
};

type Seen = { line: string; body: string };
async function withStub(
  answer: (request: Request, path: string) => unknown,
  work: (seen: Seen[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({ line: `${request.method} ${url.pathname}`, body: await request.clone().text() });
    const value = answer(request, url.pathname);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}
function output(json = false) {
  const lines: string[] = [];
  return {
    lines,
    out: { json, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}
function files() {
  const dir = mkdtempSync(join(tmpdir(), "jobs-import-"));
  writeFileSync(join(dir, "batch-register.json"), "{}");
  writeFileSync(join(dir, "eventbridge-schedule.json"), "{}");
  return [join(dir, "batch-register.json"), join(dir, "eventbridge-schedule.json")];
}
const api = (secrets: unknown[], jobs: unknown[]) => (request: Request, path: string) => {
  if (path === "/v1/job-imports") return PLAN;
  if (path === "/v1/egress-secrets") return { secrets: [] };
  if (path === "/v1/secrets") return secrets;
  if (path === "/v1/jobs" && request.method === "GET") return { items: jobs, nextCursor: null };
  if (path === "/v1/images" && request.method === "POST") return IMAGE;
  if (path.startsWith("/v1/images/")) return IMAGE;
  if (path === "/v1/jobs" && request.method === "POST")
    return { id: "55555555-5555-4555-8555-555555555555", name: "fetch_and_run" };
  if (path.startsWith("/v1/jobs/")) return { id: "66666666-6666-4666-8666-666666666666" };
  return new Response(JSON.stringify({ error: { code: "not_found", message: path } }), {
    status: 404,
  });
};

test("--dry-run prints the plan and creates nothing", async () => {
  await withStub(api([], []), async (seen) => {
    const { lines, out } = output();
    expect(await run(["jobs", "import", ...files(), "--dry-run"], env, out)).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("✓ fetch_and_run");
    expect(text).toContain("15 * * * 1-5 Europe/Berlin");
    expect(text).toContain("✗ mpi");
    expect(text).toContain("changed: fetch_and_run: its timeout of 7200 s");
    // The image's whole build file, before anything is built.
    expect(text).toContain(`fetch_and_run: its image's Dockerfile\n${PLAN.jobs[0]!.dockerfile}`);
    expect(seen.map((s) => s.line)).toEqual(["POST /v1/job-imports"]);
    expect(JSON.parse(seen[0]!.body).files.map((f: { path: string }) => f.path)).toEqual([
      "batch-register.json",
      "eventbridge-schedule.json",
    ]);
  });
});

test("a secret the job read elsewhere must be stored for jobs first", async () => {
  await withStub(api([], []), async (seen) => {
    const { lines, out } = output();
    expect(await run(["jobs", "import", ...files()], env, out)).toBe(1);
    expect(lines.join("\n")).toContain(
      "API_TOKEN came from Secrets Manager secret arn:aws:secretsmanager:...; store it for jobs first",
    );
    expect(seen.some((s) => s.line === "POST /v1/images")).toBe(false);
  });
});

test("it builds the image from the plan and creates the job with the image's command", async () => {
  const secret = {
    id: SECRET,
    name: "API_TOKEN",
    ownerId: "p",
    createdBy: "p",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  await withStub(api([secret], []), async (seen) => {
    const { lines, out } = output();
    // mpi is blocked, so the import as a whole says not everything moved.
    expect(await run(["jobs", "import", ...files()], env, out)).toBe(1);
    const build = JSON.parse(seen.find((s) => s.line === "POST /v1/images")!.body);
    expect(build.name).toBe("job-fetch_and_run");
    expect(build.dockerfile).toBe(PLAN.jobs[0]!.dockerfile);
    const create = JSON.parse(seen.find((s) => s.line === "POST /v1/jobs")!.body);
    expect(create.name).toBe("fetch_and_run");
    expect(create.image).toBe(IMAGE.id);
    expect(create.command.argv).toEqual(IMAGE.start.argv);
    expect(create.schedule).toEqual({
      kind: "cron",
      expression: "15 * * * 1-5",
      timezone: "Europe/Berlin",
    });
    expect(create.compute).toMatchObject({
      vcpu: 1,
      memoryMiB: 1024,
      diskMiB: 30720,
      durationSeconds: 3600,
    });
    expect(create.retry).toEqual({ maxAttempts: 3, backoffSeconds: 10 });
    expect(create.secrets).toEqual([{ name: "API_TOKEN", secretId: SECRET }]);
    expect(lines.join("\n")).toContain("✓ fetch_and_run created 55555555");
  });
});

test("a job of the same name is updated and rescheduled, not made twice", async () => {
  const secret = {
    id: SECRET,
    name: "API_TOKEN",
    ownerId: "p",
    createdBy: "p",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  };
  const job = {
    id: "66666666-6666-4666-8666-666666666666",
    name: "fetch_and_run",
    state: "active",
  };
  await withStub(api([secret], [job]), async (seen) => {
    const { out } = output();
    await run(["jobs", "import", ...files()], env, out);
    const lines = seen.map((s) => s.line);
    expect(lines).not.toContain("POST /v1/jobs");
    expect(lines).toContain(`POST /v1/jobs/${job.id}:update`);
    expect(lines).toContain(`POST /v1/jobs/${job.id}:reschedule`);
  });
});

test("a wall-clock time in a zone is the instant it names", () => {
  expect(zonedTime("2026-11-01T03:00:00", "UTC")).toBe(Date.UTC(2026, 10, 1, 3));
  expect(zonedTime("2026-07-01T03:00:00", "Europe/Berlin")).toBe(Date.UTC(2026, 6, 1, 1));
  expect(zonedTime("2026-12-01T03:00", "America/Denver")).toBe(Date.UTC(2026, 11, 1, 10));
  expect(startArgv({ start: { command: "run.sh --x" } })).toEqual(["sh", "-c", "run.sh --x"]);
  expect(startArgv({ start: null })).toBeUndefined();
});
