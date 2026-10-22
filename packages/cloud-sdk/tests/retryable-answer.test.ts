import { expect, test } from "bun:test";
import { RateLimitError, Runtime, RuntimeError } from "../src/index";
import { describeError } from "../src/cli";

/** A Runtime whose every call is answered by `answer`, counting calls and
 * the Idempotency-Key and time of each. */
function answering(answer: (call: number) => Response) {
  const keys: (string | null)[] = [];
  const at: number[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    keys.push(new Headers(init.headers).get("idempotency-key"));
    at.push(performance.now());
    return answer(keys.length);
  }) as unknown as typeof fetch;
  const runtime = new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: fetcher,
    maxRetries: 4,
  });
  return { runtime, keys, at };
}

const refusal = (
  code: string,
  status: number,
  retryable: boolean | undefined,
  retryAfter?: number,
): Response =>
  Response.json(
    {
      error: {
        code,
        status,
        message: "m",
        requestId: "req_1",
        hint: "h",
        ...(retryable === undefined ? {} : { retryable }),
      },
    },
    {
      status,
      ...(retryAfter === undefined ? {} : { headers: { "retry-after": `${retryAfter}` } }),
    },
  );

const SANDBOX = { id: "x", kind: "sandbox", state: "running", status: "active" };

test("the API's retryable: false on a 503 is not retried", async () => {
  const { runtime, keys } = answering(() => refusal("host_start_failed_for_good", 503, false));
  const error = await runtime.me().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RuntimeError);
  expect((error as RuntimeError).retryable).toBe(false);
  expect((error as RuntimeError).sentRetryable).toBe(false);
  expect(keys.length).toBe(1);
});

test("the API's retryable: true on a 409 is retried after Retry-After with the same key", async () => {
  const { runtime, keys, at } = answering((call) =>
    call === 1 ? refusal("snapshot_not_ready", 409, true, 1) : Response.json(SANDBOX),
  );
  const sandbox = await runtime.sandboxes.create({}, { wait: false } as never);
  expect(sandbox.id).toBe("x");
  expect(keys.length).toBe(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);
  // Retry-After: 1, within the SDK's 10% jitter.
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(880);
}, 10_000);

test("a 429 that names an hour's wait is thrown at once, retryable, with that wait", async () => {
  for (const code of ["no_credit_daily_limit", "rate_limited"]) {
    const { runtime, keys } = answering(() => refusal(code, 429, true, 3600));
    const started = performance.now();
    const error = await runtime.sandboxes
      .create({}, { wait: false } as never)
      .catch((e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ code, retryable: true, retryAfterMs: 3_600_000 });
    expect(keys.length).toBe(1);
  }
});

test("an older server's answer, with no retryable, keeps the status rule", async () => {
  // A deliberate code at 503 (an older server) is not retried; a passing 503 is.
  const off = answering(() => refusal("feature_unavailable", 503, undefined));
  await expect(off.runtime.me()).rejects.toMatchObject({ retryable: false });
  expect(off.keys.length).toBe(1);
  const passing = answering((call) =>
    call === 1 ? refusal("host_unavailable", 503, undefined, 0.01) : Response.json({ id: "u" }),
  );
  await passing.runtime.me();
  expect(passing.keys.length).toBe(2);
  // And a 409 is never retried by status alone.
  const conflict = answering(() => refusal("snapshot_not_ready", 409, undefined, 1));
  await expect(conflict.runtime.me()).rejects.toMatchObject({ retryable: false });
  expect(conflict.keys.length).toBe(1);
});

test("the CLI says whether an error is retryable, and after how long", () => {
  const later = new RuntimeError({
    message: "Daily limit reached.",
    code: "no_credit_daily_limit",
    status: 429,
    retryAfterMs: 3_600_000,
    sentRetryable: true,
  });
  expect(describeError(later, false)).toContain("\nRetryable: yes, after 3600 s");
  expect(JSON.parse(describeError(later, true)).error).toMatchObject({
    retryable: true,
    retryAfterMs: 3_600_000,
  });
  const never = new RuntimeError({
    message: "Off here.",
    code: "feature_unavailable",
    status: 501,
    sentRetryable: false,
  });
  expect(describeError(never, false)).not.toContain("Retryable");
  const json = JSON.parse(describeError(never, true)).error;
  expect(json.retryable).toBe(false);
  expect("retryAfterMs" in json).toBe(false);
});
