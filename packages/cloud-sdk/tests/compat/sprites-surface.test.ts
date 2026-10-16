import { expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import { NotFoundError, RuntimeError } from "../../src/errors.js";
import {
  APIError,
  CompatibilityError,
  ControlConnection,
  ExecError,
  OpConn,
  ProxyManager,
  ProxySession,
  SpritesClient,
  parseAPIError,
  proxyPorts,
} from "../../src/sprites/index.js";

const ID = "00000000-0000-0000-0000-000000000001";
type Call = { method: string; args?: unknown };

/** A native client with one sandbox; each method records its call. */
function fake(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const record = (method: string, args?: unknown) => calls.push({ method, args });
  let network = {
    internet: true,
    allow: [] as string[],
    deny: [] as string[],
    connect: ["db.example.com:5432"],
  };
  const snapshots: Record<string, unknown>[] = [];
  const execs: string[][] = [];
  let execAnswers: { exitCode: number; stdout?: string; stderr?: string }[] = [];
  const sandbox = {
    id: ID,
    state: "running",
    info: {
      name: "one",
      labels: {},
      createdAt: "2026-09-30T00:00:00Z",
      diskMiB: 4096,
      region: "us-east",
    },
    files: {
      async readText() {
        return "{}";
      },
      async write() {},
      async exists() {
        return true;
      },
      async watch(path: string, onEvent: (e: unknown) => void, options: unknown) {
        record("watch", { path, options });
        watchers.push(onEvent);
        return {
          async stop() {
            record("watch stop", path);
          },
        };
      },
    },
    async exec(argv: string[]) {
      execs.push(argv);
      const answer = execAnswers.shift() ?? { exitCode: 0 };
      return { stdout: "", stderr: "", timedOut: false, ...answer };
    },
    async snapshot(options: unknown) {
      record("snapshot", options);
      if (overrides.snapshotFails)
        throw new RuntimeError({ code: "snapshot_failed", status: 409, message: "No room" });
      return { id: "snap-new", mode: "disk" };
    },
    async spawn(argv: string[], options: unknown) {
      record("spawn", { argv, options });
      return {
        id: "p1",
        async write(data: unknown, options?: { eof?: boolean }) {
          record("write", { data: Buffer.from(data as string).toString(), eof: options?.eof });
        },
        async kill() {},
        async *outputBytes() {
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield { type: "stdout", data: new TextEncoder().encode("out"), offset: 0 };
          yield { type: "exit", exitCode: 0, state: "exited", timedOut: false };
        },
      };
    },
    network: {
      async get() {
        return network;
      },
      async set(rules: typeof network) {
        record("network set", rules);
        network = Object.assign({ allow: [], deny: [], connect: [] }, rules);
        return network;
      },
    },
    processes: {
      async get(id: string) {
        record("process get", id);
        return process;
      },
    },
    async forwardPort(port: number, options: { localPort?: number }) {
      record("forward", { port, options });
      if (overrides.forwardFails && port === overrides.forwardFails)
        throw new RuntimeError({ code: "tunnel_failed", status: 502, message: "No tunnel" });
      return {
        host: "localhost",
        localPort: options.localPort || 40000 + port,
        port,
        async close() {
          record("forward close", port);
        },
      };
    },
  };
  const watchers: ((e: unknown) => void)[] = [];
  const process = {
    async kill(signal: string) {
      record("kill", signal);
    },
    async wait({ signal }: { signal: AbortSignal }) {
      if (overrides.hangs && !calls.some((c) => c.args === "SIGKILL"))
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason as Error)),
        );
      return { exitCode: 143 };
    },
  };
  const runtime = {
    transport: { baseUrl: "https://withruntime.com" },
    sandboxes: {
      async get(id: string) {
        record("get", id);
        if (overrides.getFails) throw overrides.getFails as Error;
        return sandbox;
      },
      async create() {
        record("create");
        if (overrides.createFails) throw overrides.createFails as Error;
        return sandbox;
      },
    },
    snapshots: {
      async list(filter: unknown) {
        record("snapshots list", filter);
        return snapshots;
      },
      async get(id: string) {
        const found = snapshots.find((s) => s.id === id);
        if (!found) throw new NotFoundError({ code: "not_found", status: 404, message: "no" });
        return found;
      },
    },
  } as unknown as Runtime;
  const client = new SpritesClient(undefined, { client: runtime });
  return {
    calls,
    execs,
    watchers,
    snapshots,
    client,
    sprite: client.sprite(ID),
    answer: (answers: typeof execAnswers) => (execAnswers = answers),
    network: () => network,
  };
}

