import type { Process } from "../sandbox.js";
import type { OutputEvent, ProcessInfo } from "../types.js";
import type { RuntimeSandbox } from "./client.js";
import {
  checkEnvNames,
  httpDate,
  parseProcessLine,
  processLine,
  randomName,
  RUNTIME_HOME,
  toBlaxelPath,
  toRuntimePath,
} from "./context.js";
import { codeOf, guard, ResponseError, responseError, translate } from "./errors.js";

/* `sandbox.process` over Runtime's processes. A Blaxel process runs as a
   Runtime process whose command line starts with a marker holding its Blaxel
   name, so `get("dev-server")` finds it from any client, and the sandbox's
   envs are applied inside the same line: no call is added for either. */

export type ProcessRequest = {
  command: string;
  env?: { [key: string]: string };
  /** Keeps the sandbox awake while the process runs (see BLAXEL.md). */
  keepAlive?: boolean;
  maxRestarts?: number;
  name?: string;
  restartOnFailure?: boolean;
  /** Opens a pipe for writeStdin / closeStdin. */
  stdin?: boolean;
  /** Seconds. Bounds the wait of waitForCompletion and waitForPorts; with
   * keepAlive, the process is killed after it (default 600, 0 never). */
  timeout?: number;
  waitForCompletion?: boolean;
  waitForPorts?: Array<number>;
  workingDir?: string;
};
export type ProcessResponse = {
  command: string;
  completedAt: string;
  exitCode: number;
  keepAlive?: boolean;
  logs: string;
  maxRestarts?: number;
  name: string;
  /** Runtime's process id. */
  pid: string;
  restartCount?: number;
  restartOnFailure?: boolean;
  startedAt: string;
  status: "failed" | "killed" | "stopped" | "running" | "completed";
  stderr: string;
  stdin?: boolean;
  stdout: string;
  workingDir: string;
};
export type PostProcessResponse = ProcessResponse;
export type GetProcessResponse = ProcessResponse[];
export type GetProcessByIdentifierResponse = ProcessResponse;
export type DeleteProcessByIdentifierResponse = { message: string };
export type DeleteProcessByIdentifierKillResponse = { message: string };
export type ProcessLogs = { logs: string; stderr: string; stdout: string };
export type ProcessRequestWithLog = ProcessRequest & {
  onLog?: (log: string) => void;
  onStdout?: (stdout: string) => void;
  onStderr?: (stderr: string) => void;
};
export type ProcessResponseWithLog = ProcessResponse & { close: () => void };

/** Commands without an end of their own run as long as Runtime allows. */
const LONGEST_MS = 86_400_000;
/** A keepAlive process is killed after this long unless `timeout` says. */
const KEEP_ALIVE_SECONDS = 600;
const SIGKILL = 9;

/** What the process part needs from its sandbox. */
export interface ProcessContext {
  readonly id: string;
  /** The running sandbox, woken if it was paused; throws once deleted. */
  live(): Promise<RuntimeSandbox>;
  /** Wakes the sandbox after a call found it paused. */
  wake(): Promise<void>;
  /** Keeps the sandbox from pausing for `seconds` (0: until its lease ends). */
  keepAwake(seconds: number): Promise<void>;
  /** A keepAlive process was seen to end: give the sandbox its idle pause
   * back once none runs. Never throws. */
  keepAliveEnded(): Promise<void>;
}

type Meta = {
  name: string;
  command: string;
  workingDir: string;
  keepAlive?: boolean;
  restartOnFailure?: boolean;
  maxRestarts?: number;
  stdin?: boolean;
};
type Registry = {
  /** Blaxel name to Runtime process id: the newest process of that name. */
  byName: Map<string, string>;
  meta: Map<string, Meta>;
  processes: Map<string, Process>;
};
/** Per sandbox, shared by every object this module makes for it. A fresh
 * client starts empty and finds processes by their marker. */
const registries = new Map<string, Registry>();
function registryOf(sandboxId: string): Registry {
  let registry = registries.get(sandboxId);
  if (!registry) {
    registry = { byName: new Map(), meta: new Map(), processes: new Map() };
    registries.set(sandboxId, registry);
  }
  return registry;
}

/** The loopback addresses in /proc/net/tcp and tcp6: a server bound only to
 * one cannot be reached from outside, so Blaxel does not count it. */
const LOOPBACK = [
  "0100007F",
  "00000000000000000000000001000000",
  "0000000000000000FFFF00000100007F",
];

