import { beforeEach, describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/index";
import {
  CodeInterpreter,
  MAX_CREATION_TIMEOUT_SECONDS,
  NotSupportedError,
  SandboxCreationTimeoutError,
  SandboxFileSystem,
  SandboxInstance,
  isCreationTimeoutError,
} from "../../src/blaxel/index";
import { BlaxelWorld, requests } from "./fake";
import type { FakeSandbox } from "../e2b/fake";

/* @blaxel/core 0.3.25's creation deadline: SandboxInstance.create(config,
   { timeout }) gives up after `timeout` whole seconds, releases the sandbox
   and rejects with SandboxCreationTimeoutError. Before, withruntime/blaxel
   dropped `timeout` and `safe` without a word, and code that imported the
   error class got undefined, so `e instanceof SandboxCreationTimeoutError`
   threw a TypeError. */

let world: BlaxelWorld;
beforeEach(() => {
  world = new BlaxelWorld();
});
const lastCreate = () => world.called("sandboxes.create").at(-1)!;

/** A client whose new sandboxes stay starting: the server's wait for running
 * answers with the sandbox still starting, as it does at its deadline. */
function slow(): Runtime {
  const client = world.client();
  const sandboxes = client.sandboxes as unknown as Record<string, unknown>;
  const create = (sandboxes.create as (...args: unknown[]) => Promise<FakeSandbox>).bind(sandboxes);
  sandboxes.create = async (...args: unknown[]) => {
    const made = await create(...args);
    made.info.state = "starting";
    (made as unknown as Record<string, unknown>).waitFor = async (
      state: string,
      options: unknown,
    ) => {
      world.record("sandbox.waitFor", made.id, state, options);
      return made;
    };
    return made;
  };
  return client;
}

describe("SandboxInstance.create's timeout", () => {
  test("Blaxel's check and words: a whole number of seconds from 1 to 50, before any request", async () => {
    expect(MAX_CREATION_TIMEOUT_SECONDS).toBe(50);
    for (const timeout of [0, 51, 1.5, -1, Number.NaN]) {
      const error = (await SandboxInstance.create(
        { withruntime: { client: world.client() } },
        { timeout },
      ).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        `SandboxInstance.create: 'timeout' must be a whole number of seconds between 1 and 50, got ${timeout}.`,
      );
    }
    expect(requests(world, 0)).toEqual([]);
  });

  test("ready in time: one create that does not wait, then a wait bounded by what is left", async () => {
    const sandbox = await SandboxInstance.create(
      { name: "quick", withruntime: { client: slowOnce() } },
      { timeout: 10 },
    );
    expect(sandbox.metadata.name).toBe("quick");
    const [input, options] = lastCreate();
    expect(input).toMatchObject({ name: "quick", wait: false });
    expect(options).toEqual({ waitForCapacityMs: 10_000 });
    const wait = world.called("sandbox.waitFor").at(-1)!;
    expect(wait[1]).toBe("running");
    const bound = wait[2] as { timeoutSeconds: number; timeoutMs: number };
    expect(bound.timeoutSeconds).toBeGreaterThanOrEqual(1);
    expect(bound.timeoutSeconds).toBeLessThanOrEqual(10);
    expect(bound.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  test("not ready in time: the sandbox is deleted, the name is free, and the error is Blaxel's", async () => {
    const error = (await SandboxInstance.create(
      { name: "late", withruntime: { client: slow() } },
      { timeout: 1 },
    ).catch((e: unknown) => e)) as SandboxCreationTimeoutError;
    expect(error).toBeInstanceOf(SandboxCreationTimeoutError);
    expect(isCreationTimeoutError(error)).toBe(true);
    expect(isCreationTimeoutError(new Error("x"))).toBe(false);
    expect([error.name, error.code, error.status, error.sandboxName, error.timeout]).toEqual([
      "SandboxCreationTimeoutError",
      "CREATION_TIMEOUT",
      408,
      "late",
      1,
    ]);
    expect(error.message).toBe(
      "Sandbox late was not ready within 1s; the creation was cancelled. It was still starting after 1s.",
    );
    expect(world.called("sandbox.delete")).toHaveLength(1);
    // Started over, as Blaxel's error says it can be: the name is free.
    const again = await SandboxInstance.create({
      name: "late",
      withruntime: { client: world.client() },
    });
    expect(again.metadata.name).toBe("late");
  });

  test("a sandbox that stopped while starting is deleted and reported as a failed start, not a timeout", async () => {
    const client = slow();
    const sandboxes = client.sandboxes as unknown as Record<string, unknown>;
    const create = sandboxes.create as (...args: unknown[]) => Promise<FakeSandbox>;
    sandboxes.create = async (...args: unknown[]) => {
      const made = await create(...args);
      made.info.state = "stopped";
      return made;
    };
    const error = (await SandboxInstance.create(
      { name: "broken", withruntime: { client } },
      { timeout: 5 },
    ).catch((e: unknown) => e)) as Error;
    expect(error).not.toBeInstanceOf(SandboxCreationTimeoutError);
    expect(error.message).toContain("not running");
    expect(world.called("sandbox.delete")).toHaveLength(1);
  });

  test("createIfNotExists and CodeInterpreter.create pass timeout on", async () => {
    for (const make of [
      () =>
        SandboxInstance.createIfNotExists(
          { name: "n", withruntime: { client: slow() } },
          { timeout: 1 },
        ),
      () => CodeInterpreter.create({ name: "c", withruntime: { client: slow() } }, { timeout: 1 }),
    ])
      expect(await make().catch((e: unknown) => e)).toBeInstanceOf(SandboxCreationTimeoutError);
    expect(
      await SandboxInstance.createIfNotExists(
        { name: "n", withruntime: { client: world.client() } },
        { timeout: 99 },
      ).catch((e: unknown) => (e as Error).message),
    ).toContain("between 1 and 50, got 99");
  });

  test("createIfNotExists with a timeout never deletes the sandbox the name already had", async () => {
    const client = world.client();
    await SandboxInstance.create({ name: "kept", withruntime: { client } });
    const sandboxes = client.sandboxes as unknown as Record<string, unknown>;
    const create = (sandboxes.create as (...args: unknown[]) => Promise<FakeSandbox>).bind(
      sandboxes,
    );
    sandboxes.create = async (...args: unknown[]) => {
      const made = await create(...args);
      made.info.state = "paused";
      (made as unknown as Record<string, unknown>).waitFor = async () => made;
      return made;
    };
    const again = await SandboxInstance.createIfNotExists(
      { name: "kept", withruntime: { client } },
      { timeout: 1 },
    );
    expect(again.metadata.name).toBe("kept");
    expect(world.called("sandbox.delete")).toEqual([]);
  });

  test("without timeout nothing changes: the create waits for running itself", async () => {
    await SandboxInstance.create({ withruntime: { client: world.client() } });
    expect(lastCreate()[0]).not.toHaveProperty("wait");
  });
});

describe("SandboxInstance.create's safe", () => {
  test("lists / once it runs; a failure ends the sandbox and throws", async () => {
    const ls = Object.getOwnPropertyDescriptor(SandboxFileSystem.prototype, "ls")!;
    const listed: string[] = [];
    let fail = false;
    SandboxFileSystem.prototype.ls = async function (path: string) {
      listed.push(path);
      if (fail) throw new Error("guest unreachable");
      return { path, name: path, files: [], subdirectories: [] };
    };
    try {
      await SandboxInstance.create({ withruntime: { client: world.client() } });
      expect(listed).toEqual([]);
      await SandboxInstance.create({ withruntime: { client: world.client() } }, { safe: true });
      expect(listed).toEqual(["/"]);
      fail = true;
      const stops = world.called("sandbox.stop").length;
      expect(
        await SandboxInstance.create(
          { withruntime: { client: world.client() } },
          { safe: true },
        ).catch((e: unknown) => (e as Error).message),
      ).toBe("guest unreachable");
      expect(world.called("sandbox.stop").length).toBe(stops + 1);
    } finally {
      Object.defineProperty(SandboxFileSystem.prototype, "ls", ls);
    }
  });
});

describe("fork's application routing", () => {
  test("port, traffic, customDomain and prefix are refused before any request", async () => {
    const sandbox = await SandboxInstance.create({ withruntime: { client: world.client() } });
    const before = world.calls.length;
    for (const options of [
      { port: 3000 },
      { traffic: 50 },
      { customDomain: "app.example.com" },
      { prefix: "/app" },
    ]) {
      const error = (await sandbox.fork("copy", options).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as NotSupportedError).alternative).toContain("sandbox.previews.create");
    }
    expect(requests(world, before)).toEqual([]);
  });
});

/** The ordinary fake, recording the bounded wait the timeout path makes. */
function slowOnce(): Runtime {
  const client = world.client();
  const sandboxes = client.sandboxes as unknown as Record<string, unknown>;
  const create = (sandboxes.create as (...args: unknown[]) => Promise<FakeSandbox>).bind(sandboxes);
  sandboxes.create = async (...args: unknown[]) => {
    const made = await create(...args);
    made.info.state = "starting";
    (made as unknown as Record<string, unknown>).waitFor = async (
      state: string,
      options: unknown,
    ) => {
      world.record("sandbox.waitFor", made.id, state, options);
      made.info.state = state;
      return made;
    };
    return made;
  };
  return client;
}
