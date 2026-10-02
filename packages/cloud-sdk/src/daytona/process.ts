import { randomUUID } from "node:crypto";
import type { Process as RuntimeProcess, Terminal } from "../sandbox.js";
import type { ProcessInfo } from "../types.js";
import {
  HOME,
  LONGEST_MS,
  quote,
  resolvePath,
  runAs,
  WHOLE_OUTPUT,
  type SandboxContext,
} from "./context.js";
import {
  DaytonaCommandAlreadyCompletedError,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaProcessExecutionTimeoutError,
  DaytonaSessionEndedError,
  guard,
  NotSupportedError,
} from "./errors.js";

/** Daytona's ExecuteResponse. `result` is the command's stdout and stderr
 * together, in the order they were written. */
export interface ExecuteResponse {
  exitCode: number;
  result: string;
  artifacts?: { stdout: string; charts?: unknown[] };
}
export class CodeRunParams {
  argv?: string[];
  env?: Record<string, string>;
}
export interface SessionExecuteRequest {
  command: string;
  runAsync?: boolean;
  /** @deprecated Daytona's older name for runAsync. */
  async?: boolean;
  suppressInputEcho?: boolean;
}
export interface SessionExecuteResponse {
  cmdId?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}
export interface SessionCommandLogsResponse {
  output?: string;
  stdout?: string;
  stderr?: string;
}
export interface Command {
  id: string;
  command: string;
  exitCode?: number;
}
export interface Session {
  sessionId: string;
  commands: Command[];
}

const MARK = "\x1e";
/* Each session command is one line to the session's bash, which bash reads
   whole before running it, so input sent later reaches the command, not bash.
   The command travels base64-encoded and runs through eval, keeping the
   shell's directory, variables and functions from one command to the next;
   the markers say where its output ends and what it exited with. */
const PRELUDE =
  '__rt_eval() { eval "$(printf %s "$1" | base64 -d)"; }; __rt_run() { __rt_eval "$1"; __rt_c=$?; ' +
  'printf \'\\036RT%s:%s\\036\' "$2" "$__rt_c"; printf \'\\036RT%s\\036\' "$2" >&2; return $__rt_c; }\n';
const TAG = "daytona-session:";

type Listener = { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void };

class SessionCommand implements Command {
  exitCode?: number;
  stdout = "";
  stderr = "";
  output = "";
  done: Promise<void> = Promise.resolve();
  /** Settles once the command's line has reached the session's shell: input
   * sent before then would be read by the shell, not the command. */
  written: Promise<void> = Promise.resolve();
  readonly listeners = new Set<Listener>();
  constructor(
    readonly id: string,
    readonly command: string,
  ) {}
  emit(stream: "stdout" | "stderr", text: string) {
    if (!text) return;
    this[stream] += text;
    this.output += text;
    for (const listener of this.listeners)
      (stream === "stdout" ? listener.onStdout : listener.onStderr)(text);
  }
}

class ShellSession {
  readonly commands: SessionCommand[] = [];
  tail: Promise<void> = Promise.resolve();
  ended = false;
  constructor(
    readonly id: string,
    readonly process: RuntimeProcess,
    public cursor: number,
  ) {}
}

/** `sandbox.process`: Daytona's commands, code runs and sessions over
 * Runtime's exec and processes. */
export class Process {
  readonly #ctx: SandboxContext;
  readonly #sessions = new Map<string, ShellSession>();
  /** What only this client knows of its PTY sessions: envs and size. */
  readonly #ptys = new Map<string, { envs: Record<string, string>; cols: number; rows: number }>();
  constructor(ctx: SandboxContext) {
    this.#ctx = ctx;
  }

  #env(extra?: Record<string, string>) {
    const merged = { ...this.#ctx.env, ...extra };
    return Object.keys(merged).length ? { env: merged } : {};
  }

