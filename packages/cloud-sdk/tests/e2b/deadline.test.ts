import { expect, test } from "bun:test";
import { Commands, type SandboxContext } from "../../src/e2b/commands";
import type { ProcessInfo } from "../../src/types";

test("a command deadline disconnects without killing; reconnect has its own deadline", async () => {
  const child = Bun.spawn(["bash", "-c", "sleep 0.2; printf completed"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = new Response(child.stdout).text();
  let kills = 0;
  let spawnOptions: unknown;
  const info = {
    id: "deadline-process",
    state: "running",
    outputBytes: 0,
    stdinOpen: false,
  } as ProcessInfo;
  const process = {
    id: info.id,
    info,
    async *output({ signal }: { signal: AbortSignal }) {
      let abort!: () => void;
      try {
        signal.throwIfAborted();
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            abort = () =>
              reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
            signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
        signal.throwIfAborted();
        yield { type: "stdout", data: await text, offset: 0 };
        yield { type: "exit", exitCode: await child.exited, state: "exited", timedOut: false };
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
      }
    },
    async kill() {
      kills++;
      child.kill();
    },
  };
  const commands = new Commands({
    ensureHome: async () => {},
    runtime: {
      spawn: async (_command: string, options: unknown) => {
        spawnOptions = options;
        return process;
      },
      processes: { list: async () => [info], get: async () => process },
    },
  } as unknown as SandboxContext);
  try {
    const handle = await commands.run("sleep 0.2; printf completed", {
      background: true,
      timeoutMs: 15,
    });
    await expect(handle.wait()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(child.exitCode).toBeNull();
    expect(kills).toBe(0);
    expect(spawnOptions).not.toHaveProperty("timeoutMs");
    const short = await commands.connect(handle.pid, { timeoutMs: 15 });
    await expect(short.wait()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(kills).toBe(0);
    const again = await commands.connect(handle.pid, { timeoutMs: 0 });
    expect(await again.wait()).toMatchObject({ stdout: "completed", exitCode: 0 });
    expect(kills).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
