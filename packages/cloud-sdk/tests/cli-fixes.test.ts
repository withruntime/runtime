import { expect, spyOn, test } from "bun:test";
import { run } from "../src/cli";

/* Defects a person found driving the published CLI (0.5.1) on 23 September
   2026, each against a stub API: what the CLI sends and what it prints. The
   extend and MCP fixes are in packages/cloud (sandbox-extend-postgres.test.ts
   and mcp-names.test.ts). */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const INFO = {
  id: SANDBOX,
  kind: "sandbox",
  name: "web",
  state: "running",
  status: "active",
  labels: {},
  createdAt: "2026-09-22T00:00:00Z",
  expiresAt: "2026-09-23T13:00:00Z",
};
const PROCESS = {
  id: "p1",
  kind: "process",
  state: "running",
  exitCode: null,
  command: "python3 -m http.server",
  cwd: "/workspace",
  pty: false,
  stdinOpen: false,
  stdinOffset: 0,
  startedAt: "2026-09-23T12:00:00Z",
  endedAt: null,
  timeoutMs: null,
};

async function withStub(
  routes: (method: string, url: URL, body: unknown) => unknown,
  work: (lines: string[], seen: string[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    const text = request.method === "GET" ? "" : await request.text();
    const answer = await routes(request.method, url, text ? JSON.parse(text) : undefined);
    if (answer instanceof Response) return answer;
    if (answer === undefined)
      return Response.json(
        { error: { code: "route_not_found", message: url.pathname } },
        { status: 404 },
      );
    return Response.json(answer);
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    await work(lines, seen);
  } finally {
    globalThis.fetch = original;
  }
}
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const out = (lines: string[], json = false) => ({
  json,
  write: (t: string) => lines.push(t),
  error: (t: string) => lines.push(`ERR ${t}`),
});

/** A server's output: never ends when followed, as a running process's does. */
function processRoutes(method: string, url: URL) {
  const base = `/v1/sandboxes/${SANDBOX}`;
  if (url.pathname === base) return INFO;
  if (url.pathname === `${base}/processes/p1`) return PROCESS;
  if (url.pathname === `${base}/processes/p1/output`) {
    if (url.searchParams.get("follow") === "true")
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/x-ndjson" },
      });
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    return cursor === 0
      ? {
          chunks: [
            { stream: "stdout", text: "Serving HTTP on 0.0.0.0 port 8000\n", offset: 0 },
            { stream: "stderr", text: "GET / 200\n", offset: 34 },
          ],
          nextCursor: 44,
          truncated: false,
          droppedBytes: 0,
          process: PROCESS,
        }
      : { chunks: [], nextCursor: cursor, truncated: false, droppedBytes: 0, process: PROCESS };
  }
  void method;
  return undefined;
}

