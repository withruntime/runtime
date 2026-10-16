import { describe, expect, test } from "bun:test";
import { Transport } from "../transport.js";
import { InvalidRequestError, NotFoundError, RuntimeError } from "../errors.js";
import {
  alerts,
  logs,
  traces,
  type LogLine,
  type ObservabilityClient,
  type SavedView,
} from "./logs.js";

const line: LogLine = {
  time: "2026-10-06T12:00:00.000000001Z",
  timeUnixNano: "1791288000000000001",
  severity: 9,
  severityText: "INFO",
  body: "same α",
  labels: { app: "api" },
  attributes: {},
  traceId: null,
  spanId: null,
};
const view = { name: "errors", labels: {}, query: '{app="api"}' };
const rule = { ...view, condition: "above 5", for: "5m", actions: [] };
const options = { idempotencyKey: "repeat-this-write" };
function fixture(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const transport = new Transport({
    apiKey: "test-only",
    baseUrl: "https://fake.test",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({ url, init: init ?? {} });
      return handler(url, init ?? {});
    }) as typeof fetch,
  });
  return {
    client: { logs: logs(transport), traces: traces(transport), alerts: alerts(transport) },
    requests,
  };
}
type Case = {
  name: string;
  method: string;
  path: string;
  run(c: ObservabilityClient): Promise<unknown>;
  query?: Record<string, string>;
  body?: unknown;
};
const calls: Case[] = [
  {
    name: "search",
    method: "POST",
    path: "/v1/logs:search",
    body: { query: "{}", cursor: "c", limit: 2 },
    run: (c) => c.logs.search({ query: "{}", cursor: "c", limit: 2 }, options),
  },
  {
    name: "instant query",
    method: "GET",
    path: "/v1/logs/query",
    query: { query: "{}", time: "42", direction: "forward", limit: "2" },
    run: (c) => c.logs.query({ query: "{}", time: "42", direction: "forward", limit: 2 }),
  },
  {
    name: "range query",
    method: "GET",
    path: "/v1/logs/query_range",
    query: { query: "{}", start: "1", end: "2", step: "1s" },
    run: (c) => c.logs.queryRange({ query: "{}", start: "1", end: "2", step: "1s" }),
  },
  {
    name: "labels",
    method: "GET",
    path: "/v1/logs/labels",
    query: { start: "1", end: "2" },
    run: (c) => c.logs.labels({ start: "1", end: "2" }),
  },
  {
    name: "label values",
    method: "GET",
    path: "/v1/logs/labels/a%2Fb/values",
    run: (c) => c.logs.labelValues("a/b"),
  },
  { name: "trace get", method: "GET", path: "/v1/traces/a%2Fb", run: (c) => c.traces.get("a/b") },
  {
    name: "trace search",
    method: "GET",
    path: "/v1/traces:search",
    query: { q: "{duration > 1s}" },
    run: (c) => c.traces.search("{duration > 1s}"),
  },
  { name: "trace tags", method: "GET", path: "/v1/traces/tags", run: (c) => c.traces.tags() },
  {
    name: "log ingest",
    method: "POST",
    path: "/v1/logs",
    body: { resourceLogs: [] },
    run: (c) => c.logs.ingest({ resourceLogs: [] }, options),
  },
  {
    name: "trace ingest",
    method: "POST",
    path: "/v1/traces",
    body: { resourceSpans: [] },
    run: (c) => c.traces.ingest({ resourceSpans: [] }, options),
  },
  {
    name: "test rule",
    method: "POST",
    path: "/v1/alerts/a%2Fb/test",
    body: {},
    run: (c) => c.alerts.test("a/b", options),
  },
  {
    name: "silence rule",
    method: "POST",
    path: "/v1/alerts/a%2Fb/silence",
    body: { until: "2026-10-07T00:00:00Z" },
    run: (c) => c.alerts.silence("a/b", { until: "2026-10-07T00:00:00Z" }, options),
  },
];
for (const product of ["logs", "traces", "alerts"] as const) {
  const path = `/v1/${product}${product === "alerts" ? "" : "/views"}`;
  const resource = (c: ObservabilityClient) => (product === "alerts" ? c.alerts : c[product].views);
  const input = product === "alerts" ? rule : view;
  calls.push(
    {
      name: `${product} create`,
      method: "POST",
      path,
      body: input,
      run: (c) => resource(c).create(input as typeof rule, options),
    },
    {
      name: `${product} get`,
      method: "GET",
      path: `${path}/a%2Fb`,
      run: (c) => resource(c).get("a/b"),
    },
    {
      name: `${product} list`,
      method: "GET",
      path,
      query: { limit: "2", cursor: "next" },
      run: (c) => resource(c).list({ limit: 2, cursor: "next" }),
    },
    {
      name: `${product} update`,
      method: "PUT",
      path: `${path}/a%2Fb`,
      body: { name: "changed" },
      run: (c) => resource(c).update("a/b", { name: "changed" }, options),
    },
    {
      name: `${product} delete`,
      method: "DELETE",
      path: `${path}/a%2Fb`,
      run: (c) => resource(c).delete("a/b", options),
    },
  );
}
for (const entry of calls)
  describe(entry.name, () => {
    test("request, encoded path and idempotency", async () => {
      const { client, requests } = fixture(() =>
        entry.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({ data: [], nextCursor: null, marker: "answer" }),
      );
      const answer = await entry.run(client);
      if (entry.method === "DELETE") expect(answer).toBeNull();
      else if (!entry.name.endsWith(" list"))
        expect(answer).toEqual({ data: [], nextCursor: null, marker: "answer" });
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url.pathname).toBe(entry.path);
      expect(request.init.method).toBe(entry.method);
      expect(Object.fromEntries(request.url.searchParams)).toEqual(entry.query ?? {});
      if (entry.body !== undefined)
        expect(JSON.parse(request.init.body as string)).toEqual(entry.body);
      if (entry.method !== "GET")
        expect(new Headers(request.init.headers).get("idempotency-key")).toBe(
          options.idempotencyKey,
        );
    });
    test("typed server error preserves code and hint", async () => {
      const { client } = fixture(() =>
        Response.json(
          { error: { code: "not_found", message: "Missing", hint: "List resources first." } },
          { status: 404 },
        ),
      );
      try {
        await entry.run(client);
        throw new Error("Accepted failure");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        expect(error).toMatchObject({ code: "not_found", hint: "List resources first." });
      }
    });
  });

