import { expect, test } from "bun:test";
import { recordCommand, type RecordProduct } from "../src/record-cli";
import { queues } from "../src/products/queues";
import { streams } from "../src/products/streams";
import { RuntimeError } from "../src/errors";
import type { Call, Transport } from "../src/transport";
function fixture(answer: (call: Call) => unknown = () => ({ id: "r1", state: "ready" })) {
  const seen: Call[] = [];
  const output: string[] = [];
  let connected = 0;
  const t = {
    async json(call: Call) {
      seen.push(call);
      return answer(call);
    },
  } as unknown as Transport;
  const run = (
    product: RecordProduct,
    positional: string[],
    flags: Record<string, string[]> = {},
    json = true,
  ) =>
    recordCommand(
      product,
      { positional, flags: new Map(Object.entries(flags)) },
      { json, write: (text) => output.push(text), error: (text) => output.push(text) },
      async () => {
        connected++;
        return { queues: queues(t), streams: streams(t) };
      },
    );
  return { run, seen, output, connections: () => connected };
}
for (const product of ["queue", "stream"] as const) {
  test(`${product} help and invalid commands never connect`, async () => {
    const f = fixture();
    await f.run(product, ["help"]);
    expect(f.output[0]).toContain("private until launch");
    for (const [args, flags] of [
      [["bogus"], {}],
      [["get"], {}],
      [["get", "r1", "extra"], {}],
      [["create"], {}],
      [["create"], { input: ["[]"] }],
      [["create"], { input: ["{"] }],
      [["create"], { name: ["work"], input: ['{"name":"other"}'] }],
      [["delete", "r1"], { input: ["{}"] }],
      [["get", "r1"], { typo: ["x"] }],
      [["get", "r1"], { "timeout-ms": ["-1"] }],
      [["get", "r1"], { "timeout-ms": ["9007199254740992"] }],
      [["get", "r1"], { "idempotency-key": ["a", "b"] }],
      [["wait", "r1"], { state: ["failed"] }],
    ] as [string[], Record<string, string[]>][])
      await expect(f.run(product, args, flags)).rejects.toMatchObject({
        code: "usage",
        hint: expect.any(String),
      });
    expect(f.connections()).toBe(0);
  });
  test(`${product} CRUD, aliases, JSON cursors and wait preserve options`, async () => {
    const f = fixture((call) =>
      call.path.endsWith(`/${product}s`) && call.method === "GET"
        ? { data: [], nextCursor: "next" }
        : { id: "r1", state: "ready" },
    );
    const flags = { "idempotency-key": ["k"], "timeout-ms": ["50"] };
    await f.run(product, ["create"], { ...flags, name: ["work"] });
    await f.run(product, ["get", "r1"], flags);
    await f.run(product, ["update", "r1"], { ...flags, input: ['{"labels":{}}'] });
    await f.run(product, ["ls"], { ...flags, input: ['{"limit":1,"cursor":"old"}'] });
    await f.run(product, ["rm", "r1"], flags, false);
    await f.run(product, ["wait", "r1"], { ...flags, "poll-ms": ["0"] });
    expect(f.seen.map((c) => c.method)).toEqual(["POST", "GET", "POST", "GET", "DELETE", "GET"]);
    expect(f.seen[0]!.body).toEqual({ name: "work" });
    expect(f.seen[2]!.body).toEqual({ labels: {} });
    expect(f.seen[3]!.query).toEqual({ limit: 1, cursor: "old" });
    expect(JSON.parse(f.output[3]!)).toEqual({ data: [], nextCursor: "next" });
    for (const call of f.seen.slice(0, 5))
      expect(call).toMatchObject({ idempotencyKey: "k", timeoutMs: 50 });
  });
}
test("every record data command dispatches its input unchanged", async () => {
  for (const [product, verb, input] of [
    ["queue", "send", { body: "hi", groupId: "g", dedupId: "d" }],
    ["queue", "receive", { max: 10, waitSeconds: 20 }],
    ["queue", "ack", { receiptHandles: ["r"] }],
    ["queue", "retry", { receiptHandle: "r", visibilitySeconds: 0 }],
    ["stream", "publish", { records: [{ value: "hi" }] }],
    ["stream", "read", { partition: 0, offset: "9007199254740993" }],
    ["stream", "trim", { partition: 0, before: "9007199254740993" }],
  ] as [RecordProduct, string, object][]) {
    const f = fixture(() => ({ successful: ["r"], failed: [] }));
    expect(
      await f.run(product, [verb, "r1"], {
        input: [JSON.stringify(input)],
        "idempotency-key": ["k"],
      }),
    ).toBe(0);
    expect(f.seen[0]).toEqual({
      method: verb === "read" ? "GET" : "POST",
      path: `/v1/${product}s/r1:${verb}`,
      [verb === "read" ? "query" : "body"]: input,
      idempotencyKey: "k",
    });
  }
  const f = fixture();
  await f.run("queue", ["purge", "r1"]);
  await f.run("queue", ["receive", "r1"]);
  expect(f.seen.map((c) => c.body)).toEqual([{}, {}]);
  expect(f.seen[0]!.idempotencyKey).not.toBe(f.seen[1]!.idempotencyKey);
});
test("partial ack and server refusals cannot print success", async () => {
  const f = fixture(() => ({
    successful: ["r1"],
    failed: [
      {
        receiptHandle: "old",
        code: "ReceiptHandleIsInvalid",
        message: "Stale",
        hint: "Receive again.",
      },
    ],
  }));
  await expect(
    f.run("queue", ["ack", "r1"], { input: ['{"receiptHandles":["r1","old"]}'] }),
  ).rejects.toMatchObject({
    code: "ReceiptHandleIsInvalid",
    details: { successful: ["r1"] },
    hint: "Receive again.",
  });
  expect(f.output).toEqual([]);
  const error = new RuntimeError({
    code: "forbidden",
    status: 403,
    message: "No",
    hint: "Use an authorized key.",
  });
  await expect(
    fixture(() => {
      throw error;
    }).run("stream", ["get", "s1"]),
  ).rejects.toBe(error);
});
test("first-session workflow counts calls and measures fake-transport seconds", async () => {
  const f = fixture((call) =>
    call.path.endsWith(":ack")
      ? { successful: ["receipt"], failed: [] }
      : { id: "r1", state: "ready", messages: [{ body: "hello", receiptHandle: "receipt" }] },
  );
  // Official docs, counted 6 October 2026 (not timed):
  // AWS CLI SQS: create-queue, send-message, receive-message, delete-message.
  // https://docs.aws.amazon.com/cli/latest/userguide/cli_sqs_code_examples.html
  // Confluent CLI: cluster create, topic create, api-key create, topic produce,
  // topic consume. The last three topic operations are the warm-cluster path.
  // https://docs.confluent.io/confluent-cli/current/overview.html
  const samples: number[] = [];
  const queueSeconds: number[] = [];
  const streamSeconds: number[] = [];
  for (let i = 0; i < 31; i++) {
    const start = performance.now();
    await f.run("queue", ["create"], { name: ["work"] });
    await f.run("queue", ["send", "r1"], { input: ['{"body":"hello"}'] });
    await f.run("queue", ["consume", "r1"], { exec: ["cat"], max: ["1"] });
    const queueEnd = performance.now();
    queueSeconds.push((queueEnd - start) / 1000);
    await f.run("stream", ["create"], { name: ["events"] });
    await f.run("stream", ["publish", "r1"], { input: ['{"records":[{"value":"hello"}]}'] });
    await f.run("stream", ["read", "r1"], { input: ['{"partition":0,"offset":"0"}'] });
    const end = performance.now();
    streamSeconds.push((end - queueEnd) / 1000);
    samples.push((end - start) / 1000);
  }
  samples.sort((a, b) => a - b);
  queueSeconds.sort((a, b) => a - b);
  streamSeconds.sort((a, b) => a - b);
  expect(f.seen).toHaveLength(31 * 7);
  console.info(
    `First session: queue 3 commands (4 HTTP requests) in ${queueSeconds[15]!.toFixed(6)} seconds median; stream 3 commands (3 HTTP requests) in ${streamSeconds[15]!.toFixed(6)} seconds median; 31 fake-transport samples; median=${samples[15]!.toFixed(6)} seconds; max=${samples[30]!.toFixed(6)} seconds. Includes local cat process startup. No server, network, provisioning or durability measured.`,
  );
});

