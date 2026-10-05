import { expect, test } from "bun:test";
import { run, secretsCommand } from "../src/cli";
import { Runtime } from "../src/client";
import { ServiceUnavailableError } from "../src/errors";
import { jobBody } from "../src/products/jobs";
import { SecretPartlyStoredError } from "../src/products/secrets";

/* runtime.jobs, `runtime job`, and the jobs copy of `runtime secrets`, against
   a stub API. The routes themselves run over Postgres in packages/cloud
   (product-api.test.ts) and packages/db (cloud-jobs.test.ts). */

type Seen = { line: string; body: string; key: string | null };
async function withStub(
  answer: (request: Request, path: string) => unknown,
  work: (seen: Seen[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({
      line: `${request.method} ${url.pathname}${url.search}`,
      body: await request.clone().text(),
      key: request.headers.get("idempotency-key"),
    });
    const value = answer(request, url.pathname);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
function output(json = false) {
  const lines: string[] = [];
  return {
    lines,
    out: { json, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}
const runtime = () =>
  new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test", maxRetries: 2 });
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";
const JOB = {
  id: JOB_ID,
  name: "nightly",
  definition: {
    name: "nightly",
    schedule: { kind: "cron", expression: "0 3 * * *", timezone: "Europe/Berlin" },
    compute: {},
    command: { argv: ["echo", "hi"] },
    timeoutSeconds: 1800,
    retry: { maxAttempts: 1, backoffSeconds: 30 },
    secrets: [],
  },
  state: "active",
  version: 1,
  nextRunAt: Date.parse("2026-10-01T01:00:00Z"),
  blockedReason: null,
  createdAt: 0,
  updatedAt: 0,
};
const RUN = {
  id: RUN_ID,
  jobId: JOB_ID,
  occurrenceId: "o",
  attempt: 1,
  scheduledFor: 0,
  resourceId: "r",
  state: "succeeded",
  runGeneration: 1,
  executionEpoch: 1,
  deadlineAt: 2,
  startedAt: 1,
  endedAt: 2,
  exitCode: 0,
  reason: null,
  logBytes: 3,
  logsTruncated: false,
  createdAt: 0,
};
const COPY = {
  id: SECRET_ID,
  name: "DB_PASSWORD",
  ownerId: "p",
  createdBy: "p",
  version: 2,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

test("create fills in a 2 vCPU, 4 GiB run for 30 minutes and sends one idempotency key", async () => {
  await withStub(
    () => JOB,
    async (seen) => {
      const job = await runtime().jobs.create({
        name: "nightly",
        schedule: { cron: "0 3 * * *", timezone: "Europe/Berlin" },
        command: ["echo", "hi"],
      });
      expect(job.id).toBe(JOB_ID);
      expect(seen.map((s) => s.line)).toEqual(["POST /v1/jobs"]);
      expect(seen[0]!.key).toBeTruthy();
      expect(JSON.parse(seen[0]!.body)).toEqual({
        name: "nightly",
        schedule: { kind: "cron", expression: "0 3 * * *", timezone: "Europe/Berlin" },
        compute: {
          region: "us-east",
          vcpu: 2,
          cpuMode: "shared",
          cpuFloorMillis: 50,
          memoryMiB: 4096,
          diskMiB: 4096,
          durationSeconds: 1860,
        },
        command: { argv: ["echo", "hi"] },
        timeoutSeconds: 1800,
      });
    },
  );
});

test("create refuses a run bigger than a sandbox, a bad cron and a bad time before sending", () => {
  const base = { name: "x", schedule: { at: "now" as string }, command: ["true"] };
  expect(() =>
    jobBody({ ...base, schedule: { at: "2026-10-01T03:00:00Z" }, compute: { vcpu: 32 } }),
  ).toThrow(/at most 16 vCPU and 64 GiB/);
  expect(() => jobBody({ ...base, schedule: { at: 1 }, compute: { memoryMiB: 131072 } })).toThrow(
    /at most 16 vCPU/,
  );
  expect(() => jobBody({ ...base, schedule: { at: 1 }, compute: { diskMiB: 512 } })).toThrow(
    /at least 3072 MiB/,
  );
  // A disk is at most 400 GiB, as a sandbox's is (0389).
  expect(() => jobBody({ ...base, schedule: { at: 1 }, compute: { diskMiB: 409_601 } })).toThrow(
    /at most 409600 MiB \(400 GiB\); asked for 409601/,
  );
  expect(
    (
      jobBody({ ...base, schedule: { at: 1 }, compute: { diskMiB: 409_600 } }).compute as {
        diskMiB: number;
      }
    ).diskMiB,
  ).toBe(409_600);
  expect(() => jobBody({ ...base, schedule: { cron: "0 3 * *" } })).toThrow(/five fields/);
  expect(() => jobBody(base)).toThrow(/schedule.at must be a time/);
  expect(() => jobBody({ ...base, schedule: { at: 1 }, timeoutSeconds: 4000 })).toThrow(
    /at most 3600 seconds/,
  );
  // A long timeout keeps the paid time within the hour.
  expect(
    (
      jobBody({ ...base, schedule: { at: 1 }, timeoutSeconds: 3590 }).compute as {
        durationSeconds: number;
      }
    ).durationSeconds,
  ).toBe(3600);
  expect(
    (
      jobBody({ ...base, schedule: { at: 1 }, compute: { cpuMode: "reserved", vcpu: 4 } })
        .compute as {
        cpuFloorMillis: number;
      }
    ).cpuFloorMillis,
  ).toBe(4000);
});

test("list, runs, run, logs, pause, resume and cancel call their routes", async () => {
  await withStub(
    (_request, path) =>
      path === "/v1/jobs"
        ? { items: [JOB], nextCursor: null }
        : path.endsWith("/runs")
          ? { items: [RUN], nextCursor: null }
          : path.endsWith("/logs")
            ? { chunks: [], nextCursor: 3, truncated: false, complete: true }
            : path.startsWith("/v1/job-runs/")
              ? RUN
              : JOB,
    async (seen) => {
      const jobs = runtime().jobs;
      expect((await jobs.list()).data).toEqual([JOB] as never);
      expect((await jobs.runs(JOB_ID)).data[0]!.id).toBe(RUN_ID);
      expect((await jobs.run(RUN_ID)).state).toBe("succeeded");
      expect((await jobs.logs(RUN_ID, { cursor: 3 })).complete).toBe(true);
      await jobs.pause(JOB_ID);
      await jobs.resume(JOB_ID);
      await jobs.cancel(JOB_ID);
      expect(seen.map((s) => s.line)).toEqual([
        "GET /v1/jobs",
        `GET /v1/jobs/${JOB_ID}/runs`,
        `GET /v1/job-runs/${RUN_ID}`,
        `GET /v1/job-runs/${RUN_ID}/logs?cursor=3`,
        `POST /v1/jobs/${JOB_ID}:pause`,
        `POST /v1/jobs/${JOB_ID}:resume`,
        `POST /v1/jobs/${JOB_ID}:cancel`,
      ]);
      // Each write carries its own key.
      const keys = seen.filter((s) => s.line.startsWith("POST")).map((s) => s.key);
      expect(new Set(keys).size).toBe(3);
    },
  );
});

test("jobs switched off fail once, with the API's words and a hint that retrying will not help", async () => {
  await withStub(
    () =>
      Response.json(
        {
          error: {
            code: "unavailable",
            message: "This product is not enabled on this deployment.",
            hint: "This product is not enabled on this deployment yet.",
            requestId: "req_1",
          },
        },
        { status: 503 },
      ),
    async (seen) => {
      const error = await runtime()
        .jobs.list()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      const e = error as ServiceUnavailableError;
      expect(e.message).toBe("Jobs are not enabled on this Runtime API yet.");
      expect(e.hint).toMatch(/switched off.*retrying will not help/);
      expect(e.retryable).toBe(false);
      expect(e.requestId).toBe("req_1");
      expect(seen).toHaveLength(1);
    },
  );
});

test("`runtime job create` builds the schedule, binds secrets by name and refuses mistakes", async () => {
  await withStub(
    (request, path) =>
      path === "/v1/egress-secrets"
        ? { secrets: [] }
        : path === "/v1/secrets"
          ? [COPY]
          : request.method === "POST"
            ? JOB
            : JOB,
    async (seen) => {
      const { lines, out } = output();
      expect(
        await run(
          [
            "job",
            "create",
            "nightly",
            "--cron",
            "0 3 * * *",
            "--timezone",
            "Europe/Berlin",
            "--secret",
            "DB_PASSWORD=PGPASSWORD",
            "--attempts",
            "3",
            "--memory",
            "8192",
            "--",
            "python3",
            "-c",
            "print(1)",
          ],
          env,
          out,
        ),
      ).toBe(0);
      expect(lines.at(-1)).toBe(JOB_ID);
      const body = JSON.parse(seen.find((s) => s.line === "POST /v1/jobs")!.body);
      expect(body.schedule).toEqual({
        kind: "cron",
        expression: "0 3 * * *",
        timezone: "Europe/Berlin",
      });
      expect(body.command).toEqual({ argv: ["python3", "-c", "print(1)"] });
      expect(body.secrets).toEqual([{ name: "PGPASSWORD", secretId: SECRET_ID }]);
      expect(body.retry).toEqual({ maxAttempts: 3, backoffSeconds: 30 });
      expect(body.compute.memoryMiB).toBe(8192);
    },
  );
  const { out } = output();
  const fails = (argv: string[], pattern: RegExp) =>
    expect(run(["job", "create", ...argv], env, out)).rejects.toThrow(pattern);
  await fails(["x", "--at", "2020-01-01T00:00:00Z", "--", "true"], /in the past.*--at now/);
  await fails(["x", "--", "true"], /--cron.*--at/);
  await fails(["x", "--at", "now", "--cron", "* * * * *", "--", "true"], /--cron.*--at/);
  await fails(["x", "--at", "now"], /command after --/);
  await fails(["x", "--at", "tomorrow", "--", "true"], /ISO time/);
  await fails(["x", "--at", "now", "--vcpu", "32", "--", "true"], /at most 16 vCPU/);
  await fails(
    ["x", "--at", "now", "--timezone", "UTC", "--", "true"],
    /--timezone goes with --cron/,
  );
  await withStub(
    (_r, path) => (path === "/v1/egress-secrets" ? { secrets: [] } : []),
    async () => {
      await fails(
        ["x", "--at", "now", "--secret", "MISSING", "--", "true"],
        /MISSING has no copy for jobs.*secrets set MISSING --jobs/,
      );
    },
  );
});

test("`runtime job logs` takes a job id for its latest run and says how the run ended", async () => {
  const written: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (t: string) => (written.push(`out:${t}`), true);
  process.stderr.write = (t: string) => (written.push(`err:${t}`), true);
  try {
    await withStub(
      (_request, path) =>
        path === `/v1/job-runs/${JOB_ID}`
          ? Response.json(
              { error: { code: "not_found", message: "Run not found" } },
              { status: 404 },
            )
          : path.endsWith("/runs")
            ? { items: [{ ...RUN, id: "old" }, RUN], nextCursor: null }
            : path.endsWith("/logs")
              ? {
                  chunks: [
                    { offset: 0, stream: "stdout", text: "hi\n" },
                    { offset: 3, stream: "stderr", text: "warn\n" },
                  ],
                  nextCursor: 8,
                  truncated: false,
                  complete: true,
                }
              : RUN,
      async (seen) => {
        const { out } = output();
        expect(await run(["job", "logs", JOB_ID], env, out)).toBe(0);
        expect(seen.map((s) => s.line)).toContain(
          `GET /v1/job-runs/${RUN_ID}/logs?cursor=0&limitBytes=65536`,
        );
      },
    );
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  expect(written).toEqual(["out:hi\n", "err:warn\n", "err:[succeeded, exit code 0]\n"]);
});

test("`runtime secrets set --jobs` stores a jobs copy, and set again rotates it", async () => {
  await withStub(
    (request, path) =>
      path === "/v1/secrets" && request.method === "GET" ? [] : { ...COPY, version: 1 },
    async (seen) => {
      const { lines, out } = output();
      expect(
        await secretsCommand(["set", "DB_PASSWORD", "--jobs"], env, out, async () => "hunter2"),
      ).toBe(0);
      expect(seen.map((s) => s.line)).toEqual(["GET /v1/secrets?limit=100", "POST /v1/secrets"]);
      expect(JSON.parse(seen[1]!.body)).toEqual({ name: "DB_PASSWORD", value: "hunter2" });
      expect(lines.join("\n")).toContain("Stored DB_PASSWORD for jobs, version 1");
      expect(lines.join("\n")).not.toContain("hunter2");
    },
  );
  await withStub(
    (request, path) => (path === "/v1/secrets" && request.method === "GET" ? [COPY] : COPY),
    async (seen) => {
      const { out } = output();
      await secretsCommand(["set", "DB_PASSWORD", "--jobs"], env, out, async () => "new");
      expect(seen[1]!.line).toBe(`POST /v1/secrets/${SECRET_ID}:rotate`);
      expect(JSON.parse(seen[1]!.body)).toEqual({ value: "new", expectedVersion: 2 });
    },
  );
});

test("a deleted jobs name says it cannot be reused, before anything is written", async () => {
  await withStub(
    () => [{ ...COPY, deletedAt: 5 }],
    async (seen) => {
      await expect(
        runtime().secrets.set("DB_PASSWORD", { value: "x", jobs: true }),
      ).rejects.toThrow(/was deleted, and a deleted name cannot be used again/);
      expect(seen.map((s) => s.line)).toEqual(["GET /v1/secrets?limit=100"]);
    },
  );
});

test("both copies: a jobs copy that fails after the sandboxes' copy is stored says so, and a retry finishes", async () => {
  const EGRESS = {
    name: "API_TOKEN",
    hosts: ["api.example.com"],
    placeholder: "rtsec_x",
    valueBytes: 3,
    createdAt: "",
    updatedAt: "",
    enforced: true,
  };
  let jobsUp = false;
  await withStub(
    (request, path) =>
      path.startsWith("/v1/egress-secrets")
        ? EGRESS
        : !jobsUp
          ? Response.json(
              { error: { code: "unavailable", message: "Secrets are unavailable." } },
              { status: 503 },
            )
          : request.method === "GET"
            ? []
            : { ...COPY, name: "API_TOKEN", version: 1 },
    async (seen) => {
      const secrets = runtime().secrets;
      const input = { value: "tok", hosts: ["api.example.com"], jobs: true as const };
      const error = await secrets.set("API_TOKEN", input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SecretPartlyStoredError);
      expect((error as SecretPartlyStoredError).message).toMatch(
        /Stored API_TOKEN for sandboxes, but not for jobs: Secrets for jobs are not enabled/,
      );
      expect((error as SecretPartlyStoredError).details).toMatchObject({ stored: ["sandboxes"] });
      jobsUp = true;
      const saved = await secrets.set("API_TOKEN", input);
      expect(saved.placeholder).toBe("rtsec_x");
      expect(saved.jobs?.version).toBe(1);
      expect(seen.filter((s) => s.line.startsWith("PUT"))).toHaveLength(2);
    },
  );
});

test("reveal and rotate reach only the jobs copy; rm deletes every copy", async () => {
  await withStub(
    (request, path) =>
      path === "/v1/secrets" && request.method === "GET"
        ? [COPY]
        : path.endsWith(":reveal")
          ? { id: SECRET_ID, version: 2, value: "hunter2" }
          : path.startsWith("/v1/egress-secrets")
            ? { name: "DB_PASSWORD", deleted: true, enforced: true }
            : COPY,
    async (seen) => {
      const secrets = runtime().secrets;
      expect((await secrets.reveal("DB_PASSWORD")).value).toBe("hunter2");
      const removed = await secrets.delete("DB_PASSWORD");
      expect(removed.from).toEqual(["sandboxes", "jobs"]);
      expect(seen.map((s) => s.line)).toEqual([
        "GET /v1/secrets?limit=100",
        `POST /v1/secrets/${SECRET_ID}:reveal`,
        "GET /v1/secrets?limit=100",
        "DELETE /v1/egress-secrets/DB_PASSWORD",
        `POST /v1/secrets/${SECRET_ID}:delete`,
      ]);
      expect(JSON.parse(seen.at(-1)!.body)).toEqual({ expectedVersion: 2 });
    },
  );
  await withStub(
    () => [],
    async () => {
      await expect(runtime().secrets.reveal("OPENAI_API_KEY")).rejects.toThrow(
        /sandboxes' copy of a secret can never be read back/,
      );
      const { out } = output();
      await expect(
        secretsCommand(["rotate", "X", "--host", "a.example.com"], env, out, async () => "v"),
      ).rejects.toThrow(/rotate replaces the copy for jobs/);
    },
  );
});
