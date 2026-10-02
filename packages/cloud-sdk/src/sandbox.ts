import {
  KEEP_ALIVE_MARGIN_SECONDS,
  STREAMED_EXEC_TIMEOUT_MS,
  WAIT_FOR_TIMEOUT_SECONDS,
} from "./api-defaults.js";
import { CommandError, ConnectionError, NotFoundError, RuntimeError } from "./errors.js";
import { Page } from "./page.js";
import {
  type FileEvent,
  sandboxWatches,
  watchDirectory,
  type WatchHandle,
  type WatchOptions,
} from "./products/watch.js";
import { Transport, type Query, type RequestOptions } from "./transport.js";
import type {
  CommandResult,
  DeletedSandbox,
  ExecOptions,
  FileEntry,
  OutputEvent,
  BinaryOutputEvent,
  KeepAliveOptions,
  ProcessInfo,
  SandboxInfo,
  SandboxSettings,
} from "./types.js";
import { sandboxFactories, type SandboxExtensions } from "./products/index.js";
import type { Snapshot, SnapshotOptions } from "./snapshots.js";
import { Tunnel, type PortForward } from "./tunnel.js";
import type { StreamUploadSource } from "./file-source.js";

const CHUNK = 1_048_576;
/** Chunks of a large write in flight at once. Each chunk's reply waits on the
 * API and the guest, and the link idles while every chunk in flight waits:
 * from a home link (12.6 MB/s up, 27 September 2026) 100 MB took 17-18 s at
 * four and 11 s at eight, and sixteen was no faster. The guest takes 128
 * connections at once. */
const PARALLEL = 8;
const enc = (id: string) => encodeURIComponent(id);

/** One explicit deadline across a composed operation and its queue/retries. */
function requestScope(options: RequestOptions) {
  const deadline =
    options.timeoutMs === undefined || options.timeoutMs === 0
      ? undefined
      : AbortSignal.timeout(options.timeoutMs);
  const signal =
    deadline && options.signal
      ? AbortSignal.any([deadline, options.signal])
      : (deadline ?? options.signal);
  const request = {
    ...options,
    ...(deadline ? { timeoutMs: 0 } : {}),
    ...(signal ? { signal } : {}),
  };
  const cancelled = () =>
    new ConnectionError({
      message: "The call was cancelled or ran past its deadline.",
      code: "timeout",
      status: 0,
      cause: signal?.reason,
    });
  const check = () => {
    if (signal?.aborted) throw cancelled();
  };
  const wait = <T>(pending: Promise<T>): Promise<T> => {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(cancelled());
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
        },
      );
    });
  };
  return { request, check, wait };
}

/** DELETE /v1/sandboxes/{id}, for `sandbox.delete()` and
 * `runtime.sandboxes.delete(id)`. */
export function deleteSandbox(
  t: Transport,
  id: string,
  options: RequestOptions = {},
): Promise<DeletedSandbox> {
  return t.json<DeletedSandbox>({
    method: "DELETE",
    path: `/v1/sandboxes/${enc(id)}`,
    ...options,
  });
}
/* Web APIs only, so the sandbox's commands, processes and files work in a
   browser with a session token (Sandbox.fromSession): no Buffer, no
   node:crypto. */
