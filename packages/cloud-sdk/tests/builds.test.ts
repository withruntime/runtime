import { expect, test } from "bun:test";
import { builds, type Build, type BuildLogEvent } from "../src/products/builds.js";
import { ConnectionError, errorFor } from "../src/errors.js";
import { Transport, type Call } from "../src/transport.js";

const info: Build = {
  id: "build /?#",
  name: null,
  labels: {},
  repositoryId: "repo",
  ref: "main",
  branch: null,
  commit: "a".repeat(40),
  state: "queued",
  reason: null,
  timings: null,
  outputSnapshotId: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  error: null,
};
const path = "/v1/builds/build%20%2F%3F%23";
const line = (n: number): BuildLogEvent => ({
  type: "line",
  cursor: String(n),
  at: n,
  step: "compile",
  text: `line ${n}`,
  stream: "stdout",
});
const end = (n: number): BuildLogEvent => ({
  type: "terminal",
  cursor: String(n),
  state: "succeeded",
  reason: "deployed",
  failingStep: null,
});
function fake(
  answer: (call: Call) => unknown = () => info,
  stream: (call: Call, index: number) => AsyncGenerator<unknown> = async function* () {},
) {
  const calls: Call[] = [];
  const streams: Call[] = [];
  const transport = {
    async json<T>(call: Call): Promise<T> {
      calls.push(call);
      return (await answer(call)) as T;
    },
    events<T>(call: Call): AsyncGenerator<T> {
      streams.push(call);
      return stream(call, streams.length - 1) as AsyncGenerator<T>;
    },
  } as Transport;
  return { api: builds(transport), calls, streams };
}
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values = [];
  for await (const event of events) values.push(event);
  return values;
}

test("create/get/cancel and repository methods use exact paths, bodies and request options", async () => {
  const f = fake();
  const options = {
    idempotencyKey: "supplied-key",
    signal: new AbortController().signal,
    timeoutMs: 1234,
  };
  const input = {
    repositoryId: "repo",
    ref: "feature/test",
    name: "build",
    labels: { team: "web" },
  };
  expect(await f.api.create(input, options)).toEqual(info);
  await f.api.get(info.id, options);
  await f.api.cancel(info.id, options);
  const repo = {
    provider: "github" as const,
    repository: "acme/web",
    deploy: "app:web" as const,
    previews: false,
    productionBranch: "release",
  };
  await f.api.repositories.connect(repo, options);
  await f.api.repositories.update(
    "repo /?#",
    { repository: "withruntime/web", name: null },
    options,
  );
  await f.api.repositories.disconnect("repo /?#", options);
  expect(f.calls).toEqual([
    { method: "POST", path: "/v1/builds", body: input, ...options },
    { method: "GET", path, ...options },
    { method: "POST", path: `${path}:cancel`, ...options },
    { method: "POST", path: "/v1/repositories", body: repo, ...options },
    {
      method: "POST",
      path: "/v1/repositories/repo%20%2F%3F%23:update",
      body: { repository: "withruntime/web", name: null },
      ...options,
    },
    { method: "DELETE", path: "/v1/repositories/repo%20%2F%3F%23", ...options },
  ]);
});

test("both lists follow the shared data envelope and cursors, preserving filters and options", async () => {
  const f = fake((call) =>
    call.query?.cursor
      ? { data: [{ ...info, id: "second" }], nextCursor: null }
      : { data: [info], nextCursor: "next" },
  );
  for (const list of [f.api.list, f.api.repositories.list]) {
    const page = await list(
      { limit: 1, name: "web", label: ["team:web"] },
      { idempotencyKey: "read" },
    );
    expect((await collect<{ id: string }>(page)).map((row) => row.id)).toEqual([info.id, "second"]);
    expect(f.calls.at(-1)?.query).toEqual({
      limit: 1,
      name: "web",
      label: ["team:web"],
      cursor: "next",
    });
    expect(f.calls.at(-1)?.idempotencyKey).toBe("read");
    const pages = await collect<{ data: unknown[] }>((await list()).pages());
    expect(pages.length).toBe(2);
  }
});

test("default logs fetch a bounded tail; explicit cursors pass untouched", async () => {
  const tail = {
    lines: [line(1)],
    cursor: "1",
    state: "failed",
    reason: "step_failed",
    failingStep: { name: "compile", exitCode: 1, lastLines: ["error"] },
    hasMore: false,
    nextCursor: null,
  };
  const f = fake(() => tail);
  // The fake answers whatever it is given; the SDK passes the body through.
  expect(await f.api.logs(info.id)).toEqual(tail as never);
  expect(f.calls[0]).toEqual({ method: "GET", path: `${path}/logs`, query: {} });
  await f.api.logs(info.id, { cursor: "1", follow: false });
  expect(f.calls[1]?.query).toEqual({ cursor: "1", follow: false });
});