test("parseAPIError reads the vendor's body and rate-limit headers", () => {
  expect(parseAPIError(200, "{}")).toBeUndefined();
  const error = parseAPIError(
    429,
    JSON.stringify({
      error: "sprite_creation_rate_limited",
      message: "Slow down",
      limit: 10,
      window_seconds: 60,
      retry_after_seconds: 0,
      upgrade_available: true,
    }),
    { "retry-after": "7", "X-RateLimit-Remaining": "0" },
  )!;
  expect(error).toBeInstanceOf(APIError);
  expect(error.message).toBe("Slow down (limit: 10 per 60s, retry after: 0s)");
  expect(error.isRateLimitError()).toBe(true);
  expect(error.isCreationRateLimited()).toBe(true);
  expect(error.getRetryAfterSeconds()).toBe(7);
  expect(error.rateLimitRemaining).toBe(0);
  expect(error.upgradeAvailable).toBe(true);
  expect(parseAPIError(500, "not json")!.message).toBe("not json");
  expect(parseAPIError(502, undefined)!.message).toBe("API error (status 502)");
});

test("Runtime's refusals reach Sprites callers as APIError with the vendor's limit codes", async () => {
  for (const [code, status, check] of [
    ["quota_exceeded", 429, "isConcurrentLimitExceeded"],
    ["no_credit_running_limit", 409, "isConcurrentLimitExceeded"],
    ["rate_limited", 429, "isCreationRateLimited"],
  ] as const) {
    const f = fake({
      createFails: new RuntimeError({ code, status, message: "limit", retryAfterMs: 1500 }),
    });
    const error = await f.client.createSprite("one").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError)[check]()).toBe(true);
    expect((error as APIError).statusCode).toBe(status);
    expect((error as APIError).getRetryAfterSeconds()).toBe(2);
  }
  const missing = fake({
    getFails: new NotFoundError({ code: "not_found", status: 404, message: "No sandbox" }),
  });
  const error = await missing.client.getSprite(ID).catch((e: unknown) => e);
  expect(error).toMatchObject({ name: "APIError", statusCode: 404, errorCode: "not_found" });
  await expect(missing.client.upgradeSprite(ID)).rejects.toBeInstanceOf(APIError);
  await expect(missing.client.checkSprite(ID)).rejects.toBeInstanceOf(APIError);
});

test("checkSprite, upgradeSprite and client fields answer from Runtime", async () => {
  const f = fake();
  const check = await f.sprite.check();
  expect(check).toMatchObject({ spriteName: ID, spriteId: ID, status: "running" });
  expect(check.checkedAt).toBeInstanceOf(Date);
  await expect(f.sprite.upgrade()).resolves.toBeUndefined();
  expect(f.client.baseURL).toBe("https://withruntime.com");
  expect(f.client.controlMode).toBe(false);
  expect(f.sprite.useControlMode()).toBe(false);
  expect(f.sprite.hasControlConnection()).toBe(false);
  expect(f.sprite.closeControlConnection()).toBeUndefined();
  const created = await f.client.createSprite("one", { environment: { A: "1" } });
  expect(created.environment).toEqual({ A: "1" });
  expect(created.primaryRegion).toBe("us-east");
});

test("ExecError carries the vendor's result", async () => {
  const error = new ExecError("failed", { stdout: "o", stderr: "e", exitCode: 3 });
  expect(error.result).toEqual({ stdout: "o", stderr: "e", exitCode: 3 });
  expect([error.exitCode, error.stdout, error.stderr]).toEqual([3, "o", "e"]);
});

