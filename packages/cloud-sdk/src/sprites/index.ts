import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { RuntimeError } from "../errors.js";
import type { Runtime } from "../client.js";
import type { Process, Sandbox } from "../sandbox.js";
import {
  all,
  client,
  CompatibilityError,
  create,
  destroy,
  execOptions,
  lookup,
  only,
  ready,
  region,
  type ClientOptions as RuntimeClientOptions,
} from "../compat/core.js";
import { GuestFiles } from "../compat/files.js";
export { CompatibilityError };
export interface ClientOptions extends RuntimeClientOptions {
  baseURL?: string;
  timeout?: number;
  controlMode?: boolean;
}
export interface SpriteConfig {
  ramMB?: number;
  cpus?: number;
  region?: string;
  storageGB?: number;
}
export interface CreateSpriteOptions {
  config?: SpriteConfig;
  environment?: Record<string, string>;
  labels?: string[];
  urlSettings?: { auth?: string; privateAccess?: string };
  runtime?: "default" | "dev";
  waitForCapacity?: boolean;
}
export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  tty?: boolean;
  rows?: number;
  cols?: number;
  detachable?: boolean;
  sessionId?: string;
  controlMode?: boolean;
}
export interface ExecOptions extends SpawnOptions {
  encoding?: BufferEncoding;
  maxBuffer?: number;
  signal?: AbortSignal;
  timeout?: number;
}
export interface ExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
  exitCode: number;
}
function validateURLSettings(settings: { auth?: string; privateAccess?: string }) {
  only("Sprites URL settings", settings, ["auth"]);
  if (settings.auth !== "public" && settings.auth !== "sprite")
    throw new TypeError("auth must be public or sprite");
}
function validateLabels(labels: string[] | undefined) {
  if (
    labels !== undefined &&
    (!Array.isArray(labels) || Array.from(labels).some((label) => typeof label !== "string"))
  )
    throw new TypeError("labels must be an array of strings");
}
export type FilesystemErrorCode =
  | "ENOENT"
  | "EEXIST"
  | "ENOTDIR"
  | "EISDIR"
  | "EACCES"
  | "EPERM"
  | "ENOTEMPTY"
  | "EINVAL"
  | "EIO"
  | "UNKNOWN";
export class FilesystemError extends Error {
  constructor(
    message: string,
    readonly code: FilesystemErrorCode,
    readonly path: string,
    readonly syscall?: string,
  ) {
    super(message);
    this.name = "FilesystemError";
  }
}
async function fileOperation<T>(path: string, syscall: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    const codes: Record<string, FilesystemErrorCode> = {
      file_not_found: "ENOENT",
      not_found: "ENOENT",
      already_exists: "EEXIST",
      file_exists: "EEXIST",
      not_a_directory: "ENOTDIR",
      is_a_directory: "EISDIR",
      permission_denied: "EACCES",
      directory_not_empty: "ENOTEMPTY",
      invalid_request: "EINVAL",
    };
    throw new FilesystemError(
      error.message,
      codes[error.code] ?? (error.status === 404 ? "ENOENT" : "UNKNOWN"),
      path,
      syscall,
    );
  }
}
export interface Dirent {
  name: string;
  parentPath: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}
