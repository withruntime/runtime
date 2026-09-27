import { beforeEach, describe, expect, test } from "bun:test";
import { RuntimeError } from "../../src/errors";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFileLines, parseProcessLine, processLine } from "../../src/blaxel/context";
import { ResponseError, SandboxInstance } from "../../src/blaxel/index";
import { portWaitScript, resetProcesses } from "../../src/blaxel/process";
import { BlaxelWorld, requests } from "./fake";

let world: BlaxelWorld;
const withruntime = () => ({ client: world.client() });
const create = (name = "box") => SandboxInstance.create({ name, withruntime: withruntime() });
const spawned = () => world.called("sandbox.spawn");
const streamed = () => world.called("sandbox.execStream");
type Out = { type: "stdout" | "stderr"; data: string; offset: number };
const out = (type: "stdout" | "stderr", data: string): Out => ({ type, data, offset: 0 });
const exit = (exitCode: number | null, state = "exited") => ({
  type: "exit" as const,
  exitCode,
  state,
  timedOut: false,
});

beforeEach(() => {
  world = new BlaxelWorld();
  resetProcesses();
});

describe("process.exec", () => {
  test("without waitForCompletion: one spawn, answered running, the command marked with its name", async () => {
    const sandbox = await create();
    const from = world.calls.length;
    const started = await sandbox.process.exec({ command: "echo 'Hello, World!'" });
    expect(requests(world, from)).toEqual(["sandbox.spawn"]);
    expect(started).toMatchObject({
      status: "running",
      command: "echo 'Hello, World!'",
      exitCode: 0,
      completedAt: "",
      workingDir: "",
      pid: "proc-1",
    });
    expect(started.name).toMatch(/^[a-z0-9]{8}$/);
    const [line, options] = spawned()[0]!;
    expect(parseProcessLine(line as string)).toEqual({
      name: started.name,
      command: "echo 'Hello, World!'",
      keepAlive: false,
    });
    expect(options).toMatchObject({ cwd: "/workspace", timeoutMs: 86_400_000 });
    expect(started.startedAt).toMatch(/GMT$/);
  });

  test("waitForCompletion: one streamed request, with Blaxel's result", async () => {
    world.output = () => [out("stdout", "Hello, World!\n"), out("stderr", "warn\n"), exit(0)];
    const sandbox = await create();
    const from = world.calls.length;
    const done = await sandbox.process.exec({
      name: "hello-process",
      command: "echo 'Hello, World!'",
      waitForCompletion: true,
    });
    expect(requests(world, from)).toEqual(["sandbox.execStream"]);
    expect(done).toMatchObject({
      name: "hello-process",
      status: "completed",
      exitCode: 0,
      stdout: "Hello, World!\n",
      stderr: "warn\n",
      logs: "Hello, World!\nwarn\n",
    });
    expect(done.completedAt).toMatch(/GMT$/);
  });

  test("a non-zero exit is failed, with its code", async () => {
    world.output = () => [exit(3)];
    const sandbox = await create();
    const done = await sandbox.process.exec({ command: "exit 3", waitForCompletion: true });
    expect([done.status, done.exitCode]).toEqual(["failed", 3]);
  });

  test("past timeout the wait gives up with Blaxel's 422 and the process is left running", async () => {
    world.delayMs = 40;
    world.output = () => [out("stdout", "a\n"), out("stdout", "b\n"), exit(0)];
    const sandbox = await create();
    const error = (await sandbox.process
      .exec({ command: "sleep 9", waitForCompletion: true, timeout: 0.05 })
      .catch((e: unknown) => e)) as ResponseError;
    expect(error).toBeInstanceOf(ResponseError);
    expect([error.status, error.message]).toEqual([
      422,
      "Sandbox request failed with status 422: process timed out after 0.05 seconds",
    ]);
    expect(world.called("process.kill")).toEqual([]);
  });

  test("callbacks get the output as it comes", async () => {
    world.output = () => [out("stdout", "one\n"), out("stderr", "two\n"), exit(0)];
    const sandbox = await create();
    const seen: string[] = [];
    await sandbox.process.exec({
      command: "x",
      waitForCompletion: true,
      onStdout: (text) => seen.push(`out:${text}`),
      onStderr: (text) => seen.push(`err:${text}`),
      onLog: (text) => seen.push(`log:${text}`),
    });
    expect(seen).toEqual(["out:one\n", "log:one\n", "err:two\n", "log:two\n"]);
  });

  test("onLog without waiting streams line by line in the background and close() stops it", async () => {
    world.output = () => [out("stdout", "Starting\nProcess"), out("stdout", "ing...\n"), exit(0)];
    const sandbox = await create();
    const lines: string[] = [];
    const started = await sandbox.process.exec({
      name: "streaming-demo",
      command: "echo",
      onLog: (log) => lines.push(log),
    });
    expect("close" in started).toBe(true);
    await sandbox.process.wait("streaming-demo");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lines).toEqual(["Starting", "Processing..."]);
  });

  test("env, workingDir (/blaxel is /workspace) and a process's env winning over the sandbox's", async () => {
    const sandbox = await create();
    await sandbox.process.exec({
      command: "node server.js",
      workingDir: "/blaxel/app",
      env: { PORT: "8080", LOG_LEVEL: "debug" },
    });
    const [line, options] = spawned().at(-1)!;
    expect(options).toMatchObject({
      cwd: "/workspace/app",
      env: { PORT: "8080", LOG_LEVEL: "debug", RUNTIME_BLAXEL_KEEP: ":PORT:LOG_LEVEL:" },
    });
    expect(line).toContain("[ -r /etc/runtime-blaxel/env ] && . /etc/runtime-blaxel/env");
    expect(line).not.toContain("8080");
    await sandbox.process.exec({ command: "ls", workingDir: "/app" });
    expect(spawned().at(-1)![1]).toMatchObject({ cwd: "/app" });
  });

  test("a command naming /blaxel links it to /workspace in the same command", async () => {
    const sandbox = await create();
    await sandbox.process.exec({ command: "cat /blaxel/app/config.json" });
    expect(spawned().at(-1)![0]).toContain("sudo ln -s /workspace /blaxel");
    await sandbox.process.exec({ command: "ls" });
    expect(spawned().at(-1)![0]).not.toContain("ln -s");
  });

  test("keepAlive: awake as long as the process may run, the old idle pause kept in a label", async () => {
    const sandbox = await create();
    const from = world.calls.length;
    await sandbox.process.exec({
      name: "dev",
      command: "npm run dev",
      keepAlive: true,
      timeout: 3600,
    });
    expect(requests(world, from).sort()).toEqual(["sandbox.spawn", "sandbox.update"]);
    expect(world.called("sandbox.update").at(-1)![1]).toEqual({
      idlePauseSeconds: 3600,
      labels: expect.objectContaining({ "blaxel/idlePauseSeconds": "60" }),
    });
    const [line, options] = spawned().at(-1)!;
    expect(line).toMatch(/^: rt-blaxel 'dev'; : rt-blaxel-keep; /);
    expect(options).toMatchObject({ timeoutMs: 3_600_000 });
    await sandbox.process.exec({ command: "w", keepAlive: true });
    expect(spawned().at(-1)![1]).toMatchObject({ timeoutMs: 600_000 });
    await sandbox.process.exec({ command: "w", keepAlive: true, timeout: 0 });
    // A second (and a forever) keepAlive raises the pause but keeps the label's first value.
    expect(world.called("sandbox.update").at(-1)![1]).toEqual({
      idlePauseSeconds: 0,
      labels: expect.objectContaining({ "blaxel/idlePauseSeconds": "60" }),
    });
    expect(spawned().at(-1)![1]).toMatchObject({ timeoutMs: 86_400_000 });
  });

  test("restartOnFailure runs the command again up to maxRestarts", async () => {
    const sandbox = await create();
    await sandbox.process.exec({ command: "npm start", restartOnFailure: true, maxRestarts: 5 });
    const line = spawned().at(-1)![0] as string;
    expect(line).toContain("[ $__rt_n -ge 5 ] && exit $__rt_c");
    expect(parseProcessLine(line)!.command).toBe("npm start");
  });

  test("waitForPorts waits in the sandbox; a port that never opens is Blaxel's 422", async () => {
    const sandbox = await create();
    await sandbox.process.exec({ command: "npm run dev", waitForPorts: [3000] });
    const [argv, options] = world.called("sandbox.exec").at(-1)!;
    expect((argv as string[])[2]).toContain("0BB8");
    expect(options).toMatchObject({ timeoutMs: 65_000 });
    world.exec = () => ({ exitCode: 1 });
    const error = (await sandbox.process
      .exec({ command: "npm run dev", waitForPorts: [3000], timeout: 5 })
      .catch((e: unknown) => e)) as ResponseError;
    expect([error.status, error.message]).toEqual([
      422,
      "Sandbox request failed with status 422: process timed out waiting for ports after 5 seconds",
    ]);
  });

  test("a spawn refused because the sandbox was paused is made once more after a wake", async () => {
    const sandbox = await create();
    world.refuse = new RuntimeError({ message: "paused", code: "sandbox_paused", status: 409 });
    const started = await sandbox.process.exec({ command: "ls" });
    expect(started.status).toBe("running");
    expect(world.called("sandbox.wake")).toHaveLength(1);
    expect(spawned()).toHaveLength(1);
  });

  test("a streamed exec refused before it started is made once more; one cut off after is not", async () => {
    world.output = () => [exit(0)];
    const sandbox = await create();
    world.refuse = new RuntimeError({ message: "paused", code: "sandbox_paused", status: 409 });
    await sandbox.process.exec({ command: "ls", waitForCompletion: true });
    expect(streamed()).toHaveLength(2);
    expect(world.called("sandbox.wake")).toHaveLength(1);
  });
});

