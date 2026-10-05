import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError } from "../../src/errors";
import {
  ComputerUse,
  Daytona,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaNotFoundError,
  NotSupportedError,
  PtyHandle,
  type Sandbox,
} from "../../src/daytona/index";
import { DropInWorld } from "../drop-in-fake";
import type { FakeSandbox } from "../e2b/fake";

/* Calls the Daytona drop-in once refused and now carries out: PTY sessions,
   computer use, running as another Linux user, an autoStopInterval past an
   hour or 0, and list filters and sorting. */

let world: DropInWorld;
let daytona: Daytona;
const fake = (sandbox: Sandbox) => world.sandboxes.get(sandbox.id)! as FakeSandbox & Loose;
type Loose = Record<string, unknown> & { info: Record<string, unknown> };

beforeEach(() => {
  world = new DropInWorld();
  daytona = new Daytona({ withruntime: { client: world.client() } });
});
afterEach(() => {
  jest.useRealTimers();
});

/** A terminal WebSocket as Runtime's SDK hands it over, driven by the test. */
function fakeTerminals(runtime: Loose) {
  const opened: Array<{
    processId: string;
    written: string[];
    closed: boolean;
    print(text: string): void;
    exit(code: number | null): void;
  }> = [];
  runtime.terminal = async (options: { processId: string; onData?: (d: Uint8Array) => void }) => {
    let settle!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => (settle = resolve));
    const record = {
      processId: options.processId,
      written: [] as string[],
      closed: false,
      print: (text: string) => options.onData?.(new TextEncoder().encode(text)),
      exit: (code: number | null) => settle(code),
    };
    opened.push(record);
    return {
      processId: options.processId,
      exited,
      write: (data: string | Uint8Array) =>
        record.written.push(typeof data === "string" ? data : new TextDecoder().decode(data)),
      resize: () => undefined,
      close: () => {
        record.closed = true;
        settle(null);
      },
    };
  };
  // Runtime's process list shows a command line as one string.
  const spawn = (runtime.spawn as (c: unknown, o: unknown) => Promise<Loose>).bind(runtime);
  runtime.spawn = async (command: string | string[], options: Record<string, unknown>) => {
    const made = await spawn(command, options);
    made.info.command = Array.isArray(command) ? command.join(" ") : command;
    made.info.cwd = options.cwd;
    made.info.startedAt = "2026-10-01T00:00:00.000Z";
    made.info.pty = Boolean(options.pty);
    made.resize = async (cols: number, rows: number) => world.record("process.resize", cols, rows);
    return made;
  };
  return opened;
}

