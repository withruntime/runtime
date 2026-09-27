import { CommandError, ConnectionError, NotFoundError, RuntimeError } from "./errors.js";
import { Page } from "./page.js";
import {
  type FileEvent,
  sandboxWatches,
  watchDirectory,
  type WatchHandle,
  type WatchOptions,
} from "./products/watch.js";
import type { Query, RequestOptions, Transport } from "./transport.js";
import type {
  CommandResult,
  ExecOptions,
  FileEntry,
  OutputEvent,
  KeepAliveOptions,
  ProcessInfo,
  SandboxInfo,
  SandboxSettings,
} from "./types.js";
import { sandboxFactories, type SandboxExtensions } from "./products/index.js";
import type { Snapshot, SnapshotOptions } from "./snapshots.js";
import { Tunnel, type PortForward } from "./tunnel.js";

const CHUNK = 1_048_576;
const PARALLEL = 4;
const enc = (id: string) => encodeURIComponent(id);
const toBase64 = (data: string | Uint8Array) =>
  (typeof data === "string" ? Buffer.from(data) : Buffer.from(data)).toString("base64");

function commandBody(command: string | readonly string[], options: ExecOptions) {
  return {
    ...(typeof command === "string" ? { command } : { argv: [...command] }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.stdin === undefined
      ? {}
      : typeof options.stdin === "string"
        ? { stdin: options.stdin }
        : { stdinBase64: toBase64(options.stdin) }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

/** A running (or stopped) sandbox. Every method is one API call or a short
 * sequence of them; `await using sbx = await Sandbox.create()` stops it for
 * you at the end of the block. */
// Declaration merging is how a product lane's sandbox methods (sbx.previews,
// sbx.network, ...) appear typed on every Sandbox: see products/index.ts.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type
export interface Sandbox extends SandboxExtensions {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Sandbox implements AsyncDisposable {
  #info: SandboxInfo;
  #keepAlive: (() => void) | undefined;
  readonly #t: Transport;
  readonly files: Files;
  readonly processes: Processes;
  constructor(transport: Transport, info: SandboxInfo) {
    this.#t = transport;
    this.#info = info;
    this.files = new Files(transport, info.id);
    this.processes = new Processes(transport, info.id);
    for (const [name, make] of sandboxFactories())
      Object.defineProperty(this, name, { value: make(transport, this), enumerable: false });
  }
  get id(): string {
    return this.#info.id;
  }
  /** What the API last said about this sandbox. `refresh()` asks again. */
  get info(): SandboxInfo {
    return this.#info;
  }
  get state(): SandboxInfo["state"] {
    return this.#info.state;
  }
  async refresh(options: RequestOptions = {}): Promise<this> {
    this.#info = await this.#t.json<SandboxInfo>({
      method: "GET",
      path: `/v1/sandboxes/${enc(this.id)}`,
      ...options,
    });
    return this;
  }
  /** Waits (server-side, no polling) until the sandbox reaches `state`. */
  async waitFor(
    state: "running" | "paused" | "stopped",
    options: { timeoutSeconds?: number } & RequestOptions = {},
  ) {
    this.#info = await this.#t.json<SandboxInfo>({
      method: "GET",
      path: `/v1/sandboxes/${enc(this.id)}`,
      query: { waitFor: state, timeoutSeconds: options.timeoutSeconds ?? 60 },
      ...options,
    });
    return this;
  }

  /** Runs a command and returns its exit code and output. A string runs under
   * `bash -c`; an array runs without a shell. With onStdout/onStderr the output
   * streams as it happens. A timeout is a result (timedOut: true, the output so
   * far), never an error; `check: true` throws CommandError on a non-zero exit. */
  async exec(
    command: string | readonly string[],
    options: ExecOptions = {},
  ): Promise<CommandResult> {
    const streaming = options.onStdout || options.onStderr || (options.timeoutMs ?? 0) > 60_000;
    let result: CommandResult;
    if (!streaming) {
      result = await this.#t.json<CommandResult>({
        method: "POST",
        path: `/v1/sandboxes/${enc(this.id)}:exec`,
        body: commandBody(command, options),
        ...pick(options),
      });
    } else {
      const out = { stdout: "", stderr: "" };
      let exit: Extract<OutputEvent, { type: "exit" }> | undefined;
      let processId: string | undefined;
      let dropped = false;
      try {
        for await (const event of this.execStream(command, options)) {
          if (event.type === "start") processId = event.processId;
          else if (event.type === "stdout" || event.type === "stderr") {
            out[event.type] += event.data;
            (event.type === "stdout" ? options.onStdout : options.onStderr)?.(event.data);
          } else if (event.type === "truncated") dropped = true;
          else if (event.type === "exit") exit = event;
        }
      } catch (error) {
        throw await this.#unfinished(error, processId, options.signal);
      }
      result = {
        exitCode: exit?.exitCode ?? null,
        ...out,
        timedOut: exit?.timedOut ?? false,
        ...truncation(dropped),
        ...(exit?.durationMs === undefined ? {} : { durationMs: exit.durationMs }),
        ...(processId ? { processId } : {}),
      };
    }
    if (options.check && (result.exitCode !== 0 || result.timedOut)) throw new CommandError(result);
    return result;
  }

  /** An exec that ended before its command did. Cancelled through `signal`,
   * its command is sent SIGTERM, as Ctrl-C would stop it at a terminal; cut
   * off, it is left running. Either way the error names the process, so the
   * caller can read or stop what is still there. */
  async #unfinished(
    error: unknown,
    processId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (!processId) return error;
    const id = `${this.id} ${processId}`;
    if (signal?.aborted) {
      const stopped = await new Process(this.#t, this.id, { id: processId } as ProcessInfo)
        .kill("SIGTERM")
        .then(
          () => true,
          () => false,
        );
      return new RuntimeError({
        message: stopped
          ? `Cancelled; process ${processId} was sent SIGTERM.`
          : `Cancelled, but process ${processId} may still be running: stopping it failed.`,
        code: "cancelled",
        status: 0,
        hint: stopped
          ? `See what it printed: runtime sandbox logs ${id}`
          : `Stop it: runtime sandbox kill ${id}, or sandbox.processes.get("${processId}") and kill().`,
        details: { sandboxId: this.id, processId, stopped },
        cause: error,
      });
    }
    if (error instanceof RuntimeError && !(error instanceof ConnectionError)) return error;
    return new ConnectionError({
      message: `Lost the output of process ${processId}; the command may still be running.`,
      code: "connection_error",
      status: 0,
      hint: `Follow it: runtime sandbox logs ${id} -f (sandbox.processes.get("${processId}")), or stop it: runtime sandbox kill ${id}.`,
      details: { sandboxId: this.id, processId },
      cause: error,
    });
  }

  /** The command's events as they happen: start, stdout, stderr, exit. Resumes
   * by itself when the server ends a long stream or the connection drops after
   * the command started, and yields `truncated` for any output it did not
   * receive, so lost output never passes as whole. */
  async *execStream(
    command: string | readonly string[],
    options: ExecOptions = {},
  ): AsyncGenerator<OutputEvent> {
    let processId: string | undefined;
    const read = new OutputCursor();
    const events = this.#t.events<OutputEvent>({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.id)}:exec`,
      body: { ...commandBody(command, { timeoutMs: 86_400_000, ...options }), stream: true },
      ...pick(options),
      timeoutMs: options.timeoutMs === undefined ? 86_400_000 : options.timeoutMs + 60_000,
    });
    try {
      for await (const event of events) {
        if (event.type === "start") processId = event.processId;
        if (event.type === "continue") {
          yield* this.processes.follow(event.processId, {
            cursor: event.cursor,
            signal: options.signal,
          });
          return;
        }
        yield* read.pass(event);
        if (event.type === "exit") return;
      }
    } catch (error) {
      if (options.signal?.aborted || !processId || !cutOff(error)) throw error;
    }
    // The connection closed after the command started: its output is kept on
    // the sandbox, so follow it from where this stream stopped.
    if (!processId)
      throw new ConnectionError({
        message: "The exec stream closed before the command started.",
        code: "connection_error",
        status: 0,
        hint: "Run it again; to be sure it runs once, pass the same idempotencyKey.",
      });
    yield* this.processes.follow(processId, { cursor: read.cursor, signal: options.signal });
  }

  /** Starts a background process (a server, a watcher, a REPL) and returns at
   * once. `stdin: "pipe"` keeps its input open for write(); `pty` gives it a
   * terminal. */
  async spawn(
    command: string | readonly string[],
    options: Omit<ExecOptions, "onStdout" | "onStderr" | "check" | "stdin"> & {
      /** "pipe" keeps input open for write(); any other text is given once, then closed. */
      stdin?: string;
      pty?: { cols?: number; rows?: number };
    } = {},
  ): Promise<Process> {
    const { stdin, pty, ...rest } = options;
    const info = await this.#t.json<ProcessInfo>({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.id)}/processes`,
      body: {
        ...commandBody(command, rest),
        ...(stdin === "pipe" ? { stdinMode: "pipe" } : stdin === undefined ? {} : { stdin }),
        ...(pty ? { pty } : {}),
      },
      ...pick(rest),
    });
    return new Process(this.#t, this.id, info);
  }

  /** An interactive terminal over a WebSocket. Bytes you write are typed;
   * onData receives what the terminal prints. */
  async terminal(
    options: {
      cols?: number;
      rows?: number;
      command?: string;
      cwd?: string;
      /** Attach to a process started with a pty instead of a new shell. */
      processId?: string;
      onData?: (data: Uint8Array) => void;
    } = {},
  ): Promise<Terminal> {
    const socket = await this.#t.websocket(`/v1/sandboxes/${enc(this.id)}/terminal`, {
      cols: options.cols,
      rows: options.rows,
      command: options.command,
      cwd: options.cwd,
      processId: options.processId,
    });
    return Terminal.open(socket, options.onData);
  }

  /** A tunnel into the sandbox: TCP connections to any port on its loopback,
   * and SSH logins, over one authenticated WebSocket. No port is opened to the
   * internet. `tunnel.connect(5432)` gives one connection;
   * `tunnel.forward(5432)` listens locally (Node and Bun). */
  async tunnel(): Promise<Tunnel> {
    return Tunnel.open(await this.#t.websocket(`/v1/sandboxes/${enc(this.id)}/tunnel`));
  }

  /** Listens on a local port (the same number unless `localPort` says, 0 for
   * any) and forwards each connection to `port` inside the sandbox, until
   * `close()`. Node and Bun. */
  async forwardPort(
    port: number,
    options: { localPort?: number; host?: string } = {},
  ): Promise<PortForward> {
    const tunnel = await this.tunnel();
    try {
      const forward = await tunnel.forward(port, options);
      return {
        ...forward,
        close: async () => {
          await forward.close();
          tunnel.close();
        },
      };
    } catch (error) {
      tunnel.close();
      throw error;
    }
  }

  async stop(options: RequestOptions & { wait?: boolean } = {}): Promise<this> {
    this.#keepAlive?.();
    return this.#lifecycle("stop", options);
  }
  async pause(options: RequestOptions & { wait?: boolean } = {}): Promise<this> {
    return this.#lifecycle("pause", options);
  }
  /** Carries on a paused sandbox; `timeoutSeconds` is its new lease. */
  async wake(
    options: RequestOptions & { wait?: boolean; timeoutSeconds?: number } = {},
  ): Promise<this> {
    const { timeoutSeconds, ...rest } = options;
    try {
      return await this.#lifecycle(
        "wake",
        rest,
        timeoutSeconds === undefined ? {} : { timeoutSeconds },
      );
    } catch (error) {
      // Waking one that is already awake is done, not a mistake. With a new
      // lease asked for, the refusal stands: it was not given.
      if (!(error instanceof RuntimeError) || error.code !== "not_paused" || timeoutSeconds)
        throw error;
      await this.refresh(pick(rest));
      if (this.state !== "running" && this.state !== "starting") throw error;
      return this;
    }
  }
  /** More time before the lease ends (at most an hour ahead of now). */
  async extend(seconds: number, options: RequestOptions = {}): Promise<this> {
    return this.#lifecycle("extend", { ...options, wait: false }, { seconds });
  }
  /** Changes its name, labels, automatic wake, idle pause or persistence;
   * fields left out stay as they are. `persistent: true` keeps it running
   * while credit lasts (paid only). */
  async update(settings: SandboxSettings, options: RequestOptions = {}): Promise<this> {
    return this.#lifecycle("update", { ...options, wait: false }, { ...settings });
  }
  /** Keeps a running sandbox's lease ahead of now, in the background, until
   * stop() or the returned function ends it: every `everySeconds` (60) it
   * extends the lease so that `marginSeconds` (600) remain, never more than
   * the hour ahead the API allows. Running time is billed as it is used, as
   * for any extension. A paused sandbox is left paused (a request wakes it,
   * unless autoWake is off); a stopped one ends the loop. It does not keep a
   * Node or Bun process alive by itself. */
  keepAlive(options: KeepAliveOptions = {}): () => void {
    this.#keepAlive?.();
    const every = Math.max(10, options.everySeconds ?? 60) * 1000;
    const margin = Math.min(3600, Math.max(60, options.marginSeconds ?? 600));
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      ended = true;
      if (timer) clearTimeout(timer);
      if (this.#keepAlive === end) this.#keepAlive = undefined;
    };
    const tick = async () => {
      if (ended) return;
      try {
        await this.refresh();
        if (this.state === "stopped" || this.state === "stopping") return end();
        if (this.state === "running") {
          const left = (Date.parse(this.info.expiresAt) - Date.now()) / 1000;
          const need = Math.ceil(margin - left);
          if (need >= 1) await this.extend(Math.min(3600, need));
        }
      } catch (error) {
        options.onError?.(error);
      }
      if (ended) return;
      timer = setTimeout(() => void tick(), every);
      (timer as { unref?: () => void }).unref?.();
    };
    this.#keepAlive = end;
    void tick();
    return end;
  }
  /** Days a paused sandbox is kept before deletion (1 to 365). */
  async setRetention(days: number, options: RequestOptions = {}): Promise<this> {
    return this.#lifecycle("retention", { ...options, wait: false }, { days });
  }
  /** Keeps this sandbox's whole machine (files, memory, running processes) as
   * a snapshot to start new sandboxes from. A running sandbox is paused for
   * the moment it takes, then woken; a paused one stays paused. */
  async snapshot(options: SnapshotOptions & RequestOptions = {}): Promise<Snapshot> {
    const { idempotencyKey, signal, timeoutMs, ...body } = options;
    await this.refresh();
    // Straight after a fork or a wake the sandbox is still `resuming`, and
    // after a pause still `pausing`: wait for where it is going, or a
    // snapshot of it is refused as not paused (user lane, 23 September 2026).
    if (this.state === "resuming" || this.state === "starting") await this.waitFor("running");
    else if (this.state === "pausing") await this.waitFor("paused");
    const running = this.state === "running";
    if (running) await this.pause();
    try {
      return await this.#t.json<Snapshot>({
        method: "POST",
        path: `/v1/sandboxes/${enc(this.id)}:snapshot`,
        body,
        wait: 10,
        ...pick({
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(signal ? { signal } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        }),
      });
    } finally {
      if (running) await this.wake();
    }
  }
  /** Copies of this sandbox as it is now (files, memory, running processes),
   * each its own sandbox, answered once they run. A running sandbox is paused
   * for the moment its snapshot takes, then woken. One without `count`; an
   * array with it. `funding` is what the copies run on, as for a create;
   * omitted, they keep this sandbox's. */
  fork(
    options?: {
      name?: string;
      labels?: Record<string, string>;
      keepSnapshot?: boolean;
      funding?: "trial" | "paid";
    } & RequestOptions,
  ): Promise<Sandbox>;
  fork(
    options: {
      count: number;
      name?: string;
      labels?: Record<string, string>;
      keepSnapshot?: boolean;
      funding?: "trial" | "paid";
    } & RequestOptions,
  ): Promise<Sandbox[]>;
  async fork(
    options: {
      count?: number;
      name?: string;
      labels?: Record<string, string>;
      keepSnapshot?: boolean;
      funding?: "trial" | "paid";
    } & RequestOptions = {},
  ): Promise<Sandbox | Sandbox[]> {
    const { idempotencyKey, signal, timeoutMs, ...body } = options;
    const reply = await this.#t.json<{ sandboxes: SandboxInfo[] }>({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.id)}:fork`,
      body,
      wait: 60,
      ...pick({
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(signal ? { signal } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
    });
    const sandboxes = reply.sandboxes.map((info) => new Sandbox(this.#t, info));
    return options.count === undefined ? sandboxes[0]! : sandboxes;
  }
  /** Starts a stopped persistent sandbox again from its disk (memory is not kept). */
  async restart(options: RequestOptions & { wait?: boolean } = {}): Promise<this> {
    return this.#lifecycle("restart", options);
  }
  async #lifecycle(
    verb: string,
    options: RequestOptions & { wait?: boolean },
    body: Record<string, unknown> = {},
  ): Promise<this> {
    this.#info = await this.#t.json<SandboxInfo>({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.id)}:${verb}`,
      body,
      wait: options.wait === false ? 0 : 60,
      ...pick(options),
    });
    return this;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    this.#keepAlive?.();
    if (this.#info.state === "stopped") return;
    await this.stop({ wait: false }).catch(() => undefined);
  }
  toJSON(): SandboxInfo {
    return this.#info;
  }
}

