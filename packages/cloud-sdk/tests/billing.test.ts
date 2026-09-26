import { expect, test } from "bun:test";
import { billingCommand } from "../src/billing-cli";
import { run } from "../src/cli";
import { Runtime } from "../src/client";
import type { Topup } from "../src/products/billing";

/* runtime.billing and `runtime billing` against a stub API. */

const OPEN: Topup = {
  purchaseId: "3f0c2a4e-1b7d-4c5a-9e2f-0a1b2c3d4e5f",
  status: "open",
  amountUsd: "20.00",
  amount: "20.000000",
  payBy: new Date(Date.now() + 60 * 60_000).toISOString(),
  networks: [
    {
      network: "base",
      address: "0xbase_address",
      tokens: [{ currency: "usdc", contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
    },
  ],
};

async function withStub(
  answers: Topup[],
  work: (seen: { line: string; body: unknown; key: string | null }[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: { line: string; body: unknown; key: string | null }[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    seen.push({
      line: `${request.method} ${new URL(request.url).pathname}`,
      body: text ? JSON.parse(text) : null,
      key: request.headers.get("idempotency-key"),
    });
    return Response.json(answers[Math.min(i++, answers.length - 1)]);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}

test("billing.topup() posts the dollars; topupStatus() reads the top-up", async () => {
  await withStub([OPEN], async (seen) => {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    expect(await runtime.billing.topup({ usd: 20 }, { idempotencyKey: "k1" })).toEqual(OPEN);
    await runtime.billing.topupStatus(OPEN.purchaseId);
    expect(seen.map((s) => s.line)).toEqual([
      "POST /v1/billing/topups",
      `GET /v1/billing/topups/${OPEN.purchaseId}`,
    ]);
    expect(seen[0]!.body).toEqual({ usd: 20 });
    expect(seen[0]!.key).toBe("k1");
  });
});

const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const capture = (json = false) => {
  const lines: string[] = [];
  return {
    lines,
    out: { json, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
};

test("`runtime billing topup 20` prints the address and the exact amount", async () => {
  await withStub([OPEN], async (seen) => {
    const { lines, out } = capture();
    expect(await run(["billing", "topup", "20"], env, out)).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Send exactly 20.000000");
    expect(text).toContain("0xbase_address");
    expect(text).toContain("USDC");
    expect(text).toContain("cannot be matched or returned automatically");
    expect(seen[0]!.body).toEqual({ usd: 20 });
  });
});

test("`runtime billing topup` refuses a missing amount and an unknown option", async () => {
  const { out } = capture();
  await expect(run(["billing", "topup"], env, out)).rejects.toThrow("how many dollars");
  await expect(run(["billing", "topup", "20", "--usdc"], env, out)).rejects.toThrow("--usdc");
});

test("--wait checks until the credit lands", async () => {
  const pending = { ...OPEN, status: "pending" as const };
  const paid = { ...OPEN, status: "paid" as const };
  await withStub([OPEN, pending, paid], async (seen) => {
    const { lines, out } = capture();
    const naps: number[] = [];
    const code = await billingCommand(
      ["topup", "20", "--wait"],
      { positional: ["topup", "20"], flags: new Map([["wait", ["true"]]]) },
      out,
      async () => new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" }),
      async (ms) => {
        naps.push(ms);
      },
    );
    expect(code).toBe(0);
    expect(naps).toEqual([10_000, 10_000]);
    expect(lines.at(-1)).toContain("Paid: $20.00");
    expect(seen).toHaveLength(3);
  });
});

test("--json prints the top-up as the API returned it", async () => {
  await withStub([OPEN], async () => {
    const { lines, out } = capture(true);
    await run(["billing", "status", OPEN.purchaseId, "--json"], env, out);
    expect(JSON.parse(lines[0]!)).toEqual(OPEN);
  });
});

/* An account with no key: `billing topup --new-account` and `billing claim`. */
function walletStub(claims: unknown[]) {
  const saved: { key: string; orgId: string }[] = [];
  const opened: unknown[] = [];
  let i = 0;
  return {
    saved,
    opened,
    deps: {
      open: async (input: { usd: number; acceptTerms: boolean }) => {
        opened.push(input);
        return { ...OPEN, orgId: "org_1", claimCode: "rtclaim_code" };
      },
      claim: async () => claims[Math.min(i++, claims.length - 1)] as never,
      save: async (key: string, orgId: string) => {
        saved.push({ key, orgId });
      },
    },
  };
}
const noClient = async () => {
  throw new Error("a wallet command must not need a key");
};
const flags = (...names: string[]) => new Map(names.map((name) => [name, ["true"]]));

test("--new-account needs --accept-terms, and prints the claim code once", async () => {
  const stub = walletStub([]);
  const { lines, out } = capture();
  await expect(
    billingCommand(
      ["topup", "20", "--new-account"],
      { positional: ["topup", "20"], flags: flags("new-account") },
      out,
      noClient,
      undefined,
      stub.deps,
    ),
  ).rejects.toThrow("--accept-terms");
  expect(stub.opened).toHaveLength(0);
  expect(
    await billingCommand(
      ["topup", "20"],
      { positional: ["topup", "20"], flags: flags("new-account", "accept-terms") },
      out,
      noClient,
      undefined,
      stub.deps,
    ),
  ).toBe(0);
  expect(stub.opened).toEqual([{ usd: 20, acceptTerms: true }]);
  const text = lines.join("\n");
  expect(text).toContain("Send exactly 20.000000");
  expect(text).toContain("Claim code (shown once, keep it secret): rtclaim_code");
});

test("claim --wait saves the key once the payment lands, and never prints it", async () => {
  const stub = walletStub([
    { status: "open", orgId: "org_1", topup: null },
    { status: "pending", orgId: "org_1", topup: null },
    { status: "paid", orgId: "org_1", apiKey: "rtcloud_secret" },
  ]);
  const { lines, out } = capture();
  const code = await billingCommand(
    ["claim", "rtclaim_code"],
    { positional: ["claim", "rtclaim_code"], flags: flags("wait") },
    out,
    noClient,
    async () => undefined,
    stub.deps,
  );
  expect(code).toBe(0);
  expect(stub.saved).toEqual([{ key: "rtcloud_secret", orgId: "org_1" }]);
  expect(lines.join("\n")).not.toContain("rtcloud_secret");
  expect(lines.at(-1)).toContain("connected");
});

test("claim without --wait says it is not paid yet", async () => {
  const stub = walletStub([{ status: "open", orgId: "org_1", topup: null }]);
  const { lines, out } = capture();
  expect(
    await billingCommand(
      ["claim", "rtclaim_code"],
      { positional: ["claim", "rtclaim_code"], flags: new Map() },
      out,
      noClient,
      undefined,
      stub.deps,
    ),
  ).toBe(0);
  expect(lines.join("\n")).toContain("Not paid yet (open)");
  expect(stub.saved).toHaveLength(0);
});