describe("PTY sessions", () => {
  test("createPty starts a login shell on a terminal and attaches to it", async () => {
    const sandbox = await daytona.create({ envVars: { A: "1" } });
    const terminals = fakeTerminals(fake(sandbox));
    world.output = () => [];
    const seen: string[] = [];
    const pty = await sandbox.process.createPty({
      id: "my pty",
      cwd: "src",
      envs: { B: "2" },
      cols: 120,
      rows: 30,
      onData: (data) => void seen.push(new TextDecoder().decode(data)),
    });
    expect(pty).toBeInstanceOf(PtyHandle);
    const [[argv, options]] = world.called("sandbox.spawn") as [
      [string[], Record<string, unknown>],
    ];
    expect(argv.slice(0, 4)).toEqual(["bash", "-l", "-i", "-s"]);
    expect(argv.at(-1)).toBe("120x30");
    expect(options).toMatchObject({
      cwd: "/workspace/src",
      env: { A: "1", TERM: "xterm-256color", B: "2" },
      pty: { cols: 120, rows: 30 },
    });
    expect(terminals[0]!.processId).toBe("proc-1");
    expect([pty.sessionId, pty.isConnected()]).toEqual(["my pty", true]);
    await pty.waitForConnection();
    await pty.sendInput("ls\n");
    expect(terminals[0]!.written).toEqual(["ls\n"]);
    terminals[0]!.print("a.txt\n");
    await Promise.resolve();
    expect(seen).toEqual(["a.txt\n"]);
    terminals[0]!.exit(0);
    expect(await pty.wait()).toEqual({ exitCode: 0 });
    expect([pty.exitCode, pty.isConnected()]).toEqual([0, false]);
    expect(await pty.sendInput("x").catch((e: unknown) => e)).toBeInstanceOf(
      DaytonaConnectionError,
    );
  });

  test("sessions list, resize, reconnect and end by id, from any client", async () => {
    const sandbox = await daytona.create();
    const runtime = fake(sandbox);
    const terminals = fakeTerminals(runtime);
    world.output = () => [];
    const pty = await sandbox.process.createPty({ id: "one", envs: { B: "2" } });
    expect(await sandbox.process.createPty({ id: "one" }).catch((e: unknown) => e)).toBeInstanceOf(
      DaytonaConflictError,
    );
    expect(await sandbox.process.listPtySessions()).toEqual([
      {
        active: true,
        cols: 80,
        createdAt: "2026-10-01T00:00:00.000Z",
        cwd: "/workspace",
        envs: { B: "2" },
        id: "one",
        lazyStart: false,
        rows: 24,
      },
    ]);
    expect(await pty.resize(100, 40)).toMatchObject({ id: "one", cols: 100, rows: 40 });
    expect(world.called("process.resize")).toEqual([[100, 40]]);
    // Another Daytona object finds it by its id.
    const other = await new Daytona({ withruntime: { client: world.client() } }).get(sandbox.id);
    expect(await other.process.getPtySessionInfo("one")).toMatchObject({ active: true, rows: 24 });
    await pty.disconnect();
    expect(terminals[0]!.closed).toBe(true);
    expect((await pty.wait()).error).toMatch(/keeps running/);
    expect(world.called("process.kill")).toEqual([]);
    const again = await other.process.connectPty("one", { onData: () => undefined });
    expect(terminals[1]!.processId).toBe("proc-1");
    await again.kill();
    expect(world.called("process.kill")).toEqual([["proc-1", "SIGKILL"]]);
    expect(await sandbox.process.getPtySessionInfo("one").catch((e: unknown) => e)).toBeInstanceOf(
      DaytonaNotFoundError,
    );
    expect(await sandbox.process.connectPty("none").catch((e: unknown) => e)).toBeInstanceOf(
      DaytonaNotFoundError,
    );
  });
});

/** Runtime's desktop as the SDK hands it over, recording each call. */
function fakeDesktop(runtime: Loose, png = pngOf(1280, 800)) {
  const calls: unknown[][] = [];
  const call =
    (name: string, answer: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? (answer as () => unknown)() : answer;
    };
  const recording = {
    id: "rec-abcdefgh",
    state: "finished",
    path: "/workspace/recordings/rec-abcdefgh.mp4",
    bytes: 2048,
    seconds: 12,
    reason: "stopped",
    startedAt: Date.parse("2026-10-01T00:00:00.000Z"),
  };
  const desktop: Record<string, unknown> = {
    start: call("start", { ok: true, display: ":1", size: "1280x800" }),
    stop: call("stop"),
    screenshot: call("screenshot", png),
    move: call("move"),
    click: call("click"),
    drag: call("drag"),
    mouseDown: call("mouseDown"),
    mouseUp: call("mouseUp"),
    scroll: call("scroll"),
    type: call("type"),
    press: call("press"),
    cursor: call("cursor", { x: 3, y: 4 }),
    windows: call("windows", [
      { id: "71303171", title: "Chromium", x: 0, y: 0, width: 1280, height: 800 },
    ]),
    recordings: {
      start: call("recordings.start", { ...recording, state: "recording" }),
      stop: call("recordings.stop", recording),
      get: call("recordings.get", recording),
      list: call("recordings.list", [recording]),
      delete: call("recordings.delete", { deleted: true }),
      download: call("recordings.download", new Uint8Array([1, 2, 3])),
    },
  };
  Object.defineProperty(runtime, "desktop", { value: desktop, configurable: true });
  return { calls, desktop };
}

