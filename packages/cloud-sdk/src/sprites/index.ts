import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { NotFoundError, RuntimeError } from "../errors.js";
import type { Runtime } from "../client.js";
import type { Process, Sandbox } from "../sandbox.js";
import type { Snapshot } from "../snapshots.js";
import type { PortForward } from "../tunnel.js";
import { timeoutSignal } from "../transport.js";
import type { NetworkRules } from "../products/network.js";
import type { WatchHandle } from "../products/watch.js";
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
  refuse,
  region,
  type ClientOptions as RuntimeClientOptions,
  type Refused,
  type RefusedAsync,
} from "../compat/core.js";
import { GuestFiles } from "../compat/files.js";
export { CompatibilityError };
export const ERR_CODE_CREATION_RATE_LIMITED = "sprite_creation_rate_limited";
export const ERR_CODE_CONCURRENT_LIMIT_EXCEEDED = "concurrent_sprite_limit_exceeded";
export interface URLSettings {
  auth?: string;
  privateAccess?: "admins" | "org_users";
}
export interface Checkpoint {
  id: string;
  createTime: Date;
  comment?: string;
  history?: string[];
  isAuto?: boolean;
  sourceId?: string;
  health?: string;
}
export interface StreamMessage {
  type: "info" | "stdout" | "stderr" | "error" | "complete";
  data?: string;
  error?: string;
}
export interface PortMapping {
  localPort: number;
  remotePort: number;
  remoteHost?: string;
}
export interface PolicyRule {
  domain?: string;
  action?: "allow" | "deny";
  include?: string;
}
export interface NetworkPolicy {
  rules: PolicyRule[];
}
export interface PrivilegesPolicy {
  profile?: "" | "minimal" | "standard" | "privileged";
  devices?: string[];
  noNewPrivileges?: boolean;
}
export interface ResourcesPolicy {
  memory?: { limitMB: number; autoscale?: boolean };
}
export interface ServiceRequest {
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  dir?: string;
  needs?: string[];
  httpPort?: number;
}
export interface ServiceLogEvent {
  type: "stdout" | "stderr" | "exit" | "error" | "complete" | "started" | "stopping" | "stopped";
  data?: string;
  exitCode?: number;
  timestamp: number;
  logFiles?: Record<string, string>;
}
export interface SessionKillEvent {
  type: "signal" | "timeout" | "exited" | "killed" | "error" | "complete";
  message?: string;
  signal?: string;
  pid?: number;
  exitCode?: number;
}
export interface SpriteCheck {
  spriteName: string;
  spriteId: string;
  status: string;
  reason?: string;
  checkedAt: Date;
  elapsed?: number;
}
export interface SpriteStateEvent {
  type?: "heartbeat";
  name?: string;
  status?: string;
  organization: { running: number; warm: number; cold: number };
}
export interface PortNotification {
  type: "port_opened" | "port_closed";
  port: number;
  address: string;
  pid: number;
}
export interface PortList {
  type: "port_list";
  ports: PortNotification[];
}
export type PortWatchEvent = PortList | PortNotification;
export interface FilesystemWatchEvent {
  type: "subscribed" | "event" | "error";
  paths?: string[];
  path?: string;
  event?: "write" | "create" | "remove" | "rename" | "chmod";
  timestamp?: string;
  size?: number;
  isDir?: boolean;
  message?: string;
}

/** A Sprites progress or event stream: the work behind it runs whether or
 * not anyone reads, as the vendor's server-side operation does; `next()`
 * answers null at the end, `close()` stops reading (and stops a watch). */