/** Where a reader of a process's output is, in bytes of stdout and stderr
 * together. Output it did not receive, named by the server or not, becomes a
 * `truncated` event: the next chunk starting past the cursor means the bytes
 * between were lost. A server error event becomes a thrown error. */
class OutputCursor {
  constructor(public cursor = 0) {}
  *pass(event: OutputEvent): Generator<OutputEvent> {
    if (event.type === "error")
      throw new RuntimeError({
        message: event.error.message,
        code: event.error.code,
        status: 0,
        ...(event.error.requestId ? { requestId: event.error.requestId } : {}),
      });
    if (event.type === "truncated") this.cursor = Math.max(this.cursor, event.resumeAt);
    if (event.type === "stdout" || event.type === "stderr") {
      if (event.offset > this.cursor)
        yield {
          type: "truncated",
          droppedBytes: event.offset - this.cursor,
          resumeAt: event.offset,
        };
      this.cursor = Math.max(this.cursor, event.offset + Buffer.byteLength(event.data));
    }
    yield event;
  }
}

/** A stream cut off by the network rather than refused by Runtime: worth
 * reconnecting to from the cursor. */
function cutOff(error: unknown): boolean {
  return !(error instanceof RuntimeError) || error instanceof ConnectionError;
}

/** A streamed command keeps all its output unless the reader fell more than the
 * process's output buffer behind, which the server marks with a "truncated"
 * event. That event does not say which stream lost bytes, so both flags carry
 * it; without one, both are false, as a synchronous result's are. */
