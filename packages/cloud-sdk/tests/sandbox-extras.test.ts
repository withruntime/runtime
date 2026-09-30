import { expect, test } from "bun:test";
import { Runtime, type FileEvent } from "../src/index";

/* sbx.files.watch, sbx.desktop.recordings and sbx.mcp against a stub API:
   the calls the SDK makes and what it hands back. The routes are tested in
   packages/cloud (watch, desktop-recording, mcp-catalog). */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
async function sandboxWith(routes: (request: Request, body: unknown) => Response) {
  const seen: string[] = [];
  const bodies: unknown[] = [];
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text =
        request.method === "GET" || !(request.headers.get("content-type") ?? "").includes("json")
          ? ""
          : await request.text();
      const body = text ? (JSON.parse(text) as unknown) : undefined;
      if (url.pathname === `/v1/sandboxes/${SANDBOX}` && request.method === "GET")
        return Response.json({ id: SANDBOX, kind: "sandbox", state: "running", status: "active" });
      seen.push(`${request.method} ${url.pathname}${url.search}`);
      bodies.push(body);
      return routes(request, body);
    }) as typeof fetch,
  });
  return { runtime, sbx: await runtime.sandboxes.get(SANDBOX), seen, bodies };
}
const ndjson = (lines: unknown[]) =>
  new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });

test("files.watch follows the stream across continue from its cursor and reports a pause", async () => {
  const { sbx, seen, bodies } = await sandboxWith((request) => {
    const url = new URL(request.url);
    if (request.method === "POST")
      return Response.json({ id: "w1", path: "/workspace", cursor: 10 });
    if (url.searchParams.get("cursor") === "10")
      return ndjson([
        {
          k: "events",
          events: [{ type: "create", path: "/workspace/a", isDir: false }],
          cursor: 40,
        },
        { k: "overflow", dropped: 2, reason: "rate", cursor: 50 },
        { k: "continue", cursor: 50 },
      ]);
    if (request.method === "DELETE") return Response.json({ stopped: true });
    return ndjson([{ k: "paused", cursor: 50 }]);
  });
  const events: FileEvent[] = [];
  const notices: unknown[] = [];
  const exits: string[] = [];
  const watch = await sbx.files.watch("/workspace", (event) => void events.push(event), {
    recursive: true,
    exclude: ["node_modules"],
    onNotice: (notice) => notices.push(notice),
    onExit: (reason) => exits.push(reason),
  });
  await watch.done;
  expect(events).toEqual([{ type: "create", path: "/workspace/a", isDir: false }]);
  expect(notices).toEqual([{ k: "overflow", dropped: 2, reason: "rate", cursor: 50 }]);
  expect(exits).toEqual(["paused"]);
  expect(watch.cursor).toBe(50);
  expect(bodies[0]).toEqual({ path: "/workspace", recursive: true, exclude: ["node_modules"] });
  expect(seen.filter((call) => call.includes("/events"))).toEqual([
    `GET /v1/sandboxes/${SANDBOX}/files/watches/w1/events?cursor=10&follow=true`,
    `GET /v1/sandboxes/${SANDBOX}/files/watches/w1/events?cursor=50&follow=true`,
  ]);
  await watch.stop();
  expect(seen.at(-1)).toBe(`DELETE /v1/sandboxes/${SANDBOX}/files/watches/w1`);
});

