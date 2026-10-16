import { createHash } from "node:crypto";
import { Runtime } from "../client.js";
import { NotFoundError } from "../errors.js";
import { timeoutSignal } from "../transport.js";
import type { Process as NativeProcess, Sandbox as NativeSandbox } from "../sandbox.js";
import {
  quote,
  client,
  closeShell,
  CompatibilityError,
  refuse,
  type Refused,
  type RefusedAsync,
  destroy,
  environment,
  execOptions,
  only,
  pathAt,
  saveEnvironment,
  shellCommand,
  shellRoot,
  type ClientOptions,
} from "../compat/core.js";
import {
  BucketUnmountError,
  InvalidMountConfigError,
  ProcessExitedBeforeReadyError,
  ProcessReadyTimeoutError,
  S3FSMountError,
  response,
} from "./errors.js";
import {
  CodeInterpreter,
  hasEnv,
  RUN_ENV,
  type CodeContext,
  type CreateContextOptions,
  type RunCodeOptions,
} from "./interpreter.js";
import { sseStream, type FileStreamEvent } from "./streams.js";
import { CHANGES, watchFilters } from "./watch.js";
export { CompatibilityError };
export * from "./errors.js";
export { CodeInterpreter } from "./interpreter.js";
export type {
  CodeContext,
  CreateContextOptions,
  ExecutionError,
  OutputMessage,
  RunCodeOptions,
} from "./interpreter.js";
export {
  collectFile,
  isExecResult,
  isProcess,
  isProcessStatus,
  parseSSEStream,
  streamFile,
} from "./streams.js";
export type { FileChunk, FileMetadata, FileStreamEvent } from "./streams.js";
export class SandboxSecurityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SandboxSecurityError";
  }
}
export function sanitizeSandboxId(id: string) {
  if (!id || id.length > 63)
    throw new SandboxSecurityError(
      "Sandbox ID must be 1-63 characters long.",
      "INVALID_SANDBOX_ID_LENGTH",
    );
  if (id.startsWith("-") || id.endsWith("-"))
    throw new SandboxSecurityError(
      "Sandbox ID cannot start or end with hyphens (DNS requirement).",
      "INVALID_SANDBOX_ID_HYPHENS",
    );
  if (["www", "api", "admin", "root", "system", "cloudflare", "workers"].includes(id.toLowerCase()))
    throw new SandboxSecurityError(
      `Reserved sandbox ID '${id}' is not allowed.`,
      "RESERVED_SANDBOX_ID",
    );
  return id;
}
export interface SandboxOptions {
  sleepAfter?: string | number;
  keepAlive?: boolean;
  normalizeId?: boolean;
  runtime?: ClientOptions;
}
export interface ExecOptions {
  timeout?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  encoding?: string;
  stream?: boolean;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
  onComplete?: (result: ExecResult) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
  /** Cloudflare's log level for the command; it changes nothing else. */
  origin?: "user" | "internal";
}
export interface StreamOptions extends Omit<
  ExecOptions,
  "stream" | "onOutput" | "onComplete" | "onError"
> {
  sessionId?: string;
  /** Accepted as Cloudflare accepts it: its SDK does not use it either. */
  bufferSize?: number;
}
export interface WatchOptions {
  recursive?: boolean;
  include?: string[];
  exclude?: string[];
  sessionId?: string;
}
export interface CheckChangesOptions extends WatchOptions {
  since?: string;
}
export type CheckChangesResult =
  | { success: true; status: "unchanged" | "changed"; version: string; timestamp: string }
  | {
      success: true;
      status: "resync";
      reason: "expired" | "restarted";
      version: string;
      timestamp: string;
    };
export interface GitCheckoutResult {
  success: boolean;
  repoUrl: string;
  branch: string;
  targetDir: string;
  timestamp: string;
  exitCode?: number;
}
export type BucketProvider = "r2" | "s3" | "gcs";
export interface MountBucketOptions {
  endpoint?: string;
  provider?: BucketProvider;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  readOnly?: boolean;
  s3fsOptions?: string[];
  prefix?: string;
  credentialProxy?: boolean;
  localBucket?: boolean;
}
export interface ExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  duration: number;
  timestamp: string;
  sessionId?: string;
}
export interface ReadFileResult {
  success: boolean;
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  isBinary: boolean;
  size: number;
  timestamp: string;
}
export interface ReadFileStreamResult {
  success: true;
  path: string;
  content: ReadableStream<Uint8Array>;
  size: number;
  mimeType: string;
  timestamp: string;
}
export interface SessionOptions {
  id?: string;
  name?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  isolation?: boolean;
  commandTimeoutMs?: number;
}
export interface ProcessOptions {
  timeout?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  encoding?: string;
  sessionId?: string;
  processId?: string;
  autoCleanup?: boolean;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
  onExit?: (code: number | null) => void;
  onStart?: (process: Process) => void;
  onError?: (error: Error) => void;
}
const cleanEnv = (env: Record<string, string | undefined> = {}) =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
function sleepSeconds(value: string | number = 600) {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else {
    const match = /^(\d+)(s|m|h)$/.exec(value);
    if (!match) throw new TypeError("sleepAfter must be seconds or a duration such as 5m");
    seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2]!] ?? 1);
  }
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86_400)
    throw new CompatibilityError("Cloudflare", "sleepAfter outside whole seconds from 0 to 86400");
  return seconds;
}