function truncation(dropped: boolean) {
  return { stdoutTruncated: dropped, stderrTruncated: dropped };
}

function pick(options: RequestOptions): RequestOptions {
  return {
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs + 60_000 } : {}),
  };
}

export class Processes {
  constructor(
    private readonly t: Transport,
    private readonly sandboxId: string,
  ) {}
  async list(): Promise<ProcessInfo[]> {
    return (
      await this.t.json<{ data: ProcessInfo[] }>({
        method: "GET",
        path: `/v1/sandboxes/${enc(this.sandboxId)}/processes`,
      })
    ).data;
  }
  async get(processId: string): Promise<Process> {
    const info = await this.t.json<ProcessInfo>({
      method: "GET",
      path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(processId)}`,
    });
    return new Process(this.t, this.sandboxId, info);
  }
  /** Output events from `cursor` until the process exits, across stream slices. */
  async *follow(
    processId: string,
    options: { cursor?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<OutputEvent> {
    const read = new OutputCursor(options.cursor ?? 0);
    // Reconnections in a row that brought nothing: a stream that keeps
    // closing without output or an exit is given up, not followed forever.
    let idle = 0;
    for (;;) {
      const before = read.cursor;
      let resumed = false;
      try {
        for await (const event of this.t.events<OutputEvent>({
          method: "GET",
          path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(processId)}/output`,
          query: { cursor: read.cursor, follow: true },
          timeoutMs: 180_000,
          ...(options.signal ? { signal: options.signal } : {}),
        })) {
          if (event.type === "continue") {
            read.cursor = Math.max(read.cursor, event.cursor);
            resumed = true;
            break;
          }
          yield* read.pass(event);
          if (event.type === "exit") return;
        }
      } catch (error) {
        if (options.signal?.aborted || !cutOff(error)) throw error;
      }
      idle = resumed || read.cursor > before ? 0 : idle + 1;
      if (idle > 3)
        throw new ConnectionError({
          message: `The output stream of process ${processId} keeps closing before it ends.`,
          code: "connection_error",
          status: 0,
          hint: `Read what it printed so far: runtime sandbox logs ${this.sandboxId} ${processId}`,
          details: { sandboxId: this.sandboxId, processId },
        });
    }
  }
}

