import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionStore, type SavedConnection } from "../src/credentials";
import { authenticationCommand } from "../src/login";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "runtime-concurrent-logout-"));
  directories.push(directory);
  const env = { XDG_CONFIG_HOME: directory };
  const connection = (letter: string): SavedConnection => ({
    version: 1,
    apiOrigin: "https://api.withruntime.com",
    authOrigin: "https://withruntime.com",
    key: `rtcloud_11111111-2222-4333-8444-555555555555_${letter.repeat(43)}`,
    connectionId: `fixture-${letter}`,
    orgId: `org-${letter}`,
    agentName: `agent-${letter}`,
  });
  const first = connection("A"),
    second = connection("B");
  const store = connectionStore(env);
  await store.save(first);
  return { env, first, second, store };
}

for (const status of [200, 401]) {
  test(`logout preserves a newer login while the original revoke answers ${status}`, async () => {
    const kit = await setup();
    let started!: () => void;
    let resume!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resumeRequest = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let revokedExpectedKey = false;
    const logout = authenticationCommand(["logout"], kit.env, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input instanceof Request ? input.url : String(input)).toBe(
          "https://withruntime.com/api/connect/disconnect",
        );
        revokedExpectedKey =
          new Headers(init?.headers).get("authorization") === `Bearer ${kit.first.key}`;
        started();
        await resumeRequest;
        return Response.json({ disconnected: true }, { status });
      }) as typeof fetch,
    });
    try {
      await requestStarted;
      await connectionStore(kit.env).save(kit.second);
    } finally {
      resume();
    }
    expect(await logout).toEqual({ disconnected: true });
    expect(revokedExpectedKey).toBe(true);
    expect((await kit.store.read())?.key === kit.second.key).toBe(true);
  });
}

test("stale login refusal cannot remove a newer saved connection", async () => {
  const kit = await setup();
  let started!: () => void;
  let resume!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resumeRequest = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const login = authenticationCommand(["login", "--no-browser", "--no-wait"], kit.env, {
    notify: () => {},
    fetch: (async (input: RequestInfo | URL) => {
      if ((input instanceof Request ? input.url : String(input)).endsWith("/confirm")) {
        started();
        await resumeRequest;
        return Response.json({}, { status: 401 });
      }
      expect(input instanceof Request ? input.url : String(input)).toBe(
        "https://withruntime.com/api/connect/start",
      );
      return Response.json({
        verificationUri: "https://withruntime.com/connect?code=ABCD-EF01-2345",
        deviceCode: "a".repeat(43),
        userCode: "ABCD-EF01-2345",
        expiresAt: Date.now() + 60_000,
      });
    }) as typeof fetch,
  });
  try {
    await requestStarted;
    await connectionStore(kit.env).save(kit.second);
  } finally {
    resume();
  }
  expect(await login).toMatchObject({ pending: true, connected: false });
  expect((await kit.store.read())?.key === kit.second.key).toBe(true);
});

test("conditional removal matches inside the lock; ordinary removal stays unconditional", async () => {
  const kit = await setup();
  await kit.store.save(kit.second);
  await kit.store.remove(kit.first.key);
  expect((await kit.store.read())?.key === kit.second.key).toBe(true);
  await kit.store.remove(kit.second.key);
  expect(await kit.store.read()).toBeNull();
  await kit.store.save(kit.first);
  await kit.store.remove();
  expect(await kit.store.read()).toBeNull();
});