export function validateSandboxConfiguration(
  options: Pick<SandboxOptions, "sleepAfter" | "keepAlive">,
): void {
  if (options.sleepAfter !== undefined) sleepSeconds(options.sleepAfter);
  if (options.keepAlive !== undefined && typeof options.keepAlive !== "boolean")
    throw new TypeError("keepAlive must be a boolean");
}
/** Worker bindings are deliberately not inspected or invoked. Supply Runtime credentials
 * through options.runtime in Workers; Node also supports RUNTIME_API_KEY/login. */
export function getSandbox(namespace: unknown, id: string, options: SandboxOptions = {}) {
  sanitizeSandboxId(id);
  only("Cloudflare getSandbox", options, ["sleepAfter", "keepAlive", "normalizeId", "runtime"]);
  const runtime = namespace instanceof Runtime ? namespace : client(options.runtime);
  return new Sandbox(runtime, options.normalizeId ? id.toLowerCase() : id, options);
}
export class Sandbox {
  private pending?: Promise<NativeSandbox>;
  private existing?: NativeSandbox;
  readonly id: string;
  /** The port Cloudflare's container serves on; Runtime previews any port. */
  readonly defaultPort = 3000;
  /** What setEnvVars gave this handle; the sandbox keeps them for every command. */
  envVars: Record<string, string> = {};
  readonly #interpreter = new CodeInterpreter(this);
  // Durable Object and Worker plumbing Runtime has no counterpart for.
  declare readonly client: Refused;
  declare readonly tunnels: Refused;
  declare readonly callTunnels: RefusedAsync;
  declare readonly setSandboxName: RefusedAsync;
  declare readonly setContainerTimeouts: RefusedAsync;
  declare readonly setTransport: RefusedAsync;
  declare readonly onStart: RefusedAsync;
  declare readonly onStop: RefusedAsync;
  declare readonly onError: Refused;
  declare readonly onActivityExpired: RefusedAsync;
  declare readonly fetch: RefusedAsync;
  declare readonly containerFetch: RefusedAsync;
  declare readonly wsConnect: RefusedAsync;
  declare readonly getContainerPlacementId: RefusedAsync;
  declare readonly validatePortToken: RefusedAsync;
  declare readonly createBackup: RefusedAsync;
  declare readonly restoreBackup: RefusedAsync;
  constructor(
    readonly runtime: Runtime,
    id: string,
    private readonly options: SandboxOptions = {},
  ) {
    validateSandboxConfiguration(options);
    this.id = id;
  }
  get sleepAfter(): string | number {
    return this.options.sleepAfter ?? "10m";
  }
  setSleepAfter(sleepAfter: string | number) {
    return this.configure({ sleepAfter });
  }
  setKeepAlive(keepAlive: boolean) {
    return this.configure({ keepAlive });
  }
  /** Replaces the sandbox's labels, as Cloudflare's does. */
  async setLabels(labels: Record<string, string>) {
    for (const [key, value] of Object.entries(labels))
      if (typeof value !== "string") throw new TypeError(`Label ${key} must be a string`);
    await (await this.native()).update({ labels: { ...labels, "compat.provider": "cloudflare" } });
  }
  async configure(options: Pick<SandboxOptions, "sleepAfter" | "keepAlive">) {
    only("Cloudflare configure", options, ["sleepAfter", "keepAlive"]);
    validateSandboxConfiguration(options);
    const changed =
      (options.sleepAfter !== undefined && options.sleepAfter !== this.options.sleepAfter) ||
      (options.keepAlive !== undefined && options.keepAlive !== this.options.keepAlive);
    const next = { ...this.options, ...options };
    if (changed && this.pending) {
      const s = await this.pending;
      await s.update({
        idlePauseSeconds: next.keepAlive ? 0 : sleepSeconds(next.sleepAfter),
        ...(options.keepAlive !== undefined ? { persistent: options.keepAlive } : {}),
      });
    }
    Object.assign(this.options, options);
  }
  /** Only a successfully initialized native handle can supply a recovery id. */
  existingNativeId(): string | undefined {
    return this.existing?.id;
  }
  /** Reconcile an uncertain update from an authoritative read, without allocation. */
  async reconcileConfiguration(nativeId = this.existingNativeId()) {
    if (!nativeId)
      throw new Error("The uncertain Runtime configuration has no existing sandbox identity.");
    const sandbox = await this.runtime.sandboxes.get(nativeId);
    const { idlePauseSeconds, persistent } = sandbox.info;
    if (
      typeof idlePauseSeconds !== "number" ||
      !Number.isSafeInteger(idlePauseSeconds) ||
      idlePauseSeconds < 0 ||
      idlePauseSeconds > 86_400 ||
      typeof persistent !== "boolean"
    )
      throw new Error("Runtime did not return authoritative idle and persistence settings.");
    const configuration = { sleepAfter: idlePauseSeconds, keepAlive: persistent };
    Object.assign(this.options, configuration);
    this.existing = sandbox;
    this.pending = Promise.resolve(sandbox);
    return configuration;
  }
  async native() {
    if (!this.pending) {
      this.pending = (async () => {
        const s = await this.runtime.sandboxes.create({
          name: /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(this.id)
            ? this.id
            : `cf-${createHash("sha256").update(this.id).digest("hex").slice(0, 40)}`,
          getOrCreate: true,
          labels: { "compat.provider": "cloudflare" },
          idlePauseSeconds: this.options.keepAlive ? 0 : sleepSeconds(this.options.sleepAfter),
          persistent: !!this.options.keepAlive,
        });
        if (!s.info.reused) {
          try {
            await saveEnvironment(s, {});
          } catch (e) {
            await destroy(s);
            throw e;
          }
        }
        this.existing = s;
        return s;
      })();
      this.pending.catch(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }
  private session(id = `sandbox-${this.id}`, options: SessionOptions = {}) {
    return new ExecutionSession(this, id, options);
  }
  /** A session by id: its saved settings, or a fresh session of that id, as
   * Cloudflare starts one again after its shell ended. */
  private async sessionFor(id?: string) {
    if (id === undefined || id === `sandbox-${this.id}`) return this.session();
    try {
      return await this.getSession(id);
    } catch (error) {
      if (error instanceof NotFoundError) return this.session(id);
      throw error;
    }
  }
  exec(command: string, options?: ExecOptions) {
    return this.session().exec(command, options);
  }
  async execWithSessionToken(command: string, sessionId: string, options?: ExecOptions) {
    return (await this.sessionFor(sessionId)).exec(command, options);
  }
  async execStream(command: string, options: StreamOptions = {}) {
    const { sessionId, bufferSize, ...rest } = options;
    if (bufferSize !== undefined && (!Number.isSafeInteger(bufferSize) || bufferSize <= 0))
      throw new TypeError("bufferSize must be a positive integer");
    return (await this.sessionFor(sessionId)).execStream(command, rest);
  }
  execStreamWithSessionToken(command: string, sessionId: string, options: StreamOptions = {}) {
    return this.execStream(command, { ...options, sessionId });
  }
  async startProcess(command: string, options: ProcessOptions = {}) {
    if (options.processId !== undefined)
      throw new CompatibilityError("Cloudflare", "processId; Runtime names each process itself");
    if (options.autoCleanup)
      throw new CompatibilityError(
        "Cloudflare",
        "autoCleanup; Runtime keeps a finished process's record and output until the sandbox ends",
      );
    const { autoCleanup: _kept, ...rest } = options;
    return this.session(options.sessionId).startProcess(command, rest);
  }
  async createSession(options: SessionOptions = {}) {
    only("Cloudflare session", options, [
      "id",
      "name",
      "env",
      "cwd",
      "isolation",
      "commandTimeoutMs",
    ]);
    if (options.isolation)
      throw new CompatibilityError("Cloudflare", "session PID namespace isolation");
    const id = options.id ?? crypto.randomUUID();
    await (
      await this.native()
    ).files.write(
      `/workspace/.runtime-compat/cloudflare/${encodeURIComponent(id)}.json`,
      JSON.stringify(options),
      { mode: 0o600 },
    );
    return this.session(id, options);
  }
  async getSession(id: string) {
    if (id === `sandbox-${this.id}`) return this.session();
    const options = JSON.parse(
      await (
        await this.native()
      ).files.readText(`/workspace/.runtime-compat/cloudflare/${encodeURIComponent(id)}.json`),
    ) as SessionOptions;
    return this.session(id, options);
  }
  async deleteSession(id: string) {
    if (id === `sandbox-${this.id}`)
      throw new Error("The default session cannot be deleted; destroy the sandbox instead");
    await closeShell(await this.native(), `cf:${id}`);
    await (
      await this.native()
    ).files.remove(`/workspace/.runtime-compat/cloudflare/${encodeURIComponent(id)}.json`);
    return { success: true, sessionId: id, timestamp: new Date().toISOString() };
  }
  async destroy() {
    await destroy(await this.native());
    this.pending = undefined;
  }
  async setEnvVars(env: Record<string, string | undefined>) {
    const s = await this.native();
    await saveEnvironment(s, { ...(await environment(s)), ...cleanEnv(env) });
    this.envVars = { ...this.envVars, ...cleanEnv(env) };
  }
  /** Stops the sandbox; its files stay, and the next call starts it again. */
  async stop(signal?: unknown) {
    if (signal !== undefined)
      throw new CompatibilityError("Cloudflare", "a stop signal; Runtime stops every process");
    await (await this.native()).stop();
  }
  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options: { encoding?: string; sessionId?: string } = {},
  ) {
    const { sessionId, ...rest } = options;
    return (await this.sessionFor(sessionId)).writeFile(path, content, rest);
  }
  readFile(
    path: string,
    options: { encoding: "none"; sessionId?: string },
  ): Promise<ReadFileStreamResult>;
  readFile(
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64"; sessionId?: string },
  ): Promise<ReadFileResult>;
  async readFile(
    path: string,
    options: { encoding?: "utf8" | "utf-8" | "base64" | "none"; sessionId?: string } = {},
  ): Promise<ReadFileResult | ReadFileStreamResult> {
    const { sessionId, encoding } = options;
    const session = await this.sessionFor(sessionId);
    return encoding === "none"
      ? session.readFile(path, { encoding: "none" })
      : session.readFile(path, { encoding });
  }
  /** The file as Cloudflare streams it: `data:` lines of a metadata event,
   * chunks (base64 for a binary file) and a complete event; read it with
   * streamFile() or collectFile(). */
  async readFileStream(path: string, options: { sessionId?: string } = {}) {
    const read = await this.readFile(path, { encoding: "none", sessionId: options.sessionId });
    const bytes = new Uint8Array(await new Response(read.content).arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const isBinary = text.includes("\0") || text.includes("\ufffd");
    return sseStream<FileStreamEvent>(async (send) => {
      send({
        type: "metadata",
        mimeType: isBinary ? "application/octet-stream" : "text/plain",
        size: bytes.length,
        isBinary,
        encoding: isBinary ? "base64" : "utf-8",
      });
      const CHUNK = 65_536;
      if (isBinary)
        for (let i = 0; i < bytes.length; i += CHUNK) {
          let raw = "";
          for (const byte of bytes.subarray(i, i + CHUNK)) raw += String.fromCharCode(byte);
          send({ type: "chunk", data: btoa(raw) });
        }
      else
        for (let i = 0; i < text.length; i += CHUNK)
          send({ type: "chunk", data: text.slice(i, i + CHUNK) });
      send({ type: "complete", bytesRead: bytes.length });
    });
  }
  async mkdir(path: string, options: { recursive?: boolean; sessionId?: string } = {}) {
    const { sessionId, ...rest } = options;
    return (await this.sessionFor(sessionId)).mkdir(path, rest);
  }
  async deleteFile(path: string, sessionId?: string) {
    return (await this.sessionFor(sessionId)).deleteFile(path);
  }
  async renameFile(from: string, to: string, sessionId?: string) {
    return (await this.sessionFor(sessionId)).renameFile(from, to);
  }
  moveFile(from: string, to: string, sessionId?: string) {
    return this.renameFile(from, to, sessionId);
  }
  async listFiles(
    path: string,
    options: { recursive?: boolean; includeHidden?: boolean; sessionId?: string } = {},
  ) {
    const { sessionId, ...rest } = options;
    return (await this.sessionFor(sessionId)).listFiles(path, rest);
  }
  async exists(path: string, sessionId?: string) {
    return (await this.sessionFor(sessionId)).exists(path);
  }
  async listProcesses() {
    const s = await this.native();
    return Promise.all(
      (await s.processes.list()).map((p) =>
        s.processes.get(p.id).then((p) => new Process(this, p)),
      ),
    );
  }
  async getProcess(id: string) {
    try {
      return new Process(this, await (await this.native()).processes.get(id));
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }
  async killProcess(id: string, signal = "SIGTERM") {
    const p = await this.getProcess(id);
    if (!p) throw new Error(`Process ${id} not found`);
    await p.kill(signal);
  }
  async killAllProcesses() {
    const processes = (await this.listProcesses()).filter((p) => p.status === "running");
    await Promise.all(processes.map((p) => p.kill()));
    return processes.length;
  }
  async getProcessLogs(id: string) {
    const s = await this.native();
    let cursor = 0;
    let stdout = "",
      stderr = "";
    for (;;) {
      const r = await this.runtime.transport.json<{
        chunks: { stream: string; text: string }[];
        truncated: boolean;
        nextCursor: number;
      }>({
        method: "GET",
        path: `/v1/sandboxes/${encodeURIComponent(s.id)}/processes/${encodeURIComponent(id)}/output`,
        query: { cursor, maxBytes: 196608 },
      });
      if (r.truncated) throw new Error("Process logs were truncated by the host");
      for (const c of r.chunks) {
        if (c.stream === "stdout") stdout += c.text;
        else stderr += c.text;
      }
      if (r.chunks.length === 0 || r.nextCursor <= cursor) break;
      cursor = r.nextCursor;
    }
    return { stdout, stderr, processId: id };
  }
  async exposePort(port: number, options: { name?: string; hostname: string; token?: string }) {
    only("Cloudflare exposePort", options, ["name", "hostname", "token"]);
    if (options.token) throw new CompatibilityError("Cloudflare", "caller-chosen preview tokens");
    const p = await (await this.native()).previews.create(port);
    // Cloudflare's hostname routes through its Worker. Runtime returns its own signed URL.
    return { url: p.urlWithToken ?? p.url, port, name: options.name };
  }
  async unexposePort(port: number) {
    await (await this.native()).previews.delete(port);
  }
  /** Runtime's previews have their own addresses: hostname is not used to build them. */
  async getExposedPorts(_hostname: string) {
    return (await (await this.native()).previews.list()).map((p) => ({
      url: p.urlWithToken ?? p.url,
      port: p.port,
      status: "active" as const,
    }));
  }
  async isPortExposed(port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    return (await (await this.native()).previews.list()).some((p) => p.port === port);
  }
  /** Cloudflare's returns 0 too: a process's record outlives it on both. */
  async cleanupCompletedProcesses(_sessionId?: string) {
    return 0;
  }
  /** The process's output as `data:` lines of stdout, stderr and exit events. */
  async streamProcessLogs(processId: string, options: { signal?: AbortSignal } = {}) {
    only("Cloudflare streamProcessLogs", options, ["signal"]);
    options.signal?.throwIfAborted();
    const p = await (await this.native()).processes.get(processId);
    return sseStream<Record<string, unknown>>(async (send, cancelled) => {
      const signal = options.signal ? AbortSignal.any([options.signal, cancelled]) : cancelled;
      for await (const e of p.output({ signal })) {
        const at = new Date().toISOString();
        if (e.type === "stdout" || e.type === "stderr")
          send({ type: e.type, timestamp: at, data: e.data, processId });
        else if (e.type === "exit")
          send({ type: "exit", timestamp: at, data: "", processId, exitCode: e.exitCode });
        else if (e.type === "truncated")
          send({ type: "error", timestamp: at, data: "Process output was truncated", processId });
      }
    });
  }
  /** Clones with git in the sandbox, as Cloudflare's container does. */
  async gitCheckout(
    repoUrl: string,
    options: {
      branch?: string;
      targetDir?: string;
      sessionId?: string;
      depth?: number;
      cloneTimeoutMs?: number;
    } = {},
  ): Promise<GitCheckoutResult> {
    only("Cloudflare gitCheckout", options, [
      "branch",
      "targetDir",
      "sessionId",
      "depth",
      "cloneTimeoutMs",
    ]);
    const timeout = options.cloneTimeoutMs ?? 600_000;
    if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth <= 0))
      throw new Error(
        `Invalid depth value: ${options.depth}. Must be a positive integer (e.g., 1, 5, 10).`,
      );
    if (!Number.isInteger(timeout) || timeout <= 0)
      throw new Error(
        `Invalid timeout value: ${timeout}. Must be a positive integer number of milliseconds.`,
      );
    const name =
      repoUrl
        .replace(/\/+$/, "")
        .split(/[/:]/)
        .pop()
        ?.replace(/\.git$/, "") || "repo";
    const targetDir = options.targetDir ?? `/workspace/${name}`;
    const session = await this.sessionFor(options.sessionId);
    const args = [
      "git clone",
      ...(options.branch ? ["--branch", quote(options.branch)] : []),
      ...(options.depth ? ["--depth", String(options.depth)] : []),
      "--",
      quote(repoUrl),
      quote(targetDir),
    ];
    const clone = await session.exec(
      `${args.join(" ")} && git -C ${quote(targetDir)} rev-parse --abbrev-ref HEAD`,
      { timeout },
    );
    if (!clone.success)
      throw new Error(`Failed to clone ${repoUrl}: ${clone.stderr.trim() || clone.stdout.trim()}`);
    return {
      success: true,
      repoUrl,
      branch: options.branch ?? clone.stdout.trim().split("\n").pop()!,
      targetDir,
      timestamp: new Date().toISOString(),
      exitCode: clone.exitCode,
    };
  }
  /** Changes under a directory as `data:` lines of Cloudflare's watch events,
   * once the watch is established, until the stream is cancelled. */
  async watch(path: string, options: WatchOptions = {}): Promise<ReadableStream<Uint8Array>> {
    only("Cloudflare watch", options, ["recursive", "include", "exclude", "sessionId"]);
    const filters = watchFilters(options);
    const directory = await (await this.sessionFor(options.sessionId)).resolve(path);
    const encode = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const send = (event: object) => {
      if (!closed) stream.enqueue(encode.encode(`data: ${JSON.stringify(event)}\n\n`));
    };
    const handle = await (
      await this.native()
    ).files.watch(
      directory,
      (e) => {
        const timestamp = new Date().toISOString();
        const event = (eventType: string, at: string) =>
          send({ type: "event", eventType, path: at, isDirectory: e.isDir, timestamp });
        if (e.type === "rename") {
          if (e.oldPath) event("move_from", e.oldPath);
          event("move_to", e.path);
        } else
          event(
            { create: "create", write: "modify", remove: "delete", chmod: "attrib" }[
              e.type as string
            ] ?? e.type,
            e.path,
          );
      },
      {
        recursive: options.recursive ?? true,
        ...filters,
        timeoutMs: 0,
        onNotice: (n) =>
          send({ type: "error", error: n.k === "overflow" ? "Events were lost" : `Watch ${n.k}` }),
        onExit: (reason) => {
          send({ type: "stopped", reason });
          if (!closed) {
            closed = true;
            stream.close();
          }
        },
      },
    );
    return new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        send({ type: "watching", path: directory, watchId: handle.id });
      },
      async cancel() {
        closed = true;
        await handle.stop();
      },
    });
  }
  /** Whether anything under a path changed since a version this returned:
   * the version is a digest of every entry's path, size, time and mode, tied
   * to this boot of the sandbox. */
  async checkChanges(path: string, options: CheckChangesOptions = {}): Promise<CheckChangesResult> {
    only("Cloudflare checkChanges", options, [
      "since",
      "recursive",
      "include",
      "exclude",
      "sessionId",
    ]);
    const filters = watchFilters(options);
    const session = await this.sessionFor(options.sessionId);
    const r = await (
      await this.native()
    ).exec([
      "python3",
      "-c",
      CHANGES,
      await session.resolve(path),
      options.recursive === false ? "0" : "1",
      JSON.stringify(filters.include ?? []),
      JSON.stringify(filters.exclude ?? []),
    ]);
    if (r.exitCode !== 0) throw new Error(`checkChanges failed: ${r.stderr.trim()}`);
    const version = r.stdout.trim();
    const timestamp = new Date().toISOString();
    if (options.since === undefined || options.since === version)
      return {
        success: true,
        status: options.since === undefined ? "changed" : "unchanged",
        version,
        timestamp,
      };
    return options.since.split(".")[0] === version.split(".")[0]
      ? { success: true, status: "changed", version, timestamp }
      : { success: true, status: "resync", reason: "restarted", version, timestamp };
  }
  /** Mounts an S3, R2 or Google Cloud Storage bucket with Runtime's mounts. A
   * private bucket needs a Runtime secret: store its keys with
   * runtime.secrets.set and mount with sandbox.mounts.add({ secret }). */
  async mountBucket(bucket: string, mountPath: string, options: MountBucketOptions) {
    only("Cloudflare mountBucket", options, [
      "endpoint",
      "provider",
      "credentials",
      "readOnly",
      "s3fsOptions",
      "prefix",
      "credentialProxy",
      "localBucket",
    ]);
    if (options.credentials || options.credentialProxy)
      throw new CompatibilityError(
        "Cloudflare",
        "credentials in mountBucket; store them with runtime.secrets.set and mount with sandbox.mounts.add({ secret })",
      );
    if (options.s3fsOptions?.length)
      throw new CompatibilityError("Cloudflare", "s3fsOptions; Runtime mounts with its own client");
    if (options.localBucket || options.endpoint === undefined)
      throw new CompatibilityError(
        "Cloudflare",
        "an R2 binding; give the bucket's endpoint, https://<account>.r2.cloudflarestorage.com",
      );
    if (!mountPath.startsWith("/"))
      throw new InvalidMountConfigError(`Mount path must be absolute: ${mountPath}`);
    let host: string;
    try {
      host = new URL(options.endpoint).hostname;
    } catch {
      throw new InvalidMountConfigError(`Invalid endpoint URL: ${options.endpoint}`);
    }
    const r2 = /^([a-f0-9]{32})\.r2\.cloudflarestorage\.com$/.exec(host);
    const provider =
      options.provider ?? (r2 ? "r2" : host === "storage.googleapis.com" ? "gcs" : "s3");
    const prefix = options.prefix?.replace(/^\/+|\/+$/g, "") || undefined;
    try {
      await (
        await this.native()
      ).mounts.add({
        provider,
        bucket,
        path: mountPath,
        ...(prefix ? { prefix } : {}),
        ...(provider === "r2" && r2
          ? { accountId: r2[1] }
          : provider === "gcs"
            ? {}
            : { endpoint: `https://${host}` }),
        ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
      });
    } catch (error) {
      throw new S3FSMountError(
        `Failed to mount ${bucket} at ${mountPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async unmountBucket(mountPath: string) {
    try {
      await (await this.native()).mounts.remove(mountPath);
    } catch (error) {
      throw new BucketUnmountError(
        `Failed to unmount ${mountPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  createCodeContext(options?: CreateContextOptions): Promise<CodeContext> {
    return this.#interpreter.createCodeContext(options);
  }
  async runCode(code: string, options: RunCodeOptions = {}) {
    if (hasEnv(options.envVars)) throw new CompatibilityError("Cloudflare", RUN_ENV);
    return (await this.#interpreter.runCode(code, options)).toJSON();
  }
  runCodeStream(code: string, options: RunCodeOptions = {}) {
    if (hasEnv(options.envVars)) throw new CompatibilityError("Cloudflare", RUN_ENV);
    return this.#interpreter.runCodeStream(code, options);
  }
  listCodeContexts() {
    return this.#interpreter.listCodeContexts();
  }
  deleteCodeContext(contextId: string) {
    return this.#interpreter.deleteCodeContext(contextId);
  }
}
refuse("Cloudflare", "Sandbox", Sandbox, {
  client: "Runtime's API is the client; use the Sandbox methods",
  tunnels: "use exposePort for a public URL",
  callTunnels: "use exposePort for a public URL",
  setSandboxName: "the name is getSandbox's id",
  setContainerTimeouts: "Runtime starts a sandbox in under a second, with nothing to tune",
  setTransport: "Runtime's API is the only transport",
  onStart: "a Runtime sandbox has no Durable Object lifecycle hooks",
  onStop: "a Runtime sandbox has no Durable Object lifecycle hooks",
  onActivityExpired: "set sleepAfter or keepAlive instead",
  fetch: "fetch the URL exposePort returns",
  containerFetch: "fetch the URL exposePort returns",
  wsConnect: "connect to the URL exposePort returns",
  getContainerPlacementId: "a Runtime sandbox's id is its place",
  validatePortToken: "Runtime checks preview tokens itself",
  createBackup: "snapshot the sandbox with Runtime's snapshots, or keep the folder on a volume",
  restoreBackup: "create a sandbox from a Runtime snapshot",
});
refuse(
  "Cloudflare",
  "Sandbox",
  Sandbox,
  { onError: "a Runtime sandbox has no Durable Object lifecycle hooks" },
  { sync: true },
);

/** Cloudflare's Worker-side terminal proxy has no Runtime counterpart. */
export async function proxyTerminal(..._args: unknown[]): Promise<Response> {
  throw new CompatibilityError(
    "Cloudflare",
    "proxyTerminal; open a terminal with the native Runtime sandbox's terminal()",
  );
}
/** Runtime previews are served by Runtime, not through your Worker. */
export async function proxyToSandbox(..._args: unknown[]): Promise<Response | null> {
  throw new CompatibilityError(
    "Cloudflare",
    "proxyToSandbox; Runtime serves the URLs exposePort returns itself",
  );
}
export class ExecutionSession {
  constructor(
    private readonly sandbox: Sandbox,
    readonly id: string,
    private options: SessionOptions,
  ) {}
  private async context(options: ExecOptions = {}) {
    only("Cloudflare exec", options, [
      "timeout",
      "env",
      "cwd",
      "encoding",
      "stream",
      "onOutput",
      "onComplete",
      "onError",
      "signal",
      "origin",
    ]);
    if (options.origin !== undefined && !["user", "internal"].includes(options.origin))
      throw new TypeError("origin is user or internal");
    if (options.encoding && !["utf8", "utf-8"].includes(options.encoding))
      throw new CompatibilityError("Cloudflare", `process encoding ${options.encoding}`);
    const s = await this.sandbox.native();
    return {
      s,
      options: await execOptions(s, {
        cwd: options.cwd ?? this.options.cwd,
        env: { ...cleanEnv(this.options.env), ...cleanEnv(options.env) },
        timeoutMs: options.timeout ?? this.options.commandTimeoutMs,
        signal: options.signal,
        onStdout: (data) => {
          if (options.stream) options.onOutput?.("stdout", data);
        },
        onStderr: (data) => {
          if (options.stream) options.onOutput?.("stderr", data);
        },
      }),
    };
  }
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    const started = Date.now();
    try {
      const c = await this.context(options);
      const r = await c.s.exec(
        await shellCommand(c.s, command, `cf:${this.id}`, {
          env: { ...cleanEnv(this.options.env), ...cleanEnv(options.env) },
          cwd: options.cwd,
        }),
        c.options,
      );
      const result = {
        success: r.exitCode === 0 && !r.timedOut,
        exitCode: r.exitCode ?? -1,
        stdout: r.stdout,
        stderr: r.stderr,
        command,
        duration: Date.now() - started,
        timestamp: new Date(started).toISOString(),
        sessionId: this.id,
      };
      if (options.stream) options.onComplete?.(result);
      return result;
    } catch (e) {
      options.onError?.(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }
  async execStream(command: string, options: ExecOptions = {}) {
    const encode = new TextEncoder();
    const started = new Date().toISOString();
    const run = this.exec.bind(this);
    const sessionId = this.id;
    const cancellation = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, cancellation.signal])
      : cancellation.signal;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: object) => {
          if (!signal.aborted)
            controller.enqueue(encode.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        try {
          send({ type: "start", command, timestamp: started, sessionId: sessionId });
          const result = await run(command, {
            ...options,
            signal,
            stream: true,
            onOutput: (type, data) =>
              send({ type, data, timestamp: new Date().toISOString(), sessionId: sessionId }),
          });
          send({
            type: "complete",
            result,
            exitCode: result.exitCode,
            timestamp: new Date().toISOString(),
          });
          if (!cancellation.signal.aborted) controller.close();
        } catch (error) {
          if (!cancellation.signal.aborted) controller.error(error);
        }
      },
      cancel(reason) {
        cancellation.abort(reason);
      },
    });
  }
  async startProcess(command: string, options: ProcessOptions = {}) {
    only("Cloudflare startProcess", options, [
      "timeout",
      "env",
      "cwd",
      "encoding",
      "sessionId",
      "onOutput",
      "onExit",
      "onStart",
      "onError",
    ]);
    const c = await this.context({
      timeout: options.timeout,
      env: options.env,
      cwd: options.cwd,
      encoding: options.encoding,
    });
    const { stdin: _stdin, ...spawnOptions } = c.options;
    const p = await c.s.spawn(
      await shellCommand(c.s, command, `cf:${this.id}`, {
        env: { ...cleanEnv(this.options.env), ...cleanEnv(options.env) },
        cwd: options.cwd,
        persist: false,
      }),
      spawnOptions,
    );
    const process = new Process(this.sandbox, p, this.id);
    options.onStart?.(process);
    if (options.onOutput || options.onExit || options.onError)
      void (async () => {
        for await (const e of p.output())
          if (e.type === "stdout" || e.type === "stderr") options.onOutput?.(e.type, e.data);
          else if (e.type === "exit") options.onExit?.(e.exitCode);
          else if (e.type === "truncated") throw new Error("Process output was truncated");
      })().catch((e: unknown) => options.onError?.(e instanceof Error ? e : new Error(String(e))));
    return process;
  }
  /** A path as this session sees it: relative paths from its working directory. */
  resolve(path: string) {
    return this.path(path);
  }
  private async path(path: string) {
    if (path.startsWith("/")) return path;
    let cwd = this.options.cwd ?? "/workspace";
    try {
      cwd = await (
        await this.sandbox.native()
      ).files.readText(`${await shellRoot(`cf:${this.id}`)}/cwd`);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    return pathAt(path, cwd);
  }
  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options: { encoding?: string } = {},
  ) {
    if (options.encoding && !["utf8", "utf-8", "base64"].includes(options.encoding))
      throw new CompatibilityError("Cloudflare", `file encoding ${options.encoding}`);
    let bytes: Uint8Array;
    if (typeof content === "string")
      bytes =
        options.encoding === "base64"
          ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(content);
    else {
      const buffer = await new Response(content).arrayBuffer();
      bytes = new Uint8Array(buffer);
    }
    await (await this.sandbox.native()).files.write(await this.path(path), bytes);
    return { success: true, path, bytesWritten: bytes.length, timestamp: new Date().toISOString() };
  }
  readFile(path: string, options: { encoding: "none" }): Promise<ReadFileStreamResult>;
  readFile(
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64" },
  ): Promise<ReadFileResult>;
  async readFile(
    path: string,
    options: { encoding?: "utf8" | "utf-8" | "base64" | "none" } = {},
  ): Promise<ReadFileResult | ReadFileStreamResult> {
    const s = await this.sandbox.native(),
      bytes = await s.files.read(await this.path(path));
    if (options.encoding === "none")
      return {
        success: true as const,
        path,
        content: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        size: bytes.length,
        mimeType: "application/octet-stream",
        timestamp: new Date().toISOString(),
      };
    const text = new TextDecoder().decode(bytes),
      binary = text.includes("\0") || text.includes("\ufffd"),
      encoded = options.encoding === "base64" || (options.encoding === undefined && binary);
    let raw = "";
    if (encoded)
      for (let i = 0; i < bytes.length; i += 32768)
        raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return {
      success: true,
      path,
      content: encoded ? btoa(raw) : text,
      encoding: encoded ? "base64" : "utf-8",
      isBinary: binary,
      size: bytes.length,
      timestamp: new Date().toISOString(),
    };
  }
  async mkdir(path: string, options: { recursive?: boolean } = {}) {
    await (
      await this.sandbox.native()
    ).files.mkdir(await this.path(path), { parents: options.recursive });
    return { success: true, path, timestamp: new Date().toISOString() };
  }
  async deleteFile(path: string) {
    await (await this.sandbox.native()).files.remove(await this.path(path));
    return { success: true, path, timestamp: new Date().toISOString() };
  }
  async renameFile(path: string, newPath: string) {
    await (
      await this.sandbox.native()
    ).files.rename(await this.path(path), await this.path(newPath));
    return { success: true, path, newPath, timestamp: new Date().toISOString() };
  }
  async exists(path: string) {
    return {
      success: true,
      path,
      exists: await (await this.sandbox.native()).files.exists(await this.path(path)),
      timestamp: new Date().toISOString(),
    };
  }
  async listFiles(path: string, options: { recursive?: boolean; includeHidden?: boolean } = {}) {
    const s = await this.sandbox.native();
    const directory = await this.path(path);
    const entries = await s.files.list(directory, { hidden: options.includeHidden });
    if (options.recursive) {
      for (let i = 0; i < entries.length; i++)
        if (entries[i]!.type === "directory")
          entries.push(
            ...(await s.files.list(entries[i]!.path, { hidden: options.includeHidden })),
          );
    }
    const files = entries.map((e) => ({
      ...e,
      absolutePath: e.path,
      relativePath: e.path.slice(directory.replace(/\/$/, "").length + 1),
      permissions: {
        readable: !!(parseInt(e.mode, 8) & 0o444),
        writable: !!(parseInt(e.mode, 8) & 0o222),
        executable: !!(parseInt(e.mode, 8) & 0o111),
      },
    }));
    return { success: true, path, files, count: files.length, timestamp: new Date().toISOString() };
  }
  async setEnvVars(env: Record<string, string | undefined>) {
    this.options = { ...this.options, env: { ...this.options.env, ...cleanEnv(env) } };
    await (
      await this.sandbox.native()
    ).files.write(
      `/workspace/.runtime-compat/cloudflare/${encodeURIComponent(this.id)}.json`,
      JSON.stringify(this.options),
      { mode: 0o600 },
    );
  }
}
export class Process {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly native: NativeProcess,
    readonly sessionId?: string,
  ) {}
  get id() {
    return this.native.id;
  }
  get command() {
    return this.native.info.command;
  }
  get status() {
    return this.native.info.state === "exited"
      ? this.native.info.exitCode === 0
        ? "completed"
        : "failed"
      : this.native.info.state === "timed_out"
        ? "failed"
        : this.native.info.state;
  }
  get startTime() {
    return new Date(this.native.info.startedAt);
  }
  get endTime() {
    return this.native.info.endedAt ? new Date(this.native.info.endedAt) : undefined;
  }
  get exitCode() {
    return this.native.info.exitCode ?? undefined;
  }
  async kill(signal = "SIGTERM") {
    if (
      !["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"].includes(signal)
    )
      throw new TypeError(`Unsupported signal ${signal}`);
    await this.native.kill(signal as Parameters<NativeProcess["kill"]>[0]);
  }
  async getStatus() {
    await this.native.refresh();
    return this.status;
  }
  getLogs() {
    return this.sandbox.getProcessLogs(this.id);
  }
  async waitForExit(timeout?: number) {
    const r = await this.native.wait({
      signal: timeout ? timeoutSignal(timeout) : undefined,
    });
    return { exitCode: r.exitCode ?? -1 };
  }
  async waitForLog(pattern: string | RegExp, timeout = 30000) {
    const condition = `log pattern ${String(pattern)}`;
    const context = { processId: this.id, command: this.command, condition };
    const signal = timeoutSignal(timeout);
    try {
      return await this.#waitForLog(pattern, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      throw new ProcessReadyTimeoutError(
        response(
          "PROCESS_READY_TIMEOUT",
          `Process did not become ready within ${timeout}ms`,
          { ...context, timeout },
          { httpStatus: 408, operation: "process.start" },
        ),
      );
    }
  }
  async #waitForLog(pattern: string | RegExp, signal: AbortSignal) {
    let output = "";
    for await (const e of this.native.output({ signal })) {
      if (e.type === "stdout" || e.type === "stderr") {
        output += e.data;
        const match =
          typeof pattern === "string" ? output.includes(pattern) : output.match(pattern);
        if (match)
          return {
            line:
              output
                .split("\n")
                .find((line) =>
                  typeof pattern === "string"
                    ? line.includes(pattern)
                    : new RegExp(pattern.source, pattern.flags.replace("g", "")).test(line),
                ) ?? output,
            ...(typeof pattern === "string" ? {} : { match }),
          };
      } else if (e.type === "exit")
        throw new ProcessExitedBeforeReadyError(
          response(
            "PROCESS_EXITED_BEFORE_READY",
            "Process exited before expected output",
            {
              processId: this.id,
              command: this.command,
              condition: `log pattern ${String(pattern)}`,
              exitCode: e.exitCode ?? -1,
            },
            { httpStatus: 409, operation: "process.start" },
          ),
        );
    }
    throw new Error("Process output ended before expected output");
  }
}