/** A background process: its output, its input, its end. */
export class Process {
  #inputOffset: number;
  constructor(
    private readonly t: Transport,
    readonly sandboxId: string,
    public info: ProcessInfo,
  ) {
    this.#inputOffset = info.stdinOffset ?? 0;
  }
  get id(): string {
    return this.info.id;
  }
  /** Every output event from the start (or `cursor`) until exit. */
  output(options: { cursor?: number; signal?: AbortSignal } = {}): AsyncGenerator<OutputEvent> {
    return new Processes(this.t, this.sandboxId).follow(this.id, options);
  }
  /** Waits for the process to end and returns its result. */
  async wait(options: { signal?: AbortSignal } = {}): Promise<CommandResult> {
    const out = { stdout: "", stderr: "" };
    let exit: Extract<OutputEvent, { type: "exit" }> | undefined;
    let dropped = false;
    for await (const event of this.output(options)) {
      if (event.type === "stdout" || event.type === "stderr") out[event.type] += event.data;
      if (event.type === "truncated") dropped = true;
      if (event.type === "exit") exit = event;
    }
    return {
      exitCode: exit?.exitCode ?? null,
      ...out,
      timedOut: exit?.timedOut ?? false,
      ...truncation(dropped),
      processId: this.id,
    };
  }
  /** Sends input. Offsets are tracked for you, so a retried write is never typed twice. */
  async write(data: string | Uint8Array, options: { eof?: boolean } = {}): Promise<void> {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    let sent = 0;
    do {
      const reply = await this.t.json<{ offset: number }>({
        method: "POST",
        path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(this.id)}:write`,
        body: {
          base64: bytes.subarray(sent).toString("base64"),
          offset: this.#inputOffset,
          ...(options.eof ? { eof: true } : {}),
        },
      });
      sent += reply.offset - this.#inputOffset;
      this.#inputOffset = reply.offset;
    } while (sent < bytes.length);
  }
  async kill(
    signal:
      "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" | "SIGQUIT" | "SIGUSR1" | "SIGUSR2" = "SIGTERM",
  ): Promise<void> {
    await this.t.json({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(this.id)}:signal`,
      body: { signal },
    });
  }
  async resize(cols: number, rows: number): Promise<void> {
    await this.t.json({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(this.id)}:resize`,
      body: { cols, rows },
    });
  }
  async refresh(): Promise<ProcessInfo> {
    this.info = await this.t.json<ProcessInfo>({
      method: "GET",
      path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(this.id)}`,
    });
    return this.info;
  }
}

