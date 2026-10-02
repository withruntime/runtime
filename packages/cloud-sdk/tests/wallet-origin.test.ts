import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { connectionStore } from "../src/credentials";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const dummyKey = `rtcloud_11111111-2222-4333-8444-555555555555_${"A".repeat(43)}`;
async function withFixture(
  api: string,
  auth: string,
  work: (fixture: { env: NodeJS.ProcessEnv; calls: string[]; lines: string[] }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-wallet-origin-"));
  directories.push(directory);
  const env = { XDG_CONFIG_HOME: directory, RUNTIME_API_URL: api, RUNTIME_AUTH_URL: auth };
  const calls: string[] = [];
  const lines: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url.origin + url.pathname);
    if (url.pathname === "/api/wallet/claim")
      return Response.json({ status: "paid", orgId: "fixture-org", apiKey: dummyKey });
    expect(url.pathname).toBe("/api/wallet/topups");
    return Response.json({
      status: "open",
      orgId: "fixture-org",
      claimCode: "fixture-code",
      purchaseId: "fixture-topup",
      amountUsd: 20,
      amount: "20.000000",
      payBy: new Date(Date.now() + 60_000).toISOString(),
      networks: [],
    });
  }) as typeof fetch;
  try {
    await work({ env, calls, lines });
  } finally {
    globalThis.fetch = original;
  }
}
const output = (lines: string[]) => ({
  json: true,
  write: (text: string) => lines.push(text),
  error: (text: string) => lines.push(text),
});

for (const args of [
  ["claim", "fixture-code"],
  ["topup", "20", "--new-account", "--accept-terms"],
]) {
  test(`wallet ${args[0]} refuses mixed endpoints before requesting a key or account`, async () => {
    await withFixture(
      "https://unrelated.example",
      "https://withruntime.com",
      async ({ env, calls, lines }) => {
        await expect(run(["billing", ...args], env, output(lines))).rejects.toThrow(
          "Check RUNTIME_AUTH_URL and RUNTIME_API_URL",
        );
        expect(calls).toEqual([]);
        expect(await connectionStore(env).read()).toBeNull();
      },
    );
  });
}

for (const [api, auth] of [
  ["https://api.withruntime.com", "https://withruntime.com"],
  ["http://127.0.0.1:4010", "http://localhost:4011"],
]) {
  test(`wallet claim keeps matching endpoints at ${api}`, async () => {
    await withFixture(api!, auth!, async ({ env, calls, lines }) => {
      expect(await run(["billing", "claim", "fixture-code"], env, output(lines))).toBe(0);
      expect(calls).toEqual([`${auth}/api/wallet/claim`]);
      expect((await connectionStore(env).read())?.key === dummyKey).toBe(true);
      expect(lines.join("\n")).not.toContain(dummyKey);
    });
  });
}

test("billing help with mixed endpoints remains read-only", async () => {
  await withFixture(
    "https://unrelated.example",
    "https://withruntime.com",
    async ({ env, calls, lines }) => {
      expect(await run(["billing", "help"], env, output(lines))).toBe(0);
      expect(calls).toEqual([]);
      expect(lines.join("\n")).toContain("runtime billing");
    },
  );
});
