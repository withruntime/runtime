/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { Pty } from "../../src/e2b/pty";
import { pidOf, type SandboxContext } from "../../src/e2b/commands";
import { Sandbox as E2BSandbox } from "../../src/e2b/sandbox";
import type { ProcessInfo } from "../../src/types";

function fixture(options: { legacy?: boolean; idle?: boolean } = {}) {
  const calls: unknown[][] = [];
  const info = {
    id: "pty-process",
    state: "running",
    pty: true,
    stdinOpen: true,
    outputBytes: 7,
    outputEncoding: options.legacy ? "utf8" : "base64",
  } as ProcessInfo;
  const process = {
    id: info.id,
    info,
    async *outputBytes({ signal, cursor }: { signal: AbortSignal; cursor?: number }) {
      calls.push(["output", cursor]);
      signal.throwIfAborted();
      if (options.idle) {
        await new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      }
      yield { type: "stdout", data: Uint8Array.of(0, 128, 255, 27), offset: 7 };
      yield { type: "stderr", data: Uint8Array.of(0xc3, 0xa9), offset: 11 };
      yield { type: "exit", exitCode: 0, state: "exited", timedOut: false };
    },
    async kill(signal: string) {
      calls.push(["kill", signal]);
    },
    async write(data: Uint8Array) {
      calls.push(["write", [...data]]);
    },
    async resize(cols: number, rows: number) {
      calls.push(["resize", cols, rows]);
    },
  };
  const ctx = {
    ensureHome: async () => {},
    runtime: {
      async spawn(command: unknown, opts: unknown) {
        calls.push(["spawn", command, opts]);
        return process;
      },
      processes: { list: async () => [info], get: async () => process },
    },
  } as unknown as SandboxContext;
  return { pty: new Pty(ctx), calls, ctx, pid: pidOf(info.id) };
}

test("E2B PTY creates the pinned shell and preserves raw bytes, locale and empty result output", async () => {
  const { pty, calls, ctx } = fixture();
  const chunks: number[][] = [];
  const handle = await pty.create({
    cols: 91,
    rows: 33,
    timeoutMs: 0,
    envs: { TERM: "custom" },
    onData: async (data) => {
      chunks.push([...data]);
    },
  });
  expect(await handle.wait()).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
  expect(chunks).toEqual([
    [0, 128, 255, 27],
    [0xc3, 0xa9],
  ]);
  expect(calls[0]).toEqual([
    "spawn",
    ["/bin/bash", "-i", "-l"],
    expect.objectContaining({
      pty: { cols: 91, rows: 33 },
      outputEncoding: "base64",
      stdin: "pipe",
      env: { TERM: "custom", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    }),
  ]);
  expect((calls[0]![2] as Record<string, unknown>).timeoutMs).toBeUndefined();
  expect(new E2BSandbox(ctx.runtime, {} as never).pty).toBeInstanceOf(Pty);
  await expect(handle.sendStdin("x")).rejects.toMatchObject({ name: "InvalidArgumentError" });
});

test("PTY reconnect uses retained cursor, binary input, resizing and SIGKILL", async () => {
  const { pty, pid, calls } = fixture();
  const chunks: number[][] = [];
  await (
    await pty.connect(pid, {
      onData: (data) => {
        chunks.push([...data]);
      },
      timeoutMs: 0,
    })
  ).wait();
  await pty.sendInput(pid, Uint8Array.of(0, 255));
  await pty.resize(pid, { cols: 100, rows: 40 });
  expect(await pty.kill(pid)).toBe(true);
  expect(calls).toContainEqual(["output", 7]);
  expect(calls).toContainEqual(["write", [0, 255]]);
  expect(calls).toContainEqual(["resize", 100, 40]);
  expect(calls).toContainEqual(["kill", "SIGKILL"]);
  expect(chunks[0]).toEqual([0, 128, 255, 27]);
});

test("PTY timeout detaches output without killing the process", async () => {
  const { pty, calls } = fixture({ idle: true });
  const handle = await pty.create({ cols: 80, rows: 24, timeoutMs: 10, onData: () => {} });
  await expect(handle.wait()).rejects.toMatchObject({ name: "TimeoutError" });
  expect(calls.filter(([method]) => method === "kill")).toEqual([]);
});

test("PTY rejects legacy text, invalid sizes and pre-cancelled create before allocation", async () => {
  const legacy = fixture({ legacy: true });
  await expect(legacy.pty.connect(legacy.pid)).rejects.toMatchObject({ name: "NotSupportedError" });
  const { pty, calls } = fixture();
  for (const cols of [0, -1, 1.5])
    await expect(pty.create({ cols, rows: 24, onData: () => {} })).rejects.toMatchObject({
      name: "InvalidArgumentError",
    });
  await expect(
    pty.create({
      cols: 80,
      rows: 24,
      onData: () => {},
      signal: AbortSignal.abort(new Error("cancelled")),
    }),
  ).rejects.toThrow("cancelled");
  expect(calls).toEqual([]);
});

test("callback failure and disconnect close the subscription and prevent later callbacks", async () => {
  const { pty, calls } = fixture();
  let callbacks = 0;
  const broken = await pty.create({
    cols: 80,
    rows: 24,
    onData: () => {
      callbacks++;
      throw new Error("callback failed");
    },
  });
  await expect(broken.wait()).rejects.toThrow("callback failed");
  expect(callbacks).toBe(1);
  const idle = fixture({ idle: true });
  const handle = await idle.pty.create({
    cols: 80,
    rows: 24,
    onData: () => {
      callbacks++;
    },
  });
  await handle.disconnect();
  await expect(handle.wait()).rejects.toMatchObject({ name: "SandboxError" });
  expect(callbacks).toBe(1);
  expect(calls.filter(([method]) => method === "kill")).toEqual([]);
});

test("a stalled PTY callback cannot block reader cancellation or its deadline", async () => {
  for (const mode of ["deadline", "signal", "disconnect"] as const) {
    const { pty, calls } = fixture();
    const controller = new AbortController();
    let started!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handle = await pty.create({
      cols: 80,
      rows: 24,
      timeoutMs: mode === "deadline" ? 30 : 0,
      signal: controller.signal,
      onData: () => {
        started();
        return new Promise<void>(() => {});
      },
    });
    await callbackStarted;
    if (mode === "signal") controller.abort(new Error("cancelled"));
    if (mode === "disconnect") await handle.disconnect();
    await expect(handle.wait()).rejects.toMatchObject({
      name: mode === "deadline" ? "TimeoutError" : mode === "signal" ? "Error" : "SandboxError",
    });
    expect(calls.filter(([method]) => method === "kill")).toEqual([]);
  }
});
