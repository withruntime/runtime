import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  CommandExitError,
  E2B,
  FileNotFoundError,
  FileType,
  FilesystemEventType,
  InvalidArgumentError,
  NotSupportedError,
  pidOf,
  Sandbox,
  SandboxNotFoundError,
  Secret,
  Template,
  TemplateError,
  TimeoutError,
  Volume,
  waitForPort,
  type SandboxOpts,
} from "../../src/e2b/index";
import { pickKey } from "../../src/e2b/client";
import { FakeWorld, type FakeSandbox } from "./fake";

let world: FakeWorld;
const runtime = () => ({ runtime: { client: world.client() } });
const create = (opts: SandboxOpts = {}) =>
  Sandbox.create({ ...opts, runtime: { client: world.client(), ...opts.runtime } });
const fake = (sbx: Sandbox) => world.sandboxes.get(sbx.sandboxId)!;
const lastCreate = () => world.called("sandboxes.create").at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  world = new FakeWorld();
});

describe("Sandbox.create", () => {
  test("gives E2B's default machine and timeout, and leaves funding to Runtime", async () => {
    const sbx = await create();
    expect(lastCreate()).toEqual({
      vcpu: 2,
      memoryMiB: 512,
      timeoutSeconds: 300,
      onLeaseEnd: "stop",
    });
    expect(sbx.sandboxId).toBe(fake(sbx).id);
    expect(world.called("images.list")).toEqual([]);
  });

  test("maps timeoutMs, metadata, internet access and lifecycle", async () => {
    await create({
      timeoutMs: 120_500,
      metadata: { job: "eval-7" },
      allowInternetAccess: false,
      lifecycle: { onTimeout: "pause" },
    });
    expect(lastCreate()).toMatchObject({
      timeoutSeconds: 121,
      labels: { job: "eval-7" },
      network: { internet: false },
      onLeaseEnd: "pause",
      autoWake: false,
    });
    // autoResume is Runtime's automatic wake (0093).
    await create({ lifecycle: { onTimeout: "pause", autoResume: true } });
    expect(lastCreate()).toMatchObject({ onLeaseEnd: "pause", autoWake: true });
  });

  test("passes Runtime-only fields over the adapter's", async () => {
    await create({ runtime: { create: { funding: "trial", memoryMiB: 4096 } } });
    expect(lastCreate()).toMatchObject({ funding: "trial", memoryMiB: 4096, vcpu: 2 });
  });

  test("rounds a timeout under a minute up to Runtime's shortest lease", async () => {
    await create({ timeoutMs: 5_000 });
    expect(lastCreate().timeoutSeconds).toBe(60);
  });

  test("refuses what it cannot honour, before creating anything", async () => {
    const cases: Array<[SandboxOpts, RegExp]> = [
      [{ timeoutMs: 2 * 3_600_000 }, /over one hour/],
      [{ lifecycle: { onTimeout: { action: "pause", keepMemory: false } } }, /files-only pause/],
      [{ mcp: {} }, /MCP gateway/],
      [{ network: { denyOut: ["0.0.0.0/0"] } }, /network rules/],
      [{ iam: {} }, /workload identity/],
      [{ volumeMounts: { "/data": "v" } }, /volumes/],
      [{ domain: "e2b.app" }, /"domain"/],
      [{ debug: true }, /debug mode/],
    ];
    for (const [opts, message] of cases) {
      const error = await create(opts).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as Error).message).toMatch(message);
      expect((error as NotSupportedError).alternative.length).toBeGreaterThan(0);
    }
    expect(world.called("sandboxes.create")).toEqual([]);
  });

  test("Secret points at Runtime secrets, which the sandbox never sees", () => {
    const error = (() => {
      try {
        (Secret as unknown as () => unknown)();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as NotSupportedError).alternative).toContain("withruntime secrets set");
  });

  test("refuses a non-positive timeout", async () => {
    expect(await create({ timeoutMs: 0 }).catch((e: unknown) => e)).toBeInstanceOf(
      InvalidArgumentError,
    );
  });
});

