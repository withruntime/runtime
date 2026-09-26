import { expect, test } from "bun:test";
import { ConflictError, Runtime } from "../src/index";

/* A create that finds every trial slot, the account's quota or the region full
   waits for room and sends the same call again, instead of failing a CI job
   that burst past its limit (judge panel, 23 September 2026). */

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
    const status = next.status ?? 409;
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
    { code: "trial_busy", details: { sandboxIds: ["a"], concurrent: 8 } },
    { code: "trial_busy", details: { sandboxIds: ["a"], concurrent: 8 } },
  ]);
  const sbx = await client(fetcher).sandboxes.create({ funding: "trial", labels: { ci: "1" } });
  expect(sbx.id).toBe("sbx");
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0]!)).toEqual({ funding: "trial", labels: { ci: "1" } });
});

test("the paid limit, an email domain's trial limit and a full region are waited out too", async () => {
  for (const code of ["quota_exceeded", "trial_domain_limit", "no_capacity"]) {
    const { fetcher, keys } = refusing([{ code }]);
    await client(fetcher).sandboxes.create({});
    expect(keys).toHaveLength(2);
  }
  // trial_capacity is a 503: waited for as room, not spent from maxRetries.
  const { fetcher, keys } = refusing(
    Array.from({ length: 6 }, () => ({
      code: "trial_capacity",
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
  const { fetcher, keys } = refusing(Array.from({ length: 1000 }, () => ({ code: "trial_busy" })));
  const started = performance.now();
  const error = await client(fetcher, 200)
    .sandboxes.create({})
    .catch((e: unknown) => e);
  const took = performance.now() - started;
  expect(error).toBeInstanceOf(ConflictError);
  expect(error).toMatchObject({ code: "trial_busy", status: 409 });
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
  const first = refusing([{ code: "trial_busy" }]);
  await expect(client(first.fetcher, 0).sandboxes.create({})).rejects.toMatchObject({
    code: "trial_busy",
  });
  expect(first.keys).toHaveLength(1);
  const second = refusing([{ code: "quota_exceeded" }]);
  await expect(
    client(second.fetcher).sandboxes.create({}, { waitForCapacityMs: 0 }),
  ).rejects.toMatchObject({ code: "quota_exceeded" });
  expect(second.keys).toHaveLength(1);
});

test("a request that can never fit is not waited for, and only a create waits", async () => {
  const never = refusing([{ code: "trial_busy", details: { field: "count", concurrent: 8 } }]);
  await expect(client(never.fetcher).sandboxes.create({})).rejects.toMatchObject({
    code: "trial_busy",
  });
  expect(never.keys).toHaveLength(1);
  // A fork's failure names copies that started, and its key replays that
  // failure, so a fork is never retried by waiting.
  let forks = 0;
  const forking = (async (url: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(running);
    if (new URL(url).pathname.endsWith(":fork")) forks++;
    return Response.json(
      { error: { code: "trial_busy", status: 409, message: "full", retryAfterMs: 5 } },
      { status: 409 },
    );
  }) as unknown as typeof fetch;
  const sbx = await client(forking).sandboxes.get("sbx");
  await expect(sbx.fork()).rejects.toMatchObject({ code: "trial_busy" });
  expect(forks).toBe(1);
});

test("runtime.sandboxes.getOrCreate sends the name with getOrCreate, and waits for room like a create", async () => {
  const { fetcher, bodies, keys } = refusing([{ code: "trial_busy" }]);
  const sbx = await client(fetcher).sandboxes.getOrCreate("dev", { vcpu: 2 });
  expect(sbx.id).toBe("sbx");
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  expect(JSON.parse(bodies[0]!)).toEqual({ vcpu: 2, name: "dev", getOrCreate: true });
});

test("a create says why it waits, before each wait, so a person is not left with silence", async () => {
  const { fetcher } = refusing([
    { code: "trial_busy", details: { concurrent: 8 } },
    { code: "trial_busy", details: { concurrent: 8 } },
  ]);
  const heard: Array<[string, number]> = [];
  await client(fetcher).sandboxes.create(
    {},
    { onCapacityWait: (refusal, waitMs) => heard.push([refusal.code, waitMs]) },
  );
  expect(heard).toEqual([
    ["trial_busy", 5],
    ["trial_busy", 5],
  ]);
});

test("Sandbox.create takes the create options, as runtime.sandboxes.create does", async () => {
  const { Sandbox } = await import("../src/index");
  const { fetcher, keys } = refusing([{ code: "trial_busy" }]);
  await expect(
    Sandbox.create({}, { client: client(fetcher), waitForCapacityMs: 0 }),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(keys).toHaveLength(1);
});