test("arguments after the CLI separator are refused before credentials are read", async () => {
  let connected = false;
  await expect(
    recordCommand(
      "queue",
      { positional: ["delete", "q1"], flags: new Map(), rest: ["ignored"] },
      { json: true, write() {}, error() {} },
      async () => {
        connected = true;
        throw Error("must not connect");
      },
    ),
  ).rejects.toMatchObject({ code: "usage", hint: expect.any(String) });
  expect(connected).toBe(false);
});

test("CLI consume passes body on stdin without treating it as shell code and acknowledges exit zero", async () => {
  const body = '$(printf should-not-run); quoted "text"\nsecond line';
  const f = fixture((call) =>
    call.path.endsWith(":receive")
      ? { messages: [{ id: "m1", body, receiptHandle: "r", receives: 1 }] }
      : { successful: ["r"], failed: [] },
  );
  expect(
    await f.run("queue", ["consume", "q1"], {
      exec: ["cat"],
      max: ["1"],
      "wait-seconds": ["0"],
      "visibility-seconds": ["120"],
      "timeout-ms": ["200"],
    }),
  ).toBe(0);
  expect(f.output.slice(0, -1).join("")).toBe(body);
  expect(JSON.parse(f.output.at(-1)!)).toEqual({
    processed: 1,
    acknowledged: 1,
    retried: 0,
    aborted: false,
  });
  expect(f.seen.map((c) => c.path)).toEqual(["/v1/queues/q1:receive", "/v1/queues/q1:ack"]);
  expect(f.seen[0]!.body).toEqual({ max: 1, waitSeconds: 0, visibilitySeconds: 120 });
  expect(f.seen[1]!.timeoutMs).toBe(200);
});

