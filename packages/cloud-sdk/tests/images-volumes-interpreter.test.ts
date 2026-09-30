import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* The image, volume and interpreter products against a stub API: the paths and
   bodies the SDK sends, the build helper's polling and log streaming, and the
   interpreter's NDJSON stream turned into callbacks and one Execution. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
function stub(routes: (request: Request, body: unknown) => Response | Promise<Response>) {
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    const text = request.method === "GET" ? "" : await request.text();
    return routes(request, text ? JSON.parse(text) : undefined);
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

test("an interpreter cell without a deadline preserves zero and can still be cancelled", async () => {
  const { runtime } = stub(async (request, body) => {
    if (request.method === "GET")
      return json({ id: SANDBOX, kind: "sandbox", state: "running", status: "active" });
    expect(body).toMatchObject({ timeoutMs: 0 });
    await Bun.sleep(30);
    request.signal.throwIfAborted();
    return json({ status: "ok" });
  });
  const sbx = await runtime.sandboxes.get(SANDBOX);
  expect((await sbx.interpreter.run("1", { timeoutMs: 0 })).status).toBe("ok");
  await expect(
    sbx.interpreter.run("1", { timeoutMs: 0, signal: AbortSignal.timeout(5) }),
  ).rejects.toMatchObject({ code: "timeout" });
  await expect(
    sbx.interpreter.run("1", { timeoutMs: 0, requestTimeoutMs: 5 }),
  ).rejects.toMatchObject({ code: "timeout" });
});

test("snapshot pagination forwards cancellation after the first page", async () => {
  const controller = new AbortController();
  const { runtime } = stub((request) => {
    request.signal.throwIfAborted();
    return json({ data: [{ id: "first" }], nextCursor: "next" });
  });
  const first = await runtime.snapshots.list({}, { signal: controller.signal });
  expect(first.data[0]?.id).toBe("first");
  controller.abort();
  await expect(first.next()).rejects.toMatchObject({ code: "timeout" });
});

test("images.build polls to ready and streams the build log", async () => {
  let polls = 0;
  const { runtime, seen } = stub((request, body) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/images") {
      expect(body).toEqual({ recipe: { pip: ["pandas"] } });
      return json({ id: "img-1", state: "queued" });
    }
    if (path === "/v1/images/img-1/logs") {
      const after = Number(new URL(request.url).searchParams.get("after"));
      return json({
        lines: after === 0 ? [{ seq: 1, at: "t", stream: "system", text: "pulling" }] : [],
        nextAfter: 1,
        state: "building",
        truncated: false,
        done: false,
      });
    }
    if (path === "/v1/images/img-1")
      return json({ id: "img-1", state: ++polls < 2 ? "building" : "ready" });
    return new Response("{}", { status: 404 });
  });
  const lines: string[] = [];
  const image = await runtime.images.build(
    { recipe: { pip: ["pandas"] } },
    { onLog: (l) => lines.push(l.text), pollMs: 1 },
  );
  expect(image.state).toBe("ready");
  expect(lines).toEqual(["pulling"]);
  expect(seen[0]).toBe("POST /v1/images");
});

test("a failed build throws with the build's error", async () => {
  const { runtime } = stub((request) =>
    new URL(request.url).pathname === "/v1/images"
      ? json({ id: "img-2", state: "queued" })
      : json({ id: "img-2", state: "failed", error: "The command exited with code 1." }),
  );
  expect(runtime.images.build({ image: "alpine:3.20" }, { pollMs: 1 })).rejects.toThrow(
    "exited with code 1",
  );
});

test("volumes: create waits briefly, list pages, delete posts", async () => {
  const { runtime, seen } = stub((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/volumes" && request.method === "POST") {
      expect(request.headers.get("prefer")).toBe("wait=10");
      return json({ id: "vol-1", state: "ready", sizeMiB: 1024, backedUp: false });
    }
    if (path === "/v1/volumes") return json({ data: [{ id: "vol-1" }], nextCursor: null });
    return json({ id: "vol-1", state: "deleting" });
  });
  expect((await runtime.volumes.create({ sizeMiB: 1024 })).backedUp).toBe(false);
  expect((await runtime.volumes.list()).data).toHaveLength(1);
  expect((await runtime.volumes.delete("vol-1")).state).toBe("deleting");
  expect(seen).toEqual(["POST /v1/volumes", "GET /v1/volumes", "POST /v1/volumes/vol-1:delete"]);
});

test("sbx.interpreter.run returns the execution, and streams callbacks when asked", async () => {
  const execution = {
    id: "e1",
    status: "ok",
    stdout: "hi\n",
    results: [{ main: true, data: { "text/plain": "2" }, refs: {} }],
  };
  const { runtime } = stub((request, body) => {
    const path = new URL(request.url).pathname;
    if (path === `/v1/sandboxes/${SANDBOX}`)
      return json({ id: SANDBOX, kind: "sandbox", state: "running", status: "active" });
    if (path === `/v1/sandboxes/${SANDBOX}/interpreter:run`) {
      if (!(body as { stream?: boolean }).stream) return json(execution);
      const events = [
        { k: "start", id: "e1", n: 1 },
        { k: "stdout", id: "e1", text: "hi\n" },
        { k: "result", id: "e1", main: true, data: { "text/plain": "2" }, refs: {} },
        { k: "end", id: "e1", status: "ok", ms: 1 },
        { k: "execution", execution },
      ];
      return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  const sbx = await runtime.sandboxes.get(SANDBOX);
  expect((await sbx.interpreter.run("1 + 1")).results[0]!.data["text/plain"]).toBe("2");
  const out: string[] = [];
  const results: unknown[] = [];
  const streamed = await sbx.interpreter.run("print('hi'); 1 + 1", {
    onStdout: (text) => out.push(text),
    onResult: (result) => results.push(result.data),
  });
  expect(out).toEqual(["hi\n"]);
  expect(results).toEqual([{ "text/plain": "2" }]);
  expect(streamed.id).toBe("e1");
  expect(() => sbx.interpreter.result({ path: "/etc/passwd" })).toThrow(
    "Not an interpreter result path",
  );
});

test("a streamed cell's failure is a RuntimeError with its hint and request id", async () => {
  // 28 September 2026: it was a plain Error, and the CLI printed
  // "Error: forbidden: cloud forbidden" with nothing to act on or quote.
  const { runtime } = stub((request) => {
    const path = new URL(request.url).pathname;
    if (path === `/v1/sandboxes/${SANDBOX}`)
      return json({ id: SANDBOX, kind: "sandbox", state: "running", status: "active" });
    return new Response(
      `${JSON.stringify({
        k: "failure",
        code: "forbidden",
        status: 403,
        message: "This key's scopes do not include exec, which this needs.",
        hint: "The message says what this key lacks.",
        requestId: "req_cell",
      })}\n`,
      { headers: { "content-type": "application/x-ndjson" } },
    );
  });
  const sbx = await runtime.sandboxes.get(SANDBOX);
  const error = await sbx.interpreter.run("1", { onStdout: () => {} }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toMatchObject({
    name: "RuntimeError",
    code: "forbidden",
    status: 403,
    hint: "The message says what this key lacks.",
    requestId: "req_cell",
  });
});