describe("keepAlive gives the idle pause back", () => {
  const liveFor = (_command: string) => [out("stdout", "up\n")] as never;
  const label = (sandbox: SandboxInstance) =>
    world.sandboxes.get(sandbox.withruntime.id)!.info.labels["blaxel/idlePauseSeconds"];
  const idle = (sandbox: SandboxInstance) =>
    world.sandboxes.get(sandbox.withruntime.id)!.info.idlePauseSeconds;

  test("a fresh client holds it while another keepAlive process runs, and gives it back after", async () => {
    world.output = (command) => (command.includes("rt-blaxel-keep") ? liveFor(command) : [exit(0)]);
    const sandbox = await create("hold");
    await sandbox.process.exec({ name: "a", command: "serve", keepAlive: true });
    await sandbox.process.exec({ name: "b", command: "serve", keepAlive: true, timeout: 1200 });
    resetProcesses();
    const fresh = await SandboxInstance.get("hold", { withruntime: withruntime() });
    expect([label(fresh), idle(fresh)]).toEqual(["60", 1200]);
    await fresh.process.kill("a");
    expect(label(fresh)).toBe("60");
    await fresh.process.stop("b");
    expect([label(fresh), idle(fresh)]).toEqual([undefined, 60]);
    const updates = world.called("sandbox.update").length;
    await SandboxInstance.get("hold", { withruntime: withruntime() });
    expect(world.called("sandbox.update")).toHaveLength(updates);
  });

  test("one killed at its time limit gives it back at the next fresh get", async () => {
    world.output = () => liveFor("x");
    const sandbox = await create("limit");
    await sandbox.process.exec({ name: "dev", command: "serve", keepAlive: true, timeout: 120 });
    const process = world.sandboxes.get(sandbox.withruntime.id)!.processList[0]!;
    Object.assign(process.info, {
      state: "timed_out",
      exitCode: -9,
      endedAt: new Date().toISOString(),
    });
    expect(label(sandbox)).toBe("60");
    const fresh = await SandboxInstance.get("limit", { withruntime: withruntime() });
    expect([label(fresh), idle(fresh)]).toEqual([undefined, 60]);
  });

  test("a waited keepAlive process gives it back when it ends", async () => {
    world.output = () => [out("stdout", "built\n"), exit(0)];
    const sandbox = await create("waited");
    const done = await sandbox.process.exec({
      command: "npm run build",
      keepAlive: true,
      waitForCompletion: true,
    });
    expect(done.status).toBe("completed");
    expect([label(sandbox), idle(sandbox)]).toEqual([undefined, 60]);
  });

  test("a sandbox whose idle pause was never raised is left alone", async () => {
    const sandbox = await create("plain");
    const updates = world.called("sandbox.update").length;
    await SandboxInstance.get("plain", { withruntime: withruntime() });
    await sandbox.process.exec({ command: "ls", waitForCompletion: true });
    expect(world.called("sandbox.update")).toHaveLength(updates);
    expect(world.called("processes.list")).toEqual([]);
  });
});

