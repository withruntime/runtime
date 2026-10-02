import { expect, test } from "bun:test";
import { SandboxClient } from "../../src/codesandbox/index.js";
import { localSandbox } from "./codesandbox-local.js";
import { chmod, mkdir } from "node:fs/promises";
import { ManagedTasks } from "../../src/codesandbox/guest-service.js";

test("CodeSandbox zero-exit setup runner fails on lock-free stale progress", async () => {
  const world = await localSandbox();
  try {
    const tasks = { dev: { name: "dev", command: "exec sleep 30" } };
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks }),
    );
    const first = new SandboxClient(world.native, {});
    await first.tasks.getAll();
    await first.disconnect();
    const steps = [{ name: "install", command: "printf ready" }];
    const identity = JSON.stringify(steps);
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks, setupTasks: steps }),
    );
    const root = "/workspace/.runtime-compat/codesandbox/service";
    const config = JSON.parse(await world.native.files.readText(`${root}/config.json`)) as Record<
      string,
      unknown
    >;
    config.setup = { steps, config: identity };
    await world.native.files.write(`${root}/config.json`, JSON.stringify(config));
    await world.native.files.write(`${root}/setup.py`, "raise SystemExit(0)\n");
    await world.native.files.write(
      "/workspace/.runtime-compat/codesandbox/setup/progress.json",
      JSON.stringify({
        state: "IN_PROGRESS",
        config: identity,
        runId: "stale",
        currentStepIndex: 0,
        steps: steps.map((step) => ({ ...step, status: "IDLE" })),
      }),
    );
    await world.restartService();
    const control = new ManagedTasks(world.native);
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        if ((await control.boot())?.state === "failed") break;
      } catch {
        /* Wait for the new socket. */
      }
      if (Date.now() >= deadline) throw new Error("Lock-free stale progress was not rejected");
      await Bun.sleep(10);
    }
    const second = new SandboxClient(world.native, {});
    await second.initialize();
    await expect(second.setup.waitUntilComplete()).rejects.toThrow(
      "Setup exited without terminal progress",
    );
    expect(second.setup.status).toBe("STOPPED");
    await second.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox boot waits for another setup runner that still owns its lock", async () => {
  const world = await localSandbox();
  let active: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const tasks = { dev: { name: "dev", command: "exec sleep 30" } };
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks }),
    );
    const first = new SandboxClient(world.native, {});
    await first.tasks.getAll();
    await first.disconnect();
    const steps = [{ name: "peer", command: "printf ready" }];
    const identity = JSON.stringify(steps);
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks, setupTasks: steps }),
    );
    const root = "/workspace/.runtime-compat/codesandbox/service";
    const setup = "/workspace/.runtime-compat/codesandbox/setup";
    const config = JSON.parse(await world.native.files.readText(`${root}/config.json`)) as Record<
      string,
      unknown
    >;
    config.setup = { steps, config: identity };
    await world.native.files.write(`${root}/config.json`, JSON.stringify(config));
    await world.native.files.write(
      `${setup}/progress.json`,
      JSON.stringify({
        state: "IN_PROGRESS",
        config: identity,
        runId: "peer",
        currentStepIndex: 0,
        steps: steps.map((step) => ({ ...step, status: "IDLE" })),
      }),
    );
    active = Bun.spawn(
      [
        "python3",
        "-c",
        `import fcntl,json,os,sys,time
root=sys.argv[1]
lock=open(root+'/lock','a')
fcntl.flock(lock,fcntl.LOCK_EX)
open(root+'/locked','w').close()
while not os.path.exists(root+'/finish'): time.sleep(0.02)
with open(root+'/progress.json') as f: progress=json.load(f)
progress['state']='FINISHED'
for step in progress['steps']: step['status']='SUCCEEDED'
with open(root+'/progress-peer.tmp','w') as f: json.dump(progress,f)
os.replace(root+'/progress-peer.tmp',root+'/progress.json')
`,
        world.path(setup),
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    const deadline = Date.now() + 5000;
    while (!(await world.native.files.exists(`${setup}/locked`))) {
      if (Date.now() >= deadline) throw new Error("Peer runner did not lock setup");
      await Bun.sleep(10);
    }
    await world.restartService();
    const control = new ManagedTasks(world.native);
    for (;;) {
      try {
        const boot = await control.boot();
        if (boot?.config === identity) {
          expect(boot.state).toBe("starting");
          break;
        }
      } catch {
        /* Wait for the new socket. */
      }
      if (Date.now() >= deadline) throw new Error("Boot did not wait for active setup");
      await Bun.sleep(10);
    }
    await world.native.files.write(`${setup}/finish`, "ready");
    expect(await active.exited).toBe(0);
    for (;;) {
      const boot = await control.boot();
      if (boot?.state === "ready") break;
      if (boot?.state === "failed") throw new Error(boot.error);
      if (Date.now() >= deadline) throw new Error("Peer runner completion was not observed");
      await Bun.sleep(10);
    }
    const second = new SandboxClient(world.native, {});
    await second.initialize();
    await second.setup.waitUntilComplete();
    expect(second.setup.status).toBe("FINISHED");
    await second.disconnect();
  } finally {
    if (active && active.exitCode === null) active.kill();
    if (active) await active.exited;
    await world.close();
  }
});

