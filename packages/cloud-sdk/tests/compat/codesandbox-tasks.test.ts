import { expect, test } from "bun:test";
import { SandboxClient } from "../../src/codesandbox/index.js";
import { localSandbox } from "./codesandbox-local.js";
import { ManagedTasks } from "../../src/codesandbox/guest-service.js";
import { chmod } from "node:fs/promises";

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const value = await read();
      if (accepts(value)) return value;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) throw new Error("Condition did not settle");
    await Bun.sleep(10);
  }
}

test("CodeSandbox configured tasks restart and reconnect across clients using real processes", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        tasks: { dev: { name: "Development server", command: "exec sleep 30" } },
        setupTasks: [],
      }),
    );
    const first = new SandboxClient(world.native, {});
    expect(await first.tasks.get("absent")).toBeUndefined();
    const task = (await first.tasks.get("dev"))!;
    expect({
      name: task.name,
      command: task.command,
      status: task.status,
      runAtStart: task.runAtStart,
    }).toEqual({
      name: "Development server",
      command: "exec sleep 30",
      status: "IDLE",
      runAtStart: false,
    });
    await expect(task.open()).rejects.toThrow("Task is not running");
    await task.stop();
    expect(world.children).toHaveLength(0);
    await task.run();
    const control = new ManagedTasks(world.native);
    const before = await control.call<{ id: string; pid: number }>({ op: "get", taskId: "dev" });
    expect(task.status).toBe("RUNNING");
    expect(await first.commands.getAll()).toEqual([]);
    await first.disconnect();
    const second = new SandboxClient(world.native, {});
    const resumed = (await second.tasks.get("dev"))!;
    expect(resumed.status).toBe("RUNNING");
    await resumed.restart();
    expect(() => process.kill(before.pid, 0)).toThrow();
    const after = await control.call<{ id: string; pid: number }>({ op: "get", taskId: "dev" });
    expect(after.id).not.toBe(before.id);
    await resumed.stop();
    expect(resumed.status).toBe("KILLED");
    expect(() => process.kill(after.pid, 0)).toThrow();
    await second.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox configured automatic tasks start in the guest supervisor", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        tasks: { dev: { name: "dev", command: "printf started; exec sleep 30", runAtStart: true } },
      }),
    );
    const client = new SandboxClient(world.native, {});
    const task = (await client.tasks.get("dev"))!;
    expect(task.status).toBe("RUNNING");
    expect(task.runAtStart).toBe(true);
    await client.disconnect();
    const control = new ManagedTasks(world.native);
    expect(await control.call({ op: "get", taskId: "dev" })).toMatchObject({ state: "running" });
    await client.reconnect();
    await (await client.tasks.get("dev"))!.stop();
    await client.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox guest service restarts automatic tasks with a new fenced run and preserves completed setup", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        setupTasks: ["sleep 0.1; printf once >> setup-count"],
        tasks: {
          dev: { name: "dev", command: "test -f setup-count && exec sleep 30", runAtStart: true },
        },
      }),
    );
    const client = new SandboxClient(world.native, {});
    await client.initialize();
    await client.setup.waitUntilComplete();
    const task = (await client.tasks.get("dev"))!;
    await until(
      async () => task.status,
      (status) => status === "RUNNING",
    );
    const control = new ManagedTasks(world.native);
    const before = await control.call<{ id: string; pid: number }>({ op: "get", taskId: "dev" });
    await client.disconnect();
    await world.restartService();
    const after = await until(
      () => control.call<{ id: string; pid: number; state: string }>({ op: "get", taskId: "dev" }),
      (run) => run?.id !== before.id && run?.state === "running",
    );
    expect(after.id).not.toBe(before.id);
    expect(() => process.kill(before.pid, 0)).toThrow();
    expect(await world.native.files.readText("/project/sandbox/setup-count")).toBe("once");
    await client.reconnect();
    expect((await client.tasks.get("dev"))!.status).toBe("RUNNING");
    await (await client.tasks.get("dev"))!.stop();
    await client.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox task controls serialize across clients and stale stop addresses the current task", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks: { dev: { name: "dev", command: "exec sleep 30" } } }),
    );
    const a = new SandboxClient(world.native, {}),
      b = new SandboxClient(world.native, {});
    const [first, second] = await Promise.all([a.tasks.get("dev"), b.tasks.get("dev")]);
    await Promise.all([first!.run(), second!.run()]);
    const control = new ManagedTasks(world.native);
    const running = await control.call<{ pid: number }>({ op: "get", taskId: "dev" });
    await first!.stop();
    expect(() => process.kill(running.pid, 0)).toThrow();
    expect(await control.call({ op: "get", taskId: "dev" })).toMatchObject({ state: "exited" });
    await a.disconnect();
    await b.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox task output preserves Unicode across bounded read chunks and nonzero exits", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        tasks: {
          dev: {
            name: "dev",
            command: "python3 -c \"import sys; sys.stdout.write('é' * 100000); sys.exit(7)\"",
          },
        },
      }),
    );
    const client = new SandboxClient(world.native, {});
    const task = (await client.tasks.get("dev"))!;
    await task.run();
    await until(
      async () => task.status,
      (status) => status === "ERROR",
    );
    expect(await task.open()).toBe("é".repeat(100000));
    await client.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox blocked terminal input cannot block task stop or supervisor health", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        tasks: {
          dev: { name: "dev", command: "stty raw -echo; touch input-ready; exec sleep 30" },
        },
      }),
    );
    const client = new SandboxClient(world.native, {});
    const task = (await client.tasks.get("dev"))!;
    await task.run();
    await until(() => world.native.files.exists("/project/sandbox/input-ready"), Boolean);
    const control = new ManagedTasks(world.native);
    const run = await control.call<{ id: string }>({ op: "get", taskId: "dev" });
    const writing = control
      .call({ op: "write", id: run.id, data: Buffer.alloc(512 * 1024, 65).toString("base64") })
      .then(
        () => "written",
        () => "cancelled",
      );
    await until(
      () => control.call<{ inputWriters?: number }>({ op: "get", taskId: "dev" }),
      (state) => state.inputWriters === 1,
    );
    expect(await control.call<{ ok: boolean }>({ op: "ping" })).toEqual({ ok: true });
    await task.stop();
    expect(await writing).toBe("cancelled");
    expect(await control.call({ op: "get", taskId: "dev" })).toMatchObject({ state: "exited" });
    await client.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox log write failures stay observable and do not take down task controls", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        tasks: { dev: { name: "dev", command: "python3 -c \"print('x' * 100000)\"" } },
      }),
    );
    const client = new SandboxClient(world.native, {});
    await client.tasks.getAll();
    await client.disconnect();
    // A real per-process filesystem write limit provokes EFBIG in the logger.
    await world.restartService({ fileSizeLimit: 1024 });
    const control = new ManagedTasks(world.native);
    await until(
      () => control.call<{ ok: boolean }>({ op: "ping" }),
      (reply) => reply.ok,
    );
    const process = await control.start("dev");
    const failed = await until(
      () =>
        control.call<{ state: string; exitCode: number; error?: string }>({
          op: "get",
          taskId: "dev",
        }),
      (run) => run.state === "exited",
    );
    expect(failed.exitCode).toBe(125);
    expect(failed.error).toContain("File too large");
    expect(await control.call<{ ok: boolean }>({ op: "ping" })).toEqual({ ok: true });
    await process.kill();
  } finally {
    await world.close();
  }
});

