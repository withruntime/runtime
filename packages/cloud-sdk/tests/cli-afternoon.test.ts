import { expect, test } from "bun:test";
import { describeError, run } from "../src/cli";
import { RuntimeError } from "../src/errors";

/* What a customer's afternoon with the CLI found on 30 September 2026, each
   against a stub API: a list that dropped the newest sandboxes, reads that
   left out why a sandbox stopped, refusals in the API's words, help that
   ran the command, and figures that contradicted or rounded themselves
   away. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };

type Seen = { method: string; path: string; query: URLSearchParams };
async function cli(
  argv: string[],
  answer: (method: string, url: URL) => unknown,
): Promise<{ code: number; out: string; err: string; seen: Seen[] }> {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({ method: request.method, path: url.pathname, query: url.searchParams });
    const value = await answer(request.method, url);
    if (value === undefined)
      return Response.json(
        { error: { code: "not_found", status: 404, message: `stub has no ${url.pathname}` } },
        { status: 404 },
      );
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  const out: string[] = [];
  const err: string[] = [];
  try {
    const code = await run(argv, env, {
      json: argv.includes("--json"),
      write: (t) => out.push(t),
      error: (t) => err.push(t),
    });
    return { code, out: out.join("\n"), err: err.join("\n"), seen };
  } finally {
    globalThis.fetch = original;
  }
}

const sandbox = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  kind: "sandbox",
  state: "stopped",
  status: "active",
  labels: {},
  vcpu: 1,
  memoryMiB: 1024,
  diskMiB: 4096,
  cpu: "shared",
  funding: "trial",
  region: "us-east",
  createdAt: new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString(),
  expiresAt: "2026-09-30T00:00:00.000Z",
  ...extra,
});

test("`sandbox ls --all` lists every sandbox, the newest included, past a thousand", async () => {
  const total = 1_250;
  const { code, out } = await cli(["sandbox", "ls", "--all", "--json"], (_m, url) => {
    if (url.pathname !== "/v1/sandboxes") return undefined;
    const from = Number(url.searchParams.get("cursor") ?? 0);
    const size = Number(url.searchParams.get("limit") ?? 50);
    const to = Math.min(total, from + size);
    return {
      data: Array.from({ length: to - from }, (_, i) => sandbox(from + i)),
      nextCursor: to < total ? String(to) : null,
    };
  });
  expect(code).toBe(0);
  const listed = JSON.parse(out) as Array<{ id: string }>;
  expect(listed.length).toBe(total);
  expect(listed.at(-1)!.id).toBe(sandbox(total - 1).id);
});

test("`sandbox get` says what happens at the lease end, when it ended and why", async () => {
  const { out } = await cli(["sandbox", "get", SANDBOX], (_m, url) =>
    url.pathname === `/v1/sandboxes/${SANDBOX}`
      ? sandbox(1, {
          id: SANDBOX,
          onLeaseEnd: "stop",
          endedAt: "2026-09-30T03:14:53.000Z",
          stopReason: "lease_expired",
          chargedMicros: 0,
        })
      : undefined,
  );
  expect(out).toMatch(/at lease end\s+stop/);
  expect(out).toMatch(/ended\s+2026-09-30T03:14:53.000Z/);
  expect(out).toMatch(/stop reason\s+lease_expired/);
});

test("a refused create names the option, in dollars where the option takes dollars, and never details.issues", () => {
  const refused = new RuntimeError({
    code: "invalid_request",
    status: 400,
    message: "body.timeoutSeconds must be at least 60.",
    hint: "Fix the fields named in details.issues and send the request again.",
    details: {
      issues: [
        { path: "body.timeoutSeconds", message: "must be at least 60" },
        { path: "body.maxCostMicros", message: "must be at least 10000" },
      ],
    },
    requestId: "req_1",
  });
  const said = describeError(refused, false);
  expect(said).toContain("--timeout must be at least 60");
  expect(said).toContain("--max-cost must be at least $0.01");
  expect(said).not.toContain("details.issues");
  expect(said).not.toContain("timeoutSeconds");
  // --json keeps the API's own answer for a program to read.
  expect(JSON.parse(describeError(refused, true)).error.details.issues).toHaveLength(2);
  // A refusal naming one field says the option too.
  const trial = describeError(
    new RuntimeError({
      code: "invalid_trial",
      status: 400,
      message: "A trial sandbox has at most 10240 MiB of disk: diskMiB must be at most 10240.",
      details: { field: "diskMiB" },
    }),
    false,
  );
  expect(trial).toContain("--disk must be at most 10240");
});

test("`help` after a command prints its help and never runs it", async () => {
  for (const command of ["feedback", "support", "account", "otel", "compare", "switch", "usage"]) {
    const { code, out, seen } = await cli([command, "help"], () => undefined);
    expect({ command, code, sent: seen.length }).toEqual({ command, code: 0, sent: 0 });
    expect(out).toContain(`  ${command}`);
  }
});

test("the files help shows the depth it lists by default", async () => {
  const { out } = await cli(["sandbox", "help"], () => undefined);
  expect(out).toContain("[--depth 1]");
  const { seen } = await cli(["sandbox", "files", SANDBOX, "/workspace"], (_m, url) =>
    url.pathname.endsWith("/files/list") ? { data: [] } : undefined,
  );
  expect(seen.some((s) => s.query.has("depth"))).toBe(false);
});

test("`sandbox metrics` shows the newest CPU reading it holds, never 'no reading' above readings", async () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const point = (minutesAgo: number, cpuPercent: number | null) => ({
    at: at(minutesAgo),
    cpuPercent,
    cpuCores: cpuPercent === null ? null : cpuPercent / 50,
    cpuPeakPercent: cpuPercent,
    memoryBytes: 200 * 1_048_576,
    memoryPeakBytes: 210 * 1_048_576,
    samples: 4,
  });
  const { out } = await cli(["sandbox", "metrics", SANDBOX, "--range", "15m"], (_m, url) =>
    url.pathname.endsWith("/metrics")
      ? {
          sandboxId: SANDBOX,
          range: "15m",
          stepSeconds: 60,
          since: at(15),
          until: at(0),
          vcpu: 2,
          memoryLimitBytes: 1024 * 1_048_576,
          diskLimitBytes: 0,
          state: "running",
          latest: point(0, null),
          points: [point(6, 0.2), point(4, 0.3), point(0, null)],
        }
      : undefined,
  );
  expect(out).not.toContain("no reading");
  expect(out).toMatch(/cpu now\s+0\.3% of 2 vCPU .*4 min ago/);
});

test("`job ls` shows no next run for a job that will not run again", async () => {
  const job = (id: string, state: string) => ({
    id,
    name: id,
    state,
    definition: { schedule: { kind: "cron", expression: "0 3 * * *", timezone: "UTC" } },
    nextRunAt: Date.parse("2026-09-29T02:10:00.000Z"),
    blockedReason: null,
  });
  const { out } = await cli(["job", "ls"], (_m, url) =>
    url.pathname === "/v1/jobs"
      ? { items: [job("live", "active"), job("gone", "canceled")], nextCursor: null }
      : undefined,
  );
  const rows = out.split("\n");
  expect(rows.find((r) => r.startsWith("live"))).toContain("2026-09-29");
  expect(rows.find((r) => r.startsWith("gone"))).not.toContain("2026-09-29");
});

test("`limits` shows a small day's spend to the cent's fraction, as `usage` does", async () => {
  const { out } = await cli(["limits"], (_m, url) =>
    url.pathname === "/v1/limits"
      ? {
          access: "full",
          daily: { limitMicros: "5000000", usedMicros: "1407", remainingMicros: "4998593" },
        }
      : undefined,
  );
  expect(out).toMatch(/used, last 24 hours\s+\$0\.0014\b/);
  expect(out).toMatch(/daily limit\s+\$5\.00\b/);
});

test("`image get` and `volume get` read as `sandbox get` does, one fact a line", async () => {
  const image = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "web",
    version: 3,
    tags: ["latest"],
    state: "ready",
    sizeMiB: 512,
  };
  const volume = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "data",
    state: "ready",
    sizeMiB: 10240,
    attachments: [],
  };
  const { out: img } = await cli(["image", "get", image.id], (_m, url) =>
    url.pathname === `/v1/images/${image.id}` ? image : undefined,
  );
  const { out: vol } = await cli(["volume", "get", volume.id], (_m, url) =>
    url.pathname === `/v1/volumes/${volume.id}` ? volume : undefined,
  );
  for (const text of [img, vol]) expect(text.trimStart().startsWith("{")).toBe(false);
  expect(img).toMatch(/tags\s+latest/);
  expect(vol).toMatch(/attachments\s+-/);
  // --json still prints the record.
  const { out: json } = await cli(["image", "get", image.id, "--json"], (_m, url) =>
    url.pathname === `/v1/images/${image.id}` ? image : undefined,
  );
  expect(JSON.parse(json)).toEqual(image);
});

test("`sandbox kill` on a process that already exited says so, and sends no signal", async () => {
  const { code, out, seen } = await cli(["sandbox", "kill", SANDBOX, "p1"], (_m, url) =>
    url.pathname === `/v1/sandboxes/${SANDBOX}/processes/p1`
      ? { id: "p1", state: "exited", exitCode: 0, command: "sleep 1" }
      : undefined,
  );
  expect(code).toBe(0);
  expect(out).toContain("already exited");
  expect(seen.some((s) => s.path.endsWith(":signal"))).toBe(false);
});
