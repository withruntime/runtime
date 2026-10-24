import { expect, test } from "bun:test";
import { logsProductCommand } from "./logs.js";
import { terminalSafe } from "../terminal.js";
import { logs, traces, alerts, type TailEvent } from "../products/logs.js";
import { Transport } from "../transport.js";
import { InvalidRequestError } from "../errors.js";
import { onFakeClock } from "../../tests/fixtures/fake-clock";

onFakeClock();

const input = {
  name: "errors",
  labels: {},
  query: '{app="api"}',
  condition: "above 5",
  for: "5m",
  actions: [],
};
type Product = "logs" | "traces" | "alerts";
type Case = [Product, string[], Record<string, string>, string, string];
const cases: Case[] = [
  ["logs", ["query", "{}"], { from: "1", to: "2", limit: "5" }, "GET", "/v1/logs/query_range"],
  ["logs", ["labels"], {}, "GET", "/v1/logs/labels"],
  ["logs", ["values", "app"], {}, "GET", "/v1/logs/labels/app/values"],
  ["logs", ["ingest"], { body: '{"resourceLogs":[]}' }, "POST", "/v1/logs"],
  ["traces", ["ingest"], { body: '{"resourceSpans":[]}' }, "POST", "/v1/traces"],
  ["traces", ["get", "id"], {}, "GET", "/v1/traces/id"],
  ["traces", ["search", "{}"], {}, "GET", "/v1/traces:search"],
  ["traces", ["tags"], {}, "GET", "/v1/traces/tags"],
  ["alerts", ["test", "id"], {}, "POST", "/v1/alerts/id/test"],
  [
    "alerts",
    ["silence", "id"],
    { until: "2026-10-07T00:00:00Z", reason: "maintenance" },
    "POST",
    "/v1/alerts/id/silence",
  ],
];
for (const product of ["logs", "traces", "alerts"] as const)
  for (const verb of ["ls", "get", "create", "update", "delete"]) {
    const collection = `/v1/${product}${product === "alerts" ? "" : "/views"}`;
    cases.push([
      product,
      [
        ...(product === "alerts" ? [] : ["views"]),
        verb,
        ...(["get", "update", "delete"].includes(verb) ? ["id"] : []),
      ],
      ["create", "update"].includes(verb) ? { body: JSON.stringify(input) } : {},
      (
        { ls: "GET", get: "GET", create: "POST", update: "PUT", delete: "DELETE" } as Record<
          string,
          string
        >
      )[verb]!,
      collection + (["get", "update", "delete"].includes(verb) ? "/id" : ""),
    ]);
  }
function setup() {
  const requests: { url: URL; init: RequestInit }[] = [];
  const transport = new Transport({
    apiKey: "fake",
    baseUrl: "https://fake.test",
    maxRetries: 0,
    fetch: (async (url, init) => {
      requests.push({ url: new URL(url instanceof Request ? url.url : url), init: init ?? {} });
      return Response.json({ ...input, id: "id", data: [], nextCursor: null, marker: "ok" });
    }) as typeof fetch,
  });
  return {
    client: { logs: logs(transport), traces: traces(transport), alerts: alerts(transport) },
    requests,
  };
}
for (const [product, positional, flags, method, path] of cases)
  for (const mode of ["tty", "pipe", "json"] as const)
    test(`${product} ${positional.join(" ")} ${mode}`, async () => {
      const { client, requests } = setup(),
        output: string[] = [];
      const result = await logsProductCommand(
        product,
        positional,
        {
          positional,
          flags: new Map(
            Object.entries({ ...flags, "idempotency-key": "retry-key" }).map(([key, value]) => [
              key,
              [value],
            ]),
          ),
        },
        {
          json: mode === "json",
          tty: mode === "tty",
          write: (text) => output.push(text),
          error: () => {
            throw new Error("unexpected stderr");
          },
        },
        async () => client,
      );
      expect(result).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url.pathname).toBe(path);
      expect(requests[0]!.init.method).toBe(method);
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain("\x1b");
      const printed = JSON.parse(output[0]!);
      if (positional.includes("delete")) expect(printed).toEqual({ deleted: "id" });
      else if (positional.includes("ls")) expect(printed).toEqual({ data: [], nextCursor: null });
      else expect(printed.marker).toBe("ok");
      if (method !== "GET")
        expect(new Headers(requests[0]!.init.headers).get("idempotency-key")).toBe("retry-key");
      if (positional[0] === "query")
        expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
          query: "{}",
          start: "1",
          end: "2",
          limit: "5",
        });
    });
