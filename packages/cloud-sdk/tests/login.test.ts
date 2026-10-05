import { afterEach, beforeEach, expect, test } from "bun:test";
import { publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticationCommand, beginDeviceLogin, named } from "../src/login";
import { connectionStore, resolveCredential } from "../src/credentials";
import { sandboxMarker } from "../src/transport";

let directory: string;
let env: NodeJS.ProcessEnv;
const key = `rtcloud_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
const connectionId = randomUUID();
const orgId = randomUUID();
const marker = sandboxMarker.path;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "runtime-login-test-"));
  env = { XDG_CONFIG_HOME: directory };
  // Outside a sandbox, wherever the tests run: inside one, the API is called
  // at runtime.internal (sandbox-origin.test.ts).
  sandboxMarker.path = join(directory, "environment.json");
});
afterEach(async () => {
  sandboxMarker.path = marker;
  await rm(directory, { recursive: true, force: true });
});
function mockServer(
  options: { deny?: boolean; expired?: boolean; wrongOrigin?: boolean; failConfirm?: boolean } = {},
) {
  let encrypted = "";
  let starts = 0;
  let confirms = 0;
  let disconnects = 0;
  const requests: string[] = [];
  const fetcher = (async (url, init) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    requests.push(address);
    expect(init?.redirect).toBe("error");
    if (address.endsWith("/start")) {
      starts++;
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      const body = JSON.parse(init.body);
      encrypted = publicEncrypt(
        { key: body.publicKey, oaepHash: "sha256" },
        Buffer.from(key),
      ).toString("base64");
      return Response.json({
        deviceCode: "a".repeat(43),
        userCode: "ABCD-EF01-2345",
        expiresAt: Date.now() + 10000,
        verificationUri: `${options.wrongOrigin ? "https://bad.example" : "https://withruntime.com"}/connect?code=ABCD-EF01-2345`,
      });
    }
    if (address.endsWith("/token")) {
      return Response.json(
        options.deny
          ? { status: "denied" }
          : options.expired
            ? { status: "expired" }
            : { status: "connected", encryptedKey: encrypted, connectionId, orgId },
      );
    }
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
    if (address.endsWith("/confirm")) {
      confirms++;
      return options.failConfirm
        ? Response.json({}, { status: 503 })
        : Response.json({ connected: true });
    }
    if (address.endsWith("/disconnect")) {
      disconnects++;
      return Response.json({ disconnected: true });
    }
    throw new Error("Unexpected request");
  }) as typeof fetch;
  return {
    fetcher,
    requests,
    get starts() {
      return starts;
    },
    get confirms() {
      return confirms;
    },
    get disconnects() {
      return disconnects;
    },
  };
}

for (const resumed of [false, true]) {
  test(`MCP device login refuses production credentials for another API${resumed ? " when resumed" : ""}`, async () => {
    const mixed = { ...env, RUNTIME_API_URL: "https://unrelated.example" };
    const store = connectionStore(mixed);
    if (resumed)
      await store.savePending({
        version: 1,
        apiOrigin: "https://unrelated.example",
        authOrigin: "https://withruntime.com",
        privateKey: "unused",
        deviceCode: "a".repeat(43),
        url: "https://withruntime.com/connect?code=ABCD-EF01-2345",
        userCode: "ABCD-EF01-2345",
        agentName: "MCP agent",
        expiresAt: Date.now() + 60_000,
      });
    const server = mockServer();
    await expect(beginDeviceLogin(mixed, "MCP agent", { fetch: server.fetcher })).rejects.toThrow(
      "Check RUNTIME_AUTH_URL and RUNTIME_API_URL",
    );
    expect(server.requests).toEqual([]);
    expect(await store.read()).toBeNull();
  });
}

test("MCP device login retains paired local endpoints", async () => {
  const local = {
    ...env,
    RUNTIME_AUTH_URL: "http://localhost:4011",
    RUNTIME_API_URL: "http://127.0.0.1:4010",
  };
  const requests: string[] = [];
  const pending = await beginDeviceLogin(local, "MCP agent", {
    fetch: (async (input) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return Response.json({
        deviceCode: "a".repeat(43),
        userCode: "ABCD-EF01-2345",
        expiresAt: Date.now() + 60_000,
        verificationUri: "http://localhost:4011/connect?code=ABCD-EF01-2345",
      });
    }) as typeof fetch,
  });
  expect(pending.url).toBe("http://localhost:4011/connect?code=ABCD-EF01-2345");
  expect(requests).toEqual(["http://localhost:4011/api/connect/start"]);
});

test("agent login opens only the verified browser URL and keeps credentials out of output", async () => {
  const server = mockServer();
  const messages: string[] = [];
  const opened: string[] = [];
  const result = await authenticationCommand(["login", "--agent-name", "Build agent"], env, {
    fetch: server.fetcher,
    sleep: async () => {},
    notify: (text) => {
      messages.push(text);
    },
    openBrowser: async (url) => {
      opened.push(url);
    },
  });
  expect(result).toMatchObject({ connected: true, agentName: "Build agent", orgId });
  expect(opened).toEqual(["https://withruntime.com/connect?code=ABCD-EF01-2345"]);
  expect(messages.join("\n")).toContain("ABCD-EF01-2345");
  expect(JSON.stringify({ messages, opened, result })).not.toContain(key);
  expect(JSON.stringify({ messages, opened, result })).not.toContain("a".repeat(43));
  expect(await resolveCredential(env)).toBe(key);
  const [name] = await readdir(join(directory, "runtime-cloud"));
  const file = join(directory, "runtime-cloud", name!);
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
  expect((await lstat(join(directory, "runtime-cloud"))).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await readFile(file, "utf8")).key).toBe(key);
  await authenticationCommand(["login"], env, { fetch: server.fetcher });
  expect(server.starts).toBe(1);
});

test("headless login hands back the link at once, the next run finishes it, and logout revokes before removing access", async () => {
  const server = mockServer();
  const options = {
    fetch: server.fetcher,
    sleep: async () => {
      throw new Error("--no-browser must not wait");
    },
    notify: () => {},
    openBrowser: async () => {
      throw new Error("Must not open browser");
    },
  };
  const first = await authenticationCommand(["login", "--no-browser"], env, options);
  expect(first).toMatchObject({
    connected: false,
    pending: true,
    url: "https://withruntime.com/connect?code=ABCD-EF01-2345",
    userCode: "ABCD-EF01-2345",
  });
  expect(server.requests.filter((url) => url.endsWith("/token"))).toHaveLength(0);
  expect(await connectionStore(env).read()).toBeNull();
  // Approved in the browser meanwhile: the same command now finishes it.
  expect(await authenticationCommand(["login", "--no-browser"], env, options)).toMatchObject({
    connected: true,
    orgId,
  });
  expect(server.starts).toBe(1);
  expect(await connectionStore(env).read()).toMatchObject({ orgId });
  // Reviewer's finding #42, 26 September 2026: `auth status` was a branch the
  // CLI never sends (it has `whoami`), so it is not a command here either.
  await expect(
    authenticationCommand(["auth", "status"], env, { fetch: server.fetcher }),
  ).rejects.toThrow("runtime whoami");
  expect(await authenticationCommand(["logout"], env, { fetch: server.fetcher })).toEqual({
    disconnected: true,
  });
  expect(server.disconnects).toBe(1);
  expect(await connectionStore(env).read()).toBeNull();
});

test("an agent's login waits a bounded time and then hands back the link; a person's waits", async () => {
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const server = mockServer();
    const pendingForever = (async (url, init) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (address.endsWith("/token")) return Response.json({ status: "pending" });
      const answer = await server.fetcher(url, init);
      if (!address.endsWith("/start")) return answer;
      // Requests live fifteen minutes, on this test's clock.
      return Response.json({ ...(await answer.json()), expiresAt: now + 15 * 60_000 });
    }) as typeof fetch;
    const sleep = async (ms: number) => {
      now += ms;
    };
    const agent = await authenticationCommand(["login"], env, {
      fetch: pendingForever,
      sleep,
      notify: () => {},
      openBrowser: async () => {},
      interactive: false,
    });
    expect(agent).toMatchObject({ connected: false, pending: true });
    expect(now - 1_000_000).toBeGreaterThanOrEqual(50_000);
    expect(now - 1_000_000).toBeLessThan(60_000);
    // A person at a terminal waits until it is approved.
    let checks = 0;
    const approvedLater = (async (url, init) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (address.endsWith("/token") && ++checks < 40) return Response.json({ status: "pending" });
      return server.fetcher(url, init);
    }) as typeof fetch;
    expect(
      await authenticationCommand(["login"], env, {
        fetch: approvedLater,
        sleep,
        notify: () => {},
        interactive: true,
      }),
    ).toMatchObject({ connected: true });
    expect(server.starts).toBe(1);
  } finally {
    Date.now = realNow;
  }
});

test("a lost confirmation leaves a private saved credential that the next login resumes", async () => {
  const broken = mockServer({ failConfirm: true });
  await expect(
    authenticationCommand(["login", "--no-browser", "--wait"], env, {
      fetch: broken.fetcher,
      sleep: async () => {},
      notify: () => {},
    }),
  ).rejects.toThrow();
  expect(await resolveCredential(env)).toBe(key);
  const healthy = mockServer();
  expect(await authenticationCommand(["login"], env, { fetch: healthy.fetcher })).toMatchObject({
    connected: true,
  });
  expect(healthy.starts).toBe(0);
  expect(healthy.confirms).toBe(1);
});

test("failed revocation preserves the saved connection instead of claiming logout succeeded", async () => {
  const server = mockServer();
  await authenticationCommand(["login", "--no-browser", "--wait"], env, {
    fetch: server.fetcher,
    sleep: async () => {},
    notify: () => {},
  });
  for (const status of [403, 503]) {
    await expect(
      authenticationCommand(["logout"], env, {
        fetch: (async () => Response.json({}, { status })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(await resolveCredential(env)).toBe(key);
  }
});

test("a login stopped while it waits shows the same link again and never asks for a second approval", async () => {
  const server = mockServer();
  const opened: string[] = [];
  const messages: string[] = [];
  const options = {
    fetch: server.fetcher,
    notify: (text: string) => {
      messages.push(text);
    },
    openBrowser: async (url: string) => {
      opened.push(url);
    },
  };
  // An agent's tool gives up while the person has not approved yet.
  await expect(
    authenticationCommand(["login"], env, {
      ...options,
      sleep: async () => {
        throw new Error("stopped");
      },
    }),
  ).rejects.toThrow("stopped");
  const files = await readdir(join(directory, "runtime-cloud"));
  expect(files).toHaveLength(1);
  const pendingFile = join(directory, "runtime-cloud", files[0]!);
  expect((await lstat(pendingFile)).mode & 0o777).toBe(0o600);
  expect(await connectionStore(env).read()).toBeNull();
  expect(messages.join("\n")).toContain("running it again keeps the same link");

  const result = await authenticationCommand(["login"], env, {
    ...options,
    sleep: async () => {},
  });
  expect(result).toMatchObject({ connected: true, orgId });
  expect(server.starts).toBe(1);
  expect(opened).toHaveLength(1);
  expect(messages.filter((text) => text.includes("ABCD-EF01-2345"))).toHaveLength(2);
  expect(await resolveCredential(env)).toBe(key);
  expect(await readdir(join(directory, "runtime-cloud"))).not.toContain(files[0]);
});

test("denied, expired and substituted browser requests never persist a credential", async () => {
  for (const scenario of [{ deny: true }, { expired: true }, { wrongOrigin: true }]) {
    await expect(
      authenticationCommand(["login", "--no-browser", "--wait"], env, {
        fetch: mockServer(scenario).fetcher,
        sleep: async () => {},
        notify: () => {},
      }),
    ).rejects.toThrow();
    expect(await connectionStore(env).read()).toBeNull();
  }
});

test("stored credentials never follow an API origin change; environment credentials retain precedence", async () => {
  const server = mockServer();
  await authenticationCommand(["login", "--no-browser", "--wait"], env, {
    fetch: server.fetcher,
    sleep: async () => {},
    notify: () => {},
  });
  await expect(
    resolveCredential({ ...env, RUNTIME_API_URL: "https://unrelated.example" }),
  ).rejects.toThrow("No Runtime key found");
  await expect(
    authenticationCommand(["login"], { ...env, RUNTIME_API_URL: "https://unrelated.example" }),
  ).rejects.toThrow("Check RUNTIME_AUTH_URL");
  expect(await resolveCredential({ ...env, RUNTIME_API_KEY: "environment-secret" })).toBe(
    "environment-secret",
  );
});

test("shared-permission files and symlinks are refused instead of exposing credentials", async () => {
  const server = mockServer();
  await authenticationCommand(["login", "--no-browser", "--wait"], env, {
    fetch: server.fetcher,
    sleep: async () => {},
    notify: () => {},
  });
  const [name] = await readdir(join(directory, "runtime-cloud"));
  const file = join(directory, "runtime-cloud", name!);
  await chmod(file, 0o644);
  await expect(resolveCredential(env)).rejects.toThrow("private");
  await rm(file);
  await symlink("/etc/passwd", file);
  await expect(resolveCredential(env)).rejects.toThrow("safely");
});

test("a pasted key is checked, saved privately, and forgotten on logout without revoking it", async () => {
  const seen: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    seen.push(address);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
    return Response.json({ orgId, principalId: "p", credentialId: null, apiVersion: "0.2.0" });
  }) as typeof fetch;
  await expect(
    authenticationCommand(["login", "--with-key"], env, {
      fetch: fetcher,
      readKey: async () => "not-a-key",
    }),
  ).rejects.toThrow("That is not a Runtime key");
  expect(
    await authenticationCommand(["login", "--with-key"], env, {
      fetch: fetcher,
      readKey: async () => `${key}\n`,
    }),
  ).toEqual({ connected: true, agentName: "pasted key", orgId, source: "key" });
  expect(seen).toEqual(["https://api.withruntime.com/v1/me"]);
  expect(await resolveCredential(env)).toBe(key);
  expect(await authenticationCommand(["logout"], env, { fetch: fetcher })).toEqual({
    disconnected: true,
  });
  expect(seen).toHaveLength(1);
  await expect(resolveCredential(env)).rejects.toMatchObject({ code: "missing_api_key" });
});

test("the SDK uses the saved connection when no key is given, and says how to get one when there is none", async () => {
  const { Runtime } = await import("../src/index");
  const previous = { config: process.env.XDG_CONFIG_HOME, key: process.env.RUNTIME_API_KEY };
  process.env.XDG_CONFIG_HOME = directory;
  delete process.env.RUNTIME_API_KEY;
  try {
    const answered = (async (_url: string, init?: RequestInit) =>
      Response.json({
        orgId,
        principalId: new Headers(init?.headers).get("authorization"),
        credentialId: null,
        apiVersion: "0.2.0",
      })) as unknown as typeof fetch;
    // Nothing saved: the first call, not the constructor, says what to do.
    const none = new Runtime({ fetch: answered });
    await expect(none.me()).rejects.toMatchObject({
      code: "missing_api_key",
      hint: expect.stringContaining("npx -y withruntime login"),
    });
    await connectionStore(process.env).save({
      version: 1,
      apiOrigin: "https://api.withruntime.com",
      authOrigin: "https://withruntime.com",
      key,
      connectionId,
      orgId,
      agentName: "test",
    });
    expect((await new Runtime({ fetch: answered }).me()).principalId).toBe(`Bearer ${key}`);
  } finally {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.key !== undefined) process.env.RUNTIME_API_KEY = previous.key;
  }
});

test("through npx, what the CLI tells you to type names npx, and nothing else changes", () => {
  const text =
    "Usage: runtime <product> <command>\n  Each has its own help: `runtime sandbox help`.\nRun `runtime login` (runtime_feedback_submit, Runtime Cloud, runtime-cloud).";
  expect(named(text, "runtime")).toBe(text);
  expect(named(text, "npx withruntime")).toBe(
    "Usage: npx withruntime <product> <command>\n  Each has its own help: `npx withruntime sandbox help`.\nRun `npx withruntime login` (runtime_feedback_submit, Runtime Cloud, runtime-cloud).",
  );
});