describe("processes by name", () => {
  test("get by name in this client: one read and the output", async () => {
    world.output = () => [out("stdout", "hi\n"), exit(0)];
    const sandbox = await create();
    await sandbox.process.exec({ name: "hello-process", command: "echo hi" });
    const from = world.calls.length;
    const found = await sandbox.process.get("hello-process");
    expect(requests(world, from)).toEqual(["processes.get", "processes.follow"]);
    expect(found).toMatchObject({
      name: "hello-process",
      status: "completed",
      stdout: "hi\n",
      logs: "hi\n",
    });
  });

  test("get by name from a fresh client finds the process by its marker", async () => {
    world.output = () => [out("stdout", "hi\n"), exit(0)];
    await (await create("fresh")).process.exec({ name: "server", command: "node server.js" });
    resetProcesses();
    const again = await SandboxInstance.get("fresh", { withruntime: withruntime() });
    const from = world.calls.length;
    const found = await again.process.get("server");
    expect(requests(world, from)).toEqual(["processes.list", "processes.follow"]);
    expect(found).toMatchObject({ name: "server", command: "node server.js", stdout: "hi\n" });
    const missing = (await again.process.get("nope").catch((e: unknown) => e)) as ResponseError;
    expect([missing.status, missing.message]).toEqual([
      404,
      "Sandbox request failed with status 404: process not found",
    ]);
  });

  test("a command longer than Runtime's 256-character record keeps its name and the start of the command", async () => {
    world.output = () => [out("stdout", "x\n"), exit(0)];
    const sandbox = await create("long");
    const command = `echo ${"x".repeat(400)}`;
    await sandbox.process.exec({ name: "long-one", command });
    const record = world.sandboxes.get(sandbox.withruntime.id)!.processList[0]!;
    record.info.command = (record.info.command as string).slice(0, 256);
    resetProcesses();
    const found = await sandbox.process.get("long-one");
    expect(found.name).toBe("long-one");
    expect(command.startsWith(found.command)).toBe(true);
    expect(found.command.length).toBeGreaterThan(50);
    expect((await sandbox.process.list()).map((one) => one.name)).toEqual(["long-one"]);
  });

  test("restartCount counts Blaxel's restart notes in the output", async () => {
    world.output = () => [
      out("stdout", "run\n\n[Process failed with exit code 1. Attempting restart 1/2...]\nrun\n"),
      out("stdout", "\n[Process failed with exit code 1. Attempting restart 2/2...]\nrun\n"),
      exit(1),
    ];
    const sandbox = await create();
    const done = await sandbox.process.exec({
      command: "flaky",
      restartOnFailure: true,
      maxRestarts: 2,
      waitForCompletion: true,
    });
    expect([
      done.status,
      done.exitCode,
      done.restartCount,
      done.restartOnFailure,
      done.maxRestarts,
    ]).toEqual(["failed", 1, 2, true, 2]);
  });

  test("the newest process of a name wins", async () => {
    world.output = () => [exit(0)];
    const sandbox = await create();
    await sandbox.process.exec({ name: "job", command: "one" });
    await sandbox.process.exec({ name: "job", command: "two" });
    resetProcesses();
    expect((await sandbox.process.get("job")).command).toBe("two");
  });

  test("wait follows to the end; maxWait bounds it without stopping the process", async () => {
    world.output = () => [out("stdout", "done\n"), exit(0)];
    const sandbox = await create();
    await sandbox.process.exec({ name: "long-task", command: "sleep 10" });
    const done = await sandbox.process.wait("long-task", { maxWait: 600_000, interval: 5000 });
    expect([done.status, done.stdout]).toEqual(["completed", "done\n"]);
    world.delayMs = 50;
    await sandbox.process.exec({ name: "slow", command: "sleep 10" });
    const late = (await sandbox.process
      .wait("slow", { maxWait: 20 })
      .catch((e: unknown) => e)) as Error;
    expect(late.message).toBe("Process did not finish in time (slow); it may still be running");
    expect(world.called("process.kill")).toEqual([]);
    expect(() => sandbox.process.wait("slow", { maxWait: -5 })).toThrow(RangeError);
  });

  test("stop and kill signal the process and its status says which", async () => {
    world.output = () => [exit(null, "killed")];
    const sandbox = await create();
    await sandbox.process.exec({ name: "a", command: "sleep 99" });
    await sandbox.process.exec({ name: "b", command: "sleep 99" });
    expect(await sandbox.process.stop("a")).toEqual({ message: "Process stop requested" });
    expect(await sandbox.process.kill("b")).toEqual({ message: "Process kill requested" });
    expect(world.called("process.kill")).toEqual([
      ["proc-1", "SIGTERM"],
      ["proc-2", "SIGKILL"],
    ]);
    expect(await sandbox.process.get("a")).toMatchObject({ status: "stopped", exitCode: -1 });
    expect(await sandbox.process.get("b")).toMatchObject({ status: "killed", exitCode: -1 });
    resetProcesses();
    // From a fresh client too: the signal is in Runtime's record.
    expect((await sandbox.process.get("a")).status).toBe("stopped");
  });

  test("logs by stream; list shows only this adapter's processes", async () => {
    world.output = () => [out("stdout", "o\n"), out("stderr", "e\n"), exit(0)];
    const sandbox = await create();
    await sandbox.process.exec({ name: "p", command: "x" });
    expect(await sandbox.process.logs("p")).toBe("o\ne\n");
    expect(await sandbox.process.logs("p", "stderr")).toBe("e\n");
    expect(await sandbox.process.logs("p", "stdout")).toBe("o\n");
    await sandbox.withruntime.spawn("not-ours", {});
    const listed = await sandbox.process.list();
    expect(listed.map((one) => one.name)).toEqual(["p"]);
  });

  test("streamLogs gives whole lines to each callback and ends with the process", async () => {
    world.output = () => [
      out("stdout", "Output 1\nOut"),
      out("stdout", "put 2\n"),
      out("stderr", "x"),
      exit(0),
    ];
    const sandbox = await create();
    await sandbox.process.exec({ name: "stream-demo", command: "loop" });
    const seen: string[] = [];
    const stream = sandbox.process.streamLogs("stream-demo", {
      onLog: (log) => seen.push(`log:${log}`),
      onStdout: (text) => seen.push(`out:${text}`),
      onStderr: (text) => seen.push(`err:${text}`),
    });
    await stream.wait();
    stream.close();
    expect(seen).toEqual([
      "out:Output 1",
      "log:Output 1",
      "out:Output 2",
      "log:Output 2",
      "err:x",
      "log:x",
    ]);
  });

  test("stdin: a pipe opened at start, written and closed by name", async () => {
    const sandbox = await create();
    await sandbox.process.exec({ name: "mcp", command: "mcp-server", stdin: true });
    expect(spawned().at(-1)![1]).toMatchObject({ stdin: "pipe" });
    await sandbox.process.writeStdin("mcp", '{"jsonrpc":"2.0"}\n');
    await sandbox.process.closeStdin("mcp");
    expect(world.called("process.write")).toEqual([
      ["proc-1", '{"jsonrpc":"2.0"}\n', {}],
      ["proc-1", "", { eof: true }],
    ]);
  });
});