test("a checkpoint is a disk snapshot, streamed as the vendor's progress messages", async () => {
  const f = fake();
  const stream = await f.sprite.createCheckpoint("before upgrade");
  const messages = [];
  for await (const message of stream) messages.push(message);
  expect(messages.map((m) => m.type)).toEqual(["info", "info", "complete"]);
  expect(f.calls.find((c) => c.method === "snapshot")?.args).toEqual({
    mode: "disk",
    labels: { "compat.sprite": ID, "compat.comment": "before upgrade" },
  });
  const failing = fake({ snapshotFails: true });
  const failed: unknown[] = [];
  await (await failing.sprite.createCheckpoint()).processAll((m) => void failed.push(m));
  expect(failed).toEqual([
    { type: "info", data: "Creating checkpoint" },
    { type: "error", error: "No room" },
  ]);
  await expect(f.sprite.createCheckpoint(5 as unknown as string)).rejects.toBeInstanceOf(TypeError);
});

test("a checkpoint is taken even when nobody reads its stream", async () => {
  const f = fake();
  const stream = await f.sprite.createCheckpoint();
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.calls.some((c) => c.method === "snapshot")).toBe(true);
  expect(await stream.next()).toBeNull();
});

test("checkpoints list only this Sprite's disk snapshots, newest first", async () => {
  const f = fake();
  f.snapshots.push(
    {
      id: "old",
      mode: "disk",
      sourceSandboxId: ID,
      state: "ready",
      createdAt: "2026-10-01T00:00:00Z",
      labels: { "compat.comment": "first" },
    },
    {
      id: "memory",
      mode: "memory",
      sourceSandboxId: ID,
      state: "ready",
      createdAt: "2026-10-02T00:00:00Z",
    },
    {
      id: "other",
      mode: "disk",
      sourceSandboxId: "someone-else",
      state: "ready",
      createdAt: "2026-10-03T00:00:00Z",
    },
    {
      id: "new",
      mode: "disk",
      sourceSandboxId: ID,
      state: "ready",
      createdAt: "2026-10-04T00:00:00Z",
    },
  );
  const list = await f.sprite.listCheckpoints();
  expect(list.map((c) => c.id)).toEqual(["new", "old"]);
  expect(list[1]).toMatchObject({ comment: "first", health: "", isAuto: false });
  expect(f.calls.find((c) => c.method === "snapshots list")?.args).toEqual({
    sandboxId: ID,
    state: "ready",
  });
  expect((await f.sprite.getCheckpoint("old")).createTime).toEqual(
    new Date("2026-10-01T00:00:00Z"),
  );
  for (const id of ["memory", "other", "absent"])
    await expect(f.sprite.getCheckpoint(id)).rejects.toThrow(`Checkpoint not found: ${id}`);
  await expect(f.sprite.listCheckpoints("v1")).rejects.toBeInstanceOf(CompatibilityError);
  await expect(f.sprite.restoreCheckpoint("old")).rejects.toThrow("runtime.sandboxes.create");
});

test.each([
  [[], { internet: true, allow: [], deny: [] }],
  [[{ domain: "*", action: "deny" }], { internet: false, allow: [], deny: [] }],
  [
    [
      { domain: "*", action: "allow" },
      { domain: "a.com", action: "allow" },
    ],
    { internet: true, allow: [], deny: [] },
  ],
  [
    [
      { domain: "GitHub.com", action: "allow" },
      { domain: "*.npmjs.org", action: "allow" },
      { domain: "*", action: "deny" },
    ],
    { internet: true, allow: ["github.com", "*.npmjs.org"], deny: [] },
  ],
  [[{ domain: "bad.com", action: "deny" }], { internet: true, allow: [], deny: ["bad.com"] }],
  [
    [
      { domain: "*.x.com", action: "allow" },
      { domain: "a.x.com", action: "deny" },
    ],
    { internet: true, allow: ["*.x.com"], deny: ["a.x.com"] },
  ],
] as const)("network policy %j becomes Runtime's rules", async (rules, expected) => {
  const f = fake();
  await f.sprite.updateNetworkPolicy({ rules: rules as never });
  expect(f.calls.find((c) => c.method === "network set")?.args).toEqual({
    ...expected,
    connect: ["db.example.com:5432"],
  });
});

