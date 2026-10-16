import { expect, test } from "bun:test";
import { RuntimeError } from "../src/errors";
import { balancers, firewall, type Balancer } from "../src/products/balancers";
import { Transport } from "../src/transport";

// The SDK's balancers and firewall clients: each verb's path and body, and
// a wait that follows applying to active and deleting to deleted.
const id = "11111111-1111-4111-8111-111111111111";
const record = (state: Balancer["state"], waitingOn: string[] = []): Balancer => ({
  id,
  name: null,
  labels: {},
  state,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: state === "deleted" ? 2 : null,
  error: state === "failed" ? { code: "route_refused", message: "A router refused it." } : null,
  waitingOn,
  hostname: `${id.replaceAll("-", "")}.runtimehost.com`,
  targets: [],
});

function stub(answer: (request: Request, count: number) => unknown) {
  const seen: { method: string; path: string; body: string }[] = [];
  const transport = new Transport({
    apiKey: "rk_test",
    baseUrl: "https://api.example.test",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        body: await request.clone().text(),
      });
      return Response.json(answer(request, seen.length));
    }) as typeof fetch,
  });
  return { transport, seen };
}

test("each verb reaches its route with its body", async () => {
  const { transport, seen } = stub(() => record("applying"));
  const lb = balancers(transport);
  const target = { id: "22222222-2222-4222-8222-222222222222", port: 8080 };
  await lb.create({ name: "edge", targets: [target] });
  await lb.update(id, { targets: [target] });
  await lb.get(id, { waitFor: "active", timeoutSeconds: 10 });
  await lb.delete(id);
  await firewall(transport).create({ address: id, effect: "limit", requests: 100, seconds: 60 });
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    "POST /v1/balancers",
    `POST /v1/balancers/${id}:update`,
    `GET /v1/balancers/${id}?waitFor=active&timeoutSeconds=10`,
    `DELETE /v1/balancers/${id}`,
    "POST /v1/firewall/rules",
  ]);
  expect(JSON.parse(seen[0]!.body)).toEqual({ name: "edge", targets: [target] });
  expect(JSON.parse(seen[4]!.body)).toEqual({
    address: id,
    effect: "limit",
    requests: 100,
    seconds: 60,
  });
});

test("a wait follows applying until every router serves it", async () => {
  const states = [record("applying", ["vin-11"]), record("applying"), record("active")];
  const { transport } = stub((_, n) => states[Math.min(n, states.length) - 1]);
  const done = await balancers(transport).wait(id, "active", { pollMs: 0 });
  expect(done.state).toBe("active");
});

test("a wait that ends failed answers the resource's own error", async () => {
  const { transport } = stub(() => record("failed"));
  const error = await balancers(transport)
    .wait(id, "active", { pollMs: 0 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RuntimeError);
  expect((error as RuntimeError).code).toBe("route_refused");
});

test("a delete with wait follows deleting to deleted", async () => {
  const states = [record("deleting", ["vin-12"]), record("deleting"), record("deleted")];
  const { transport, seen } = stub((_, n) => states[Math.min(n, states.length) - 1]);
  const done = await balancers(transport).delete(id, { wait: true, pollMs: 0 });
  expect(done.state).toBe("deleted");
  expect(seen[0]!.method).toBe("DELETE");
});
