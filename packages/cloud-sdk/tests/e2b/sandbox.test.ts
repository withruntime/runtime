import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
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
import { keptLeases, renewLeases } from "../../src/e2b/sandbox";
import { PublicPreviewNotAllowedError } from "../../src/e2b/index";
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

  test("a timeout over an hour gets an hour's lease, carried on up to the time asked", async () => {
    // 2 October 2026: an E2B timeout over an hour was refused.
    const start = Date.now();
    try {
      const sbx = await create({ timeoutMs: 90 * 60_000 });
      expect(lastCreate().timeoutSeconds).toBe(3600);
      const asked = keptLeases().get(sbx.sandboxId)!;
      expect(Math.abs(asked - (start + 90 * 60_000))).toBeLessThan(2000);
      // Five minutes on, with 55 minutes of lease left: moved on to an hour ahead.
      setSystemTime(new Date(start + 5 * 60_000));
      fake(sbx).info.expiresAt = new Date(start + 60 * 60_000).toISOString();
      await renewLeases();
      const [, first] = world.called("sandbox.extend").at(-1)!;
      expect(first as number).toBeGreaterThan(5 * 60 - 40);
      expect(first as number).toBeLessThanOrEqual(5 * 60);
      expect(keptLeases().has(sbx.sandboxId)).toBe(true);
      // Forty minutes in: the end asked is within the hour, so the lease is
      // moved to it exactly, never past it, and the sandbox is let go.
      setSystemTime(new Date(start + 40 * 60_000));
      await renewLeases();
      expect(Math.abs(Date.parse(fake(sbx).info.expiresAt) - asked)).toBeLessThan(2000);
      expect(keptLeases().has(sbx.sandboxId)).toBe(false);
    } finally {
      setSystemTime();
    }
  });

  test("kill lets a kept sandbox go; setTimeout and connect keep one past an hour", async () => {
    const sbx = await create({ timeoutMs: 2 * 3_600_000 });
    expect(keptLeases().has(sbx.sandboxId)).toBe(true);
    await sbx.kill();
    expect(keptLeases().has(sbx.sandboxId)).toBe(false);
    const other = await create();
    await other.setTimeout(5 * 3_600_000);
    expect(keptLeases().get(other.sandboxId)! - Date.now()).toBeGreaterThan(4.9 * 3_600_000);
    // The lease itself goes no further than an hour ahead.
    expect(Date.parse(fake(other).info.expiresAt) - Date.now()).toBeLessThanOrEqual(3_600_000);
    const third = await create();
    await Sandbox.connect(third.sandboxId, { ...runtime(), timeoutMs: 3 * 3_600_000 });
    expect(keptLeases().has(third.sandboxId)).toBe(true);
    await Sandbox.kill(third.sandboxId, runtime());
    await other.kill();
    expect(keptLeases().size).toBe(0);
  });

  test("a timeout over 24 hours is refused, as E2B refuses it", async () => {
    const error = await create({ timeoutMs: 25 * 3_600_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidArgumentError);
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
    // Read from byte 0 by the request that starts it, so nothing printed
    // before the first read is dropped (2 October 2026: output was cut).
    expect(world.called("sandbox.spawn")).toEqual([]);
    const [command, options] = world.called("sandbox.execStream").at(-1)!;
    expect(command).toBe("echo hi");
    expect(options).toMatchObject({ cwd: "/tmp", env: { B: "3" }, timeoutMs: 86_400_000 });
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
    // E2B's timeout bounds the wait, never the process: it gets a day.
    expect(world.called("sandbox.execStream").at(-1)![1]).toMatchObject({ timeoutMs: 86_400_000 });
  });

  test("a command killed by a signal exits -1", async () => {
    world.exec = () => ({ exitCode: null, stderr: "" });
    const sbx = await create();
    const error = (await sbx.commands
      .run("kill -9 $$")
      .catch((e: unknown) => e)) as CommandExitError;
    expect([error.exitCode, error.error]).toEqual([-1, "terminated by a signal"]);
  });

  test("runs as another user through sudo -u, and refuses one the sandbox lacks", async () => {
    // 2 October 2026: user: "root" was refused.
    const sbx = await create();
    await sbx.commands.run("whoami", { user: "root" });
    expect(world.called("sandbox.execStream").at(-1)![0]).toEqual([
      "sudo",
      "-n",
      "-E",
      "-H",
      "-u",
      "root",
      "--",
      "/bin/bash",
      "-c",
      "cd ~ 2>/dev/null\nwhoami",
    ]);
    // root needs no check; another user is checked once.
    expect(world.called("sandbox.exec")).toEqual([]);
    await sbx.commands.run("whoami", { user: "app", cwd: "/srv" });
    await sbx.commands.run("whoami", { user: "app" });
    expect(world.called("sandbox.exec").map(([argv]) => argv)).toEqual([["id", "-u", "--", "app"]]);
    expect(world.called("sandbox.execStream").at(-2)![0]).toEqual([
      "sudo",
      "-n",
      "-E",
      "-H",
      "-u",
      "app",
      "--",
      "/bin/bash",
      "-c",
      "whoami",
    ]);
    world.exec = (command) =>
      Array.isArray(command) && command[0] === "id" ? { exitCode: 1 } : { exitCode: 0 };
    const before = world.called("sandbox.execStream").length;
    const error = await sbx.commands.run("whoami", { user: "ghost" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as Error).message).toContain('no user "ghost"');
    expect(world.called("sandbox.execStream")).toHaveLength(before);
    expect(world.calls.some(([, argv]) => String(argv).includes("useradd"))).toBe(false);
    await sbx.commands.run("id", { user: "user" });
    expect(world.called("sandbox.execStream").at(-1)![0]).toBe("id");
  });

  test("links /home/user to /workspace once, when something names it", async () => {
    const sbx = await create();
    await sbx.commands.run("ls");
    expect(world.called("sandbox.execStream").map(([command]) => command)).toEqual(["ls"]);
    expect(world.called("sandbox.exec")).toHaveLength(0);
    await sbx.commands.run("cat /home/user/a.txt");
    await sbx.files.write("/home/user/b.txt", "b");
    await sbx.commands.run("ls", { cwd: "/home/user" });
    const commands = world.calls
      .filter(([method]) => method === "sandbox.exec" || method === "sandbox.execStream")
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
      [process.id, "hello\n", { timeoutMs: 0, signal: expect.any(AbortSignal) }],
      [process.id, "", { eof: true, timeoutMs: 0, signal: expect.any(AbortSignal) }],
    ]);
    const spawn = world.called("sandbox.spawn")[1]![1] as Record<string, unknown>;
    expect(spawn).toMatchObject({
      stdin: "pipe",
      request: { timeoutMs: 0, signal: expect.any(AbortSignal) },
    });
    expect(spawn.timeoutMs).toBeUndefined();

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

  test("acts as another user through sudo -u, and refuses metadata", async () => {
    // 2 October 2026: files with user: "root" were refused.
    const sbx = await create();
    const stored = new Map<string, string>();
    world.exec = (command, options) => {
      const argv = command as unknown as string[];
      if (argv[0] !== "sudo") return { exitCode: 0 };
      const [path] = argv.slice(9);
      const text = argv[7]!;
      if (text.includes("base64 -d >")) {
        stored.set(
          path!,
          (stored.get(path!) ?? "") +
            Buffer.from(String(options.stdin), "base64").toString("latin1"),
        );
        return { exitCode: 0 };
      }
      if (text.includes("base64 -w 0"))
        return stored.has(path!)
          ? { exitCode: 0, stdout: Buffer.from(stored.get(path!)!, "latin1").toString("base64") }
          : { exitCode: 44 };
      if (text.includes("find"))
        return {
          exitCode: 0,
          stdout: `f\x003\x00600\x00root\x00root\x001790000000.5\x00${path}\x00\x00`,
        };
      return { exitCode: 0 };
    };
    await sbx.files.write("/etc/app.conf", "a=1", { user: "root" });
    const write = world.called("sandbox.exec").at(-1)!;
    expect((write[0] as string[]).slice(0, 5)).toEqual(["sudo", "-n", "-u", "root", "--"]);
    expect(write[1]).toMatchObject({ stdin: Buffer.from("a=1").toString("base64") });
    expect(world.called("files.write")).toEqual([]);
    expect(await sbx.files.read("/etc/app.conf", { user: "root" })).toBe("a=1");
    const bytes = new Uint8Array([0, 255, 128, 7]);
    await sbx.files.write("/root/b.bin", bytes.buffer, { user: "root" });
    expect(await sbx.files.read("/root/b.bin", { user: "root", format: "bytes" })).toEqual(bytes);
    expect(
      await sbx.files.read("/root/missing", { user: "root" }).catch((e: unknown) => e),
    ).toBeInstanceOf(FileNotFoundError);
    expect(await sbx.files.getInfo("/etc/app.conf", { user: "root" })).toMatchObject({
      name: "app.conf",
      type: FileType.FILE,
      size: 3,
      mode: 0o600,
      permissions: "rw-------",
      owner: "root",
    });
    expect(world.called("files.stat")).toEqual([]);
    expect(
      await sbx.files.watchDir("/root", () => undefined, { user: "root" }).catch((e: unknown) => e),
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

  test("filters by template and start time, sorts newest first and resumes from a token", async () => {
    // 2 October 2026: these were refused.
    world.images.push({ id: "11111111-1111-4111-8111-111111111111", name: "mine", state: "ready" });
    const a = await create();
    const b = await create({ template: "mine" });
    const c = await create({ template: "mine" });
    fake(a).info.createdAt = "2026-10-01T00:00:00.000Z";
    fake(b).info.createdAt = "2026-10-02T00:00:00.000Z";
    fake(c).info.createdAt = "2026-10-03T00:00:00.000Z";
    const all = async (paginator: ReturnType<typeof Sandbox.list>) => {
      const seen = [];
      while (paginator.hasNext) seen.push(...(await paginator.nextItems()));
      return seen.map((one) => one.sandboxId);
    };
    expect(await all(Sandbox.list({ ...runtime(), query: { template: "mine" } }))).toEqual([
      b.sandboxId,
      c.sandboxId,
    ]);
    expect(await all(Sandbox.list({ ...runtime(), query: { template: "base" } }))).toEqual([
      a.sandboxId,
    ]);
    expect(await all(Sandbox.list({ ...runtime(), query: { template: "none" } }))).toEqual([]);
    expect(
      await all(Sandbox.list({ ...runtime(), query: { startedAfter: new Date("2026-10-02") } })),
    ).toEqual([b.sandboxId, c.sandboxId]);
    const newest = Sandbox.list({ ...runtime(), order: "desc", limit: 2 });
    expect((await newest.nextItems()).map((one) => one.sandboxId)).toEqual([
      c.sandboxId,
      b.sandboxId,
    ]);
    expect(newest.hasNext).toBe(true);
    const token = newest.nextToken!;
    expect(
      await all(Sandbox.list({ ...runtime(), order: "desc", limit: 2, nextToken: token })),
    ).toEqual([a.sandboxId]);
    // A token from Runtime's own paging resumes the same way.
    const plain = Sandbox.list({ ...runtime(), limit: 1 });
    await plain.nextItems();
    expect(await all(Sandbox.list({ ...runtime(), nextToken: plain.nextToken! }))).toEqual([
      b.sandboxId,
      c.sandboxId,
    ]);
    expect(() => Sandbox.list({ ...runtime(), nextToken: "abc" })).toThrow(InvalidArgumentError);
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

  test("e2b 2.52.0's bounds: a fork's count is 1 to 20, httpVersion is 1.1 or 2", async () => {
    const sbx = await create({ httpVersion: "1.1" });
    const lookedUp = world.called("sandboxes.get").length;
    for (const count of [0, 21, 1.5]) {
      const error = await sbx.fork({ count }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as Error).message).toBe("count must be an integer between 1 and 20");
      expect(
        await Sandbox.fork(sbx.sandboxId, { ...runtime(), count }).catch((e: unknown) => e),
      ).toBeInstanceOf(InvalidArgumentError);
    }
    expect(world.called("sandbox.fork")).toEqual([]);
    expect(world.called("sandboxes.get")).toHaveLength(lookedUp);
    expect(await sbx.fork({ count: 20 })).toHaveLength(20);
    const wrong = { httpVersion: "3" } as unknown as { httpVersion: "2" };
    expect(await create(wrong).catch((e: unknown) => e)).toBeInstanceOf(InvalidArgumentError);
    const before = process.env.E2B_HTTP_VERSION;
    process.env.E2B_HTTP_VERSION = "h3";
    try {
      const error = await create().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as Error).message).toContain("E2B_HTTP_VERSION");
    } finally {
      if (before === undefined) delete process.env.E2B_HTTP_VERSION;
      else process.env.E2B_HTTP_VERSION = before;
    }
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

  test("on a trial sandbox getHost says at once what works, never a host that 404s", async () => {
    // 2 October 2026, live: getHost on a trial returned a host answering 404
    // "Nothing is shared on port 8080", after a warning nobody saw.
    const sbx = await create({ runtime: { create: { funding: "trial" } } });
    const error = (() => {
      try {
        sbx.getHost(8080);
      } catch (caught) {
        return caught;
      }
    })() as PublicPreviewNotAllowedError;
    expect(error).toBeInstanceOf(PublicPreviewNotAllowedError);
    expect(error).toBeInstanceOf(NotSupportedError);
    expect(error.code).toBe("public_preview_not_allowed");
    expect(error.message).toContain("previews.create(8080)");
    expect(error.message).toContain("urlWithToken");
    expect(await sbx.getPublicHost(8080).catch((e: unknown) => e)).toBeInstanceOf(
      PublicPreviewNotAllowedError,
    );
    expect(world.called("previews.create")).toEqual([]);
  });

  test("Runtime's refusal of a public share is not read as a bad key", async () => {
    const sbx = await create();
    // Runtime refuses the public share though the sandbox read as paid.
    fake(sbx).refusePublic = true;
    const error = await sbx.getPublicHost(3000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicPreviewNotAllowedError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
  });
});

describe("what Runtime does not have", () => {
  test("throws NotSupportedError naming the alternative", async () => {
    const sbx = await create();
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
