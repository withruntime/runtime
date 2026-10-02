import { beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import {
  NotSupportedError,
  Sandbox,
  SandboxUser,
  SandboxUserAlreadyExistsError,
  type CreateSandboxParams,
} from "../../src/vercel/index";
import { DropInWorld } from "../drop-in-fake";

/* Calls the Vercel drop-in once refused and now carries out: users and
   groups, timeouts over an hour, and list filters,
   sorting and cursors. */

let world: DropInWorld;
const client = () => {
  const made = world.client() as unknown as Record<string, unknown>;
  made.transport = { baseUrl: "https://api.withruntime.com" };
  return made as never;
};
const create = (params: CreateSandboxParams = {}) =>
  Sandbox.create({ ...params, withruntime: { client: client(), ...params.withruntime } });
const fake = (sandbox: Sandbox) => world.sandboxes.get(sandbox.withruntime.id)!;
const argvs = () => world.called("sandbox.exec").map(([argv]) => argv as string[]);

beforeEach(() => {
  world = new DropInWorld();
});

describe("users and groups", () => {
  test("createUser makes a real Linux user the way Vercel does, with sudo", async () => {
    const sandbox = await create();
    const alice = await sandbox.createUser("alice");
    expect(alice).toBeInstanceOf(SandboxUser);
    expect([alice.username, alice.homeDir]).toEqual(["alice", "/home/alice"]);
    expect(argvs()).toEqual([
      ["sudo", "--preserve-env", "useradd", "-m", "-s", "/bin/bash", "alice"],
      ["sudo", "--preserve-env", "chown", "alice:runtime", "/home/alice"],
      ["sudo", "--preserve-env", "chmod", "770", "/home/alice"],
    ]);
  });

  test("an existing user is SandboxUserAlreadyExistsError, a bad name refused first", async () => {
    const sandbox = await create();
    world.exec = () => ({ exitCode: 9, stderr: "useradd: user 'alice' already exists\n" });
    const error = await sandbox.createUser("alice").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxUserAlreadyExistsError);
    expect((error as SandboxUserAlreadyExistsError).username).toBe("alice");
    const before = argvs().length;
    expect(await sandbox.createUser("Bob; rm -rf /").catch((e: Error) => e.message)).toMatch(
      /Invalid username/,
    );
    expect(argvs()).toHaveLength(before);
  });

  test("a user's commands run under sudo -u in its home, with env surviving sudo", async () => {
    const sandbox = await create();
    const alice = sandbox.asUser("alice");
    await alice.runCommand({ cmd: "whoami", env: { A: "1" } });
    expect(argvs().at(-1)).toEqual([
      "sudo",
      "-u",
      "alice",
      "--",
      "bash",
      "-c",
      'cd "$1" || exit 1; shift; exec "$@"',
      "bash",
      "/home/alice",
      "env",
      "A=1",
      "whoami",
    ]);
    await sandbox.asUser("root").runCommand("id");
    expect(argvs().at(-1)!.slice(0, 3)).toEqual(["sudo", "-u", "root"]);
    expect(argvs().at(-1)![8]).toBe("/root");
  });

  test("a user's files are written then given to it; reads go through the user", async () => {
    const sandbox = await create();
    world.exec = (command) => {
      const argv = command as unknown as string[];
      if (argv[0] === "id") return { exitCode: 0, stdout: "alice\n" };
      if (argv.includes("base64")) return { exitCode: 0, stdout: "aGk=\n" };
      return { exitCode: 0 };
    };
    const alice = sandbox.asUser("alice");
    await alice.writeFiles([{ path: "notes/a.txt", content: "hi" }]);
    expect(world.called("files.write").at(-1)![0]).toBe("/home/alice/notes/a.txt");
    expect(argvs()).toContainEqual([
      "sudo",
      "--preserve-env",
      "chown",
      "alice:alice",
      "/home/alice/notes/a.txt",
    ]);
    expect(argvs()).toContainEqual([
      "sudo",
      "--preserve-env",
      "chown",
      "alice:runtime",
      "/home/alice/notes",
    ]);
    expect((await alice.readFileToBuffer({ path: "notes/a.txt" }))!.toString()).toBe("hi");
    world.exec = () => ({ exitCode: 1, stderr: "base64: x: No such file or directory\n" });
    expect(await alice.readFileToBuffer({ path: "x" })).toBeNull();
  });

  test("groups: groupadd with a setgid shared directory, usermod, gpasswd", async () => {
    const sandbox = await create();
    expect(await sandbox.createGroup("devs")).toEqual({
      groupname: "devs",
      sharedDir: "/shared/devs",
    });
    await sandbox.addUserToGroup("alice", "devs");
    await sandbox.removeUserFromGroup("alice", "devs");
    expect(argvs().map((argv) => argv.slice(2).join(" "))).toEqual([
      "groupadd devs",
      "mkdir -p /shared/devs",
      "chown runtime:devs /shared/devs",
      "chmod 2770 /shared/devs",
      "usermod -aG devs alice",
      "gpasswd -d alice devs",
    ]);
  });
});