test.each([
  [[{ include: "defaults" }], CompatibilityError],
  [
    [
      { domain: "a.x.com", action: "allow" },
      { domain: "*.x.com", action: "deny" },
    ],
    CompatibilityError,
  ],
  [
    [
      { domain: "a.com", action: "allow" },
      { domain: "a.com", action: "deny" },
    ],
    CompatibilityError,
  ],
  [
    [
      { domain: "*", action: "allow" },
      { domain: "*", action: "deny" },
    ],
    TypeError,
  ],
  [[{ domain: "a.com", action: "block" }], TypeError],
  [[{ action: "allow" }], TypeError],
  [[{ domain: "a.com", action: "allow", port: 22 }], CompatibilityError],
  ["not a list", TypeError],
] as const)("network policy %j is refused before any change", async (rules, kind) => {
  const f = fake();
  await expect(f.sprite.updateNetworkPolicy({ rules: rules as never })).rejects.toBeInstanceOf(
    kind,
  );
  expect(f.calls.some((c) => c.method === "network set")).toBe(false);
});

test("getNetworkPolicy reads Runtime's rules back as Sprites rules", async () => {
  const f = fake();
  expect(await f.sprite.getNetworkPolicy()).toEqual({ rules: [] });
  await f.sprite.updateNetworkPolicy({
    rules: [
      { domain: "a.com", action: "allow" },
      { domain: "b.com", action: "deny" },
    ],
  });
  expect(await f.sprite.getNetworkPolicy()).toEqual({
    rules: [
      { domain: "a.com", action: "allow" },
      { domain: "b.com", action: "deny" },
      { domain: "*", action: "deny" },
    ],
  });
  await f.sprite.updateNetworkPolicy({ rules: [{ domain: "*", action: "deny" }] });
  expect(await f.sprite.getNetworkPolicy()).toEqual({ rules: [{ domain: "*", action: "deny" }] });
});

test("killSession signals, waits and reports each step", async () => {
  const f = fake();
  const events = [];
  for await (const event of await f.sprite.killSession("p1", "TERM", "1s")) events.push(event);
  expect(events).toEqual([
    { type: "signal", signal: "SIGTERM" },
    { type: "exited", exitCode: 143 },
    { type: "complete" },
  ]);
  const hung = fake({ hangs: true });
  const steps = [];
  for await (const event of await hung.sprite.killSession("p1", "SIGINT", "20ms"))
    steps.push(event.type);
  expect(steps).toEqual(["signal", "timeout", "killed", "complete"]);
  expect(hung.calls.filter((c) => c.method === "kill").map((c) => c.args)).toEqual([
    "SIGINT",
    "SIGKILL",
  ]);
  await expect(f.sprite.killSession("p1", "SIGSTOP")).rejects.toBeInstanceOf(TypeError);
  await expect(f.sprite.killSession("p1", "TERM", "soon")).rejects.toBeInstanceOf(TypeError);
});

test("maxRunAfterDisconnect and control mode are refused before any call", async () => {
  const f = fake();
  const options = { maxRunAfterDisconnect: "30s" } as never;
  expect(() => f.sprite.spawn("sh", [], options)).toThrow(CompatibilityError);
  expect(() => f.sprite.createSession("sh", [], options)).toThrow(CompatibilityError);
  expect(() => f.sprite.attachSession("p1", options)).toThrow(CompatibilityError);
  expect(() => f.sprite.exec("true", options)).toThrow(CompatibilityError);
  expect(() => f.sprite.execFileHTTP("true", [], { tty: true } as never)).toThrow(
    CompatibilityError,
  );
  await expect(f.sprite.getControlConnection()).rejects.toBeInstanceOf(CompatibilityError);
  expect(() => new OpConn().write()).toThrow(CompatibilityError);
  await expect(new OpConn().wait()).rejects.toBeInstanceOf(CompatibilityError);
  await expect(new ControlConnection().startOp("exec")).rejects.toBeInstanceOf(CompatibilityError);
  expect(() => new ControlConnection().isClosed()).toThrow(CompatibilityError);
  expect(f.calls).toEqual([]);
});

