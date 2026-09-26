import type { Process } from "../sandbox.js";
import type { ProcessInfo as RuntimeProcessInfo } from "../types.js";
import { request } from "./client.js";
import type { RuntimeSandbox } from "./client.js";
import {
  CommandExitError,
  guard,
  InvalidArgumentError,
  NotSupportedError,
  SandboxError,
  TimeoutError,
  translate,
  type CommandResult,
} from "./errors.js";

export type { CommandResult };
export type Username = "user" | "root" | (string & {});

export interface CommandRequestOpts {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}
export interface CommandStartOpts extends CommandRequestOpts {
  background?: boolean;
  cwd?: string;
  /** Only the default user. Runtime runs commands as `runtime`, the sandbox's
   * owner, with passwordless sudo; E2B's `root` is refused rather than
   * silently run as someone else. */
  user?: Username;
  envs?: Record<string, string>;
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
  stdin?: boolean;
  /** Default 60 000, as in E2B. 0 is no limit (Runtime's longest, 24 hours). */
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

/** The shared state a sandbox's modules need: the Runtime sandbox, the
 * environment given at create, and the one-time /home/user link. */
export interface SandboxContext {
  readonly runtime: RuntimeSandbox;
  readonly envs: Record<string, string>;
  /** Makes /home/user (E2B's home) lead to /workspace (Runtime's), once, when
   * something names it. */
  ensureHome(text: string | undefined): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const LONGEST_MS = 86_400_000;

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

function refuseUser(user: Username | undefined) {
  if (user !== undefined && user !== "user")
    throw new NotSupportedError(
      `Running as the user "${user}"`,
      'Runtime runs commands as its sandbox owner, with passwordless sudo: prefix the command with "sudo" to run it as root.',
    );
}

function timeoutFor(timeoutMs: number | undefined) {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (timeoutMs === 0) return LONGEST_MS;
  return Math.min(timeoutMs, LONGEST_MS);
}

function timedOut(timeoutMs: number) {
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
      ? {}
      : {
          error: result.exitCode === null ? "terminated by a signal" : `exit status ${exitCode}`,
        }),
    ...(result.truncated ? { truncated: true as const } : {}),
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
    const merged = { ...this.#ctx.envs, ...envs };
    return Object.keys(merged).length ? { env: merged } : {};
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
    refuseUser(opts.user);
    await this.#ctx.ensureHome(`${cmd}\n${opts.cwd ?? ""}`);
    const timeoutMs = timeoutFor(opts.timeoutMs);
    if (opts.background || opts.stdin) {
      const handle = await this.#start(cmd, opts, timeoutMs);
      return opts.background ? handle : handle.wait();
    }
    /* Always streamed, so the result holds the whole output as E2B's does: an
       exec with no output callback returns at most 64 KiB of each stream. */
    const onStdout = opts.onStdout;
    const onStderr = opts.onStderr;
    const result = await guard("sandbox", () =>
      this.#ctx.runtime.exec(cmd, {
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...this.#env(opts.envs),
        timeoutMs,
        onStdout: (text: string) => void onStdout?.(text),
        ...(onStderr ? { onStderr: (text: string) => void onStderr(text) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );
    return settle(
      { ...result, truncated: result.stdoutTruncated === true || result.stderrTruncated === true },
      timeoutMs,
    );
  }

  async #start(cmd: string, opts: CommandStartOpts, timeoutMs: number) {
    const process = await guard("sandbox", () =>
      this.#ctx.runtime.spawn(cmd, {
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...this.#env(opts.envs),
        timeoutMs,
        ...(opts.stdin ? { stdin: "pipe" } : {}),
        ...request(opts),
      }),
    );
    return new CommandHandle(process, {
      stdin: opts.stdin === true,
      timeoutMs,
      ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
      ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    });
  }

