import { expect, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";
import type { PlanNow, Plans } from "../src/products/plans";

/* runtime.plans and `runtime plans` against a stub API. The figures are a
 * test's, not Marc's plans. */

const NOW: PlanNow = {
  planId: "team",
  name: "Team",
  status: "active",
  interval: "month",
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  nextPlanId: null,
  startedAt: "2026-09-01T00:00:00.000Z",
  addOns: [{ id: "extra-seats", quantity: 1, endsAt: null }],
  autoUpgrade: false,
  planUsage: {
    grantedMicros: "550000000",
    leftMicros: "412500000",
    expiresAt: "2026-11-01T00:00:00.000Z",
  },
};

const PLANS: Plans = {
  current: NOW,
  plans: [
    {
      id: "pro",
      name: "Pro",
      card: "pro",
      feeMicros: "50000000",
      yearlyFeeMicros: "500000000",
      bonusMicros: "0",
      trialDays: 14,
      firstPeriodDouble: true,
      support: "agent",
      collection: "card",
      contract: false,
      position: 1,
      included: [{ product: "apps", meter: "egress", quantity: 100, unit: "GB" }],
      limits: [],
      features: [],
      addOns: [],
    },
    {
      id: "team",
      name: "Team",
      card: "team",
      feeMicros: "500000000",
      yearlyFeeMicros: null,
      bonusMicros: "50000000",
      trialDays: 0,
      firstPeriodDouble: false,
      support: "slack",
      collection: "card",
      contract: false,
      position: 2,
      included: [],
      limits: [
        { limit: "sandbox.count", max: 200 },
        { limit: "sandbox.memory", max: null },
      ],
      features: ["sso"],
      addOns: [
        {
          id: "extra-seats",
          name: "Extra seats",
          feeMicros: "20000000",
          limits: [{ limit: "member.count", add: 10 }],
          feature: null,
        },
      ],
    },
  ],
};

async function withStub(
  answer: (path: string) => unknown,
  work: (seen: string[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = request.method === "GET" ? "" : await request.text();
    const body = text ? ` ${text}` : "";
    seen.push(`${request.method} ${path}${body}`);
    return Response.json(answer(path));
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}

function capture(json = false) {
  const lines: string[] = [];
  return {
    lines,
    out: { json, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}

const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };

test("runtime.plans reads and changes through /v1/plans", async () => {
  await withStub(
    (path) => (path === "/v1/plans" ? PLANS : { checkoutUrl: null, current: NOW }),
    async (seen) => {
      const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
      const listed = await runtime.plans.list();
      expect(listed.current?.planUsage?.leftMicros).toBe("412500000");
      expect(listed.plans[1]?.addOns[0]?.limits).toEqual([{ limit: "member.count", add: 10 }]);
      expect((await runtime.plans.choose("pro")).current?.planId).toBe("team");
      await runtime.plans.choose("pro", { interval: "year", idempotencyKey: "k-1" });
      await runtime.plans.cancel();
      await runtime.plans.resume();
      await runtime.plans.addOn("extra-seats");
      await runtime.plans.removeAddOn("extra-seats");
      await runtime.plans.autoUpgrade(true);
      expect(seen).toEqual([
        "GET /v1/plans",
        'POST /v1/plans/choose {"plan":"pro"}',
        'POST /v1/plans/choose {"plan":"pro","interval":"year"}',
        "POST /v1/plans/cancel {}",
        "POST /v1/plans/resume {}",
        'POST /v1/plans/add-ons {"addOn":"extra-seats"}',
        "DELETE /v1/plans/add-ons/extra-seats",
        'PUT /v1/plans/auto-upgrade {"on":true}',
      ]);
    },
  );
});

test("every plan change sends an Idempotency-Key, the caller's when given", async () => {
  const original = globalThis.fetch;
  const keys: (string | null)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Request(input, init).headers.get("idempotency-key"));
    return Response.json({ checkoutUrl: null, current: NOW });
  }) as typeof fetch;
  try {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    await runtime.plans.choose("pro", { interval: "year", idempotencyKey: "k-1" });
    await runtime.plans.addOn("extra-seats");
    await runtime.plans.removeAddOn("extra-seats");
    await runtime.plans.autoUpgrade(false);
    expect(keys[0]).toBe("k-1");
    for (const key of keys.slice(1)) expect(key).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    globalThis.fetch = original;
  }
});

test("`runtime plans` prints yours and the catalogue, or the JSON with --json", async () => {
  await withStub(
    () => PLANS,
    async () => {
      const { lines, out } = capture();
      expect(await run(["plans"], env, out)).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("Your plan: Team (team), active, monthly.");
      expect(text).toContain("Next fee on 2026-11-01.");
      expect(text).toContain("Plan usage left: $412.50 of $550.00, until 2026-11-01.");
      expect(text).toContain("Add-ons: extra-seats.");
      expect(text).toContain("Auto-upgrade: off.");
      expect(text).toMatch(/pro\s+Pro\s+\$50\.00\s+\$500\.00\s+-\s+14 days\s+agent/);
      expect(text).toMatch(/team\s+Team\s+\$500\.00\s+-\s+\$50\.00\s+-\s+slack/);
      expect(text).toContain("includes 100 GB of apps egress a month");
      expect(text).toContain("limits sandbox.count 200, sandbox.memory unlimited");
      expect(text).toContain("add-ons extra-seats ($20.00 a month)");
      expect(text).toContain("plans choose <plan> [--yearly]");

      const json = capture(true);
      expect(await run(["plans", "--json"], env, json.out)).toBe(0);
      expect(JSON.parse(json.lines.join(""))).toEqual(PLANS);
    },
  );
});

test("`runtime plans` shows a trial, a yearly plan and auto-upgrade on", async () => {
  await withStub(
    () => ({
      current: {
        ...NOW,
        status: "trialing",
        interval: "year",
        trialEndsAt: "2026-10-15T00:00:00.000Z",
        autoUpgrade: true,
        addOns: [{ id: "extra-seats", quantity: 2, endsAt: "2026-11-01T00:00:00.000Z" }],
        planUsage: null,
      },
      plans: [],
    }),
    async () => {
      const { lines, out } = capture();
      expect(await run(["plans", "ls"], env, out)).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("Your plan: Team (team), trialing, yearly.");
      // A trial saved a card: when it is charged, and how to stop it.
      expect(text).toContain(
        "The trial ends on 2026-10-15, when its card is charged the first period; `runtime plans cancel` before then charges nothing.",
      );
      expect(text).toContain("Add-ons: extra-seats x2 (ends 2026-11-01).");
      expect(text).toContain("Auto-upgrade: on;");
      expect(text).not.toContain("Plan usage left");
    },
  );
});

test("`runtime plans` with no plan says the account pays for what runs", async () => {
  await withStub(
    () => ({ current: null, plans: [] }),
    async () => {
      const { lines, out } = capture();
      expect(await run(["plans"], env, out)).toBe(0);
      expect(lines.join("\n")).toContain("No plan: you pay for what runs from your credit.");
      expect(lines.join("\n")).toContain("No plans are offered yet.");
    },
  );
});

test("`runtime plans choose` prints the payment page for a first plan", async () => {
  await withStub(
    () => ({
      checkoutUrl: "https://withruntime.com/account/billing?plan=pro#plans",
      current: null,
    }),
    async (seen) => {
      const { lines, out } = capture();
      expect(await run(["plans", "choose", "pro"], env, out)).toBe(0);
      expect(lines.join("\n")).toContain(
        "A person chooses it and pays the first month here, then the plan starts:\nhttps://withruntime.com/account/billing?plan=pro#plans",
      );
      expect(seen).toEqual(['POST /v1/plans/choose {"plan":"pro"}']);
    },
  );
});

test("`runtime plans choose --yearly`, add-ons and auto-upgrade send their change", async () => {
  await withStub(
    () => ({ checkoutUrl: null, current: { ...NOW, autoUpgrade: true } }),
    async (seen) => {
      const yearly = capture();
      expect(await run(["plans", "choose", "team", "--yearly"], env, yearly.out)).toBe(0);
      expect(yearly.lines.join("\n")).toContain("Your plan: Team (team), active, monthly.");
      expect(await run(["plans", "add-on", "extra-seats"], env, capture().out)).toBe(0);
      expect(await run(["plans", "remove-add-on", "extra-seats"], env, capture().out)).toBe(0);
      const on = capture();
      expect(await run(["plans", "auto-upgrade", "on"], env, on.out)).toBe(0);
      expect(on.lines.join("\n")).toContain("Auto-upgrade: on;");
      expect(await run(["plans", "auto-upgrade", "off"], env, capture().out)).toBe(0);
      expect(seen).toEqual([
        'POST /v1/plans/choose {"plan":"team","interval":"year"}',
        'POST /v1/plans/add-ons {"addOn":"extra-seats"}',
        "DELETE /v1/plans/add-ons/extra-seats",
        'PUT /v1/plans/auto-upgrade {"on":true}',
        'PUT /v1/plans/auto-upgrade {"on":false}',
      ]);
    },
  );
});

test("`runtime plans cancel` and `resume` say when the plan ends or that it goes on", async () => {
  await withStub(
    (path) => ({
      checkoutUrl: null,
      current: { ...NOW, cancelAtPeriodEnd: path.endsWith("/cancel") },
    }),
    async (seen) => {
      const cancel = capture();
      expect(await run(["plans", "cancel"], env, cancel.out)).toBe(0);
      expect(cancel.lines.join("\n")).toContain("It ends on 2026-11-01;");
      expect(cancel.lines.join("\n")).toContain("plans resume` keeps it.");
      const resume = capture();
      expect(await run(["plans", "resume"], env, resume.out)).toBe(0);
      expect(resume.lines.join("\n")).toContain("Next fee on 2026-11-01.");
      expect(seen).toEqual(["POST /v1/plans/cancel {}", "POST /v1/plans/resume {}"]);
    },
  );
});

test("`runtime plans` refuses a missing plan and an unknown verb before calling", async () => {
  await withStub(
    () => PLANS,
    async (seen) => {
      await expect(run(["plans", "choose"], env, capture().out)).rejects.toThrow(
        "Say which plan: runtime plans choose <plan>.",
      );
      await expect(run(["plans", "upgrade"], env, capture().out)).rejects.toThrow(
        "Unknown plans command upgrade",
      );
      await expect(run(["plans", "add-on"], env, capture().out)).rejects.toThrow(
        "Say which add-on: runtime plans add-on <id>.",
      );
      await expect(run(["plans", "auto-upgrade", "maybe"], env, capture().out)).rejects.toThrow(
        "Say on or off: runtime plans auto-upgrade on|off.",
      );
      await expect(run(["plans", "cancel", "--yearly"], env, capture().out)).rejects.toThrow(
        "--yearly goes with plans choose <plan>.",
      );
      expect(seen).toEqual([]);
    },
  );
});
