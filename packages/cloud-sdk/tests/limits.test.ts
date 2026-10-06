import { expect, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";

/* runtime.limits.get() and `runtime limits` against a stub API. The route is
   tested over Postgres in packages/cloud (limits-api.test.ts). */

const LIMITED = {
  access: "full",
  daily: {
    limitMicros: "25000000",
    usedMicros: "3100000",
    remainingMicros: "21900000",
    window: "24h",
  },
  trial: null,
};
const READ_ONLY = {
  access: "read",
  daily: { limitMicros: null, usedMicros: "0", remainingMicros: null, window: "24h" },
  trial: null,
};
const ON_TRIAL = {
  access: "full",
  daily: { limitMicros: null, usedMicros: "0", remainingMicros: null, window: "24h" },
  trial: {
    totalMs: 180_000_000,
    usedMs: 36_000_000,
    reservedMs: 3_600_000,
    availableMs: 140_400_000,
  },
};

async function withStub(body: unknown, work: (seen: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json(body);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}

const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
function output() {
  const lines: string[] = [];
  return {
    lines,
    out: { json: false, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}

test("limits.get() reads GET /v1/limits", async () => {
  await withStub(LIMITED, async (seen) => {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    const limits = await runtime.limits.get();
    expect(limits.daily.remainingMicros).toBe("21900000");
    expect(seen).toEqual(["GET /v1/limits"]);
  });
});

test("`runtime limits` prints the access, the daily limit and what is left, or the JSON with --json", async () => {
  await withStub(LIMITED, async () => {
    const { lines, out } = output();
    expect(await run(["limits"], env, out)).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/access\s+full: every product/);
    expect(text).toMatch(/daily limit\s+\$25\.00/);
    expect(text).toMatch(/used, last 24 hours\s+\$3\.10/);
    expect(text).toMatch(/left\s+\$21\.90/);
    const json: string[] = [];
    await run(["limits", "--json"], env, { ...out, json: true, write: (t) => json.push(t) });
    expect(JSON.parse(json[0]!)).toEqual(LIMITED);
  });
  await withStub(READ_ONLY, async () => {
    const { lines, out } = output();
    expect(await run(["limits"], env, out)).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/access\s+read only/);
    expect(text).toMatch(/daily limit\s+none/);
    expect(text).not.toMatch(/left/);
  });
});

test("`runtime limits` says the free time left: old free hours, or this month's included usage", async () => {
  await withStub(ON_TRIAL, async () => {
    const { lines, out } = output();
    expect(await run(["limits"], env, out)).toBe(0);
    expect(lines.join("\n")).toMatch(
      /free time\s+39 hours left \(50 free hours given before 5 October 2026, and the included usage\)$/m,
    );
  });
  const monthly = {
    ...ON_TRIAL,
    trial: {
      totalMs: 0,
      usedMs: 0,
      reservedMs: 0,
      availableMs: 675_000_000,
      offer: "monthly",
      renewsAt: "2026-11-01T00:00:00.000Z",
    },
  };
  await withStub(monthly, async () => {
    const { lines, out } = output();
    expect(await run(["limits"], env, out)).toBe(0);
    expect(lines.join("\n")).toMatch(
      /free time\s+187\.5 hours at 2 vCPU and 4 GiB left this month, renews 2026-11-01$/m,
    );
    expect(lines.join("\n")).not.toMatch(/of 0 hours/);
  });
  await withStub(LIMITED, async () => {
    const { lines, out } = output();
    expect(await run(["limits"], env, out)).toBe(0);
    expect(lines.join("\n")).not.toMatch(/free time/);
  });
});

test("`runtime limits` and `runtime whoami` say a pilot's sandboxes run free, and until when", async () => {
  const pilot = {
    id: "pilot-1",
    sandboxes: 1000,
    vcpu: 2,
    memoryMiB: 2048,
    diskMiB: 10240,
    startsAt: "2026-10-05T16:31:35Z",
    endsAt: "2026-10-12T16:00:00Z",
    graceEndsAt: "2026-10-13T16:00:00Z",
    endedAt: null,
    hours: 10_000,
    usedMs: 412.5 * 3_600_000,
    leftMs: 9_587.5 * 3_600_000,
  };
  await withStub({ ...LIMITED, available: "100000000", pilot }, async () => {
    const { lines, out } = output();
    expect(await run(["limits"], env, out)).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(
      /^pilot\s+a pilot: up to 1,000 sandboxes free, running until 2026-10-13 16:00 UTC; credit does not run it; to extend it, write to support$/m,
    );
    expect(text).toMatch(
      /^pilot sandbox hours\s+9,587\.5 of 10,000 left; new pilot sandboxes until 2026-10-12 16:00 UTC$/m,
    );
  });
  // With how many run (an API with 0414): how long the hours last at that rate.
  await withStub({ ...LIMITED, pilot: { ...pilot, running: 1000 } }, async () => {
    const { lines, out } = output();
    expect(await run(["limits"], env, out)).toBe(0);
    expect(lines.join("\n")).toMatch(
      /^pilot sandbox hours\s+9,587\.5 of 10,000 left; at 1,000 running, about 9\.6 hours; new pilot sandboxes until 2026-10-12 16:00 UTC$/m,
    );
  });
  await withStub(
    {
      orgId: "org-1",
      orgName: "Agents",
      principalId: "agent-1",
      apiVersion: "0.2.0",
      available: "100000000",
      pilot,
    },
    async () => {
      const { lines, out } = output();
      expect(await run(["whoami"], env, out)).toBe(0);
      expect(lines.join("\n")).toMatch(
        /^funding\s+a pilot: up to 1,000 sandboxes free, running until 2026-10-13 16:00 UTC; credit does not run it; to extend it, write to support; \$100\.00 of credit$/m,
      );
    },
  );
});

test("`runtime usage` counts every resource by kind when the API totals them, not the hundred newest", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({
    resourceId: `sb-${i}`,
    kind: "sandbox",
    chargedMicros: 0,
    heldMicros: 0,
  }));
  const usage = {
    unit: "microdollars",
    credited: "100000000",
    spent: "0",
    held: "0",
    expired: "0",
    available: "100000000",
    takenBack: "0",
    resources: hundred,
  };
  // An API that totals them: 1,000 sandboxes and the images behind them.
  await withStub(
    {
      ...usage,
      kinds: [
        { kind: "sandbox", resources: 1000, chargedMicros: "0", heldMicros: "0" },
        { kind: "image", resources: 2, chargedMicros: "1500", heldMicros: "0" },
      ],
    },
    async () => {
      const { lines, out } = output();
      expect(await run(["usage"], env, out)).toBe(0);
      const text = lines.join("\n");
      expect(text).toMatch(/^sandboxes\s+1,000\s+\$0\.0000\s+\$0\.0000$/m);
      expect(text).toMatch(/^images\s+2\s+\$0\.0015\s+\$0\.0000$/m);
    },
  );
  // An older API: the hundred it lists, as before.
  await withStub(usage, async () => {
    const { lines, out } = output();
    expect(await run(["usage"], env, out)).toBe(0);
    expect(lines.join("\n")).toMatch(/^sandboxes\s+100\s/m);
  });
});
