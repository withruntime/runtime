import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* Lifecycle and fork calls keep the caller's deadline as given (1 October
   2026 audit): a command's timeoutMs is its limit in the guest, plus a minute
   for the answer, but a stop's or a fork's is the call's own, and 0 turns the
   client's limit off. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const INFO = { id: SANDBOX, kind: "sandbox", state: "running", status: "active" };

async function sandbox(lifecycleMs: number, clientTimeoutMs?: number) {
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    ...(clientTimeoutMs === undefined ? {} : { timeoutMs: clientTimeoutMs }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json(INFO);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, lifecycleMs);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init.signal!.reason as Error);
          },
          { once: true },
        );
      });
      return new URL(request.url).pathname.endsWith(":fork")
        ? Response.json({ sandboxes: [INFO] })
        : Response.json(INFO);
    }) as typeof fetch,
  });
  return runtime.sandboxes.get(SANDBOX);
}

test("a lifecycle or fork call ends at the caller's deadline, not a minute later", async () => {
  const sbx = await sandbox(5_000);
  for (const call of [
    () => sbx.stop({ timeoutMs: 20 }),
    () => sbx.pause({ timeoutMs: 20 }),
    () => sbx.wake({ timeoutMs: 20 }),
    () => sbx.restart({ timeoutMs: 20 }),
    () => sbx.fork({ timeoutMs: 20 }),
  ]) {
    const began = performance.now();
    await expect(call()).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - began).toBeLessThan(1_000);
  }
});

test("timeoutMs: 0 turns the client's limit off for a lifecycle call", async () => {
  const sbx = await sandbox(150, 50);
  await expect(sbx.stop()).rejects.toMatchObject({ code: "timeout" });
  expect((await sbx.stop({ timeoutMs: 0 })).id).toBe(SANDBOX);
  expect(await sbx.fork({ timeoutMs: 0 })).toBeDefined();
});
