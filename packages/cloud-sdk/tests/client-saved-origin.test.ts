import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/client";
import { connectionOrigins, connectionStore } from "../src/credentials";
import { sandboxMarker } from "../src/transport";

const DUMMY_KEY = `rtcloud_11111111-2222-4333-8444-555555555555_${"A".repeat(43)}`;
const OTHER_DUMMY_KEY = `rtcloud_11111111-2222-4333-8444-555555555555_${"B".repeat(43)}`;
const ENV_NAMES = [
  "XDG_CONFIG_HOME",
  "RUNTIME_API_KEY",
  "RUNTIME_API_URL",
  "RUNTIME_AUTH_URL",
] as const;
let directory: string;
let previous: Record<string, string | undefined>;
const marker = sandboxMarker.path;
beforeEach(async () => {
  previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  directory = await mkdtemp(join(tmpdir(), "runtime-client-origin-"));
  // Outside a sandbox unless a test writes this file, wherever the tests run.
  sandboxMarker.path = join(directory, "environment.json");
  process.env.XDG_CONFIG_HOME = directory;
  delete process.env.RUNTIME_API_KEY;
  process.env.RUNTIME_API_URL = "https://api.withruntime.com";
  process.env.RUNTIME_AUTH_URL = "https://withruntime.com";
});
afterEach(async () => {
  sandboxMarker.path = marker;
  for (const name of ENV_NAMES) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
  await rm(directory, { recursive: true, force: true });
});
async function save(apiOrigin: string, key = DUMMY_KEY) {
  const env = { ...process.env, RUNTIME_API_URL: apiOrigin };
  const origins = connectionOrigins(env);
  await connectionStore(env).save({
    version: 1,
    apiOrigin: origins.api,
    authOrigin: origins.auth,
    key,
    connectionId: "fixture-connection",
    orgId: "fixture-org",
    agentName: "fixture-agent",
  });
}
function recorder() {
  const calls: { origin: string; keyMatchesProduction: boolean; keyMatchesOther: boolean }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const auth = request.headers.get("authorization");
    calls.push({
      origin: new URL(request.url).origin,
      keyMatchesProduction: auth === `Bearer ${DUMMY_KEY}`,
      keyMatchesOther: auth === `Bearer ${OTHER_DUMMY_KEY}`,
    });
    return Response.json({
      orgId: "fixture-org",
      principalId: "fixture-agent",
      credentialId: null,
    });
  }) as typeof fetch;
  return { calls, fetcher };
}

test("an unrelated constructor API cannot receive the saved production credential", async () => {
  await save("https://api.withruntime.com");
  const record = recorder();
  const runtime = new Runtime({ baseUrl: "https://unrelated.example", fetch: record.fetcher });
  await expect(runtime.me()).rejects.toMatchObject({ code: "missing_api_key" });
  expect(record.calls).toEqual([]);
});

test("normalized constructor origin retains the matching saved credential", async () => {
  await save("https://api.withruntime.com");
  const record = recorder();
  const runtime = new Runtime({
    baseUrl: "https://API.WITHRUNTIME.COM:443/",
    fetch: record.fetcher,
  });
  await runtime.me();
  expect(record.calls).toEqual([
    { origin: "https://api.withruntime.com", keyMatchesProduction: true, keyMatchesOther: false },
  ]);
});

test("inside a sandbox the key saved for the public API is used, and the call goes to runtime.internal", async () => {
  await save("https://api.withruntime.com");
  await writeFile(sandboxMarker.path, "{}");
  for (const options of [{}, { baseUrl: "https://api.withruntime.com" }]) {
    const record = recorder();
    await new Runtime({ ...options, fetch: record.fetcher }).me();
    expect(record.calls).toEqual([
      { origin: "http://runtime.internal", keyMatchesProduction: true, keyMatchesOther: false },
    ]);
  }
});

test("a constructor origin chooses its own saved connection rather than the environment's", async () => {
  await save("https://api.withruntime.com");
  await save("https://unrelated.example", OTHER_DUMMY_KEY);
  const record = recorder();
  await new Runtime({ baseUrl: "https://unrelated.example", fetch: record.fetcher }).me();
  expect(record.calls).toEqual([
    { origin: "https://unrelated.example", keyMatchesProduction: false, keyMatchesOther: true },
  ]);
});

test("an environment origin change after construction cannot redirect saved-key lookup", async () => {
  await save("https://api.withruntime.com");
  await save("https://unrelated.example", OTHER_DUMMY_KEY);
  const record = recorder();
  const runtime = new Runtime({ fetch: record.fetcher });
  process.env.RUNTIME_API_URL = "https://unrelated.example";
  await runtime.me();
  expect(record.calls).toEqual([
    { origin: "https://api.withruntime.com", keyMatchesProduction: true, keyMatchesOther: false },
  ]);
});

for (const source of ["explicit", "environment"] as const) {
  test(`${source} API key remains deliberate authority for a constructor origin`, async () => {
    await save("https://api.withruntime.com");
    const record = recorder();
    if (source === "environment") process.env.RUNTIME_API_KEY = OTHER_DUMMY_KEY;
    await new Runtime({
      baseUrl: "https://unrelated.example",
      fetch: record.fetcher,
      ...(source === "explicit" ? { apiKey: OTHER_DUMMY_KEY } : {}),
    }).me();
    expect(record.calls).toEqual([
      { origin: "https://unrelated.example", keyMatchesProduction: false, keyMatchesOther: true },
    ]);
  });
}

test("an explicit zero connection limit retains the transport's minimum of one", async () => {
  let active = 0;
  let peak = 0;
  let notifyStart: (() => void) | undefined;
  const releases: (() => void)[] = [];
  const fetcher = (async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => {
      releases.push(resolve);
      notifyStart?.();
    });
    active--;
    return Response.json({
      orgId: "fixture-org",
      principalId: "fixture-agent",
      credentialId: null,
    });
  }) as unknown as typeof fetch;
  const runtime = new Runtime({ apiKey: DUMMY_KEY, fetch: fetcher, maxConnections: 0 });
  const calls = Array.from({ length: 6 }, () => runtime.me());
  for (let index = 0; index < calls.length; index++) {
    while (releases.length <= index)
      await new Promise<void>((resolve) => {
        notifyStart = resolve;
      });
    releases[index]!();
  }
  await Promise.all(calls);
  expect(peak).toBe(1);
});
