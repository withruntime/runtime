import { expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { Runtime } from "../src/client";
import { ConnectionError } from "../src/errors";
import { Transport } from "../src/transport";

const transport = (
  fetcher: typeof fetch,
  options: { maxConnections?: number; maxRetries?: number } = {},
) => new Transport({ apiKey: "rk_test", fetch: fetcher, ...options });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const read of ["json", "bytes", "fileBytes"] as const) {
  for (const reason of ["abort", "deadline"] as const) {
    test(`${read}: a ${reason} releases a queued call without sending it`, async () => {
      const entered = deferred();
      const held = deferred();
      let calls = 0;
      const t = transport(
        (async () => {
          calls++;
          if (calls === 1) {
            entered.resolve();
            await held.promise;
          }
          return Response.json({ ok: true });
        }) as unknown as typeof fetch,
        { maxConnections: 1 },
      );
      const first = t[read]({ method: "GET", path: "/v1/me" });
      await entered.promise;
      const controller = new AbortController();
      const queued = t[read]({
        method: "POST",
        path: "/v1/feedback",
        idempotencyKey: "queued-key",
        ...(reason === "abort" ? { signal: controller.signal } : { timeoutMs: 5 }),
      }).catch((error: unknown) => error);
      if (reason === "abort") controller.abort();
      try {
        const result = await Promise.race([queued, Bun.sleep(100).then(() => "still queued")]);
        expect(result).toBeInstanceOf(ConnectionError);
        expect(result).toMatchObject({ code: "timeout", idempotencyKey: "queued-key" });
        expect(calls).toBe(1);
      } finally {
        held.resolve();
        await first;
        await queued;
      }
      await t[read]({ method: "GET", path: "/v1/me" });
      expect(calls).toBe(2);
    });
  }
}

test("abort during retry backoff retains the SDK error and the write key", async () => {
  const controller = new AbortController();
  let calls = 0;
  const t = transport((async () => {
    calls++;
    setTimeout(() => controller.abort(), 5);
    throw new TypeError("connection reset");
  }) as unknown as typeof fetch);
  const error = await t
    .json({ method: "POST", path: "/v1/feedback", signal: controller.signal })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error).toMatchObject({ code: "timeout" });
  expect((error as ConnectionError).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls).toBe(1);
});

test("a cut response body is retried with the original write key and body", async () => {
  const seen: Array<{ key: string | null; body: unknown }> = [];
  const t = transport(
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ key: new Headers(init?.headers).get("idempotency-key"), body: init?.body });
      if (seen.length === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("socket closed while reading"));
            },
          }),
        );
      return Response.json({ ok: true });
    }) as unknown as typeof fetch,
    { maxRetries: 1 },
  );
  expect(
    await t.json<{ ok: boolean }>({
      method: "POST",
      path: "/v1/feedback",
      body: { summary: "hello" },
    }),
  ).toEqual({ ok: true });
  expect(seen).toHaveLength(2);
  expect(seen[0]).toEqual(seen[1]);
  expect(seen[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("a cut response for a call that cannot be replayed is a typed error, sent once", async () => {
  let calls = 0;
  const t = transport((async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("socket closed while reading"));
        },
      }),
    );
  }) as unknown as typeof fetch);
  await expect(
    t.json({ method: "POST", path: "/v1/support/messages", retry: false }),
  ).rejects.toMatchObject({ code: "connection_error" });
  expect(calls).toBe(1);
});

test("a cleanly truncated JSON answer retries under the original write key", async () => {
  const keys: Array<string | null> = [];
  const t = transport(
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      return keys.length === 1 ? new Response('{"ok":') : Response.json({ ok: true });
    }) as unknown as typeof fetch,
    { maxRetries: 1 },
  );
  expect<unknown>(await t.json({ method: "POST", path: "/v1/feedback" })).toEqual({ ok: true });
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);
});

test("unusable JSON answers retain the typed failure and write key", async () => {
  for (const retry of [true, false]) {
    let calls = 0;
    const t = transport(
      (async () => {
        calls++;
        return new Response('{"ok":');
      }) as unknown as typeof fetch,
      { maxRetries: 0 },
    );
    const error = await t
      .json({ method: "POST", path: "/v1/feedback", retry })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ code: "connection_error" });
    expect((error as ConnectionError).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toBe(1);
  }
});