/** A command that waits until every port listens on an address other than
 * loopback, up to `seconds`, reading whichever of the kernel's socket tables
 * exist (a guest without IPv6 has no tcp6). Exits 0 when they all listen. */
export function portWaitScript(
  ports: number[],
  seconds: number,
  tables = ["/proc/net/tcp", "/proc/net/tcp6"],
): string {
  const hex = ports.map((port) => port.toString(16).toUpperCase().padStart(4, "0"));
  const skip = LOOPBACK.map((address) => `a[1] != "${address}"`).join(" && ");
  return (
    `t=""; for f in ${tables.join(" ")}; do [ -r "$f" ] && t="$t $f"; done; ` +
    `end=$((SECONDS+${seconds})); while :; do ok=1; for h in ${hex.join(" ")}; do ` +
    `awk -v h="$h" '$4 == "0A" { split($2, a, ":"); if (a[2] == h && ${skip}) f = 1 } END { exit !f }' ` +
    `$t </dev/null || ok=0; done; [ $ok = 1 ] && exit 0; ` +
    `[ $SECONDS -ge $end ] && exit 1; sleep 0.2; done`
  );
}

/** Test hook: forget every process this module has seen, as a fresh client
 * would. */
export function resetProcesses() {
  registries.clear();
}

type Found = { id: string; info: ProcessInfo; process?: Process };
type Output = { stdout: string; stderr: string; logs: string };
type Exit = Extract<OutputEvent, { type: "exit" }>;

/** Blaxel's status from Runtime's record. A process ended by a signal has a
 * negative exit code on Runtime (-15 after SIGTERM, -9 after SIGKILL or its
 * time limit): SIGKILL is killed, any other signal stopped, from any client. */
function statusOf(state: string, exitCode: number | null): ProcessResponse["status"] {
  if (state === "running" && exitCode === null) return "running";
  if (exitCode === null) return "killed";
  if (exitCode < 0) return exitCode === -SIGKILL ? "killed" : "stopped";
  return exitCode === 0 ? "completed" : "failed";
}

