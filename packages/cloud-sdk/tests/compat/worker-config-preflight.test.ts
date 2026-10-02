import { expect, mock, test } from "bun:test";
import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";
import type { Runtime } from "../../src/client.js";
import { Sandbox as Facade, validateSandboxConfiguration } from "../../src/cloudflare/index.js";

// The real Worker class is imported with only its platform base replaced.
// This proves method ordering; actual Durable Object behavior needs workerd.
void mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));
const { Sandbox: Worker } = await import("../../src/cloudflare/worker.js");

const CONFIGURATION_KEY = "runtime.configuration";
const INTENT_KEY = "runtime.configuration.pending";
const NATIVE_ID = "11111111-2222-4333-8444-555555555555";
const INITIAL = {
  sandboxName: { name: "valid" },
  nativeSandboxId: `cf-do-${"a".repeat(64)}`,
  sleepAfter: 600,
  keepAlive: false,
};

function workerFixture(
  initial?: unknown,
  hooks: {
    put?: (key: string, value: unknown) => Promise<void>;
    delete?: (key: string) => Promise<void>;
  } = {},
) {
  const writes: unknown[] = [];
  const records = new Map<string, unknown>();
  if (initial !== undefined) records.set(CONFIGURATION_KEY, initial);
  const ctx = {
    id: { toString: () => "a".repeat(64) },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback(),
    storage: {
      async get(key: string) {
        return records.get(key);
      },
      async put(key: string, value: unknown) {
        writes.push(value);
        await hooks.put?.(key, value);
        records.set(key, value);
      },
      async delete(key: string) {
        await hooks.delete?.(key);
        return records.delete(key);
      },
    },
  } as unknown as DurableObjectState;
  const restart = () => new Worker(ctx, { RUNTIME_API_KEY: "rtcloud_fixture" });
  const worker = restart();
  return {
    writes,
    records,
    worker,
    restart,
    memory: () => (worker as unknown as { configuration: unknown }).configuration,
  };
}

async function nativeFixture() {
  const updates: { idlePauseSeconds: number; persistent?: boolean }[] = [];
  const reads: string[] = [];
  let creates = 0;
  const control: {
    update?: (options: { idlePauseSeconds: number; persistent?: boolean }) => Promise<void>;
    read?: () => Promise<void>;
  } = {};
  const native = {
    id: NATIVE_ID,
    info: { reused: true, idlePauseSeconds: 600, persistent: false as boolean | undefined },
    async update(options: { idlePauseSeconds: number; persistent?: boolean }) {
      updates.push(options);
      await control.update?.(options);
      Object.assign(native.info, options);
    },
  };
  const runtime = {
    sandboxes: {
      async create() {
        creates++;
        return native;
      },
      async get(id: string) {
        reads.push(id);
        await control.read?.();
        return native;
      },
    },
  } as unknown as Runtime;
  const makeFacade = () => new Facade(runtime, "existing", { sleepAfter: 600, keepAlive: false });
  const facade = makeFacade();
  await facade.native();
  return { facade, makeFacade, native, control, updates, reads, creates: () => creates };
}

test("Worker configuration refuses invalid sleep values before writing durable state", async () => {
  for (const sleepAfter of [NaN, Infinity, -1, 0.5, 86_401, "bad", "25h"]) {
    const f = workerFixture();
    await expect(f.worker.configure({ sleepAfter })).rejects.toBeDefined();
    expect(f.writes).toEqual([]);
    await f.worker.configure({ sandboxName: { name: "valid" }, sleepAfter: "5m" });
    expect(f.writes).toHaveLength(1);
  }
});

test("Worker configuration refuses malformed keepAlive and display names before storage", async () => {
  const f = workerFixture();
  await expect(
    f.worker.configure({ keepAlive: "yes" as unknown as boolean }),
  ).rejects.toBeInstanceOf(TypeError);
  await expect(f.worker.configure({ sandboxName: { name: "" } })).rejects.toBeDefined();
  expect(f.writes).toEqual([]);
});

test("Cloudflare sleep configuration preserves defaults, zero and supported duration boundaries", () => {
  for (const sleepAfter of [undefined, 0, 1, 86_400, "0s", "5m", "24h"])
    expect(() => validateSandboxConfiguration({ sleepAfter })).not.toThrow();
});

