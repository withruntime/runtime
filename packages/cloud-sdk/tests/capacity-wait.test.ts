import { expect, test } from "bun:test";
import { RateLimitError, Runtime } from "../src/index";

/* A create that finds every trial slot, the account's quota or the region full
   waits for room and sends the same call again, instead of failing a CI job
   that burst past its limit (judge panel, 23 September 2026). */

const STATUS: Record<string, number> = {
  no_capacity: 503,
  quota_exceeded: 429,
  no_credit_running_limit: 429,
};

const running = { id: "sbx", kind: "sandbox", state: "running", status: "active" };

function refusing(
  refusals: Array<{ code: string; status?: number; details?: Record<string, unknown> }>,
) {
  const keys: (string | null)[] = [];
  const bodies: string[] = [];
  const paths: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    keys.push(new Headers(init.headers).get("idempotency-key"));
    bodies.push(typeof init.body === "string" ? init.body : "");
    paths.push(new URL(url).pathname);
    const next = refusals.shift();
    if (!next) return Response.json(running);
    // As the API answers them since 17 October 2026.
    const status = next.status ?? STATUS[next.code] ?? 409;
    return Response.json(
      {
        error: {
          code: next.code,
          status,
          message: "full",
          retryAfterMs: 5,
          ...(next.details ? { details: next.details } : {}),
        },
      },
      { status },
    );
  }) as unknown as typeof fetch;
  return { fetcher, keys, bodies, paths };
}

const client = (fetcher: typeof fetch, waitForCapacityMs?: number) =>
  new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: fetcher,
    ...(waitForCapacityMs === undefined ? {} : { waitForCapacityMs }),
  });

test("a create waits out a full trial, then succeeds with the same key and input", async () => {
  const { fetcher, keys, bodies } = refusing([
    { code: "no_credit_running_limit", details: { sandboxIds: ["a"], concurrent: 8 } },
    { code: "no_credit_running_limit", details: { sandboxIds: ["a"], concurrent: 8 } },
  ]);
  const sbx = await client(fetcher).sandboxes.create({ funding: "trial", labels: { ci: "1" } });
  expect(sbx.id).toBe("sbx");
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0]!)).toEqual({ funding: "trial", labels: { ci: "1" } });
});

test("the paid limit, an email domain's trial limit and a full region are waited out too", async () => {
  for (const code of ["quota_exceeded", "no_credit_domain_limit", "no_capacity"]) {
    const { fetcher, keys } = refusing([{ code }]);
    await client(fetcher).sandboxes.create({});
    expect(keys).toHaveLength(2);
  }
  // no_credit_capacity_full is a 503: waited for as room, not spent from maxRetries.
  const { fetcher, keys } = refusing(
    Array.from({ length: 6 }, () => ({
      code: "no_credit_capacity_full",
      status: 503,
    })),
  );
  await new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: fetcher,
    maxRetries: 1,
  }).sandboxes.create({});
  expect(keys).toHaveLength(7);
});

test("when the wait runs out, the original refusal is thrown", async () => {
  const { fetcher, keys } = refusing(
    Array.from({ length: 1000 }, () => ({ code: "no_credit_running_limit" })),
  );
  const started = performance.now();
  const error = await client(fetcher, 200)
    .sandboxes.create({})
    .catch((e: unknown) => e);
  const took = performance.now() - started;
  expect(error).toBeInstanceOf(RateLimitError);
  expect(error).toMatchObject({ code: "no_credit_running_limit", status: 429 });
  expect(keys.length).toBeGreaterThan(2);
  expect(took).toBeGreaterThanOrEqual(190);
  expect(took).toBeLessThan(1500);
  // The wait is added to the call's deadline, not taken from it: a short
  // timeoutMs still ends in the refusal, never in a cancelled call.
  const short = refusing(Array.from({ length: 1000 }, () => ({ code: "no_capacity" })));
  await expect(
    client(short.fetcher).sandboxes.create({}, { timeoutMs: 50, waitForCapacityMs: 250 }),
  ).rejects.toMatchObject({ code: "no_capacity" });
});

test("waitForCapacityMs: 0 fails at once, on the client or on one call", async () => {
  const first = refusing([{ code: "no_credit_running_limit" }]);
  await expect(client(first.fetcher, 0).sandboxes.create({})).rejects.toMatchObject({
    code: "no_credit_running_limit",
  });
  expect(first.keys).toHaveLength(1);
  const second = refusing([{ code: "quota_exceeded" }]);
  await expect(
    client(second.fetcher).sandboxes.create({}, { waitForCapacityMs: 0 }),
  ).rejects.toMatchObject({ code: "quota_exceeded" });
  expect(second.keys).toHaveLength(1);
});

