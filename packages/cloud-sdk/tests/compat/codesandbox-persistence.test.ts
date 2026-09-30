import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { SandboxClient } from "../../src/codesandbox/index.js";
import { localSandbox } from "./codesandbox-local.js";

test("fresh CodeSandbox client restarts privately captured command settings and detaches subscriptions", async () => {
  const world = await localSandbox();
  try {
    const first = new SandboxClient(world.native, { TOKEN: "private-session-secret" });
    const options = { cwd: world.directory, name: "server", env: { TOKEN: "captured-secret" } };
    await first.commands.runBackground("exec sleep 30", options);
    options.env.TOKEN = "changed";
    await world.native.spawn("exec sleep 30", { cwd: world.directory }); // Foreign process excluded.
    await first.disconnect();
    await Promise.resolve();
    expect(world.subscriptions()).toBe(0);
    const second = new SandboxClient(world.native, { TOKEN: "different-client" });
    const [command] = await second.commands.getAll();
    expect(command?.name).toBe("server");
    expect(command?.command).toBe("exec sleep 30");
    expect(await second.commands.getAll()).toHaveLength(1);
    await command!.restart();
    expect(world.invocations[2]).toEqual(world.invocations[0]);
    expect(await world.children[0]!.exited).toBeGreaterThan(0);
    const running = (await world.native.processes.list()).filter((p) => p.state === "running");
    const own = running[1]!;
    expect(
      (await stat(world.path(`/workspace/.runtime-compat/codesandbox/commands/${own.id}.json`)))
        .mode & 0o777,
    ).toBe(0o600);
    expect(JSON.stringify(own)).not.toContain("captured-secret");
    await command!.kill();
    await second.disconnect();
    await Promise.resolve();
    expect(world.subscriptions()).toBe(0);
  } finally {
    await world.close();
  }
});

test("CodeSandbox string arrays run sequential shell commands and failures short circuit", async () => {
  const world = await localSandbox();
  try {
    const client = new SandboxClient(world.native, {});
    expect(
      await client.commands.run(["printf first", "printf second"], { cwd: world.directory }),
    ).toBe("firstsecond");
    await expect(
      client.commands.run(["printf before; exit 7", "printf forbidden"], { cwd: world.directory }),
    ).rejects.toMatchObject({ exitCode: 7, output: "before" });
  } finally {
    await world.close();
  }
});

test("CodeSandbox failed private manifest write terminates the newly started command", async () => {
  const world = await localSandbox();
  try {
    world.failWrites(new Error("private disk unavailable"));
    const client = new SandboxClient(world.native, {});
    await expect(
      client.commands.runBackground("exec sleep 30", { cwd: world.directory }),
    ).rejects.toThrow("private disk unavailable");
    expect(world.children).toHaveLength(1);
    expect(await world.children[0]!.exited).toBeGreaterThan(0);
    expect(world.subscriptions()).toBe(0);
  } finally {
    await world.close();
  }
});
