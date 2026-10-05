import { afterEach, expect, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connectionOrigins, connectionStore, type SavedConnection } from "../src/credentials";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "runtime-account-lock-"));
  directories.push(directory);
  const env = { XDG_CONFIG_HOME: directory };
  const origins = connectionOrigins(env);
  const saved = (orgId: string): SavedConnection => ({
    version: 1,
    apiOrigin: origins.api,
    authOrigin: origins.auth,
    key: `rtcloud_${randomUUID()}_${randomBytes(32).toString("base64url")}`,
    connectionId: randomUUID(),
    orgId,
    agentName: orgId,
  });
  return { directory, env, saved };
}
async function retained(env: NodeJS.ProcessEnv) {
  const store = connectionStore(env);
  return [(await store.read())!.orgId, ...(await store.others()).map((one) => one.orgId)].sort();
}

test("simultaneous account saves through separate stores retain every connection", async () => {
  const kit = await setup();
  const accounts = Array.from({ length: 8 }, (_, i) => `org-${i}`);
  await Promise.all(accounts.map((account) => connectionStore(kit.env).save(kit.saved(account))));
  expect(await retained(kit.env)).toEqual(accounts);
  expect(
    (await readdir(join(kit.directory, "runtime-cloud"))).some((file) => file.endsWith(".lock")),
  ).toBe(false);
});

test("independent CLI processes serialize account saves", async () => {
  const kit = await setup();
  const source = new URL("../src/credentials.ts", import.meta.url).pathname;
  const connections = [kit.saved("org-a"), kit.saved("org-b")];
  const children = connections.map((connection, index) =>
    Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { connectionStore } from ${JSON.stringify(source)};
     import { access, writeFile } from "node:fs/promises";
     await writeFile(${JSON.stringify(join(kit.directory, `ready-${index}`))}, "ready");
     for (;;) { try { await access(${JSON.stringify(join(kit.directory, "go"))}); break; } catch { await Bun.sleep(5); } }
     await connectionStore(${JSON.stringify(kit.env)}).save(${JSON.stringify(connection)});`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  try {
    const until = performance.now() + 3000;
    while (
      (await readdir(kit.directory)).filter((name) => name.startsWith("ready-")).length !== 2
    ) {
      if (performance.now() >= until)
        throw new Error("Credential subprocesses did not reach the barrier.");
      await Bun.sleep(5);
    }
    await writeFile(join(kit.directory, "go"), "go");
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    expect(await retained(kit.env)).toEqual(["org-a", "org-b"]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
});

test("an interrupted holder fails safely without replacing saved credentials", async () => {
  const kit = await setup();
  const store = connectionStore(kit.env);
  const first = kit.saved("org-a");
  await store.save(first);
  const directory = join(kit.directory, "runtime-cloud");
  const current = (await readdir(directory)).find((file) => file.endsWith(".json"))!;
  const lock = join(dirname(join(directory, current)), current.replace(/\.json$/, ".lock"));
  const dead = Bun.spawn(
    [process.execPath, "--eval", "process.stdout.write(String(process.pid))"],
    { stdout: "pipe" },
  );
  const pid = Number(await new Response(dead.stdout).text());
  expect(await dead.exited).toBe(0);
  await writeFile(lock, JSON.stringify({ pid }), { mode: 0o600 });
  const refused = store.save(kit.saved("org-b"));
  await expect(refused).rejects.toThrow("credential update was interrupted");
  await expect(refused).rejects.toMatchObject({
    name: "CredentialsLockedError",
    reason: "interrupted",
    lockFile: lock,
  });
  expect(await retained(kit.env)).toEqual(["org-a"]);
  expect(JSON.parse(await readFile(join(directory, current), "utf8")).key).toBe(first.key);
  expect(await readFile(lock, "utf8")).toBe(JSON.stringify({ pid }));
});

test("a holder that finishes between the lock's read and its check is waited for, not called interrupted", async () => {
  // Under load a waiter reads the holder's pid, the holder saves, removes its
  // lock and exits, and only then does the waiter ask whether that pid lives.
  // That used to fail the save as an interrupted update (exit 1 in the CLI).
  const kit = await setup();
  const store = connectionStore(kit.env);
  await store.save(kit.saved("org-a"));
  const directory = join(kit.directory, "runtime-cloud");
  const current = (await readdir(directory)).find((file) => file.endsWith(".json"))!;
  const lock = join(directory, current.replace(/\.json$/, ".lock"));
  const finished = Bun.spawn(
    [process.execPath, "--eval", "process.stdout.write(String(process.pid))"],
    { stdout: "pipe" },
  );
  const pid = Number(await new Response(finished.stdout).text());
  expect(await finished.exited).toBe(0);
  await writeFile(lock, JSON.stringify({ pid }), { mode: 0o600 });
  const real = process.kill.bind(process);
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    // The holder finished just before this check: its lock is gone.
    if (target === pid) unlinkSync(lock);
    return real(target, signal);
  });
  try {
    await store.save(kit.saved("org-b"));
  } finally {
    kill.mockRestore();
  }
  expect(await retained(kit.env)).toEqual(["org-a", "org-b"]);
  expect((await readdir(directory)).some((file) => file.endsWith(".lock"))).toBe(false);
});

test("malformed archived connections cannot replace the active credential", async () => {
  const kit = await setup();
  const store = connectionStore(kit.env);
  await store.save(kit.saved("current"));
  const directory = join(kit.directory, "runtime-cloud");
  const current = (await readdir(directory)).find((file) => file.endsWith(".json"))!;
  const malformed = kit.saved("malformed");
  const { connectionId: _connection, ...withoutConnection } = malformed;
  const { agentName: _name, ...withoutName } = malformed;
  await writeFile(
    join(directory, current.replace(/\.json$/, ".accounts.json")),
    JSON.stringify([
      { ...malformed, orgName: 17 },
      withoutConnection,
      withoutName,
      kit.saved("valid"),
    ]),
    { mode: 0o600 },
  );
  expect((await store.others()).map((one) => one.orgId)).toEqual(["valid"]);
  expect(await store.use("malformed")).toBeNull();
  expect(await store.use("missing-name")).toBeNull();
  expect((await store.read())!.orgId).toBe("current");
  expect((await store.use("valid"))!.orgId).toBe("valid");
});

test("null saved JSON reports the named invalid-connection error", async () => {
  const kit = await setup();
  const store = connectionStore(kit.env);
  await store.save(kit.saved("current"));
  const directory = join(kit.directory, "runtime-cloud");
  const current = (await readdir(directory)).find((file) => file.endsWith(".json"))!;
  await writeFile(join(directory, current), "null", { mode: 0o600 });
  await expect(store.read()).rejects.toThrow("saved connection is invalid. Connect again.");
});

test("a lock close error cannot strand the account-update lock", async () => {
  const kit = await setup();
  const store = connectionStore(kit.env);
  const original = filesystem.open;
  const failure = new Error("synthetic lock close failure");
  const mocked = spyOn(filesystem, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith(".lock")) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw failure;
      };
    }
    return handle;
  });
  try {
    // The exact error proves that the filesystem fault was actually injected.
    await expect(store.save(kit.saved("first"))).rejects.toBe(failure);
  } finally {
    mocked.mockRestore();
  }
  expect(
    (await readdir(join(kit.directory, "runtime-cloud"))).some((file) => file.endsWith(".lock")),
  ).toBe(false);
  await store.save(kit.saved("second"));
  expect(await retained(kit.env)).toEqual(["first", "second"]);
});