test("CLI consume returns nonzero and releases messages when the command fails", async () => {
  const f = fixture((call) =>
    call.path.endsWith(":receive")
      ? { messages: [{ id: "m1", body: "hi", receiptHandle: "r", receives: 1 }] }
      : {},
  );
  expect(await f.run("queue", ["consume", "q1"], { exec: ["exit 7"], max: ["2"] })).toBe(1);
  expect(f.seen.map((c) => c.path.split(":").at(-1))).toEqual([
    "receive",
    "retry",
    "receive",
    "retry",
  ]);
  expect(f.seen[1]!.body).toEqual({ receiptHandle: "r", visibilitySeconds: 0 });
  expect(f.output.join("")).toContain("command_failed");
  expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ processed: 2, acknowledged: 0, retried: 2 });
});

test("CLI consume rejects missing commands, bad bounds, keys and stream consume before connecting", async () => {
  const f = fixture();
  const refused: Record<string, string[]>[] = [
    {},
    { exec: [" "] },
    { exec: ["cat"], max: ["-1"] },
    { exec: ["cat"], "wait-seconds": ["21"] },
    { exec: ["cat"], "visibility-seconds": ["43201"] },
    { exec: ["cat"], "timeout-ms": ["0"] },
    { exec: ["cat"], "idempotency-key": ["one-key-for-every-message"] },
  ];
  for (const flags of refused)
    await expect(f.run("queue", ["consume", "q1"], flags)).rejects.toMatchObject({
      code: "usage",
      hint: expect.any(String),
    });
  await expect(f.run("stream", ["consume", "s1"], { exec: ["cat"] })).rejects.toMatchObject({
    code: "usage",
  });
  expect(f.connections()).toBe(0);
});

test("CLI cancellation terminates the command and releases its receipt; signal listeners are removed", async () => {
  const controller = new AbortController();
  const seen: Call[] = [];
  const output: string[] = [];
  let pid = 0;
  const t = {
    async json(call: Call) {
      seen.push(call);
      return call.path.endsWith(":receive")
        ? { messages: [{ id: "m1", body: "hi", receiptHandle: "r", receives: 1 }] }
        : {};
    },
  } as unknown as Transport;
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)'`;
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const code = await recordCommand(
      "queue",
      { positional: ["consume", "q1"], flags: new Map([["exec", [command]]]) },
      {
        json: true,
        write: (text) => output.push(text),
        error: (text) => {
          if (/^\d+$/.test(text)) {
            pid = Number(text);
            controller.abort();
          }
        },
      },
      async () => ({ queues: queues(t), streams: streams(t) }),
      controller.signal,
    );
    expect(code).toBe(130);
    expect(pid).toBeGreaterThan(0);
    expect(JSON.parse(output.at(-1)!)).toEqual({
      processed: 1,
      acknowledged: 0,
      retried: 1,
      aborted: true,
    });
    expect(seen.map((c) => c.path.split(":").at(-1))).toEqual(["receive", "retry"]);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    let alive = true;
    for (let attempt = 0; alive && attempt < 50; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        alive = false;
      }
    }
    expect(alive).toBe(false);
  } finally {
    clearTimeout(timer);
  }
});
