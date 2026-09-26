import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { Runtime } from "../src/client";
import { connectionStore, type SavedConnection } from "../src/credentials";

/* Several accounts on one machine, `runtime account`, and the audit log
 * through the SDK and `runtime audit`. ARCHITECTURE.md section 3.9. */

let directory: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "runtime-accounts-test-"));
  env = { XDG_CONFIG_HOME: directory };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const connection = (orgName: string, orgId: string = randomUUID()): SavedConnection => ({
  version: 1,
  apiOrigin: "https://api.withruntime.com",
  authOrigin: "https://withruntime.com",
  key: `rtcloud_${randomUUID()}_${randomBytes(32).toString("base64url")}`,
  connectionId: randomUUID(),
  orgId,
  agentName: `agent for ${orgName}`,
  orgName,
});

function capture(json = false) {
  const lines: string[] = [];
  return {
    lines,
    out: { json, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}

test("connecting a second account keeps the first, and switching swaps them", async () => {
  const store = connectionStore(env);
  const acme = connection("Acme");
  const solo = connection("Solo");
  await store.save(acme);
  await store.save(solo);
  expect((await store.read())?.orgId).toBe(solo.orgId);
  expect((await store.others()).map((one) => one.orgId)).toEqual([acme.orgId]);

  // The same account again replaces its connection rather than adding one.
  const soloAgain = { ...connection("Solo", solo.orgId) };
  await store.save(soloAgain);
  expect((await store.read())?.key).toBe(soloAgain.key);
  expect((await store.others()).map((one) => one.orgId)).toEqual([acme.orgId]);

  expect((await store.use("acme"))?.orgId).toBe(acme.orgId);
  expect((await store.read())?.orgId).toBe(acme.orgId);
  expect((await store.others()).map((one) => one.orgId)).toEqual([solo.orgId]);
  expect(await store.use("nobody")).toBeNull();
});

test("`runtime account` lists the saved accounts, and `account switch` chooses one", async () => {
  const store = connectionStore(env);
  const acme = connection("Acme");
  const solo = connection("Solo");
  await store.save(acme);
  await store.save(solo);

  const listed = capture(true);
  expect(await run(["account", "--json"], env, listed.out)).toBe(0);
  const value = JSON.parse(listed.lines[0]!) as {
    accounts: { orgName: string; current: boolean }[];
  };
  expect(value.accounts).toEqual([
    expect.objectContaining({ orgName: "Solo", current: true }),
    expect.objectContaining({ orgName: "Acme", current: false }),
  ]);

  const switched = capture();
  expect(await run(["account", "switch", "Acme"], env, switched.out)).toBe(0);
  expect(switched.lines.join("\n")).toContain("Now using Acme.");
  expect((await store.read())?.orgId).toBe(acme.orgId);

  const missing = capture();
  await expect(run(["account", "switch", "Nowhere"], env, missing.out)).rejects.toThrow(
    /No saved connection/,
  );
  await expect(
    run(["account", "switch", "Acme"], { ...env, RUNTIME_API_KEY: "rk_env" }, missing.out),
  ).rejects.toThrow(/RUNTIME_API_KEY/);
});

test("audit.list() reads GET /v1/audit with its filters, and `runtime audit` prints a table", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  const page = {
    events: [
      {
        seq: "42",
        id: randomUUID(),
        at: "2026-09-23T10:00:00.000Z",
        action: "member.role_changed",
        actor: { kind: "person", id: randomUUID(), name: "Marc", person: null },
        target: { type: "member", id: "acct" },
        detail: { from: "developer", to: "admin" },
        ip: "203.0.113.7",
        requestId: "req_1",
        via: "web",
      },
    ],
    next: "42",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    return Response.json(page);
  }) as typeof fetch;
  try {
    const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
    const got = await runtime.audit.list({ action: "member.", limit: 10 });
    expect(got.events[0]!.action).toBe("member.role_changed");
    expect(seen[0]).toBe("GET /v1/audit?action=member.&limit=10");

    const printed = capture();
    const cli = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
    expect(await run(["audit", "--action", "key."], cli, printed.out)).toBe(0);
    const text = printed.lines.join("\n");
    expect(text).toContain("member.role_changed");
    expect(text).toContain("203.0.113.7");
    expect(text).toContain("audit --before 42");
    expect(seen.at(-1)).toBe("GET /v1/audit?action=key.");
  } finally {
    globalThis.fetch = original;
  }
});