test("client timeoutMs: 0 keeps the documented disabled deadline", async () => {
  const timeout = spyOn(AbortSignal, "timeout");
  try {
    const runtime = new Runtime({
      apiKey: "rk_test",
      timeoutMs: 0,
      fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    });
    await runtime.me();
    expect(timeout).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

test("capacity waits do not spend the transport retry allowance", async () => {
  let calls = 0;
  const t = transport(
    (async () => {
      calls++;
      if (calls <= 3)
        return Response.json(
          {
            error: {
              code: "no_credit_running_limit",
              message: "full",
              retryAfterMs: 1,
            },
          },
          { status: 409 },
        );
      if (calls === 4) throw new TypeError("connection reset");
      return Response.json({ ok: true });
    }) as unknown as typeof fetch,
    { maxRetries: 1 },
  );
  expect(
    await t.json<{ ok: boolean }>({
      method: "POST",
      path: "/v1/sandboxes",
      waitForCapacityMs: 2000,
    }),
  ).toEqual({
    ok: true,
  });
  expect(calls).toBe(5);
});

test("errors from caller callbacks propagate without resending a call", async () => {
  for (const callback of ["onResponse", "onCapacityWait"] as const) {
    let calls = 0;
    const failure = new Error("caller failed");
    const t = transport(
      (async () => {
        calls++;
        return callback === "onResponse"
          ? Response.json({ ok: true })
          : Response.json(
              { error: { code: "no_credit_running_limit", message: "full" } },
              { status: 409 },
            );
      }) as unknown as typeof fetch,
      { maxRetries: 1 },
    );
    const error = await t
      .json({
        method: "POST",
        path: "/v1/sandboxes",
        waitForCapacityMs: 2000,
        [callback]: () => {
          throw failure;
        },
      })
      .catch((error: unknown) => error);
    expect(error).toBe(failure);
    expect(calls).toBe(1);
  }
});

test("a failed response callback cancels the unread body and keeps its error", async () => {
  let cancelled = false;
  const failure = new Error("caller failed");
  const t = transport(
    (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      )) as unknown as typeof fetch,
  );
  const error = await t
    .json({
      method: "GET",
      path: "/v1/me",
      onResponse: () => {
        throw failure;
      },
    })
    .catch((error: unknown) => error);
  expect(error).toBe(failure);
  expect(cancelled).toBe(true);
});

test("a real HTTP response cut after headers replays a write exactly once", async () => {
  let calls = 0;
  let writes = 0;
  const keys = new Set<string>();
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls++;
      const key = String(request.headers["idempotency-key"]);
      if (!keys.has(key)) {
        keys.add(key);
        writes++;
      }
      response.writeHead(200, { "content-type": "application/json", "content-length": "11" });
      if (calls === 1) {
        response.write('{"ok":');
        setTimeout(() => response.destroy(), 5);
      } else response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local server port");
    const t = new Transport({
      apiKey: "rk_test",
      baseUrl: `http://127.0.0.1:${address.port}`,
      fetch,
      maxRetries: 1,
    });
    expect(
      await t.json<{ ok: boolean }>({
        method: "POST",
        path: "/v1/feedback",
        body: { summary: "hello" },
      }),
    ).toEqual({ ok: true });
    expect({ calls, writes, keys: keys.size }).toEqual({ calls: 2, writes: 1, keys: 1 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const read of ["send", "json"] as const) {
  test(`${read}: a deadline ends an unresolved credential lookup`, async () => {
    let calls = 0;
    const t = new Transport({
      apiKey: () => new Promise(() => {}),
      timeoutMs: 5,
      fetch: (async () => {
        calls++;
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
    });
    const pending = t[read]({
      method: "POST",
      path: "/v1/feedback",
      idempotencyKey: "key-wait",
    }).catch((error: unknown) => error);
    const result = await Promise.race([pending, Bun.sleep(100).then(() => "still finding key")]);
    expect(result).toBeInstanceOf(ConnectionError);
    expect(result).toMatchObject({ code: "timeout", idempotencyKey: "key-wait" });
    expect(calls).toBe(0);
  });
}

/* A thousand creates from one client meet a full region, or a 429: each waits
   before trying again. Waiting holds no connection, so it must not hold one of
   the client's connection slots either: with every slot asleep, the stop that
   would free room, or any read, sat behind them for up to two minutes. */
for (const refusal of [
  { code: "no_capacity", status: 503, room: true },
  { code: "rate_limited", status: 429, room: false },
] as const) {
  test(`a call waiting out ${refusal.code} lends its connection slot to the next call`, async () => {
    const order: string[] = [];
    let refused = false;
    const t = transport(
      (async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        order.push(`${init.method} ${path}`);
        if (path === "/v1/sandboxes" && !refused) {
          refused = true;
          return Response.json(
            {
              error: {
                code: refusal.code,
                status: refusal.status,
                message: "m",
                retryAfterMs: 300,
              },
            },
            { status: refusal.status },
          );
        }
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
      { maxConnections: 1 },
    );
    const create = t.json({
      method: "POST",
      path: "/v1/sandboxes",
      body: {},
      ...(refusal.room ? { waitForCapacityMs: 5000 } : {}),
    });
    while (!refused) await Bun.sleep(1);
    const started = performance.now();
    await t.json({ method: "GET", path: "/v1/me" });
    expect(performance.now() - started).toBeLessThan(200);
    await create;
    expect(order).toEqual(["POST /v1/sandboxes", "GET /v1/me", "POST /v1/sandboxes"]);
  });
}

/* One address may hold 64 connections to the API; past that its edge resets
   them. A thousand agents' commands from one orchestrator each held a stream
   with no limit, and got resets. Streams and calls now share the client's
   cap: the rest wait their turn, and a few connections are always kept for
   calls, so a stream's reader that makes a call is never stuck behind
   streams. */
test("streams and calls together hold at most maxConnections, and calls keep their own", async () => {
  let open = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  const t = transport(
    (async (url: string) => {
      open++;
      peak = Math.max(peak, open);
      if (new URL(url).pathname === "/v1/me") {
        open--;
        return Response.json({ ok: true });
      }
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"type":"start"}\n'));
            gates.push(() => {
              open--;
              controller.close();
            });
          },
        }),
      );
    }) as unknown as typeof fetch,
    { maxConnections: 12 },
  );
  // Twenty streams that stay open until told: four of the twelve stay free.
  const readers = Array.from({ length: 20 }, async () => {
    const seen: unknown[] = [];
    for await (const event of t.events({ method: "GET", path: "/v1/stream" })) seen.push(event);
    return seen;
  });
  while (gates.length < 4) await Bun.sleep(1);
  await Bun.sleep(20);
  expect(gates.length).toBe(4);
  // A call is answered at once beside them, however many streams wait.
  await Promise.all(Array.from({ length: 6 }, () => t.json({ method: "GET", path: "/v1/me" })));
  expect(peak).toBeLessThanOrEqual(12);
  // Each stream that ends lets the next one in, until all twenty are read.
  let closed = 0;
  while (closed < 20) {
    while (gates.length === 0) await Bun.sleep(1);
    gates.shift()!();
    closed++;
  }
  for (const seen of await Promise.all(readers)) expect(seen).toEqual([{ type: "start" }]);
  expect(peak).toBeLessThanOrEqual(12);
});

test("a download stream gives its connection back when read, cancelled or past its deadline", async () => {
  let calls = 0;
  const t = transport(
    (async (_url: string, init: RequestInit) => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            init.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
        }),
        { headers: { "x-content-length": "3" } },
      );
    }) as unknown as typeof fetch,
    { maxConnections: 9 },
  );
  // One stream slot (nine less the eight kept for calls): each download must
  // give it back for the next to start.
  const cancelled = await t.fileStream({ method: "GET", path: "/v1/a" });
  await cancelled.cancel();
  const late = await t.fileStream({ method: "GET", path: "/v1/b", timeoutMs: 30 });
  const lateReader = late.getReader();
  await lateReader.read();
  await Bun.sleep(60);
  const third = await Promise.race([
    t.fileStream({ method: "GET", path: "/v1/c" }),
    Bun.sleep(500).then(() => "still queued"),
  ]);
  expect(third).not.toBe("still queued");
  expect(calls).toBe(3);
});