export interface ReaddirOptions {
  withFileTypes?: boolean;
  recursive?: boolean;
  pattern?: string;
  encoding?: BufferEncoding;
}
export class ExecError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stdout: string | Buffer,
    readonly stderr: string | Buffer,
  ) {
    super(message);
    this.name = "ExecError";
  }
}
export class SpritesClient {
  readonly runtime: Runtime;
  constructor(token?: string, options: ClientOptions = {}) {
    only("Sprites client", options, [
      "apiKey",
      "baseUrl",
      "baseURL",
      "timeout",
      "timeoutMs",
      "maxRetries",
      "fetch",
      "client",
      "controlMode",
      "waitForCapacityMs",
    ]);
    if (options.controlMode) throw new CompatibilityError("Sprites", "control-mode wire protocol");
    this.runtime = client({
      ...options,
      apiKey: options.apiKey ?? token,
      baseUrl: options.baseUrl ?? options.baseURL,
      timeoutMs: options.timeoutMs ?? options.timeout,
    });
  }
  sprite(name: string) {
    return new Sprite(name, this);
  }
  async createSprite(
    name: string,
    input: SpriteConfig | CreateSpriteOptions = {},
    extra: Omit<CreateSpriteOptions, "config"> = {},
  ) {
    const o: CreateSpriteOptions = ["ramMB", "cpus", "region", "storageGB"].some((k) => k in input)
      ? { ...extra, config: input as SpriteConfig }
      : { ...(input as CreateSpriteOptions), ...extra };
    only("Sprites create", o, [
      "config",
      "environment",
      "labels",
      "urlSettings",
      "runtime",
      "waitForCapacity",
    ]);
    if (o.runtime !== undefined)
      throw new CompatibilityError(
        "Sprites",
        `vendor runtime image ${o.runtime}; import it into Runtime first`,
      );
    if (o.urlSettings !== undefined) validateURLSettings(o.urlSettings);
    validateLabels(o.labels);
    const c = o.config ?? {};
    only("Sprites config", c, ["ramMB", "cpus", "region", "storageGB"]);
    const s = await create(
      this.runtime,
      "sprites",
      {
        name,
        persistent: true,
        vcpu: c.cpus,
        memoryMiB: c.ramMB,
        diskMiB: c.storageGB === undefined ? undefined : Math.ceil((c.storageGB * 1e9) / 1048576),
        region: region("Sprites", c.region),
        labels: { "compat.labels": JSON.stringify(o.labels ?? []) },
      },
      o.environment,
      undefined,
      o.waitForCapacity === false ? { waitForCapacityMs: 0 } : {},
    );
    const sprite = new Sprite(name, this);
    sprite.hydrate(s);
    if (o.urlSettings) {
      try {
        await sprite.updateURLSettings(o.urlSettings);
      } catch (e) {
        await destroy(s);
        throw e;
      }
    }
    return sprite;
  }
  async getSprite(name: string) {
    const sprite = this.sprite(name);
    sprite.hydrate(await lookup(this.runtime, name));
    return sprite;
  }
  async deleteSprite(name: string) {
    await destroy(await lookup(this.runtime, name));
  }
  async listSprites(
    options: {
      prefix?: string;
      maxResults?: number;
      continuationToken?: string;
      bulkLoad?: boolean;
    } = {},
  ) {
    only("Sprites list", options, ["prefix", "maxResults", "continuationToken", "bulkLoad"]);
    const values = (await all(this.runtime, "sprites")).filter((s) =>
      (s.info.name ?? s.id).startsWith(options.prefix ?? ""),
    );
    const offset = Number(options.continuationToken ?? 0),
      limit = options.maxResults ?? 100;
    return {
      sprites: values.slice(offset, offset + limit).map((s) => ({
        id: s.id,
        name: s.info.name ?? s.id,
        status: s.state,
        createdAt: new Date(s.info.createdAt),
        updatedAt: new Date(s.info.createdAt),
        config: {
          cpus: s.info.vcpu,
          ramMB: s.info.memoryMiB,
          storageGB: (s.info.diskMiB * 1048576) / 1e9,
          region: s.info.region,
        },
      })),
      hasMore: offset + limit < values.length,
      nextContinuationToken: offset + limit < values.length ? String(offset + limit) : undefined,
    };
  }
  async listAllSprites(prefix?: string) {
    return (await all(this.runtime, "sprites"))
      .filter((s) => (s.info.name ?? s.id).startsWith(prefix ?? ""))
      .map((s) => {
        const sprite = this.sprite(s.info.name ?? s.id);
        sprite.hydrate(s);
        return sprite;
      });
  }
  async restartSprite(name: string) {
    const s = await lookup(this.runtime, name);
    await s.stop();
    await s.restart();
    return { spriteName: name, machineId: s.id, message: "Restarted" };
  }
  updateURLSettings(name: string, settings: { auth?: string; privateAccess?: string }) {
    return this.sprite(name).updateURLSettings(settings);
  }
}
export class Sprite {
  id?: string;
  status?: string;
  config?: SpriteConfig;
  createdAt?: Date;
  updatedAt?: Date;
  url?: string;
  labels: string[] = [];
  constructor(
    readonly name: string,
    readonly client: SpritesClient,
  ) {}
  hydrate(s: Sandbox) {
    this.id = s.id;
    this.status = s.state;
    this.config = {
      cpus: s.info.vcpu,
      ramMB: s.info.memoryMiB,
      region: s.info.region,
      storageGB: (s.info.diskMiB * 1048576) / 1e9,
    };
    this.createdAt = new Date(s.info.createdAt);
    this.updatedAt = this.createdAt;
    this.labels = JSON.parse(s.info.labels["compat.labels"] ?? "[]") as string[];
  }
  async native() {
    const s = await lookup(this.client.runtime, this.id ?? this.name);
    this.hydrate(s);
    return s;
  }
  spawn(command: string, args: string[] = [], options: SpawnOptions = {}) {
    return new SpriteCommand(this, command, args, options);
  }
  exec(command: string, options?: ExecOptions) {
    return this.execFile("bash", ["-c", command], options);
  }
  async execFile(
    file: string,
    args: string[] = [],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0))
      throw new TypeError("timeout must be a non-negative finite number");
    if (
      options.encoding &&
      options.encoding !== ("buffer" as string) &&
      !Buffer.isEncoding(options.encoding)
    )
      throw new TypeError(`Unknown encoding: ${String(options.encoding)}`);
    only("Sprites exec", options, [
      "cwd",
      "env",
      "tty",
      "rows",
      "cols",
      "detachable",
      "sessionId",
      "controlMode",
      "encoding",
      "maxBuffer",
      "signal",
      "timeout",
    ]);
    if (options.controlMode) throw new CompatibilityError("Sprites", "control-mode wire protocol");
    const cmd = this.spawn(file, args, options);
    const out: Buffer[] = [],
      err: Buffer[] = [];
    const maxBuffer = options.maxBuffer || 10 * 1024 * 1024;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let rejectFailure: (error: Error) => void = () => undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    const cancel = (error: Error) => {
      if (failure) return;
      failure = error;
      cmd.kill("SIGTERM");
      cmd.close();
      rejectFailure(error);
    };
    const capture = (channel: "stdout" | "stderr", target: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      if (channel === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if ((channel === "stdout" ? stdoutBytes : stderrBytes) > maxBuffer)
        cancel(new Error(`${channel} maxBuffer exceeded`));
      else target.push(chunk);
    };
    cmd.stdout.on("data", capture("stdout", out));
    cmd.stderr.on("data", capture("stderr", err));
    const abort = () => cancel(new Error("Command aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = options.timeout
      ? setTimeout(
          () => cancel(new Error(`Command timed out after ${options.timeout} ms`)),
          options.timeout,
        )
      : undefined;
    try {
      const exitCode = await Promise.race([cmd.wait(), failed]);
      if (failure) throw failure;
      const stdout = Buffer.concat(out),
        stderr = Buffer.concat(err);
      const r = {
        stdout:
          options.encoding === ("buffer" as string)
            ? stdout
            : stdout.toString(options.encoding ?? "utf8"),
        stderr:
          options.encoding === ("buffer" as string)
            ? stderr
            : stderr.toString(options.encoding ?? "utf8"),
        exitCode,
      };
      if (exitCode !== 0)
        throw new ExecError(`Command exited with code ${exitCode}`, exitCode, r.stdout, r.stderr);
      return r;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  execFileHTTP(file: string, args?: string[], options?: ExecOptions) {
    return this.execFile(file, args, options);
  }
  createSession(command: string, args: string[] = [], options: SpawnOptions = {}) {
    // The pinned SDK's session wrapper forces a terminal, even when a caller
    // supplies tty:false. Attaching an existing session detects its own PTY.
    return this.spawn(command, args, { ...options, detachable: true, tty: true });
  }
  attachSession(sessionId: string, options: SpawnOptions = {}) {
    return this.spawn("", [], { ...options, sessionId });
  }
  async listSessions() {
    return (await (await this.native()).processes.list())
      .filter((p) => p.state === "running")
      .map((p) => ({
        id: p.id,
        command: p.command,
        created: new Date(p.startedAt),
        workdir: p.cwd,
        isActive: p.state === "running",
        tty: p.pty,
      }));
  }
  delete() {
    return this.client.deleteSprite(this.id ?? this.name);
  }
  destroy() {
    return this.delete();
  }
  restart() {
    return this.client.restartSprite(this.id ?? this.name);
  }
  filesystem(workingDir = "/") {
    return new SpriteFilesystem(() => this.native(), workingDir);
  }
  async createCheckpoint(_comment?: string): Promise<never> {
    throw new CompatibilityError(
      "Sprites",
      "filesystem-only checkpoints; Runtime snapshots also include running memory",
    );
  }
  async listCheckpoints(): Promise<never> {
    throw new CompatibilityError("Sprites", "filesystem-only checkpoints");
  }
  async getCheckpoint(_id: string): Promise<never> {
    throw new CompatibilityError("Sprites", "filesystem-only checkpoints");
  }

  async updateURLSettings(settings: { auth?: string; privateAccess?: string }) {
    validateURLSettings(settings);
    const p = await (
      await this.native()
    ).previews.create(8080, { visibility: settings.auth === "public" ? "public" : "private" });
    this.url = p.urlWithToken ?? p.url;
  }
  async update(options: {
    labels?: string[];
    urlSettings?: { auth?: string; privateAccess?: string };
  }) {
    only("Sprites update", options, ["labels", "urlSettings"]);
    if (options.labels === undefined && options.urlSettings === undefined)
      throw new TypeError("urlSettings or labels is required");
    if (options.urlSettings !== undefined) validateURLSettings(options.urlSettings);
    validateLabels(options.labels);
    const s = await this.native();
    if (options.labels)
      await s.update({
        labels: { ...s.info.labels, "compat.labels": JSON.stringify(options.labels) },
      });
    if (options.urlSettings) await this.updateURLSettings(options.urlSettings);
    this.hydrate(s);
    return this;
  }
}
export class SpriteCommand extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  private readonly process: Promise<Process>;
  private readonly completion: Promise<number>;
  private code = -1;
  private readonly controller = new AbortController();
  constructor(sprite: Sprite, command: string, args: string[] = [], options: SpawnOptions = {}) {
    super();
    only("Sprites spawn", options, [
      "cwd",
      "env",
      "tty",
      "rows",
      "cols",
      "detachable",
      "sessionId",
      "controlMode",
      "encoding",
      "maxBuffer",
      "signal",
      "timeout",
    ]);
    if (options.controlMode) throw new CompatibilityError("Sprites", "control-mode wire protocol");
    this.process = (async () => {
      const s = await ready(await sprite.native());
      return options.sessionId
        ? s.processes.get(options.sessionId)
        : s.spawn([command, ...args], {
            ...(await execOptions(s, { cwd: options.cwd, env: options.env })),
            stdin: "pipe",
            outputEncoding: "base64",
            pty: options.tty ? { rows: options.rows, cols: options.cols } : undefined,
          });
    })();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        void this.process.then((p) => p.write(chunk)).then(() => callback(), callback);
      },
      final: (callback) => {
        void this.process.then((p) => p.write("", { eof: true })).then(() => callback(), callback);
      },
    });
    this.completion = this.follow();
    this.completion.catch((error) => {
      if (this.listenerCount("error")) this.emit("error", error);
    });
  }
  private async follow() {
    try {
      const p = await this.process;
      this.emit("spawn");
      this.emit("session", p.id);
      for await (const e of p.outputBytes({ signal: this.controller.signal })) {
        if (e.type === "stdout") this.stdout.write(e.data);
        else if (e.type === "stderr") this.stderr.write(e.data);
        else if (e.type === "truncated") throw new Error("Sprite command output was truncated");
        else if (e.type === "exit") this.code = e.exitCode ?? -1;
      }
      this.emit("exit", this.code);
      this.emit("close", this.code);
      return this.code;
    } finally {
      this.stdout.end();
      this.stderr.end();
    }
  }
  async start(): Promise<void> {
    await this.process;
  }
  wait() {
    return this.completion;
  }
  kill(signal = "SIGTERM") {
    this.signal(signal);
  }
  signal(signal: string) {
    if (
      !["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"].includes(signal)
    )
      throw new TypeError(`Unsupported signal ${signal}`);
    void this.process
      .then((p) => p.kill(signal as Parameters<Process["kill"]>[0]))
      .catch((error) => {
        if (this.listenerCount("error")) this.emit("error", error);
      });
  }
  resize(cols: number, rows: number) {
    void this.process
      .then((p) => p.resize(cols, rows))
      .catch((error) => {
        if (this.listenerCount("error")) this.emit("error", error);
      });
  }
  close() {
    this.controller.abort();
  }
  exitCode() {
    return this.code;
  }
}
export class SpriteFilesystem {
  private readonly files: GuestFiles;
  constructor(
    private readonly get: () => Promise<Sandbox>,
    cwd = "/",
  ) {
    this.files = new GuestFiles(get, cwd);
  }
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, encoding?: null): Promise<Buffer>;
  async readFile(path: string, encoding?: "utf8" | null): Promise<string | Buffer> {
    const bytes = Buffer.from(await fileOperation(path, "read", () => this.files.readFile(path)));
    return encoding === "utf8" ? bytes.toString("utf8") : bytes;
  }
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }) {
    return fileOperation(path, "write", () => this.files.writeFile(path, data, options));
  }
  readdir(path: string, options?: ReaddirOptions & { withFileTypes?: false }): Promise<string[]>;
  readdir(path: string, options: ReaddirOptions & { withFileTypes: true }): Promise<Dirent[]>;
  async readdir(
    path: string,
    options: {
      withFileTypes?: boolean;
      recursive?: boolean;
      pattern?: string;
      encoding?: BufferEncoding;
    } = {},
  ) {
    only("Sprites readdir", options, ["withFileTypes", "recursive", "pattern", "encoding"]);
    if (options.encoding && options.encoding !== "utf8")
      throw new CompatibilityError("Sprites", "directory name encodings other than utf8");
    if (options.recursive && options.pattern)
      throw new CompatibilityError("Sprites", "recursive listing with a glob pattern");
    const entries = await fileOperation(path, "readdir", async () => {
      const s = await this.get();
      const entries = await s.files.list(this.files.path(path), {
        hidden: true,
        glob: options.pattern,
      });
      if (options.recursive)
        for (let i = 0; i < entries.length; i++)
          if (entries[i]!.type === "directory")
            entries.push(...(await s.files.list(entries[i]!.path, { hidden: true })));
      return entries;
    });
    return entries.map((e) =>
      options.withFileTypes
        ? {
            name: e.name,
            parentPath: path,
            isDirectory: () => e.type === "directory",
            isFile: () => e.type === "file",
            isSymbolicLink: () => e.type === "symlink",
          }
        : e.name,
    );
  }
  async mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}) {
    await fileOperation(path, "mkdir", () => this.files.mkdir(path, options.recursive));
    if (options.mode !== undefined) await this.files.chmod(path, options.mode);
  }
  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}) {
    if (!options.force && !(await this.files.exists(path)))
      throw new FilesystemError(`Path not found: ${path}`, "ENOENT", path, "rm");
    await fileOperation(path, "rm", () => this.files.remove(path, options.recursive));
  }
  async stat(path: string) {
    const e = await fileOperation(path, "stat", () => this.files.stat(path));
    return {
      size: e.size,
      mode: parseInt(e.mode, 8),
      mtime: new Date(e.modifiedAt),
      atime: new Date(e.modifiedAt),
      birthtime: new Date(e.modifiedAt),
      isDirectory: () => e.type === "directory",
      isFile: () => e.type === "file",
      isSymbolicLink: () => e.type === "symlink",
    };
  }
  rename(from: string, to: string) {
    return fileOperation(from, "rename", () => this.files.rename(from, to, true));
  }
  copyFile(from: string, to: string, options: { recursive?: boolean } = {}) {
    return fileOperation(from, "copyFile", () =>
      this.files.copy(from, to, options.recursive, true),
    );
  }
  chmod(path: string, mode: number, options: { recursive?: boolean } = {}) {
    return fileOperation(path, "chmod", () => this.files.chmod(path, mode, options.recursive));
  }
  exists(path: string) {
    return this.files.exists(path);
  }
  appendFile(path: string, data: string | Uint8Array) {
    return fileOperation(path, "appendFile", () => this.files.appendFile(path, data));
  }
  async readJSON<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await this.readFile(path, "utf8")) as T;
  }
  writeJSON(path: string, data: unknown, options: { spaces?: number } = {}) {
    return this.writeFile(path, JSON.stringify(data, null, options.spaces));
  }
}
export class CheckpointStream {
  private index = 0;
  constructor(
    private readonly messages: {
      type: "complete" | "error" | "info";
      data?: string;
      error?: string;
    }[],
  ) {}
  async next() {
    return this.messages[this.index++] ?? null;
  }
  async processAll(handler: (message: (typeof this.messages)[number]) => void | Promise<void>) {
    for await (const message of this) await handler(message);
  }
  close() {
    this.index = this.messages.length;
  }
  async *[Symbol.asyncIterator]() {
    let message;
    while ((message = await this.next())) yield message;
  }
}