  /** Running commands. */
  async list(_opts: CommandRequestOpts = {}): Promise<ProcessInfo[]> {
    const processes = await guard("sandbox", () => this.#ctx.runtime.processes.list());
    return processes.filter((info) => info.state === "running").map(describe);
  }

  async #find(pid: number): Promise<RuntimeProcessInfo | undefined> {
    const processes = await guard("sandbox", () => this.#ctx.runtime.processes.list());
    return processes.find((info) => pidOf(info.id) === pid && info.state === "running");
  }

  async #process(pid: number): Promise<Process> {
    const info = await this.#find(pid);
    if (!info) throw new SandboxError(`No running command with pid ${pid}.`);
    return guard("sandbox", () => this.#ctx.runtime.processes.get(info.id));
  }

  /** Kills a command with SIGKILL, as E2B does. False when there is none. */
  async kill(pid: number, _opts: CommandRequestOpts = {}): Promise<boolean> {
    const info = await this.#find(pid);
    if (!info) return false;
    const process = await guard("sandbox", () => this.#ctx.runtime.processes.get(info.id));
    await guard("sandbox", () => process.kill("SIGKILL"));
    return true;
  }

  /** Sends input to a command started with `stdin: true`. */
  async sendStdin(pid: number, data: string | Uint8Array, _opts: CommandRequestOpts = {}) {
    const process = await this.#process(pid);
    if (!process.info.stdinOpen)
      throw new InvalidArgumentError(
        `The command with pid ${pid} was not started with stdin: true, so its input is closed.`,
      );
    await guard("sandbox", () => process.write(data));
  }

  async closeStdin(pid: number, _opts: CommandRequestOpts = {}) {
    const process = await this.#process(pid);
    await guard("sandbox", () => process.write("", { eof: true }));
  }

  /** Attaches to a running command; output from now on reaches the handle. */
  async connect(pid: number, opts: CommandConnectOpts = {}): Promise<CommandHandle> {
    const process = await this.#process(pid);
    return new CommandHandle(process, {
      stdin: process.info.stdinOpen,
      timeoutMs: timeoutFor(opts.timeoutMs),
      cursor: process.info.outputBytes,
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

/** A command started in the background: E2B's CommandHandle over a Runtime
 * process. Output streams into `stdout`/`stderr` and the callbacks as it
 * arrives. */
export class CommandHandle {
  readonly pid: number;
  readonly #process: Process;
  readonly #stdin: boolean;
  readonly #timeoutMs: number;
  readonly #abort = new AbortController();
  readonly #done: Promise<void>;
  #stdout = "";
  #stderr = "";
  #exit: { exitCode: number | null; timedOut: boolean } | undefined;
  #truncated = false;
  #failure: Error | undefined;
  #disconnected = false;

  constructor(
    process: Process,
    options: {
      stdin: boolean;
      timeoutMs: number;
      cursor?: number;
      onStdout?: (data: string) => void | Promise<void>;
      onStderr?: (data: string) => void | Promise<void>;
    },
  ) {
    this.#process = process;
    this.pid = pidOf(process.id);
    this.#stdin = options.stdin;
    this.#timeoutMs = options.timeoutMs;
    this.#done = this.#follow(options);
  }

  async #follow(options: {
    cursor?: number;
    onStdout?: (data: string) => void | Promise<void>;
    onStderr?: (data: string) => void | Promise<void>;
  }) {
    try {
      for await (const event of this.#process.output({
        ...(options.cursor ? { cursor: options.cursor } : {}),
        signal: this.#abort.signal,
      })) {
        if (event.type === "stdout") {
          this.#stdout += event.data;
          await options.onStdout?.(event.data);
        } else if (event.type === "stderr") {
          this.#stderr += event.data;
          await options.onStderr?.(event.data);
        } else if (event.type === "truncated") {
          this.#truncated = true;
        } else if (event.type === "exit") {
          this.#exit = { exitCode: event.exitCode, timedOut: event.timedOut };
        }
      }
    } catch (error) {
      if (!this.#disconnected) {
        const translated = translate(error, "sandbox");
        this.#failure =
          translated instanceof Error ? translated : new SandboxError(String(translated));
      }
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

  /** Kills the command with SIGKILL. False when it had already ended. */
  async kill(): Promise<boolean> {
    if (this.#exit) return false;
    try {
      await guard("sandbox", () => this.#process.kill("SIGKILL"));
      return true;
    } catch (error) {
      if (error instanceof SandboxError && error.statusCode === 404) return false;
      throw error;
    }
  }

  async sendStdin(data: string | Uint8Array, _opts: CommandRequestOpts = {}): Promise<void> {
    if (!this.#stdin)
      throw new InvalidArgumentError(
        "The command was not started with stdin: true, so its input is closed.",
      );
    await guard("sandbox", () => this.#process.write(data));
  }

  async closeStdin(_opts: CommandRequestOpts = {}): Promise<void> {
    if (!this.#stdin)
      throw new InvalidArgumentError("The command was not started with stdin: true.");
    await guard("sandbox", () => this.#process.write("", { eof: true }));
  }
}
