import { expect, test } from "bun:test";
import { streams } from "../src/products/streams";
import { RuntimeError } from "../src/errors";
import type { Call, Transport } from "../src/transport";
const options = { idempotencyKey: "restart-key", timeoutMs: 500 };
function fixture(
  answer: (call: Call, count: number) => unknown = () => ({ id: "s1", state: "ready" }),
) {
  const seen: Call[] = [];
  const transport = {
    async json(call: Call) {
      seen.push(call);
      return answer(call, seen.length);
    },
  } as unknown as Transport;
  return { api: streams(transport), seen };
}
test("stream requests preserve exact offsets, ordered headers, paths, bodies and keys", async () => {
  const { api, seen } = fixture();
  const id = "tenant/s?#";
  const base = `/v1/streams/${encodeURIComponent(id)}`;
  const create = {
    name: "events",
    labels: { team: "a" },
    partitions: 2,
    retentionMs: 10,
    retentionBytes: "9007199254740993",
  };
  const publish = {
    records: [
      {
        key: "a",
        value: null,
        headers: [
          { key: "x", value: "one" },
          { key: "x", value: "two" },
        ],
      },
    ],
  };
  const trim = { partition: 1, before: "9007199254740993" };
  const cases: [() => Promise<unknown>, string, string, unknown][] = [
    [() => api.create(create, options), "POST", "/v1/streams", create],
    [() => api.get(id, options), "GET", base, undefined],
    [
      () => api.update(id, { retentionMs: 20 }, options),
      "POST",
      `${base}:update`,
      { retentionMs: 20 },
    ],
    [() => api.delete(id, options), "DELETE", base, undefined],
    [() => api.publish(id, publish, options), "POST", `${base}:publish`, publish],
    [() => api.trim(id, trim, options), "POST", `${base}:trim`, trim],
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
  for (const position of [{ offset: "9007199254740993" }, { time: 0 }]) {
    const query = { partition: 0, ...position, maxBytes: 1024, waitMs: 0 };
    await api.read(id, query, options);
    expect(seen.at(-1)).toEqual({ ...options, method: "GET", path: `${base}:read`, query });
  }
});
test("stream pages preserve filters and keys; wait uses the shared lifecycle", async () => {
  const { api, seen } = fixture((_, n) => ({
    data: [{ id: "s1" }],
    nextCursor: n === 1 ? "next" : null,
  }));
  expect(await (await api.list({ name: "events", limit: 1 }, options)).toArray()).toHaveLength(2);
  expect(seen).toEqual(
    [1, 2].map((n) => ({
      ...options,
      method: "GET",
      path: "/v1/streams",
      query: { name: "events", limit: 1, ...(n === 2 ? { cursor: "next" } : {}) },
    })),
  );
  expect((await fixture().api.wait("s1", "ready", options)).state).toBe("ready");
});
for (const code of [
  "OFFSET_OUT_OF_RANGE",
  "CORRUPT_MESSAGE",
  "UNKNOWN_TOPIC_OR_PARTITION",
  "MESSAGE_TOO_LARGE",
  "TOPIC_AUTHORIZATION_FAILED",
  "UNSUPPORTED_VERSION",
  "TOPIC_ALREADY_EXISTS",
  "INVALID_PARTITIONS",
  "INVALID_REQUEST",
  "OUT_OF_ORDER_SEQUENCE_NUMBER",
  "INVALID_PRODUCER_EPOCH",
  "KAFKA_STORAGE_ERROR",
  "SASL_AUTHENTICATION_FAILED",
  "INVALID_RECORD",
  "INVALID_CONFIG",
  "INVALID_REPLICATION_FACTOR",
  "not_found",
  "forbidden",
  "insufficient_credit",
  "idempotency_conflict",
]) {
  test(`stream preserves ${code}, hint and retry key`, async () => {
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
      }).api.publish("s1", { records: [{ value: "hi" }] }, options),
    ).rejects.toBe(error);
  });
}
test("retried publish keeps its key and record order", async () => {
  let first = true;
  const { api, seen } = fixture(() => {
    if (first) {
      first = false;
      throw new RuntimeError({
        code: "connection_error",
        status: 0,
        message: "Lost",
        hint: "Retry the same key.",
      });
    }
    return { records: [{ partition: 0, offset: "9007199254740993" }] };
  });
  const input = {
    records: [
      { key: "a", value: "first" },
      { key: "a", value: "second" },
    ],
  };
  await expect(api.publish("s1", input, options)).rejects.toBeInstanceOf(RuntimeError);
  expect(await api.publish("s1", input, options)).toEqual({
    records: [{ partition: 0, offset: "9007199254740993" }],
  });
  expect(seen[0]).toEqual(seen[1]);
});
