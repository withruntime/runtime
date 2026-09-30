import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Process } from "../../src/daytona/process";
import type { SandboxContext } from "../../src/daytona/context";
import type { OutputEvent, ProcessInfo } from "../../src/types";

// A real persistent Bash, with only its network transport replaced. Recording
// command strings cannot detect control flow escaping the command envelope.
test("Daytona sessions retain shell state, survive return and time out waits without killing commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-daytona-session-"));
  const children: ReturnType<typeof spawn>[] = [];
  const native = {
    processes: { list: async () => [] },
    async spawn(argv: string[], options: { cwd?: string; env?: Record<string, string> }) {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: directory,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      const events: OutputEvent[] = [];
      let offset = 0;
      let ended = false;
      let code: number | null = null;
      const waiters = new Set<() => void>();
      const wake = () => {
        for (const resolve of waiters) resolve();
        waiters.clear();
      };
      for (const channel of ["stdout", "stderr"] as const)
        child[channel].on("data", (data: Buffer) => {
          events.push({ type: channel, data: data.toString(), offset });
          offset += data.length;
          wake();
        });
      child.on("close", (exitCode) => {
        code = exitCode;
        ended = true;
        events.push({ type: "exit", exitCode, state: "exited", timedOut: false });
        wake();
      });
      return {
        id: String(child.pid),
        get info() {
          return {
            id: String(child.pid),
            state: ended ? "exited" : "running",
            command: argv.join(" "),
            outputBytes: offset,
            firstOffset: 0,
            exitCode: code,
          } as ProcessInfo;
        },
        async write(data: string) {
          child.stdin.write(data);
        },
        async kill(signal: NodeJS.Signals = "SIGTERM") {
          child.kill(signal);
        },
        async *output({ cursor = 0 }: { cursor?: number } = {}) {
          let index = 0;
          for (;;) {
            while (index < events.length) {
              const event = events[index++]!;
              if (event.type === "exit") {
                yield event;
                return;
              }
              if (
                (event.type === "stdout" || event.type === "stderr") &&
                event.offset + Buffer.byteLength(event.data) > cursor
              )
                yield event;
            }
            if (ended) return;
            await new Promise<void>((resolve) => waiters.add(resolve));
          }
        },
      };
    },
  };
  const api = new Process({
    live: async () => native,
    env: {},
    language: "python",
    ensureHome: async () => {},
  } as unknown as SandboxContext);
  try {
    await api.createSession("ordinary");
    await api.executeSessionCommand("ordinary", {
      command: "export GREETING=hello; mkdir child; cd child; f() { printf function; }",
    });
    expect(
      (
        await api.executeSessionCommand("ordinary", {
          command: 'printf "%s:%s:" "$GREETING" "${PWD##*/}"; f',
        })
      ).stdout,
    ).toBe("hello:child:function");
    expect((await api.executeSessionCommand("ordinary", { command: "return 7" }, 1)).exitCode).toBe(
      7,
    );
    expect(
      (await api.executeSessionCommand("ordinary", { command: "printf still-running" })).stdout,
    ).toBe("still-running");
    await expect(
      api.executeSessionCommand(
        "ordinary",
        { command: "sleep 0.15; printf finished > survived" },
        0.02,
      ),
    ).rejects.toMatchObject({ name: "DaytonaProcessExecutionTimeoutError" });
    // The next command queues behind the still-running one, rather than racing it.
    expect((await api.executeSessionCommand("ordinary", { command: "cat survived" })).stdout).toBe(
      "finished",
    );
    await api.deleteSession("ordinary");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
      if (child.exitCode === null)
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