test("CodeSandbox setup executes real steps in order and reconnects after client disconnect", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        setupTasks: [
          { name: "prepare", command: "sleep 0.15; printf prepared > marker; printf first" },
          { name: "build", command: "cat marker; printf second" },
        ],
      }),
    );
    const first = new SandboxClient(world.native, {});
    await first.initialize();
    const waiting = first.setup.waitUntilComplete();
    await first.disconnect();
    await expect(waiting).rejects.toThrow("disconnected");
    const second = new SandboxClient(world.native, {});
    await second.initialize();
    await second.setup.waitUntilComplete();
    const steps = second.setup.getSteps();
    expect(steps.map((s) => [s.name, s.status])).toEqual([
      ["prepare", "SUCCEEDED"],
      ["build", "SUCCEEDED"],
    ]);
    expect(await steps[0]!.open()).toBe("first");
    expect(await steps[1]!.open()).toBe("preparedsecond");
    expect(second.setup.status).toBe("FINISHED");
    await steps[0]!.waitUntilComplete();
    await second.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox setup failure prevents subsequent steps and reports Step Failed and Setup Failed", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ setupTasks: ["printf failure; exit 7", "touch forbidden"] }),
    );
    const client = new SandboxClient(world.native, {});
    await client.initialize();
    await expect(client.setup.waitUntilComplete()).rejects.toThrow("Setup Failed");
    const [step] = client.setup.getSteps();
    await expect(step!.waitUntilComplete()).rejects.toThrow("Step Failed");
    expect(await world.native.files.exists("/project/sandbox/forbidden")).toBe(false);
    await client.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox reconnect renews setup subscriptions without rerunning the guest sequence", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ setupTasks: ["sleep 0.2; printf completed"] }),
    );
    const client = new SandboxClient(world.native, {});
    await client.initialize();
    const waiting = client.setup.waitUntilComplete();
    await client.disconnect();
    await expect(waiting).rejects.toThrow("disconnected");
    await client.reconnect();
    await client.setup.waitUntilComplete();
    expect(await client.setup.getSteps()[0]!.open()).toBe("completed");
    expect(world.children).toHaveLength(1);
    await client.disconnect();
    expect(world.subscriptions()).toBe(0);
  } finally {
    await world.close();
  }
});

