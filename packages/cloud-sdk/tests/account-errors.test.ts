import { expect, test } from "bun:test";
import { AccountBlockedError, Runtime, RuntimeError, errorFor } from "../src/index";
import { run } from "../src/cli";

/* A blocked account gets its own error type (ARCHITECTURE.md section 11,
   "A blocked account is told why"), so code can tell it from an empty balance
   without reading the message. */
test("account_blocked becomes AccountBlockedError, keeps the server's words and is not retryable", () => {
  const error = errorFor(402, {
    error: {
      code: "account_blocked",
      message: "This account cannot spend: a payment on it is disputed with the card issuer.",
      requestId: "req_1",
    },
  });
  expect(error).toBeInstanceOf(AccountBlockedError);
  expect(error).toBeInstanceOf(RuntimeError);
  expect(error.code).toBe("account_blocked");
  expect(error.status).toBe(402);
  expect(error.message).toContain("disputed");
  expect(error.retryable).toBe(false);
});

test("an empty balance stays a plain RuntimeError", () => {
  const error = errorFor(402, { error: { code: "insufficient_funds", message: "Add credit." } });
  expect(error).not.toBeInstanceOf(AccountBlockedError);
  expect(error.code).toBe("insufficient_funds");
});

/* runtime.account.close() and `runtime account close` (ARCHITECTURE.md
   section 3.1): the account's name goes in the body, and nothing is sent
   until it is given. */
async function withStub(answer: unknown, work: (seen: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(
      `${request.method} ${new URL(request.url).pathname} ${request.method === "POST" ? await request.text() : ""}`.trim(),
    );
    return Response.json(answer);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}
const CLOSED = { orgId: "o1", name: "Acme", closedAt: "2026-09-25T20:00:00.000Z", released: false };

test("account.close() posts the typed name to POST /v1/account:close", async () => {
  await withStub(CLOSED, async (seen) => {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    expect(await runtime.account.close({ confirm: "Acme" })).toEqual(CLOSED);
    expect(seen).toEqual(['POST /v1/account:close {"confirm":"Acme"}']);
  });
});

test("`runtime account close` needs --confirm, and says the name to type", async () => {
  const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
  const lines: string[] = [];
  const out = {
    json: false,
    write: (t: string) => lines.push(t),
    error: (t: string) => lines.push(t),
  };
  await withStub(
    { orgId: "o1", principalId: "p1", credentialId: "c1", apiVersion: "0.2.0", orgName: "Acme" },
    async (seen) => {
      await expect(run(["account", "close"], env, out)).rejects.toThrow(
        'account close --confirm "Acme"',
      );
      expect(seen).toEqual(["GET /v1/me"]);
    },
  );
  lines.length = 0;
  await withStub(CLOSED, async (seen) => {
    expect(await run(["account", "close", "--confirm", "Acme"], env, out)).toBe(0);
    expect(lines.join("\n")).toContain("Closed Acme.");
    expect(seen).toEqual(['POST /v1/account:close {"confirm":"Acme"}']);
  });
});