describe("timeouts over an hour", () => {
  test("a 3-hour timeout starts with an hour's lease and reports 3 hours", async () => {
    const sandbox = await create({ timeout: 3 * 3_600_000 });
    expect(world.called("sandboxes.create").at(-1)![0]).toMatchObject({ timeoutSeconds: 3600 });
    expect(sandbox.timeout).toBe(3 * 3_600_000);
  });

  test("the lease is extended near its end, an hour at a time, never past the timeout", async () => {
    const sandbox = await create({ timeout: 70 * 60_000 });
    const asked = Date.now() + 70 * 60_000;
    const runtime = fake(sandbox);
    const end = () => Date.parse(runtime.info.expiresAt);
    // Far from its end: no call.
    await sandbox.runCommand("ls");
    expect(world.called("sandbox.extend")).toHaveLength(0);
    // Five minutes left: moved to an hour ahead, the most one lease may run.
    runtime.info.expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await sandbox.runCommand("ls");
    expect(Math.abs(end() - (Date.now() + 3_600_000))).toBeLessThan(2000);
    // 55 minutes on, five minutes left again: moved to the 70 minutes asked
    // for, no further.
    setSystemTime(new Date(Date.now() + 55 * 60_000));
    try {
      await sandbox.runCommand("ls");
    } finally {
      setSystemTime();
    }
    expect(world.called("sandbox.extend")).toHaveLength(2);
    expect(Math.abs(end() - asked)).toBeLessThan(2000);
    expect(end()).toBeLessThanOrEqual(asked + 1000);
  });

  test("with no calls at all, the lease is renewed while the object lives", async () => {
    jest.useFakeTimers();
    try {
      const sandbox = await create({ timeout: 3 * 3_600_000 });
      const start = Date.now();
      for (let minute = 0; minute < 240; minute++) {
        jest.advanceTimersByTime(60_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      expect(world.called("sandbox.extend").length).toBeGreaterThan(1);
      const end = Date.parse(fake(sandbox).info.expiresAt);
      expect(end).toBeLessThanOrEqual(start + 3 * 3_600_000 + 1000);
      expect(end).toBeGreaterThan(start + 170 * 60_000);
    } finally {
      jest.useRealTimers();
    }
  });

  test("extendTimeout past an hour moves the timeout; the lease follows", async () => {
    const sandbox = await create({ timeout: 30 * 60_000 });
    await sandbox.extendTimeout(2 * 3_600_000);
    expect(sandbox.timeout).toBe(150 * 60_000);
    const [[, seconds]] = world.called("sandbox.extend") as [[string, number]];
    // At most an hour ahead of now, the API's limit.
    expect(Date.parse(fake(sandbox).info.expiresAt) - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(seconds).toBeGreaterThan(29 * 60);
  });

  test("update shortens a timeout the lease has not reached; earlier than the lease is refused", async () => {
    const sandbox = await create({ timeout: 3 * 3_600_000 });
    await sandbox.update({ timeout: 2 * 3_600_000 });
    expect(sandbox.timeout).toBe(2 * 3_600_000);
    const error = await sandbox.update({ timeout: 10 * 60_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as Error).message).toMatch(/earlier than the current lease/);
    expect(sandbox.timeout).toBe(2 * 3_600_000);
  });

  test("a non-persistent sandbox's extensions end with stop()", async () => {
    const sandbox = await create({ timeout: 3 * 3_600_000, persistent: false });
    await sandbox.stop();
    const runtime = fake(sandbox);
    runtime.info.state = "running";
    runtime.info.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await sandbox.mkDir("x");
    expect(world.called("sandbox.extend")).toHaveLength(0);
  });
});

describe("list filters, sorting and cursors", () => {
  test("namePrefix, sortBy and sortOrder apply to every sandbox", async () => {
    for (const name of ["web-b", "api", "web-a", "web-c"]) await create({ name });
    const result = await Sandbox.list({
      namePrefix: "web-",
      sortBy: "name",
      sortOrder: "desc",
      withruntime: { client: client() },
    });
    expect(result.sandboxes.map((one) => one.name)).toEqual(["web-c", "web-b", "web-a"]);
    expect(result.pagination).toEqual({ count: 3, next: null });
  });

  test("a limit pages with a cursor that a later call continues from", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) await create({ name });
    const first = await Sandbox.list({
      limit: 2,
      sortBy: "name",
      withruntime: { client: client() },
    });
    expect(first.sandboxes.map((one) => one.name)).toEqual(["a", "b"]);
    expect(first.pagination.next).not.toBeNull();
    const second = await Sandbox.list({
      limit: 2,
      sortBy: "name",
      cursor: first.pagination.next!,
      withruntime: { client: client() },
    });
    expect(second.sandboxes.map((one) => one.name)).toEqual(["c", "d"]);
    const pages: string[][] = [];
    for await (const page of first.pages()) pages.push(page.sandboxes.map((one) => one.name));
    expect(pages).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect((await first.toArray()).map((one) => one.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("a cursor this adapter did not make is refused clearly", async () => {
    const error = await Sandbox.list({ cursor: "abc", withruntime: { client: client() } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RangeError);
  });
});
