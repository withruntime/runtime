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
};
const READ_ONLY = {
  access: "read",
  daily: { limitMicros: null, usedMicros: "0", remainingMicros: null, window: "24h" },
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
