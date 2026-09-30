/** Execute the same command-array consumer against the actual pinned SDK and Runtime. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { SandboxClient } from "../../src/codesandbox/index.js";
import { localSandbox } from "./codesandbox-local.js";
const root = process.argv[2];
if (!root) throw new Error("Usage: bun codesandbox-official.ts <prepared-reference-runtime>");
const official = await import(
  join(resolve(root), "node_modules/@codesandbox/sdk/dist/esm/index.js")
);
function event<T>() {
  const handlers = new Set<(value: T) => void>();
  return {
    on: (handler: (value: T) => void) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    },
    fire: (value: T) => {
      for (const handler of handlers) handler(value);
    },
  };
}
const world = await localSandbox();
const children: ReturnType<typeof Bun.spawn>[] = [];
const output = event<{ shellId: string; out: string }>(),
  exit = event<{ shellId: string; exitCode: number }>(),
  terminated = event<{ shellId: string }>();
const disposable = { onWillDispose: () => ({ dispose() {} }) };
const shells = {
  onShellOut: output.on,
  onShellExited: exit.on,
  onShellTerminated: terminated.on,
  async create(_cwd: string, _size: unknown, command: string) {
    const shellId = crypto.randomUUID();
    const child = Bun.spawn(["bash", "-c", command], {
      cwd: world.directory,
      env: { ...process.env, HOME: world.directory },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    const done = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // The official client subscribes after create returns, as its real daemon
    // does. Capture actual subprocess output; only transport delivery is modeled.
    setTimeout(() => {
      void done.then(([stdout, stderr, exitCode]) => {
        if (stdout || stderr) output.fire({ shellId, out: stdout + stderr });
        exit.fire({ shellId, exitCode });
      });
    }, 0);
    return { shellId, status: "RUNNING", buffer: [], shellType: "TERMINAL" };
  },
  async rename() {},
};
try {
  const baseline = new official.SandboxCommands(disposable, {
    workspacePath: world.directory,
    shells,
  });
  const runtime = new SandboxClient(world.native, {});
  async function flow(commands: typeof runtime.commands) {
    const success = await commands.run(["printf first", "printf second"], {
      cwd: world.directory,
      env: { CHECK: "value with ' quote" },
    });
    let failure: unknown;
    try {
      await commands.run(["printf before; exit 7", "printf forbidden"], { cwd: world.directory });
    } catch (error) {
      const e = error as { name: string; exitCode: number; output: string };
      failure = { name: e.name, code: e.exitCode, output: e.output };
    }
    return { success, failure };
  }
  const expected = await flow(baseline);
  assert.deepEqual(await flow(runtime.commands), expected);
  assert.deepEqual(expected, {
    success: "firstsecond",
    failure: { name: "CommandError", code: 7, output: "before" },
  });
  console.log(
    "Pinned CodeSandbox SDK2.4.2: unchanged sequential command-array workflow and failure output match with real local subprocesses.",
  );
  await world.native.files.write(
    "/project/sandbox/.codesandbox/tasks.json",
    JSON.stringify({
      tasks: { dev: { name: "dev", command: "exec sleep 30" } },
      setupTasks: [
        { name: "first", command: "printf first" },
        { name: "second", command: "printf second" },
      ],
    }),
  );
  const taskUpdates = event<unknown>();
  let taskData = {
    id: "dev",
    name: "dev",
    command: "exec sleep 30",
    ports: [],
    shell: null as unknown,
  };
  let activeTask: Awaited<ReturnType<typeof world.native.spawn>> | undefined;
  const agent = {
    ports: { getPorts: async () => [], onPortsUpdated: event<unknown>().on },
    tasks: {
      getTasks: async () => ({ tasks: { dev: taskData } }),
      onTaskUpdate: taskUpdates.on,
      async runTask() {
        if (activeTask) await activeTask.kill();
        activeTask = await world.native.spawn("exec sleep 30", { cwd: world.directory });
        taskData = { ...taskData, shell: { shellId: activeTask.id, status: "RUNNING" } };
        taskUpdates.fire(taskData);
      },
      async stopTask() {
        if (activeTask) await activeTask.kill();
        taskData = { ...taskData, shell: { shellId: activeTask?.id, status: "KILLED" } };
        taskUpdates.fire(taskData);
      },
    },
    shells,
  };
  async function taskFlow(tasks: typeof runtime.tasks) {
    const task = (await tasks.get("dev"))!;
    const initial = {
      id: task.id,
      name: task.name,
      command: task.command,
      status: task.status,
      runAtStart: task.runAtStart,
    };
    let openError = "";
    try {
      await task.open();
    } catch (error) {
      openError = (error as Error).message;
    }
    const idleStop = await task.stop();
    const started = await task.run();
    const restarted = await task.restart();
    const running = task.status;
    const stopped = await task.stop();
    return {
      initial,
      openError,
      idleStop,
      started,
      restarted,
      running,
      stopped,
      status: task.status,
      missing: await tasks.get("absent"),
    };
  }
  const officialTasks = new official.Tasks(disposable, agent);
  assert.deepEqual(await taskFlow(runtime.tasks), await taskFlow(officialTasks));
  await runtime.initialize();
  await runtime.setup.waitUntilComplete();
  const setupAgent = {
    setup: { onSetupProgressUpdate: event<unknown>().on },
    shells: { ...shells, open: async (id: string) => ({ buffer: [id] }) },
  };
  const baselineSetup = new official.Setup(disposable, setupAgent, {
    state: "FINISHED",
    currentStepIndex: 1,
    steps: ["first", "second"].map((name) => ({
      name,
      command: `printf ${name}`,
      shellId: name,
      finishStatus: "SUCCEEDED",
    })),
  });
  async function setupFlow(setup: typeof runtime.setup) {
    await setup.waitUntilComplete();
    const steps = [];
    for (const step of setup.getSteps()) {
      await step.waitUntilComplete();
      steps.push({
        name: step.name,
        command: step.command,
        status: step.status,
        output: await step.open(),
      });
    }
    return { status: setup.status, current: setup.currentStepIndex, steps };
  }
  assert.deepEqual(await setupFlow(runtime.setup), await setupFlow(baselineSetup));
  await runtime.disconnect();
  console.log(
    "Pinned CodeSandbox SDK2.4.2: task lifecycle results, idle errors, and finished setup/step outputs match published wrappers; Runtime setup uses the real guest runner locally.",
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  await world.close();
}
