import type { Process } from "../sandbox.js";
import type { OutputEvent, ProcessInfo as RuntimeProcessInfo } from "../types.js";
import type { RequestOptions } from "../transport.js";
import type { RuntimeSandbox } from "./client.js";
import {
  CommandExitError,
  guard,
  InvalidArgumentError,
  SandboxError,
  TimeoutError,
  translate,
  type CommandResult,
} from "./errors.js";
import { commandAs, runAs } from "./users.js";

export type { CommandResult };
export type Username = "user" | "root" | (string & {});

export interface CommandRequestOpts {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}
export interface CommandStartOpts extends CommandRequestOpts {
  background?: boolean;
  cwd?: string;
  /** "user" (the default) is the sandbox's own user, `runtime`; any other
   * user that exists in the sandbox, `root` included, runs it through
   * `sudo -u`. An unknown user is refused, never created. */
  user?: Username;
  envs?: Record<string, string>;
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
  stdin?: boolean;
  /** Stream connection deadline, 60 000 by default. Zero waits without a deadline. */
  timeoutMs?: number;
}
export type CommandConnectOpts = Pick<CommandStartOpts, "onStderr" | "onStdout" | "timeoutMs"> &
  CommandRequestOpts;

/** A command as E2B lists it. `pid` is a number derived from Runtime's process
 * id (stable for the life of the process), not the Linux pid. */
export interface ProcessInfo {
  pid: number;
  tag?: string;
  cmd: string;
  args: string[];
  envs: Record<string, string>;
  cwd?: string;
}

/** The shared state a sandbox's modules need: the Runtime sandbox and the
 * one-time /home/user link. The environment given at create is Runtime's to
 * keep: it is the sandbox's own `env`, added to every command there. */
export interface SandboxContext {
  readonly runtime: RuntimeSandbox;
  readonly requestTimeoutMs?: number;
  /** Makes /home/user (E2B's home) lead to /workspace (Runtime's), once, when
   * something names it. */
  ensureHome(text: string | undefined, options?: RequestOptions): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** How long a command may run on Runtime: a day, E2B's longest sandbox. E2B's
 * own `timeoutMs` bounds only the connection, so the process gets this. */
const PROCESS_LIFETIME_MS = 86_400_000;

/** E2B's pids are numbers; Runtime's process ids are strings. The number is a
 * 31-bit FNV-1a hash of the id, so every client derives the same one. */
export function pidOf(processId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < processId.length; i++) {
    hash ^= processId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1 || 1;
}

export function timeoutFor(timeoutMs: number | undefined) {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
    throw new InvalidArgumentError("timeoutMs must be a nonnegative whole number.");
  return timeoutMs;
}

/** One budget for lookup and mutation, including retries and queued input. */
export function commandRequest(
  opts: CommandRequestOpts,
  defaultTimeoutMs = 60_000,
): RequestOptions {
  opts.signal?.throwIfAborted();
  const timeoutMs = timeoutFor(opts.requestTimeoutMs ?? defaultTimeoutMs);
  const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal =
    opts.signal && deadline ? AbortSignal.any([opts.signal, deadline]) : (opts.signal ?? deadline);
  return { timeoutMs: 0, ...(signal ? { signal } : {}) };
}

export async function findProcess(ctx: SandboxContext, pid: number, options: RequestOptions) {
  options.signal?.throwIfAborted();
  const processes = await guard("sandbox", () => ctx.runtime.processes.list(options));
  options.signal?.throwIfAborted();
  const matches = processes.filter((info) => pidOf(info.id) === pid && info.state === "running");
  if (matches.length > 1)
    throw new SandboxError(
      `More than one running command has pid ${pid}; use the native process id instead.`,
    );
  return matches[0];
}

export async function resolveProcess(
  ctx: SandboxContext,
  pid: number,
  options: RequestOptions,
): Promise<Process> {
  const info = await findProcess(ctx, pid, options);
  if (!info) throw new SandboxError(`No running command with pid ${pid}.`);
  return guard("sandbox", () => ctx.runtime.processes.get(info.id, options));
}

export async function killProcess(
  ctx: SandboxContext,
  pid: number,
  options: RequestOptions,
): Promise<boolean> {
  const info = await findProcess(ctx, pid, options);
  if (!info) return false;
  try {
    const process = await guard("sandbox", () => ctx.runtime.processes.get(info.id, options));
    options.signal?.throwIfAborted();
    await guard("sandbox", () => process.kill("SIGKILL", options));
    return true;
  } catch (error) {
    if (error instanceof SandboxError && error.statusCode === 404) return false;
    throw error;
  }
}

export function timedOut(timeoutMs: number) {
  return new TimeoutError(
    `Command timed out after ${timeoutMs} ms: this error is likely due to exceeding 'timeoutMs'. ` +
      "Pass a larger 'timeoutMs', or 0 for no limit.",
  );
}

/** A Runtime result as E2B's: a command killed by a signal has no exit code on
 * Runtime; E2B reports -1. E2B never loses output, so a result that did says
 * so in `truncated` rather than passing as whole. */
function toResult(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}): CommandResult {
  const exitCode = result.exitCode ?? -1;
  return {
    exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(exitCode === 0
      ? { error: "" }
      : {
          error: result.exitCode === null ? "terminated by a signal" : `exit status ${exitCode}`,
        }),
    ...(result.truncated ? { truncated: true as const } : {}),
  };
}

