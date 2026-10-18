import { expect, test } from "bun:test";
import { billingCommand } from "../src/billing-cli";
import { run } from "../src/cli";
import { Runtime } from "../src/client";
import type { AutoTopUp, Topup } from "../src/products/billing";

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
  const rekeyed: string[] = [];
  let i = 0;
  return {
    saved,
    opened,
    rekeyed,
    deps: {
      open: async (input: { usd: number; acceptTerms: boolean }) => {
        opened.push(input);
        return { ...OPEN, orgId: "org_1", claimCode: "rtclaim_code" };
      },
      claim: async () => claims[Math.min(i++, claims.length - 1)] as never,
      rekey: async (code: string) => {
        rekeyed.push(code);
        return {
          status: "replaced" as const,
          orgId: "org_1",
          apiKey: "rtcloud_new",
          revokedKeyId: "key_old",
        };
      },
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

test("claim --new-key replaces a lost key, saves the new one, and never prints it", async () => {
  const stub = walletStub([]);
  const { lines, out } = capture();
  const code = await billingCommand(
    ["claim", "rtclaim_code"],
    { positional: ["claim", "rtclaim_code"], flags: flags("new-key") },
    out,
    noClient,
    async () => undefined,
    stub.deps,
  );
  expect(code).toBe(0);
  expect(stub.rekeyed).toEqual(["rtclaim_code"]);
  expect(stub.saved).toEqual([{ key: "rtcloud_new", orgId: "org_1" }]);
  expect(lines.join("\n")).not.toContain("rtcloud_new");
  expect(lines.join("\n")).toContain("Every other key of this account no longer works");
});

test("--new-key is only for claim, and needs the code", async () => {
  const stub = walletStub([]);
  const { out } = capture();
  const call = (positional: string[]) =>
    billingCommand(
      positional,
      { positional, flags: flags("new-key") },
      out,
      noClient,
      async () => undefined,
      stub.deps,
    );
  await expect(call(["claim"])).rejects.toThrow("Give the claim code");
  await expect(call(["topup", "20"])).rejects.toThrow();
  expect(stub.rekeyed).toEqual([]);
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

test("claim --wait stops at once when the top-up has no address, and says to send it again", async () => {
  const next =
    "This top-up has no address to pay to yet. Send the same POST /api/wallet/topups again with this claimCode to get one; no second account opens.";
  const topup = {
    purchaseId: "p_1",
    status: "open" as const,
    amountUsd: "20.00",
    amount: "20.000000",
    payBy: null,
    networks: [],
  };
  const stub = walletStub([{ status: "open", orgId: "org_1", topup, next }]);
  const { lines, out } = capture();
  expect(
    await billingCommand(
      ["claim", "rtclaim_code"],
      { positional: ["claim", "rtclaim_code"], flags: flags("wait") },
      out,
      noClient,
      undefined,
      stub.deps,
    ),
  ).toBe(1);
  expect(lines.join("\n")).toBe(next);
  expect(stub.saved).toHaveLength(0);
});

const AUTO: AutoTopUp = {
  enabled: true,
  waitingForCard: false,
  below: 5,
  amount: 20,
  monthlyLimit: 100,
  thisMonth: 20,
  card: true,
  offReason: null,
  offAt: null,
  saveCardAt: null,
};

test("billing.autoTopUp reads, sets and turns off, each to its own route", async () => {
  await withStub([AUTO as unknown as Topup], async (seen) => {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    expect(await runtime.billing.autoTopUp.get()).toEqual(AUTO);
    const input = { enabled: true, below: 5, amount: 20, monthlyLimit: 100 };
    await runtime.billing.autoTopUp.set(input, { idempotencyKey: "k2" });
    await runtime.billing.autoTopUp.off();
    expect(seen.map((s) => s.line)).toEqual([
      "GET /v1/billing/auto-top-up",
      "PUT /v1/billing/auto-top-up",
      "DELETE /v1/billing/auto-top-up",
    ]);
    expect(seen[1]!.body).toEqual(input);
    expect(seen[1]!.key).toBe("k2");
  });
});

test("`runtime billing auto-top-up on` sends the three figures; show and off say where it stands", async () => {
  const waiting = {
    ...AUTO,
    enabled: false,
    waitingForCard: true,
    card: false,
    saveCardAt: "https://withruntime.com/account/billing#auto-top-up",
  };
  await withStub([waiting as unknown as Topup], async (seen) => {
    const { lines, out } = capture();
    expect(
      await run(
        ["billing", "auto-top-up", "on", "--below", "15", "--amount", "$20", "--monthly", "100"],
        env,
        out,
      ),
    ).toBe(0);
    expect(seen[0]).toMatchObject({
      line: "PUT /v1/billing/auto-top-up",
      body: { enabled: true, below: 15, amount: 20, monthlyLimit: 100 },
    });
    expect(lines.join("\n")).toContain("turns on once a card is saved");
    expect(lines.join("\n")).toContain("withruntime.com/account/billing");
  });
  // Figures not given are left out: the server keeps the saved ones, or its defaults.
  await withStub([waiting as unknown as Topup], async (seen) => {
    const { out } = capture();
    expect(await run(["billing", "auto-top-up", "on"], env, out)).toBe(0);
    expect(seen[0]!.body).toEqual({ enabled: true });
  });
  await withStub([waiting as unknown as Topup], async (seen) => {
    const { out } = capture();
    expect(await run(["billing", "auto-top-up", "on", "--amount", "50"], env, out)).toBe(0);
    expect(seen[0]!.body).toEqual({ enabled: true, amount: 50 });
  });
  const off = { ...AUTO, enabled: false, offReason: "declined" as const };
  await withStub([off as unknown as Topup], async (seen) => {
    const { lines, out } = capture();
    expect(await run(["billing", "auto-top-up", "off"], env, out)).toBe(0);
    expect(seen[0]!.line).toBe("DELETE /v1/billing/auto-top-up");
    expect(lines.join("\n")).toContain("the bank declined the last charge");
  });
  await withStub([AUTO as unknown as Topup], async (seen) => {
    const { lines, out } = capture(true);
    expect(await run(["billing", "auto-top-up"], env, out)).toBe(0);
    expect(seen[0]!.line).toBe("GET /v1/billing/auto-top-up");
    expect(JSON.parse(lines[0]!)).toEqual(AUTO);
  });
});

test("`runtime billing auto-top-up` refuses a figure that is not dollars, an unknown verb, and figures elsewhere", async () => {
  const { out } = capture();
  for (const bad of ["ten", "0", "$"])
    await expect(
      run(["billing", "auto-top-up", "on", "--below", "10", "--monthly", bad], env, out),
    ).rejects.toThrow("--monthly");
  await expect(run(["billing", "auto-top-up", "maybe"], env, out)).rejects.toThrow(
    "show, on or off",
  );
  await expect(run(["billing", "topup", "20", "--below", "5"], env, out)).rejects.toThrow(
    "billing auto-top-up on",
  );
});