test("services, privilege and resource policies, sprite watching and tokens are refused by name", async () => {
  const f = fake();
  for (const method of [
    "listServices",
    "getService",
    "createService",
    "deleteService",
    "startService",
    "stopService",
    "restartService",
    "getServiceLogs",
    "signalService",
    "getPrivilegesPolicy",
    "updatePrivilegesPolicy",
    "deletePrivilegesPolicy",
    "getResourcesPolicy",
    "updateResourcesPolicy",
    "deleteResourcesPolicy",
  ] as const) {
    const error = await f.sprite[method]().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompatibilityError);
    expect((error as Error).message).toContain(`Sprite.${method}`);
  }
  await expect(f.client.watchSprites()).rejects.toThrow("runtime.events");
  await expect(SpritesClient.createToken("macaroon", "org")).rejects.toThrow("Runtime API key");
  expect(f.calls).toEqual([]);
});

test("asRoot file operations run through sudo and fail as FilesystemError", async () => {
  const f = fake();
  const fs = f.sprite.filesystem("/app");
  await fs.rm("tmp", { recursive: true, asRoot: true });
  await fs.rename("a", "/b", { asRoot: true });
  await fs.chmod("a", 0o4755, { recursive: true, asRoot: true });
  await fs.copyFile("a", "b", { preserveAttrs: true });
  await fs.copyFile("a", "b", { recursive: true, asRoot: true });
  await fs.chown("a", { uid: 1000, gid: "staff", recursive: true, asRoot: true });
  await fs.chown("a", { gid: 5 });
  expect(f.execs).toEqual([
    ["sudo", "-n", "--", "rm", "-f", "-r", "--", "/app/tmp"],
    ["sudo", "-n", "--", "mv", "-f", "-T", "--", "/app/a", "/b"],
    ["sudo", "-n", "--", "chmod", "-R", "4755", "--", "/app/a"],
    ["cp", "--preserve=mode,ownership,timestamps", "--", "/app/a", "/app/b"],
    ["sudo", "-n", "--", "cp", "-R", "--", "/app/a", "/app/b"],
    ["sudo", "-n", "--", "chown", "-R", "1000:staff", "--", "/app/a"],
    ["chown", ":5", "--", "/app/a"],
  ]);
  f.answer([
    { exitCode: 1, stderr: "chown: changing ownership of '/app/a': Operation not permitted" },
  ]);
  await expect(fs.chown("a", { uid: 0 })).rejects.toMatchObject({
    name: "FilesystemError",
    code: "EPERM",
    path: "a",
    syscall: "chown",
  });
  f.answer([{ exitCode: 1, stderr: "rm: cannot remove '/app/x': No such file or directory" }]);
  await expect(fs.rm("x", { force: true, asRoot: true })).rejects.toMatchObject({ code: "ENOENT" });
  const before = f.execs.length;
  await expect(fs.chown("a", {})).rejects.toBeInstanceOf(TypeError);
  await expect(fs.chown("a", { uid: "x:y" })).rejects.toBeInstanceOf(TypeError);
  await expect(fs.chown("a", { uid: -1 })).rejects.toBeInstanceOf(TypeError);
  await expect(fs.chown("a", { uid: 1, owner: 2 } as never)).rejects.toBeInstanceOf(
    CompatibilityError,
  );
  await expect(fs.chmod("a", -1, { asRoot: true })).rejects.toBeInstanceOf(TypeError);
  expect(f.execs.length).toBe(before);
});