test("CodeSandbox setup steps expose a real resizable terminal and future step open waits for launch", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({
        setupTasks: [
          { name: "hold", command: "sleep 0.2" },
          {
            name: "terminal",
            // Reads its size only after the test has resized it, however slow the machine.
            command:
              "test -t 0 && test -t 1; printf tty; while [ ! -e resized ]; do sleep 0.02; done; stty size",
          },
        ],
      }),
    );
    const client = new SandboxClient(world.native, {});
    await client.initialize();
    const step = client.setup.getSteps()[1]!;
    await step.open({ cols: 90, rows: 35 });
    await world.native.files.write("/project/sandbox/resized", "");
    await step.waitUntilComplete();
    expect(await step.open()).toBe("tty35 90\r\n");
    await client.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox setup boot failure is observable when its private directory refuses writes", async () => {
  const world = await localSandbox();
  const setup = "/workspace/.runtime-compat/codesandbox/setup";
  try {
    const tasks = { dev: { name: "dev", command: "exec sleep 30" } };
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks }),
    );
    const first = new SandboxClient(world.native, {});
    await first.tasks.getAll();
    await first.disconnect();
    const steps = [{ name: "install", command: "printf ready" }];
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks, setupTasks: steps }),
    );
    const configPath = "/workspace/.runtime-compat/codesandbox/service/config.json";
    const config = JSON.parse(await world.native.files.readText(configPath)) as Record<
      string,
      unknown
    >;
    config.setup = { steps, config: JSON.stringify(steps) };
    await world.native.files.write(configPath, JSON.stringify(config));
    await mkdir(world.path(setup), { recursive: true });
    await chmod(world.path(setup), 0o500);
    await world.restartService();
    const second = new SandboxClient(world.native, {});
    await second.initialize();
    await expect(second.setup.waitUntilComplete()).rejects.toThrow("Permission denied");
    expect(second.setup.status).toBe("STOPPED");
    await second.disconnect();
  } finally {
    await chmod(world.path(setup), 0o700);
    await world.close();
  }
});

test("CodeSandbox setup reports a failed boot runner instead of waiting on stale progress", async () => {
  const world = await localSandbox();
  try {
    const tasks = { dev: { name: "dev", command: "exec sleep 30" } };
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks }),
    );
    const first = new SandboxClient(world.native, {});
    await first.tasks.getAll();
    await first.disconnect();
    const steps = [{ name: "install", command: "printf ready" }];
    const identity = JSON.stringify(steps);
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ tasks, setupTasks: steps }),
    );
    const root = "/workspace/.runtime-compat/codesandbox/service";
    const config = JSON.parse(await world.native.files.readText(`${root}/config.json`)) as Record<
      string,
      unknown
    >;
    config.setup = { steps, config: identity };
    await world.native.files.write(`${root}/config.json`, JSON.stringify(config));
    await world.native.files.write(`${root}/setup.py`, "raise SystemExit(17)\n");
    await world.native.files.write(
      "/workspace/.runtime-compat/codesandbox/setup/progress.json",
      JSON.stringify({
        state: "IN_PROGRESS",
        config: identity,
        runId: "stale",
        currentStepIndex: 0,
        steps: steps.map((step) => ({ ...step, status: "IDLE" })),
      }),
    );
    await world.restartService();
    const control = new ManagedTasks(world.native);
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        if ((await control.boot())?.state === "failed") break;
      } catch {
        /* Wait for the new socket. */
      }
      if (Date.now() >= deadline) throw new Error("Boot failure was not published");
      await Bun.sleep(10);
    }
    const second = new SandboxClient(world.native, {});
    await second.initialize();
    await expect(second.setup.waitUntilComplete()).rejects.toThrow("Setup exited with code 17");
    expect(second.setup.status).toBe("STOPPED");
    await second.disconnect();
  } finally {
    await world.close();
  }
});

test("CodeSandbox setup step open with dimensions tolerates a terminal that has already closed", async () => {
  const world = await localSandbox();
  try {
    await world.native.files.write(
      "/project/sandbox/.codesandbox/tasks.json",
      JSON.stringify({ setupTasks: [{ name: "quick", command: "printf done" }] }),
    );
    const client = new SandboxClient(world.native, {});
    await client.initialize();
    await client.setup.waitUntilComplete();
    // A client whose cached progress still shows the step running on a
    // terminal the guest has since closed.
    const cached = (
      client.setup as unknown as { progress: { steps: { status: string; tty?: string }[] } }
    ).progress.steps[0]!;
    cached.status = "IDLE";
    cached.tty = "/dev/runtime-closed-terminal";
    await client.setup.open(0, { cols: 90, rows: 35 });
    await client.disconnect();
  } finally {
    await world.close();
  }
});
