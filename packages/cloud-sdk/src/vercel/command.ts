import type { Process } from "../sandbox.js";
import { guard, StreamError, translate } from "./errors.js";

/** One piece of a command's output, as Vercel's `logs()` yields it. */
export type LogOutputLine = { stream: "stdout" | "stderr"; data: string };
/** Cached output from a command, as in Vercel. */
export interface CommandOutput {
  stdout: string;
  stderr: string;
}
export type Signal =
  "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" | "SIGQUIT" | "SIGUSR1" | "SIGUSR2" | number;

type RuntimeSignal = Exclude<Signal, number>;
const SIGNAL_NUMBERS: Record<number, RuntimeSignal> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  9: "SIGKILL",
  10: "SIGUSR1",
  12: "SIGUSR2",
  15: "SIGTERM",
};

/** A command killed by a signal has no exit code on Runtime. One killed at
 * its `timeoutMs` (SIGKILL) reports 137, as a shell does; any other signal
 * reports -1. */
export function exitCodeOf(exitCode: number | null, timedOut: boolean): number {
  if (exitCode !== null) return exitCode;
  return timedOut ? 137 : -1;
}

function join(lines: LogOutputLine[], stream: "stdout" | "stderr" | "both") {
  return lines
    .filter((line) => stream === "both" || line.stream === stream)
    .map((line) => line.data)
    .join("");
}

type Init = {
  id: string;
  cwd: string;
  startedAt: number;
  sandboxName: string;
  process?: Process;
  lines?: LogOutputLine[];
};

/** A command in a sandbox, as Vercel's `Command`. A detached one runs on:
 * `wait()` for its end, `logs()` for its output as it happens. `cmdId` is
 * Runtime's process id. */
export class Command {
  exitCode: number | null = null;
  durationMs?: number;
  protected readonly init: Init;
  #finished: Promise<CommandFinished> | undefined;

  constructor(init: Init) {
    this.init = init;
  }
  get cmdId(): string {
    return this.init.id;
  }
  get cwd(): string {
    return this.init.cwd;
  }
  get startedAt(): number {
    return this.init.startedAt;
  }

  /** The command's output from its start, as it happens:
   * `for await (const log of cmd.logs()) process.stdout.write(log.data)`. */
  logs(
    opts: { signal?: AbortSignal } = {},
  ): AsyncGenerator<LogOutputLine, void, void> & Disposable & { close(): void } {
    const abort = new AbortController();
    const forward = () => abort.abort();
    if (opts.signal?.aborted) abort.abort();
    else opts.signal?.addEventListener("abort", forward, { once: true });
    const lines = this.init.lines;
    const process = this.init.process;
    const sandboxName = this.init.sandboxName;
    async function* read(): AsyncGenerator<LogOutputLine, void, void> {
      try {
        if (abort.signal.aborted) return;
        if (lines) {
          yield* lines;
          return;
        }
        try {
          for await (const event of process!.output({ signal: abort.signal })) {
            if (event.type === "truncated")
              throw new StreamError(
                "output_truncated",
                "Some command output is no longer available.",
                process!.id,
              );
            if (event.type === "stdout" || event.type === "stderr")
              yield { stream: event.type, data: event.data };
            if (event.type === "exit") return;
          }
        } catch (error) {
          if (abort.signal.aborted) return;
          if (error instanceof StreamError) throw error;
          const translated = translate(error, sandboxName);
          throw translated instanceof Error && translated !== error
            ? translated
            : new StreamError(
                "stream_failed",
                String((error as Error).message ?? error),
                process!.id,
              );
        }
      } finally {
        opts.signal?.removeEventListener("abort", forward);
      }
    }
    const generator = read();
    return Object.assign(generator, {
      close: () => abort.abort(),
      [Symbol.dispose]: () => abort.abort(),
    });
  }

  /** Waits for the command to end. */
  wait(params: { signal?: AbortSignal } = {}): Promise<CommandFinished> {
    this.#finished ??= this.#follow(params);
    return this.#finished;
  }

  async #follow(params: { signal?: AbortSignal }): Promise<CommandFinished> {
    const lines: LogOutputLine[] = [];
    let exit: { exitCode: number | null; timedOut: boolean; durationMs?: number } | undefined;
    await guard(async () => {
      for await (const event of this.init.process!.output(
        params.signal ? { signal: params.signal } : {},
      )) {
        if (event.type === "truncated")
          throw new StreamError(
            "output_truncated",
            "Some command output is no longer available.",
            this.init.process!.id,
          );
        if (event.type === "stdout" || event.type === "stderr")
          lines.push({ stream: event.type, data: event.data });
        else if (event.type === "exit")
          exit = {
            exitCode: event.exitCode,
            timedOut: event.timedOut,
            ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          };
      }
    }, this.init.sandboxName);
    if (!exit)
      throw new StreamError(
        "stream_ended",
        "The command's output ended before it exited.",
        this.init.process!.id,
      );
    this.exitCode = exitCodeOf(exit.exitCode, exit.timedOut);
    if (exit.durationMs !== undefined) this.durationMs = exit.durationMs;
    return new CommandFinished(
      { ...this.init, lines },
      this.exitCode,
      exit.durationMs ?? undefined,
    );
  }

  /** stdout, stderr, or both in the order they were written. For a detached
   * command this waits for it to end. */
  async output(
    stream: "stdout" | "stderr" | "both" = "both",
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    if (this.init.lines) return join(this.init.lines, stream);
    return (await this.wait(opts)).output(stream);
  }
  stdout(opts: { signal?: AbortSignal } = {}): Promise<string> {
    return this.output("stdout", opts);
  }
  stderr(opts: { signal?: AbortSignal } = {}): Promise<string> {
    return this.output("stderr", opts);
  }

  /** Sends a signal, SIGTERM by default. */
  async kill(signal: Signal = "SIGTERM", opts: { abortSignal?: AbortSignal } = {}): Promise<void> {
    opts.abortSignal?.throwIfAborted();
    if (!this.init.process) return;
    const name = typeof signal === "number" ? SIGNAL_NUMBERS[signal] : signal;
    if (!name)
      throw new RangeError(
        `Signal ${signal} has no name Runtime knows; use SIGTERM, SIGKILL, SIGINT, SIGHUP, SIGQUIT, SIGUSR1 or SIGUSR2.`,
      );
    await guard(
      () => this.init.process!.kill(name, opts.abortSignal ? { signal: opts.abortSignal } : {}),
      this.init.sandboxName,
    );
  }
}

/** A command that has ended; `exitCode` is set. */
export class CommandFinished extends Command {
  declare exitCode: number;
  constructor(init: Init, exitCode: number, durationMs?: number) {
    super(init);
    this.exitCode = exitCode;
    if (durationMs !== undefined) this.durationMs = durationMs;
  }
  override wait(): Promise<CommandFinished> {
    return Promise.resolve(this);
  }
}
