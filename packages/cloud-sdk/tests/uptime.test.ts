import { expect, test } from "bun:test";
import { uptime, type UptimeCheck } from "../src/products/uptime.js";
import type { Call, Transport } from "../src/transport.js";

/* The uptime client (src/products/uptime.ts) sends each verb to the route the
   API serves (engines/address/crates/uptime-api), with ids
   escaped, and pages lists by cursor. No fetch: a recording transport. */

const CHECK: UptimeCheck = {
  id: "c /?#",
  name: "home",
  labels: {},
  state: "active",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  error: null,
  url: "https://example.com/",
  method: "GET",
  intervalSeconds: 30,
  timeoutMs: 10_000,
  regions: ["enam", "wnam"],
  confirm: 2,
  statuses: [],
  health: "up",
  healthSince: 1,
};

function fake(answer: (call: Call) => unknown = () => CHECK) {
  const calls: Call[] = [];
  const transport = {
    async json<T>(call: Call): Promise<T> {
      calls.push(call);
      return answer(call) as T;
    },
  } as Transport;
  return { api: uptime(transport), calls };
}

test("each verb reaches its route, ids escaped", async () => {
  const { api, calls } = fake();
  await api.create({ url: "https://example.com/", intervalSeconds: 30 }, { idempotencyKey: "k" });
  await api.get(CHECK.id, { waitFor: "active", timeoutSeconds: 5 });
  await api.update(CHECK.id, { name: "renamed" });
  await api.delete(CHECK.id);
  await api.results(CHECK.id, { before: 99, region: "enam" });
  const id = "c%20%2F%3F%23";
  expect(calls.map((c) => [c.method, c.path])).toEqual([
    ["POST", "/v1/uptime"],
    ["GET", `/v1/uptime/${id}`],
    ["POST", `/v1/uptime/${id}:update`],
    ["DELETE", `/v1/uptime/${id}`],
    ["GET", `/v1/uptime/${id}/results`],
  ]);
  expect(calls[0]).toMatchObject({
    body: { url: "https://example.com/", intervalSeconds: 30 },
    idempotencyKey: "k",
  });
  expect(calls[1]!.query).toEqual({ waitFor: "active", timeoutSeconds: 5 });
  expect(calls[4]!.query).toEqual({ before: 99, region: "enam" });
});

test("a list pages by its cursor until none is left", async () => {
  const { api, calls } = fake((call) =>
    (call.query as { cursor?: string } | undefined)?.cursor
      ? { data: [CHECK], nextCursor: null }
      : { data: [CHECK], nextCursor: "next" },
  );
  const seen: string[] = [];
  for await (const check of await api.list({ label: ["status:public"] })) seen.push(check.id);
  expect(seen).toEqual([CHECK.id, CHECK.id]);
  expect(calls.map((c) => c.query)).toEqual([
    { label: ["status:public"] },
    { label: ["status:public"], cursor: "next" },
  ]);
});
