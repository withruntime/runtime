import { expect, test } from "bun:test";
import { queues } from "../src/products/queues";
import { RuntimeError } from "../src/errors";
import { Transport, type Call } from "../src/transport";
const options = { idempotencyKey: "restart-key", timeoutMs: 500 };
function fixture(
  answer: (call: Call, count: number) => unknown = () => ({ id: "q1", state: "ready" }),
) {
  const seen: Call[] = [];
  const transport = {
    async json(call: Call) {
      seen.push(call);
      return answer(call, seen.length);
    },
  } as unknown as Transport;
  return { api: queues(transport), seen };
}
test("all queue requests preserve method, escaped path, body and key", async () => {
  const { api, seen } = fixture();
  const id = "tenant/q?#";
  const base = `/v1/queues/${encodeURIComponent(id)}`;
  const create = {
    name: "work.fifo",
    labels: { team: "a" },
    settings: { fifo: true, deadLetter: { queue: "dead.fifo", maxReceives: 3 } },
  };
  const send = {
    body: "hi",
    attributes: { x: { dataType: "String", stringValue: "v" } },
    delaySeconds: 0,
    groupId: "g",
    dedupId: "d",
  };
  const cases: [() => Promise<unknown>, string, string, unknown][] = [
    [() => api.create(create, options), "POST", "/v1/queues", create],
    [() => api.get(id, options), "GET", base, undefined],
    [() => api.update(id, { labels: {} }, options), "POST", `${base}:update`, { labels: {} }],
    [() => api.delete(id, options), "DELETE", base, undefined],
    [() => api.send(id, send, options), "POST", `${base}:send`, send],
    [
      () => api.receive(id, { max: 10, waitSeconds: 20, visibilitySeconds: 0 }, options),
      "POST",
      `${base}:receive`,
      { max: 10, waitSeconds: 20, visibilitySeconds: 0 },
    ],
    [
      () => api.ack(id, { receiptHandles: ["r1"] }, options),
      "POST",
      `${base}:ack`,
      { receiptHandles: ["r1"] },
    ],
    [
      () => api.retry(id, { receiptHandle: "r1", visibilitySeconds: 0 }, options),
      "POST",
      `${base}:retry`,
      { receiptHandle: "r1", visibilitySeconds: 0 },
    ],
    [() => api.purge(id, options), "POST", `${base}:purge`, {}],
  ];
  for (const [run, method, path, body] of cases) {
    await run();
    expect(seen.at(-1) as unknown).toEqual({
      ...options,
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
  }
});
test("pagination retains filters, cursor and request controls", async () => {
  const { api, seen } = fixture((_, n) => ({
    data: [{ id: `q${n}` }],
    nextCursor: n === 1 ? "next" : null,
  }));
  const query = { label: ["team:a"], limit: 1, state: ["ready" as const] };
  expect((await (await api.list(query, options)).toArray()).map((q) => q.id)).toEqual(["q1", "q2"]);
  expect(seen).toEqual(
    [1, 2].map((n) => ({
      ...options,
      method: "GET",
      path: "/v1/queues",
      query: { ...query, ...(n === 2 ? { cursor: "next" } : {}) },
    })),
  );
});
for (const code of [
  "InvalidParameterValue",
  "InvalidAttributeValue",
  "MissingParameter",
  "UnsupportedOperation",
  "QueueDoesNotExist",
  "AWS.SimpleQueueService.NonExistentQueue",
  "ReceiptHandleIsInvalid",
  "MessageNotInflight",
  "PurgeQueueInProgress",
  "BatchEntryIdsNotDistinct",
  "TooManyEntriesInBatchRequest",
  "InvalidSecurity",
  "SignatureDoesNotMatch",
  "AccessDenied",
  "RequestThrottled",
  "InternalError",
  "not_found",
  "forbidden",
  "insufficient_credit",
  "idempotency_conflict",
]) {
  test(`queue preserves ${code}, hint and retry key`, async () => {
    const error = new RuntimeError({
      code,
      status: 400,
      message: "Refused",
      hint: "Fix the input.",
      idempotencyKey: options.idempotencyKey,
    });
    await expect(
      fixture(() => {
        throw error;
      }).api.send("q1", { body: "hi" }, options),
    ).rejects.toBe(error);
  });
}
test("partial acknowledgements retain failed handles and recovery hints", async () => {
  const result = {
    successful: ["r1"],
    failed: [
      {
        receiptHandle: "old",
        code: "ReceiptHandleIsInvalid",
        message: "Stale",
        hint: "Receive again.",
      },
    ],
  };
  expect(await fixture(() => result).api.ack("q1", { receiptHandles: ["r1", "old"] })).toEqual(
    result,
  );
});
test("wait follows pending states; failed and deleted cannot pass as ready", async () => {
  const { api, seen } = fixture((_, n) => ({ id: "q1", state: n < 3 ? "updating" : "ready" }));
  expect((await api.wait("q1", "ready", { ...options, pollMs: 0 })).state).toBe("ready");
  expect(seen).toHaveLength(3);
  expect(seen.every((c) => c.idempotencyKey === undefined)).toBe(true);
  for (const state of ["failed", "deleted"])
    await expect(fixture(() => ({ state })).api.wait("q1")).rejects.toMatchObject({
      code: "unexpected_state",
      hint: expect.any(String),
    });
  await expect(
    fixture(() => ({
      state: "failed",
      error: { code: "quota_exceeded", message: "Full", hint: "Reduce retention." },
    })).api.wait("q1"),
  ).rejects.toMatchObject({ code: "quota_exceeded", hint: "Reduce retention." });
  expect((await fixture(() => ({ state: "deleted" })).api.wait("q1", "deleted")).state).toBe(
    "deleted",
  );
});
test("wait bounds sleeping and in-flight reads; aborts and bad timing fail explicitly", async () => {
  const pending = fixture(() => ({ state: "creating" }));
  await expect(
    pending.api.wait("q1", "ready", { pollMs: 1000, timeoutMs: 10 }),
  ).rejects.toMatchObject({ code: "timeout" });
  const blocked = fixture(
    (call) =>
      new Promise((_, reject) =>
        call.signal!.addEventListener("abort", () => reject(Error("cancelled")), { once: true }),
      ),
  );
  await expect(blocked.api.wait("q1", "ready", { timeoutMs: 10 })).rejects.toMatchObject({
    code: "timeout",
  });
  await expect(
    pending.api.wait("q1", "ready", { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: "timeout" });
  for (const bad of [-1, NaN, Infinity, 0.5]) {
    await expect(pending.api.wait("q1", "ready", { pollMs: bad })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(pending.api.wait("q1", "ready", { timeoutMs: bad })).rejects.toMatchObject({
      code: "invalid_request",
    });
  }
});
test("lost send reply can be retried after restarting the client without another effect", async () => {
  const remembered = new Map<string, unknown>();
  const keys: string[] = [];
  let lose = true;
  const make = () =>
    queues(
      new Transport({
        apiKey: "test",
        baseUrl: "http://127.0.0.1",
        maxRetries: 0,
        fetch: (async (_url, init) => {
          const key = new Headers(init?.headers).get("idempotency-key")!;
          keys.push(key);
          if (!remembered.has(key)) remembered.set(key, { id: "m1", md5: "digest" });
          if (lose) {
            lose = false;
            throw new TypeError("fetch failed");
          }
          return Response.json(remembered.get(key));
        }) as typeof fetch,
      }),
    );
  await expect(make().send("q1", { body: "hi" }, options)).rejects.toBeInstanceOf(RuntimeError);
  expect(await make().send("q1", { body: "hi" }, options)).toEqual({ id: "m1", md5: "digest" });
  expect(keys).toEqual([options.idempotencyKey, options.idempotencyKey]);
  expect(remembered.size).toBe(1);
});

const message = { id: "m1", body: "hello", receiptHandle: "receipt", receives: 1 };
function consumerFixture(onCall?: (call: Call) => unknown) {
  return fixture((call) =>
    onCall
      ? onCall(call)
      : call.path.endsWith(":receive")
        ? { messages: [message] }
        : call.path.endsWith(":ack")
          ? { successful: [message.receiptHandle], failed: [] }
          : { receiptHandle: message.receiptHandle, visibilitySeconds: 0 },
  );
}

test("consume acknowledges only after the handler resolves and respects max", async () => {
  const f = consumerFixture();
  let complete!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handled = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const consuming = f.api.consume(
    "q1",
    async (received) => {
      expect(received).toEqual(message);
      started();
      await handled;
    },
    { max: 1, waitSeconds: 7, visibilitySeconds: 60 },
  );
  await running;
  expect(f.seen.map((c) => c.path)).toEqual(["/v1/queues/q1:receive"]);
  expect(f.seen[0]!.body).toEqual({ max: 1, waitSeconds: 7, visibilitySeconds: 60 });
  complete();
  expect(await consuming).toEqual({ processed: 1, acknowledged: 1, retried: 0, aborted: false });
  expect(f.seen[1]).toMatchObject({
    method: "POST",
    path: "/v1/queues/q1:ack",
    body: { receiptHandles: ["receipt"] },
  });
  expect(f.seen[1]!.idempotencyKey).not.toBe(f.seen[0]!.idempotencyKey);
});

test("consume releases thrown and rejected handlers immediately and counts failed attempts toward max", async () => {
  const f = consumerFixture();
  let attempts = 0;
  expect(
    await f.api.consume(
      "q1",
      () => {
        if (++attempts === 1) throw Error("sync failure");
        return Promise.reject(Error("async failure"));
      },
      { max: 2 },
    ),
  ).toEqual({ processed: 2, acknowledged: 0, retried: 2, aborted: false });
  expect(f.seen.map((c) => c.path.split(":").at(-1))).toEqual([
    "receive",
    "retry",
    "receive",
    "retry",
  ]);
  for (const call of f.seen.filter((c) => c.path.endsWith(":retry"))) {
    expect(call.body).toEqual({ receiptHandle: "receipt", visibilitySeconds: 0 });
    expect(call.signal).toBeUndefined();
  }
});

test("abort releases the in-flight handler and never acknowledges its late success", async () => {
  const f = consumerFixture();
  const controller = new AbortController();
  let complete!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const consuming = f.api.consume(
    "q1",
    (_message, signal) => {
      expect(signal).toBe(controller.signal);
      started();
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    { signal: controller.signal },
  );
  await running;
  controller.abort();
  expect(await consuming).toEqual({ processed: 1, acknowledged: 0, retried: 1, aborted: true });
  complete();
  await Promise.resolve();
  expect(f.seen.map((c) => c.path.split(":").at(-1))).toEqual(["receive", "retry"]);
  expect(f.seen[1]!.body).toEqual({ receiptHandle: "receipt", visibilitySeconds: 0 });
  expect(f.seen[1]!.signal).toBeUndefined();
});

test("abort after a receive reply releases the receipt without running its handler", async () => {
  const controller = new AbortController();
  const f = consumerFixture((call) => {
    if (call.path.endsWith(":receive")) {
      controller.abort();
      return { messages: [message] };
    }
    return {};
  });
  let handled = 0;
  expect(
    await f.api.consume(
      "q1",
      () => {
        handled++;
      },
      { signal: controller.signal },
    ),
  ).toEqual({ processed: 0, acknowledged: 0, retried: 1, aborted: true });
  expect(handled).toBe(0);
  expect(f.seen[1]!.path).toBe("/v1/queues/q1:retry");
});

test("cancellation during acknowledgement finishes settlement without receiving again", async () => {
  const controller = new AbortController();
  const f = consumerFixture((call) => {
    if (call.path.endsWith(":receive")) return { messages: [message] };
    controller.abort();
    expect(call.signal).toBeUndefined();
    return { successful: ["receipt"], failed: [] };
  });
  expect(await f.api.consume("q1", () => {}, { signal: controller.signal })).toEqual({
    processed: 1,
    acknowledged: 1,
    retried: 0,
    aborted: true,
  });
  expect(f.seen).toHaveLength(2);
});

test("zero max and an already aborted signal do nothing; malformed bounds are refused", async () => {
  const f = consumerFixture();
  expect((await f.api.consume("q1", () => {}, { max: 0 })).processed).toBe(0);
  expect((await f.api.consume("q1", () => {}, { signal: AbortSignal.abort() })).aborted).toBe(true);
  for (const option of [
    { max: -1 },
    { max: 1.5 },
    { max: Infinity },
    { waitSeconds: 21 },
    { visibilitySeconds: -1 },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
  ])
    await expect(f.api.consume("q1", () => {}, option)).rejects.toMatchObject({
      code: "invalid_request",
      hint: expect.any(String),
    });
  expect(f.seen).toHaveLength(0);
});

test("empty polling and a cancelled receive stop without acknowledging anything", async () => {
  const controller = new AbortController();
  const empty = consumerFixture(() => ({ messages: [] }));
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    expect(
      (await empty.api.consume("q1", () => {}, { signal: controller.signal, waitSeconds: 0 }))
        .aborted,
    ).toBe(true);
    expect(empty.seen).toHaveLength(1);
  } finally {
    clearTimeout(timer);
  }
  const cancelled = new AbortController();
  const f = consumerFixture(() => {
    cancelled.abort();
    throw new RuntimeError({ code: "timeout", message: "Reply lost", status: 0 });
  });
  expect((await f.api.consume("q1", () => {}, { signal: cancelled.signal })).aborted).toBe(true);
  expect(f.seen).toHaveLength(1);
});

test("lost ack reply is retried with the same key and body without rerunning the handler", async () => {
  const acks: { key: string; body: string }[] = [];
  const remembered = new Set<string>();
  let handlerCalls = 0;
  const api = queues(
    new Transport({
      apiKey: "test",
      baseUrl: "http://127.0.0.1",
      maxRetries: 0,
      fetch: (async (url, init) => {
        const request = new Request(url, init);
        if (request.url.endsWith(":receive")) return Response.json({ messages: [message] });
        const key = new Headers(init?.headers).get("idempotency-key")!;
        acks.push({ key, body: await request.text() });
        remembered.add(key);
        if (acks.length === 1) throw new TypeError("fetch failed after acknowledgement");
        return Response.json({ successful: ["receipt"], failed: [] });
      }) as typeof fetch,
    }),
  );
  expect(
    await api.consume(
      "q1",
      () => {
        handlerCalls++;
      },
      { max: 1 },
    ),
  ).toEqual({ processed: 1, acknowledged: 1, retried: 0, aborted: false });
  expect(handlerCalls).toBe(1);
  expect(acks).toHaveLength(2);
  expect(acks[0]).toEqual(acks[1]);
  expect(acks[0]!.key).toBeTruthy();
  expect(remembered.size).toBe(1);
});

test("ack refusals, missing results and release failures are observable, never counted as success", async () => {
  for (const ack of [
    {
      successful: [],
      failed: [
        {
          receiptHandle: "receipt",
          code: "ReceiptHandleIsInvalid",
          message: "Expired",
          hint: "Receive again.",
        },
      ],
    },
    { successful: [], failed: [] },
  ]) {
    const f = consumerFixture((call) =>
      call.path.endsWith(":receive") ? { messages: [message] } : ack,
    );
    await expect(f.api.consume("q1", () => {}, { max: 1 })).rejects.toMatchObject({
      code: ack.failed.length ? "ReceiptHandleIsInvalid" : "invalid_response",
      hint: expect.any(String),
    });
    expect(f.seen).toHaveLength(2);
  }
  const error = new RuntimeError({
    code: "forbidden",
    status: 403,
    message: "Refused",
    hint: "Use the queue owner's key.",
  });
  const f = consumerFixture((call) => {
    if (call.path.endsWith(":receive")) return { messages: [message] };
    throw error;
  });
  await expect(
    f.api.consume(
      "q1",
      () => {
        throw Error("failed");
      },
      { max: 1 },
    ),
  ).rejects.toBe(error);
});

test("lost release replies use the same key; repeated loss fails instead of looping", async () => {
  let releases = 0;
  const f = consumerFixture((call) => {
    if (call.path.endsWith(":receive")) return { messages: [message] };
    if (++releases === 1)
      throw new RuntimeError({
        code: "connection_error",
        status: 0,
        message: "Lost reply",
        hint: "Retry the same key.",
      });
    return {};
  });
  expect(
    (
      await f.api.consume(
        "q1",
        () => {
          throw Error("handler failed");
        },
        { max: 1 },
      )
    ).retried,
  ).toBe(1);
  expect(f.seen[1]).toEqual(f.seen[2]);
  const failed = consumerFixture((call) => {
    if (call.path.endsWith(":receive")) return { messages: [message] };
    throw new RuntimeError({
      code: "connection_error",
      status: 0,
      message: "Still offline",
      hint: "Allow redelivery after visibility expires.",
    });
  });
  await expect(failed.api.consume("q1", () => {}, { max: 1 })).rejects.toMatchObject({
    code: "connection_error",
    hint: "Allow redelivery after visibility expires.",
  });
  expect(failed.seen).toHaveLength(3);
  expect(failed.seen[1]).toEqual(failed.seen[2]);
});

test("unexpected overdelivery is refused, never acknowledged or silently consumed", async () => {
  const f = consumerFixture(() => ({
    messages: [message, { ...message, receiptHandle: "other" }],
  }));
  let calls = 0;
  await expect(
    f.api.consume(
      "q1",
      () => {
        calls++;
      },
      { max: 1 },
    ),
  ).rejects.toMatchObject({ code: "invalid_response", hint: expect.any(String) });
  expect(calls).toBe(0);
  expect(f.seen).toHaveLength(1);
});