test("dropped connection resumes after delivered cursor, deduplicates replay, and yields terminal", async () => {
  const f = fake(undefined, async function* (_call, index) {
    if (index === 0) {
      yield line(1);
      yield line(2);
      throw new TypeError("connection reset");
    }
    yield line(2);
    yield line(3);
    yield end(3);
  });
  expect(await collect(f.api.logs(info.id, { follow: true }))).toEqual([
    line(1),
    line(2),
    line(3),
    end(3),
  ]);
  expect(f.streams.map((call) => call.query)).toEqual([
    { follow: true },
    { follow: true, cursor: "2" },
  ]);
});

test("EOF without terminal and transport ConnectionError resume; explicit continue preserves cursor", async () => {
  const f = fake(undefined, async function* (_call, index) {
    if (index === 0) {
      yield line(4);
      return;
    }
    if (index === 1)
      throw new ConnectionError({ code: "connection_error", message: "lost", status: 0 });
    if (index === 2) {
      yield { type: "continue", cursor: "4" };
      return;
    }
    yield line(5);
    yield end(5);
  });
  expect(await collect(f.api.logs(info.id, { follow: true, cursor: "3" }))).toEqual([
    line(4),
    line(5),
    end(5),
  ]);
  expect(f.streams.map((c) => c.query?.cursor)).toEqual(["3", "4", "4", "4"]);
});

test("repeated disconnects end with actionable code and last cursor, then caller can resume", async () => {
  const f = fake(undefined, async function* (_call, index) {
    if (index === 0) yield line(1);
  });
  await expect(collect(f.api.logs(info.id, { follow: true }))).rejects.toMatchObject({
    code: "build_log_interrupted",
    hint: expect.any(String),
    details: { cursor: "1" },
  });
  expect(f.streams.length).toBe(4);
  const recovered = fake(undefined, async function* () {
    yield line(2);
    yield end(2);
  });
  expect(await collect(recovered.api.logs(info.id, { follow: true, cursor: "1" }))).toEqual([
    line(2),
    end(2),
  ]);
});

test("HTTP refusals, cursor gaps and invalid terminal results are never swallowed", async () => {
  for (const status of [403, 404, 410]) {
    // eslint-disable-next-line require-yield -- a stream refused before its first event
    const f = fake(undefined, async function* () {
      throw errorFor(status, {
        error: { code: "build_log_cursor_expired", hint: "Read the tail." },
      });
    });
    await expect(collect(f.api.logs(info.id, { follow: true }))).rejects.toMatchObject({
      status,
      hint: "Read the tail.",
    });
    expect(f.streams.length).toBe(1);
  }
  for (const event of [
    { ...line(2), cursor: "a\nb" },
    { ...end(0), reason: null },
    { ...end(0), failingStep: undefined },
    { type: "error", cursor: "0", code: "broken" },
    { type: "nonsense", cursor: "0" },
    { ...line(1), text: 7 },
    { type: "continue", cursor: "a\nb" },
  ]) {
    const f = fake(undefined, async function* () {
      yield event;
    });
    await expect(collect(f.api.logs(info.id, { follow: true }))).rejects.toMatchObject({
      code: expect.stringMatching(/^build_log_(gap|invalid)$/),
      hint: expect.any(String),
    });
    expect(f.streams.length).toBe(1);
  }
  const f = fake(undefined, async function* () {
    yield { type: "error", cursor: null, code: "build_log_cursor_expired", hint: "Read the tail." };
  });
  await expect(collect(f.api.logs(info.id, { follow: true }))).rejects.toMatchObject({
    code: "build_log_cursor_expired",
    hint: "Read the tail.",
  });
});

test("invalid NDJSON is named and carries the last delivered cursor", async () => {
  const t = new Transport({
    apiKey: "fake",
    baseUrl: "http://127.0.0.1",
    maxRetries: 0,
    fetch: (async () =>
      new Response(`${JSON.stringify(line(1))}\ninvalid-json\n`, {
        headers: { "content-type": "application/x-ndjson" },
      })) as unknown as typeof fetch,
  });
  await expect(collect(builds(t).logs("build", { follow: true }))).rejects.toMatchObject({
    code: "build_log_invalid",
    hint: expect.any(String),
    details: { cursor: "1" },
  });
});