test("failed native configuration does not overwrite the facade's old sleep setting", async () => {
  const changes: unknown[] = [];
  let fail = true;
  const native = {
    info: { reused: true },
    async update(options: unknown) {
      changes.push(options);
      if (fail) throw new Error("controlled update failure");
    },
  };
  const runtime = {
    sandboxes: {
      async create() {
        return native;
      },
    },
  } as unknown as Runtime;
  const facade = new Facade(runtime, "one", { sleepAfter: 600 });
  await facade.native();
  await expect(facade.configure({ sleepAfter: "20m", keepAlive: true })).rejects.toThrow(
    "controlled update failure",
  );
  fail = false;
  await facade.configure({ keepAlive: false });
  expect(changes).toEqual([
    { idlePauseSeconds: 0, persistent: true },
    { idlePauseSeconds: 600, persistent: false },
  ]);
});

test("Worker rejection restores desired state and retains explicit native uncertainty", async () => {
  const f = workerFixture({ ...INITIAL });
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.facade });
  const original = new Error("controlled native refusal");
  n.control.update = async () => {
    throw original;
  };
  await expect(f.worker.configure({ sleepAfter: "20m", keepAlive: true })).rejects.toBe(original);
  expect(original).toMatchObject({ configurationUncertain: true });
  expect(f.records.get(CONFIGURATION_KEY)).toEqual(INITIAL);
  expect(f.memory()).toEqual(INITIAL);
  expect(f.records.get(INTENT_KEY)).toMatchObject({ sandboxId: NATIVE_ID });
  await expect(f.worker.exec("anything")).rejects.toMatchObject({ configurationUncertain: true });
  expect(n.updates).toHaveLength(1);
  n.control.update = undefined;
  await f.worker.configure({ keepAlive: false });
  expect(n.reads).toEqual([NATIVE_ID]);
  expect(f.records.get(CONFIGURATION_KEY)).toMatchObject({ sleepAfter: 600, keepAlive: false });
  expect(f.records.has(INTENT_KEY)).toBe(false);
  expect(n.creates()).toBe(1);
});

test("Worker rollback deletes a configuration record that did not previously exist", async () => {
  const f = workerFixture();
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.facade });
  const original = new Error("controlled native refusal");
  n.control.update = async () => {
    throw original;
  };
  await expect(f.worker.configure({ sleepAfter: "20m" })).rejects.toBe(original);
  expect(f.records.has(CONFIGURATION_KEY)).toBe(false);
  expect(f.memory()).toEqual({});
  expect(f.records.get(INTENT_KEY)).toMatchObject({ sandboxId: NATIVE_ID });
});

test("Worker preserves the primary native failure when durable rollback also fails", async () => {
  const original = new Error("native failure"),
    cleanup = new Error("rollback failure");
  const f = workerFixture(
    { ...INITIAL },
    {
      async put(key, value) {
        if (key === CONFIGURATION_KEY && (value as typeof INITIAL).sleepAfter === 600)
          throw cleanup;
      },
    },
  );
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.facade });
  n.control.update = async () => {
    throw original;
  };
  await expect(f.worker.configure({ sleepAfter: "20m" })).rejects.toBe(original);
  expect(original).toMatchObject({ cause: cleanup, configurationUncertain: true });
  expect(f.memory()).toEqual(INITIAL);
  expect(f.records.get(INTENT_KEY)).toMatchObject({ sandboxId: NATIVE_ID });
});

test("Worker preserves an existing native cause when durable rollback also fails", async () => {
  const cause = new Error("native cause sentinel"),
    original = new Error("native failure", { cause }),
    cleanup = new Error("rollback failure");
  const f = workerFixture(
    { ...INITIAL },
    {
      async put(key, value) {
        if (key === CONFIGURATION_KEY && (value as typeof INITIAL).sleepAfter === 600)
          throw cleanup;
      },
    },
  );
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.facade });
  n.control.update = async () => {
    throw original;
  };
  await expect(f.worker.configure({ sleepAfter: "20m" })).rejects.toBe(original);
  expect(original.cause).toBe(cause);
  expect(original).toMatchObject({ cleanupError: cleanup, configurationUncertain: true });
  expect(f.memory()).toEqual(INITIAL);
  expect(f.records.get(INTENT_KEY)).toMatchObject({ sandboxId: NATIVE_ID });
});

test("Worker storage failure precedes native effects and leaves the old configuration", async () => {
  const original = new Error("desired-state write failed");
  const f = workerFixture(
    { ...INITIAL },
    {
      async put(key, value) {
        if (
          key === CONFIGURATION_KEY &&
          (value as { sleepAfter?: string | number }).sleepAfter === "20m"
        )
          throw original;
      },
    },
  );
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.facade });
  await expect(f.worker.configure({ sleepAfter: "20m" })).rejects.toBe(original);
  expect(n.updates).toEqual([]);
  expect(f.records.get(CONFIGURATION_KEY)).toEqual(INITIAL);
  expect(f.memory()).toEqual(INITIAL);
  expect(f.records.has(INTENT_KEY)).toBe(false);
});

