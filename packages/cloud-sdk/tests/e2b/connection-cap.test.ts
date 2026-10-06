import { expect, spyOn, test } from "bun:test";
import { Runtime } from "../../src/client";
import { Sandbox } from "../../src/e2b/sandbox";

/* An orchestrator moved from E2B runs one agent per sandbox, a thousand at
   once, each in commands.run. One address may hold 64 connections to the API,
   and each running command's output is a stream that holds one. The adapter
   shares its client's cap: commands past it wait their turn and then run,
   rather than having their connections reset. */
test("many commands at once from one client stay under its connection cap and all finish", async () => {
  let open = 0;
  let peak = 0;
  const encoder = new TextEncoder();
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    open++;
    peak = Math.max(peak, open);
    if (init.method === "POST" && url.pathname === "/v1/sandboxes") {
      open--;
      return Response.json({
        id: "sbx",
        kind: "sandbox",
        state: "running",
        status: "active",
        labels: {},
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (init.method === "POST" && url.pathname.endsWith(":exec")) {
      const id = `p${Math.random()}`;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ type: "start", processId: id })}\n`),
            );
            await Bun.sleep(15);
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "stdout", data: "ok\n", offset: 0 })}\n${JSON.stringify({ type: "exit", exitCode: 0, state: "exited", timedOut: false })}\n`,
              ),
            );
            open--;
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    open--;
    return Response.json({});
  }) as unknown as typeof fetch;
  const client = new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: fetcher,
    maxConnections: 12,
  });
  const sbx = await Sandbox.create({ runtime: { client } });
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) => sbx.commands.run(`echo ${i}`)),
  );
  expect(results.every((result) => result.exitCode === 0 && result.stdout === "ok\n")).toBe(true);
  expect(peak).toBeLessThanOrEqual(12);
  await sbx.kill();
});

/* E2B's SDK holds no call back, so code written for it runs a hundred
   one-second commands in a hundred sandboxes from one process in about a
   second. The adapter's own client must not read them 40 at a time (Agentin
   rehearsal, 5 October 2026: three waves, 10.1, 20.4 and 30.7 s). */
test("the adapter's own client runs a hundred commands at once, as E2B does", async () => {
  const { resetClients, E2B_MAX_CONNECTIONS } = await import("../../src/e2b/client");
  resetClients();
  const encoder = new TextEncoder();
  let open = 0;
  let peak = 0;
  const original = globalThis.fetch;
  const warnings: string[] = [];
  const warn = spyOn(process, "emitWarning").mockImplementation((message: string | Error) => {
    warnings.push(String(message));
  });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (init.method === "POST" && url.pathname === "/v1/sandboxes")
      return Response.json({
        id: `sbx-${Math.random()}`,
        kind: "sandbox",
        state: "running",
        status: "active",
        labels: {},
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    if (init.method === "POST" && url.pathname.endsWith(":exec")) {
      open++;
      peak = Math.max(peak, open);
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "start", processId: `p${Math.random()}` })}\n`,
              ),
            );
            await Bun.sleep(1000);
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "exit", exitCode: 0, state: "exited", timedOut: false })}\n`,
              ),
            );
            open--;
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    return Response.json({});
  }) as typeof fetch;
  const before = { key: process.env.RUNTIME_API_KEY, url: process.env.RUNTIME_API_URL };
  process.env.RUNTIME_API_KEY = "rtcloud_test";
  process.env.RUNTIME_API_URL = "https://api.example.test";
  try {
    const sandboxes = await Promise.all(Array.from({ length: 100 }, () => Sandbox.create()));
    const started = performance.now();
    const results = await Promise.all(sandboxes.map((sbx) => sbx.commands.run("sleep 1")));
    const seconds = (performance.now() - started) / 1000;
    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    expect(peak).toBe(100);
    expect(seconds).toBeLessThan(1.8);
    expect(E2B_MAX_CONNECTIONS).toBeGreaterThanOrEqual(1024);
    expect(warnings.filter((message) => message.includes("wait their turn"))).toEqual([]);
  } finally {
    globalThis.fetch = original;
    warn.mockRestore();
    if (before.key === undefined) delete process.env.RUNTIME_API_KEY;
    else process.env.RUNTIME_API_KEY = before.key;
    if (before.url === undefined) delete process.env.RUNTIME_API_URL;
    else process.env.RUNTIME_API_URL = before.url;
    resetClients();
  }
});

/* When calls do queue, the caller hears it once, with the way out. */
test("a client past its connections warns once that calls wait their turn", async () => {
  const { resetClients, warnQueued } = await import("../../src/e2b/client");
  const { Runtime } = await import("../../src/client");
  resetClients();
  const warnings: string[] = [];
  const warn = spyOn(process, "emitWarning").mockImplementation((message: string | Error) => {
    warnings.push(String(message));
  });
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const small = new Runtime({
      apiKey: "rk",
      baseUrl: "https://api.example.test",
      maxConnections: 1,
      onQueued: warnQueued,
      fetch: (async () => {
        await gate;
        return Response.json({ data: [], hasMore: false });
      }) as unknown as typeof fetch,
    });
    const calls = [small.sandboxes.list(), small.sandboxes.list(), small.sandboxes.list()];
    await Bun.sleep(20);
    release();
    await Promise.all(calls);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("More than 1 calls and command streams are open at once");
  } finally {
    warn.mockRestore();
    resetClients();
  }
});