test("CodeSandbox a failed task metadata write rolls back startup and leaves supervisor usable", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks: { dev: { name: "dev", command: "exec sleep 30" } } }),
    );
    const client = new SandboxClient(world.native, {});
    await client.tasks.getAll();
    await client.disconnect();
    await world.restartService({ fileSizeLimit: 0 });
    const control = new ManagedTasks(world.native);
    await until(
      () => control.call<{ ok: boolean }>({ op: "ping" }),
      (reply) => reply.ok,
    );
    await expect(control.start("dev")).rejects.toThrow("File too large");
    expect(await control.call<{ ok: boolean }>({ op: "ping" })).toEqual({ ok: true });
    expect(await control.call<unknown>({ op: "get", taskId: "dev" })).toBeNull();
  } finally {
    await world.close();
  }
});

test("CodeSandbox a fresh client opens completed task output without waiting for a subscription", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks: { dev: { name: "dev", command: "printf saved-output" } } }),
    );
    const first = new SandboxClient(world.native, {});
    await (await first.tasks.get("dev"))!.run();
    const control = new ManagedTasks(world.native);
    await until(
      () => control.call<{ state: string }>({ op: "get", taskId: "dev" }),
      (run) => run.state === "exited",
    );
    await first.disconnect();
    const second = new SandboxClient(world.native, {});
    const task = (await second.tasks.get("dev"))!;
    expect(task.status).toBe("FINISHED");
    expect(await task.open()).toBe("saved-output");
    await second.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox final state remains readable when saving the result is refused", async () => {
  const world = await localSandbox();
  const root = "/workspace/.runtime-compat/codesandbox/service";
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        tasks: {
          dev: {
            name: "dev",
            command: "while [ ! -f finish ]; do sleep 0.02; done; printf finished",
          },
        },
      }),
    );
    const client = new SandboxClient(world.native, {});
    await (await client.tasks.get("dev"))!.run();
    const control = new ManagedTasks(world.native);
    const run = await control.call<{ id: string }>({ op: "get", taskId: "dev" });
    await until(() => world.native.files.exists(`${root}/${run.id}.log`), Boolean);
    await chmod(world.path(root), 0o500);
    await world.native.files.write("/project/sandbox/finish", "ready");
    const result = await until(
      () =>
        control.call<{ state: string; exitCode: number; error?: string }>({
          op: "get",
          taskId: "dev",
        }),
      (value) => value.state === "exited",
    );
    expect(result.exitCode).toBe(125);
    expect(result.error).toContain("Cannot persist task result");
    expect(await control.call<{ ok: boolean }>({ op: "ping" })).toEqual({ ok: true });
    await client.disconnect();
  } finally {
    await chmod(world.path(root), 0o700);
    await world.close();
  }
});

test("CodeSandbox automatic task startup failure remains visible when disk writes fail", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        tasks: { dev: { name: "dev", command: "exec sleep 30", runAtStart: true } },
      }),
    );
    const client = new SandboxClient(world.native, {});
    await client.tasks.getAll();
    await client.disconnect();
    await world.restartService({ fileSizeLimit: 0 });
    const control = new ManagedTasks(world.native);
    const run = await until(
      () => control.call<{ state: string; error?: string }>({ op: "get", taskId: "dev" }),
      (run) =>
        run.state === "exited" && Boolean(run.error?.includes("Automatic task startup failed")),
    );
    expect(run.error).toContain("File too large");
    expect(await control.call<{ ok: boolean }>({ op: "ping" })).toEqual({ ok: true });
    const failed = await control.get("dev");
    const collect = async () => {
      for await (const _event of failed!.output()) {
        /* Drain to the terminal failure. */
      }
    };
    await expect(collect()).rejects.toThrow("Automatic task startup failed");
  } finally {
    await world.close();
  }
});