  /** A command and its environment option as Runtime runs them: as given
   * for the sandbox owner, through sudo for create's `user`. */
  #as(
    command: string | string[],
    extra?: Record<string, string>,
  ): [string | string[], { env?: Record<string, string> }] {
    const user = this.#ctx.user;
    if (!user) return [command, this.#env(extra)];
    const argv = typeof command === "string" ? ["bash", "-c", command] : command;
    return [runAs(user, argv, { ...this.#ctx.env, ...extra }).argv, {}];
  }

  /** Runs a shell command and resolves with its exit code and output. A
   * non-zero exit is a result, not an error. `timeout` is in seconds; past
   * it the command is killed and DaytonaProcessExecutionTimeoutError is
   * thrown. */
  async executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<ExecuteResponse> {
    await this.#ctx.ensureHome(`${command}\n${cwd ?? ""}`);
    const runtime = await this.#ctx.live();
    const timeoutMs = timeout ? timeout * 1000 : LONGEST_MS;
    const [run, environment] = this.#as(`{ ${command}\n} 2>&1`, env);
    const result = await guard("sandbox", () =>
      runtime.exec(run, {
        cwd: cwd === undefined ? HOME : resolvePath(cwd),
        ...environment,
        timeoutMs,
        ...WHOLE_OUTPUT,
      }),
    );
    if (result.stdoutTruncated || result.stderrTruncated)
      throw new DaytonaConnectionError(
        "Some command output is no longer available.",
        502,
        undefined,
        "output_truncated",
      );
    if (result.timedOut)
      throw new DaytonaProcessExecutionTimeoutError(
        `Command timed out after ${timeout} s. Pass a larger timeout, or 0 for none.`,
        408,
      );
    const output = result.stdout + result.stderr;
    return { exitCode: result.exitCode ?? -1, result: output, artifacts: { stdout: output } };
  }

  /** Runs code in the sandbox's language (python by default, or javascript or
   * typescript as given at create) as a fresh process. `artifacts.charts` is
   * always empty on Runtime. */
  async codeRun(
    code: string,
    params: CodeRunParams = {},
    timeout?: number,
  ): Promise<ExecuteResponse> {
    const runtime = await this.#ctx.live();
    const interpreter =
      this.#ctx.language === "python"
        ? ["python3", "-c", code]
        : this.#ctx.language === "typescript"
          ? ["bun", "-e", code]
          : ["node", "-e", code];
    const timeoutMs = timeout ? timeout * 1000 : LONGEST_MS;
    const [run, environment] = this.#as(
      ["sh", "-c", 'exec "$@" 2>&1', "sh", ...interpreter, ...(params.argv ?? [])],
      params.env,
    );
    const result = await guard("sandbox", () =>
      runtime.exec(run, {
        cwd: HOME,
        ...environment,
        timeoutMs,
        ...WHOLE_OUTPUT,
      }),
    );
    if (result.stdoutTruncated || result.stderrTruncated)
      throw new DaytonaConnectionError(
        "Some command output is no longer available.",
        502,
        undefined,
        "output_truncated",
      );
    if (result.timedOut)
      throw new DaytonaProcessExecutionTimeoutError(`Code run timed out after ${timeout} s.`, 408);
    return {
      exitCode: result.exitCode ?? -1,
      result: result.stdout,
      artifacts: { stdout: result.stdout, charts: [] },
    };
  }

  // ---- sessions ----------------------------------------------------------

  /** Starts a session: a bash that keeps its directory and variables from
   * one command to the next. Runs one command at a time; a command sent while
   * another runs waits for it, as it would typed into a shell. */
  async createSession(sessionId: string): Promise<void> {
    if (this.#sessions.has(sessionId) || (await this.#discover(sessionId)))
      throw new DaytonaConflictError(`Session ${sessionId} already exists.`, 409);
    const runtime = await this.#ctx.live();
    const [run, environment] = this.#as([
      "bash",
      "--noprofile",
      "--norc",
      "-s",
      `${TAG}${sessionId}`,
    ]);
    const process = await guard("sandbox", () =>
      runtime.spawn(run, {
        cwd: HOME,
        ...environment,
        stdin: "pipe",
        timeoutMs: LONGEST_MS,
      }),
    );
    await guard("process", () => process.write(PRELUDE));
    this.#sessions.set(sessionId, new ShellSession(sessionId, process, 0));
  }

  /** A session made by another client (another Daytona object on this
   * sandbox): found by its tag among the running processes. Its output from
   * now on is followed; earlier commands are not known here. */
  async #discover(sessionId: string): Promise<ShellSession | undefined> {
    const runtime = await this.#ctx.live();
    const list = await guard("sandbox", () => runtime.processes.list());
    const info = list.find(
      (one) => one.state === "running" && one.command.split(" ").includes(`${TAG}${sessionId}`),
    );
    if (!info) return undefined;
    const process = await guard("process", () => runtime.processes.get(info.id));
    const session = new ShellSession(sessionId, process, info.outputBytes);
    this.#sessions.set(sessionId, session);
    return session;
  }

  async #session(sessionId: string): Promise<ShellSession> {
    const session = this.#sessions.get(sessionId) ?? (await this.#discover(sessionId));
    if (!session) throw new DaytonaNotFoundError(`Session ${sessionId} was not found.`, 404);
    if (session.ended) throw new DaytonaSessionEndedError(`Session ${sessionId} has ended.`, 410);
    return session;
  }

  #command(session: ShellSession, commandId: string): SessionCommand {
    const found = session.commands.find((one) => one.id === commandId);
    if (!found)
      throw new DaytonaNotFoundError(
        `Command ${commandId} was not found in session ${session.id} (commands run from another client are not known here).`,
        404,
      );
    return found;
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = await this.#session(sessionId);
    return { sessionId, commands: session.commands.map(describe) };
  }

  async getSessionCommand(sessionId: string, commandId: string): Promise<Command> {
    return describe(this.#command(await this.#session(sessionId), commandId));
  }

  /** Runs a command in the session. It waits and returns the output and exit
   * code, or with `runAsync: true` returns the cmdId at once. */
  async executeSessionCommand(
    sessionId: string,
    req: SessionExecuteRequest,
    timeout?: number,
  ): Promise<SessionExecuteResponse> {
    const session = await this.#session(sessionId);
    await this.#ctx.ensureHome(req.command);
    await this.#ctx.live();
    const command = new SessionCommand(randomUUID(), req.command);
    session.commands.push(command);
    const previous = session.tail;
    let release!: () => void;
    session.tail = new Promise((resolve) => (release = resolve));
    let sent!: () => void;
    command.written = new Promise((resolve) => (sent = resolve));
    command.done = (async () => {
      try {
        await previous;
        if (session.ended)
          throw new DaytonaSessionEndedError(`Session ${sessionId} has ended.`, 410);
        const encoded = Buffer.from(req.command).toString("base64");
        await guard("process", () => session.process.write(`__rt_run ${encoded} ${command.id}\n`));
        sent();
        await this.#follow(session, command);
      } finally {
        sent();
        release();
      }
    })();
    if (req.runAsync || req.async) {
      command.done.catch(() => undefined);
      return { cmdId: command.id };
    }
    if (timeout && timeout > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          command.done,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new DaytonaProcessExecutionTimeoutError(
                    `Waiting for session command timed out after ${timeout} s. The command continues in the session.`,
                    408,
                  ),
                ),
              timeout * 1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } else await command.done;
    return {
      cmdId: command.id,
      output: command.output,
      stdout: command.stdout,
      stderr: command.stderr,
      ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
    };
  }

  async #follow(session: ShellSession, command: SessionCommand) {
    const outMark = `${MARK}RT${command.id}:`;
    const errMark = `${MARK}RT${command.id}${MARK}`;
    const buffer = { stdout: "", stderr: "" };
    const sent = { stdout: 0, stderr: 0 };
    let outDone = false;
    let errDone = false;
    // Sends what is certainly the command's: everything before a marker, or
    // before a marker's first byte that may still be arriving.
    const flush = (stream: "stdout" | "stderr", end: number) => {
      command.emit(stream, buffer[stream].slice(sent[stream], end));
      sent[stream] = Math.max(sent[stream], end);
    };
    await guard("process", async () => {
      for await (const event of session.process.output({ cursor: session.cursor })) {
        if (event.type === "truncated") {
          session.ended = true;
          throw new DaytonaConnectionError(
            "Session command output was lost.",
            502,
            undefined,
            "output_truncated",
          );
        }
        if (event.type === "exit") {
          session.ended = true;
          flush("stdout", buffer.stdout.length);
          flush("stderr", buffer.stderr.length);
          command.exitCode = event.exitCode ?? -1;
          return;
        }
        if (event.type !== "stdout" && event.type !== "stderr") continue;
        session.cursor = event.offset + Buffer.byteLength(event.data);
        buffer[event.type] += event.data;
        if (event.type === "stdout" && !outDone) {
          const at = buffer.stdout.indexOf(outMark);
          const end = at < 0 ? -1 : buffer.stdout.indexOf(MARK, at + outMark.length);
          if (end >= 0) {
            flush("stdout", at);
            command.exitCode = Number(buffer.stdout.slice(at + outMark.length, end));
            outDone = true;
          } else {
            const pending = buffer.stdout.lastIndexOf(MARK);
            flush("stdout", pending < 0 ? buffer.stdout.length : pending);
          }
        }
        if (event.type === "stderr" && !errDone) {
          const at = buffer.stderr.indexOf(errMark);
          if (at >= 0) {
            flush("stderr", at);
            errDone = true;
          } else {
            const pending = buffer.stderr.lastIndexOf(MARK);
            flush("stderr", pending < 0 ? buffer.stderr.length : pending);
          }
        }
        if (outDone && errDone) return;
      }
      session.ended = true;
    });
  }

  /** A command's output so far, or with callbacks, its output from the start
   * as it happens until it ends. */
  getSessionCommandLogs(sessionId: string, commandId: string): Promise<SessionCommandLogsResponse>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void>;
  async getSessionCommandLogs(
    sessionId: string,
    commandId: string,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<SessionCommandLogsResponse | void> {
    const command = this.#command(await this.#session(sessionId), commandId);
    if (!onStdout && !onStderr)
      return { output: command.output, stdout: command.stdout, stderr: command.stderr };
    const listener = {
      onStdout: onStdout ?? (() => undefined),
      onStderr: onStderr ?? (() => undefined),
    };
    if (command.stdout) listener.onStdout(command.stdout);
    if (command.stderr) listener.onStderr(command.stderr);
    command.listeners.add(listener);
    try {
      await command.done;
    } finally {
      command.listeners.delete(listener);
    }
  }

  /** Types `data` into the session, where the running command reads it. */
  async sendSessionCommandInput(sessionId: string, commandId: string, data: string): Promise<void> {
    const session = await this.#session(sessionId);
    const command = this.#command(session, commandId);
    await command.written;
    if (command.exitCode !== undefined)
      throw new DaytonaCommandAlreadyCompletedError(
        `Command ${commandId} has already completed.`,
        410,
      );
    await guard("process", () => session.process.write(data));
  }

  /** Sessions this object made or found. */
  async listSessions(): Promise<Session[]> {
    return [...this.#sessions.values()]
      .filter((one) => !one.ended)
      .map((one) => ({ sessionId: one.id, commands: one.commands.map(describe) }));
  }

  /** Ends the session's shell and everything it runs. */
  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.#session(sessionId);
    session.ended = true;
    this.#sessions.delete(sessionId);
    await guard("process", () => session.process.kill("SIGKILL"));
  }

  getEntrypointSession(): Promise<never> {
    return entrypoint();
  }
  getEntrypointLogs(): Promise<never> {
    return entrypoint();
  }

  // ---- terminals ---------------------------------------------------------

  /** Starts an interactive shell on a terminal (a PTY) that outlives this
   * connection: disconnect() leaves it running, connectPty(id) attaches
   * again, killPtySession(id) ends it. On Runtime it is a process started
   * with a terminal, found again by its id among the sandbox's processes. */
  async createPty(options: PtyCreateOptions & Partial<PtyConnectOptions>): Promise<PtyHandle> {
    const id = options?.id;
    if (!id) throw new DaytonaError("A PTY session needs an id.", 400);
    if (await this.#findPty(id))
      throw new DaytonaConflictError(`PTY session ${id} already exists.`, 409);
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    await this.#ctx.ensureHome(options.cwd);
    const cwd = options.cwd === undefined ? HOME : resolvePath(options.cwd);
    const envs = { ...options.envs };
    const runtime = await this.#ctx.live();
    const [run, environment] = this.#as(["bash", "-l", "-i", "-s", ptyTag(id), `${cols}x${rows}`], {
      TERM: "xterm-256color",
      ...envs,
    });
    const process = await guard("sandbox", () =>
      runtime.spawn(run, { cwd, ...environment, pty: { cols, rows }, timeoutMs: LONGEST_MS }),
    );
    this.#ptys.set(id, { envs, cols, rows });
    try {
      return await this.#attach(id, process.id, options.onData);
    } catch (error) {
      await process.kill("SIGKILL").catch(() => undefined);
      throw error;
    }
  }

  /** Attaches to a running PTY session. Output it printed before arrives
   * first, then what it prints from now on. */
  async connectPty(sessionId: string, options?: Partial<PtyConnectOptions>): Promise<PtyHandle> {
    const found = await this.#findPty(sessionId);
    if (!found) throw new DaytonaNotFoundError(`PTY session ${sessionId} was not found.`, 404);
    return this.#attach(sessionId, found.id, options?.onData);
  }

  async listPtySessions(): Promise<PtySessionInfo[]> {
    const latest = new Map<string, ProcessInfo>();
    for (const info of await this.#ptyProcesses()) latest.set(ptyOf(info.command)!.id, info);
    return [...latest.values()].map((info) => this.#ptyInfo(info));
  }

  async getPtySessionInfo(sessionId: string): Promise<PtySessionInfo> {
    const found = (await this.#ptyProcesses())
      .filter((info) => ptyOf(info.command)!.id === sessionId)
      .at(-1);
    if (!found) throw new DaytonaNotFoundError(`PTY session ${sessionId} was not found.`, 404);
    return this.#ptyInfo(found);
  }

  /** Ends the session's shell and everything it runs. */
  async killPtySession(sessionId: string): Promise<void> {
    const process = await this.#ptyProcess(sessionId);
    await guard("process", () => process.kill("SIGKILL"));
  }

  async resizePtySession(sessionId: string, cols: number, rows: number): Promise<PtySessionInfo> {
    const process = await this.#ptyProcess(sessionId);
    await guard("process", () => process.resize(cols, rows));
    const known = this.#ptys.get(sessionId);
    this.#ptys.set(sessionId, { envs: known?.envs ?? {}, cols, rows });
    return this.#ptyInfo({ ...process.info, state: "running" });
  }

  /** Terminal processes this adapter started, a killed one gone as on
   * Daytona; an exited one stays, inactive. */
  async #ptyProcesses(): Promise<ProcessInfo[]> {
    const runtime = await this.#ctx.live();
    const list = await guard("sandbox", () => runtime.processes.list());
    return list.filter((info) => info.state !== "killed" && ptyOf(info.command));
  }

  async #findPty(sessionId: string): Promise<ProcessInfo | undefined> {
    return (await this.#ptyProcesses()).find(
      (info) => info.state === "running" && ptyOf(info.command)!.id === sessionId,
    );
  }

  async #ptyProcess(sessionId: string): Promise<RuntimeProcess> {
    const found = await this.#findPty(sessionId);
    if (!found) throw new DaytonaNotFoundError(`PTY session ${sessionId} was not found.`, 404);
    const runtime = await this.#ctx.live();
    return guard("process", () => runtime.processes.get(found.id));
  }

  #ptyInfo(info: ProcessInfo): PtySessionInfo {
    const tag = ptyOf(info.command)!;
    const known = this.#ptys.get(tag.id);
    return {
      active: info.state === "running",
      cols: known?.cols ?? tag.cols,
      createdAt: info.startedAt,
      cwd: info.cwd,
      envs: { ...known?.envs },
      id: tag.id,
      lazyStart: false,
      rows: known?.rows ?? tag.rows,
    };
  }

  async #attach(
    sessionId: string,
    processId: string,
    onData: PtyConnectOptions["onData"] | undefined,
  ): Promise<PtyHandle> {
    const runtime = await this.#ctx.live();
    const terminal = await guard("sandbox", () =>
      runtime.terminal({
        processId,
        ...(onData
          ? {
              onData: (data: Uint8Array) =>
                void Promise.resolve()
                  .then(() => onData(data))
                  .catch(() => undefined),
            }
          : {}),
      }),
    );
    return new PtyHandle(
      terminal,
      sessionId,
      (cols, rows) => this.resizePtySession(sessionId, cols, rows),
      () => this.killPtySession(sessionId),
    );
  }
}