export class Terminal {
  readonly exited: Promise<number | null>;
  #processId: string | undefined;
  private constructor(
    private readonly socket: WebSocket,
    exited: Promise<number | null>,
  ) {
    this.exited = exited;
  }
  get processId(): string | undefined {
    return this.#processId;
  }
  static open(socket: WebSocket, onData?: (data: Uint8Array) => void): Promise<Terminal> {
    socket.binaryType = "arraybuffer";
    let settle!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => (settle = resolve));
    let exitCode: number | null = null;
    return new Promise((resolve, reject) => {
      let terminal: Terminal | undefined;
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const message = JSON.parse(event.data) as {
            type: string;
            processId?: string;
            exitCode?: number | null;
            error?: { code: string; message: string };
          };
          if (message.type === "ready") {
            terminal = new Terminal(socket, exited);
            terminal.#processId = message.processId;
            resolve(terminal);
          } else if (message.type === "exit") exitCode = message.exitCode ?? null;
          else if (message.type === "error" && !terminal)
            reject(
              new RuntimeError({
                message: message.error?.message ?? "Terminal failed.",
                code: message.error?.code ?? "terminal_failed",
                status: 0,
              }),
            );
        } else onData?.(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onclose = () => {
        settle(exitCode);
        if (!terminal)
          reject(
            new RuntimeError({
              message:
                "The terminal could not be opened (check the key and that the sandbox is running).",
              code: "terminal_refused",
              status: 0,
            }),
          );
      };
      socket.onerror = () => undefined;
    });
  }
  write(data: string | Uint8Array): void {
    this.socket.send(typeof data === "string" ? new TextEncoder().encode(data) : data);
  }
  resize(cols: number, rows: number): void {
    this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }
  close(): void {
    this.socket.close(1000);
  }
}

