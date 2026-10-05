import { expect, test } from "bun:test";
import { sandboxBrowser } from "../src/products/browser";
import { sandboxDesktop } from "../src/products/desktop";
import { sandboxMcp } from "../src/products/mcp";
import { Transport } from "../src/transport";

/* Waits for a first install, and for MCP servers to be ready, keep the
   caller's one deadline and stop on abort (1 October 2026 audit): no wait
   outlives a cancelled call, and no request is sent after it. */

const SANDBOX = { id: "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f" } as never;

function transport(answer: (request: Request, init?: RequestInit) => Promise<Response>) {
  const seen: string[] = [];
  const t = new Transport({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return answer(request, init);
    }) as typeof fetch,
  });
  return { t, seen };
}

const installing = (code: string, retryAfterMs: number) =>
  Response.json({ error: { code, message: "installing", retryAfterMs } }, { status: 409 });

/** A request that never answers until its signal ends it. */
const stalled = (init?: RequestInit) =>
  new Promise<Response>((_, reject) =>
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error), {
      once: true,
    }),
  );

test("an abort ends an install wait at once, and nothing more is sent", async () => {
  for (const start of [
    (t: Transport, signal: AbortSignal) => sandboxBrowser(t, SANDBOX).start({}, { signal }),
    (t: Transport, signal: AbortSignal) => sandboxDesktop(t, SANDBOX).start({}, { signal }),
    (t: Transport, signal: AbortSignal) =>
      sandboxDesktop(t, SANDBOX).open("https://example.com", { signal }),
  ]) {
    const { t, seen } = transport(async (request) =>
      installing(
        request.url.includes("browser") ? "browser_installing" : "desktop_installing",
        200,
      ),
    );
    const stop = new AbortController();
    const began = performance.now();
    const call = start(t, stop.signal);
    setTimeout(() => stop.abort(new Error("stopped")), 10);
    await expect(call).rejects.toThrow("stopped");
    expect(performance.now() - began).toBeLessThan(150);
    await Bun.sleep(250);
    expect(seen.length).toBe(1);
  }
});

test("an install wait keeps the call's one deadline", async () => {
  const { t, seen } = transport(async () => installing("browser_installing", 200));
  const began = performance.now();
  await expect(sandboxBrowser(t, SANDBOX).start({}, { timeoutMs: 50 })).rejects.toMatchObject({
    code: "browser_installing",
  });
  expect(performance.now() - began).toBeLessThan(150);
  expect(seen.length).toBe(1);
});

test("MCP readiness cuts off a stalled status request at its deadline", async () => {
  const stuck = transport(async (_request, init) => stalled(init));
  const began = performance.now();
  await expect(sandboxMcp(stuck.t, SANDBOX).ready({ timeoutMs: 20 })).rejects.toMatchObject({
    code: "timeout",
  });
  expect(performance.now() - began).toBeLessThan(150);
  // With a state read first, the deadline returns it.
  let calls = 0;
  const slow = transport(async (_request, init) =>
    calls++ === 0
      ? Response.json({
          running: true,
          port: 8765,
          servers: [{ name: "fetch", status: "installing", url: "u" }],
          warnings: [],
        })
      : stalled(init),
  );
  const state = await sandboxMcp(slow.t, SANDBOX).ready({ timeoutMs: 40, intervalMs: 1 });
  expect(state.servers[0]!.status).toBe("installing");
  expect(performance.now() - began).toBeLessThan(300);
});