test("search paging follows opaque cursors and preserves equal timestamp lines", async () => {
  const { client, requests } = fixture((_url, init) =>
    Response.json({
      lines: [line],
      next: JSON.parse(init.body as string).cursor ? null : "opaque/+",
      stats: {},
    }),
  );
  const pages = [];
  for await (const page of client.logs.pages({ query: "{}", limit: 1 })) pages.push(page);
  expect(pages.flatMap((page) => page.lines)).toEqual([line, line]);
  expect(JSON.parse(requests[1]!.init.body as string).cursor).toBe("opaque/+");
});
test("search detects a cursor loop", async () => {
  const { client } = fixture(() => Response.json({ lines: [], next: "same" }));
  const iterator = client.logs.pages({ query: "{}", cursor: "same" });
  await iterator.next();
  await expect(iterator.next()).rejects.toMatchObject({ code: "invalid_stream" });
});
test("resource lists can follow pages", async () => {
  const { client } = fixture((url) =>
    Response.json({
      data: [{ id: url.searchParams.get("cursor") ?? "first" }],
      nextCursor: url.searchParams.has("cursor") ? null : "second",
    }),
  );
  expect(await (await client.logs.views.list()).toArray()).toEqual([
    { id: "first" },
    { id: "second" },
  ] as SavedView[]);
});
test("UTF-8 bytes enforce the 1 MiB ingest bound before fetch", () => {
  const { client, requests } = fixture(() => {
    throw new Error("No fetch allowed");
  });
  expect(() => client.logs.ingest({ resourceLogs: [{ body: "α".repeat(530_000) }] })).toThrow(
    InvalidRequestError,
  );
  expect(() => client.traces.ingest({ resourceSpans: [{ body: "α".repeat(530_000) }] })).toThrow(
    InvalidRequestError,
  );
  expect(requests).toHaveLength(0);
});
const event = (id: string, value: unknown = line, kind = "") =>
  `id: ${id}\r\n${kind ? `event: ${kind}\r\n` : ""}data: ${JSON.stringify(value)}\r\n\r\n`;