test("failed intent staging clears uncertainty without requiring a native UUID", async () => {
  const original = new Error("intent staging failed");
  let rejectStage = true;
  const f = workerFixture(
    { ...INITIAL },
    {
      async put(key) {
        if (key === INTENT_KEY && rejectStage) {
          rejectStage = false;
          throw original;
        }
      },
    },
  );
  const n = await nativeFixture();
  const facade = n.makeFacade();
  expect(facade.existingNativeId()).toBeUndefined();
  Object.assign(facade, { listProcesses: async () => [] });
  Object.assign(f.worker, { facade });
  await expect(f.worker.configure({ sleepAfter: "20m" })).rejects.toBe(original);
  expect(
    (original as Error & { configurationUncertain?: boolean }).configurationUncertain,
  ).toBeUndefined();
  expect(f.records.has(INTENT_KEY)).toBe(false);
  expect(f.records.get(CONFIGURATION_KEY)).toEqual(INITIAL);
  expect(f.memory()).toEqual(INITIAL);
  expect(n.updates).toEqual([]);
  expect(await f.worker.listProcesses()).toEqual([]);
  await f.worker.configure({ sleepAfter: "20m" });
  expect(f.records.get(CONFIGURATION_KEY)).toMatchObject({ sleepAfter: "20m" });
  expect(n.reads).toEqual([]);
  expect(n.creates()).toBe(1);
});

test("failed intent-stage cleanup preserves its primary failure and explicit uncertainty", async () => {
  const original = new Error("intent staging failed"),
    cleanup = new Error("intent cleanup failed");
  const f = workerFixture(
    { ...INITIAL },
    {
      async put(key) {
        if (key === INTENT_KEY) throw original;
      },
      async delete(key) {
        if (key === INTENT_KEY) throw cleanup;
      },
    },
  );
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.makeFacade() });
  await expect(f.worker.configure({ sleepAfter: "20m" })).rejects.toBe(original);
  expect(original).toMatchObject({ cause: cleanup, configurationUncertain: true });
  expect(f.memory()).toEqual(INITIAL);
  expect(f.records.get(CONFIGURATION_KEY)).toEqual(INITIAL);
  expect(n.updates).toEqual([]);
  await expect(f.worker.exec("anything")).rejects.toMatchObject({ configurationUncertain: true });
  expect(n.reads).toEqual([]);
  expect(n.creates()).toBe(1);
});