function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("computer use", () => {
  test("mouse, keyboard and screenshots act on Runtime's desktop, in Daytona's shapes", async () => {
    const sandbox = await daytona.create();
    const { calls } = fakeDesktop(fake(sandbox));
    const computer = sandbox.computerUse;
    expect(computer).toBeInstanceOf(ComputerUse);
    expect(await computer.start()).toMatchObject({ message: expect.any(String) });
    expect(await computer.mouse.click(10, 20, "right", true)).toEqual({ x: 10, y: 20 });
    expect(await computer.mouse.move(5, 6)).toEqual({ x: 5, y: 6 });
    expect(await computer.mouse.getPosition()).toEqual({ x: 3, y: 4 });
    expect(await computer.mouse.drag(1, 2, 3, 4)).toEqual({ x: 3, y: 4 });
    await computer.mouse.drag(1, 2, 3, 4, "right");
    expect(await computer.mouse.scroll(100, 200, "down", 3)).toBe(true);
    await computer.mouse.scroll(100, 200, "up");
    await computer.keyboard.type("hello", 50);
    await computer.keyboard.press("enter", ["ctrl", "shift"]);
    await computer.keyboard.hotkey("cmd+pageup");
    await computer.keyboard.press("a");
    expect(calls).toEqual([
      ["start"],
      ["click", 10, 20, { button: "right", double: true }],
      ["move", 5, 6],
      ["cursor"],
      ["drag", [1, 2], [3, 4]],
      ["move", 1, 2],
      ["mouseDown", "right"],
      ["move", 3, 4],
      ["mouseUp", "right"],
      ["scroll", 3, { x: 100, y: 200 }],
      ["scroll", -1, { x: 100, y: 200 }],
      ["type", "hello", { delayMs: 50 }],
      ["press", "ctrl+shift+Return"],
      ["press", "super+Prior"],
      ["press", "a"],
    ]);
  });

  test("screenshots, display, windows, status and recordings", async () => {
    const sandbox = await daytona.create();
    const png = pngOf(1280, 800);
    const { calls, desktop } = fakeDesktop(fake(sandbox), png);
    const computer = sandbox.computerUse;
    expect(await computer.screenshot.takeFullScreen()).toEqual({
      screenshot: Buffer.from(png).toString("base64"),
      sizeBytes: png.byteLength,
    });
    await computer.screenshot.takeCompressed({ format: "jpeg", quality: 70 });
    expect(calls.at(-1)).toEqual(["screenshot", { format: "jpeg", quality: 70 }]);
    expect(await computer.display.getInfo()).toEqual({
      displays: [{ id: 0, x: 0, y: 0, width: 1280, height: 800, isActive: true }],
    });
    expect(await computer.display.getWindows()).toEqual({
      windows: [{ id: 71303171, title: "Chromium", x: 0, y: 0, width: 1280, height: 800 }],
    });
    expect(await computer.getStatus()).toEqual({ status: "active" });
    desktop.cursor = async () => {
      throw new RuntimeError({ message: "Not running.", code: "desktop_not_running", status: 409 });
    };
    expect(await computer.getStatus()).toEqual({ status: "inactive" });
    expect(await computer.recording.stop("rec-abcdefgh")).toEqual({
      id: "rec-abcdefgh",
      fileName: "rec-abcdefgh.mp4",
      filePath: "/workspace/recordings/rec-abcdefgh.mp4",
      startTime: "2026-10-01T00:00:00.000Z",
      endTime: "2026-10-01T00:00:12.000Z",
      status: "completed",
      sizeBytes: 2048,
      durationSeconds: 12,
    });
    expect((await computer.recording.start("demo")).status).toBe("recording");
    expect((await computer.recording.list()).recordings).toHaveLength(1);
    const target = join(mkdtempSync(join(tmpdir(), "daytona-rec-")), "out", "a.mp4");
    await computer.recording.download("rec-abcdefgh", target);
    expect([...readFileSync(target)]).toEqual([1, 2, 3]);
    for (const refuse of [
      () => computer.screenshot.takeRegion({ x: 0, y: 0, width: 10, height: 10 }),
      () => computer.screenshot.takeFullScreen(true),
      () => computer.screenshot.takeCompressed({ scale: 0.5 }),
      () => computer.screenshot.takeCompressed({ format: "webp" }),
      () => computer.getProcessLogs("xvfb"),
      () => computer.accessibility.getTree(),
    ])
      expect(await refuse().catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
  });
});

describe("running as another Linux user", () => {
  test("create's user must be in the image; commands then run as it through sudo", async () => {
    const sandbox = await daytona.create({ user: "alice", envVars: { A: "1" } });
    expect(sandbox.user).toBe("alice");
    const [ready] = world.called("sandbox.exec")[0] as [string[]];
    expect(ready.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(ready.at(-1)).toBe("alice");
    await sandbox.process.executeCommand("whoami");
    const [argv, options] = world.called("sandbox.exec").at(-1) as [
      string[],
      Record<string, unknown>,
    ];
    expect(argv.slice(0, 7)).toEqual(["sudo", "-u", "alice", "-H", "--", "env", "A=1"]);
    expect(argv.slice(-3)).toEqual(["bash", "-c", "{ whoami\n} 2>&1"]);
    expect(options.env).toBeUndefined();
    // get() finds the user again.
    expect((await daytona.get(sandbox.id)).user).toBe("alice");
    // Files this client writes are given to the user.
    await sandbox.fs.uploadFile(Buffer.from("x"), "a.txt");
    expect(world.called("sandbox.exec").at(-1)![0]).toEqual([
      "sudo",
      "chown",
      "alice",
      "--",
      "/workspace/a.txt",
    ]);
  });

  test("a user the image lacks ends the sandbox and says how to add it", async () => {
    world.exec = () => ({ exitCode: 3 });
    const error = await daytona.create({ user: "bob" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaytonaError);
    expect((error as Error).message).toMatch(/useradd -m bob/);
    expect(world.called("sandbox.stop")).toHaveLength(1);
    expect(await daytona.create({ user: "Bob; rm" }).catch((e: unknown) => e)).toBeInstanceOf(
      DaytonaError,
    );
    // The owner's names run as the owner.
    const owner = await daytona.create({ user: "daytona" });
    expect(owner.user).toBe("daytona");
  });
});

describe("autoStopInterval past an hour, or 0", () => {
  /* Since 0300 a sandbox with no time to live has no time limit: the
     interval is its idle pause, counted by the sandbox itself, and nothing
     here extends anything, so a long command is never frozen for want of
     calls from this object. */
  test("120 minutes: no time limit, paused after 120 idle minutes by the sandbox", async () => {
    jest.useFakeTimers();
    const sandbox = await daytona.create({ autoStopInterval: 120 });
    const create = world.called("sandboxes.create").at(-1)![0] as Record<string, unknown>;
    expect(create).toMatchObject({ idlePauseSeconds: 7200 });
    expect(create).not.toHaveProperty("timeoutSeconds");
    await sandbox.process.executeCommand("true");
    for (let minute = 0; minute < 180; minute++) {
      jest.advanceTimersByTime(60_000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    expect(world.called("sandbox.extend")).toHaveLength(0);
  });

  test("0: never paused for idleness, with no time limit", async () => {
    await daytona.create({ autoStopInterval: 0 });
    const create = world.called("sandboxes.create").at(-1)![0] as Record<string, unknown>;
    expect(create).toMatchObject({ idlePauseSeconds: 0 });
    expect(create).not.toHaveProperty("timeoutSeconds");
  });

  test("a time to live is a time limit, kept by the lease", async () => {
    await daytona.create({ ttlMinutes: 30 });
    const create = world.called("sandboxes.create").at(-1)![0] as Record<string, unknown>;
    expect(create).toMatchObject({ timeoutSeconds: 900, onLeaseEnd: "stop" });
    expect(create).not.toHaveProperty("idlePauseSeconds");
  });
});

describe("list filters and sorting", () => {
  test("name prefixes, resources, dates and sort apply as Daytona's API does", async () => {
    for (const [name, cpu] of [
      ["web-b", 2],
      ["api", 4],
      ["web-a", 1],
    ] as const)
      await daytona.create({ name, resources: { cpu } });
    const names = async (query: Parameters<Daytona["list"]>[0]) =>
      (await daytona.list(query)).items.map((one) => one.name);
    expect(await names({ name: "WEB-", sort: "name", order: "asc" })).toEqual(["web-a", "web-b"]);
    expect(await names({ sort: "cpu" })).toEqual(["api", "web-b", "web-a"]);
    expect(await names({ minCpu: 2, maxCpu: 3 })).toEqual(["web-b"]);
    expect(await names({ createdAtBefore: new Date(1_700_000_000_000) })).toEqual([]);
    expect(await names({ createdAtAfter: new Date(1_700_000_000_000) })).toHaveLength(3);
    expect(await names({ targets: ["eu"] })).toEqual([]);
    const iterated: string[] = [];
    for await (const one of daytona.list({ name: "web", sort: "name", order: "desc" }))
      iterated.push(one.name);
    expect(iterated).toEqual(["web-b", "web-a"]);
    expect(() => daytona.list({ sort: "size" as never })).toThrow(RangeError);
  });
});