for (const mode of ["tty", "pipe", "json"] as const)
  test(`tail ${mode}, selector escaping, gap and backpressure`, async () => {
    const { client } = setup();
    const output: string[] = [];
    let drained = 0;
    const events: TailEvent[] = [
      {
        time: "12:00",
        timeUnixNano: "1",
        severity: 9,
        severityText: "INFO",
        labels: {},
        attributes: {},
        traceId: null,
        spanId: null,
        body: "line\x1b[2J\nnext",
        cursor: "one",
      },
      { gap: true, from: "old", to: "kept" },
    ];
    let received: unknown;
    client.logs.tail = async function* (query, options) {
      received = { query, options };
      yield* events;
    };
    const positional = ["tail", 'app"name'];
    await logsProductCommand(
      "logs",
      positional,
      {
        positional,
        flags: new Map([
          ["since", ["1h"]],
          ["grep", ['a"b']],
        ]),
      },
      {
        json: mode === "json",
        tty: mode === "tty",
        write: (text) => output.push(text),
        error() {},
        async drain() {
          drained++;
        },
      },
      async () => client,
      { now: Date.parse("2026-10-06T12:00:00Z") },
    );
    expect(received).toEqual({
      query: '{app="app\\"name"} |= "a\\"b"',
      options: { start: "2026-10-06T11:00:00.000Z" },
    });
    expect(drained).toBe(2);
    if (mode === "json") expect(output.map((text) => JSON.parse(text))).toEqual(events);
    else {
      if (mode === "tty") expect(output[0]).toContain("line\\u001b[2J\\u000anext");
      else expect(output[0]).toContain("line\u001b[2J\nnext");
      expect(output[1]).toContain("Logs expired");
      expect(output[1]!.includes("\x1b[2m")).toBe(mode === "tty");
    }
  });