/** Daytona's PtyCreateOptions. */
export interface PtyCreateOptions {
  id: string;
  cwd?: string;
  envs?: Record<string, string>;
  cols?: number;
  rows?: number;
}
/** Daytona's PtyConnectOptions. */
export interface PtyConnectOptions {
  onData: (data: Uint8Array) => void | Promise<void>;
}
/** Daytona's PtyResult. */
export interface PtyResult {
  exitCode?: number;
  error?: string;
}
/** Daytona's PtySessionInfo. */
export interface PtySessionInfo {
  active: boolean;
  cols: number;
  createdAt: string;
  cwd: string;
  envs: Record<string, string>;
  id: string;
  lazyStart: boolean;
  rows: number;
}

/** One connection to a PTY session, Daytona's PtyHandle over Runtime's
 * terminal WebSocket. */
export class PtyHandle {
  readonly sessionId: string;
  readonly #terminal: Terminal;
  readonly #resize: (cols: number, rows: number) => Promise<PtySessionInfo>;
  readonly #kill: () => Promise<void>;
  readonly #result: Promise<PtyResult>;
  #connected = true;
  #disconnected = false;
  #exitCode: number | undefined;
  #error: string | undefined;

  /** Use process.createPty or process.connectPty. */
  constructor(
    terminal: Terminal,
    sessionId: string,
    resize: (cols: number, rows: number) => Promise<PtySessionInfo>,
    kill: () => Promise<void>,
  ) {
    this.sessionId = sessionId;
    this.#terminal = terminal;
    this.#resize = resize;
    this.#kill = kill;
    this.#result = terminal.exited.then((code) => {
      this.#connected = false;
      if (code !== null) this.#exitCode = code;
      else
        this.#error = this.#disconnected
          ? "Disconnected; the PTY session keeps running. connectPty() attaches again."
          : "The PTY session was ended by a signal.";
      return {
        ...(this.#exitCode === undefined ? {} : { exitCode: this.#exitCode }),
        ...(this.#error === undefined ? {} : { error: this.#error }),
      };
    });
  }