/* A server under disk pressure answers `guest_busy` ("nothing ran") several
   times in a row. Each such answer guarantees the call did nothing, so it is
   sent again, with the same key, until the caller's deadline: the worst a
   customer sees is slowness. A call that may have run is never replayed. */
test("guest_busy is retried past maxRetries until it clears, with the same key", async () => {
  const keys: (string | null)[] = [];
  let refusals = 9;
  const t = transport(
    (async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      if (refusals-- > 0)
        return Response.json(
          { error: { code: "guest_busy", status: 503, message: "Nothing ran.", retryAfterMs: 1 } },
          { status: 503 },
        );
      return Response.json({ ok: true });
    }) as unknown as typeof fetch,
    { maxRetries: 2 },
  );
  await expect(t.json({ method: "POST", path: "/v1/sandboxes/s:exec", body: {} })).resolves.toEqual(
    {
      ok: true,
    },
  );
  expect(keys).toHaveLength(10);
  expect(new Set(keys).size).toBe(1);
});

test("a call that cannot be replayed is still sent again after an answer that ran nothing", async () => {
  let calls = 0;
  const t = transport((async () => {
    calls++;
    if (calls <= 3)
      return Response.json(
        { error: { code: "guest_busy", status: 503, message: "Nothing ran.", retryAfterMs: 1 } },
        { status: 503 },
      );
    return Response.json({ ok: true });
  }) as unknown as typeof fetch);
  await t.json({ method: "POST", path: "/v1/x", body: {}, retry: false });
  expect(calls).toBe(4);
  // A passing failure that may have run is not replayed for such a call.
  let others = 0;
  const strict = transport((async () => {
    others++;
    return Response.json(
      { error: { code: "host_unavailable", status: 503, message: "m", retryAfterMs: 1 } },
      { status: 503 },
    );
  }) as unknown as typeof fetch);
  await expect(
    strict.json({ method: "POST", path: "/v1/x", body: {}, retry: false }),
  ).rejects.toMatchObject({ code: "host_unavailable" });
  expect(others).toBe(1);
});