test("abort, early return and overall timeout close iterators without reconnecting", async () => {
  let closed = 0;
  const f = fake(undefined, async function* () {
    try {
      yield line(1);
      yield line(2);
    } finally {
      closed++;
    }
  });
  const controller = new AbortController();
  const iterator = f.api.logs(info.id, { follow: true }, { signal: controller.signal });
  await iterator.next();
  controller.abort(new Error("stop"));
  await expect(iterator.next()).rejects.toThrow("stop");
  expect(closed).toBe(1);
  expect(f.streams.length).toBe(1);
  for await (const _event of f.api.logs(info.id, { follow: true })) break;
  expect(closed).toBe(2);
  expect(f.streams.length).toBe(2);
  const empty = fake();
  await expect(
    collect(empty.api.logs(info.id, { follow: true }, { timeoutMs: 10 })),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(empty.streams.length).toBe(1);
});

test("real transport sends stable generated and supplied idempotency keys across a lost response", async () => {
  const calls: { path: string; method: string; key: string | null; body: unknown }[] = [];
  let lose = true;
  const t = new Transport({
    apiKey: "fake",
    baseUrl: "http://127.0.0.1",
    maxRetries: 1,
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      const text = await request.text();
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        key: request.headers.get("idempotency-key"),
        body: text ? JSON.parse(text) : undefined,
      });
      if (lose) {
        lose = false;
        throw new TypeError("response lost after accepting request");
      }
      return Response.json(info);
    }) as typeof fetch,
  });
  const api = builds(t);
  await api.create({ repositoryId: "repo", ref: "main" });
  expect(calls.length).toBe(2);
  expect(calls[0]?.key).toBeTruthy();
  expect(calls[1]).toEqual(calls[0]);
  await api.cancel(info.id, { idempotencyKey: "cancel-key" });
  expect(calls.at(-1)?.key).toBe("cancel-key");
  await api.repositories.connect({
    provider: "git",
    repository: "https://git.example/web",
    deploy: "function:api",
  });
  expect(calls.at(-1)?.key).toBeTruthy();
  await api.repositories.disconnect("repo");
  expect(calls.at(-1)?.key).toBeTruthy();
});

test("real NDJSON transport reconnects after a partial line without losing UTF-8 output", async () => {
  const queries: string[] = [];
  const encoder = new TextEncoder();
  const t = new Transport({
    apiKey: "fake",
    baseUrl: "http://127.0.0.1",
    maxRetries: 0,
    fetch: (async (url) => {
      queries.push(new URL(new Request(url).url).search);
      if (queries.length === 1) {
        let pull = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pull++ === 0)
                controller.enqueue(encoder.encode(`${JSON.stringify(line(1))}\n{"type":"li`));
              else controller.error(new TypeError("socket lost"));
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      const bytes = encoder.encode(
        `${JSON.stringify({ ...line(2), text: "café 🚀" })}\n${JSON.stringify(end(2))}\n`,
      );
      let pos = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (pos === bytes.length) controller.close();
            else controller.enqueue(bytes.slice(pos, ++pos));
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }) as typeof fetch,
  });
  expect(await collect(builds(t).logs("build", { follow: true }))).toEqual([
    line(1),
    { ...line(2), text: "café 🚀" } as BuildLogEvent,
    end(2),
  ]);
  expect(queries).toEqual(["?follow=true", "?follow=true&cursor=1"]);
});

test("opaque cursors and named steps survive gap events and reconnection", async () => {
  const a = { ...line(1), cursor: "opaque/Z=+/1", step: "install dependencies" };
  const b = { ...line(2), cursor: "opaque/A=+/9", step: "compile" };
  const gap: BuildLogEvent = { type: "gap", cursor: a.cursor, earliestCursor: b.cursor };
  const f = fake(undefined, async function* (_call, index) {
    if (index === 0) {
      yield a;
      throw new TypeError("lost");
    }
    yield a;
    yield gap;
    yield b;
    yield { ...end(2), cursor: b.cursor };
  });
  expect(await collect(f.api.logs(info.id, { follow: true }))).toEqual([
    a,
    gap,
    b,
    { ...end(2), cursor: b.cursor },
  ]);
  expect(f.streams[1]?.query?.cursor).toBe(a.cursor);
});

test("an initial retention gap establishes the server checkpoint without skipping its first line", async () => {
  const gap: BuildLogEvent = {
    type: "gap",
    cursor: "checkpoint/before-build",
    earliestCursor: "1",
  };
  const f = fake(undefined, async function* () {
    yield gap;
    yield line(1);
    yield end(1);
  });
  expect(await collect(f.api.logs(info.id, { follow: true }))).toEqual([gap, line(1), end(1)]);
});

test("successful continuations cannot reset the caller's overall follow deadline", async () => {
  let closed = 0;
  const f = fake(undefined, async function* () {
    try {
      yield { type: "continue", cursor: null };
    } finally {
      closed++;
    }
  });
  await expect(
    collect(f.api.logs(info.id, { follow: true }, { timeoutMs: 80 })),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(f.streams.length).toBeLessThanOrEqual(2);
  expect(closed).toBe(f.streams.length);
});

test("search page cursors pass unchanged and cannot be used as stream cursors", async () => {
  const f = fake();
  await f.api.logs(info.id, { pageCursor: "search/opaque" });
  expect(f.calls[0]?.query).toEqual({ pageCursor: "search/opaque" });
  await expect(
    collect(f.api.logs(info.id, { follow: true, pageCursor: "search/opaque" })),
  ).rejects.toMatchObject({ code: "invalid_log_options" });
  expect(f.streams).toHaveLength(0);
});

test("a transport that ignores abort cannot trap a follow beyond its deadline", async () => {
  // eslint-disable-next-line require-yield -- a stream that never sends anything
  const f = fake(undefined, async function* () {
    await new Promise(() => {});
  });
  await expect(
    collect(f.api.logs(info.id, { follow: true }, { timeoutMs: 10 })),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(f.streams).toHaveLength(1);
});