class Feed<T> {
  #items: T[] = [];
  #waiters: (() => void)[] = [];
  #ended = false;
  #closed = false;
  #error: unknown;
  constructor(source?: AsyncIterable<T>) {
    if (source)
      void (async () => {
        try {
          for await (const item of source) this.push(item);
          this.end();
        } catch (error) {
          this.end(error);
        }
      })();
  }
  protected push(item: T): void {
    if (this.#ended || this.#closed) return;
    this.#items.push(item);
    this.#wake();
  }
  protected end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    this.#wake();
  }
  /** Called once by close(); a watch stops its native watch here. */
  protected stop(): void {}
  #wake() {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
  async next(): Promise<T | null> {
    while (!this.#items.length && !this.#ended && !this.#closed)
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    if (this.#closed) return null;
    if (this.#items.length) return this.#items.shift()!;
    if (this.#error !== undefined) {
      const error = this.#error;
      this.#error = undefined;
      throw error instanceof Error ? error : new Error("The stream failed", { cause: error });
    }
    return null;
  }
  async processAll(handler: (item: T) => void | Promise<void>): Promise<void> {
    for await (const item of this) await handler(item);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stop();
    this.#wake();
  }
  isClosed(): boolean {
    return this.#closed || (this.#ended && !this.#items.length);
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    let item: T | null;
    while ((item = await this.next()) !== null) yield item;
  }
}
export class CheckpointStream extends Feed<StreamMessage> {}
export class RestoreStream extends Feed<StreamMessage> {}
export class ServiceLogStream extends Feed<ServiceLogEvent> {}
export class SessionKillStream extends Feed<SessionKillEvent> {}
export class SpriteListStream extends Feed<SpriteStateEvent> {}

export class APIError extends Error {
  readonly errorCode?: string;
  readonly statusCode?: number;
  readonly limit?: number;
  readonly windowSeconds?: number;
  readonly retryAfterSeconds?: number;
  readonly currentCount?: number;
  readonly upgradeAvailable?: boolean;
  readonly upgradeUrl?: string;
  readonly retryAfterHeader?: number;
  readonly rateLimitLimit?: number;
  readonly rateLimitRemaining?: number;
  readonly rateLimitReset?: number;
  constructor(
    message: string,
    options: {
      errorCode?: string;
      statusCode?: number;
      limit?: number;
      windowSeconds?: number;
      retryAfterSeconds?: number;
      currentCount?: number;
      upgradeAvailable?: boolean;
      upgradeUrl?: string;
      retryAfterHeader?: number;
      rateLimitLimit?: number;
      rateLimitRemaining?: number;
      rateLimitReset?: number;
    } = {},
  ) {
    super(message);
    this.name = "APIError";
    Object.assign(this, options);
  }
  isRateLimitError(): boolean {
    return this.statusCode === 429;
  }
  isCreationRateLimited(): boolean {
    return this.errorCode === ERR_CODE_CREATION_RATE_LIMITED;
  }
  isConcurrentLimitExceeded(): boolean {
    return this.errorCode === ERR_CODE_CONCURRENT_LIMIT_EXCEEDED;
  }
  getRetryAfterSeconds(): number | undefined {
    if (this.retryAfterSeconds !== undefined && this.retryAfterSeconds > 0)
      return this.retryAfterSeconds;
    return this.retryAfterHeader;
  }
}
/** The vendor's parser, for callers that read Sprites-shaped answers themselves. */
export function parseAPIError(
  statusCode: number,
  body: string | undefined,
  headers: Record<string, string> = {},
): APIError | undefined {
  if (statusCode < 400) return undefined;
  const header = (name: string) => {
    const value = headers[name.toLowerCase()] ?? headers[name];
    const number = value ? parseInt(value, 10) : NaN;
    return Number.isNaN(number) ? undefined : number;
  };
  const retryAfterHeader = header("Retry-After");
  let message = "";
  let data: Record<string, unknown> = {};
  if (body)
    try {
      data = JSON.parse(body) as Record<string, unknown>;
      message = (data.message as string) || "";
    } catch {
      message = body;
    }
  const errorCode = data.error as string | undefined;
  const limit = data.limit as number | undefined;
  const windowSeconds = data.window_seconds as number | undefined;
  const retryAfterSeconds = data.retry_after_seconds as number | undefined;
  const currentCount = data.current_count as number | undefined;
  const upgradeUrl = data.upgrade_url as string | undefined;
  if (statusCode === 429 && message) {
    const details: string[] = [];
    if (limit !== undefined && windowSeconds !== undefined)
      details.push(`limit: ${limit} per ${windowSeconds}s`);
    if (currentCount !== undefined) details.push(`current: ${currentCount}`);
    const retry = retryAfterSeconds ?? retryAfterHeader;
    if (retry !== undefined) details.push(`retry after: ${retry}s`);
    if (upgradeUrl) details.push(`upgrade: ${upgradeUrl}`);
    if (details.length) message = `${message} (${details.join(", ")})`;
  }
  return new APIError(message || errorCode || `API error (status ${statusCode})`, {
    errorCode,
    statusCode,
    limit,
    windowSeconds,
    retryAfterSeconds,
    currentCount,
    upgradeAvailable: data.upgrade_available as boolean | undefined,
    upgradeUrl,
    retryAfterHeader,
    rateLimitLimit: header("X-RateLimit-Limit"),
    rateLimitRemaining: header("X-RateLimit-Remaining"),
    rateLimitReset: header("X-RateLimit-Reset"),
  });
}
/** Runtime's refusal as the APIError the vendor's client throws; limits on
 * running sandboxes are its concurrent limit, the API's rate limit on a
 * create its creation limit. */
async function api<T>(run: () => Promise<T>, creating = false): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.status < 400) throw error;
    const errorCode = ["no_credit_running_limit", "quota_exceeded"].includes(error.code)
      ? ERR_CODE_CONCURRENT_LIMIT_EXCEEDED
      : creating && error.code === "rate_limited"
        ? ERR_CODE_CREATION_RATE_LIMITED
        : error.code;
    const retry =
      error.retryAfterMs === undefined ? undefined : Math.ceil(error.retryAfterMs / 1000);
    throw Object.assign(
      new APIError(error.message, {
        errorCode,
        statusCode: error.status,
        retryAfterSeconds: retry,
        retryAfterHeader: retry,
      }),
      { cause: error },
    );
  }
}
/** "30s", "500ms", "2m" or "1h", as Sprites' durations are written. */
function duration(value: string, name: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  if (!match) throw new TypeError(`${name} must be a duration such as "10s"`);
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!]!;
}
const SIGNALS = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
  "SIGUSR1",
  "SIGUSR2",
] as const;
function signalName(signal: string): (typeof SIGNALS)[number] {
  const name = (signal.startsWith("SIG") ? signal : `SIG${signal}`) as (typeof SIGNALS)[number];
  if (!SIGNALS.includes(name)) throw new TypeError(`Unsupported signal ${signal}`);
  return name;
}
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
/** maxRunAfterDisconnect is left out: a Runtime process runs until it ends
 * or is killed, whoever is connected. */