/** Blaxel's restart notes in a process's output: the last is its restart count. */
function restartsIn(logs: string): number {
  let count = 0;
  for (const [, n] of logs.matchAll(
    /\n\[Process failed with exit code -?\d+\. Attempting restart (\d+)\//g,
  ))
    count = Math.max(count, Number(n));
  return count;
}

/** `sandbox.process`: run, follow and stop processes, by pid or by name. */
export class SandboxProcess {
  readonly #ctx: ProcessContext;
  constructor(ctx: ProcessContext) {
    this.#ctx = ctx;
  }

  get #registry(): Registry {
    return registryOf(this.#ctx.id);
  }

  #remember(id: string, meta: Meta, process?: Process) {
    const registry = this.#registry;
    registry.byName.set(meta.name, id);
    registry.meta.set(id, meta);
    if (process) registry.processes.set(id, process);
  }

  /** Starts a command. Without waitForCompletion it answers at once, the
   * process running; with it, once the process ends, with its output. */
  async exec(
    request: ProcessRequest | ProcessRequestWithLog,
  ): Promise<PostProcessResponse | ProcessResponseWithLog> {
    const { onLog, onStdout, onStderr, ...req } = request as ProcessRequestWithLog;
    if (typeof req.command !== "string" || req.command === "")
      throw responseError(400, "command is required");
    const env = req.env ?? {};
    checkEnvNames(Object.keys(env));
    const meta: Meta = {
      name: req.name || randomName(),
      command: req.command,
      workingDir: req.workingDir ?? "",
      ...(req.keepAlive ? { keepAlive: true } : {}),
      ...(req.restartOnFailure
        ? { restartOnFailure: true, maxRestarts: req.maxRestarts ?? 0 }
        : {}),
      ...(req.stdin ? { stdin: true } : {}),
    };
    const line = processLine(req.command, {
      name: meta.name,
      ...(req.restartOnFailure ? { maxRestarts: req.maxRestarts ?? 0 } : {}),
      linkHome: /\/blaxel(\/|\s|$|["'`;:])/.test(`${req.command} ${Object.values(env).join(" ")}`),
      ...(req.keepAlive ? { keepAlive: true } : {}),
    });
    const names = Object.keys(env);
    const options = {
      cwd: req.workingDir ? toRuntimePath(req.workingDir) : RUNTIME_HOME,
      ...(names.length ? { env: { ...env, RUNTIME_BLAXEL_KEEP: `:${names.join(":")}:` } } : {}),
      timeoutMs: this.#killAfterMs(req),
    };
    // Awake first: a sandbox that cannot be kept awake refuses the process
    // rather than pausing under it.
    if (req.keepAlive) await this.#ctx.keepAwake(this.#killAfterMs(req) / 1000);
    const callbacks = onLog || onStdout || onStderr;
    if (req.waitForCompletion && !req.stdin && !req.waitForPorts?.length)
      return await this.#execWaiting(line, options, meta, req.timeout, {
        ...(onLog ? { onLog } : {}),
        ...(onStdout ? { onStdout } : {}),
        ...(onStderr ? { onStderr } : {}),
      });
    const runtime = await this.#ctx.live();
    const process = await this.#retryPaused(() =>
      runtime.spawn(line, { ...options, ...(req.stdin ? { stdin: "pipe" } : {}) }),
    );
    this.#remember(process.id, meta, process);
    if (req.waitForPorts?.length) await this.#waitForPorts(req.waitForPorts, req.timeout);
    if (req.waitForCompletion) {
      const bounded = req.timeout !== undefined && req.timeout > 0;
      const done = await this.wait(process.id, {
        maxWait: bounded ? req.timeout! * 1000 : -1,
      }).catch((error: unknown) => {
        throw bounded && !(error instanceof ResponseError)
          ? responseError(422, `process timed out after ${req.timeout} seconds`)
          : error;
      });
      if (callbacks) replay(done, { onLog, onStdout, onStderr });
      return { ...done, close: () => undefined };
    }
    const running = this.#response(process.info, meta, { stdout: "", stderr: "", logs: "" });
    if (!callbacks) return running;
    const stream = this.streamLogs(process.id, {
      ...(onLog ? { onLog } : {}),
      ...(onStdout ? { onStdout } : {}),
      ...(onStderr ? { onStderr } : {}),
    });
    return { ...running, close: () => stream.close() };
  }

  #killAfterMs(req: ProcessRequest): number {
    if (!req.keepAlive) return LONGEST_MS;
    const seconds = req.timeout === undefined || req.timeout < 0 ? KEEP_ALIVE_SECONDS : req.timeout;
    return seconds === 0 ? LONGEST_MS : Math.min(LONGEST_MS, seconds * 1000);
  }

  /** A call that found the sandbox paused (autoWake off) is made again once,
   * after a wake: it never started, so it cannot run twice. */
  async #retryPaused<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    try {
      return await work();
    } catch (error) {
      signal?.throwIfAborted();
      if (codeOf(error) !== "sandbox_paused") throw translate(error);
      await this.#ctx.wake();
      signal?.throwIfAborted();
      return guard(work);
    }
  }

  /** One streamed exec: the process's id arrives first, then its output, then
   * its end. Past `timeout` seconds the wait gives up and the process keeps
   * running, as in Blaxel. */
  async #execWaiting(
    line: string,
    options: { cwd: string; env?: Record<string, string>; timeoutMs: number },
    meta: Meta,
    timeout: number | undefined,
    callbacks: Pick<ProcessRequestWithLog, "onLog" | "onStdout" | "onStderr">,
  ): Promise<ProcessResponseWithLog> {
    const runtime = await this.#ctx.live();
    const abort = new AbortController();
    let timedOut = false;
    const timer =
      timeout && timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, timeout * 1000)
        : undefined;
    const out: Output = { stdout: "", stderr: "", logs: "" };
    let id: string | undefined;
    let exit: Exit | undefined;
    const startedAt = new Date().toISOString();
    const run = async () => {
      for await (const event of runtime.execStream(line, { ...options, signal: abort.signal })) {
        if (event.type === "truncated")
          throw responseError(502, "Some command output is no longer available.");
        if (event.type === "start") {
          id = event.processId;
          this.#remember(id, meta);
        } else if (event.type === "stdout" || event.type === "stderr") {
          out[event.type] += event.data;
          out.logs += event.data;
          (event.type === "stdout" ? callbacks.onStdout : callbacks.onStderr)?.(event.data);
          callbacks.onLog?.(event.data);
        } else if (event.type === "exit") exit = event;
      }
    };
    try {
      try {
        await run();
      } catch (error) {
        if (timedOut) throw error;
        if (id !== undefined || codeOf(error) !== "sandbox_paused") throw error;
        await this.#ctx.wake();
        await run();
      }
    } catch (error) {
      if (timedOut) throw responseError(422, `process timed out after ${timeout} seconds`);
      throw translate(error);
    } finally {
      clearTimeout(timer);
    }
    const info: ProcessInfo = {
      id: id ?? "",
      kind: "process",
      state: (exit?.state as ProcessInfo["state"]) ?? "exited",
      exitCode: exit?.exitCode ?? null,
      command: line,
      cwd: options.cwd,
      pty: false,
      stdinOpen: false,
      stdinOffset: 0,
      startedAt,
      endedAt: new Date().toISOString(),
      timeoutMs: options.timeoutMs,
      outputBytes: 0,
      firstOffset: 0,
    };
    const done = await this.#settled(this.#response(info, meta, out));
    return { ...done, close: () => abort.abort() };
  }

  /** Waits until every port listens on an address other than loopback, as
   * Blaxel's waitForPorts, in one command inside the sandbox. */
  async #waitForPorts(ports: number[], timeout: number | undefined) {
    const seconds = timeout && timeout > 0 ? timeout : 60;
    for (const port of ports)
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw responseError(400, `invalid port ${port}`);
    const script = portWaitScript(ports, seconds);
    const runtime = await this.#ctx.live();
    const result = await guard(() =>
      runtime.exec(["bash", "-c", script], { timeoutMs: (seconds + 5) * 1000 }),
    );
    if (result.exitCode !== 0)
      throw responseError(422, `process timed out waiting for ports after ${seconds} seconds`);
  }

  /** A keepAlive process seen to end gives the sandbox its idle pause back
   * (when no other runs) before the answer. */
  async #settled(response: ProcessResponse): Promise<ProcessResponse> {
    if (response.keepAlive && response.status !== "running") await this.#ctx.keepAliveEnded();
    return response;
  }

  #response(info: ProcessInfo, meta: Meta | undefined, out: Output): ProcessResponse {
    const parsed = meta ?? metaOf(info);
    const status = statusOf(info.state, info.exitCode);
    return {
      command: parsed.command,
      completedAt: status === "running" ? "" : httpDate(info.endedAt ?? Date.now()),
      exitCode:
        info.exitCode === null ? (status === "running" ? 0 : -1) : Math.max(-1, info.exitCode),
      logs: out.logs,
      name: parsed.name,
      pid: info.id,
      startedAt: httpDate(info.startedAt),
      status,
      stderr: out.stderr,
      stdout: out.stdout,
      workingDir: parsed.workingDir,
      keepAlive: parsed.keepAlive ?? false,
      restartOnFailure: parsed.restartOnFailure ?? false,
      maxRestarts: parsed.maxRestarts ?? 0,
      restartCount: restartsIn(out.logs),
      stdin: parsed.stdin ?? false,
    };
  }

  /** A process by pid or name: the registry first, then Runtime's list. */
  async #find(identifier: string, signal?: AbortSignal): Promise<Found> {
    signal?.throwIfAborted();
    const runtime = await this.#ctx.live();
    signal?.throwIfAborted();
    const registry = this.#registry;
    const known =
      registry.byName.get(identifier) ?? (registry.meta.has(identifier) ? identifier : undefined);
    if (known !== undefined) {
      const process = await this.#retryPaused(
        () => runtime.processes.get(known, { signal }),
        signal,
      );
      signal?.throwIfAborted();
      registry.processes.set(known, process);
      return { id: known, info: process.info, process };
    }
    const all = await this.#retryPaused(() => runtime.processes.list({ signal }), signal);
    signal?.throwIfAborted();
    let found: ProcessInfo | undefined;
    for (const info of all) {
      const parsed = parseProcessLine(info.command);
      const matches = parsed?.name === identifier || info.id === identifier;
      if (matches && (!found || Date.parse(info.startedAt) >= Date.parse(found.startedAt)))
        found = info;
    }
    if (!found) throw responseError(404, "process not found");
    const parsed = parseProcessLine(found.command);
    if (parsed) this.#remember(found.id, { ...metaOf(found), name: parsed.name });
    return { id: found.id, info: found };
  }

  async #process(found: Found): Promise<Process> {
    if (found.process) return found.process;
    const cached = this.#registry.processes.get(found.id);
    if (cached) return cached;
    const runtime = await this.#ctx.live();
    const process = await guard(() => runtime.processes.get(found.id));
    this.#registry.processes.set(found.id, process);
    return process;
  }

  /** The output so far: to the end for a process that has ended, to what it
   * had written when read for one still running. */
  async #output(found: Found, untilExit: boolean, signal?: AbortSignal): Promise<Output> {
    const out: Output = { stdout: "", stderr: "", logs: "" };
    const running = found.info.state === "running";
    if (running && !untilExit && found.info.outputBytes <= found.info.firstOffset) return out;
    signal?.throwIfAborted();
    const runtime = await this.#ctx.live();
    signal?.throwIfAborted();
    const abort = new AbortController();
    const forward = () => abort.abort();
    signal?.throwIfAborted();
    signal?.addEventListener("abort", forward, { once: true });
    try {
      for await (const event of runtime.processes.follow(found.id, {
        cursor: 0,
        signal: abort.signal,
      })) {
        if (event.type === "truncated")
          throw responseError(502, "Some command output is no longer available.");
        if (event.type === "stdout" || event.type === "stderr") {
          out[event.type] += event.data;
          out.logs += event.data;
          const reached = event.offset + Buffer.byteLength(event.data);
          if (running && !untilExit && reached >= found.info.outputBytes) break;
        } else if (event.type === "exit") {
          found.info = {
            ...found.info,
            state: event.state as ProcessInfo["state"],
            exitCode: event.exitCode,
            endedAt: found.info.endedAt ?? new Date().toISOString(),
          };
          break;
        }
      }
      // A follow cut short by the caller's signal ends without its exit.
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw translate(error);
    } finally {
      abort.abort();
      signal?.removeEventListener("abort", forward);
    }
    return out;
  }

  /** The process, with the output it has written so far. */
  async get(
    identifier: string,
    options: { signal?: AbortSignal; retry?: boolean } = {},
  ): Promise<GetProcessByIdentifierResponse> {
    options.signal?.throwIfAborted();
    const signal = options.signal;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Process read was interrupted.", { cause: signal?.reason }));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const reading = (async () => {
        const found = await this.#find(identifier, signal);
        const out = await this.#output(found, false, signal);
        signal?.throwIfAborted();
        return this.#settled(this.#response(found.info, this.#registry.meta.get(found.id), out));
      })();
      return await Promise.race([reading, interrupted]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Waits for the process to end (at most `maxWait` ms, -1 for no limit) and
   * answers it with its output. The process is never stopped by the wait. */
  async wait(
    identifier: string,
    {
      maxWait = 60_000,
      interval = 1000,
      signal,
    }: { maxWait?: number; interval?: number; signal?: AbortSignal } = {},
  ): Promise<GetProcessByIdentifierResponse> {
    if (
      !Number.isFinite(maxWait) ||
      (maxWait < 0 && maxWait !== -1) ||
      !Number.isFinite(interval) ||
      interval <= 0
    )
      throw new RangeError(
        "maxWait must be -1 or finite and non-negative; interval must be finite and positive",
      );
    signal?.throwIfAborted();
    const late = () =>
      new Error(`Process did not finish in time (${identifier}); it may still be running`);
    if (maxWait === 0) throw late();
    const abort = new AbortController();
    const forward = () => abort.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", forward, { once: true });
    const timer = maxWait === -1 ? undefined : setTimeout(() => abort.abort(late()), maxWait);
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => {
        const reason: unknown = abort.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error("Process wait was interrupted.", { cause: reason }),
        );
      };
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = (async () => {
        const found = await this.#find(identifier, abort.signal);
        const out = await this.#output(found, true, abort.signal);
        abort.signal.throwIfAborted();
        return await this.#settled(
          this.#response(found.info, this.#registry.meta.get(found.id), out),
        );
      })();
      return await Promise.race([result, interrupted]);
    } catch (error) {
      if (abort.signal.aborted) throw abort.signal.reason ?? error;
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) abort.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", forward);
    }
  }

  /** Every process started through this adapter, running or ended. Their
   * output is left empty: read one with get() or logs(). */
  async list(): Promise<GetProcessResponse> {
    const runtime = await this.#ctx.live();
    const all = await this.#retryPaused(() => runtime.processes.list());
    const registry = this.#registry;
    return all
      .filter((info) => registry.meta.has(info.id) || parseProcessLine(info.command))
      .map((info) =>
        this.#response(info, registry.meta.get(info.id), { stdout: "", stderr: "", logs: "" }),
      );
  }

  /** SIGTERM. */
  async stop(identifier: string): Promise<DeleteProcessByIdentifierResponse> {
    await this.#signal(identifier, "SIGTERM");
    return { message: "Process stop requested" };
  }

  /** SIGKILL. */
  async kill(identifier: string): Promise<DeleteProcessByIdentifierKillResponse> {
    await this.#signal(identifier, "SIGKILL");
    return { message: "Process kill requested" };
  }

  /** Signals the process. A keepAlive one is given up to 2 s to end, and then
   * the sandbox gets its idle pause back when no other runs. */
  async #signal(identifier: string, signal: "SIGTERM" | "SIGKILL") {
    const found = await this.#find(identifier);
    const process = await this.#process(found);
    await guard(() => process.kill(signal));
    const meta = this.#registry.meta.get(found.id) ?? metaOf(found.info);
    if (!meta.keepAlive) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2000);
    try {
      await this.#output(
        { ...found, info: { ...found.info, state: "running" } },
        true,
        abort.signal,
      );
    } catch {
      // Still ending after 2 s: the next check gives the idle pause back.
    } finally {
      clearTimeout(timer);
    }
    await this.#ctx.keepAliveEnded();
  }

  /** Bytes to the standard input of a process started with `stdin: true`,
   * sent as they are. */
  async writeStdin(identifier: string, data: string | Uint8Array): Promise<void> {
    const process = await this.#process(await this.#find(identifier));
    await guard(() => process.write(data));
  }

  /** Closes the process's standard input (EOF). */
  async closeStdin(identifier: string): Promise<void> {
    const process = await this.#process(await this.#find(identifier));
    await guard(() => process.write("", { eof: true }));
  }

  /** The output so far: both streams in the order written ("all"), or one. */
  async logs(identifier: string, type: "stdout" | "stderr" | "all" = "all"): Promise<string> {
    if (type !== "all" && type !== "stdout" && type !== "stderr")
      throw new Error("Unsupported log type");
    const found = await this.#find(identifier);
    const out = await this.#output(found, false);
    return type === "all" ? out.logs : out[type];
  }

  /** Follows the output from the start until the process ends, a line at a
   * time, as Blaxel's streamLogs. `close()` stops following. */
  streamLogs(
    identifier: string,
    options: {
      onLog?: (log: string) => void;
      onStdout?: (stdout: string) => void;
      onStderr?: (stderr: string) => void;
      onError?: (error: Error) => void;
    } = {},
  ): { close: () => void; wait: () => Promise<void> } {
    const abort = new AbortController();
    const partial = { stdout: "", stderr: "" };
    const emit = (stream: "stdout" | "stderr", line: string) => {
      (stream === "stdout" ? options.onStdout : options.onStderr)?.(line);
      options.onLog?.(line);
    };
    const done = (async () => {
      try {
        const found = await this.#find(identifier);
        const runtime = await this.#ctx.live();
        for await (const event of runtime.processes.follow(found.id, {
          cursor: 0,
          signal: abort.signal,
        })) {
          if (event.type === "truncated")
            throw responseError(502, "Some command output is no longer available.");
          if (event.type === "stdout" || event.type === "stderr") {
            const lines = (partial[event.type] + event.data).split(/\r?\n/);
            partial[event.type] = lines.pop()!;
            for (const line of lines) emit(event.type, line);
          } else if (event.type === "exit") break;
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        const failure = translate(error);
        const asError = failure instanceof Error ? failure : new Error(String(failure));
        options.onError?.(asError);
        throw asError;
      } finally {
        for (const stream of ["stdout", "stderr"] as const)
          if (partial[stream].trim()) emit(stream, partial[stream]);
      }
    })();
    void done.catch(() => undefined);
    return { close: () => abort.abort(), wait: () => done };
  }
}

/** What a process's recorded command says about it, when this adapter did
 * not start it in this client. */
function metaOf(info: ProcessInfo): Meta {
  const parsed = parseProcessLine(info.command);
  return {
    name: parsed?.name ?? info.id,
    command: parsed?.command ?? info.command,
    workingDir: info.cwd === RUNTIME_HOME ? "" : toBlaxelPath(info.cwd),
    ...(parsed?.keepAlive ? { keepAlive: true } : {}),
  };
}

/** Output a waited process already wrote, given to the callbacks line by line. */
function replay(
  done: ProcessResponse,
  callbacks: Pick<ProcessRequestWithLog, "onLog" | "onStdout" | "onStderr">,
) {
  for (const line of done.stdout.split("\n").filter(Boolean)) callbacks.onStdout?.(line);
  for (const line of done.stderr.split("\n").filter(Boolean)) callbacks.onStderr?.(line);
  for (const line of done.logs.split("\n").filter(Boolean)) callbacks.onLog?.(line);
}
