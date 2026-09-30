import { randomUUID } from "node:crypto";
import type { Process as RuntimeProcess } from "../sandbox.js";
import {
  HOME,
  LONGEST_MS,
  quote,
  resolvePath,
  WHOLE_OUTPUT,
  type SandboxContext,
} from "./context.js";
import {
  DaytonaCommandAlreadyCompletedError,
  DaytonaConflictError,
  DaytonaConnectionError,
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
  constructor(ctx: SandboxContext) {
    this.#ctx = ctx;
  }

  #env(extra?: Record<string, string>) {
    const merged = { ...this.#ctx.env, ...extra };
    return Object.keys(merged).length ? { env: merged } : {};
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
    const result = await guard("sandbox", () =>
      runtime.exec(`{ ${command}\n} 2>&1`, {
        cwd: cwd === undefined ? HOME : resolvePath(cwd),
        ...this.#env(env),
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
    const result = await guard("sandbox", () =>
      runtime.exec(["sh", "-c", 'exec "$@" 2>&1', "sh", ...interpreter, ...(params.argv ?? [])], {
        cwd: HOME,
        ...this.#env(params.env),
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
    const process = await guard("sandbox", () =>
      runtime.spawn(["bash", "--noprofile", "--norc", "-s", `${TAG}${sessionId}`], {
        cwd: HOME,
        ...this.#env(),
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

  createPty(): Promise<never> {
    return pty();
  }
  connectPty(): Promise<never> {
    return pty();
  }
  listPtySessions(): Promise<never> {
    return pty();
  }
  getPtySessionInfo(): Promise<never> {
    return pty();
  }
  killPtySession(): Promise<never> {
    return pty();
  }
  resizePtySession(): Promise<never> {
    return pty();
  }
}

function describe(command: SessionCommand): Command {
  return {
    id: command.id,
    command: command.command,
    ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
  };
}

function pty(): Promise<never> {
  return Promise.reject(
    new NotSupportedError(
      "Daytona's PTY sessions",
      "Use `await sandbox.withruntime.terminal({ cols, rows, onData })` for an interactive terminal, or a session for commands.",
    ),
  );
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