test("ordinary Worker calls wait for a successful configuration instead of rejecting transient intent", async () => {
  const f = workerFixture({ ...INITIAL });
  const n = await nativeFixture();
  const calls: string[] = [];
  const answer = { success: true, stdout: "ok", stderr: "", exitCode: 0 };
  Object.assign(n.facade, {
    async exec() {
      calls.push("exec");
      return answer;
    },
    async listProcesses() {
      calls.push("list");
      return [];
    },
  });
  Object.assign(f.worker, { facade: n.facade });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  n.control.update = async () => {
    entered();
    await gate;
  };
  const configuration = f.worker.configure({ sleepAfter: "20m" });
  await started;
  let settled = 0;
  const exec = f.worker.exec("echo ok").then(
    (value) => {
      settled++;
      return { value };
    },
    (error: unknown) => {
      settled++;
      return { error };
    },
  );
  const list = f.worker.listProcesses().then(
    (value) => {
      settled++;
      return { value };
    },
    (error: unknown) => {
      settled++;
      return { error };
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual([]);
  expect(settled).toBe(0);
  release();
  await configuration;
  expect<unknown>(await exec).toEqual({ value: answer });
  expect(await list).toEqual({ value: [] });
  expect(calls.sort()).toEqual(["exec", "list"]);
  expect(f.records.has(INTENT_KEY)).toBe(false);
  expect(n.updates).toEqual([{ idlePauseSeconds: 1200 }]);
});

for (const operation of ["exec", "execStream"] as const) {
  test(`Worker ${operation} observes caller cancellation while waiting for configuration`, async () => {
    const f = workerFixture({ ...INITIAL });
    const n = await nativeFixture();
    const calls: string[] = [];
    Object.assign(n.facade, {
      async exec() {
        calls.push("exec");
      },
      async execStream() {
        calls.push("execStream");
      },
    });
    Object.assign(f.worker, { facade: n.facade });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    n.control.update = async () => {
      entered();
      await gate;
    };
    const configuration = f.worker.configure({ sleepAfter: "20m" });
    await started;
    const controller = new AbortController();
    const original = new Error("caller stopped waiting");
    const outcome = f.worker[operation]("anything", {
      signal: controller.signal,
      timeout: 50,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await Promise.resolve();
    controller.abort(original);
    try {
      expect(await outcome).toEqual({ error: original });
      expect(calls).toEqual([]);
    } finally {
      release();
      await configuration;
    }
    expect(calls).toEqual([]);
    expect(f.records.has(INTENT_KEY)).toBe(false);
  });
}

test("concurrent Worker configuration waits for rollback and reconciliation", async () => {
  const f = workerFixture({ ...INITIAL });
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.facade });
  const original = new Error("first update failed");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  n.control.update = async () => {
    if (n.updates.length === 1) {
      entered();
      await gate;
      throw original;
    }
  };
  // Settled later, after the gate opens: bun's `expect(pending).rejects` runs
  // the event loop until the promise settles, so the gate would never open.
  const first = f.worker.configure({ sleepAfter: "20m" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await started;
  const second = f.worker.configure({ keepAlive: true });
  await Promise.resolve();
  expect(n.updates).toHaveLength(1);
  release();
  expect(await first).toBe(original);
  await second;
  expect(n.reads).toEqual([NATIVE_ID]);
  expect(n.updates).toEqual([
    { idlePauseSeconds: 1200 },
    { idlePauseSeconds: 0, persistent: true },
  ]);
  expect(f.records.get(CONFIGURATION_KEY)).toMatchObject({ sleepAfter: 600, keepAlive: true });
  expect(f.records.has(INTENT_KEY)).toBe(false);
});

test("restarted Worker reconciles a lost native acknowledgement by recorded UUID without allocating", async () => {
  const f = workerFixture({ ...INITIAL });
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.facade });
  const original = new Error("acknowledgement lost after applying");
  n.control.update = async (options) => {
    Object.assign(n.native.info, options);
    throw original;
  };
  await expect(f.worker.configure({ sleepAfter: "20m" })).rejects.toBe(original);
  expect(f.records.get(CONFIGURATION_KEY)).toEqual(INITIAL);
  expect(n.native.info.idlePauseSeconds).toBe(1200);
  const restarted = f.restart();
  Object.assign(restarted, { facade: n.makeFacade() });
  await restarted.configure({});
  expect(n.reads).toEqual([NATIVE_ID]);
  expect(n.creates()).toBe(1);
  expect(n.updates).toHaveLength(1);
  expect(f.records.get(CONFIGURATION_KEY)).toMatchObject({ sleepAfter: 1200, keepAlive: false });
  expect(f.records.has(INTENT_KEY)).toBe(false);
});

test("missing authoritative fields or failed reads preserve uncertain intent", async () => {
  for (const missingFields of [false, true]) {
    const f = workerFixture({ ...INITIAL });
    const n = await nativeFixture();
    Object.assign(f.worker, { facade: n.facade });
    n.control.update = async () => {
      throw new Error("uncertain native update");
    };
    await expect(f.worker.configure({ sleepAfter: "20m" })).rejects.toBeDefined();
    const intent = f.records.get(INTENT_KEY);
    if (missingFields) n.native.info.persistent = undefined;
    else
      n.control.read = async () => {
        throw new Error("authoritative read failed");
      };
    await expect(f.worker.configure({})).rejects.toMatchObject({ configurationUncertain: true });
    expect(f.records.get(INTENT_KEY)).toEqual(intent);
    expect(f.memory()).toEqual(INITIAL);
    expect(n.updates).toHaveLength(1);
    expect(n.creates()).toBe(1);
  }
});

test("reconciliation without an existing native identity fails without allocation or a read", async () => {
  const n = await nativeFixture();
  await expect(n.makeFacade().reconcileConfiguration()).rejects.toThrow(
    "no existing sandbox identity",
  );
  expect(n.reads).toEqual([]);
  expect(n.creates()).toBe(1);
});

test("explicitly undefined Worker options keep the existing configuration", async () => {
  const f = workerFixture({ ...INITIAL });
  const n = await nativeFixture();
  Object.assign(f.worker, { facade: n.facade });
  await f.worker.configure({ sleepAfter: undefined, keepAlive: undefined, sandboxName: undefined });
  expect(f.records.get(CONFIGURATION_KEY)).toEqual(INITIAL);
  expect(f.memory()).toEqual(INITIAL);
  expect(n.updates).toEqual([]);
  expect(f.records.has(INTENT_KEY)).toBe(false);
});