const utf8 = (data: string | Uint8Array) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
const toBase64 = (data: string | Uint8Array) => base64(utf8(data));
async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(data) as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  /** Short-lived tokens that let a browser reach this sandbox directly. */
  readonly sessions: SandboxSessions;
  constructor(transport: Transport, info: SandboxInfo) {
    this.#t = transport;
    this.#info = info;
    this.files = new Files(transport, info.id);
    this.processes = new Processes(transport, info.id);
    this.sessions = new SandboxSessions(transport, info.id);
    for (const [name, make] of sandboxFactories())
      Object.defineProperty(this, name, { value: make(transport, this), enumerable: false });
  }
  get id(): string {
    return this.#info.id;
  }
  /** A sandbox reached with a session token instead of an API key, for code in
   * a browser: commands and their streams, processes, files and previews of
   * this one sandbox. Makes no call; `info` holds only the id until
   * `refresh()`. Your backend makes the session with `sbx.sessions.create()`
   * and hands the page `token` and `sandboxId`.
   *
   *   const sbx = Sandbox.fromSession({ token, sandboxId });
   *   const { stdout } = await sbx.exec("ls /workspace");
   */
  static fromSession(session: {
    token: string;
    sandboxId: string;
    /** The API's origin, `apiUrl` in the session; https://api.withruntime.com
     * unless you run your own. */
    apiUrl?: string;
    fetch?: typeof fetch;
  }): Sandbox {
    if (!/^rtsess_/.test(session.token))
      throw new RuntimeError({
        message: "That is not a sandbox session token (they start rtsess_).",
        code: "invalid_request",
        status: 0,
        hint: "Make one on your backend with sbx.sessions.create() and pass its token.",
      });
    const transport = new Transport({
      apiKey: session.token,
      ...(session.apiUrl ? { baseUrl: session.apiUrl } : {}),
      ...(session.fetch ? { fetch: session.fetch } : {}),
    });
    return new Sandbox(transport, { id: session.sandboxId } as SandboxInfo);
  }
  /** The API's latest answer. `start`, the report of an image's start
   * command, is the create's alone: the API keeps no record of it, so a
   * later read of this sandbox keeps it here. */
  #keep(info: SandboxInfo): void {
    const start = this.#info?.start;
    this.#info = info.start === undefined && start !== undefined ? { ...info, start } : info;
  }
  /** What the API last said about this sandbox. `refresh()` asks again. */
  get info(): SandboxInfo {
    return this.#info;
  }
  get state(): SandboxInfo["state"] {
    return this.#info.state;
  }
  async refresh(options: RequestOptions = {}): Promise<this> {
    this.#keep(
      await this.#t.json<SandboxInfo>({
        method: "GET",
        path: `/v1/sandboxes/${enc(this.id)}`,
        ...options,
      }),
    );
    return this;
  }
  /** Waits (server-side, no polling) until the sandbox reaches `state`. */
  async waitFor(
    state: "running" | "paused" | "stopped",
    options: { timeoutSeconds?: number } & RequestOptions = {},
  ) {
    this.#keep(
      await this.#t.json<SandboxInfo>({
        method: "GET",
        path: `/v1/sandboxes/${enc(this.id)}`,
        query: {
          waitFor: state,
          timeoutSeconds: options.timeoutSeconds ?? WAIT_FOR_TIMEOUT_SECONDS,
        },
        ...options,
      }),
    );
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
            await (event.type === "stdout" ? options.onStdout : options.onStderr)?.(event.data);
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
      body: {
        ...commandBody(command, { timeoutMs: STREAMED_EXEC_TIMEOUT_MS, ...options }),
        stream: true,
      },
      ...pick(options),
      timeoutMs:
        options.timeoutMs === undefined ? STREAMED_EXEC_TIMEOUT_MS : options.timeoutMs + 60_000,
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
      outputEncoding?: "utf8" | "base64";
      /** HTTP request options, independently of the process execution deadline. */
      request?: RequestOptions;
    } = {},
  ): Promise<Process> {
    const { stdin, pty, outputEncoding, request, ...rest } = options;
    const info = await this.#t.json<ProcessInfo>({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.id)}/processes`,
      body: {
        ...commandBody(command, rest),
        ...(stdin === "pipe" ? { stdinMode: "pipe" } : stdin === undefined ? {} : { stdin }),
        ...(pty ? { pty } : {}),
        ...(outputEncoding ? { outputEncoding } : {}),
      },
      ...pick(rest),
      ...request,
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
  /** Deletes it for good: stops it if it runs or is paused, deletes its disk
   * and paused memory, revokes its previews and ports, and removes it from
   * lists. Its snapshots, usage and audit entries stay. Deleting it again
   * answers the same. */
  async delete(options: RequestOptions = {}): Promise<DeletedSandbox> {
    this.#keepAlive?.();
    return deleteSandbox(this.#t, this.id, options);
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
  /** Moves it to another image (id, name, name:tag or name@version), keeping
   * its id, /workspace (its home: dotfiles, pip --user and npm -g installs),
   * volumes, environment, name and previews. Its processes restart, and
   * everything else on its old disk (sudo installs, apt packages, /etc) is
   * lost, which `keep: "workspace"` says you know; snapshot it first to keep
   * everything. A running sandbox is paused first. A switch that fails is
   * undone (`switch_undone`), the sandbox on its old image with nothing lost.
   * Charged as a wake. */
  async switchImage(image: string, options: RequestOptions & { keep: "workspace" }): Promise<this> {
    const { keep, ...rest } = options;
    this.#keep(
      await this.#t.json<SandboxInfo>({
        method: "POST",
        path: `/v1/sandboxes/${enc(this.id)}:switch-image`,
        body: { image, keep },
        // A pause, two boots and the copy between them.
        wait: 120,
        ...pick(rest),
      }),
    );
    return this;
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
    const margin = Math.min(3600, Math.max(60, options.marginSeconds ?? KEEP_ALIVE_MARGIN_SECONDS));
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
    if (body.mode !== undefined && body.mode !== "memory" && body.mode !== "disk")
      throw new TypeError("Snapshot mode must be memory or disk.");
    signal?.throwIfAborted();
    const until =
      performance.now() + Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : 60_000, 60_000);
    const request = (): RequestOptions => {
      signal?.throwIfAborted();
      const left = Math.ceil(until - performance.now());
      if (left <= 0)
        throw new RuntimeError({
          code: "snapshot_timeout",
          status: 0,
          message: "Snapshot capture ran past its deadline.",
        });
      return { ...(signal ? { signal } : {}), timeoutMs: left };
    };
    await this.refresh(request());
    // Straight after a fork or a wake the sandbox is still `resuming`, and
    // after a pause still `pausing`: wait for where it is going, or a
    // snapshot of it is refused as not paused (user lane, 23 September 2026).
    if (this.state === "resuming" || this.state === "starting")
      await this.waitFor("running", request());
    else if (this.state === "pausing") await this.waitFor("paused", request());
    const running = this.state === "running";
    // Check before entering cleanup: an abort during refresh must not pause or wake.
    const pauseOptions = running ? request() : undefined;
    let captured: Snapshot | undefined;
    let primary: unknown;
    let failed = false;
    try {
      if (running) await this.pause(pauseOptions);
      let snapshot = await this.#t.json<Snapshot>({
        method: "POST",
        path: `/v1/sandboxes/${enc(this.id)}:snapshot`,
        body,
        wait: 10,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...request(),
      });
      captured = snapshot;
      // Prefer: wait is bounded on the server. A capture still in progress
      // must keep its source paused, or the worker refuses it after we wake.
      while (snapshot.state === "capturing") {
        signal?.throwIfAborted();
        if (performance.now() >= until)
          throw new RuntimeError({
            code: "snapshot_timeout",
            status: 0,
            message: "Snapshot capture did not finish within one minute.",
            details: { snapshotId: snapshot.id },
          });
        await new Promise((resolve) => setTimeout(resolve, 200));
        snapshot = await this.#t.json<Snapshot>({
          method: "GET",
          path: `/v1/snapshots/${enc(snapshot.id)}`,
          ...request(),
        });
      }
      if (snapshot.state !== "ready")
        throw new RuntimeError({
          code: "snapshot_failed",
          status: 409,
          message: snapshot.error ?? `Snapshot capture ended in state ${snapshot.state}.`,
          details: { snapshotId: snapshot.id },
        });
      if (body.mode === "disk" && snapshot.mode !== "disk")
        throw new RuntimeError({
          code: "snapshot_mode_mismatch",
          status: 409,
          message: "The server did not confirm a disk-only snapshot.",
          details: { snapshotId: snapshot.id },
        });
      captured = snapshot;
    } catch (error) {
      failed = true;
      primary = error;
    }
    if (running) {
      try {
        await this.wake();
      } catch (wakeError) {
        const recovery = {
          ...(captured ? { snapshotId: captured.id } : {}),
          sourceSandboxId: this.id,
          sourceWakeError: {
            ...(wakeError instanceof RuntimeError ? { code: wakeError.code } : {}),
            message: wakeError instanceof Error ? wakeError.message : String(wakeError),
          },
        };
        const reported = failed ? primary : wakeError;
        if (reported instanceof Error && Object.isExtensible(reported)) {
          if (reported instanceof RuntimeError)
            Object.assign(reported, { details: { ...reported.details, ...recovery } });
          else Object.assign(reported, recovery);
        }
        if (!failed) throw wakeError;
      }
    }
    if (failed) throw primary;
    return captured!;
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
    this.#keep(
      await this.#t.json<SandboxInfo>({
        method: "POST",
        path: `/v1/sandboxes/${enc(this.id)}:${verb}`,
        body,
        wait: options.wait === false ? 0 : 60,
        ...pick(options),
      }),
    );
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
      this.cursor = Math.max(
        this.cursor,
        event.offset +
          (event.base64 === undefined
            ? utf8(event.data).byteLength
            : processBytes(event.base64).length),
      );
    }
    yield event;
  }
}