function sse(text: string, bytes = 7) {
  const encoded = new TextEncoder().encode(text);
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at === encoded.length) controller.close();
        else {
          controller.enqueue(encoded.slice(at, at + bytes));
          at = Math.min(at + bytes, encoded.length);
        }
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
test("SSE reconnects by cursor, discards torn events, keeps identical records and decodes split UTF-8", async () => {
  let count = 0;
  const { client, requests } = fixture(() =>
    ++count === 1
      ? sse(`: heartbeat\r\n\r\n${event("one")}id: torn\ndata: {`)
      : sse(event("one") + event("two")),
  );
  const iterator = client.logs.tail("{}", { reconnectMs: 0 });
  expect((await iterator.next()).value).toEqual({ ...line, cursor: "one" });
  expect((await iterator.next()).value).toEqual({ ...line, cursor: "two" });
  expect(requests[1]!.url.searchParams.get("cursor")).toBe("one");
  expect(new Headers(requests[0]!.init.headers).get("accept")).toBe("text/event-stream");
  await iterator.return(undefined);
});
test("a drop before the first line resumes from the start event's cursor", async () => {
  let count = 0;
  const { client, requests } = fixture(() =>
    ++count === 1
      ? sse(event("began", { cursor: "began" }, "start"))
      : sse(event("began", { cursor: "began" }, "start") + event("first")),
  );
  const iterator = client.logs.tail("{}", { reconnectMs: 0 });
  expect((await iterator.next()).value).toEqual({ ...line, cursor: "first" });
  expect(requests[0]!.url.searchParams.get("cursor")).toBeNull();
  expect(requests[1]!.url.searchParams.get("cursor")).toBe("began");
  await iterator.return(undefined);
});
test("server retention gap becomes typed from/to and resumes after it", async () => {
  const { client } = fixture(() => sse(event("kept", { cursor: "kept" }, "gap") + event("later")));
  const iterator = client.logs.tail("{}", { cursor: "expired", reconnectMs: 0 });
  expect((await iterator.next()).value).toEqual({ gap: true, from: "expired", to: "kept" });
  expect((await iterator.next()).value).toMatchObject({ cursor: "later" });
  await iterator.return(undefined);
});
test("reader error, including an echoed cursor, reconnects without moving the cursor", async () => {
  let calls = 0;
  const { client, requests } = fixture(() =>
    sse(++calls === 1 ? event("old", { message: "reader gone" }, "error") : event("new")),
  );
  const iterator = client.logs.tail("{}", { cursor: "old", reconnectMs: 0 });
  expect((await iterator.next()).value).toMatchObject({ cursor: "new" });
  expect(requests[1]!.url.searchParams.get("cursor")).toBe("old");
  await iterator.return(undefined);
});
for (const [name, wire] of [
  ["JSON", "id: a\ndata: nope\n\n"],
  ["cursor", `data: ${JSON.stringify(line)}\n\n`],
  ["line", event("a", {})],
  ["gap", event("a", { cursor: "wrong" }, "gap")],
  ["oversized event", `id: a\ndata: ${"x".repeat(1_048_577)}\n\n`],
] as const)
  test(`invalid ${name} fails once with a code and hint`, async () => {
    const { client, requests } = fixture(() => sse(wire, wire.length));
    await expect(
      client.logs.tail("{}", { cursor: "before", reconnectMs: 0 }).next(),
    ).rejects.toMatchObject({ code: "invalid_stream", hint: expect.any(String) });
    expect(requests).toHaveLength(1);
  });
test("tail authentication errors do not reconnect", async () => {
  const { client, requests } = fixture(() =>
    Response.json({ error: { code: "unauthorized", hint: "Sign in." } }, { status: 401 }),
  );
  await expect(client.logs.tail("{}").next()).rejects.toMatchObject({
    code: "unauthorized",
    hint: "Sign in.",
  });
  expect(requests).toHaveLength(1);
});
test("aborting an idle connection closes its reader", async () => {
  let cancelled = false;
  const { client } = fixture(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const abort = new AbortController();
  const iterator = client.logs.tail("{}", { signal: abort.signal });
  const pending = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort(new Error("test stop"));
  await expect(pending).rejects.toThrow("test stop");
  expect(cancelled).toBe(true);
});
test("non-SSE success is refused", async () => {
  const { client } = fixture(() => Response.json({}));
  await expect(client.logs.tail("{}").next()).rejects.toBeInstanceOf(RuntimeError);
});

test("an abrupt read failure reconnects, rather than only handling clean EOF", async () => {
  let attempt = 0;
  const { client, requests } = fixture(() => {
    if (++attempt > 1) return sse(event("second"));
    let pulled = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!pulled) {
            pulled = true;
            controller.enqueue(new TextEncoder().encode(event("first")));
          } else controller.error(new Error("connection reset"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const iterator = client.logs.tail("{}", { reconnectMs: 0 });
  expect((await iterator.next()).value).toMatchObject({ cursor: "first" });
  expect((await iterator.next()).value).toMatchObject({ cursor: "second" });
  expect(requests[1]!.url.searchParams.get("cursor")).toBe("first");
  await iterator.return(undefined);
});
test("a multline SSE event and the agreed from/to gap shape are accepted", async () => {
  const { client } = fixture(() =>
    sse('event: gap\nid: kept\ndata: {"from":"old",\ndata: "to":"kept"}\n\n'),
  );
  const iterator = client.logs.tail("{}", { cursor: "old" });
  expect((await iterator.next()).value).toEqual({ gap: true, from: "old", to: "kept" });
  await iterator.return(undefined);
});
test("abort during reconnect delay stops without another request", async () => {
  const abort = new AbortController();
  const { client, requests } = fixture(() => sse(event("first")));
  const iterator = client.logs.tail("{}", { signal: abort.signal, reconnectMs: 1000 });
  await iterator.next();
  const pending = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort(new Error("stop reconnect"));
  await expect(pending).rejects.toThrow("stop reconnect");
  expect(requests).toHaveLength(1);
});