const SPAWN_KEYS = [
  "cwd",
  "env",
  "tty",
  "rows",
  "cols",
  "detachable",
  "sessionId",
  "controlMode",
] as const;
const EXEC_KEYS = [...SPAWN_KEYS, "encoding", "maxBuffer", "signal", "timeout"] as const;
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
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "ExecError";
  }
  get exitCode(): number {
    return this.result.exitCode;
  }
  get stdout(): string | Buffer {
    return this.result.stdout;
  }
  get stderr(): string | Buffer {
    return this.result.stderr;
  }
}
/** The vendor's control-mode wire protocol: multiplexed operations over one
 * WebSocket. Runtime's own API multiplexes commands without it. */
const CONTROL = "Runtime runs each command over its own API; use spawn, exec or execFile";
export class OpConn extends EventEmitter {
  declare readonly write: Refused;
  declare readonly sendEOF: Refused;
  declare readonly resize: Refused;
  declare readonly signal: Refused;
  declare readonly handleData: Refused;
  declare readonly handleText: Refused;
  declare readonly complete: Refused;
  declare readonly close: Refused;
  declare readonly isClosed: Refused;
  declare readonly getExitCode: Refused;
  declare readonly wait: RefusedAsync;
}
refuse(
  "Sprites",
  "OpConn",
  OpConn,
  Object.fromEntries(
    [
      "write",
      "sendEOF",
      "resize",
      "signal",
      "handleData",
      "handleText",
      "complete",
      "close",
      "isClosed",
      "getExitCode",
    ].map((name) => [name, CONTROL]),
  ),
  { sync: true },
);
refuse("Sprites", "OpConn", OpConn, { wait: CONTROL });
export class ControlConnection extends EventEmitter {
  declare readonly isActive: Refused;
  declare readonly setActive: Refused;
  declare readonly clearOpConn: Refused;
  declare readonly connect: RefusedAsync;
  declare readonly startOp: RefusedAsync;
  declare readonly sendData: Refused;
  declare readonly close: Refused;
  declare readonly isClosed: Refused;
}
refuse(
  "Sprites",
  "ControlConnection",
  ControlConnection,
  Object.fromEntries(
    ["isActive", "setActive", "clearOpConn", "sendData", "close", "isClosed"].map((name) => [
      name,
      CONTROL,
    ]),
  ),
  { sync: true },
);
refuse("Sprites", "ControlConnection", ControlConnection, {
  connect: CONTROL,
  startOp: CONTROL,
});
export class SpritesClient {
  readonly runtime: Runtime;
  /** The Runtime API the calls go to. */
  readonly baseURL: string;
  /** The Runtime key given, if any; otherwise RUNTIME_API_KEY or the saved login is used. */
  readonly token: string;
  /** Always false: true is refused (control mode). */
  readonly controlMode = false;
  declare static readonly createToken: RefusedAsync;
  declare readonly watchSprites: RefusedAsync;
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
    this.baseURL = this.runtime.transport?.baseUrl ?? options.baseUrl ?? options.baseURL ?? "";
    this.token = options.apiKey ?? token ?? "";
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
    const s = await api(
      () =>
        create(
          this.runtime,
          "sprites",
          {
            name,
            persistent: true,
            vcpu: c.cpus,
            memoryMiB: c.ramMB,
            diskMiB:
              c.storageGB === undefined ? undefined : Math.ceil((c.storageGB * 1e9) / 1048576),
            region: region("Sprites", c.region),
            labels: { "compat.labels": JSON.stringify(o.labels ?? []) },
          },
          o.environment,
          undefined,
          o.waitForCapacity === false ? { waitForCapacityMs: 0 } : {},
        ),
      true,
    );
    const sprite = new Sprite(name, this);
    sprite.hydrate(s);
    sprite.environment = { ...o.environment };
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
    sprite.hydrate(await api(() => lookup(this.runtime, name)));
    return sprite;
  }
  async deleteSprite(name: string) {
    await api(async () => destroy(await lookup(this.runtime, name)));
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
    const values = (await api(() => all(this.runtime, "sprites"))).filter((s) =>
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
    return (await api(() => all(this.runtime, "sprites")))
      .filter((s) => (s.info.name ?? s.id).startsWith(prefix ?? ""))
      .map((s) => {
        const sprite = this.sprite(s.info.name ?? s.id);
        sprite.hydrate(s);
        return sprite;
      });
  }
  async restartSprite(name: string) {
    return api(async () => {
      const s = await lookup(this.runtime, name);
      await s.stop();
      await s.restart();
      return { spriteName: name, machineId: s.id, message: "Restarted" };
    });
  }
  /** Its state as Runtime reports it now; `elapsed` is the lookup's milliseconds. */
  async checkSprite(name: string): Promise<SpriteCheck> {
    const started = performance.now();
    const s = await api(() => lookup(this.runtime, name));
    return {
      spriteName: name,
      spriteId: s.id,
      status: s.state,
      checkedAt: new Date(),
      elapsed: Math.round(performance.now() - started),
    };
  }
  /** Runtime keeps each sandbox's system current itself, so there is nothing
   * to move to: this checks that the Sprite exists, as the vendor's call does. */
  async upgradeSprite(name: string): Promise<void> {
    await api(() => lookup(this.runtime, name));
  }
  async updateSprite(
    name: string,
    options: { urlSettings?: URLSettings; labels?: string[] },
  ): Promise<Sprite> {
    return (await this.getSprite(name)).update(options);
  }
  updateURLSettings(name: string, settings: { auth?: string; privateAccess?: string }) {
    return this.sprite(name).updateURLSettings(settings);
  }
}
refuse("Sprites", "SpritesClient", SpritesClient, {
  watchSprites: "watch sandbox state with runtime.events or signed webhooks",
});
refuse(
  "Sprites",
  "SpritesClient",
  { prototype: SpritesClient },
  {
    createToken:
      "Fly macaroons are not Runtime credentials; create a Runtime API key in the console",
  },
);
export class Sprite {
  id?: string;
  /** Runtime does not send the organization's name with a sandbox. */
  organizationName?: string;
  status?: string;
  config?: SpriteConfig;
  /** Set by createSprite; Runtime keeps it in the sandbox, not in its listing. */
  environment?: Record<string, string>;
  createdAt?: Date;
  updatedAt?: Date;
  url?: string;
  urlSettings?: URLSettings;
  /** Vendor storage and version fields; Runtime has no equivalent to report. */
  bucketName?: string;
  primaryRegion?: string;
  version?: string;
  environmentVersion?: string;
  labels: string[] = [];
  lastRunningAt?: Date;
  lastWarmingAt?: Date;
  declare readonly restoreCheckpoint: RefusedAsync;
  declare readonly getControlConnection: RefusedAsync;
  declare readonly listServices: RefusedAsync;
  declare readonly getService: RefusedAsync;
  declare readonly createService: RefusedAsync;
  declare readonly deleteService: RefusedAsync;
  declare readonly startService: RefusedAsync;
  declare readonly stopService: RefusedAsync;
  declare readonly restartService: RefusedAsync;
  declare readonly getServiceLogs: RefusedAsync;
  declare readonly signalService: RefusedAsync;
  declare readonly getPrivilegesPolicy: RefusedAsync;
  declare readonly updatePrivilegesPolicy: RefusedAsync;
  declare readonly deletePrivilegesPolicy: RefusedAsync;
  declare readonly getResourcesPolicy: RefusedAsync;
  declare readonly updateResourcesPolicy: RefusedAsync;
  declare readonly deleteResourcesPolicy: RefusedAsync;
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
    this.primaryRegion = s.info.region;
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
    only("Sprites spawn", options, EXEC_KEYS);
    return new SpriteCommand(this, command, args, options);
  }
  exec(command: string, options: ExecOptions = {}) {
    only("Sprites exec", options, EXEC_KEYS);
    return this.execFile("bash", ["-c", command], options);
  }
  execFile(file: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
    only("Sprites exec", options, EXEC_KEYS);
    return this.#execute(file, args, options);
  }
  /** Runtime's commands are HTTP calls already; `input` is written to stdin
   * and stdin closed, and without it stdin is closed at once. */
  execFileHTTP(
    file: string,
    args: string[] = [],
    options: Omit<ExecOptions, "tty" | "sessionId" | "controlMode" | "detachable"> & {
      input?: string | Buffer;
    } = {},
  ): Promise<ExecResult> {
    only("Sprites HTTP exec", options, [
      "cwd",
      "env",
      "encoding",
      "maxBuffer",
      "signal",
      "timeout",
      "input",
    ]);
    const { input, ...rest } = options;
    return this.#execute(file, args, rest, input ?? "");
  }
  async #execute(
    file: string,
    args: string[],
    options: ExecOptions,
    input?: string | Buffer,
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
    if (options.controlMode) throw new CompatibilityError("Sprites", "control-mode wire protocol");
    const cmd = this.spawn(file, args, options);
    if (input !== undefined) {
      if (input.length) cmd.stdin.end(input);
      else cmd.stdin.end();
    }
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
      if (exitCode !== 0) throw new ExecError(`Command exited with code ${exitCode}`, r);
      return r;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  createSession(command: string, args: string[] = [], options: SpawnOptions = {}) {
    only("Sprites session", options, SPAWN_KEYS);
    // The pinned SDK's session wrapper forces a terminal, even when a caller
    // supplies tty:false. Attaching an existing session detects its own PTY.
    return this.spawn(command, args, { ...options, detachable: true, tty: true });
  }
  attachSession(sessionId: string, options: SpawnOptions = {}) {
    only("Sprites session", options, SPAWN_KEYS);
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
  /** Ends a session: `signal` (SIGTERM by default; "TERM" works too), then
   * SIGKILL if it has not exited within `timeout` ("10s" by default). */
  async killSession(sessionId: string, signal = "SIGTERM", timeout = "10s") {
    const name = signalName(signal);
    const ms = duration(timeout, "timeout");
    const process = await (await this.native()).processes.get(sessionId);
    const kill = (async function* (): AsyncGenerator<SessionKillEvent> {
      try {
        await process.kill(name);
        yield { type: "signal", signal: name };
        try {
          const result = await process.wait({ signal: timeoutSignal(ms) });
          yield { type: "exited", exitCode: result.exitCode ?? undefined };
        } catch (error) {
          if (!(error instanceof Error) || !["TimeoutError", "AbortError"].includes(error.name))
            throw error;
          yield { type: "timeout", message: `Still running after ${timeout}` };
          await process.kill("SIGKILL");
          yield { type: "killed", signal: "SIGKILL" };
        }
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        yield { type: "error", message: error.message };
        return;
      }
      yield { type: "complete" };
    })();
    return new SessionKillStream(kill);
  }
  /** Ports listening in the Sprite now, then each one opened or closed. */
  async watchPorts(): Promise<PortWatcher> {
    const watcher = new PortWatcher(this.client, this.id ?? this.name);
    await watcher.connect();
    return watcher;
  }
  /** Runtime keeps each sandbox's system current itself; this checks it exists. */
  async upgrade(): Promise<void> {
    await this.client.upgradeSprite(this.id ?? this.name);
  }
  check(): Promise<SpriteCheck> {
    return this.client.checkSprite(this.id ?? this.name);
  }
  /** A checkpoint is a Runtime disk snapshot: the files, not the running
   * processes. The Sprite is paused for the moment it takes, then woken.
   * Progress arrives as the vendor's stream; a refusal is an `error` message. */
  async createCheckpoint(comment?: string): Promise<CheckpointStream> {
    if (comment !== undefined && typeof comment !== "string")
      throw new TypeError("comment must be a string");
    const s = await this.native();
    const taken = s.snapshot({
      mode: "disk",
      labels: { "compat.sprite": s.id, ...(comment ? { "compat.comment": comment } : {}) },
    });
    taken.catch(() => undefined);
    return new CheckpointStream(
      (async function* (): AsyncGenerator<StreamMessage> {
        yield { type: "info", data: "Creating checkpoint" };
        try {
          const snapshot = await taken;
          yield { type: "info", data: `Checkpoint ${snapshot.id} created` };
        } catch (error) {
          if (!(error instanceof RuntimeError)) throw error;
          yield { type: "error", error: error.message };
          return;
        }
        yield { type: "complete" };
      })(),
    );
  }
  /** This Sprite's disk snapshots, newest first. */
  async listCheckpoints(historyFilter?: string): Promise<Checkpoint[]> {
    if (historyFilter !== undefined)
      throw new CompatibilityError("Sprites", "checkpoint history filters");
    const s = await this.native();
    const found: Checkpoint[] = [];
    for await (const snapshot of await this.client.runtime.snapshots.list({
      sandboxId: s.id,
      state: "ready",
    }))
      if (snapshot.mode === "disk" && snapshot.sourceSandboxId === s.id)
        found.push(checkpoint(snapshot));
    return found.sort((a, b) => b.createTime.getTime() - a.createTime.getTime());
  }
  async getCheckpoint(id: string): Promise<Checkpoint> {
    const s = await this.native();
    let snapshot: Snapshot;
    try {
      snapshot = await this.client.runtime.snapshots.get(id);
    } catch (error) {
      if (error instanceof NotFoundError) throw new Error(`Checkpoint not found: ${id}`);
      throw error;
    }
    if (snapshot.mode !== "disk" || snapshot.sourceSandboxId !== s.id)
      throw new Error(`Checkpoint not found: ${id}`);
    return checkpoint(snapshot);
  }
  /** Forwards localhost:`localPort` here to `remotePort` in the Sprite. */
  proxyPort(localPort: number, remotePort: number, remoteHost?: string): Promise<ProxySession> {
    return proxyPort(this.client, this.id ?? this.name, localPort, remotePort, remoteHost);
  }
  proxyPorts(mappings: PortMapping[]): Promise<ProxySession[]> {
    return proxyPorts(this.client, this.id ?? this.name, mappings);
  }
  /** Runtime's network rules as Sprites rules: `* deny` closes the internet,
   * allow rules are the only destinations reachable, deny rules are refused. */
  async getNetworkPolicy(): Promise<NetworkPolicy> {
    const policy = await (await this.native()).network.get();
    if (!policy.internet) return { rules: [{ domain: "*", action: "deny" }] };
    const rules: PolicyRule[] = [
      ...policy.allow.map((domain) => ({ domain, action: "allow" as const })),
      ...policy.deny.map((domain) => ({ domain, action: "deny" as const })),
    ];
    if (policy.allow.length) rules.push({ domain: "*", action: "deny" });
    return { rules };
  }
  /** Replaces the rules, keeping any host:port openings set through Runtime. */
  async updateNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    const rules = networkRules(policy);
    const s = await this.native();
    const current = await s.network.get();
    await s.network.set({ ...rules, connect: current.connect });
  }
  /** Control mode is never on: Runtime refuses `controlMode: true`. */
  useControlMode(): boolean {
    return false;
  }
  hasControlConnection(): boolean {
    return false;
  }
  /** Nothing to close: no control connection is ever opened. */
  closeControlConnection(): void {}

  async updateURLSettings(settings: { auth?: string; privateAccess?: string }) {
    validateURLSettings(settings);
    const p = await (
      await this.native()
    ).previews.create(8080, { visibility: settings.auth === "public" ? "public" : "private" });
    this.url = p.urlWithToken ?? p.url;
    this.urlSettings = { auth: settings.auth };
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
const SERVICES =
  "Runtime has no service manager; run it as a process with spawn, or as an image's start command";
refuse("Sprites", "Sprite", Sprite, {
  restoreCheckpoint:
    "Runtime has no in-place restore; start a new sandbox from the checkpoint with runtime.sandboxes.create({ snapshot: id })",
  getControlConnection: CONTROL,
  listServices: SERVICES,
  getService: SERVICES,
  createService: SERVICES,
  deleteService: SERVICES,
  startService: SERVICES,
  stopService: SERVICES,
  restartService: SERVICES,
  getServiceLogs: SERVICES,
  signalService: SERVICES,
  getPrivilegesPolicy: "Runtime sets one privilege profile for every sandbox: root through sudo",
  updatePrivilegesPolicy: "Runtime sets one privilege profile for every sandbox: root through sudo",
  deletePrivilegesPolicy: "Runtime sets one privilege profile for every sandbox: root through sudo",
  getResourcesPolicy: "read the sandbox's memory size from runtime.sandboxes.get",
  updateResourcesPolicy:
    "change memory with the native sandbox's resize(), which restarts its programs",
  deleteResourcesPolicy:
    "change memory with the native sandbox's resize(), which restarts its programs",
});
function checkpoint(snapshot: Snapshot): Checkpoint {
  const labels = (snapshot.labels ?? {}) as Record<string, string>;
  return {
    id: snapshot.id,
    createTime: new Date(snapshot.createdAt),
    comment: labels["compat.comment"],
    isAuto: false,
    health: snapshot.state === "ready" ? "" : snapshot.state,
  };
}
/** Sprites lets the more specific rule win and reads `rules: []` as no
 * limit; Runtime's allow list is the only destinations reachable and its deny
 * list always wins. A policy whose meaning would differ is refused. */
function networkRules(policy: NetworkPolicy): NetworkRules {
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.rules))
    throw new TypeError("policy.rules must be an array");
  only("Sprites network policy", policy, ["rules"]);
  const allow: string[] = [];
  const deny: string[] = [];
  let everything: "allow" | "deny" | undefined;
  for (const rule of policy.rules) {
    if (!rule || typeof rule !== "object") throw new TypeError("Each rule must be an object");
    only("Sprites network rule", rule, ["domain", "action", "include"]);
    if (rule.include !== undefined)
      throw new CompatibilityError(
        "Sprites",
        `the network preset ${String(rule.include)}; list its domains as allow rules`,
      );
    if (typeof rule.domain !== "string" || !rule.domain.trim())
      throw new TypeError("Each rule needs a domain");
    if (rule.action !== "allow" && rule.action !== "deny")
      throw new TypeError("action must be allow or deny");
    const domain = rule.domain.trim().toLowerCase();
    if (domain === "*") {
      if (everything && everything !== rule.action)
        throw new TypeError("* is both allowed and denied");
      everything = rule.action;
    } else (rule.action === "allow" ? allow : deny).push(domain);
  }
  const covers = (wide: string, narrow: string) =>
    wide === narrow || (wide.startsWith("*.") && narrow.endsWith(wide.slice(1)));
  for (const allowed of allow)
    for (const denied of deny)
      if (covers(denied, allowed))
        throw new CompatibilityError(
          "Sprites",
          `allowing ${allowed} inside the denied ${denied}; Runtime's deny rules always win`,
        );
  if (everything === "deny" && !allow.length) return { internet: false, allow: [], deny };
  return { internet: true, allow: everything === "allow" ? [] : allow, deny };
}

