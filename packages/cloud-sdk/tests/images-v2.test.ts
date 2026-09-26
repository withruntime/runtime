import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { chunkArchive, dockerignoreFilter, packContext } from "../src/image-context";
import { Runtime } from "../src/index";

/* Build contexts from a folder, their chunked upload, streamed build logs,
   versions and tags, and registry credentials, against a stub API. */

function stub(routes: (request: Request, body: unknown) => Response | Promise<Response>) {
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    const type = request.headers.get("content-type") ?? "";
    const body =
      request.method === "GET"
        ? undefined
        : type.includes("json")
          ? JSON.parse(await request.text())
          : new Uint8Array(await request.arrayBuffer());
    return routes(request, body);
  }) as typeof fetch;
  return {
    runtime: new Runtime({
      apiKey: "rt_test",
      baseUrl: "http://localhost",
      fetch: fetcher,
      maxRetries: 0,
    }),
    seen,
  };
}
const json = (value: unknown) => Response.json(value);

async function folder(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "rt-ctx-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("a folder packs its .dockerignore'd files, the same bytes every time", async () => {
  const root = await folder({
    ".dockerignore": "node_modules\n*.log\n!keep.log\n",
    "app/main.py": "print(1)\n",
    "node_modules/x/index.js": "x",
    "debug.log": "noise",
    "keep.log": "kept",
    Dockerfile: "FROM python:3.12\nCOPY . .\n",
  });
  try {
    const packed = await packContext(root);
    expect(packed.files.map((f) => f.path)).toEqual([
      ".dockerignore",
      "Dockerfile",
      "app/main.py",
      "keep.log",
    ]);
    expect(packed.dockerignore).toContain("node_modules");
    expect(new TextDecoder().decode(gunzipSync(packed.archive))).toContain("print(1)");
    const again = await packContext(root);
    expect(Buffer.from(again.archive).equals(Buffer.from(packed.archive))).toBe(true);
    const chunks = await chunkArchive(new Uint8Array(2_500_000).fill(1));
    expect(chunks.chunks.map((c) => c.bytes.length)).toEqual([1048576, 1048576, 402848]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the SDK's .dockerignore reads patterns as the server does", () => {
  const ignored = dockerignoreFilter("**/*.tmp\nbuild/\n!build/keep\n# note\n/secret\n");
  expect(["a/b.tmp", "build/x", "secret/k"].map(ignored)).toEqual([true, true, true]);
  expect(["build/keep", "src/secret", "main.py"].map(ignored)).toEqual([false, false, false]);
});

test("build with contextDir uploads only the chunks the server lacks, then streams the log", async () => {
  const root = await folder({
    "main.py": "print(2)\n",
    Dockerfile: "FROM python:3.12\nCOPY . .\n",
  });
  let created: Record<string, unknown> = {};
  const put: string[] = [];
  try {
    const { runtime } = stub((request, body) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/images/context/missing")
        return json({ missing: (body as { digests: string[] }).digests });
      if (url.pathname.startsWith("/v1/images/context/")) {
        put.push(url.pathname.split("/").at(-1)!);
        return json({ sha256: "x", size: (body as Uint8Array).length, stored: true });
      }
      if (url.pathname === "/v1/images" && request.method === "POST") {
        created = body as Record<string, unknown>;
        return json({ id: "img-9", state: "queued" });
      }
      if (url.pathname === "/v1/images/img-9/logs" && url.searchParams.get("follow") === "true")
        return new Response(
          [
            { type: "line", seq: 1, at: "t", stream: "system", text: "Unpacked 2 files" },
            { type: "line", seq: 2, at: "t", stream: "build", text: "done" },
            { type: "done", state: "ready", image: { id: "img-9", state: "ready", version: 3 } },
          ]
            .map((e) => JSON.stringify(e))
            .join("\n"),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      return new Response("{}", { status: 404 });
    });
    const lines: string[] = [];
    const image = await runtime.images.build(
      { name: "app", dockerfile: "FROM python:3.12\nCOPY . .\n", contextDir: root },
      { onLog: (line) => lines.push(line.text), pollMs: 1 },
    );
    expect(image).toMatchObject({ id: "img-9", state: "ready", version: 3 });
    expect(lines).toEqual(["Unpacked 2 files", "done"]);
    const context = created.context as { archive: { chunks: string[] }; files: { path: string }[] };
    expect(context.files.map((f) => f.path)).toEqual(["Dockerfile", "main.py"]);
    expect(put).toEqual(context.archive.chunks);
    expect(created.contextDir).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tags, versions and names resolve to ids; registries never send a secret back", async () => {
  const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
  const { runtime, seen } = stub((request, body) => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/images/resolve") return json({ id: ID, version: 2 });
    if (url.pathname === `/v1/images/${ID}:tag`)
      return json({ id: ID, tags: [(body as { tag: string }).tag] });
    if (url.pathname === "/v1/images/registries" && request.method === "POST")
      return json({ id: "r", registry: "ghcr.io", kind: "basic", username: "me" });
    if (url.pathname === "/v1/images/registries") return json({ data: [] });
    if (url.pathname === `/v1/images/${ID}:delete`) return json({ id: ID, state: "deleting" });
    if (url.pathname === "/v1/images") return json({ data: [], nextCursor: null });
    return new Response("{}", { status: 404 });
  });
  expect((await runtime.images.tag("web:v2", "prod")).tags).toEqual(["prod"]);
  expect((await runtime.images.delete("web@2")).state).toBe("deleting");
  await runtime.images.versions("web");
  expect(
    await runtime.images.registries.set({ registry: "ghcr.io", username: "me", password: "p" }),
  ).toMatchObject({
    registry: "ghcr.io",
  });
  expect(seen).toEqual([
    "GET /v1/images/resolve?ref=web%3Av2",
    `POST /v1/images/${ID}:tag`,
    "GET /v1/images/resolve?ref=web%402",
    `POST /v1/images/${ID}:delete`,
    "GET /v1/images?name=web&limit=100",
    "POST /v1/images/registries",
  ]);
});
