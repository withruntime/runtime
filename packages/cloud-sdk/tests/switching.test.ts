import { expect, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";

/* runtime.switching and `runtime compare` / `runtime switch` against a stub
   API. The routes are tested in packages/cloud (switching-api.test.ts). */

const SUMMARY = {
  enabled: true,
  maxMicros: "100000000",
  providers: ["e2b", "daytona", "vercel", "modal", "cloudflare", "fly"],
  eligible: true,
  switch: null as null | Record<string, unknown>,
};

const COMPARISON = {
  provider: "e2b",
  rival: {
    name: "E2B",
    checked: "2026-09-22",
    rates: ["$0.0504 per vCPU-hour", "$0.0162 per GiB-hour"],
    planFee: "Hobby $0; Pro $150 a month",
    sources: [{ label: "E2B pricing", url: "https://e2b.dev/pricing" }],
  },
  basis: "usage",
  window: { days: 30, from: "2026-08-24T12:00:00.000Z", to: "2026-09-23T12:00:00.000Z" },
  usage: {
    sandboxes: 1000,
    runSeconds: 60000,
    activeCpuSeconds: 20000,
    unpricedSandboxes: 0,
    trialSandboxes: 0,
    trialRunSeconds: 0,
  },
  runtimeMicros: "638889",
  rivalMicros: "2760000",
  savingMicros: "2121111",
  savingPercent: 76.9,
  perMonth: {
    fromDays: 3,
    runtimeMicros: "6388890",
    rivalMicros: "27600000",
    savingMicros: "21211110",
  },
  note: "The same sandboxes...",
  switching: SUMMARY,
};

async function withStub(
  answer: (request: Request) => unknown,
  work: (seen: string[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(
      `${request.method} ${url.pathname}${url.search}${request.method === "POST" ? ` ${await request.clone().text()}` : ""}`,
    );
    const body = answer(request);
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}

const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
function capture(json = false) {
  const lines: string[] = [];
  return {
    lines,
    out: { json, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}

test("switching.compare(), get() and record() call the routes", async () => {
  await withStub(
    (request) => (new URL(request.url).pathname === "/v1/usage/compare" ? COMPARISON : SUMMARY),
    async (seen) => {
      const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
      expect((await runtime.switching.compare({ provider: "e2b" })).savingMicros).toBe("2121111");
      await runtime.switching.compare({ provider: "modal", days: 7 });
      await runtime.switching.get();
      await runtime.switching.record({ provider: "daytona" });
      expect(seen).toEqual([
        "GET /v1/usage/compare?provider=e2b",
        "GET /v1/usage/compare?provider=modal&days=7",
        "GET /v1/switching",
        'POST /v1/switching {"provider":"daytona"}',
      ]);
    },
  );
});

test("`runtime compare --from e2b` says what the month saves, and how to claim the credit", async () => {
  await withStub(
    () => COMPARISON,
    async (seen) => {
      const { lines, out } = capture();
      expect(await run(["compare", "--from", "E2B"], env, out)).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain(
        "Your last 30 days: $0.6389 on Runtime; the same sandboxes on E2B: $2.76; you save $2.12 (76.9%). Your usage so far covers 3 days; at that pace, a saving of about $21.21 a month.",
      );
      expect(text).toContain("Priced: 1,000 sandboxes, 16.67 hours running.");
      expect(text).toContain("E2B's published rates, checked 22 September 2026:");
      expect(text).toContain(
        "Switching from E2B? Run `runtime switch --from e2b` before your first top-up and we match that top-up, up to $100.00.",
      );
      expect(seen).toEqual(["GET /v1/usage/compare?provider=e2b"]);

      const json = capture(true);
      await run(["compare", "--from", "e2b", "--days", "14", "--json"], env, json.out);
      expect(JSON.parse(json.lines[0]!)).toEqual(COMPARISON);
      expect(seen.at(-1)).toBe("GET /v1/usage/compare?provider=e2b&days=14");
    },
  );
});

test("`runtime compare` is honest when the rival costs less, and when it prices an example", async () => {
  const dearer = {
    ...COMPARISON,
    savingMicros: "-1500000",
    savingPercent: -12.5,
    perMonth: { ...COMPARISON.perMonth, savingMicros: "-3000000" },
    switching: { ...SUMMARY, eligible: false },
  };
  await withStub(
    () => dearer,
    async () => {
      const { lines, out } = capture();
      await run(["compare", "--from", "e2b"], env, out);
      const text = lines.join("\n");
      expect(text).toContain(
        "E2B would cost $1.50 less (12.5%). Your usage so far covers 3 days; at that pace, about $3.00 a month more on Runtime.",
      );
      expect(text).not.toContain("switch --from");
    },
  );
  const example = { ...COMPARISON, basis: "example", perMonth: null };
  await withStub(
    () => example,
    async () => {
      const { lines, out } = capture();
      await run(["compare", "--from", "e2b"], env, out);
      const text = lines.join("\n");
      expect(text).toContain(
        "No settled sandboxes in your last 30 days yet, so this prices an example: 1,000 runs of 60 seconds using 20 CPU-seconds each.",
      );
      expect(text).toContain("The example: $0.6389 on Runtime; the same sandboxes on E2B: $2.76;");
    },
  );
});

test("`runtime switch --from e2b` records it; `runtime switch` shows where it stands", async () => {
  const recorded = {
    ...SUMMARY,
    eligible: false,
    switch: {
      provider: "e2b",
      status: "pending",
      refusedReason: null,
      recordedAt: "2026-09-23T12:00:00.000Z",
      creditMicros: "0",
    },
  };
  await withStub(
    () => recorded,
    async (seen) => {
      const { lines, out } = capture();
      expect(await run(["switch", "--from", "e2b"], env, out)).toBe(0);
      expect(lines.join("\n")).toBe(
        "Recorded: switching from E2B. This organization's switch from E2B was recorded on 23 September 2026: its first top-up is matched, up to $100.00, once the payment settles.",
      );
      expect(seen).toEqual(['POST /v1/switching {"provider":"e2b"}']);
    },
  );
  await withStub(
    () => ({
      ...recorded,
      switch: { ...recorded.switch, status: "paid", creditMicros: "40000000" },
    }),
    async (seen) => {
      const { lines, out } = capture();
      await run(["switch"], env, out);
      expect(lines.join("\n")).toBe(
        "This organization's switch from E2B was recorded on 23 September 2026 and matched its first top-up: $40.00 of credit.",
      );
      expect(seen).toEqual(["GET /v1/switching"]);
    },
  );
  await withStub(
    () => SUMMARY,
    async () => {
      const { out } = capture();
      await expect(run(["switch", "--from", "aws"], env, out)).rejects.toThrow(
        "Unknown provider aws",
      );
      await expect(run(["compare"], env, out)).rejects.toThrow("Name the rival");
      await expect(run(["compare", "--from", "e2b", "--vcpu", "2"], env, out)).rejects.toThrow(
        "Unknown option --vcpu",
      );
    },
  );
});

test("`runtime compare --from daytona` names a switch already recorded from E2B, with its date, and changes nothing", async () => {
  const switched = {
    ...COMPARISON,
    provider: "daytona",
    rival: { ...COMPARISON.rival, name: "Daytona" },
    switching: {
      ...SUMMARY,
      eligible: false,
      switch: {
        provider: "e2b",
        status: "pending",
        refusedReason: null,
        recordedAt: "2026-09-23T08:15:00.000Z",
        creditMicros: "0",
      },
    },
  };
  await withStub(
    () => switched,
    async (seen) => {
      const { lines, out } = capture();
      expect(await run(["compare", "--from", "daytona"], env, out)).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain(
        "This organization's switch from E2B was recorded on 23 September 2026: its first top-up is matched, up to $100.00, once the payment settles. A switch is recorded once, so it stays E2B, not Daytona.",
      );
      expect(text).not.toContain("Your switch from");
      // Comparing only reads: nothing is recorded.
      expect(seen).toEqual(["GET /v1/usage/compare?provider=daytona"]);
    },
  );
});

test("`runtime compare` says which sandboxes the free trial paid for, and that they are priced at the standard rates", async () => {
  const trial = {
    ...COMPARISON,
    usage: { ...COMPARISON.usage, sandboxes: 70, trialSandboxes: 70, trialRunSeconds: 60000 },
  };
  await withStub(
    () => trial,
    async () => {
      const { lines, out } = capture();
      await run(["compare", "--from", "e2b"], env, out);
      expect(lines.join("\n")).toContain(
        "Priced: 70 sandboxes, 16.67 hours running. All of them ran on the free trial, which charged nothing; Runtime's side prices them at the standard rates, what the same work costs on paid credit.",
      );
    },
  );
  await withStub(
    () => ({ ...trial, usage: { ...trial.usage, trialSandboxes: 3 } }),
    async () => {
      const { lines, out } = capture();
      await run(["compare", "--from", "e2b"], env, out);
      expect(lines.join("\n")).toContain(
        "3 of them, 16.67 hours of that time, ran on the free trial",
      );
    },
  );
});

test("`runtime compare` never shows a short trial test as $0 or 0 hours", async () => {
  // One trial sandbox of 2 vCPU and 512 MiB for 10 seconds, 2 CPU-seconds used:
  // 25 microdollars on Runtime's side, 302 at Daytona's rates.
  const short = {
    ...COMPARISON,
    provider: "daytona",
    rival: { ...COMPARISON.rival, name: "Daytona" },
    usage: {
      ...COMPARISON.usage,
      sandboxes: 1,
      runSeconds: 10,
      activeCpuSeconds: 2,
      trialSandboxes: 1,
      trialRunSeconds: 10,
    },
    runtimeMicros: "25",
    rivalMicros: "302",
    savingMicros: "277",
    savingPercent: 91.7,
    perMonth: { fromDays: 1, runtimeMicros: "750", rivalMicros: "9060", savingMicros: "8310" },
  };
  await withStub(
    () => short,
    async () => {
      const { lines, out } = capture();
      await run(["compare", "--from", "daytona"], env, out);
      const text = lines.join("\n");
      expect(text).toContain(
        "Your last 30 days: $0.000025 on Runtime; the same sandboxes on Daytona: $0.0003; you save $0.0003 (91.7%).",
      );
      expect(text).toContain("Priced: 1 sandbox, 10 seconds running. It ran on the free trial");
      expect(text).not.toMatch(/\$0\.0+(?!\d)/);
    },
  );
  await withStub(
    () => ({ ...short, usage: { ...short.usage, runSeconds: 90, trialRunSeconds: 90 } }),
    async () => {
      const { lines, out } = capture();
      await run(["compare", "--from", "daytona"], env, out);
      expect(lines.join("\n")).toContain("1 sandbox, 1.5 minutes running.");
    },
  );
});
