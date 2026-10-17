import type { Readable } from "node:stream";
import type { Process } from "../sandbox.js";
import { APIError, guard, StreamError, translate } from "./errors.js";

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
  /** Each line as it arrives, for an attached command's stdout/stderr. */
  onLine?: (line: LogOutputLine) => void;
};

/** One stdin request carries at most this much of a write (Runtime's input
 * request size); a client error on it means none of it was applied. */
const STDIN_REQUEST_BYTES = 1_048_576;
/** Reading a piped stream pauses once this much waits behind a write. */
const STDIN_BUFFERED_BYTES = 512 * 1024;

/** A command in a sandbox, as Vercel's `Command`. A detached one runs on:
 * `wait()` for its end, `logs()` for its output as it happens. `cmdId` is
 * Runtime's process id. */
export class Command {
  exitCode: number | null = null;
  durationMs?: number;
  protected readonly init: Init;
  #finished: Promise<CommandFinished> | undefined;
  /** Pending stdin writes, so concurrent calls reach the process in call order. */
  #stdinQueue: Promise<void> = Promise.resolve();
  /** Set when a write failed after possibly writing part of it; later writes
   * are refused so nothing is appended to a partial message. */
  #stdinError: unknown = null;
  /** Set when the command was started with a `Readable` for stdin. */
  stdinPipe: StdinPipe | null = null;

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

  /** Waits for the command to end. With a `Readable` piped to its stdin,
   * rejects if piping fails, and stops piping once the command exits. */
  wait(params: { signal?: AbortSignal } = {}): Promise<CommandFinished> {
    this.#finished ??= this.#follow(params);
    const pipe = this.stdinPipe;
    if (!pipe) return this.#finished;
    return waitWithStdinPipe(this.#finished, pipe, {
      ...(params.signal ? { signal: params.signal } : {}),
      onPipeError: () => {
        if (this.stdinPipe === pipe) this.stdinPipe = null;
      },
    });
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
        if (event.type === "stdout" || event.type === "stderr") {
          const line: LogOutputLine = { stream: event.type, data: event.data };
          lines.push(line);
          this.init.onLine?.(line);
        } else if (event.type === "exit")
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
    const { onLine: _onLine, ...init } = this.init;
    return new CommandFinished({ ...init, lines }, this.exitCode, exit.durationMs ?? undefined);
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

  /** Writes to the stdin of a command started with `stdin: true` and
   * `detached: true`. Writes reach the process in call order and resolve once
   * it has accepted the data; Runtime's input offsets make every resend exact,
   * so no byte is written twice. If a write fails, part of it may have been
   * written, and later writes are refused; closeStdin still works. */
  async writeStdin(
    data: string | Uint8Array,
    opts: { abortSignal?: AbortSignal } = {},
  ): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) return;
    await this.#enqueueStdin(async (process) => {
      if (this.#stdinError)
        throw new Error(
          "Stdin is in an unknown state after an earlier write failed. Close stdin or kill the command.",
          { cause: this.#stdinError },
        );
      opts.abortSignal?.throwIfAborted();
      try {
        await guard(
          () => process.write(bytes, opts.abortSignal ? { signal: opts.abortSignal } : {}),
          this.init.sandboxName,
        );
      } catch (error) {
        const rejectedWhole =
          error instanceof APIError &&
          error.response.status >= 400 &&
          error.response.status < 500 &&
          bytes.length <= STDIN_REQUEST_BYTES;
        if (!rejectedWhole) this.#stdinError = error;
        throw error;
      }
    }, opts.abortSignal);
  }

  /** Closes the command's stdin, so it reads EOF once it has consumed what
   * was written. */
  async closeStdin(opts: { abortSignal?: AbortSignal } = {}): Promise<void> {
    await this.#enqueueStdin(
      (process) =>
        guard(
          () =>
            process.write(new Uint8Array(0), {
              eof: true,
              ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
            }),
          this.init.sandboxName,
        ),
      opts.abortSignal,
    );
  }

  #enqueueStdin(work: (process: Process) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const previous = this.#stdinQueue;
    const run = (async () => {
      await waitForTurn(previous, signal);
      return work(this.init.process!);
    })();
    this.#stdinQueue = Promise.allSettled([previous, run]).then(() => {});
    return run;
  }
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** A `Readable` being written to a command's stdin. */
export interface StdinPipe {
  /** Resolves once the stream has ended and stdin is closed, or the command
   * stops accepting input; rejects if a write fails or the stream errors. */
  done: Promise<void>;
  /** Stops reading the stream, for when the command has exited. */
  stop(): void;
}

