import { expect, test } from "bun:test";
import { Command, SandboxClient } from "../../src/codesandbox/index.js";
import type { Process, Sandbox } from "../../src/sandbox.js";
import type { OutputEvent } from "../../src/types.js";

function processFixture() {
  let end!: (exit: number) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const finished = new Promise<number>((resolve) => {
    end = resolve;
  });
  let kills = 0;
  const process = {
    async *output() {
      ready();
      const exit = await finished;
      yield { type: "stdout", data: `output-${exit}`, offset: 0 } as OutputEvent;
      yield { type: "exit", exitCode: exit, state: "exited", timedOut: false } as OutputEvent;
    },
    async kill() {
      kills++;
      end(137);
    },
  } as unknown as Process;
  return { process, started, end, kills: () => kills };
}

test("CodeSandbox restart fences old output and preserves already waiting callers", async () => {
  const old = processFixture(),
    next = processFixture();
  let starts = 0;
  const command = new Command(old.process, "server", "dev", async () => {
    starts++;
    return next.process;
  });
  const statuses: string[] = [],
    output: string[] = [];
  command.onStatusChange((value) => statuses.push(value));
  command.onOutput((value) => output.push(value));
  const waiting = command.waitUntilComplete();
  await old.started;
  expect(await command.restart()).toBeUndefined();
  await next.started;
  expect(command.status).toBe("RUNNING");
  expect(old.kills()).toBe(1);
  expect(starts).toBe(1);
  expect(output).toEqual([]);
  next.end(0);
  expect(await waiting).toBe("output-0");
  expect(await command.waitUntilComplete()).toBe("output-0");
  expect(statuses).toEqual(["FINISHED"]);
  await expect(command.restart()).rejects.toThrow("Command is not running");
  expect(starts).toBe(1);
});

test("CodeSandbox restart failure settles waiters and kill remains KILLED after delayed exit", async () => {
  const old = processFixture();
  const command = new Command(old.process, "server", undefined, async () => {
    throw new Error("capacity fixture");
  });
  const wait = command.waitUntilComplete();
  await expect(command.restart()).rejects.toThrow("capacity fixture");
  await expect(wait).rejects.toThrow("capacity fixture");
  expect(command.status).toBe("ERROR");
  const running = processFixture();
  const killed = new Command(running.process, "server");
  await killed.kill();
  await expect(killed.waitUntilComplete()).rejects.toMatchObject({
    name: "CommandError",
    exitCode: 1,
  });
  await Promise.resolve();
  expect(killed.status).toBe("KILLED");
});

test("CodeSandbox command restarts a real local child with its captured commands and environment", async () => {
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const invocations: unknown[] = [];
  let command: Command | undefined;
  const native = {
    files: { readText: async () => "{}", write: async () => undefined },
    spawn: async (argv: string, options: { env: Record<string, string>; cwd?: string }) => {
      invocations.push({ command: argv, env: { ...options.env }, cwd: options.cwd });
      const child = Bun.spawn(
        ["bash", "-c", children.length ? 'printf "%s" "$MESSAGE"' : "sleep 30"],
        {
          env: { ...process.env, ...options.env },
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      children.push(child);
      const output = new Response(child.stdout).text();
      return {
        async *output() {
          const exitCode = await child.exited;
          yield { type: "stdout", data: await output, offset: 0 };
          yield { type: "exit", exitCode, state: "exited", timedOut: false };
        },
        async kill() {
          child.kill();
          await child.exited;
        },
      } as unknown as Process;
    },
  } as unknown as Sandbox;
  try {
    const client = new SandboxClient(native, {});
    const argv = ["printf hello", "printf world"],
      options = { env: { MESSAGE: "kept" }, cwd: "/workspace" };
    command = await client.commands.runBackground(argv, options);
    argv[0] = "wrong";
    options.env.MESSAGE = "changed";
    const waiting = command.waitUntilComplete();
    await command.restart();
    expect(await waiting).toBe("kept");
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toEqual(invocations[0]);
    expect(await children[0]!.exited).toBeGreaterThan(0);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
});

test("CodeSandbox kill ignores exit received before its signal response", async () => {
  let exit!: () => void, finishKill!: () => void, read!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const response = new Promise<void>((resolve) => {
    finishKill = resolve;
  });
  const consumed = new Promise<void>((resolve) => {
    read = resolve;
  });
  const process = {
    async *output() {
      try {
        await exited;
        yield { type: "exit", exitCode: 137, state: "killed", timedOut: false };
      } finally {
        read();
      }
    },
    async kill() {
      exit();
      await response;
    },
  } as unknown as Process;
  const command = new Command(process, "server"),
    statuses: string[] = [];
  command.onStatusChange((status) => statuses.push(status));
  const killing = command.kill();
  await consumed;
  expect(statuses).toEqual([]);
  finishKill();
  await killing;
  await expect(command.waitUntilComplete()).rejects.toMatchObject({ exitCode: 1 });
  expect(statuses).toEqual(["KILLED"]);
});

test("CodeSandbox status assignments emit only changes", async () => {
  const fixture = processFixture();
  const command = new Command(fixture.process, "server");
  const statuses: string[] = [];
  command.onStatusChange((status) => statuses.push(status));
  command.status = "RESTARTING";
  command.status = "RESTARTING";
  command.status = "RUNNING";
  expect(statuses).toEqual(["RESTARTING", "RUNNING"]);
  fixture.end(0);
  await command.waitUntilComplete();
});
