import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* 28 September 2026: the report of an image's start command came back on the
   create and was lost at the first refresh. The API keeps no record of it, so
   `sandboxes.get` has none; the Sandbox the create returned keeps it. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const START = { state: "ready", processId: "p1", readyMs: 420 } as const;

function world() {
  return new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const base = { id: ID, kind: "sandbox", status: "active", state: "running" };
      if (request.method === "POST" && url.pathname === "/v1/sandboxes")
        return Response.json({ ...base, start: START });
      if (url.pathname.endsWith(":stop"))
        return Response.json({ ...base, status: "stopped", state: "stopped" });
      return Response.json(base);
    }) as typeof fetch,
  });
}

test("the create's start report survives a refresh and a stop", async () => {
  const sbx = await world().sandboxes.create({ image: "app" });
  expect(sbx.info.start).toEqual(START);
  await sbx.refresh();
  expect(sbx.info.start).toEqual(START);
  await sbx.waitFor("running");
  await sbx.stop();
  expect(sbx.state).toBe("stopped");
  expect(sbx.info.start).toEqual(START);
});

test("a sandbox read by id has no start report to keep", async () => {
  const sbx = await world().sandboxes.get(ID);
  await sbx.refresh();
  expect(sbx.info.start).toBeUndefined();
});