/** A local listener that carries each connection to a port in the Sprite,
 * over Runtime's tunnel. Node and Bun. */
export class ProxySession extends EventEmitter {
  readonly localPort: number;
  readonly remotePort: number;
  readonly remoteHost: string;
  #sprite: Sprite;
  #forward: PortForward | undefined;
  #closed = false;
  #done: Promise<void>;
  #finish!: () => void;
  constructor(
    client: SpritesClient | { baseURL: string; token: string },
    spriteName: string,
    mapping: PortMapping,
  ) {
    super();
    only("Sprites port mapping", mapping, ["localPort", "remotePort", "remoteHost"]);
    for (const [name, port] of [
      ["localPort", mapping.localPort],
      ["remotePort", mapping.remotePort],
    ] as const)
      if (
        !Number.isInteger(port) ||
        port < 0 ||
        port > 65535 ||
        (name === "remotePort" && port === 0)
      )
        throw new TypeError(`${name} must be a port number`);
    const host = mapping.remoteHost ?? "localhost";
    if (!["localhost", "127.0.0.1", "::1"].includes(host))
      throw new CompatibilityError(
        "Sprites",
        `proxying to ${host}; forward a port of the Sprite itself (localhost)`,
      );
    this.localPort = mapping.localPort;
    this.remotePort = mapping.remotePort;
    this.remoteHost = host;
    const owner =
      client instanceof SpritesClient
        ? client
        : new SpritesClient(client.token, { baseURL: client.baseURL });
    this.#sprite = owner.sprite(spriteName);
    this.#done = new Promise((resolve) => (this.#finish = resolve));
  }
  async start(): Promise<void> {
    if (this.#closed) throw new Error("Proxy session is closed");
    try {
      const s = await ready(await this.#sprite.native());
      this.#forward = await s.forwardPort(this.remotePort, {
        localPort: this.localPort,
        host: "localhost",
      });
    } catch (error) {
      if (this.listenerCount("error")) this.emit("error", error);
      throw error;
    }
    if (this.#closed) await this.#forward.close();
  }
  localAddr(): string | null {
    return this.#forward && !this.#closed ? `localhost:${this.#forward.localPort}` : null;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#forward?.close().catch(() => undefined);
    this.#finish();
    this.emit("close");
  }
  wait(): Promise<void> {
    return this.#done;
  }
}
export class ProxyManager {
  #sessions: ProxySession[] = [];
  addSession(session: ProxySession): void {
    this.#sessions.push(session);
  }
  closeAll(): void {
    for (const session of this.#sessions) session.close();
  }
  async waitAll(): Promise<void> {
    await Promise.all(this.#sessions.map((session) => session.wait()));
  }
}
export async function proxyPort(
  client: SpritesClient | { baseURL: string; token: string },
  spriteName: string,
  localPort: number,
  remotePort: number,
  remoteHost?: string,
): Promise<ProxySession> {
  const session = new ProxySession(client, spriteName, { localPort, remotePort, remoteHost });
  await session.start();
  return session;
}
/** All or none: a mapping that cannot start closes the ones before it. */
export async function proxyPorts(
  client: SpritesClient | { baseURL: string; token: string },
  spriteName: string,
  mappings: PortMapping[],
): Promise<ProxySession[]> {
  const sessions: ProxySession[] = [];
  try {
    for (const mapping of mappings) {
      const session = new ProxySession(client, spriteName, mapping);
      sessions.push(session);
      await session.start();
    }
    return sessions;
  } catch (error) {
    for (const session of sessions) session.close();
    throw error;
  }
}

/** Polls the Sprite's listening TCP sockets once a second with `ss` (as
 * Sprites' own watcher keeps a connection open, this keeps it awake). */
export class PortWatcher extends Feed<PortWatchEvent> {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #sprite: Sprite;
  constructor(client: SpritesClient, spriteName: string) {
    super();
    this.#sprite = client.sprite(spriteName);
  }
  async connect(): Promise<void> {
    const s = await ready(await this.#sprite.native());
    let known = await listening(s);
    this.push({ type: "port_list", ports: [...known.values()] });
    const tick = async () => {
      if (this.#stopped) return;
      try {
        const now = await listening(s);
        for (const [key, port] of known)
          if (!now.has(key)) this.push({ ...port, type: "port_closed" });
        for (const [key, port] of now) if (!known.has(key)) this.push(port);
        known = now;
      } catch (error) {
        this.end(error);
        return;
      }
      if (!this.#stopped) this.#timer = setTimeout(() => void tick(), 1000);
    };
    this.#timer = setTimeout(() => void tick(), 1000);
  }
  protected override stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
  }
}
async function listening(s: Sandbox): Promise<Map<string, PortNotification>> {
  const result = await s.exec(["ss", "-Hltnp"]);
  if (result.exitCode !== 0)
    throw new Error(`Cannot list ports in the Sprite: ${result.stderr.trim() || "ss failed"}`);
  const ports = new Map<string, PortNotification>();
  for (const line of result.stdout.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const at = local.lastIndexOf(":");
    const port = Number(local.slice(at + 1));
    if (!Number.isInteger(port)) continue;
    const address = local
      .slice(0, at)
      .replace(/^\[|\]$/g, "")
      .replace(/%.*$/, "");
    const pid = Number(/pid=(\d+)/.exec(line)?.[1] ?? 0);
    ports.set(`${address}:${port}`, { type: "port_opened", port, address, pid });
  }
  return ports;
}

/** Runtime's file watch, one per path, as Sprites' watch events. */
export class FilesystemWatcher extends Feed<FilesystemWatchEvent> {
  #handles: WatchHandle[] = [];
  #stopped = false;
  #files: GuestFiles;
  constructor(
    private readonly sandbox: () => Promise<Sandbox>,
    private readonly paths: string[],
    workingDir: string,
    private readonly recursive: boolean,
  ) {
    super();
    this.#files = new GuestFiles(sandbox, workingDir);
  }
  async connect(): Promise<void> {
    const s = await this.sandbox();
    const paths = this.paths.map((path) => this.#files.path(path));
    try {
      for (const path of paths) {
        const handle = await s.files.watch(
          path,
          (event) => {
            if (event.type === "access") return;
            this.push({
              type: "event",
              path: event.path,
              event: event.type,
              isDir: event.isDir,
              timestamp: new Date().toISOString(),
            });
          },
          { recursive: this.recursive, timeoutMs: 0 },
        );
        this.#handles.push(handle);
        if (this.#stopped) void handle.stop().catch(() => undefined);
      }
    } catch (error) {
      this.stop();
      throw error;
    }
    this.push({ type: "subscribed", paths });
  }
  protected override stop(): void {
    this.#stopped = true;
    for (const handle of this.#handles.splice(0)) void handle.stop().catch(() => undefined);
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
    only("Sprites spawn", options, EXEC_KEYS);
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
    private readonly cwd = "/",
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
  async rm(path: string, options: { recursive?: boolean; force?: boolean; asRoot?: boolean } = {}) {
    if (!options.force && !(await this.files.exists(path)))
      throw new FilesystemError(`Path not found: ${path}`, "ENOENT", path, "rm");
    if (options.asRoot)
      return this.#root(
        path,
        "rm",
        ["rm", "-f", ...(options.recursive ? ["-r"] : []), "--", this.files.path(path)],
        true,
      );
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
  async rename(from: string, to: string, options: { asRoot?: boolean } = {}) {
    if (options.asRoot)
      return this.#root(
        from,
        "rename",
        ["mv", "-f", "-T", "--", this.files.path(from), this.files.path(to)],
        true,
      );
    return fileOperation(from, "rename", () => this.files.rename(from, to, true));
  }
  async copyFile(
    from: string,
    to: string,
    options: { recursive?: boolean; preserveAttrs?: boolean; asRoot?: boolean } = {},
  ) {
    if (options.asRoot || options.preserveAttrs)
      return this.#root(
        from,
        "copyFile",
        [
          "cp",
          ...(options.recursive ? ["-R"] : []),
          ...(options.preserveAttrs ? ["--preserve=mode,ownership,timestamps"] : []),
          "--",
          this.files.path(from),
          this.files.path(to),
        ],
        options.asRoot === true,
      );
    return fileOperation(from, "copyFile", () =>
      this.files.copy(from, to, options.recursive, true),
    );
  }
  async chmod(path: string, mode: number, options: { recursive?: boolean; asRoot?: boolean } = {}) {
    if (options.asRoot) {
      if (!Number.isInteger(mode) || mode < 0) throw new TypeError("mode must be a file mode");
      return this.#root(
        path,
        "chmod",
        [
          "chmod",
          ...(options.recursive ? ["-R"] : []),
          (mode & 0o7777).toString(8),
          "--",
          this.files.path(path),
        ],
        true,
      );
    }
    return fileOperation(path, "chmod", () => this.files.chmod(path, mode, options.recursive));
  }
  /** By number or name, as the Sprite's user unless `asRoot` (sudo). */
  async chown(
    path: string,
    options: {
      uid?: number | string;
      gid?: number | string;
      recursive?: boolean;
      asRoot?: boolean;
    },
  ): Promise<void> {
    only("Sprites chown", options ?? {}, ["uid", "gid", "recursive", "asRoot"]);
    if (options?.uid === undefined && options?.gid === undefined)
      throw new TypeError("uid or gid is required");
    for (const id of [options.uid, options.gid])
      if (
        id !== undefined &&
        !(typeof id === "number" ? Number.isInteger(id) && id >= 0 : /^[A-Za-z0-9._-]+$/.test(id))
      )
        throw new TypeError("uid and gid must be ids or user and group names");
    const owner = `${options.uid ?? ""}${options.gid === undefined ? "" : `:${options.gid}`}`;
    return this.#root(
      path,
      "chown",
      ["chown", ...(options.recursive ? ["-R"] : []), owner, "--", this.files.path(path)],
      options.asRoot === true,
    );
  }
  /** Changes to these paths until the watcher is closed. */
  async watch(paths: string | string[], options: { recursive?: boolean } = {}) {
    only("Sprites watch", options, ["recursive"]);
    const list = Array.isArray(paths) ? paths : [paths];
    if (!list.length || list.some((path) => typeof path !== "string" || !path))
      throw new TypeError("paths must name at least one path");
    const watcher = new FilesystemWatcher(this.get, list, this.cwd, options.recursive === true);
    await watcher.connect();
    return watcher;
  }
  /** A guest command for what the file API does not offer: as root through
   * sudo when asked, and its failure as the vendor's FilesystemError. */
  async #root(path: string, syscall: string, argv: string[], asRoot: boolean): Promise<void> {
    const result = await (await this.get()).exec(asRoot ? ["sudo", "-n", "--", ...argv] : argv);
    if (result.exitCode === 0) return;
    const message = result.stderr.trim() || `${syscall} failed`;
    const code: FilesystemErrorCode = /No such file/i.test(message)
      ? "ENOENT"
      : /File exists/i.test(message)
        ? "EEXIST"
        : /Not a directory/i.test(message)
          ? "ENOTDIR"
          : /Is a directory/i.test(message)
            ? "EISDIR"
            : /Directory not empty/i.test(message)
              ? "ENOTEMPTY"
              : /Operation not permitted|password is required|sudo:/i.test(message)
                ? "EPERM"
                : /Permission denied/i.test(message)
                  ? "EACCES"
                  : /invalid/i.test(message)
                    ? "EINVAL"
                    : "UNKNOWN";
    throw new FilesystemError(message, code, path, syscall);
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