test("filesystem watch maps Runtime's file events and stops them on close", async () => {
  const f = fake();
  const watcher = await f.sprite.filesystem("/app").watch(["src", "/etc"], { recursive: true });
  expect(f.calls.filter((c) => c.method === "watch").map((c) => c.args)).toEqual([
    { path: "/app/src", options: { recursive: true, timeoutMs: 0 } },
    { path: "/etc", options: { recursive: true, timeoutMs: 0 } },
  ]);
  expect(await watcher.next()).toEqual({ type: "subscribed", paths: ["/app/src", "/etc"] });
  f.watchers[0]!({ type: "access", path: "/app/src/x", isDir: false });
  f.watchers[0]!({ type: "write", path: "/app/src/x", isDir: false });
  expect(await watcher.next()).toMatchObject({ type: "event", event: "write", path: "/app/src/x" });
  watcher.close();
  expect(watcher.isClosed()).toBe(true);
  expect(await watcher.next()).toBeNull();
  expect(f.calls.filter((c) => c.method === "watch stop")).toHaveLength(2);
  await expect(f.sprite.filesystem().watch([])).rejects.toBeInstanceOf(TypeError);
  await expect(f.sprite.filesystem().watch("a", { depth: 1 } as never)).rejects.toBeInstanceOf(
    CompatibilityError,
  );
});

test("watchPorts lists listening ports, then reports each one opened and closed", async () => {
  const f = fake();
  f.answer([
    { exitCode: 0, stdout: 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=12,fd=19))\n' },
    { exitCode: 0, stdout: "LISTEN 0 4096 [::]:8080 [::]:*\n" },
  ]);
  const watcher = await f.sprite.watchPorts();
  expect(await watcher.next()).toEqual({
    type: "port_list",
    ports: [{ type: "port_opened", port: 3000, address: "0.0.0.0", pid: 12 }],
  });
  expect(await watcher.next()).toEqual({
    type: "port_closed",
    port: 3000,
    address: "0.0.0.0",
    pid: 12,
  });
  expect(await watcher.next()).toEqual({ type: "port_opened", port: 8080, address: "::", pid: 0 });
  watcher.close();
  expect(f.execs.every((argv) => argv.join(" ") === "ss -Hltnp")).toBe(true);
  const broken = fake();
  broken.answer([{ exitCode: 0 }, { exitCode: 127, stderr: "ss: not found" }]);
  const failing = await broken.sprite.watchPorts();
  expect(await failing.next()).toEqual({ type: "port_list", ports: [] });
  await expect(failing.next()).rejects.toThrow("ss: not found");
});

test("proxyPort forwards a local port over Runtime's tunnel", async () => {
  const f = fake();
  const session = await f.sprite.proxyPort(0, 8080);
  expect(f.calls.find((c) => c.method === "forward")?.args).toEqual({
    port: 8080,
    options: { localPort: 0, host: "localhost" },
  });
  expect(session.localAddr()).toBe("localhost:48080");
  const manager = new ProxyManager();
  manager.addSession(session);
  const closed = manager.waitAll();
  manager.closeAll();
  await closed;
  expect(session.localAddr()).toBeNull();
  await expect(session.start()).rejects.toThrow("closed");
  expect(
    () => new ProxySession(f.client, ID, { localPort: 1, remotePort: 5432, remoteHost: "db" }),
  ).toThrow(CompatibilityError);
  expect(() => new ProxySession(f.client, ID, { localPort: 1, remotePort: 70000 })).toThrow(
    TypeError,
  );
});

test("proxyPorts is all or none", async () => {
  const f = fake({ forwardFails: 6000 });
  await expect(
    proxyPorts(f.client, ID, [
      { localPort: 0, remotePort: 5000 },
      { localPort: 0, remotePort: 6000 },
    ]),
  ).rejects.toBeInstanceOf(RuntimeError);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.calls.filter((c) => c.method === "forward close").map((c) => c.args)).toEqual([5000]);
});

test("execFileHTTP writes input to stdin and closes it; without input stdin closes at once", async () => {
  const f = fake();
  expect(await f.sprite.execFileHTTP("cat", [], { input: "hello" })).toEqual({
    stdout: "out",
    stderr: "",
    exitCode: 0,
  });
  expect(f.calls.filter((c) => c.method === "write").map((c) => c.args)).toEqual([
    { data: "hello", eof: undefined },
    { data: "", eof: true },
  ]);
  const empty = fake();
  await empty.sprite.execFileHTTP("cat");
  expect(empty.calls.filter((c) => c.method === "write").map((c) => c.args)).toEqual([
    { data: "", eof: true },
  ]);
});