test("`sandbox logs` without -f prints the output so far and returns while the process runs", async () => {
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await withStub(processRoutes, async (lines, seen) => {
      const done = run(["sandbox", "logs", SANDBOX, "p1"], env, out(lines));
      const outcome = await Promise.race([done, Bun.sleep(3000).then(() => "still following")]);
      expect(outcome).toBe(0);
      expect(stdout.mock.calls.map((c) => String(c[0]))).toContain(
        "Serving HTTP on 0.0.0.0 port 8000\n",
      );
      const errors = stderr.mock.calls.map((c) => String(c[0]));
      expect(errors).toContain("GET / 200\n");
      expect(errors.join("")).toContain(`sandbox logs ${SANDBOX} p1 -f`);
      expect(seen.some((line) => line.includes("follow=true"))).toBe(false);

      const json: string[] = [];
      expect(await run(["sandbox", "logs", SANDBOX, "p1", "--json"], env, out(json, true))).toBe(0);
      expect(JSON.parse(json[0]!)).toMatchObject({
        processId: "p1",
        state: "running",
        exitCode: null,
        truncated: false,
        chunks: [{ stream: "stdout" }, { stream: "stderr" }],
      });
    });
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("`usage` prints a summary in dollars; --json keeps every figure", async () => {
  const usage = {
    orgId: "org",
    unit: "microdollars",
    credited: "35000000",
    spent: "10000277",
    held: "1105",
    expired: "0",
    available: "24998618",
    takenBack: "10000000",
    trial: { totalMs: 360_000_000, usedMs: 3_663_049, reservedMs: 0, availableMs: 356_336_951 },
    outbound: {
      month: "2026-09",
      sentBytes: 112_374_182_400,
      freeBytes: 107_374_182_400,
      billableBytes: 5_000_000_000,
      allowanceBytes: 107_374_182_400,
      chargedMicros: "100000",
      writtenOffMicros: "0",
    },
    resources: [
      ...Array.from({ length: 3 }, (_, i) => ({
        resourceId: `s${i}`,
        kind: "sandbox",
        chargedMicros: 12_000,
        heldMicros: 0,
      })),
      { resourceId: "i1", kind: "image", chargedMicros: 54, heldMicros: 176 },
    ],
  };
  await withStub(
    (_method, url) => (url.pathname === "/v1/usage" ? usage : undefined),
    async (lines) => {
      expect(await run(["usage"], env, out(lines))).toBe(0);
      const text = lines.join("\n");
      expect(text).toMatch(/^available\s+\$25\.00$/m);
      // spent includes what a refund took back: used and returned are apart.
      expect(text).toMatch(/^used\s+\$0\.0003$/m);
      expect(text).toMatch(/^returned by refunds and disputes\s+\$10\.00$/m);
      expect(text).toMatch(/^held for running sandboxes and this hour's storage\s+\$0\.0011$/m);
      expect(text).toMatch(/^free trial\s+99 of 100 hours left$/m);
      expect(text).toMatch(
        /^outbound traffic this month\s+104\.7 GiB sent, 0 GiB of 100 GiB free left, \$0\.1000 charged$/m,
      );
      expect(text).toMatch(/sandboxes\s+3\s+\$0\.0360\s+\$0\.0000/);
      expect(text).toMatch(/image\s+1\s+\$0\.000054\s+\$0\.0002/);
      expect(text).toContain("usage --json");
      expect(text).not.toContain("24998618");
      expect(text.split("\n").length).toBeLessThan(20);

      const json: string[] = [];
      await run(["usage", "--json"], env, out(json, true));
      expect(JSON.parse(json[0]!)).toEqual(usage);
    },
  );
});

test("`usage --csv` is one row per resource with exact dollars, quoted where it must be", async () => {
  const usage = {
    orgId: "org",
    unit: "microdollars",
    credited: "0",
    spent: "0",
    held: "0",
    expired: "0",
    available: "0",
    takenBack: "0",
    trial: null,
    resources: [
      {
        resourceId: "s1",
        name: 'eval, "big"',
        kind: "sandbox",
        status: "stopped",
        state: "stopped",
        createdAt: "2026-09-25T10:00:00.000Z",
        vcpu: 2,
        memoryMiB: 4096,
        runningSeconds: "61.250",
        activeCpuSeconds: "3.500000",
        memoryGiBSeconds: "245.000000",
        chargedMicros: 1_234_567,
        heldMicros: 0,
      },
      {
        resourceId: "i1",
        name: null,
        kind: "image",
        status: "active",
        state: null,
        chargedMicros: 7,
        heldMicros: 176,
      },
    ],
  };
  await withStub(
    (_method, url) => (url.pathname === "/v1/usage" ? usage : undefined),
    async (lines) => {
      expect(await run(["usage", "--csv"], env, out(lines))).toBe(0);
      expect(lines.join("\n").split("\n")).toEqual([
        "resource_id,name,kind,state,created_at,vcpu,memory_mib,running_seconds,active_cpu_seconds,memory_gib_seconds,charged_usd,held_usd",
        's1,"eval, ""big""",sandbox,stopped,2026-09-25T10:00:00.000Z,2,4096,61.250,3.500000,245.000000,1.234567,0.000000',
        "i1,,image,active,,,,,,,0.000007,0.000176",
      ]);
      await expect(run(["usage", "--cvs"], env, out(lines))).rejects.toThrow(
        "Unknown option --cvs",
      );
    },
  );
});

test("a sandbox's name works in exec and the other sandbox commands, as in ssh", async () => {
  await withStub(
    (method, url) => {
      if (method === "GET" && url.pathname === "/v1/sandboxes")
        return url.searchParams.get("name") === "web"
          ? { data: [INFO], nextCursor: null }
          : { data: [], nextCursor: null };
      if (url.pathname === `/v1/sandboxes/${SANDBOX}:exec`)
        return { stdout: "hi\n", stderr: "", exitCode: 0, timedOut: false };
      if (url.pathname === `/v1/sandboxes/${SANDBOX}:stop`) return { ...INFO, state: "stopped" };
      if (url.pathname === "/v1/events") return { data: [], nextCursor: null };
    },
    async (lines, seen) => {
      expect(
        await run(["sandbox", "exec", "web", "--json", "--", "echo", "hi"], env, out(lines, true)),
      ).toBe(0);
      expect(JSON.parse(lines[0]!)).toMatchObject({ stdout: "hi\n", exitCode: 0 });
      expect(seen).toContain(`POST /v1/sandboxes/${SANDBOX}:exec`);
      expect(seen.some((line) => line.startsWith("GET /v1/sandboxes?name=web"))).toBe(true);

      expect(await run(["sandbox", "stop", "web"], env, out(lines))).toBe(0);
      expect(seen).toContain(`POST /v1/sandboxes/${SANDBOX}:stop`);

      await run(["events", "--sandbox", "web"], env, out(lines));
      expect(seen.at(-1)).toContain(`resourceId=${SANDBOX}`);

      // An id is used as it is, with no lookup by name.
      const before = seen.length;
      await run(["events", "--sandbox", SANDBOX], env, out(lines));
      expect(seen.slice(before)).toEqual([`GET /v1/events?resourceId=${SANDBOX}`]);

      await expect(run(["sandbox", "exec", "nope", "--", "true"], env, out(lines))).rejects.toThrow(
        "No live sandbox is named nope.",
      );
    },
  );
});

/** `runtime mcp` as a client runs it: a child process on stdio, connected. */
async function bridge() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const message = (await request.json()) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x" } },
      });
    },
  });
  const child = Bun.spawn(
    [process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, "mcp"],
    {
      env: {
        PATH: process.env.PATH ?? "",
        RUNTIME_API_KEY: "fixture",
        RUNTIME_API_URL: `http://127.0.0.1:${server.port}`,
      },
      stdin: "pipe",
      stdout: "pipe",
    },
  );
  void child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
  );
  const reader = child.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(JSON.parse(first)).toMatchObject({ id: 1, result: { serverInfo: { name: "x" } } });
  return { child, server };
}
const exitWithin = (child: { exited: Promise<number> }, ms: number) =>
  Promise.race([child.exited, Bun.sleep(ms).then(() => "still running")]);