/** The command exited or closed its input: piping ends quietly, as a closed
 * pipe does in a shell. */
function inputNoLongerAccepted(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.response.status === 404 ||
      (error.response.status === 409 && error.code === "stdin_closed"))
  );
}

/** Writes a stream to a command's stdin in order, closing stdin when it
 * ends. What is read while a write is in flight goes in the next write, and
 * reading pauses while too much waits. The stream is never ended or
 * destroyed, and every listener is removed once piping stops. */
export function pipeStdin(command: Command, stream: Readable, signal?: AbortSignal): StdinPipe {
  let stopped = false;
  let writing = false;
  let ended = false;
  let waiting: Uint8Array[] = [];
  let waitingBytes = 0;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});

  const stop = () => {
    if (stopped) return false;
    stopped = true;
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onError);
    stream.off("close", onClose);
    signal?.removeEventListener("abort", onAbort);
    stream.pause();
    return true;
  };
  const settle = (error?: unknown) => {
    if (!stop()) return;
    if (error === undefined) resolveDone();
    else rejectDone(error);
  };
  const failed = (error: unknown) => settle(inputNoLongerAccepted(error) ? undefined : error);
  const flush = () => {
    if (stopped || writing) return;
    if (waiting.length) {
      writing = true;
      const data = concat(waiting);
      waiting = [];
      waitingBytes = 0;
      command.writeStdin(data).then(() => {
        writing = false;
        if (stopped) return;
        if (!ended) stream.resume();
        flush();
      }, failed);
    } else if (ended) {
      writing = true;
      command.closeStdin().then(() => settle(), failed);
    }
  };
  function onData(chunk: string | Uint8Array) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    waiting.push(bytes);
    waitingBytes += bytes.length;
    if (waitingBytes >= STDIN_BUFFERED_BYTES) stream.pause();
    flush();
  }
  function onEnd() {
    ended = true;
    flush();
  }
  function onError(error: unknown) {
    if (!stop()) return;
    void command
      .closeStdin()
      .catch(() => {})
      .finally(() => rejectDone(error));
  }
  function onClose() {
    if (!stream.readableEnded) onError(new Error("The stdin stream closed before it ended"));
  }
  function onAbort() {
    settle();
  }

  if (signal?.aborted) settle();
  else {
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("error", onError);
    stream.on("close", onClose);
    if (stream.destroyed && !stream.readableEnded) onClose();
    else {
      stream.on("end", onEnd);
      stream.on("data", onData);
      if (stream.readableEnded) onEnd();
    }
  }
  return { done, stop: () => settle() };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Waits for a command to finish, rejecting early if piping its stdin fails,
 * and stops piping once it has exited. Aborting `signal` stops waiting but
 * leaves the pipe running. */
export async function waitWithStdinPipe<T>(
  finished: Promise<T>,
  pipe: StdinPipe | null,
  opts: { signal?: AbortSignal; onPipeError?: () => void } = {},
): Promise<T> {
  if (!pipe) return finished;
  finished.then(
    () => pipe.stop(),
    () => {
      if (!opts.signal?.aborted) pipe.stop();
    },
  );
  return Promise.race([
    finished,
    pipe.done.then(
      () => finished,
      (error) => {
        opts.onPipeError?.();
        throw error;
      },
    ),
  ]);
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
  /** Always throws: the command has already exited. */
  override async writeStdin(
    _data: string | Uint8Array,
    _opts?: { abortSignal?: AbortSignal },
  ): Promise<never> {
    throw new Error("Cannot write to stdin: the command has already finished.");
  }
  /** Always throws: the command has already exited. */
  override async closeStdin(_opts?: { abortSignal?: AbortSignal }): Promise<never> {
    throw new Error("Cannot close stdin: the command has already finished.");
  }
}