/** Files in the sandbox. Paths are absolute; any path the sandbox user may use. */
export class Files {
  constructor(
    private readonly t: Transport,
    private readonly sandboxId: string,
  ) {}
  #path = (suffix: string) => `/v1/sandboxes/${enc(this.sandboxId)}${suffix}`;
  /** Watch a directory: `onEvent` gets create, write, remove, rename and
   * chmod events until `handle.stop()`. E2B's `watchDir`, plus filters,
   * batches, and a watch that loses nothing across a pause:
   *
   *   const watch = await sbx.files.watch("/workspace", (e) => console.log(e.type, e.path),
   *     { recursive: true, exclude: ["node_modules"] });
   *   ...
   *   await watch.stop();
   */
  watch(
    path: string,
    onEvent?: (event: FileEvent) => void | Promise<void>,
    options?: WatchOptions,
  ): Promise<WatchHandle> {
    return watchDirectory(this.t, this.sandboxId, path, onEvent, options);
  }
  /** The watches running in the sandbox, and polling reads by cursor. */
  get watches() {
    return sandboxWatches(this.t, this.sandboxId);
  }
  /** A file's bytes, any size, checked against the length (and for a small
   * file the SHA-256) the API sends first: a read that arrives short is read
   * again, then throws `download_incomplete`, never returns short. For a file
   * too big to hold in memory use `readStream` or `download`. */
  async read(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.t.fileBytes({
      method: "GET",
      path: this.#path("/files/content"),
      query: { path },
      accept: "application/octet-stream",
      ...options,
    });
  }
  /** A file's bytes as they arrive, for files of any size without holding
   * them in memory (Daytona's `downloadFileStream`). The stream errors with
   * `download_incomplete` if it ends short of the file's length.
   *
   *   const stream = await sbx.files.readStream("/workspace/big.tar");
   *   await stream.pipeTo(Writable.toWeb(fs.createWriteStream("big.tar")));
   */
  async readStream(
    path: string,
    options: RequestOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    return this.t.fileStream({
      method: "GET",
      path: this.#path("/files/content"),
      query: { path },
      accept: "application/octet-stream",
      ...options,
    });
  }
  async readText(path: string, options: RequestOptions = {}): Promise<string> {
    return new TextDecoder().decode(await this.read(path, options));
  }
  /** Writes a file, atomically, making parent directories. Under /workspace
   * any size, large ones in parallel 1 MiB chunks checked against their
   * SHA-256; elsewhere, with the sandbox user's rights, up to 1 MiB. `mode`
   * sets its permissions (0o755 for a program); 0o644 when left out. */
  async write(
    path: string,
    data: string | Uint8Array,
    writeOptions: RequestOptions & { mode?: number } = {},
  ): Promise<{ path: string; size: number }> {
    const { mode, ...options } = writeOptions;
    const octal = mode === undefined ? undefined : (mode & 0o777).toString(8).padStart(3, "0");
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length <= CHUNK) {
      // bytes(), not send(): the answer is read, so its connection is free
      // for the next call rather than held until garbage collection.
      await this.t.bytes({
        method: "PUT",
        path: this.#path("/files/content"),
        query: { path, ...(octal ? { mode: octal } : {}) },
        bytes,
        ...options,
      });
      return { path, size: bytes.length };
    }
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // A guest journals mutations across operations, not per URL. One logical
    // write therefore owns separate stable keys for each mutation phase.
    const uploadKey = options.idempotencyKey ?? crypto.randomUUID();
    const phaseOptions = (phase: string): RequestOptions => ({
      ...options,
      idempotencyKey: createHash("sha256")
        .update(JSON.stringify(["files.write", uploadKey, phase]))
        .digest("hex"),
    });
    type Upload = { uploadId: string; chunkBytes: number; mode?: string; replayed?: boolean };
    let begin: Upload;
    try {
      begin = await this.t.json<Upload>({
        method: "POST",
        path: this.#path("/uploads"),
        body: { path, size: bytes.length, sha256, ...(octal ? { mode: octal } : {}) },
        ...phaseOptions("begin"),
      });
    } catch (error) {
      if (!octal || !(error instanceof RuntimeError) || error.code !== "guest_upgrade_required")
        throw error;
      // The API aborted the unsupported transfer before accepting chunks.
      // A different body needs a different key; retain deterministic retries.
      begin = await this.t.json<Upload>({
        method: "POST",
        path: this.#path("/uploads"),
        body: { path, size: bytes.length, sha256 },
        ...phaseOptions("legacy-begin"),
      });
    }
    const commit = () =>
      this.t.json({
        method: "POST",
        path: this.#path(`/uploads/${enc(begin.uploadId)}:commit`),
        body: {},
        ...phaseOptions("commit"),
      });
    let committed = false;
    if (begin.replayed) {
      // A completed commit removed the transfer. Ask its journal before
      // resending chunks; an incomplete transfer alone is safe to continue.
      try {
        await commit();
        committed = true;
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== "upload_incomplete") throw error;
      }
    }
    const offsets: number[] = [];
    for (let offset = 0; offset < bytes.length; offset += begin.chunkBytes) offsets.push(offset);
    let next = 0;
    const worker = async () => {
      while (next < offsets.length) {
        const offset = offsets[next++]!;
        await this.t.bytes({
          method: "PUT",
          path: this.#path(`/uploads/${enc(begin.uploadId)}`),
          query: { offset },
          bytes: bytes.subarray(offset, offset + begin.chunkBytes),
        });
      }
    };
    try {
      if (!committed) {
        await Promise.all(Array.from({ length: Math.min(PARALLEL, offsets.length) }, worker));
        await commit();
      }
      // An older sandbox image ignores the mode in the upload; set it after.
      if (octal && begin.mode !== octal)
        await this.t.json({
          method: "POST",
          path: this.#path("/files:chmod"),
          body: { path, mode: octal },
          ...phaseOptions("chmod"),
        });
    } catch (error) {
      await this.t
        .json({
          method: "POST",
          path: this.#path(`/uploads/${enc(begin.uploadId)}:abort`),
          body: {},
          ...phaseOptions("abort"),
        })
        .catch(() => undefined);
      throw error;
    }
    return { path, size: bytes.length };
  }
  /** Directory entries; `depth` goes deeper, `glob` filters (e.g. "**\/*.py"). */
  async list(
    path = "/workspace",
    options: { depth?: number; glob?: string; hidden?: boolean; limit?: number } = {},
  ): Promise<FileEntry[]> {
    return (
      await this.t.json<{ data: FileEntry[] }>({
        method: "GET",
        path: this.#path("/files/list"),
        query: { path, ...options },
      })
    ).data;
  }
  async glob(pattern: string, root = "/workspace"): Promise<FileEntry[]> {
    return this.list(root, { glob: pattern });
  }
  async stat(
    path: string,
  ): Promise<(FileEntry & { exists: true }) | { exists: false; path: string }> {
    return this.t.json({ method: "GET", path: this.#path("/files/stat"), query: { path } });
  }
  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)).exists;
  }
  async mkdir(path: string, options: { parents?: boolean } = {}): Promise<void> {
    await this.t.json({
      method: "POST",
      path: this.#path("/files:mkdir"),
      body: { path, ...options },
    });
  }
  async remove(path: string, options: { recursive?: boolean } = {}): Promise<boolean> {
    return (
      await this.t.json<{ removed: boolean }>({
        method: "POST",
        path: this.#path("/files:remove"),
        body: { path, ...options },
      })
    ).removed;
  }
  async rename(from: string, to: string, options: { overwrite?: boolean } = {}): Promise<void> {
    await this.t.json({
      method: "POST",
      path: this.#path("/files:rename"),
      body: { from, to, ...options },
    });
  }
  /** Copies a local file or directory into the sandbox. A directory travels as
   * one gzipped tar and is unpacked in place. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const { stat, readFile } = await import("node:fs/promises");
    const info = await stat(localPath);
    if (info.isFile()) {
      // Its permissions travel with it: an uploaded script stays runnable.
      const data = await readFile(localPath);
      const mode = info.mode & 0o777;
      await this.write(remotePath, data, { mode }).catch(async (error: unknown) => {
        // A missing parent is made, as a directory upload makes its own.
        const parent = remotePath.slice(0, remotePath.lastIndexOf("/"));
        if (!(error instanceof NotFoundError) || !parent) throw error;
        await this.mkdir(parent, { parents: true });
        await this.write(remotePath, data, { mode });
      });
      return;
    }
    const { packDirectory } = await import("./tar.js");
    const archive = await packDirectory(localPath);
    // Large writes go only to /workspace (the server refuses others), so the
    // archive is staged there and removed after unpacking.
    const staging = `/workspace/.runtime-upload-${crypto.randomUUID()}.tar.gz`;
    await this.write(staging, archive);
    const result = await new Sandbox(this.t, { id: this.sandboxId } as SandboxInfo).exec([
      "sh",
      "-c",
      'mkdir -p "$1" && tar -xpzf "$2" -C "$1"; code=$?; rm -f "$2"; exit $code',
      "sh",
      remotePath,
      staging,
    ]);
    if (result.exitCode !== 0) throw new CommandError(result);
  }
  /** Streams a file to disk through a partial file beside the target, renamed
   * into place only once every byte has arrived: a failed copy never leaves
   * a short file under the name asked for. A short stream is tried again,
   * twice, as a short `read` is. */
  async #streamTo(remotePath: string, localPath: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const partial = `${localPath}.runtime-partial-${crypto.randomUUID().slice(0, 8)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = await this.readStream(remotePath);
        // The handle is closed before anything else touches the file, so a
        // failed copy's partial file is really gone when the error returns.
        const file = await fs.open(partial, "w");
        try {
          for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
            await file.write(chunk);
        } finally {
          await file.close();
        }
        await fs.rename(partial, localPath);
        return;
      } catch (error) {
        await fs.rm(partial, { force: true });
        if (
          attempt >= 2 ||
          !(error instanceof RuntimeError) ||
          error.code !== "download_incomplete"
        )
          throw error;
      }
    }
  }
  /** Copies a file or directory out of the sandbox. A file streams to disk,
   * any size, checked against its length. */
  async download(remotePath: string, localPath: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const paths = await import("node:path");
    const entry = await this.stat(remotePath);
    if (!entry.exists)
      throw new RuntimeError({
        message: `${remotePath} does not exist.`,
        code: "file_not_found",
        status: 404,
      });
    if (entry.type !== "directory") {
      await fs.mkdir(paths.dirname(localPath), { recursive: true });
      await this.#streamTo(remotePath, localPath);
      return;
    }
    const staging = `/tmp/.runtime-download-${crypto.randomUUID()}.tar.gz`;
    const sandbox = new Sandbox(this.t, { id: this.sandboxId } as SandboxInfo);
    const packed = await sandbox.exec(["tar", "-czf", staging, "-C", remotePath, "."]);
    if (packed.exitCode !== 0) throw new CommandError(packed);
    try {
      const { unpackArchive } = await import("./tar.js");
      await unpackArchive(await this.read(staging), localPath);
    } finally {
      await this.remove(staging).catch(() => undefined);
    }
  }
}

export function sandboxPage(
  t: Transport,
  body: { data: SandboxInfo[]; nextCursor: string | null },
  query: Record<string, unknown>,
): Page<Sandbox> {
  return new Page(
    body.data.map((info) => new Sandbox(t, info)),
    body.nextCursor,
    async (cursor) =>
      sandboxPage(
        t,
        await t.json({
          method: "GET",
          path: "/v1/sandboxes",
          query: Object.assign({}, query, { cursor }) as Query,
        }),
        query,
      ),
  );
}
