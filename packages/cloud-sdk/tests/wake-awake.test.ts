import { expect, test } from "bun:test";
import { Runtime, RuntimeError } from "../src/index";

/* 25 September 2026: `runtime sandbox wake` on a sandbox that was already
   awake failed with not_paused. Waking an awake sandbox is done. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
function world(state: string) {
  return new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith(":wake"))
        return Response.json(
          { error: { code: "not_paused", message: "Only a paused sandbox can be woken." } },
          { status: 409 },
        );
      return Response.json({ id: ID, kind: "sandbox", state, status: "active", metadata: {} });
    }) as typeof fetch,
  });
}

test("waking an awake sandbox is done", async () => {
  const sbx = await world("running").sandboxes.get(ID);
  expect((await sbx.wake()).state).toBe("running");
});

test("a stopped one, or a new lease that was not given, is still refused", async () => {
  const stopped = await world("stopped").sandboxes.get(ID);
  expect(await stopped.wake().catch((e: unknown) => e)).toBeInstanceOf(RuntimeError);
  const running = await world("running").sandboxes.get(ID);
  expect(await running.wake({ timeoutSeconds: 600 }).catch((e: unknown) => e)).toBeInstanceOf(
    RuntimeError,
  );
});