describe("speed", () => {
  test("create then a first waited command is two requests, as with withruntime itself", async () => {
    world.output = () => [out("stdout", "ok\n"), exit(0)];
    const sandbox = await SandboxInstance.create({ withruntime: withruntime() });
    await sandbox.process.exec({ command: "echo ok", waitForCompletion: true });
    expect(requests(world, 0)).toEqual(["sandboxes.create", "sandbox.execStream"]);
  });
});

describe("the process line", () => {
  test("its exact form, which the Python adapter writes too", () => {
    expect(processLine("echo 'hi'", { name: "web" })).toBe(
      ": rt-blaxel 'web'; export HOST=\"${HOST:-0.0.0.0}\"; [ -r /etc/runtime-blaxel/env ] && . /etc/runtime-blaxel/env; " +
        "unset RUNTIME_BLAXEL_KEEP; __rt_cmd='echo '\\''hi'\\'''; export __rt_cmd; " +
        'exec sudo -E env "PATH=$PATH" "HOME=$HOME" bash -c \'eval "$__rt_cmd"\'',
    );
    expect(processLine("x", { name: "k", keepAlive: true, linkHome: true })).toStartWith(
      ": rt-blaxel 'k'; : rt-blaxel-keep; export HOST=",
    );
    expect(processLine("x", { name: "k", linkHome: true })).toContain(
      "unset RUNTIME_BLAXEL_KEEP; { [ -e /blaxel ] || sudo ln -s /workspace /blaxel; } 2>/dev/null; __rt_cmd='x'",
    );
  });

  test("run by bash (sudo left out here), it keeps env precedence, HOME, stdin, exit codes and restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "blaxel-line-"));
    const file = join(dir, "env");
    writeFileSync(file, envFileLines({ A: "from-sandbox", PORT: "3000", HOME: "/blaxel-home" }));
    const run = (line: string, env: Record<string, string>, input?: string) =>
      spawnSync(
        "bash",
        [
          "-c",
          line.replaceAll("/etc/runtime-blaxel/env", file).replace("exec sudo -E env", "exec env"),
        ],
        { encoding: "utf8", input, env: { PATH: process.env.PATH!, HOME: "/workspace", ...env } },
      );
    const plain = run(
      processLine("echo $A $PORT $HOME $HOST; read x; echo got $x; exit 7", { name: "n" }),
      { PORT: "8080", RUNTIME_BLAXEL_KEEP: ":PORT:" },
      "line\n",
    );
    expect([plain.status, plain.stdout]).toEqual([
      7,
      "from-sandbox 8080 /blaxel-home 0.0.0.0\ngot line\n",
    ]);
    const restarted = run(processLine("echo run; exit 2", { name: "r", maxRestarts: 1 }), {});
    expect([restarted.status, restarted.stdout]).toEqual([
      2,
      "run\n\n[Process failed with exit code 2. Attempting restart 1/1...]\nrun\n",
    ]);
  });

  test("the port wait reads whichever socket tables exist, and never counts loopback", () => {
    const dir = mkdtempSync(join(tmpdir(), "blaxel-ports-"));
    const header = "  sl  local_address rem_address   st\n";
    const tcp = join(dir, "tcp");
    const missing = join(dir, "tcp6");
    const wait = (seconds: number) =>
      spawnSync("bash", ["-c", portWaitScript([3000], seconds, [tcp, missing])], {
        encoding: "utf8",
      });
    writeFileSync(tcp, `${header}   0: 00000000:0BB8 00000000:0000 0A\n`);
    expect(wait(5).status).toBe(0);
    writeFileSync(tcp, `${header}   0: 0100007F:0BB8 00000000:0000 0A\n`);
    expect(wait(1).status).toBe(1);
    writeFileSync(tcp, `${header}   0: 00000000:0BB8 00000000:0000 01\n`);
    expect(wait(1).status).toBe(1);
    const none = spawnSync("bash", ["-c", portWaitScript([3000], 1, [missing])], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(none.status).toBe(1);
  });
});
