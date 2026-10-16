import { expect, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";

/* runtime.networks.private and `runtime networks private on|off|status` against
 * a stub API. The routes are tested on Postgres in packages/cloud
 * (private-network-api-postgres.test.ts), and the connections themselves in
 * private-mesh.test.ts. */

const STATE = {
  suffix: "sandbox.internal",
  allowed: true,
  why: null,
  enabledAt: "2026-10-02T10:00:00.000Z",
  disabledAt: null,
};
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };

async function withStub(
  answer: (method: string, body: unknown) => unknown,
  work: (seen: Array<{ line: string; body: unknown }>) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: Array<{ line: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    seen.push({ line: `${request.method} ${new URL(request.url).pathname}`, body });
    const value = answer(request.method, body);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}
async function cli(argv: string[]) {
  const lines: string[] = [];
  const code = await run(argv, env, {
    json: false,
    write: (t) => lines.push(t),
    error: (t) => lines.push(`ERR ${t}`),
  });
  return { code, text: lines.join("\n") };
}
const answer = (method: string, body: unknown) => ({
  ...STATE,
  enabled: method === "PUT" ? (body as { enabled: boolean }).enabled : true,
});

test("runtime.networks.private sets and reads the switch", async () => {
  await withStub(answer, async (seen) => {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    expect((await runtime.networks.private.set({ enabled: true })).enabled).toBe(true);
    expect(await runtime.networks.private.get()).toMatchObject({
      enabled: true,
      suffix: "sandbox.internal",
    });
    expect(seen).toEqual([
      { line: "PUT /v1/networks/private", body: { enabled: true } },
      { line: "GET /v1/networks/private", body: undefined },
    ]);
  });
});

test("`runtime networks private on|off|status` says what it means", async () => {
  await withStub(answer, async (seen) => {
    const on = await cli(["networks", "private", "on"]);
    expect(on.code).toBe(0);
    expect(on.text).toContain("<name>.sandbox.internal");
    const off = await cli(["networks", "private", "off"]);
    expect(off.text).toContain("cut");
    expect((await cli(["networks", "private", "status"])).text).toContain("On:");
    expect(seen.map((s) => [s.line, s.body])).toEqual([
      ["PUT /v1/networks/private", { enabled: true }],
      ["PUT /v1/networks/private", { enabled: false }],
      ["GET /v1/networks/private", undefined],
    ]);
    await expect(cli(["networks", "private", "maybe"])).rejects.toMatchObject({ code: "usage" });
  });
});

test("a trial account is told it needs a paid account", async () => {
  await withStub(
    () => ({ ...STATE, enabled: false, allowed: false, why: "not_paid", enabledAt: null }),
    async () => {
      expect((await cli(["networks", "private", "status"])).text).toContain("needs a kept top-up");
    },
  );
});