test("desktop recordings and MCP servers: the calls and bodies", async () => {
  const { runtime, sbx, seen, bodies } = await sandboxWith((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/video")) return new Response(new Uint8Array([0, 0, 0, 24]));
    if (url.pathname === "/v1/mcp/catalog") return Response.json({ data: [{ id: "github" }] });
    if (url.pathname.endsWith("/mcp"))
      return Response.json({
        running: true,
        port: 8765,
        servers: [{ name: "fetch", status: "ready", url: "u" }],
        warnings: [],
      });
    return Response.json({
      id: "rec-00000000aaaa",
      state: "recording",
      path: "/x.mp4",
      bytes: 0,
      reason: null,
    });
  });
  const rec = await sbx.desktop.recordings.start({ fps: 5, maxMiB: 64 });
  await sbx.desktop.recordings.stop(rec.id);
  expect((await sbx.desktop.recordings.download(rec.id)).length).toBe(4);
  expect((await runtime.mcp.catalog())[0]!.id).toBe("github");
  await sbx.mcp.start([{ id: "fetch" }], { port: 9000 });
  expect((await sbx.mcp.ready({ intervalMs: 1 })).servers[0]!.status).toBe("ready");
  await sbx.mcp.stop();
  expect(seen).toEqual([
    `POST /v1/sandboxes/${SANDBOX}/desktop/recordings`,
    `POST /v1/sandboxes/${SANDBOX}/desktop/recordings/rec-00000000aaaa:stop`,
    `GET /v1/sandboxes/${SANDBOX}/desktop/recordings/rec-00000000aaaa/video`,
    "GET /v1/mcp/catalog",
    `POST /v1/sandboxes/${SANDBOX}/mcp`,
    `GET /v1/sandboxes/${SANDBOX}/mcp`,
    `DELETE /v1/sandboxes/${SANDBOX}/mcp`,
  ]);
  expect(bodies[0]).toEqual({ fps: 5, maxMiB: 64 });
  expect(bodies[4]).toEqual({ servers: [{ id: "fetch" }], port: 9000 });
});

test("an uploaded file keeps its mode, and a directory unpacks with its modes", async () => {
  const { mkdtemp, writeFile, chmod, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const dir = await mkdtemp(nodePath.join(tmpdir(), "rt-mode-"));
  const script = nodePath.join(dir, "run.sh");
  await writeFile(script, "#!/bin/sh\necho hi\n");
  await chmod(script, 0o755);
  const { sbx, seen } = await sandboxWith((request) =>
    new URL(request.url).pathname.endsWith(":exec")
      ? Response.json({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      : Response.json({ ok: true }),
  );
  await sbx.files.upload(script, "/workspace/run.sh");
  expect(seen[0]).toBe(
    `PUT /v1/sandboxes/${SANDBOX}/files/content?path=%2Fworkspace%2Frun.sh&mode=755`,
  );
  await mkdir(nodePath.join(dir, "tree"));
  await writeFile(nodePath.join(dir, "tree", "x"), "x");
  await sbx.files.upload(nodePath.join(dir, "tree"), "/workspace/tree");
  expect(seen.at(-1)).toBe(`PUT /v1/sandboxes/${SANDBOX}/files/archive?path=%2Fworkspace%2Ftree`);
});

test("a webhook watch runs until stopped, and a preview names the sites that may embed it", async () => {
  const { sbx, seen, bodies } = await sandboxWith((request) =>
    request.method === "POST" && new URL(request.url).pathname.endsWith("/files/watches")
      ? Response.json({
          id: "sync",
          path: "/workspace/app",
          processId: "p1",
          state: "running",
          startedAt: 0,
          cursor: 0,
          webhook: true,
        })
      : Response.json({ port: 3000, embedOrigins: ["https://app.example.com"] }),
  );
  const watch = await sbx.files.watches.webhook("/workspace/app", { recursive: true, id: "sync" });
  expect(watch.webhook).toBe(true);
  expect(seen[0]).toBe(`POST /v1/sandboxes/${SANDBOX}/files/watches`);
  expect(bodies[0]).toEqual({
    path: "/workspace/app",
    recursive: true,
    id: "sync",
    timeoutMs: 0,
    webhook: true,
  });
  await sbx.previews.create(3000, { embedOrigins: ["https://app.example.com"] });
  expect(bodies[1]).toEqual({ port: 3000, embedOrigins: ["https://app.example.com"] });
});