describe("templates", () => {
  test("base and the code interpreter's template are Runtime's stock image", async () => {
    await Sandbox.create("base", runtime());
    await Sandbox.create("code-interpreter-v1", runtime());
    expect(world.called("sandboxes.create").map(([input]) => input)).toEqual([
      expect.not.objectContaining({ image: expect.anything() }),
      expect.not.objectContaining({ image: expect.anything() }),
    ]);
  });

  test("a name is a ready Runtime image of that name", async () => {
    world.images.push({ id: "img-1", name: "my-agent", state: "ready" });
    await Sandbox.create("my-agent", runtime());
    expect(world.called("images.list")[0]).toEqual([
      { name: "my-agent", state: "ready", limit: 1 },
    ]);
    expect(lastCreate()).toMatchObject({ image: "img-1", vcpu: 2, memoryMiB: 512 });
  });

  test("an E2B template with no Runtime image says how to build one", async () => {
    const error = await Sandbox.create("abc123xyz", runtime()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as Error).message).toContain("--name abc123xyz");
    expect(world.called("sandboxes.create")).toEqual([]);
  });

  test("a UUID is an image when one exists, else a snapshot, which keeps its own shape", async () => {
    const image = "11111111-2222-4333-8444-555555555555";
    world.images.push({ id: image, name: null, state: "ready" });
    await Sandbox.create(image, runtime());
    expect(lastCreate()).toMatchObject({ image });
    const snapshot = "99999999-2222-4333-8444-555555555555";
    await Sandbox.create(snapshot, runtime());
    expect(lastCreate()).toEqual({ snapshot, timeoutSeconds: 300, onLeaseEnd: "stop" });
  });

  test("a snapshot while forks are off fails with Runtime's own words", async () => {
    world.forksEnabled = false;
    const error = await Sandbox.create("99999999-2222-4333-8444-555555555555", runtime()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as Error).message).toContain("Forks are paused");
  });
});

describe("keys", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("an E2B key is never used", () => {
    delete process.env.RUNTIME_API_KEY;
    process.env.E2B_API_KEY = "e2b_abc";
    expect(pickKey()).toBeUndefined();
    expect(() => pickKey("e2b_abc")).toThrow(AuthenticationError);
  });

  test("RUNTIME_API_KEY first, then a Runtime key left in E2B_API_KEY", () => {
    process.env.RUNTIME_API_KEY = "rk_runtime";
    process.env.E2B_API_KEY = "rk_other";
    expect(pickKey()).toBe("rk_runtime");
    expect(pickKey("e2b_abc")).toBe("rk_runtime");
    expect(pickKey("rk_given")).toBe("rk_given");
    delete process.env.RUNTIME_API_KEY;
    expect(pickKey()).toBe("rk_other");
  });
});

