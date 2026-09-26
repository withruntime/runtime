import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* sbx.previews, sbx.network and sbx.desktop against a stub API: the paths,
   methods and bodies the SDK sends, and what it hands back. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
async function sandboxWith(routes: (request: Request, body: unknown) => Response) {
  const seen: Array<{ call: string; body: unknown }> = [];
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.text();
      const body = text ? (JSON.parse(text) as unknown) : undefined;
      if (url.pathname === `/v1/sandboxes/${SANDBOX}` && request.method === "GET")
        return Response.json({ id: SANDBOX, kind: "sandbox", state: "running", status: "active" });
      seen.push({ call: `${request.method} ${url.pathname}${url.search}`, body });
      return routes(request, body);
    }) as typeof fetch,
  });
  return { sbx: await runtime.sandboxes.get(SANDBOX), seen };
}

test("previews: create, list, get with a token lifetime, rotate, delete", async () => {
  const preview = {
    id: "p1",
    port: 3000,
    url: "https://3000-x.preview.test/",
    token: "rtp1.k1.a.1.b",
  };
  const { sbx, seen } = await sandboxWith((request) =>
    new URL(request.url).pathname.endsWith("/previews") && request.method === "GET"
      ? Response.json({ data: [preview], nextCursor: null })
      : Response.json(preview),
  );
  expect((await sbx.previews.create(3000, { visibility: "public" })).url).toBe(preview.url);
  expect((await sbx.previews.list()).map((p) => p.id)).toEqual(["p1"]);
  await sbx.previews.get(3000, 3600);
  await sbx.previews.rotate(3000);
  await sbx.previews.delete(3000);
  expect(seen).toEqual([
    { call: `POST /v1/sandboxes/${SANDBOX}/previews`, body: { port: 3000, visibility: "public" } },
    { call: `GET /v1/sandboxes/${SANDBOX}/previews`, body: undefined },
    { call: `GET /v1/sandboxes/${SANDBOX}/previews/3000?ttlSeconds=3600`, body: undefined },
    { call: `POST /v1/sandboxes/${SANDBOX}/previews/3000:rotate`, body: undefined },
    { call: `DELETE /v1/sandboxes/${SANDBOX}/previews/3000`, body: undefined },
  ]);
});

test("network: set, off, on and get send the rules as a PUT", async () => {
  const { sbx, seen } = await sandboxWith(() => Response.json({ internet: false, version: 1 }));
  await sbx.network.set({
    internet: true,
    allow: ["registry.npmjs.org"],
    connect: ["db.example.com:5432"],
  });
  await sbx.network.off();
  await sbx.network.on();
  await sbx.network.get();
  expect(seen.map((s) => [s.call, s.body])).toEqual([
    [
      `PUT /v1/sandboxes/${SANDBOX}/network`,
      { internet: true, allow: ["registry.npmjs.org"], connect: ["db.example.com:5432"] },
    ],
    [`PUT /v1/sandboxes/${SANDBOX}/network`, { internet: false }],
    [`PUT /v1/sandboxes/${SANDBOX}/network`, { internet: true }],
    [`GET /v1/sandboxes/${SANDBOX}/network`, undefined],
  ]);
});

test("desktop: start, actions as one route, screenshot as bytes", async () => {
  const { sbx, seen } = await sandboxWith((request, body) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/desktop/screenshot")) return new Response(new Uint8Array([0x89, 0x50]));
    if ((body as { action?: string } | undefined)?.action === "windows")
      return Response.json({ windows: [{ id: "0x1", title: "Firefox" }] });
    return Response.json({ ok: true });
  });
  await sbx.desktop.start({ width: 1024, height: 768 });
  await sbx.desktop.click(10, 20, { button: "right" });
  await sbx.desktop.drag([1, 2], [3, 4]);
  await sbx.desktop.type("hi");
  await sbx.desktop.press("ctrl+l");
  expect((await sbx.desktop.windows())[0]!.title).toBe("Firefox");
  expect([...(await sbx.desktop.screenshot({ format: "jpeg" }))]).toEqual([0x89, 0x50]);
  expect(seen.map((s) => [s.call, s.body])).toEqual([
    [`POST /v1/sandboxes/${SANDBOX}/desktop:start`, { width: 1024, height: 768 }],
    [
      `POST /v1/sandboxes/${SANDBOX}/desktop:act`,
      { action: "click", x: 10, y: 20, button: "right" },
    ],
    [`POST /v1/sandboxes/${SANDBOX}/desktop:act`, { action: "drag", from: [1, 2], to: [3, 4] }],
    [`POST /v1/sandboxes/${SANDBOX}/desktop:act`, { action: "type", text: "hi" }],
    [`POST /v1/sandboxes/${SANDBOX}/desktop:act`, { action: "key", keys: "ctrl+l" }],
    [`POST /v1/sandboxes/${SANDBOX}/desktop:act`, { action: "windows" }],
    [`GET /v1/sandboxes/${SANDBOX}/desktop/screenshot?format=jpeg`, undefined],
  ]);
});