  get exitCode(): number | undefined {
    return this.#exitCode;
  }
  get error(): string | undefined {
    return this.#error;
  }
  isConnected(): boolean {
    return this.#connected;
  }
  /** Resolves at once: the handle is returned connected. */
  async waitForConnection(): Promise<void> {
    if (!this.#connected && this.#exitCode === undefined)
      throw new DaytonaConnectionError(this.#error ?? "Connection closed");
  }
  async sendInput(data: string | Uint8Array): Promise<void> {
    if (!this.#connected) throw new DaytonaConnectionError("PTY is not connected");
    try {
      this.#terminal.write(data);
    } catch (error) {
      throw new DaytonaConnectionError(
        `Failed to send input to PTY: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  resize(cols: number, rows: number): Promise<PtySessionInfo> {
    return this.#resize(cols, rows);
  }
  /** Closes this connection; the session keeps running. */
  async disconnect(): Promise<void> {
    if (!this.#connected) return;
    this.#disconnected = true;
    this.#terminal.close();
  }
  /** Resolves when the session ends (or this connection closes) with its
   * exit code, or `error` saying why there is none. */
  wait(): Promise<PtyResult> {
    return this.#result;
  }
  kill(): Promise<void> {
    return this.#kill();
  }
}

const PTY_TAG = "daytona-pty:";
/** A session id as one word of the shell's command line, found again by
 * listPtySessions in any client. */
function ptyTag(id: string): string {
  return PTY_TAG + Buffer.from(id).toString("base64url");
}
function ptyOf(command: string): { id: string; cols: number; rows: number } | undefined {
  const words = String(command).split(" ");
  const at = words.findIndex((word) => word.startsWith(PTY_TAG));
  if (at < 0) return undefined;
  const size = /^(\d+)x(\d+)$/.exec(words[at + 1] ?? "");
  return {
    id: Buffer.from(words[at]!.slice(PTY_TAG.length), "base64url").toString(),
    cols: Number(size?.[1] ?? 80),
    rows: Number(size?.[2] ?? 24),
  };
}

function describe(command: SessionCommand): Command {
  return {
    id: command.id,
    command: command.command,
    ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
  };
}

function entrypoint(): Promise<never> {
  return Promise.reject(
    new NotSupportedError(
      "The image entrypoint session",
      "A Runtime image does not run an entrypoint; start it with process.createSession and executeSessionCommand.",
    ),
  );
}

export { quote };
