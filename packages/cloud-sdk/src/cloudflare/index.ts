import { createHash } from "node:crypto";
import { Runtime } from "../client.js";
import { NotFoundError } from "../errors.js";
import type { Process as NativeProcess, Sandbox as NativeSandbox } from "../sandbox.js";
import {
  client,
  closeShell,
  CompatibilityError,
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
export { CompatibilityError };
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
  if (typeof value === "number") return value;
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new TypeError("sleepAfter must be seconds or a duration such as 5m");
  return Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2]!] ?? 1);
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
  readonly id: string;
  constructor(
    readonly runtime: Runtime,
    id: string,
    private readonly options: SandboxOptions = {},
  ) {
    this.id = id;
  }
  async configure(options: Pick<SandboxOptions, "sleepAfter" | "keepAlive">) {
    if (options.sleepAfter !== undefined) sleepSeconds(options.sleepAfter);
    const changed =
      (options.sleepAfter !== undefined && options.sleepAfter !== this.options.sleepAfter) ||
      (options.keepAlive !== undefined && options.keepAlive !== this.options.keepAlive);
    Object.assign(this.options, options);
    if (changed && this.pending) {
      const s = await this.pending;
      await s.update({
        idlePauseSeconds: this.options.keepAlive ? 0 : sleepSeconds(this.options.sleepAfter),
        ...(options.keepAlive !== undefined ? { persistent: options.keepAlive } : {}),
      });
    }
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
  exec(command: string, options?: ExecOptions) {
    return this.session().exec(command, options);
  }
  execStream(command: string, options?: ExecOptions) {
    return this.session().execStream(command, options);
  }
  startProcess(command: string, options: ProcessOptions = {}) {
    return this.session(options.sessionId).startProcess(command, options);
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
  }
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: string },
  ) {
    return this.session().writeFile(path, content, options);
  }
  readFile(path: string, options: { encoding: "none" }): Promise<ReadFileStreamResult>;
  readFile(
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64" },
  ): Promise<ReadFileResult>;
  readFile(
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64" | "none" },
  ): Promise<ReadFileResult | ReadFileStreamResult> {
    return options?.encoding === "none"
      ? this.session().readFile(path, { encoding: "none" })
      : this.session().readFile(path, options as { encoding?: "utf8" | "utf-8" | "base64" });
  }
  mkdir(path: string, options?: { recursive?: boolean }) {
    return this.session().mkdir(path, options);
  }
  deleteFile(path: string) {
    return this.session().deleteFile(path);
  }
  renameFile(from: string, to: string) {
    return this.session().renameFile(from, to);
  }
  moveFile(from: string, to: string) {
    return this.renameFile(from, to);
  }
  listFiles(path: string, options?: { recursive?: boolean; includeHidden?: boolean }) {
    return this.session().listFiles(path, options);
  }
  exists(path: string) {
    return this.session().exists(path);
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
    ]);
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
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
    return { exitCode: r.exitCode ?? -1 };
  }
  async waitForLog(pattern: string | RegExp, timeout = 30000) {
    let output = "";
    for await (const e of this.native.output({ signal: AbortSignal.timeout(timeout) })) {
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
      }
    }
    throw new Error("Process exited before expected output");
  }
}
