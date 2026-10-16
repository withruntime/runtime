import { expect, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";

/* runtime.networks.signedRequests and `runtime networks signed-requests
 * on|off|status` against a stub API. The routes are tested on Postgres in
 * packages/cloud (signed-requests-api-postgres.test.ts). */

const STATE = {
  allowed: true,
  why: null,
  enabledAt: "2026-10-10T10:00:00.000Z",
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
    return Response.json(answer(request.method, body));
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

test("runtime.networks.signedRequests sets and reads the switch", async () => {
  await withStub(answer, async (seen) => {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    expect((await runtime.networks.signedRequests.set({ enabled: true })).enabled).toBe(true);
    expect(await runtime.networks.signedRequests.get()).toMatchObject({
      enabled: true,
      allowed: true,
    });
    expect(seen).toEqual([
      { line: "PUT /v1/networks/signed-requests", body: { enabled: true } },
      { line: "GET /v1/networks/signed-requests", body: undefined },
    ]);
  });
});

test("`runtime networks signed-requests on|off|status` says what it means", async () => {
  await withStub(answer, async (seen) => {
    const on = await cli(["networks", "signed-requests", "on"]);
    expect(on.code).toBe(0);
    expect(on.text).toStartWith("On.");
    expect((await cli(["networks", "signed-requests", "off"])).text).toContain("within 5 minutes");
    expect((await cli(["networks", "signed-requests", "status"])).text).toStartWith("On.");
    expect(seen.map((s) => [s.line, s.body])).toEqual([
      ["PUT /v1/networks/signed-requests", { enabled: true }],
      ["PUT /v1/networks/signed-requests", { enabled: false }],
      ["GET /v1/networks/signed-requests", undefined],
    ]);
    await expect(cli(["networks", "signed-requests", "maybe"])).rejects.toMatchObject({
      code: "usage",
    });
  });
});

test("an account without credit is told it needs credit", async () => {
  await withStub(
    () => ({ ...STATE, enabled: false, allowed: false, why: "no_credit", enabledAt: null }),
    async () => {
      expect((await cli(["networks", "signed-requests", "status"])).text).toContain("Needs credit");
    },
  );
});
