import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { keySource, pickKey, resetClients } from "../../src/e2b/client";
import { TEMPLATE_LABEL } from "../../src/e2b/sandbox";
import { PublicPreviewNotAllowedError } from "../../src/e2b/index";
import { commandAs, listedAs, shellAs } from "../../src/e2b/users";
import { FakeWorld, guestCommand, notFound, type FakeSandbox } from "./fake";

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
  test("gives E2B's default machine and E2B's 300 s, which ends in a pause, never a delete", async () => {
    const sbx = await create();
    // Nobody asked for it to end, so E2B's default five minutes pauses it:
    // nothing is lost, and the next call wakes it.
    expect(lastCreate()).toEqual({
      vcpu: 2,
      memoryMiB: 512,
      timeoutSeconds: 300,
      onLeaseEnd: "pause",
    });
    expect(sbx.sandboxId).toBe(fake(sbx).id);
    expect(world.called("images.list")).toEqual([]);
    expect((await sbx.getInfo()).lifecycle?.onTimeout).toBe("pause");
  });

  test("a timeoutMs is a deadline the server keeps, and it deletes, as E2B's kill does", async () => {
    const sbx = await create({ timeoutMs: 600_000 });
    expect(lastCreate()).toMatchObject({ timeoutSeconds: 600, onLeaseEnd: "delete" });
    const info = await sbx.getInfo();
    expect(Math.abs(info.endAt.getTime() - (Date.now() + 600_000))).toBeLessThan(2000);
    expect(info.lifecycle?.onTimeout).toBe("kill");
    await sbx.setTimeout(1_200_000);
    // Ten minutes on, rounded up to a whole second: 601 when a millisecond
    // passed between the create and the call.
    const [id, seconds] = world.called("sandbox.extend").at(-1) as [string, number];
    expect(id).toBe(sbx.sandboxId);
    expect(seconds).toBeGreaterThanOrEqual(600);
    expect(seconds).toBeLessThanOrEqual(601);
    // An explicit onTimeout "kill" deletes too, with or without a timeoutMs.
    await create({ lifecycle: { onTimeout: "kill" } });
    expect(lastCreate()).toMatchObject({ timeoutSeconds: 300, onLeaseEnd: "delete" });
  });

  test("a timeout up to 24 hours is sent whole: no timer in this process keeps it", async () => {
    // 5 October 2026: a 24-hour timeoutMs was an hour's lease that this
    // process moved on every five minutes, so a create from a request handler
    // or a cron ended within the hour.
    const sbx = await create({ timeoutMs: 24 * 3_600_000 });
    expect(lastCreate()).toMatchObject({ timeoutSeconds: 86_400, onLeaseEnd: "delete" });
    await sbx.setTimeout(24 * 3_600_000);
    // The same end, to the second: nothing to move.
    expect(world.called("sandbox.extend")).toEqual([]);
    const other = await create({ timeoutMs: 600_000 });
    await Sandbox.connect(other.sandboxId, { ...runtime(), timeoutMs: 3 * 3_600_000 });
    const [, seconds] = world.called("sandbox.extend").at(-1) as [string, number];
    expect(seconds).toBeGreaterThan(3 * 3600 - 610);
  });

  test("a sandbox the server keeps running (a pilot's) has no end to move", async () => {
    const sbx = await create({ runtime: { create: { persistent: true } } });
    await sbx.setTimeout(600_000);
    await Sandbox.connect(sbx.sandboxId, { ...runtime(), timeoutMs: 600_000 });
    expect(world.called("sandbox.extend")).toEqual([]);
    // Its end is E2B's furthest, a day ahead, not where it is paid up to:
    // 5 October 2026, a pilot's read minutes ahead and looked about to end.
    const day = Date.now() + 86_400_000;
    const info = await sbx.getInfo();
    expect(Math.abs(info.endAt.getTime() - day)).toBeLessThan(2000);
    const [listed] = await Sandbox.list({ ...runtime() }).nextItems();
    expect(Math.abs(listed!.endAt.getTime() - day)).toBeLessThan(2000);
    // A paused one keeps the time it stopped.
    await sbx.pause();
    expect((await sbx.getInfo()).endAt.getTime()).toBe(Date.parse(fake(sbx).info.expiresAt));
  });

  test("setTimeout cannot bring the end sooner, and says so", async () => {
    const sbx = await create({ timeoutMs: 600_000 });
    const error = await sbx.setTimeout(60_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as Error).message).toContain("kill()");
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

  test("a name, name:tag or team/name:tag is a Runtime image the create resolves", async () => {
    world.images.push({ id: "img-1", name: "my-agent", state: "ready" });
    const sbx = await Sandbox.create("my-agent", runtime());
    expect(lastCreate()).toMatchObject({
      image: "my-agent",
      vcpu: 2,
      memoryMiB: 512,
      labels: { [TEMPLATE_LABEL]: "my-agent" },
    });
    // No lookup before the create: the create resolves the name.
    expect(world.called("images.list")).toEqual([]);
    await Sandbox.create("my-agent:v2", runtime());
    expect(lastCreate()).toMatchObject({ image: "my-agent:v2" });
    await Sandbox.create("acme-team/my-agent:v2", runtime());
    expect(lastCreate()).toMatchObject({
      image: "my-agent:v2",
      labels: { [TEMPLATE_LABEL]: "acme-team/my-agent:v2" },
    });
    // getInfo and list name the template it was made from, from any client,
    // and keep it out of metadata (5 October 2026: it read "base").
    const info = await Sandbox.getInfo(sbx.sandboxId, runtime());
    expect(info.templateId).toBe("my-agent");
    expect(info.metadata).toEqual({});
    const listed = await Sandbox.list({
      ...runtime(),
      query: { template: "my-agent" },
    }).nextItems();
    expect(listed.map((one) => one.sandboxId)).toEqual([sbx.sandboxId]);
  });

  test("the template label never pushes metadata past Runtime's 32 labels", async () => {
    world.images.push({ id: "img-1", name: "my-agent", state: "ready" });
    const metadata = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, "v"]));
    await Sandbox.create("my-agent", { ...runtime(), metadata });
    expect(lastCreate().labels).toEqual(metadata);
  });

  test("an E2B template with no Runtime image says how to build one", async () => {
    const error = await Sandbox.create("abc123xyz", runtime()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as Error).message).toContain("--name abc123xyz");
    expect((error as TemplateError).code).toBe("template_not_found");
    expect(world.sandboxes.size).toBe(0);
    // It names the account the key belongs to: 5 October 2026, a
    // RUNTIME_API_KEY of another account looked like a missing image.
    expect((error as Error).message).toContain(
      'No Runtime image is named "abc123xyz" in the account "Acme".',
    );
  });

  test("a UUID is an image when one exists, else a snapshot, which keeps its own shape", async () => {
    const image = "11111111-2222-4333-8444-555555555555";
    world.images.push({ id: image, name: null, state: "ready" });
    await Sandbox.create(image, runtime());
    expect(lastCreate()).toMatchObject({ image });
    const snapshot = "99999999-2222-4333-8444-555555555555";
    await Sandbox.create(snapshot, runtime());
    expect(lastCreate()).toEqual({
      snapshot,
      timeoutSeconds: 300,
      onLeaseEnd: "pause",
      labels: { [TEMPLATE_LABEL]: snapshot },
    });
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
    // Never a quiet fall back to a saved login, which may be another account.
    expect(() => pickKey()).toThrow(/RUNTIME_API_KEY/);
    expect(() => pickKey()).toThrow(AuthenticationError);
    expect(() => pickKey("e2b_abc")).toThrow(AuthenticationError);
    delete process.env.E2B_API_KEY;
    expect(pickKey()).toBeUndefined();
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

  test("two different Runtime keys in RUNTIME_API_KEY and E2B_API_KEY are said once, and errors name the key's source", () => {
    // 5 October 2026: a RUNTIME_API_KEY of another account silently beat
    // E2B_API_KEY, and the create failed as a missing image.
    resetClients();
    const warnings: unknown[][] = [];
    const warn = spyOn(process, "emitWarning").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    try {
      process.env.RUNTIME_API_KEY = "rk_same";
      process.env.E2B_API_KEY = "rk_same";
      pickKey();
      process.env.E2B_API_KEY = "e2b_left";
      pickKey();
      expect(warnings).toEqual([]);
      process.env.E2B_API_KEY = "rk_other";
      expect(pickKey()).toBe("rk_same");
      pickKey();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]![0]).toContain(
        "RUNTIME_API_KEY and E2B_API_KEY hold different Runtime keys",
      );
      expect(warnings[0]![1]).toEqual({ code: "RUNTIME_E2B_TWO_KEYS" });
    } finally {
      warn.mockRestore();
      resetClients();
    }
    expect(keySource("rk_given")).toBe("apiKey");
    expect(keySource()).toBe("RUNTIME_API_KEY");
    delete process.env.RUNTIME_API_KEY;
    expect(keySource()).toBe("E2B_API_KEY");
    delete process.env.E2B_API_KEY;
    expect(keySource()).toBe("the saved login");
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

  test("a command whose sandbox is killed under it fails with E2B's TimeoutError", async () => {
    // 5 October 2026, E2B's own suite: it was a SandboxNotFoundError.
    const sbx = await create();
    world.outputError = notFound("not_found", "No sandbox with that id.");
    const handle = await sbx.commands.run("sleep 60", { background: true });
    const error = await handle.wait().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toMatch(
      /ended before the stream completed|sandbox was killed/,
    );
    expect((error as Error).cause).toBeInstanceOf(SandboxNotFoundError);
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
    const link =
      "[ -e /home/user ] || sudo ln -s /workspace /home/user || exit 1; if [ /home/user -ef /workspace ]; then echo same; fi";
    expect(commands.filter((command) => String(command).includes("ln -s"))).toEqual([link]);
    expect(commands.indexOf(link)).toBe(1);
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
    expect(listed[0]).toMatchObject({ cmd: "/bin/bash", args: ["-l", "-c", "cat"] });

    await sbx.commands.sendStdin(open.pid, "more");
    const attached = await sbx.commands.connect(open.pid);
    expect(attached.pid).toBe(open.pid);
    expect(await sbx.commands.kill(open.pid)).toBe(true);
    expect(process.killed).toBe("SIGKILL");
    expect(await sbx.commands.kill(12345)).toBe(false);
    expect(await closed.kill()).toBe(true);
  });

  test("commands.list shows each command as E2B starts it: /bin/bash -l -c and the customer's own script", async () => {
    // 5 October 2026: args were ["-c", "bash -c npm run dev"], so code that
    // finds its server by args[2] or by the script found nothing.
    const sbx = await create();
    await sbx.commands.run("npm run dev", { background: true });
    expect(await sbx.commands.list()).toMatchObject([
      { cmd: "/bin/bash", args: ["-l", "-c", "npm run dev"], envs: {} },
    ]);
    const line = (argv: string[]) => guestCommand(argv);
    expect(listedAs(line(commandAs("root", "npm run dev", false)))).toEqual({
      cmd: "/bin/bash",
      args: ["-l", "-c", "npm run dev"],
    });
    expect(listedAs(line(commandAs("root", "echo a && echo b", true)))).toEqual({
      cmd: "/bin/bash",
      args: ["-l", "-c", "echo a && echo b"],
    });
    expect(listedAs(line(shellAs("root", false)))).toEqual({
      cmd: "/bin/bash",
      args: ["-i", "-l"],
    });
    expect(listedAs(line(["/bin/bash", "-i", "-l"]))).toEqual({
      cmd: "/bin/bash",
      args: ["-i", "-l"],
    });
    // Started outside this package, with its own words.
    expect(listedAs("python3 -m http.server 8000")).toEqual({
      cmd: "python3",
      args: ["-m", "http.server", "8000"],
    });
  });
});