/** The subscription deadline includes the opening handshake. */
export function connectionRequest(opts: CommandConnectOpts, defaultTimeoutMs?: number) {
  const timeoutMs = timeoutFor(opts.timeoutMs);
  const deadline = timeoutMs > 0 ? performance.now() + timeoutMs : undefined;
  const connectionTimeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal =
    connectionTimeout && opts.signal
      ? AbortSignal.any([connectionTimeout, opts.signal])
      : (connectionTimeout ?? opts.signal);
  return {
    timeoutMs,
    deadline,
    request: commandRequest({ ...opts, signal }, defaultTimeoutMs),
    failure: (error: unknown): never => {
      if (connectionTimeout?.aborted) throw timedOut(timeoutMs);
      throw error;
    },
  };
}

function settle(
  result: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
  },
  timeoutMs: number,
): CommandResult {
  if (result.timedOut) throw timedOut(timeoutMs);
  const out = toResult(result);
  if (out.truncated && typeof process !== "undefined" && process.emitWarning)
    process.emitWarning(
      "Part of the command's output was dropped before it was read, so stdout and stderr are incomplete (result.truncated). Write large output to a file and read it with sandbox.files.read.",
      { code: "RUNTIME_E2B_OUTPUT_TRUNCATED" },
    );
  if (out.exitCode !== 0) throw new CommandExitError(out);
  return out;
}

/** `sandbox.commands`: E2B's command module over Runtime's exec and processes. */
export class Commands {
  readonly #ctx: SandboxContext;
  constructor(ctx: SandboxContext) {
    this.#ctx = ctx;
  }