describe("commands.run", () => {
  test("resolves with E2B's result and passes cwd, envs and timeout", async () => {
    // The sandbox's envs are Runtime's to keep (its create's env); a command's
    // own go with the command, and Runtime puts them over the sandbox's.
    const sbx = await create({ envs: { A: "1", B: "2" } });
    expect(lastCreate().env).toEqual({ A: "1", B: "2" });
    const seen: string[] = [];
    const result = await sbx.commands.run("echo hi", {
      cwd: "/tmp",
      envs: { B: "3" },
      onStdout: (text) => void seen.push(text),
    });
    expect(result).toEqual({ exitCode: 0, error: "", stdout: "ran echo hi\n", stderr: "" });
    expect(seen).toEqual(["ran echo hi\n"]);
    const [command, options] = world.called("sandbox.spawn").at(-1)!;
    expect(command).toBe("echo hi");
    expect(options).toMatchObject({ cwd: "/tmp", env: { B: "3" } });
  });

  test("returns the whole output, past the 64 KiB an exec result holds, as E2B does", async () => {
    // The judge panel's reproduction: python3 -c 'print("x"*70000)'.
    world.exec = () => ({
      exitCode: 0,
      stdout: `${"x".repeat(70_000)}\n`,
      stderr: "y".repeat(70_000),
    });
    const sbx = await create();
    const result = await sbx.commands.run(`python3 -c 'print("x"*70000)'`, { timeoutMs: 60_000 });
    expect(result.stdout.length).toBe(70_001);
    expect(result.stderr.length).toBe(70_000);
    expect(result.exitCode).toBe(0);
  });

  test("says when output was dropped, where E2B's result has no room to", async () => {
    // A customer's report, 24 September 2026: output lost in a stream came
    // back looking whole.
    const warnings: string[] = [];
    const listen = (warning: Error) => void warnings.push(warning.message);
    process.on("warning", listen);
    try {
      world.exec = () => ({ exitCode: 0, stdout: "tail\n", lost: true });
      const sbx = await create();
      const result = await sbx.commands.run("big");
      expect(result).toEqual({
        exitCode: 0,
        error: "",
        stdout: "tail\n",
        stderr: "",
        truncated: true,
      });
      world.exec = () => ({ exitCode: 1, stdout: "tail\n", lost: true });
      const error = (await sbx.commands.run("big").catch((e: unknown) => e)) as CommandExitError;
      expect(error.truncated).toBe(true);
      world.exec = () => ({ exitCode: 0, stdout: "whole\n" });
      expect(await sbx.commands.run("small")).not.toHaveProperty("truncated");
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("output was dropped");
    } finally {
      process.off("warning", listen);
    }
  });

  test("throws CommandExitError carrying the result on a non-zero exit", async () => {
    world.exec = () => ({ exitCode: 3, stdout: "partial\n", stderr: "boom\n" });
    const sbx = await create();
    const error = await sbx.commands.run("exit 3").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandExitError);
    const exit = error as CommandExitError;
    expect([exit.exitCode, exit.stdout, exit.stderr, exit.error]).toEqual([
      3,
      "partial\n",
      "boom\n",
      "exit status 3",
    ]);
    expect(exit.message).toBe("exit status 3");
  });

  test("a timeout throws TimeoutError; 0 means no limit", async () => {
    world.exec = () => ({ exitCode: null, stdout: "", timedOut: true });
    const sbx = await create();
    expect(
      await sbx.commands.run("sleep 9", { timeoutMs: 1000 }).catch((e: unknown) => e),
    ).toBeInstanceOf(TimeoutError);
    world.exec = () => ({ exitCode: 0 });
    await sbx.commands.run("true", { timeoutMs: 0 });
    expect(world.called("sandbox.spawn").at(-1)![1]).not.toHaveProperty("timeoutMs");
  });

  test("a command killed by a signal exits -1", async () => {
    world.exec = () => ({ exitCode: null, stderr: "" });
    const sbx = await create();
    const error = (await sbx.commands
      .run("kill -9 $$")
      .catch((e: unknown) => e)) as CommandExitError;
    expect([error.exitCode, error.error]).toEqual([-1, "terminated by a signal"]);
  });

  test("refuses another user rather than running as someone else", async () => {
    const sbx = await create();
    expect(await sbx.commands.run("id", { user: "root" }).catch((e: unknown) => e)).toBeInstanceOf(
      NotSupportedError,
    );
    await sbx.commands.run("id", { user: "user" });
  });

  test("links /home/user to /workspace once, when something names it", async () => {
    const sbx = await create();
    await sbx.commands.run("ls");
    expect(world.called("sandbox.spawn").map(([command]) => command)).toEqual(["ls"]);
    expect(world.called("sandbox.exec")).toHaveLength(0);
    await sbx.commands.run("cat /home/user/a.txt");
    await sbx.files.write("/home/user/b.txt", "b");
    await sbx.commands.run("ls", { cwd: "/home/user" });
    const commands = world.calls
      .filter(([method]) => method === "sandbox.exec" || method === "sandbox.spawn")
      .map(([, command]) => command);
    expect(commands.filter((command) => String(command).includes("ln -s"))).toEqual([
      "[ -e /home/user ] || sudo ln -s /workspace /home/user",
    ]);
    expect(commands.indexOf("[ -e /home/user ] || sudo ln -s /workspace /home/user")).toBe(1);
  });
});

