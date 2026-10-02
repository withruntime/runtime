import { expect, test } from "bun:test";
import { SandboxProcess, resetProcesses, type ProcessContext } from "../../src/blaxel/process.js";

function lookup() {
  resetProcesses();
  let release!: (value: Awaited<ReturnType<ProcessContext["live"]>>) => void;
  let lookups = 0;
  const pending = new Promise<Awaited<ReturnType<ProcessContext["live"]>>>((resolve) => {
    release = resolve;
  });
  const process = new SandboxProcess({
    id: "isolated-wait-deadline",
    live: () => pending,
    wake: async () => {
      throw new Error("Must not wake after cancellation");
    },
    keepAwake: async () => {},
    keepAliveEnded: async () => {},
  });
  return {
    process,
    release: () =>
      release({
        processes: {
          list: async () => {
            lookups++;
            return [];
          },
        },
      } as unknown as Awaited<ReturnType<ProcessContext["live"]>>),
    lookups: () => lookups,
  };
}

test("wait deadline covers a pending sandbox lookup and prevents late process reads", async () => {
  const f = lookup();
  try {
    await expect(f.process.wait("command", { maxWait: 10 })).rejects.toThrow(
      "Process did not finish in time",
    );
  } finally {
    f.release();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.lookups()).toBe(0);
});

test("caller cancellation covers a pending sandbox lookup and retains its reason", async () => {
  const f = lookup();
  const controller = new AbortController();
  const reason = new Error("Caller stopped waiting");
  const waiting = f.process.wait("command", { maxWait: -1, signal: controller.signal });
  controller.abort(reason);
  try {
    await expect(waiting).rejects.toBe(reason);
  } finally {
    f.release();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.lookups()).toBe(0);
});

test("get cancellation interrupts lookup and prevents a late process list", async () => {
  const f = lookup();
  const controller = new AbortController();
  const reason = new Error("Caller stopped reading");
  const reading = f.process.get("command", { signal: controller.signal });
  controller.abort(reason);
  try {
    await expect(reading).rejects.toBe(reason);
  } finally {
    f.release();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.lookups()).toBe(0);
});