test("`runtime mcp` exits promptly on SIGTERM with its stdin still open, and when stdin closes", async () => {
  const first = await bridge();
  try {
    const began = performance.now();
    first.child.kill("SIGTERM");
    expect(await exitWithin(first.child, 3000)).toBe(0);
    expect(performance.now() - began).toBeLessThan(1500);
  } finally {
    first.child.kill("SIGKILL");
    await first.server.stop(true);
  }
  const second = await bridge();
  try {
    const began = performance.now();
    void second.child.stdin.end();
    expect(await exitWithin(second.child, 3000)).toBe(0);
    expect(performance.now() - began).toBeLessThan(1500);
  } finally {
    second.child.kill("SIGKILL");
    await second.server.stop(true);
  }
}, 20_000);

test("`whoami` names the organization, the role and what it can spend", async () => {
  await withStub(
    (_method, url) =>
      url.pathname === "/v1/me"
        ? {
            orgId: "org-1",
            orgName: "Acme",
            role: "owner",
            principalId: "agent-1",
            credentialId: "key-1",
            apiVersion: "0.2.0",
          }
        : url.pathname === "/v1/usage"
          ? {
              available: "24990000",
              trial: { totalMs: 360_000_000, usedMs: 0, reservedMs: 0, availableMs: 343_800_000 },
            }
          : undefined,
    async (lines) => {
      expect(await run(["whoami"], env, out(lines))).toBe(0);
      const text = lines.join("\n");
      expect(text).toMatch(/^organization\s+Acme \(org-1\)$/m);
      expect(text).toMatch(/^role\s+owner$/m);
      expect(text).toMatch(/^funding\s+free trial, 95\.5 hours left; \$24\.99 of credit$/m);
    },
  );
});

// Reviewer's finding #44, 26 September 2026: exec streams, and a streamed
// command's timeout is 24 hours unless --timeout says otherwise, but the line
// a timeout printed said 60 s.
test("a streamed exec that times out says the timeout it ran under", async () => {
  const stream = () =>
    new Response(
      [
        { type: "start", processId: "p1" },
        { type: "stdout", data: "partial\n", offset: 0 },
        { type: "exit", exitCode: null, state: "timed_out", timedOut: true },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  const bodies: unknown[] = [];
  await withStub(
    (_method, url, body) => {
      if (url.pathname === `/v1/sandboxes/${SANDBOX}`) return INFO;
      if (url.pathname === `/v1/sandboxes/${SANDBOX}:exec`) {
        bodies.push(body);
        return stream();
      }
    },
    async (lines) => {
      const write = spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(await run(["sandbox", "exec", SANDBOX, "--", "sleep", "1d"], env, out(lines))).toBe(
          124,
        );
        expect(lines.at(-1)).toBe(
          "ERR runtime: timed out after 24 h; the command's process group was killed.",
        );
        expect(
          await run(
            ["sandbox", "exec", SANDBOX, "--timeout", "5", "--", "sleep", "9"],
            env,
            out(lines),
          ),
        ).toBe(124);
        expect(lines.at(-1)).toContain("timed out after 5 s;");
      } finally {
        write.mockRestore();
      }
    },
  );
  expect(bodies[0]).toMatchObject({ timeoutMs: 86_400_000, stream: true });
});
