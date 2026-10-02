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
              code: "trial_busy",
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
          : Response.json({ error: { code: "trial_busy", message: "full" } }, { status: 409 });
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
