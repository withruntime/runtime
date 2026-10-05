import { expect, test } from "bun:test";
import type { RuntimeError } from "../src/index";
import { ConnectionError, Runtime } from "../src/index";
import { run } from "../src/cli";

/* A streamed exec that loses output, loses its connection or is cancelled
   (user lane, 25 September 2026): lost output must never pass as whole, a cut
   connection after the command started must not end the command's output,
   and Ctrl-C must stop the command in the sandbox, not only the CLI. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const info = { id: ID, kind: "sandbox", state: "running", status: "active", labels: {} };
type Line = Record<string, unknown>;

/** An NDJSON body that sends `lines`, then ends, fails, or stays open. */
function stream(lines: Line[], end: "close" | "fail" | "hang" = "close", signal?: AbortSignal) {
  const encoder = new TextEncoder();
  const queue = lines.map((line) => encoder.encode(`${JSON.stringify(line)}\n`));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (end === "hang")
          signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
      // One line a read, so a failure comes after what was sent, as it does
      // when a connection drops mid-stream.
      pull(controller) {
        const next = queue.shift();
        if (next) controller.enqueue(next);
        else if (end === "close") controller.close();
        else if (end === "fail") controller.error(new TypeError("terminated"));
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

function server(
  answer: (method: string, url: URL, init: RequestInit) => Response | undefined,
  options: { maxRetries?: number } = {},
) {
  const calls: string[] = [];
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
    return answer(init.method ?? "GET", url, init) ?? Response.json(info);
  }) as unknown as typeof fetch;
  const runtime = new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: fetcher,
    ...options,
  });
  return { runtime, calls };
}

test("output the stream skipped is reported lost even when the server did not say so", async () => {
  const { runtime } = server((method, url) =>
    method === "POST" && url.pathname.endsWith(":exec")
      ? stream([
          { type: "start", processId: "p1" },
          { type: "stdout", data: "a\n", offset: 0 },
          { type: "stdout", data: "b\n", offset: 10 },
          { type: "exit", exitCode: 0, state: "exited", timedOut: false },
        ])
      : undefined,
  );
  const sbx = await runtime.sandboxes.get(ID);
  const events: Line[] = [];
  for await (const event of sbx.execStream("x")) events.push(event);
  expect(events[2]).toEqual({ type: "truncated", droppedBytes: 8, resumeAt: 10 });
  const result = await sbx.exec("x", { onStdout: () => {} });
  expect(result).toMatchObject({ exitCode: 0, stdout: "a\nb\n", stdoutTruncated: true });
});

test("a server's own truncated event is reported once, not again for the same gap", async () => {
  const { runtime } = server((method, url) =>
    method === "POST" && url.pathname.endsWith(":exec")
      ? stream([
          { type: "start", processId: "p1" },
          { type: "truncated", droppedBytes: 10, resumeAt: 10 },
          { type: "stdout", data: "b\n", offset: 10 },
          { type: "exit", exitCode: 0, state: "exited", timedOut: false },
        ])
      : undefined,
  );
  const events: string[] = [];
  for await (const event of (await runtime.sandboxes.get(ID)).execStream("x"))
    events.push(event.type);
  expect(events).toEqual(["start", "truncated", "stdout", "exit"]);
});

test("a connection cut after the command started is followed from where it stopped", async () => {
  const { runtime, calls } = server((method, url) => {
    if (method === "POST" && url.pathname.endsWith(":exec"))
      return stream(
        [
          { type: "start", processId: "p1" },
          { type: "stdout", data: "a\n", offset: 0 },
        ],
        "fail",
      );
    if (url.pathname.endsWith("/processes/p1/output"))
      return stream([
        { type: "stdout", data: "b\n", offset: 2 },
        { type: "exit", exitCode: 0, state: "exited", timedOut: false },
      ]);
    return undefined;
  });
  const result = await (await runtime.sandboxes.get(ID)).exec("x", { onStdout: () => {} });
  expect(result).toMatchObject({ exitCode: 0, stdout: "a\nb\n", stdoutTruncated: false });
  expect(calls).toContain(`GET /v1/sandboxes/${ID}/processes/p1/output?cursor=2&follow=true`);
});

test("a stream that keeps closing with nothing new is given up with the process named", async () => {
  const { runtime, calls } = server((method, url) => {
    if (method === "POST" && url.pathname.endsWith(":exec"))
      return stream([{ type: "start", processId: "p1" }]);
    if (url.pathname.endsWith("/processes/p1/output")) return stream([]);
    return undefined;
  });
  const error = await (
    await runtime.sandboxes.get(ID)
  )
    .exec("x", { onStdout: () => {} })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConnectionError);
  expect((error as RuntimeError).details).toEqual({ sandboxId: ID, processId: "p1" });
  expect((error as RuntimeError).hint).toContain(`runtime sandbox logs ${ID} p1 -f`);
  expect(calls.filter((c) => c.includes("/output")).length).toBe(4);
});