test("a request that can never fit is not waited for, and a fork never waits", async () => {
  const never = refusing([
    { code: "no_credit_running_limit", details: { field: "count", concurrent: 8 } },
  ]);
  await expect(client(never.fetcher).sandboxes.create({})).rejects.toMatchObject({
    code: "no_credit_running_limit",
  });
  expect(never.keys).toHaveLength(1);
  // A fork's failure names copies that started, and its key replays that
  // failure, so a fork is never retried by waiting.
  let forks = 0;
  const forking = (async (url: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(running);
    if (new URL(url).pathname.endsWith(":fork")) forks++;
    return Response.json(
      { error: { code: "no_credit_running_limit", status: 429, message: "full", retryAfterMs: 5 } },
      { status: 429 },
    );
  }) as unknown as typeof fetch;
  const sbx = await client(forking).sandboxes.get("sbx");
  await expect(sbx.fork()).rejects.toMatchObject({ code: "no_credit_running_limit" });
  expect(forks).toBe(1);
});

test("runtime.sandboxes.getOrCreate sends the name with getOrCreate, and waits for room like a create", async () => {
  const { fetcher, bodies, keys } = refusing([{ code: "no_credit_running_limit" }]);
  const sbx = await client(fetcher).sandboxes.getOrCreate("dev", { vcpu: 2 });
  expect(sbx.id).toBe("sbx");
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  expect(JSON.parse(bodies[0]!)).toEqual({ vcpu: 2, name: "dev", getOrCreate: true });
});

test("a create says why it waits, before each wait, so a person is not left with silence", async () => {
  const { fetcher } = refusing([
    { code: "no_credit_running_limit", details: { concurrent: 8 } },
    { code: "no_credit_running_limit", details: { concurrent: 8 } },
  ]);
  const heard: Array<[string, number]> = [];
  await client(fetcher).sandboxes.create(
    {},
    { onCapacityWait: (refusal, waitMs) => heard.push([refusal.code, waitMs]) },
  );
  expect(heard).toEqual([
    ["no_credit_running_limit", 5],
    ["no_credit_running_limit", 5],
  ]);
});

test("Sandbox.create takes the create options, as runtime.sandboxes.create does", async () => {
  const { Sandbox } = await import("../src/index");
  const { fetcher, keys } = refusing([{ code: "no_credit_running_limit" }]);
  await expect(
    Sandbox.create({}, { client: client(fetcher), waitForCapacityMs: 0 }),
  ).rejects.toBeInstanceOf(RateLimitError);
  expect(keys).toHaveLength(1);
});

/* 16 October 2026, 06:11 UTC: the product check's wake was refused
   no_capacity in 36 ms on its full server, where a create would have waited.
   A wake or restart stays on its server, so it waits there for room. */
function fullServer(refusals: number) {
  const keys: (string | null)[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json({ ...running, state: "paused" });
    keys.push(new Headers(init.headers).get("idempotency-key"));
    if (refusals-- <= 0) return Response.json(running);
    return Response.json(
      { error: { code: "no_capacity", status: 503, message: "full", retryAfterMs: 5 } },
      { status: 503 },
    );
  }) as unknown as typeof fetch;
  return { fetcher, keys };
}

test("a wake and a restart on a full server wait for room with the same key", async () => {
  for (const verb of ["wake", "restart"] as const) {
    const { fetcher, keys } = fullServer(2);
    const waits: string[] = [];
    const sbx = await client(fetcher).sandboxes.get("sbx");
    await sbx[verb]({ onCapacityWait: (refusal) => waits.push(refusal.code) });
    expect(sbx.state).toBe("running");
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(waits).toEqual(["no_capacity", "no_capacity"]);
  }
});

test("a wake with waitForCapacityMs 0, on the client or the call, fails at once", async () => {
  for (const [onClient, onCall] of [
    [0, undefined],
    [undefined, 0],
  ] as const) {
    const { fetcher, keys } = fullServer(1);
    const sbx = await client(fetcher, onClient).sandboxes.get("sbx");
    await expect(
      sbx.wake(onCall === undefined ? {} : { waitForCapacityMs: onCall }),
    ).rejects.toMatchObject({ code: "no_capacity" });
    expect(keys).toHaveLength(1);
  }
});

test("a wait for room moves the call's deadline on, and never spends the caller's own timeoutMs", async () => {
  // Two waits of 250 ms each, against a call given 200 ms: the waits are the
  // room's, so the wake still lands. (30 ms against 40 ms waits ran out on a
  // loaded machine before the first wait, on the requests' own time.)
  let refusals = 2;
  const fetcher = (async (_url: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json({ ...running, state: "paused" });
    if (refusals-- <= 0) return Response.json(running);
    return Response.json(
      { error: { code: "no_capacity", status: 503, message: "full", retryAfterMs: 250 } },
      { status: 503 },
    );
  }) as unknown as typeof fetch;
  const sbx = await client(fetcher).sandboxes.get("sbx");
  await sbx.wake({ timeoutMs: 200 });
  expect(sbx.state).toBe("running");
});