describe("files", () => {
  test("an image with its own /home/user gets /workspace paths back, which name the file", async () => {
    const sbx = await create();
    world.exec = () => ({ exitCode: 0, stdout: "" });
    expect((await sbx.files.write("a.txt", "a")).path).toBe("/workspace/a.txt");
    expect((await sbx.files.getInfo("a.txt")).path).toBe("/workspace/a.txt");
  });

  test("write and read text, bytes and blobs; relative paths land in the home", async () => {
    // 5 October 2026, E2B's own suite: a relative write came back as
    // /workspace/... where E2B gives /home/user/...
    const sbx = await create();
    expect(await sbx.files.write("notes/a.txt", "hello")).toEqual({
      name: "a.txt",
      type: FileType.FILE,
      path: "/home/user/notes/a.txt",
    });
    expect(fake(sbx).fileMap.get("/workspace/notes/a.txt")).toBeDefined();
    expect((await sbx.files.getInfo("./notes/a.txt")).path).toBe("/home/user/notes/a.txt");
    expect((await sbx.files.list("notes")).map((entry) => entry.path)).toEqual([
      "/home/user/notes/a.txt",
    ]);
    expect((await sbx.files.getInfo("/workspace/notes/a.txt")).path).toBe("/workspace/notes/a.txt");
    // Asked once, beside the first call: /home/user leads to /workspace.
    expect(world.called("sandbox.exec").filter(([c]) => String(c).includes("ln -s"))).toHaveLength(
      1,
    );
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
      permissions: "-rw-r--r--",
    });
    expect(world.called("files.list")[0]![1]).toEqual({ depth: 1, hidden: true });
    expect((await sbx.files.getInfo("/workspace/d")).type).toBe(FileType.DIR);
    expect(await sbx.files.exists("/workspace/d/x.py")).toBe(true);
    expect(await sbx.files.makeDir("/workspace/d")).toBe(false);
    expect(await sbx.files.makeDir("/workspace/e")).toBe(true);
    const moved = await sbx.files.rename("/workspace/d/x.py", "/workspace/d/y.py");
    expect(moved.path).toBe("/workspace/d/y.py");
    expect((await sbx.files.rename("d/y.py", "d/x.py")).path).toBe("/home/user/d/x.py");
    await sbx.files.rename("d/x.py", "d/y.py");
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
    // A file Runtime puts in place whole is created and, as envd says, written:
    // E2B's own watch test waits for the write (5 October 2026).
    expect(seen).toEqual([
      { name: "a.txt", type: FilesystemEventType.CREATE },
      { name: "a.txt", type: FilesystemEventType.WRITE },
      { name: "sub/b.txt", type: FilesystemEventType.WRITE },
    ]);
    expect(world.called("files.watch")[0]).toMatchObject([
      "/workspace/app",
      { recursive: true, timeoutMs: 0 },
    ]);
    await handle.stop();
    expect(world.called("files.watch.stop")).toEqual([["/workspace/app"]]);
    // envd watches only a directory.
    await sbx.files.write("/workspace/one.txt", "1");
    const refused = await sbx.files.watchDir("one.txt", () => {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvalidArgumentError);
    expect(world.called("files.watch")).toHaveLength(1);
  });

  test("entries read as envd gives them: the kind's letter, E2B's user, an absolute link target, depth at least one", async () => {
    // 5 October 2026, E2B's own suite: "rw-r--r--" for "-rw-r--r--", owner
    // "runtime" for "user", a link's "a.txt" for its absolute target.
    const sbx = await create();
    fake(sbx).listing = [
      {
        name: "d",
        path: "/workspace/x/d",
        type: "directory",
        size: 4096,
        mode: "0755",
        owner: "runtime",
        group: "runtime",
        modifiedAt: "2026-10-05T00:00:00.000Z",
      },
      {
        name: "l",
        path: "/workspace/x/l",
        type: "symlink",
        size: 5,
        mode: "0777",
        owner: "root",
        group: "root",
        symlinkTarget: "../a.txt",
        modifiedAt: "2026-10-05T00:00:00.000Z",
      },
      {
        name: "m",
        path: "/workspace/x/m",
        type: "symlink",
        size: 5,
        mode: "0777",
        owner: "runtime",
        group: "runtime",
        symlinkTarget: "/etc/hosts",
        modifiedAt: "2026-10-05T00:00:00.000Z",
      },
    ];
    const [dir, link, absolute] = await sbx.files.list("x");
    expect(dir).toMatchObject({ permissions: "drwxr-xr-x", owner: "user", group: "user" });
    expect(link).toMatchObject({
      permissions: "Lrwxrwxrwx",
      owner: "root",
      symlinkTarget: "/home/user/a.txt",
    });
    expect(absolute!.symlinkTarget).toBe("/etc/hosts");
    const error = await sbx.files.list("x", { depth: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as Error).message).toBe("depth should be at least one");
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
      permissions: "-rw-------",
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
  test("kill deletes the sandbox for good, as E2B's kill destroys it; unknown ids are false", async () => {
    // 5 October 2026: kill was a stop, which keeps the disk; a pilot's kept
    // stops filled its 2,000 kept slots and its hosts' disks.
    const sbx = await create();
    expect(await sbx.kill()).toBe(true);
    expect(world.called("sandbox.delete")).toHaveLength(1);
    expect(world.called("sandbox.stop")).toEqual([]);
    expect(world.sandboxes.has(sbx.sandboxId)).toBe(false);
    expect(await sbx.kill()).toBe(false);
    expect(await Sandbox.kill(sbx.sandboxId, runtime())).toBe(false);
    expect(await Sandbox.kill("nope", runtime())).toBe(false);
    const other = await create();
    expect(await Sandbox.kill(other.sandboxId, runtime())).toBe(true);
    expect(world.called("sandbox.delete")).toHaveLength(2);
    expect(await Sandbox.kill(other.sandboxId, runtime())).toBe(false);
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
      lifecycle: { onTimeout: "pause", autoResume: true },
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

  test("a sandbox Runtime paused for being idle is running to E2B code: the next call wakes it", async () => {
    const sbx = await create({ metadata: { suite: "idle" } });
    fake(sbx).info.state = "paused";
    fake(sbx).info.stopReason = "idle";
    expect(await sbx.isRunning()).toBe(true);
    expect((await sbx.getInfo()).state).toBe("running");
    const running = await Sandbox.list({
      ...runtime(),
      query: { state: ["running"], metadata: { suite: "idle" } },
    }).nextItems();
    expect(running.map((one) => one.sandboxId)).toEqual([sbx.sandboxId]);
    // Paused on request, it is paused, as on E2B.
    fake(sbx).info.stopReason = "requested";
    expect(await sbx.isRunning()).toBe(false);
    const paused = await Sandbox.list({
      ...runtime(),
      query: { state: ["paused"], metadata: { suite: "idle" } },
    }).nextItems();
    expect(paused.map((one) => one.sandboxId)).toEqual([sbx.sandboxId]);
    // Without automatic wake, nothing wakes it: paused.
    fake(sbx).info.stopReason = "idle";
    fake(sbx).info.autoWake = false;
    expect(await sbx.isRunning()).toBe(false);
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
