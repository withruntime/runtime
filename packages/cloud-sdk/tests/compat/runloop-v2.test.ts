import { expect, test } from "bun:test";
import { Runloop, RunloopSDK } from "../../src/runloop/index.js";
import type { Runtime } from "../../src/client.js";
const BOX = "11111111-2222-4333-8444-555555555555";

function fixture() {
  const calls: unknown[] = [];
  const process = {
    write: async (text: string, options: unknown) => {
      calls.push(["write", text, options]);
    },
    kill: async (signal: string, options: unknown) => {
      calls.push(["kill", signal, options]);
    },
  };
  const runtime = {
    sandboxes: {
      get: async () => {
        calls.push("lookup");
        return { processes: { get: async () => process } };
      },
    },
  } as unknown as Runtime;
  return { client: new Runloop({ client: runtime }), runtime, calls, process };
}

test("Runloop 2 input requires exactly one nonempty text or signal before any lookup", async () => {
  const f = fixture();
  for (const body of [
    undefined,
    null,
    {},
    { text: "" },
    { text: 1 },
    { text: "input", signal: "EOF" },
    { signal: "TERM" },
    { signal: AbortSignal.abort() },
    { text: null, signal: null },
  ]) {
    await expect(
      f.client.devboxes.executions.sendStdIn(BOX, "exec", body as never),
    ).rejects.toThrow(/stdin/i);
    expect(f.calls).toEqual([]);
  }
});

test("Runloop 2 text, EOF and interrupt map separately; write failures never report success", async () => {
  const f = fixture(),
    options = { timeout: 50, signal: new AbortController().signal };
  expect(
    await f.client.devboxes.executions.sendStdIn(BOX, "exec", { text: "héllo\n" }, options),
  ).toEqual({ devbox_id: BOX, execution_id: "exec", success: true });
  await f.client.devboxes.executions.sendStdIn(BOX, "exec", { signal: "EOF" }, options);
  await f.client.devboxes.executions.sendStdIn(BOX, "exec", { signal: "INTERRUPT" }, options);
  expect(f.calls).toEqual([
    "lookup",
    ["write", "héllo\n", { eof: false, signal: options.signal, timeoutMs: 50 }],
    "lookup",
    ["write", "", { eof: true, signal: options.signal, timeoutMs: 50 }],
    "lookup",
    ["kill", "SIGINT", { signal: options.signal, timeoutMs: 50, idempotencyKey: undefined }],
  ]);
  const failure = new Error("stdin closed");
  f.process.write = async () => {
    throw failure;
  };
  await expect(f.client.devboxes.executions.sendStdIn(BOX, "exec", { text: "x" })).rejects.toBe(
    failure,
  );
});

test("Runloop 2 provider-only services name a Runtime alternative without requests", () => {
  const f = fixture();
  for (const name of [
    "secrets",
    "objects",
    "axons",
    "gatewayConfigs",
    "mcpConfigs",
    "networkPolicies",
  ]) {
    expect(() => (f.client as unknown as Record<string, unknown>)[name]).toThrow(
      /Runtime.*(API|files|events|egress)/,
    );
    expect(f.calls).toEqual([]);
  }
});

test("Runloop 2 high-level consumer sends input, closes it and reads the result", async () => {
  const f = fixture();
  const sdk = new RunloopSDK({ client: f.runtime });
  const starts: unknown[] = [];
  sdk.api.devboxes.executeAsync = async (id, body) => {
    starts.push([id, body]);
    return { devbox_id: id, execution_id: "exec", status: "running" };
  };
  sdk.api.devboxes.executions.awaitCompleted = async () => ({
    devbox_id: BOX,
    execution_id: "exec",
    status: "completed",
    exit_status: 0,
    stdout: "héllo\n",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
  });
  const execution = await sdk.devbox.fromId(BOX).cmd.execAsync("cat", { attach_stdin: true });
  expect(starts).toEqual([[BOX, { command: "cat", attach_stdin: true }]]);
  expect(execution.executionId).toBe("exec");
  expect(execution.devboxId).toBe(BOX);
  expect(await execution.sendStdIn("héllo\n")).toBeUndefined();
  expect(await execution.closeStdIn()).toBeUndefined();
  const result = await execution.result();
  expect(result.success).toBe(true);
  expect(result.failed).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(await result.stdout()).toBe("héllo\n");
  expect(await result.stdout(1)).toBe("héllo");
  expect(await result.stderr()).toBe("");
  sdk.api.devboxes.executions.sendStdIn = async () => ({
    devbox_id: BOX,
    execution_id: "exec",
    success: false,
  });
  await expect(execution.sendStdIn("refused")).rejects.toThrow("Failed to send stdin");
  await expect(execution.closeStdIn()).rejects.toThrow("Failed to send stdin");
});