test("tail survives an actual fake-fetch disconnect through the SDK", async () => {
  let calls = 0;
  const cursors: (string | null)[] = [],
    output: string[] = [];
  const abort = new AbortController();
  const transport = new Transport({
    apiKey: "fake",
    baseUrl: "https://fake.test",
    fetch: (async (input) => {
      cursors.push(
        new URL(input instanceof Request ? input.url : input).searchParams.get("cursor"),
      );
      const cursor = String(++calls);
      return new Response(
        `id: ${cursor}\ndata: ${JSON.stringify({ time: "now", timeUnixNano: "1", labels: {}, body: "same", severityText: "INFO" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  });
  const client = { logs: logs(transport), traces: traces(transport), alerts: alerts(transport) };
  const run = logsProductCommand(
    "logs",
    ["tail", "{}"],
    { positional: ["tail", "{}"], flags: new Map() },
    {
      json: true,
      write(text) {
        output.push(text);
        if (output.length === 2) abort.abort(new Error("done"));
      },
      error() {},
    },
    async () => client,
    { signal: abort.signal },
  );
  await expect(run).rejects.toThrow("done");
  expect(cursors).toEqual([null, "1"]);
  expect(output.map((text) => JSON.parse(text).cursor)).toEqual(["1", "2"]);
});
for (const [product, positional, flags] of [
  ["logs", ["query", "{}"], { limit: "0" }],
  ["logs", ["query"], {}],
  ["logs", ["tail", "api"], { since: "forever" }],
  ["alerts", ["create"], { body: "[1]" }],
  ["alerts", ["create"], { body: "broken" }],
  ["alerts", ["silence", "id"], { until: "tomorrow" }],
  ["logs", ["ingest"], { body: "{}" }],
  ["traces", ["ingest"], { body: "{}" }],
  ["alerts", ["oops", "id"], {}],
] as [Product, string[], Record<string, string>][])
  test(`refuses ${positional.join(" ")} ${JSON.stringify(flags)}`, async () => {
    const { client, requests } = setup();
    await expect(
      logsProductCommand(
        product,
        positional,
        { positional, flags: new Map(Object.entries(flags).map(([key, value]) => [key, [value]])) },
        { json: true, write() {}, error() {} },
        async () => client,
      ),
    ).rejects.toMatchObject({ code: "usage", hint: expect.any(String) });
    expect(requests).toHaveLength(0);
  });
test("help needs no credentials", async () => {
  const output: string[] = [];
  await logsProductCommand(
    "logs",
    ["help"],
    { positional: ["help"], flags: new Map() },
    { json: false, write: (text) => output.push(text), error() {} },
    async () => {
      throw new Error("credentials requested");
    },
  );
  expect(output[0]).toContain("\nruntime logs query");
});

test("typed failures reach the main CLI's JSON error renderer unchanged", async () => {
  const { client } = setup();
  const failure = new InvalidRequestError({
    code: "query_limit",
    message: "Too broad",
    status: 400,
    hint: "Narrow the time range.",
  });
  client.logs.queryRange = async () => {
    throw failure;
  };
  await expect(
    logsProductCommand(
      "logs",
      ["query", "{}"],
      { positional: ["query", "{}"], flags: new Map() },
      {
        json: true,
        write() {
          throw new Error("Do not print success on failure");
        },
        error() {},
      },
      async () => client,
    ),
  ).rejects.toBe(failure);
});

test("human JSON keeps formatting but escapes C1 terminal controls", async () => {
  const { client } = setup();
  const output: string[] = [];
  client.traces.get = async () => ({ resourceSpans: [], marker: "\u009b2J" });
  await logsProductCommand(
    "traces",
    ["get", "id"],
    { positional: ["get", "id"], flags: new Map() },
    { json: false, tty: true, write: (text) => output.push(text), error() {} },
    async () => client,
  );
  expect(output[0]).not.toContain("\u009b");
  expect(output[0]).toContain("\\u009b");
  expect(output[0]).toContain("\n");
  expect(JSON.parse(output[0]!).marker).toBe("\u009b2J");
});

test("a terminal shows what customers' programs wrote, escaped, and nothing acts", async () => {
  // Clipboard (OSC 52), a forged link (OSC 8), screen clear, the one-byte C1
  // CSI and a right-to-left override; tab stays.
  const hostile =
    "a\tb \x1b]52;c;c2VjcmV0\x07 \x1b]8;;https://evil.test\x07ok\x1b]8;;\x07 \x1b[2J \u009b2J \u202eevil";
  const shown = terminalSafe(hostile);
  // eslint-disable-next-line no-control-regex -- the test looks for control characters
  expect(shown).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f-\x9f\u202e]/);
  expect(shown).toContain("a\tb");
  expect(shown).toContain("\\u001b]52;c;c2VjcmV0\\u0007");
  expect(shown).toContain("\\u009b2J \\u202eevil");
  const run = async (tty: boolean, raw: boolean, json: boolean) => {
    const { client } = setup();
    client.logs.tail = async function* () {
      yield { cursor: "c", time: "t", severityText: "INFO", body: hostile, labels: {} } as never;
    };
    const output: string[] = [];
    const flags = new Map<string, string[]>(raw ? [["raw", ["true"]]] : []);
    await logsProductCommand(
      "logs",
      ["tail", "{}"],
      { positional: ["tail", "{}"], flags },
      { json, tty, write: (text) => output.push(text), error() {} },
      async () => client,
    );
    return output.join("\n");
  };
  for (const json of [false, true]) {
    const onTerminal = await run(true, false, json);
    expect(onTerminal).not.toContain("\x1b]");
    expect(onTerminal).not.toContain("\u009b");
    expect(onTerminal).not.toContain("\u202e");
    if (json) expect(JSON.parse(onTerminal).body).toBe(hostile);
    // A pipe, or --raw on a terminal, gets exactly what was written.
    expect(await run(false, false, json)).toContain(json ? JSON.stringify(hostile) : hostile);
    expect(await run(true, true, json)).toContain(json ? JSON.stringify(hostile) : hostile);
  }
});