test("an hours-long command outlives a spell of refusals and cuts while its output is followed", async () => {
  /* A thousand agents each follow a long command, reconnecting every 110 s.
     A reconnect that meets a busy API (503 busy, 429), a host restarting (an
     error event with a passing status) or a dropped connection must keep
     following: the command is still running. Four such in a row used to end
     the exec with "keeps closing" and fail the agent's task. */
  const busy = (code: string, status: number) =>
    Response.json({ error: { code, status, message: "m", retryAfterMs: 1 } }, { status });
  const spell = [
    () => busy("busy", 503),
    () => busy("rate_limited", 429),
    () =>
      stream([
        {
          type: "error",
          error: {
            code: "host_unavailable",
            status: 503,
            message: "m",
            processId: "p1",
            cursor: 2,
          },
        },
      ]),
    () => stream([], "fail"),
    () => busy("host_unavailable", 503),
  ];
  const { runtime, calls } = server(
    (method, url) => {
      if (method === "POST" && url.pathname.endsWith(":exec"))
        return stream([
          { type: "start", processId: "p1" },
          { type: "stdout", data: "a\n", offset: 0 },
          { type: "continue", processId: "p1", cursor: 2 },
        ]);
      if (url.pathname.endsWith("/processes/p1/output"))
        return (
          spell.shift()?.() ??
          stream([
            { type: "stdout", data: "b\n", offset: 2 },
            { type: "exit", exitCode: 0, state: "exited", timedOut: false },
          ])
        );
      return undefined;
    },
    { maxRetries: 0 },
  );
  const result = await (await runtime.sandboxes.get(ID)).exec("x", { onStdout: () => {} });
  expect(result).toMatchObject({ exitCode: 0, stdout: "a\nb\n", stdoutTruncated: false });
  expect(calls.filter((c) => c.includes("/output")).length).toBe(6);
});

test("a deliberate refusal or a missing process still ends the follow at once", async () => {
  for (const [code, status] of [
    ["unavailable", 503],
    ["process_not_found", 404],
  ] as const) {
    const { runtime, calls } = server(
      (method, url) => {
        if (method === "POST" && url.pathname.endsWith(":exec"))
          return stream([{ type: "start", processId: "p1" }], "fail");
        if (url.pathname.endsWith("/processes/p1/output"))
          return Response.json({ error: { code, status, message: "m" } }, { status });
        return undefined;
      },
      { maxRetries: 0 },
    );
    const error = await (
      await runtime.sandboxes.get(ID)
    )
      .exec("x", { onStdout: () => {} })
      .catch((e: unknown) => e);
    expect((error as RuntimeError).code).toBe(code);
    expect(calls.filter((c) => c.includes("/output")).length).toBe(1);
  }
});

test("cancelling a streamed exec stops the command in the sandbox and says so", async () => {
  const cancel = new AbortController();
  const { runtime, calls } = server((method, url, init) => {
    if (method === "POST" && url.pathname.endsWith(":exec"))
      return stream(
        [
          { type: "start", processId: "p1" },
          { type: "stdout", data: "working\n", offset: 0 },
        ],
        "hang",
        init.signal ?? undefined,
      );
    if (url.pathname.endsWith("/processes/p1:signal")) return Response.json({ ok: true });
    return undefined;
  });
  const error = await (
    await runtime.sandboxes.get(ID)
  )
    .exec("sleep 600", { signal: cancel.signal, onStdout: () => cancel.abort() })
    .catch((e: unknown) => e);
  expect((error as RuntimeError).code).toBe("cancelled");
  expect((error as RuntimeError).message).toBe("Cancelled; process p1 was sent SIGTERM.");
  expect((error as RuntimeError).details).toMatchObject({ processId: "p1", stopped: true });
  expect(calls).toContain(`POST /v1/sandboxes/${ID}/processes/p1:signal`);
});

test("the CLI exits non-zero and says so when a streamed exec lost output", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    return init?.method === "POST" && url.pathname.endsWith(":exec")
      ? stream([
          { type: "start", processId: "p1" },
          { type: "stdout", data: "a\n", offset: 0 },
          { type: "stdout", data: "b\n", offset: 10 },
          { type: "exit", exitCode: 0, state: "exited", timedOut: false },
        ])
      : Response.json(info);
  }) as typeof fetch;
  const errors: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    const code = await run(
      ["sandbox", "exec", ID, "--", "x"],
      { RUNTIME_API_KEY: "rk", RUNTIME_API_URL: "https://api.example.test" },
      { json: false, write: () => {}, error: (t) => errors.push(t) },
    );
    expect(code).toBe(1);
  } finally {
    process.stdout.write = write;
    globalThis.fetch = original;
  }
  expect(errors.join("\n")).toContain("some of the command's output was lost");
});