test("guest_busy that never clears ends at the caller's deadline with its own error", async () => {
  let calls = 0;
  const t = transport((async () => {
    calls++;
    return Response.json(
      { error: { code: "guest_busy", status: 503, message: "Nothing ran.", retryAfterMs: 5 } },
      { status: 503 },
    );
  }) as unknown as typeof fetch);
  const started = performance.now();
  const error = await t
    .json({ method: "GET", path: "/v1/x", timeoutMs: 200 })
    .catch((error: unknown) => error);
  expect(performance.now() - started).toBeLessThan(400);
  expect(error).toMatchObject({ code: "guest_busy", status: 503 });
  expect(calls).toBeGreaterThan(5);
});

/* The leader drill on vin-5, 4 October 2026: a call in flight when the
   controller died waited, its connection silent, until its deadline, and
   failed. An attempt whose answer has not started by ANSWER_START_MS is sent
   again under the same key. */
test("an attempt whose answer never starts is sent again under the same key", async () => {
  const keys: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    keys.push(request.headers["idempotency-key"] as string | undefined);
    if (keys.length === 1) return; // a server that is gone: the connection stays, silent
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const t = new Transport({
      apiKey: "rk_test",
      baseUrl: `http://localhost:${port}`,
      answerStartMs: 200,
      timeoutMs: 5_000,
    });
    const started = performance.now();
    const answer = await t.json<{ ok: boolean }>({
      method: "POST",
      path: "/v1/feedback",
      idempotencyKey: "same-key",
      body: {},
    });
    expect(answer).toEqual({ ok: true });
    expect(keys).toEqual(["same-key", "same-key"]);
    expect(performance.now() - started).toBeLessThan(2_000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
