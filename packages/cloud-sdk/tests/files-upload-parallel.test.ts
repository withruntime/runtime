import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* A large write keeps eight chunks in flight: at four, a home link idled
   while every chunk waited on its reply (100 MB up: 17-18 s at four, 11 s at
   eight, measured 27 September 2026). */
const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";

test("a large write sends eight chunks at once", async () => {
  let inFlight = 0;
  let most = 0;
  let chunks = 0;
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET")
        return Response.json({ id: ID, kind: "sandbox", state: "running", status: "active" });
      if (path.endsWith("/uploads")) return Response.json({ uploadId: "u1", chunkBytes: 1048576 });
      if (request.method === "PUT") {
        chunks++;
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return Response.json({ received: chunks * 1048576 });
      }
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  const files = (await runtime.sandboxes.get(ID)).files;
  await files.write("/workspace/big.bin", new Uint8Array(16 * 1048576));
  expect(chunks).toBe(16);
  expect(most).toBe(8);
});
