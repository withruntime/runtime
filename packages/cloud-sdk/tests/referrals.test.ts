import { expect, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";

/* runtime.referrals.get() and `runtime referrals` against a stub API. */

const SUMMARY = {
  code: "k7m2q9xd",
  link: "https://withruntime.com/r/k7m2q9xd",
  rewardMicros: "25000000",
  maxRewardMicros: "1000000000",
  minPurchaseMicros: "10000000",
  yearlyCapMicros: "50000000000",
  enabled: true,
  year: 2026,
  signedUp: 3,
  pending: 1,
  paid: 2,
  capped: 0,
  reversed: 0,
  earnedMicros: "50000000",
  earnedThisYearMicros: "50000000",
  capRemainingMicros: "49950000000",
  referredBy: null,
  payingCompanies: 2,
  shareEarnedMicros: "0",
  shareBasisPoints: 1000,
  shareMonths: 12,
  windowDays: 30,
};

async function withStub(work: (seen: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? "" : ` ${await request.text()}`;
    seen.push(`${request.method} ${decodeURIComponent(new URL(request.url).pathname)}${body}`);
    return Response.json(SUMMARY);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}

test("referrals.get() reads GET /v1/referrals", async () => {
  await withStub(async (seen) => {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    const summary = await runtime.referrals.get();
    expect(summary.link).toBe(SUMMARY.link);
    expect(seen).toEqual(["GET /v1/referrals"]);
  });
});

test("`runtime referrals` prints the link and what it earned, or the JSON with --json", async () => {
  const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
  await withStub(async () => {
    const lines: string[] = [];
    const out = {
      json: false,
      write: (t: string) => lines.push(t),
      error: (t: string) => lines.push(t),
    };
    expect(await run(["referrals"], env, out)).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Your link: https://withruntime.com/r/k7m2q9xd");
    expect(text).toContain("first 30 days matched, up to $1,000.00");
    expect(text).toContain("$10.00 or more gives each of you at least $25.00");
    expect(text).toContain("for 12 months you earn 10% of what it spends");
    expect(text).toContain("$50,000.00 a year");
    expect(text).toMatch(/paying\s+2/);
    expect(text).toMatch(/earned\s+\$50\.00/);
    expect(text).toMatch(/left this year \(2026\)\s+\$49,950\.00/);
    // Marc, 10 October 2026: the link's page never names the company, so
    // the CLI says nothing about it.
    expect(text).not.toContain("invite page");

    const json: string[] = [];
    await run(["referrals", "--json"], env, { ...out, json: true, write: (t) => json.push(t) });
    expect(JSON.parse(json[0]!)).toEqual(SUMMARY);
  });
});

test("`runtime referrals` takes no --show-name, and the SDK has no referrals.update", async () => {
  const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
  await withStub(async (seen) => {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    expect(Object.keys(runtime.referrals)).toEqual(["get"]);
    const out = { json: false, write: () => {}, error: () => {} };
    await expect(run(["referrals", "--show-name", "off"], env, out)).rejects.toThrow(/show-name/);
    expect(seen).toEqual([]);
  });
});
