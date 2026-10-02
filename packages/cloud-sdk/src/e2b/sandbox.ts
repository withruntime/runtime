import type { Runtime } from "../client.js";
import type { RequestOptions } from "../transport.js";
import {
  clientFor,
  request,
  type ConnectionOpts,
  type RuntimeCreate,
  type RuntimeOpts,
  type RuntimeSandbox,
} from "./client.js";
import { Commands, type SandboxContext } from "./commands.js";
import {
  guard,
  InvalidArgumentError,
  NotSupportedError,
  SandboxError,
  SandboxNotFoundError,
  TemplateError,
} from "./errors.js";
import { Filesystem } from "./filesystem.js";
import { Pty } from "./pty.js";

/* E2B's Sandbox over Runtime's. Every call is one or a few calls of the
   withruntime SDK; nothing here speaks HTTP. What Runtime cannot do the same
   way throws NotSupportedError before anything happens. */

/** E2B's default machine: 2 vCPU and 512 MiB (docs.e2b.dev/billing, checked
 * 23 September 2026). Pass `runtime: { create: { memoryMiB } }` for another. */
export const DEFAULT_SHAPE = { vcpu: 2, memoryMiB: 512 } as const;
/** E2B's default sandbox timeout, 300 s. */
export const DEFAULT_TIMEOUT_MS = 300_000;
/** Runtime's lease bounds (MAX_TIMEOUT_SECONDS in the API). */
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 3600;
/** E2B template names that mean "the stock environment": Runtime's default image. */
const STOCK_TEMPLATES = new Set(["base", "code-interpreter-v1", "code-interpreter"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SandboxState = "running" | "paused";
export type SandboxOnTimeout =
  "pause" | "kill" | { action: "pause" | "kill"; keepMemory?: boolean };
export type SandboxLifecycle = { onTimeout: SandboxOnTimeout; autoResume?: boolean };

export interface SandboxOpts extends ConnectionOpts {
  /** An E2B template name. "base" (the default) is Runtime's stock image; any
   * other name must be a ready Runtime image of that name, and a UUID a
   * Runtime image or snapshot id. */
  template?: string;
  /** Stored as the sandbox's labels (at most 32, values up to 256 characters). */
  metadata?: Record<string, string>;
  /** The sandbox's own environment: every command, terminal and code run in it
   * gets these, whoever connects. Values are never shown again. */
  envs?: Record<string, string>;
  /** Default 300 000. Runtime's leases run 60 s to 1 hour; shorter rounds up
   * to 60 s (with a warning), longer is refused. */
  timeoutMs?: number;
  /** Accepted and ignored, as E2B ignores it. */
  secure?: boolean;
  /** false: no network at all. */
  allowInternetAccess?: boolean;
  /** What happens when the timeout ends: "kill" (E2B's default, Runtime stops
   * the sandbox) or "pause". */
  lifecycle?: SandboxLifecycle;
  mcp?: unknown;
  network?: unknown;
  iam?: unknown;
  volumeMounts?: unknown;
  /** Runtime-only: an explicit client, or fields for the create. */
  runtime?: RuntimeOpts;
}

export type SandboxConnectOpts = ConnectionOpts & {
  timeoutMs?: number;
  onResume?: "restore" | "reboot";
  runtime?: RuntimeOpts;
};
export type SandboxApiOpts = Pick<ConnectionOpts, "apiKey" | "requestTimeoutMs" | "signal"> & {
  runtime?: RuntimeOpts;
};

export interface SandboxInfo {
  sandboxId: string;
  /** "base" for Runtime's stock image, else the image or snapshot id. */
  templateId: string;
  name?: string;
  metadata: Record<string, string>;
  startedAt: Date;
  endAt: Date;
  state: SandboxState;
  cpuCount: number;
  memoryMB: number;
  /** Runtime has no envd: "runtime". */
  envdVersion: string;
  lifecycle?: { onTimeout: "pause" | "kill"; autoResume: boolean };
}
export interface SnapshotInfo {
  snapshotId: string;
  names: string[];
}
export type SandboxListOpts = SandboxApiOpts & {
  query?: {
    metadata?: Record<string, string>;
    state?: SandboxState[];
    startedAfter?: Date;
    template?: string;
  };
  order?: "asc" | "desc";
  limit?: number;
  nextToken?: string;
};

let warnedShortLease = false;

function leaseSeconds(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new InvalidArgumentError(`timeoutMs must be a positive number, not ${timeoutMs}.`);
  const seconds = Math.ceil(timeoutMs / 1000);
  if (seconds > MAX_LEASE_SECONDS)
    throw new NotSupportedError(
      `A sandbox timeout of ${timeoutMs} ms (over one hour)`,
      "Runtime leases last up to an hour (3_600_000 ms); call sandbox.setTimeout(...) before it ends to keep going, as often as needed.",
    );
  if (seconds < MIN_LEASE_SECONDS) {
    if (!warnedShortLease && typeof process !== "undefined") {
      warnedShortLease = true;
      process.emitWarning(
        `timeoutMs ${timeoutMs} is under Runtime's shortest lease; the sandbox gets 60 s. Call kill() when done.`,
        { code: "RUNTIME_E2B_SHORT_TIMEOUT" },
      );
    }
    return MIN_LEASE_SECONDS;
  }
  return seconds;
}

function onLeaseEnd(lifecycle: SandboxLifecycle | undefined): "pause" | "stop" {
  if (!lifecycle) return "stop";
  const action =
    typeof lifecycle.onTimeout === "string" ? lifecycle.onTimeout : lifecycle.onTimeout.action;
  if (typeof lifecycle.onTimeout === "object" && lifecycle.onTimeout.keepMemory === false)
    throw new NotSupportedError(
      "A files-only pause (keepMemory: false)",
      "Runtime's pause keeps memory and files; leave keepMemory out.",
    );
  return action === "pause" ? "pause" : "stop";
}

function refuseCreate(opts: SandboxOpts) {
  const refusals: Array<[keyof SandboxOpts, string, string]> = [
    [
      "mcp",
      "E2B's MCP gateway (mcp)",
      "Run MCP servers yourself with commands.run(..., { background: true }).",
    ],
    [
      "network",
      "E2B's network rules (network)",
      "Pass Runtime's rules instead: runtime: { create: { network: { internet: true, allow: [...], deny: [...] } } }.",
    ],
    ["iam", "E2B workload identity (iam)", "Pass credentials with envs."],
    [
      "volumeMounts",
      "E2B volumes (volumeMounts)",
      "Use a Runtime volume: runtime: { create: { volumes: [{ volumeId, path }] } }.",
    ],
  ];
  for (const [field, feature, alternative] of refusals)
    if (opts[field] !== undefined) throw new NotSupportedError(feature, alternative);
}

/** Where a template sends the create: the stock image, a Runtime image by
 * name or id, or a Runtime snapshot by id. */
async function resolveTemplate(
  client: Runtime,
  template: string,
  options: RequestOptions,
): Promise<Partial<RuntimeCreate>> {
  options.signal?.throwIfAborted();
  if (STOCK_TEMPLATES.has(template)) return {};
  if (UUID.test(template)) {
    try {
      await client.images.get(template, options);
      return { image: template };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    return { snapshot: template };
  }
  const page = await client.images.list({ name: template, state: "ready", limit: 1 }, options);
  const image = page.data[0];
  if (image) return { image: image.id };
  const error = new TemplateError(
    `No Runtime image is named "${template}". E2B templates do not run on Runtime; build the same ` +
      `environment as a Runtime image with that name and this call starts from it: ` +
      `\`npx withruntime image build --dockerfile e2b.Dockerfile --name ${template}\`, or ` +
      `runtime.images.build({ name: "${template}", dockerfile }).`,
  );
  error.code = "template_not_found";
  throw error;
}

function state(runtime: RuntimeSandbox): SandboxState | "stopped" {
  const current = runtime.state;
  if (current === "paused" || current === "pausing") return "paused";
  if (current === "stopped" || current === "stopping") return "stopped";
  return "running";
}

function infoOf(runtime: RuntimeSandbox): SandboxInfo {
  const info = runtime.info;
  const templateId =
    typeof info.image === "string"
      ? info.image
      : typeof info.snapshot === "string"
        ? info.snapshot
        : "base";
  const current = state(runtime);
  return {
    sandboxId: info.id,
    templateId,
    ...(info.name ? { name: info.name } : {}),
    metadata: info.labels ?? {},
    startedAt: new Date(info.createdAt),
    endAt: new Date(info.expiresAt),
    state: current === "stopped" ? "paused" : current,
    cpuCount: info.vcpu,
    memoryMB: info.memoryMiB,
    envdVersion: "runtime",
    lifecycle: {
      onTimeout: info.onLeaseEnd === "stop" ? "kill" : "pause",
      autoResume: info.autoWake === true,
    },
  };
}

function unsupported(feature: string, alternative: string): Promise<never> {
  return Promise.reject(new NotSupportedError(feature, alternative));
}

/** A sandbox, with E2B's methods. `sandbox.runtime` is the Runtime sandbox
 * underneath, for anything E2B has no name for. */
/** Where Runtime serves previews; getHost names a host under it. */
const PREVIEW_DOMAIN = "runtimehost.com";

export class Sandbox {
  protected static readonly defaultTemplate: string = "base";

  readonly files: Filesystem;
  readonly commands: Commands;
  readonly pty: Pty;
  readonly #client: Runtime;
  #runtime: RuntimeSandbox;
  #home: Promise<void> | undefined;
  /** Ports shared as public previews, by port: the one share each asked for. */
  readonly #shares = new Map<number, Promise<string>>();

  /** Use Sandbox.create or Sandbox.connect. */
  constructor(
    runtime: RuntimeSandbox,
    client: Runtime,
    protected readonly requestTimeoutMs = 60_000,
  ) {
    this.#runtime = runtime;
    this.#client = client;
    const ctx = {
      ensureHome: (text: string | undefined, options?: RequestOptions) =>
        this.#ensureHome(text, options),
      requestTimeoutMs: this.requestTimeoutMs,
    } as unknown as SandboxContext;
    // A getter, so the modules see the sandbox as it is after each refresh.
    Object.defineProperty(ctx, "runtime", { get: () => this.#runtime });
    this.files = new Filesystem(ctx);
    this.commands = new Commands(ctx);
    this.pty = new Pty(ctx);
  }

  get sandboxId(): string {
    return this.#runtime.id;
  }
  /** The Runtime sandbox underneath: previews, network, desktop, interpreter,
   * processes, terminal and the rest of Runtime's SDK. */
  get runtime(): RuntimeSandbox {
    return this.#runtime;
  }
  protected get client(): Runtime {
    return this.#client;
  }

  /** E2B's home is /home/user and Runtime's is /workspace. The first time a
   * path or command names /home/user, it is made a link to /workspace (unless
   * something is already there), so paths written for E2B work. */
  #ensureHome(text: string | undefined, options: RequestOptions = {}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const wait = (pending: Promise<void>): Promise<void> => {
      if (!signal) return pending;
      return new Promise((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the caller's abort reason as is, as the upstream SDK does
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        pending.then(
          () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
          (error: unknown) => {
            signal.removeEventListener("abort", abort);
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- passes the pending call's own failure through unchanged
            reject(error);
          },
        );
      });
    };
    if (this.#home || !text?.includes("/home/user")) return wait(this.#home ?? Promise.resolve());
    const pending = (async () => {
      const result = await guard("sandbox", () =>
        this.#runtime.exec("[ -e /home/user ] || sudo ln -s /workspace /home/user", { signal }),
      );
      if (result.exitCode !== 0 && typeof process !== "undefined")
        process.emitWarning(`Could not link /home/user to /workspace: ${result.stderr.trim()}`, {
          code: "RUNTIME_E2B_HOME",
        });
    })();
    this.#home = pending;
    pending.catch(() => {
      if (this.#home === pending) this.#home = undefined;
    });
    return wait(pending);
  }

  // ---- create, connect, list -------------------------------------------

  /** Creates a sandbox from `template` (default "base", Runtime's stock image)
   * with E2B's default machine, 2 vCPU and 512 MiB, and waits until it runs.
   * Funding is left to Runtime: the free trial while the account has trial
   * time, then prepaid credit, exactly as withruntime's own create. */
  static create<S extends typeof Sandbox>(this: S, opts?: SandboxOpts): Promise<InstanceType<S>>;
  static create<S extends typeof Sandbox>(
    this: S,
    template: string,
    opts?: SandboxOpts,
  ): Promise<InstanceType<S>>;
  static async create<S extends typeof Sandbox>(
    this: S,
    templateOrOpts?: string | SandboxOpts,
    maybeOpts?: SandboxOpts,
  ): Promise<InstanceType<S>> {
    const opts = (typeof templateOrOpts === "string" ? maybeOpts : templateOrOpts) ?? {};
    const template =
      (typeof templateOrOpts === "string" ? templateOrOpts : opts.template) ?? this.defaultTemplate;
    const options = request(opts);
    options.signal?.throwIfAborted();
    refuseCreate(opts);
    const client = clientFor(opts);
    const input: RuntimeCreate = {
      timeoutSeconds: leaseSeconds(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      onLeaseEnd: onLeaseEnd(opts.lifecycle),
      // With a lifecycle, E2B resumes a paused sandbox on traffic only when
      // asked (autoResume); Runtime's automatic wake is the same thing (0093).
      ...(opts.lifecycle ? { autoWake: opts.lifecycle.autoResume === true } : {}),
      ...(opts.metadata && Object.keys(opts.metadata).length ? { labels: opts.metadata } : {}),
      // Runtime keeps them with the sandbox: every command, terminal and
      // interpreter in it gets them, from this client or any other.
      ...(opts.envs && Object.keys(opts.envs).length ? { env: opts.envs } : {}),
      ...(opts.allowInternetAccess === false ? { network: { internet: false } } : {}),
    };
    const source = await guard("other", () => resolveTemplate(client, template, options));
    options.signal?.throwIfAborted();
    const create: RuntimeCreate = {
      // A snapshot carries its own machine; everything else gets E2B's shape.
      ...(source.snapshot ? {} : DEFAULT_SHAPE),
      ...input,
      ...source,
      ...opts.runtime?.create,
    };
    const runtime = await guard("sandbox", () => client.sandboxes.create(create, options));
    return new this(runtime, client, opts.requestTimeoutMs) as InstanceType<S>;
  }

  /** Connects to a sandbox by id, waking it if it is paused, as E2B does. A
   * `timeoutMs` moves a running sandbox's end later, never earlier. */
  static async connect<S extends typeof Sandbox>(
    this: S,
    sandboxId: string,
    opts: SandboxConnectOpts = {},
  ): Promise<InstanceType<S>> {
    const client = clientFor(opts);
    const runtime = await guard("sandbox", () => client.sandboxes.get(sandboxId, request(opts)));
    await resume(runtime, opts);
    return new this(runtime, client, opts.requestTimeoutMs) as InstanceType<S>;
  }

  /** Wakes this sandbox if it is paused. */
  async connect(opts: SandboxConnectOpts = {}): Promise<this> {
    await guard("sandbox", () => this.#runtime.refresh(request(opts)));
    await resume(this.#runtime, opts);
    return this;
  }

  /** Running and paused sandboxes, a page at a time, as E2B's paginator. */
  static list(opts: SandboxListOpts = {}): SandboxPaginator {
    return new SandboxPaginator(clientFor(opts), opts);
  }

  // ---- lifecycle --------------------------------------------------------

  /** Stops the sandbox. False when it was not found or had already ended. */
  static async kill(sandboxId: string, opts: SandboxApiOpts = {}): Promise<boolean> {
    const client = clientFor(opts);
    try {
      const runtime = await guard("sandbox", () => client.sandboxes.get(sandboxId, request(opts)));
      return await stop(runtime, opts);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
  }
  async kill(opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal"> = {}): Promise<boolean> {
    try {
      return await stop(this.#runtime, opts);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
  }

  /** Sets the sandbox to end `timeoutMs` from now. Runtime leases only move
   * later: a shorter timeout than the one it has is refused. */
  static async setTimeout(sandboxId: string, timeoutMs: number, opts: SandboxApiOpts = {}) {
    const client = clientFor(opts);
    const runtime = await guard("sandbox", () => client.sandboxes.get(sandboxId, request(opts)));
    await extendTo(runtime, timeoutMs, opts);
  }
  async setTimeout(
    timeoutMs: number,
    opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal"> = {},
  ): Promise<void> {
    await guard("sandbox", () => this.#runtime.refresh(request(opts)));
    await extendTo(this.#runtime, timeoutMs, opts);
  }

  static async getInfo(sandboxId: string, opts: SandboxApiOpts = {}): Promise<SandboxInfo> {
    const client = clientFor(opts);
    return infoOf(await guard("sandbox", () => client.sandboxes.get(sandboxId, request(opts))));
  }
  async getInfo(opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal"> = {}) {
    await guard("sandbox", () => this.#runtime.refresh(request(opts)));
    return infoOf(this.#runtime);
  }

  async isRunning(opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal"> = {}) {
    try {
      await guard("sandbox", () => this.#runtime.refresh(request(opts)));
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
    return this.#runtime.state === "running";
  }

  /** Pauses the sandbox, keeping memory and files. False when it was paused. */
  static async pause(
    sandboxId: string,
    opts: SandboxApiOpts & { keepMemory?: boolean } = {},
  ): Promise<boolean> {
    const client = clientFor(opts);
    return pause(
      await guard("sandbox", () => client.sandboxes.get(sandboxId, request(opts))),
      opts,
    );
  }
  static betaPause(sandboxId: string, opts: SandboxApiOpts & { keepMemory?: boolean } = {}) {
    return this.pause(sandboxId, opts);
  }
  async pause(opts: SandboxApiOpts & { keepMemory?: boolean } = {}): Promise<boolean> {
    await guard("sandbox", () => this.#runtime.refresh(request(opts)));
    return pause(this.#runtime, opts);
  }
  async betaPause(opts: SandboxApiOpts & { keepMemory?: boolean } = {}): Promise<boolean> {
    return this.pause(opts);
  }

  // ---- forks and snapshots ---------------------------------------------

  /** Copies of this sandbox, memory and all. While Runtime's forks are
   * switched off this throws NotSupportedError with Runtime's own words. */
  static async fork<S extends typeof Sandbox>(
    this: S,
    sandboxId: string,
    opts: SandboxApiOpts & { count?: number; timeoutMs?: number } = {},
  ): Promise<Array<InstanceType<S> | Error>> {
    const { count: _count, timeoutMs: _timeoutMs, ...connection } = opts;
    const source = await this.connect(sandboxId, connection);
    return source.fork(opts);
  }
  async fork(
    opts: SandboxApiOpts & { count?: number; timeoutMs?: number } = {},
  ): Promise<Array<this | Error>> {
    if (opts.timeoutMs !== undefined)
      // A fork's lease is Runtime's to set; one shorter than asked could not be
      // honoured after the forks exist, so this is refused before any are made.
      throw new NotSupportedError(
        "A timeout for forks (fork timeoutMs)",
        "Fork without it, then call setTimeout(ms) on each fork.",
      );
    const copies = await guard("sandbox", () =>
      this.#runtime.fork({ count: opts.count ?? 1, ...request(opts) }),
    );
    // Copies keep the source's environment on Runtime's side.
    const Kind = this.constructor as new (runtime: RuntimeSandbox, client: Runtime) => this;
    return copies.map((copy) => new Kind(copy, this.#client));
  }

  /** Keeps the sandbox's whole machine as a Runtime snapshot; start from it
   * with Sandbox.create(snapshotId). */
  async createSnapshot(opts: SandboxApiOpts & { name?: string } = {}): Promise<SnapshotInfo> {
    const snapshot = await guard("sandbox", () =>
      this.#runtime.snapshot({ ...(opts.name ? { name: opts.name } : {}), ...request(opts) }),
    );
    return { snapshotId: snapshot.id, names: snapshot.name ? [snapshot.name] : [] };
  }
  static async createSnapshot(
    sandboxId: string,
    opts: SandboxApiOpts & { name?: string } = {},
  ): Promise<SnapshotInfo> {
    const client = clientFor(opts);
    const runtime = await guard("sandbox", () => client.sandboxes.get(sandboxId, request(opts)));
    return new Sandbox(runtime, client).createSnapshot(opts);
  }
  static async deleteSnapshot(snapshotId: string, opts: SandboxApiOpts = {}): Promise<boolean> {
    const client = clientFor(opts);
    try {
      await guard("other", () => client.snapshots.delete(snapshotId, request(opts)));
      return true;
    } catch (error) {
      if (error instanceof SandboxError && error.statusCode === 404) return false;
      throw error;
    }
  }

  // ---- ports ------------------------------------------------------------

  /** E2B's getHost, answered at once as E2B answers it:
   * `<port>-<id>.runtimehost.com`. A Runtime preview's address is made from
   * the sandbox and the port alone, so it is known without a call; the port
   * is shared publicly the first time it is asked for, in about a tenth of a
   * second, beside the caller. A request that lands before the share may be
   * answered 404 for up to two seconds; `await getPublicHost(port)` returns
   * once the share has landed. */
  getHost(port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new InvalidArgumentError(`port must be a whole number from 1 to 65535, not ${port}.`);
    void this.#share(port).catch((error: unknown) => {
      if (typeof process !== "undefined" && process.emitWarning)
        process.emitWarning(
          `Sharing port ${port} for getHost failed: ${error instanceof Error ? error.message : String(error)}. getPublicHost(${port}) says why.`,
          { code: "RUNTIME_E2B_GET_HOST" },
        );
    });
    return `${port}-${this.sandboxId.replaceAll("-", "").toLowerCase()}.${PREVIEW_DOMAIN}`;
  }
  /** Shares `port` at a public HTTPS address (a Runtime preview) and returns
   * its host, `<port>-<id>.<domain>`, once the share has landed. Anyone with
   * the address can reach it; a browser sees a one-time page naming Runtime. */
  async getPublicHost(port: number): Promise<string> {
    return this.#share(port);
  }
  #share(port: number): Promise<string> {
    let share = this.#shares.get(port);
    if (!share) {
      share = guard("sandbox", () =>
        this.#runtime.previews.create(port, { visibility: "public" }),
      ).then((preview) => new URL(preview.url).host);
      // A failed share is asked again next time, not remembered.
      share.catch(() => this.#shares.delete(port));
      this.#shares.set(port, share);
    }
    return share;
  }

  // ---- what Runtime does differently -----------------------------------

  get git(): never {
    throw new NotSupportedError(
      "E2B's git module (deprecated by E2B too)",
      "Run git with sandbox.commands.run('git ...'); git is installed.",
    );
  }
  /** E2B's metrics, from Runtime's measured readings (`sbx.metrics()`): CPU
   * as a percent of the sandbox's vCPUs and resident memory, one entry per
   * host reading (every minute by default) between `start` and `end`, kept
   * 24 hours at that resolution. Disk use inside the sandbox is not measured:
   * `diskUsed` is null and `diskTotal` is the disk's size. */
  async getMetrics(opts: MetricsOpts = {}): Promise<E2BSandboxMetrics[]> {
    return e2bMetrics(this.#runtime, opts);
  }
  static async getMetrics(sandboxId: string, opts: MetricsOpts & SandboxApiOpts = {}) {
    const client = clientFor(opts);
    const runtime = await guard("sandbox", () => client.sandboxes.get(sandboxId, request(opts)));
    return e2bMetrics(runtime, opts);
  }
  updateNetwork(): Promise<never> {
    return unsupported(
      "E2B's network rules (updateNetwork)",
      "Use sandbox.runtime.network.set({ internet, allow, deny }).",
    );
  }
  uploadUrl(): Promise<never> {
    return unsupported("Signed upload URLs", "Use sandbox.files.write(path, data).");
  }
  downloadUrl(): Promise<never> {
    return unsupported(
      "Signed download URLs",
      "Use sandbox.files.read(path, { format: 'bytes' }).",
    );
  }
  getMcpUrl(): never {
    throw new NotSupportedError(
      "E2B's MCP gateway",
      "Runtime's own MCP server is `npx withruntime mcp`.",
    );
  }
  getMcpToken(): Promise<never> {
    return unsupported("E2B's MCP gateway", "Runtime's own MCP server is `npx withruntime mcp`.");
  }
}

async function resume(runtime: RuntimeSandbox, opts: SandboxConnectOpts) {
  if (opts.onResume === "reboot")
    throw new NotSupportedError(
      "Resuming by reboot (onResume: 'reboot')",
      "Runtime's wake restores memory; stop the sandbox and create a new one for a clean boot.",
    );
  const current = state(runtime);
  if (current === "stopped") throw new SandboxNotFoundError(`Sandbox ${runtime.id} has ended.`);
  if (current === "paused") {
    await guard("sandbox", () =>
      runtime.wake({
        ...(opts.timeoutMs === undefined ? {} : { timeoutSeconds: leaseSeconds(opts.timeoutMs) }),
        ...request(opts),
      }),
    );
    return;
  }
  if (opts.timeoutMs !== undefined) {
    const later = Date.now() + opts.timeoutMs - Date.parse(runtime.info.expiresAt);
    if (later > 1000)
      await guard("sandbox", () => runtime.extend(Math.ceil(later / 1000), request(opts)));
  }
}

async function stop(
  runtime: RuntimeSandbox,
  opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal">,
) {
  if (state(runtime) === "stopped") return false;
  await guard("sandbox", () => runtime.stop({ wait: false, ...request(opts) }));
  return true;
}

async function extendTo(
  runtime: RuntimeSandbox,
  timeoutMs: number,
  opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal">,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new InvalidArgumentError(`timeoutMs must be a positive number, not ${timeoutMs}.`);
  const later = Date.now() + timeoutMs - Date.parse(runtime.info.expiresAt);
  if (later < -1000)
    throw new NotSupportedError(
      "Shortening a sandbox's timeout",
      "Runtime leases only move later. Call kill() when the work is done.",
    );
  if (later > 1000)
    await guard("sandbox", () => runtime.extend(Math.ceil(later / 1000), request(opts)));
}

async function pause(runtime: RuntimeSandbox, opts: SandboxApiOpts & { keepMemory?: boolean }) {
  if (opts.keepMemory === false)
    throw new NotSupportedError(
      "A files-only pause (keepMemory: false)",
      "Runtime's pause keeps memory and files; leave keepMemory out.",
    );
  const current = state(runtime);
  if (current === "paused") return false;
  if (current === "stopped") throw new SandboxNotFoundError(`Sandbox ${runtime.id} has ended.`);
  await guard("sandbox", () => runtime.pause(request(opts)));
  return true;
}

const RUNNING = ["starting", "running", "resuming"] as const;
const PAUSED = ["pausing", "paused"] as const;

/** E2B's paginator: `while (p.hasNext) items.push(...(await p.nextItems()))`. */
export class SandboxPaginator {
  readonly #client: Runtime;
  readonly #request: RequestOptions;
  readonly #filter: Parameters<Runtime["sandboxes"]["list"]>[0];
  #page: Awaited<ReturnType<Runtime["sandboxes"]["list"]>> | undefined;
  #hasNext = true;

  constructor(client: Runtime, opts: SandboxListOpts) {
    this.#client = client;
    this.#request = request(opts);
    const query = opts.query ?? {};
    if (query.template !== undefined && !STOCK_TEMPLATES.has(query.template))
      throw new NotSupportedError(
        "Listing by template",
        "Filter by metadata instead: give sandboxes a metadata key when you create them.",
      );
    if (query.startedAfter !== undefined)
      throw new NotSupportedError(
        "Listing by start time (startedAfter)",
        "List them all and filter on getInfo().startedAt.",
      );
    if (opts.order === "desc")
      throw new NotSupportedError(
        "Newest-first listing (order: 'desc')",
        "Runtime lists oldest first; reverse the list yourself.",
      );
    if (opts.nextToken !== undefined)
      throw new NotSupportedError(
        "Starting a list from a saved nextToken",
        "Keep the paginator and call nextItems() again.",
      );
    const states = query.state?.length ? query.state : (["running", "paused"] as const);
    this.#filter = {
      state: states.flatMap((one) => (one === "running" ? [...RUNNING] : [...PAUSED])),
      ...(query.metadata && Object.keys(query.metadata).length ? { labels: query.metadata } : {}),
      ...(opts.limit ? { limit: Math.min(opts.limit, 100) } : {}),
    };
  }
  get hasNext(): boolean {
    return this.#hasNext;
  }
  get nextToken(): string | undefined {
    return this.#page?.nextCursor ?? undefined;
  }
  async nextItems(): Promise<SandboxInfo[]> {
    this.#request.signal?.throwIfAborted();
    if (!this.#hasNext) throw new SandboxError("No more items to fetch.");
    const previous = this.#page;
    const page = await guard("other", async () =>
      previous
        ? await previous.next()
        : await this.#client.sandboxes.list(this.#filter, this.#request),
    );
    this.#page = page ?? undefined;
    this.#hasNext = Boolean(page?.hasMore);
    return (page?.data ?? []).map(infoOf);
  }
}

type MetricsOpts = { start?: Date | number; end?: Date | number };
export type E2BSandboxMetrics = {
  timestamp: Date;
  cpuUsedPct: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  /** Not measured by Runtime: null. */
  diskUsed: number | null;
  diskTotal: number;
};
async function e2bMetrics(
  runtime: RuntimeSandbox,
  opts: MetricsOpts,
): Promise<E2BSandboxMetrics[]> {
  const start =
    opts.start === undefined ? Date.now() - 15 * 60_000 : new Date(opts.start).getTime();
  const end = opts.end === undefined ? Date.now() : new Date(opts.end).getTime();
  const span = Date.now() - start;
  const range =
    span <= 15 * 60_000 ? "15m" : span <= 3_600_000 ? "1h" : span <= 6 * 3_600_000 ? "6h" : "24h";
  const metrics = await runtime.metrics({ range });
  return metrics.points
    .filter((point) => {
      const at = Date.parse(point.at);
      return at >= start - metrics.stepSeconds * 1000 && at <= end && point.cpuPercent !== null;
    })
    .map((point) => ({
      timestamp: new Date(point.at),
      cpuUsedPct: point.cpuPercent!,
      cpuCount: metrics.vcpu,
      memUsed: point.memoryBytes,
      memTotal: metrics.memoryLimitBytes,
      diskUsed: null,
      diskTotal: metrics.diskLimitBytes,
    }));
}