describe("background commands", () => {
  test("return a handle whose wait gives the result", async () => {
    const sbx = await create();
    const seen: string[] = [];
    const handle = await sbx.commands.run("python3 server.py", {
      background: true,
      onStdout: (text) => void seen.push(text),
    });
    const process = fake(sbx).processList[0]!;
    expect(handle.pid).toBe(pidOf(process.id));
    expect(await handle.wait()).toEqual({
      exitCode: 0,
      error: "",
      stdout: "ran python3 server.py\n",
      stderr: "",
    });
    expect(seen).toEqual(["ran python3 server.py\n"]);
    expect(handle.exitCode).toBe(0);
  });

  test("wait says when output was dropped before it was read", async () => {
    world.output = () => [
      { type: "truncated", droppedBytes: 10, resumeAt: 10 },
      { type: "stdout", data: "tail\n", offset: 10 },
      { type: "exit", exitCode: 0, state: "exited", timedOut: false },
    ];
    const sbx = await create();
    const handle = await sbx.commands.run("big", { background: true });
    expect(await handle.wait()).toEqual({
      exitCode: 0,
      error: "",
      stdout: "tail\n",
      stderr: "",
      truncated: true,
    });
  });

  test("wait throws CommandExitError on a non-zero exit", async () => {
    world.output = () => [
      { type: "stderr", data: "bad\n", offset: 0 },
      { type: "exit", exitCode: 2, state: "exited", timedOut: false },
    ];
    const sbx = await create();
    const handle = await sbx.commands.run("false", { background: true });
    const error = (await handle.wait().catch((e: unknown) => e)) as CommandExitError;
    expect(error).toBeInstanceOf(CommandExitError);
    expect([error.exitCode, error.stderr]).toEqual([2, "bad\n"]);
  });

  test("stdin, kill, list, connect and kill by pid", async () => {
    world.output = () => [{ type: "stdout", data: "ready\n", offset: 0 }];
    const sbx = await create();
    const closed = await sbx.commands.run("cat", { background: true });
    expect(await closed.sendStdin("x").catch((e: unknown) => e)).toBeInstanceOf(
      InvalidArgumentError,
    );
    const open = await sbx.commands.run("cat", { background: true, stdin: true });
    await open.sendStdin("hello\n");
    await open.closeStdin();
    const process = fake(sbx).processList[1]!;
    expect(world.called("process.write")).toEqual([
      [process.id, "hello\n", {}],
      [process.id, "", { eof: true }],
    ]);
    expect(world.called("sandbox.spawn")[1]![1]).toMatchObject({ stdin: "pipe" });

    const listed = await sbx.commands.list();
    expect(listed.map((one) => one.pid)).toContain(open.pid);
    expect(listed[0]).toMatchObject({ cmd: "/bin/bash", args: ["-c", "cat"] });

    await sbx.commands.sendStdin(open.pid, "more");
    const attached = await sbx.commands.connect(open.pid);
    expect(attached.pid).toBe(open.pid);
    expect(await sbx.commands.kill(open.pid)).toBe(true);
    expect(process.killed).toBe("SIGKILL");
    expect(await sbx.commands.kill(12345)).toBe(false);
    expect(await closed.kill()).toBe(true);
  });
});