  #env(envs: Record<string, string> | undefined) {
    return envs && Object.keys(envs).length ? { env: envs } : {};
  }

  /** Runs a command. In the foreground it resolves with the result and throws
   * CommandExitError on a non-zero exit and TimeoutError past `timeoutMs`; with
   * `background: true` it resolves at once with a CommandHandle. */
  run(cmd: string, opts?: CommandStartOpts & { background?: false }): Promise<CommandResult>;
  run(cmd: string, opts: CommandStartOpts & { background: true }): Promise<CommandHandle>;
  run(
    cmd: string,
    opts?: CommandStartOpts & { background?: boolean },
  ): Promise<CommandHandle | CommandResult>;
  async run(cmd: string, opts: CommandStartOpts = {}): Promise<CommandHandle | CommandResult> {
    const opening = connectionRequest(opts, this.#ctx.requestTimeoutMs);
    const handle = await (async () => {
      const user = await runAs(this.#ctx, opts.user, opening.request);
      await this.#ctx.ensureHome(`${cmd}\n${opts.cwd ?? ""}`, opening.request);
      opening.request.signal?.throwIfAborted();
      const command = user ? commandAs(user, cmd, opts.cwd !== undefined) : cmd;
      // A command waited on here is read from its first byte by the request
      // that starts it, so Runtime holds a fast writer back rather than
      // dropping what it printed before the first read: the result is whole.
      return opts.background || opts.stdin
        ? this.#start(command, opts, opening.timeoutMs, opening.request, opening.deadline)
        : this.#stream(command, opts, opening.timeoutMs, opening.request, opening.deadline);
    })().catch(opening.failure);
    return opts.background ? handle : handle.wait();
  }

  async #stream(
    cmd: string | string[],
    opts: CommandStartOpts,
    timeoutMs: number,
    request: RequestOptions,
    deadline?: number,
  ) {
    const abort = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal;
    const stopOpening = () => abort.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", stopOpening, { once: true });
    const stream = this.#ctx.runtime.execStream(cmd, {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...this.#env(opts.envs),
      timeoutMs: PROCESS_LIFETIME_MS,
      signal,
    });
    const events = stream[Symbol.asyncIterator]();
    try {
      const first = await guard("sandbox", () => events.next());
      if (first.done || first.value.type !== "start")
        throw new SandboxError("The command's output began without a start.");
      const runtime = this.#ctx.runtime;
      const processId = first.value.processId;
      return new CommandHandle(
        {
          started: true,
          id: processId,
          events,
          abort,
          process: () =>
            runtime.processes.get(processId, commandRequest({}, this.#ctx.requestTimeoutMs)),
        },
        {
          stdin: false,
          timeoutMs,
          deadline,
          requestTimeoutMs: this.#ctx.requestTimeoutMs,
          ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
          ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
        },
      );
    } catch (error) {
      abort.abort();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", stopOpening);
    }
  }

  async #start(
    cmd: string | string[],
    opts: CommandStartOpts,
    timeoutMs: number,
    request: RequestOptions,
    deadline?: number,
  ) {
    request.signal?.throwIfAborted();
    const process = await guard("sandbox", () =>
      this.#ctx.runtime.spawn(cmd, {
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...this.#env(opts.envs),
        ...(opts.stdin ? { stdin: "pipe" } : {}),
        request,
      }),
    );
    return new CommandHandle(process, {
      stdin: opts.stdin === true,
      timeoutMs,
      deadline,
      requestTimeoutMs: this.#ctx.requestTimeoutMs,
      signal: opts.signal,
      ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
      ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    });
  }

  /** Running commands. */
  async list(opts: CommandRequestOpts = {}): Promise<ProcessInfo[]> {
    const request = commandRequest(opts, this.#ctx.requestTimeoutMs);
    const processes = await guard("sandbox", () => this.#ctx.runtime.processes.list(request));
    return processes.filter((info) => info.state === "running").map(describe);
  }

  /** Kills a command with SIGKILL, as E2B does. False when there is none. */
  async kill(pid: number, opts: CommandRequestOpts = {}): Promise<boolean> {
    return killProcess(this.#ctx, pid, commandRequest(opts, this.#ctx.requestTimeoutMs));
  }

  /** Sends input to a command started with `stdin: true`. */
  async sendStdin(pid: number, data: string | Uint8Array, opts: CommandRequestOpts = {}) {
    const request = commandRequest(opts, this.#ctx.requestTimeoutMs);
    const process = await resolveProcess(this.#ctx, pid, request);
    if (!process.info.stdinOpen)
      throw new InvalidArgumentError(
        `The command with pid ${pid} was not started with stdin: true, so its input is closed.`,
      );
    request.signal?.throwIfAborted();
    await guard("sandbox", () => process.write(data, request));
  }

  async closeStdin(pid: number, opts: CommandRequestOpts = {}) {
    const request = commandRequest(opts, this.#ctx.requestTimeoutMs);
    const process = await resolveProcess(this.#ctx, pid, request);
    request.signal?.throwIfAborted();
    await guard("sandbox", () => process.write("", { ...request, eof: true }));
  }

  /** Attaches to a running command; output from now on reaches the handle. */
  async connect(pid: number, opts: CommandConnectOpts = {}): Promise<CommandHandle> {
    const opening = connectionRequest(opts, this.#ctx.requestTimeoutMs);
    const process = await resolveProcess(this.#ctx, pid, opening.request).catch(opening.failure);
    return new CommandHandle(process, {
      stdin: process.info.stdinOpen,
      timeoutMs: opening.timeoutMs,
      deadline: opening.deadline,
      signal: opts.signal,
      cursor: process.info.outputBytes,
      requestTimeoutMs: this.#ctx.requestTimeoutMs,
      ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
      ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    });
  }
}

function describe(info: RuntimeProcessInfo): ProcessInfo {
  return {
    pid: pidOf(info.id),
    cmd: "/bin/bash",
    args: ["-c", info.command],
    envs: {},
    cwd: info.cwd,
  };
}

/** Reader cancellation also releases a callback whose promise never settles. */
async function deliver(signal: AbortSignal, callback: () => void | Promise<void>) {
  signal.throwIfAborted();
  let cancelled!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the caller's abort reason as is, as the upstream SDK does
    cancelled = () => reject(signal.reason);
    signal.addEventListener("abort", cancelled, { once: true });
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return callback();
      }),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", cancelled);
  }
}

/** A command whose output this handle reads from the request that started
 * it: its process id, the rest of its events, the controller that ends the
 * read, and the Runtime process, fetched only when something needs it. */
export interface StartedStream {
  started: true;
  id: string;
  events: AsyncIterator<OutputEvent>;
  abort: AbortController;
  process: () => Promise<Process>;
}

/** A command started in the background: E2B's CommandHandle over a Runtime
 * process. Output streams into `stdout`/`stderr` and the callbacks as it
 * arrives. */
export class CommandHandle {
  readonly pid: number;
  readonly #source: Process | StartedStream;
  #process: Promise<Process> | undefined;
  readonly #stdin: boolean;
  readonly #timeoutMs: number;
  readonly #requestTimeoutMs: number | undefined;
  readonly #abort: AbortController;
  readonly #done: Promise<void>;
  #stdout = "";
  #stderr = "";
  #exit: { exitCode: number | null; timedOut: boolean } | undefined;
  #truncated = false;
  #failure: Error | undefined;
  #disconnected = false;
  #deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(
    source: Process | StartedStream,
    options: {
      stdin: boolean;
      timeoutMs: number;
      cursor?: number;
      signal?: AbortSignal;
      onStdout?: (data: string) => void | Promise<void>;
      onStderr?: (data: string) => void | Promise<void>;
      onData?: (data: Uint8Array) => void | Promise<void>;
      pty?: boolean;
      requestTimeoutMs?: number;
      deadline?: number;
    },
  ) {
    this.#source = source;
    this.#abort = "started" in source ? source.abort : new AbortController();
    this.pid = pidOf(source.id);
    this.#stdin = options.stdin;
    this.#timeoutMs = options.timeoutMs;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    // E2B's timeout limits the subscription. It never asks us to kill the
    // process: the sandbox lease still bounds the workload after disconnect.
    if (options.timeoutMs > 0) {
      this.#deadline = setTimeout(
        () => {
          this.#failure = timedOut(options.timeoutMs);
          this.#abort.abort();
        },
        options.deadline === undefined
          ? options.timeoutMs
          : Math.max(0, options.deadline - performance.now()),
      );
      this.#deadline.unref?.();
    }
    this.#done = this.#follow(options);
  }

  async #follow(options: {
    cursor?: number;
    signal?: AbortSignal;
    onStdout?: (data: string) => void | Promise<void>;
    onStderr?: (data: string) => void | Promise<void>;
    onData?: (data: Uint8Array) => void | Promise<void>;
    pty?: boolean;
  }) {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.#abort.signal])
      : this.#abort.signal;
    const source = this.#source;
    try {
      const outputOptions = {
        ...(options.cursor ? { cursor: options.cursor } : {}),
        signal,
      };
      const output: AsyncIterable<OutputEvent | { type: string; data: unknown }> =
        "started" in source
          ? { [Symbol.asyncIterator]: () => source.events }
          : options.pty
            ? source.outputBytes(outputOptions)
            : source.output(outputOptions);
      for await (const event of output) {
        if (this.#disconnected) break;
        signal.throwIfAborted();
        if (
          (event.type === "stdout" || event.type === "stderr") &&
          event.data instanceof Uint8Array
        ) {
          await deliver(signal, () => options.onData?.(event.data as Uint8Array));
        } else if (event.type === "stdout" && typeof event.data === "string") {
          this.#stdout += event.data;
          await deliver(signal, () => options.onStdout?.(event.data as string));
        } else if (event.type === "stderr" && typeof event.data === "string") {
          this.#stderr += event.data;
          await deliver(signal, () => options.onStderr?.(event.data as string));
        } else if (event.type === "truncated") {
          this.#truncated = true;
        } else if (event.type === "exit") {
          const exit = event as Extract<OutputEvent, { type: "exit" }>;
          this.#exit = { exitCode: exit.exitCode, timedOut: exit.timedOut };
        }
      }
    } catch (error) {
      if (!this.#disconnected && !this.#failure) {
        const translated = translate(error, "sandbox");
        this.#failure =
          translated instanceof Error ? translated : new SandboxError(String(translated));
      }
    } finally {
      if (this.#deadline !== undefined) clearTimeout(this.#deadline);
    }
  }

  /** The exit code, or undefined while the command runs. */
  get exitCode(): number | undefined {
    return this.#exit ? (this.#exit.exitCode ?? -1) : undefined;
  }
  get error(): string | undefined {
    return this.#exit ? this.#result().error : undefined;
  }
  get stdout(): string {
    return this.#stdout;
  }
  get stderr(): string {
    return this.#stderr;
  }

  #result() {
    return toResult({
      exitCode: this.#exit?.exitCode ?? null,
      stdout: this.#stdout,
      stderr: this.#stderr,
    });
  }

  /** Waits for the command to end. Throws CommandExitError on a non-zero exit,
   * as E2B does. */
  async wait(): Promise<CommandResult> {
    await this.#done;
    if (this.#failure) throw this.#failure;
    if (!this.#exit)
      throw new SandboxError(
        this.#disconnected
          ? "Disconnected from the command before it ended; reconnect with commands.connect(pid)."
          : "The command's output ended without an exit.",
      );
    return settle(
      {
        exitCode: this.#exit.exitCode,
        stdout: this.#stdout,
        stderr: this.#stderr,
        timedOut: this.#exit.timedOut,
        truncated: this.#truncated,
      },
      this.#timeoutMs,
    );
  }

  /** Stops receiving output; the command keeps running. */
  async disconnect(): Promise<void> {
    this.#disconnected = true;
    this.#abort.abort();
    await Promise.resolve();
  }

  /** The Runtime process, fetched once when a started stream needs it. */
  #runtimeProcess(): Promise<Process> {
    const source = this.#source;
    if (!("started" in source)) return Promise.resolve(source);
    this.#process ??= guard("sandbox", source.process);
    this.#process.catch(() => (this.#process = undefined));
    return this.#process;
  }

  /** Kills the command with SIGKILL. False when it had already ended. */
  async kill(): Promise<boolean> {
    if (this.#exit) return false;
    try {
      const process = await this.#runtimeProcess();
      await guard("sandbox", () =>
        process.kill("SIGKILL", commandRequest({}, this.#requestTimeoutMs)),
      );
      return true;
    } catch (error) {
      if (error instanceof SandboxError && error.statusCode === 404) return false;
      throw error;
    }
  }

  async sendStdin(data: string | Uint8Array, opts: CommandRequestOpts = {}): Promise<void> {
    const request = commandRequest(opts, this.#requestTimeoutMs);
    if (!this.#stdin)
      throw new InvalidArgumentError(
        "The command was not started with stdin: true, so its input is closed.",
      );
    const process = await this.#runtimeProcess();
    await guard("sandbox", () => process.write(data, request));
  }

  async closeStdin(opts: CommandRequestOpts = {}): Promise<void> {
    const request = commandRequest(opts, this.#requestTimeoutMs);
    if (!this.#stdin)
      throw new InvalidArgumentError("The command was not started with stdin: true.");
    const process = await this.#runtimeProcess();
    await guard("sandbox", () => process.write("", { ...request, eof: true }));
  }
}