function processBytes(encoded: string): string {
  try {
    return atob(encoded);
  } catch (cause) {
    throw new RuntimeError({
      code: "invalid_process_output",
      status: 502,
      message: "The process returned invalid base64 output.",
      cause,
    });
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

/** A sandbox session, as the API answers it. `token` is set only in the
 * answer to `create`. */
export type SandboxSession = {
  id: string;
  sandboxId: string;
  name: string | null;
  origins: string[];
  /** The agent whose key made it; the session acts as it. */
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  state: "active" | "expired" | "revoked";
};
export type CreatedSandboxSession = SandboxSession & {
  /** The bearer token, `rtsess_...`: hand it to the page, never log it. */
  token: string;
  /** The API's origin, for `Sandbox.fromSession({ apiUrl })`. */
  apiUrl: string;
};

/** Sessions: a token your backend makes and hands to your own frontend, which
 * then runs commands, reads and writes files and reaches previews in this one
 * sandbox directly, without proxying through your servers. A session cannot
 * stop, pause, extend, fork, snapshot or change the sandbox, create anything,
 * or reach anything else. It lasts an hour unless asked (a day at most), ends
 * when the key that made it is revoked, and is revocable at once. */
export class SandboxSessions {
  constructor(
    private readonly t: Transport,
    private readonly sandboxId: string,
  ) {}
  /** A new session. `origins` are the exact pages that will use it
   * (`https://app.example.com`, or `http://localhost:5173` while developing):
   * the API answers CORS for them and refuses any other page. */
  async create(
    input: { ttlSeconds?: number; origins?: string[]; name?: string } = {},
    options: RequestOptions = {},
  ): Promise<CreatedSandboxSession> {
    const path = `/v1/sandboxes/${enc(this.sandboxId)}/sessions`;
    const made = await this.t.json<SandboxSession & { token: string | null; apiUrl: string }>({
      method: "POST",
      path,
      body: input,
      ...options,
    });
    if (made.token) return made as CreatedSandboxSession;
    /* The answer replayed an earlier create whose reply was lost, and a token
       is shown only once: end that session and make a fresh one. */
    await this.revoke(made.id).catch(() => undefined);
    const fresh = await this.t.json<SandboxSession & { token: string | null; apiUrl: string }>({
      method: "POST",
      path,
      body: input,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (!fresh.token)
      throw new RuntimeError({
        message: "The session was made but its token did not arrive.",
        code: "session_token_lost",
        status: 0,
        hint: `Revoke session ${fresh.id} and create another.`,
      });
    return fresh as CreatedSandboxSession;
  }
  /** Sessions still active, and those that ended in the last day, newest first. */
  async list(options: RequestOptions = {}): Promise<SandboxSession[]> {
    return (
      await this.t.json<{ data: SandboxSession[] }>({
        method: "GET",
        path: `/v1/sandboxes/${enc(this.sandboxId)}/sessions`,
        ...options,
      })
    ).data;
  }
  /** Ends a session now; its next request is refused. */
  async revoke(sessionId: string, options: RequestOptions = {}): Promise<SandboxSession> {
    return this.t.json<SandboxSession>({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.sandboxId)}/sessions/${enc(sessionId)}:revoke`,
      body: {},
      ...options,
    });
  }
}

export class Processes {
  constructor(
    private readonly t: Transport,
    private readonly sandboxId: string,
  ) {}
  async list(options: RequestOptions = {}): Promise<ProcessInfo[]> {
    return (
      await this.t.json<{ data: ProcessInfo[] }>({
        method: "GET",
        path: `/v1/sandboxes/${enc(this.sandboxId)}/processes`,
        ...options,
      })
    ).data;
  }
  async get(processId: string, options: RequestOptions = {}): Promise<Process> {
    const info = await this.t.json<ProcessInfo>({
      method: "GET",
      path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(processId)}`,
      ...options,
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
  #inputWrites: Promise<void> = Promise.resolve();
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
  /** Lossless output for a process spawned with outputEncoding: "base64".
   * Refuses text-only output rather than inventing bytes that were discarded. */
  async *outputBytes(
    options: { cursor?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<BinaryOutputEvent> {
    if (this.info.outputEncoding !== "base64")
      throw new RuntimeError({
        code: "binary_output_unavailable",
        status: 409,
        message: "Spawn the process with outputEncoding: base64 to read lossless bytes.",
      });
    for await (const event of this.output(options)) {
      if (event.type === "stdout" || event.type === "stderr") {
        if (event.base64 === undefined)
          throw new RuntimeError({
            code: "binary_output_unavailable",
            status: 502,
            message: "The process returned text without its original bytes.",
          });
        const raw = processBytes(event.base64);
        yield {
          type: event.type,
          offset: event.offset,
          data: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
        };
      } else yield event as Exclude<OutputEvent, { type: "stdout" | "stderr" }>;
    }
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
  /** Sends input. Offsets protect transport retries; signal and timeoutMs cover
   * the whole logical write, including its queue and backpressure. */
  write(
    data: string | Uint8Array,
    options: { eof?: boolean } & Pick<RequestOptions, "signal" | "timeoutMs"> = {},
  ): Promise<void> {
    if ((options as RequestOptions).idempotencyKey !== undefined)
      return Promise.reject(
        new RuntimeError({
          message:
            "Process input writes do not accept caller idempotency keys; offsets protect transport retries.",
          code: "unsupported_process_write_option",
          status: 400,
        }),
      );
    // Copy before queuing: callers may reuse their buffer while a previous
    // write waits for the guest to drain its pipe.
    const bytes = new Uint8Array(utf8(data));
    const eof = options.eof === true;
    const { eof: _eof, ...requestOptions } = options;
    const scope = requestScope(requestOptions);
    const write = this.#inputWrites.then(async () => {
      let sent = 0;
      let chunkSize = CHUNK;
      do {
        scope.check();
        const chunk = bytes.subarray(sent, sent + chunkSize);
        const reply = await this.t.json<{ offset: number }>({
          method: "POST",
          path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(this.id)}:write`,
          body: {
            base64: base64(chunk),
            offset: this.#inputOffset,
            ...(eof && sent + chunk.length === bytes.length ? { eof: true } : {}),
          },
          ...scope.request,
        });
        const accepted = reply.offset - this.#inputOffset;
        if (!Number.isSafeInteger(reply.offset) || accepted < 0 || accepted > chunk.length)
          throw new ConnectionError({
            message: "The process returned an invalid input offset.",
            code: "connection_error",
            status: 0,
          });
        sent += accepted;
        this.#inputOffset = reply.offset;
        // A slow pipe may take only part of a chunk. Keep later uploads within
        // that observed capacity instead of resending almost a MiB each time.
        // Zero is legitimate backpressure: retry a bounded probe at the same
        // offset without discarding bytes or inventing progress.
        if (accepted < chunk.length) {
          chunkSize = accepted > 0 ? accepted : Math.min(chunkSize, 65_536);
          // A full pipe must yield even if a proxy answers immediately; don't
          // spin requests while the guest has accepted none of this input.
          if (accepted === 0) await scope.wait(new Promise((resolve) => setTimeout(resolve, 100)));
        }
      } while (sent < bytes.length);
    });
    this.#inputWrites = write.catch(() => undefined);
    return scope.wait(write);
  }
  async kill(
    signal:
      "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" | "SIGQUIT" | "SIGUSR1" | "SIGUSR2" = "SIGTERM",
    options: RequestOptions = {},
  ): Promise<void> {
    await this.t.json({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(this.id)}:signal`,
      body: { signal },
      ...options,
    });
  }
  async resize(cols: number, rows: number, options: RequestOptions = {}): Promise<void> {
    await this.t.json({
      method: "POST",
      path: `/v1/sandboxes/${enc(this.sandboxId)}/processes/${enc(this.id)}:resize`,
      body: { cols, rows },
      ...options,
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
    const scope = requestScope(options);
    scope.check();
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
        ...scope.request,
      });
      return { path, size: bytes.length };
    }
    const sha256 = await scope.wait(sha256Hex(bytes));
    return this.#writeUpload(
      path,
      {
        size: bytes.length,
        sha256,
        chunkAt: (offset, length) => bytes.subarray(offset, offset + length),
      },
      octal,
      scope,
    );
  }
  /** Uploads byte streams with bounded memory on Node/Bun. Unknown-length
   * inputs stage once in a private local temporary file; known local files
   * and Blobs avoid that extra disk copy. Paths are local file paths. */
  async writeStream(
    path: string,
    input: StreamUploadSource | Uint8Array,
    writeOptions: RequestOptions & {
      mode?: number;
      onProgress?: (progress: { bytesSent: number }) => void;
    } = {},
  ): Promise<{ path: string; size: number }> {
    const { mode, onProgress, ...options } = writeOptions;
    if (input instanceof Uint8Array) {
      const result = await this.write(path, input, {
        ...options,
        ...(mode === undefined ? {} : { mode }),
      });
      onProgress?.({ bytesSent: result.size });
      return result;
    }
    const scope = requestScope(options);
    scope.check();
    if (
      !(globalThis as { process?: { versions?: { node?: string; bun?: string } } }).process
        ?.versions?.node
    )
      throw new RuntimeError({
        message:
          "Streamed file uploads require Node or Bun for incremental hashing and private local staging. Use files.write with byte data in a browser.",
        code: "unsupported_runtime",
        status: 0,
      });
    const { prepareFileSource } = await import("./file-source.js");
    const source = await prepareFileSource(input, { ...scope, signal: scope.request.signal });
    let written: { path: string; size: number };
    try {
      if (source.size <= CHUNK) {
        written = await this.write(path, await scope.wait(source.chunkAt(0, source.size)), {
          ...scope.request,
          ...(mode === undefined ? {} : { mode }),
        });
        onProgress?.({ bytesSent: written.size });
      } else {
        const octal = mode === undefined ? undefined : (mode & 0o777).toString(8).padStart(3, "0");
        written = await this.#writeUpload(path, source, octal, scope, onProgress);
      }
    } catch (primary) {
      try {
        await source.close();
      } catch (cleanupError) {
        if (primary === undefined) throw cleanupError;
        if (primary instanceof Error && Object.isExtensible(primary)) {
          try {
            Object.defineProperty(primary, "cleanupError", {
              value: cleanupError,
              configurable: true,
            });
          } catch {
            /* Keep the original upload failure. */
          }
        }
      }
      throw primary;
    }
    // A failed close after a good upload is the call's failure.
    await source.close();
    return written;
  }
  /** One implementation of atomic, checked chunk uploads for bytes and streams. */
  async #writeUpload(
    path: string,
    source: {
      size: number;
      sha256: string;
      chunkAt(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
    },
    octal: string | undefined,
    scope: ReturnType<typeof requestScope>,
    onProgress?: (progress: { bytesSent: number }) => void,
  ): Promise<{ path: string; size: number }> {
    const sha256 = source.sha256;
    // A guest journals mutations across operations, not per URL. One logical
    // write therefore owns separate stable keys for each mutation phase.
    const uploadKey = scope.request.idempotencyKey ?? crypto.randomUUID();
    const phaseKeys = new Map<string, string>();
    for (const phase of ["begin", "legacy-begin", "commit", "chmod", "abort"])
      phaseKeys.set(phase, await sha256Hex(JSON.stringify(["files.write", uploadKey, phase])));
    const phaseOptions = (phase: string): RequestOptions => ({
      ...scope.request,
      idempotencyKey: phaseKeys.get(phase)!,
    });
    type Upload = { uploadId: string; chunkBytes: number; mode?: string; replayed?: boolean };
    let begin: Upload;
    scope.check();
    try {
      begin = await this.t.json<Upload>({
        method: "POST",
        path: this.#path("/uploads"),
        body: { path, size: source.size, sha256, ...(octal ? { mode: octal } : {}) },
        ...phaseOptions("begin"),
      });
    } catch (error) {
      if (!octal || !(error instanceof RuntimeError) || error.code !== "guest_upgrade_required")
        throw error;
      // The API aborted the unsupported transfer before accepting chunks.
      // A different body needs a different key; retain deterministic retries.
      scope.check();
      begin = await this.t.json<Upload>({
        method: "POST",
        path: this.#path("/uploads"),
        body: { path, size: source.size, sha256 },
        ...phaseOptions("legacy-begin"),
      });
    }
    // A malformed response does not prove ownership of any transfer to abort.
    if (typeof begin.uploadId !== "string" || begin.uploadId.length === 0)
      throw new ConnectionError({
        message: "The file upload returned no transfer identifier.",
        code: "connection_error",
        status: 0,
      });
    const commit = () => {
      scope.check();
      return this.t.json({
        method: "POST",
        path: this.#path(`/uploads/${enc(begin.uploadId)}:commit`),
        body: {},
        ...phaseOptions("commit"),
      });
    };
    let committed = false;
    let nextOffset = 0;
    const stopChunks = new AbortController();
    const chunkSignal = scope.request.signal
      ? AbortSignal.any([scope.request.signal, stopChunks.signal])
      : stopChunks.signal;
    const chunkScope = requestScope({ ...scope.request, signal: chunkSignal });
    let bytesSent = 0;
    let failed = false;
    let primaryFailure: unknown;
    const worker = async () => {
      try {
        while (nextOffset < source.size) {
          scope.check();
          if (stopChunks.signal.aborted) return;
          const offset = nextOffset;
          nextOffset += begin.chunkBytes;
          const offered = source.chunkAt(offset, Math.min(begin.chunkBytes, source.size - offset));
          const chunk = offered instanceof Promise ? await chunkScope.wait(offered) : offered;
          chunkScope.check();
          if (chunk.length !== Math.min(begin.chunkBytes, source.size - offset))
            throw new ConnectionError({
              message: "The local upload source returned an incomplete chunk.",
              code: "source_changed",
              status: 0,
            });
          const receipt = await this.t.json<{ received: number }>({
            method: "PUT",
            path: this.#path(`/uploads/${enc(begin.uploadId)}`),
            query: { offset },
            bytes: chunk,
            ...scope.request,
            signal: chunkSignal,
            // Offsets and byte hashes make chunk replay safe without mutation keys.
            idempotencyKey: undefined,
          });
          // Parallel receipts report cumulative accepted bytes, not this offset.
          if (
            !Number.isSafeInteger(receipt.received) ||
            receipt.received < chunk.length ||
            receipt.received > source.size
          )
            throw new ConnectionError({
              message: "The file upload returned invalid byte progress.",
              code: "connection_error",
              status: 0,
            });
          bytesSent += chunk.length;
          onProgress?.({ bytesSent });
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          primaryFailure = error;
          stopChunks.abort(error);
        }
        throw error;
      }
    };
    try {
      if (
        !Number.isSafeInteger(begin.chunkBytes) ||
        begin.chunkBytes <= 0 ||
        begin.chunkBytes > CHUNK
      )
        throw new ConnectionError({
          message: "The file upload returned an invalid chunk size.",
          code: "connection_error",
          status: 0,
        });
      if (begin.replayed) {
        // A completed commit removed the transfer. Ask its journal before
        // resending chunks; an incomplete transfer alone is safe to continue.
        try {
          await commit();
          committed = true;
          onProgress?.({ bytesSent: source.size });
        } catch (error) {
          if (!(error instanceof RuntimeError) || error.code !== "upload_incomplete") throw error;
        }
      }
      if (!committed) {
        const workers = Array.from(
          { length: Math.min(PARALLEL, Math.ceil(source.size / begin.chunkBytes)) },
          worker,
        );
        // Drain every owned in-flight chunk before aborting its transfer.
        // Promise.all's early rejection could otherwise leave writes racing cleanup.
        await Promise.allSettled(workers);
        if (failed) throw primaryFailure;
        await commit();
      }
      // An older sandbox image ignores the mode in the upload; set it after.
      if (octal && begin.mode !== octal) {
        scope.check();
        await this.t.json({
          method: "POST",
          path: this.#path("/files:chmod"),
          body: { path, mode: octal },
          ...phaseOptions("chmod"),
        });
      }
    } catch (error) {
      try {
        await this.t.json({
          method: "POST",
          path: this.#path(`/uploads/${enc(begin.uploadId)}:abort`),
          body: {},
          idempotencyKey: phaseKeys.get("abort")!,
          timeoutMs: 5000,
        });
      } catch (cleanupError) {
        // Keep the original failure; retain cleanup evidence when possible.
        if (error instanceof Error && Object.isExtensible(error)) {
          try {
            Object.defineProperty(error, error.cause === undefined ? "cause" : "cleanupError", {
              value: cleanupError,
              configurable: true,
            });
          } catch {
            /* A frozen property cannot replace the primary failure. */
          }
        }
      }
      throw error;
    }
    return { path, size: source.size };
  }
  /** Directory entries; `depth` goes deeper, `glob` filters (e.g. "**\/*.py"). */
  async list(
    path = "/workspace",
    options: {
      depth?: number;
      glob?: string;
      hidden?: boolean;
      limit?: number;
    } & RequestOptions = {},
  ): Promise<FileEntry[]> {
    const { signal, timeoutMs, idempotencyKey, ...query } = options;
    return (
      await this.t.json<{ data: FileEntry[] }>({
        method: "GET",
        path: this.#path("/files/list"),
        query: { path, ...query },
        signal,
        timeoutMs,
        idempotencyKey,
      })
    ).data;
  }
  async glob(pattern: string, root = "/workspace"): Promise<FileEntry[]> {
    return this.list(root, { glob: pattern });
  }
  async stat(
    path: string,
    options: RequestOptions = {},
  ): Promise<(FileEntry & { exists: true }) | { exists: false; path: string }> {
    return this.t.json({
      method: "GET",
      path: this.#path("/files/stat"),
      query: { path },
      ...options,
    });
  }
  async exists(path: string, options: RequestOptions = {}): Promise<boolean> {
    return (await this.stat(path, options)).exists;
  }
  async mkdir(path: string, options: { parents?: boolean } & RequestOptions = {}): Promise<void> {
    const { parents, ...request } = options;
    await this.t.json({
      method: "POST",
      path: this.#path("/files:mkdir"),
      body: { path, parents },
      ...request,
    });
  }
  async remove(
    path: string,
    options: { recursive?: boolean } & RequestOptions = {},
  ): Promise<boolean> {
    const { recursive, ...request } = options;
    return (
      await this.t.json<{ removed: boolean }>({
        method: "POST",
        path: this.#path("/files:remove"),
        body: { path, recursive },
        ...request,
      })
    ).removed;
  }
  async rename(
    from: string,
    to: string,
    options: { overwrite?: boolean } & RequestOptions = {},
  ): Promise<void> {
    const { overwrite, ...request } = options;
    await this.t.json({
      method: "POST",
      path: this.#path("/files:rename"),
      body: {
        from,
        to,
        ...(overwrite === undefined ? {} : { overwrite }),
      },
      ...request,
    });
  }
  /** Packs a directory as archive bytes; `gzip: false` returns plain tar.
   * Exclusions are relative paths, not globs. `user: root` selects guest root. */
  async archive(
    path: string,
    options: RequestOptions & {
      gzip?: boolean;
      exclude?: string[];
      user?: "sandbox" | "root";
    } = {},
  ): Promise<Uint8Array> {
    const { gzip = true, exclude, user, ...request } = options;
    return this.t.fileBytes({
      method: "GET",
      path: this.#path("/files/archive"),
      query: { path, gzip, ...(exclude ? { exclude } : {}), ...(user ? { user } : {}) },
      accept: gzip ? "application/gzip" : "application/x-tar",
      ...request,
    });
  }
  /** Unpacks archive bytes in a directory with the sandbox user's rights by
   * default; `user: root` explicitly selects root inside this guest. */
  async unarchive(
    path: string,
    bytes: Uint8Array,
    options: RequestOptions & { gzip?: boolean; user?: "sandbox" | "root" } = {},
  ): Promise<void> {
    const { gzip = bytes[0] === 0x1f && bytes[1] === 0x8b, user, ...request } = options;
    const scope = requestScope(request);
    scope.check();
    if (bytes.length <= CHUNK) {
      await this.t.bytes({
        method: "PUT",
        path: this.#path("/files/archive"),
        query: { path, ...(user ? { user } : {}) },
        bytes,
        ...scope.request,
      });
      return;
    }
    const key = request.idempotencyKey ?? crypto.randomUUID();
    const phase = async (name: string) => ({
      ...scope.request,
      idempotencyKey: await sha256Hex(JSON.stringify(["files.unarchive", key, name])),
    });
    const begin = await this.t.json<{ uploadId: string; chunkBytes: number }>({
      method: "POST",
      path: this.#path("/files/archive/uploads"),
      body: { path, gzip, ...(user ? { user } : {}) },
      ...(await phase("begin")),
    });
    const upload = (suffix = "") =>
      this.#path(`/files/archive/uploads/${enc(begin.uploadId)}${suffix}`);
    try {
      if (!Number.isSafeInteger(begin.chunkBytes) || begin.chunkBytes <= 0)
        throw new ConnectionError({
          message: "The archive upload returned an invalid chunk size.",
          code: "connection_error",
          status: 0,
        });
      for (let offset = 0; offset < bytes.length; offset += begin.chunkBytes) {
        scope.check();
        await this.t.bytes({
          method: "PUT",
          path: upload(),
          query: { offset },
          bytes: bytes.subarray(offset, offset + begin.chunkBytes),
          ...(await phase(`chunk:${offset}`)),
        });
      }
      scope.check();
      await this.t.json({
        method: "POST",
        path: upload(":commit"),
        body: {},
        ...(await phase("commit")),
      });
    } catch (error) {
      // Cleanup must still run when the caller's signal/deadline has expired.
      const idempotencyKey = await sha256Hex(JSON.stringify(["files.unarchive", key, "abort"]));
      await this.t
        .json({ method: "POST", path: upload(":abort"), body: {}, idempotencyKey })
        .catch(() => undefined);
      throw error;
    }
  }
  /** Copies a local file or directory into the sandbox. A directory travels as
   * one gzipped tar to the API's folder routes, and the sandbox's own `tar`
   * unpacks it as it arrives, making the folder. */
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
    if (archive.length <= CHUNK) {
      await this.t.bytes({
        method: "PUT",
        path: this.#path("/files/archive"),
        query: { path: remotePath },
        bytes: archive,
      });
      return;
    }
    // Larger: parts in order, each unpacked as it arrives; a part resent
    // after a lost answer is not written twice.
    const begin = await this.t.json<{ uploadId: string; chunkBytes: number }>({
      method: "POST",
      path: this.#path("/files/archive/uploads"),
      body: { path: remotePath, gzip: true },
    });
    const upload = (suffix = "") =>
      this.#path(`/files/archive/uploads/${enc(begin.uploadId)}${suffix}`);
    try {
      for (let offset = 0; offset < archive.length; offset += begin.chunkBytes)
        await this.t.bytes({
          method: "PUT",
          path: upload(),
          query: { offset },
          bytes: archive.subarray(offset, offset + begin.chunkBytes),
        });
      await this.t.json({ method: "POST", path: upload(":commit"), body: {} });
    } catch (error) {
      await this.t
        .json({ method: "POST", path: upload(":abort"), body: {} })
        .catch(() => undefined);
      throw error;
    }
  }
  /** Streams a file to disk through a partial file beside the target, renamed
   * into place only once every byte has arrived: a failed copy never leaves
   * a short file under the name asked for. A short stream is tried again,
   * twice, as a short `read` is. */
  async #streamTo(
    remotePath: string,
    localPath: string,
    options: RequestOptions = {},
  ): Promise<void> {
    const scope = requestScope(options);
    const fs = await import("node:fs/promises");
    const partial = `${localPath}.runtime-partial-${crypto.randomUUID().slice(0, 8)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        scope.check();
        const stream = await this.readStream(remotePath, scope.request);
        // The handle is closed before anything else touches the file, so a
        // failed copy's partial file is really gone when the error returns.
        try {
          const file = await fs.open(partial, "w");
          try {
            for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
              let written = 0;
              while (written < chunk.length) {
                scope.check();
                const result = await file.write(chunk.subarray(written));
                if (result.bytesWritten === 0) throw new Error("The local file accepted no bytes.");
                written += result.bytesWritten;
              }
            }
          } finally {
            await file.close();
          }
        } finally {
          // Opening or writing the local file can fail before consumption.
          await stream.cancel().catch(() => undefined);
        }
        scope.check();
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
   * any size, checked against its length; a directory comes as one tar from
   * the API's folder route. */
  async download(
    remotePath: string,
    localPath: string,
    options: RequestOptions = {},
  ): Promise<void> {
    const scope = requestScope(options);
    scope.check();
    const fs = await import("node:fs/promises");
    const paths = await import("node:path");
    const entry = await this.stat(remotePath, scope.request);
    if (!entry.exists)
      throw new RuntimeError({
        message: `${remotePath} does not exist.`,
        code: "file_not_found",
        status: 404,
      });
    if (entry.type !== "directory") {
      await fs.mkdir(paths.dirname(localPath), { recursive: true });
      await this.#streamTo(remotePath, localPath, scope.request);
      return;
    }
    // The sandbox's own `tar` packs it as it streams, and it is unpacked as
    // it arrives; one cut short is refused and nothing is put in place.
    const archive = await this.t.fileStream({
      method: "GET",
      path: this.#path("/files/archive"),
      query: { path: remotePath, gzip: true },
      accept: "application/gzip",
      ...scope.request,
    });
    const { unpackStream } = await import("./tar.js");
    try {
      await unpackStream(archive as unknown as AsyncIterable<Uint8Array>, localPath, {
        signal: scope.request.signal,
      });
    } finally {
      await archive.cancel().catch(() => undefined);
    }
  }
}

export function sandboxPage(
  t: Transport,
  body: { data: SandboxInfo[]; nextCursor: string | null },
  query: Record<string, unknown>,
  options: RequestOptions = {},
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
          ...options,
        }),
        query,
        options,
      ),
  );
}