describe("files", () => {
  test("write and read text, bytes and blobs; relative paths land in the home", async () => {
    const sbx = await create();
    expect(await sbx.files.write("notes/a.txt", "hello")).toEqual({
      name: "a.txt",
      type: FileType.FILE,
      path: "/workspace/notes/a.txt",
    });
    expect(await sbx.files.read("/workspace/notes/a.txt")).toBe("hello");
    expect(await sbx.files.read("notes/a.txt", { format: "bytes" })).toEqual(
      new TextEncoder().encode("hello"),
    );
    expect(await (await sbx.files.read("notes/a.txt", { format: "blob" })).text()).toBe("hello");
    const stream = await sbx.files.read("notes/a.txt", { format: "stream" });
    expect(await new Response(stream).text()).toBe("hello");
    const many = await sbx.files.write([
      { path: "/workspace/b.bin", data: new Uint8Array([1, 2]).buffer },
      { path: "/workspace/c.txt", data: new Blob(["c"]) },
    ]);
    expect(many.map((one) => one.path)).toEqual(["/workspace/b.bin", "/workspace/c.txt"]);
    expect(fake(sbx).fileMap.get("/workspace/b.bin")).toEqual(new Uint8Array([1, 2]));
  });

  test("list, info, exists, makeDir, rename, remove", async () => {
    const sbx = await create();
    await sbx.files.write("/workspace/d/x.py", "print(1)");
    const [entry] = await sbx.files.list("/workspace/d");
    expect(entry).toMatchObject({
      name: "x.py",
      path: "/workspace/d/x.py",
      type: FileType.FILE,
      size: 8,
      mode: 0o644,
      permissions: "rw-r--r--",
    });
    expect(world.called("files.list")[0]![1]).toEqual({ depth: 1, hidden: true });
    expect((await sbx.files.getInfo("/workspace/d")).type).toBe(FileType.DIR);
    expect(await sbx.files.exists("/workspace/d/x.py")).toBe(true);
    expect(await sbx.files.makeDir("/workspace/d")).toBe(false);
    expect(await sbx.files.makeDir("/workspace/e")).toBe(true);
    const moved = await sbx.files.rename("/workspace/d/x.py", "/workspace/d/y.py");
    expect(moved.path).toBe("/workspace/d/y.py");
    expect(world.called("files.rename")[0]![2]).toEqual({ overwrite: true });
    await sbx.files.remove("/workspace/d");
    expect(world.called("files.remove")[0]).toEqual(["/workspace/d", { recursive: true }]);
    expect(await sbx.files.exists("/workspace/d/y.py")).toBe(false);
  });

  test("a missing file is FileNotFoundError", async () => {
    const sbx = await create();
    const error = await sbx.files.read("/workspace/none").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileNotFoundError);
    expect((error as FileNotFoundError).code).toBe("file_not_found");
    expect((error as FileNotFoundError).requestId).toBe("req_1");
    expect(await sbx.files.getInfo("/workspace/none").catch((e: unknown) => e)).toBeInstanceOf(
      FileNotFoundError,
    );
  });

  test("watchDir runs on Runtime's watch: names relative to the directory, E2B's types", async () => {
    const sbx = await create();
    fake(sbx).watchEvents = [
      { type: "create", path: "/workspace/app/a.txt", isDir: false },
      { type: "write", path: "/workspace/app/sub/b.txt", isDir: false },
    ];
    const seen: unknown[] = [];
    const handle = await sbx.files.watchDir("app", (event) => void seen.push(event), {
      recursive: true,
      timeoutMs: 0,
    });
    expect(seen).toEqual([
      { name: "a.txt", type: FilesystemEventType.CREATE },
      { name: "sub/b.txt", type: FilesystemEventType.WRITE },
    ]);
    expect(world.called("files.watch")[0]).toMatchObject([
      "/workspace/app",
      { recursive: true, timeoutMs: 0 },
    ]);
    await handle.stop();
    expect(world.called("files.watch.stop")).toEqual([["/workspace/app"]]);
  });

  test("refuses other users and metadata", async () => {
    const sbx = await create();
    expect(
      await sbx.files.read("/etc/shadow", { user: "root" }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
    expect(
      await sbx.files.write("/workspace/a", "a", { metadata: { k: "v" } }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
  });
});

describe("lifecycle", () => {
  test("kill stops once, without waiting; unknown ids are false", async () => {
    const sbx = await create();
    expect(await sbx.kill()).toBe(true);
    expect(world.called("sandbox.stop")[0]![1]).toEqual({ wait: false });
    expect(await sbx.kill()).toBe(false);
    expect(await Sandbox.kill(sbx.sandboxId, runtime())).toBe(false);
    expect(await Sandbox.kill("nope", runtime())).toBe(false);
  });

  test("setTimeout moves the end later and refuses to move it earlier", async () => {
    const sbx = await create({ timeoutMs: 120_000 });
    await sbx.setTimeout(600_000);
    const [, seconds] = world.called("sandbox.extend")[0]!;
    expect(seconds as number).toBeGreaterThanOrEqual(479);
    expect(seconds as number).toBeLessThanOrEqual(481);
    expect(await sbx.setTimeout(60_000).catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
    await Sandbox.setTimeout(sbx.sandboxId, 900_000, runtime());
    expect(world.called("sandbox.extend")).toHaveLength(2);
  });

  test("getInfo, isRunning, pause and connect", async () => {
    const sbx = await create({ metadata: { a: "b" } });
    expect(await sbx.getInfo()).toMatchObject({
      sandboxId: sbx.sandboxId,
      templateId: "base",
      metadata: { a: "b" },
      state: "running",
      cpuCount: 2,
      memoryMB: 512,
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
    expect(await sbx.isRunning()).toBe(true);
    expect(await sbx.pause()).toBe(true);
    expect(await sbx.betaPause()).toBe(false);
    expect(await sbx.isRunning()).toBe(false);
    const again = await Sandbox.connect(sbx.sandboxId, { ...runtime(), timeoutMs: 600_000 });
    expect(world.called("sandbox.wake")[0]![1]).toEqual({ timeoutSeconds: 600 });
    expect(await again.isRunning()).toBe(true);
    expect(
      await Sandbox.connect(sbx.sandboxId, { ...runtime(), onResume: "reboot" }).catch(
        (e: unknown) => e,
      ),
    ).toBeInstanceOf(NotSupportedError);
    await sbx.kill();
    expect(await Sandbox.connect(sbx.sandboxId, runtime()).catch((e: unknown) => e)).toBeInstanceOf(
      SandboxNotFoundError,
    );
    expect(await Sandbox.connect("nope", runtime()).catch((e: unknown) => e)).toBeInstanceOf(
      SandboxNotFoundError,
    );
  });

  test("pause refuses a files-only pause", async () => {
    const sbx = await create();
    expect(await sbx.pause({ keepMemory: false }).catch((e: unknown) => e)).toBeInstanceOf(
      NotSupportedError,
    );
  });
});

describe("Sandbox.list", () => {
  test("pages through running and paused sandboxes by metadata", async () => {
    const a = await create({ metadata: { suite: "x" } });
    await create({ metadata: { suite: "y" } });
    const c = await create({ metadata: { suite: "x" } });
    await c.pause();
    const paginator = Sandbox.list({ ...runtime(), query: { metadata: { suite: "x" } }, limit: 1 });
    const seen = [];
    while (paginator.hasNext) seen.push(...(await paginator.nextItems()));
    expect(seen.map((one) => [one.sandboxId, one.state])).toEqual([
      [a.sandboxId, "running"],
      [c.sandboxId, "paused"],
    ]);
    expect(world.called("sandboxes.list")[0]![0]).toEqual({
      state: ["starting", "running", "resuming", "pausing", "paused"],
      labels: { suite: "x" },
      limit: 1,
    });
  });

  test("refuses filters Runtime does not have", () => {
    expect(() => Sandbox.list({ ...runtime(), query: { template: "mine" } })).toThrow(
      NotSupportedError,
    );
    expect(() => Sandbox.list({ ...runtime(), order: "desc" })).toThrow(NotSupportedError);
    expect(() => Sandbox.list({ ...runtime(), query: { startedAfter: new Date() } })).toThrow(
      NotSupportedError,
    );
  });
});

describe("forks, snapshots and ports", () => {
  test("forks and snapshots go through while Runtime has them on", async () => {
    const sbx = await create({ envs: { K: "v" } });
    const forks = await sbx.fork({ count: 2 });
    expect(forks).toHaveLength(2);
    expect(forks[0]).toBeInstanceOf(Sandbox);
    const more = await Sandbox.fork(sbx.sandboxId, { ...runtime(), count: 1 });
    expect(more).toHaveLength(1);
    expect(
      await Sandbox.fork(sbx.sandboxId, { ...runtime(), timeoutMs: 60_000 }).catch(
        (e: unknown) => e,
      ),
    ).toBeInstanceOf(NotSupportedError);
    expect(world.called("sandbox.fork")).toHaveLength(2);
    expect(world.called("sandbox.extend")).toEqual([]);
    const snapshot = await sbx.createSnapshot({ name: "s" });
    expect(snapshot.names).toEqual(["s"]);
    expect(await Sandbox.deleteSnapshot(snapshot.snapshotId, runtime())).toBe(true);
    expect(await Sandbox.deleteSnapshot(snapshot.snapshotId, runtime())).toBe(false);
  });

  test("while they are off, they say so in Runtime's words", async () => {
    world.forksEnabled = false;
    const sbx = await create();
    for (const attempt of [sbx.fork(), sbx.createSnapshot()]) {
      const error = await attempt.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as NotSupportedError).code).toBe("fork_unavailable");
      expect((error as Error).message).toContain("custom image");
    }
  });

  test("getHost answers at once, as E2B's does, and shares the port once", async () => {
    // 25 September 2026: getHost threw, so E2B code did not run unchanged.
    const sbx = await create();
    const host = `3000-${sbx.sandboxId.replaceAll("-", "")}.runtimehost.com`;
    expect(sbx.getHost(3000)).toBe(host);
    expect(sbx.getHost(3000)).toBe(host);
    expect(await sbx.getPublicHost(3000)).toBe(host);
    expect(world.called("previews.create")).toEqual([[3000, { visibility: "public" }]]);
    expect(() => sbx.getHost(0)).toThrow(/1 to 65535/);
  });
});

describe("what Runtime does not have", () => {
  test("throws NotSupportedError naming the alternative", async () => {
    const sbx = await create();
    expect(() => sbx.pty).toThrow(/terminal/);
    expect(() => sbx.git).toThrow(/commands.run/);
    for (const call of [sbx.updateNetwork(), sbx.uploadUrl(), sbx.downloadUrl()])
      expect(await call.catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
    expect(() => sbx.getMcpUrl()).toThrow(NotSupportedError);
  });

  test("E2B's other exports load, and throw on use", () => {
    expect(() => Template()).toThrow(/images.build/);
    expect(() => Volume["create"]?.()).toThrow(/volumes/);
    expect(() => new Secret()).toThrow(NotSupportedError);
    expect(() => waitForPort(3000)).toThrow(NotSupportedError);
  });
});

describe("E2B client", () => {
  test("binds its client to every static call", async () => {
    const e2b = new E2B({ client: world.client() });
    const sbx = await e2b.Sandbox.create({ timeoutMs: 90_000 });
    expect(sbx).toBeInstanceOf(Sandbox);
    expect(lastCreate().timeoutSeconds).toBe(90);
    expect(await e2b.Sandbox.kill(sbx.sandboxId)).toBe(true);
    const paginator = e2b.Sandbox.list();
    expect(await paginator.nextItems()).toEqual([]);
  });
});

export type { FakeSandbox };
