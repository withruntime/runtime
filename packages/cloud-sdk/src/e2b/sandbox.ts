import type { Runtime } from "../client.js";
import type { RequestOptions } from "../transport.js";
import {
  clientFor,
  keySource,
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
  PublicPreviewNotAllowedError,
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
/** E2B's default sandbox timeout, 300 s. A sandbox created without timeoutMs
 * gets it, and is paused when it runs out rather than killed, since nobody
 * asked for it to end: nothing in it is lost, and the next call wakes it. On
 * a pilot account the server keeps every sandbox running instead (0254). */
export const DEFAULT_TIMEOUT_MS = 300_000;
/** Runtime's time limit bounds (MIN_TIMEOUT_SECONDS and MAX_TIMEOUT_SECONDS
 * in the API): a minute to 24 hours, E2B's longest (its Pro plan). The server
 * keeps the deadline: nothing in this process has to stay running for it. */
const MIN_TIMEOUT_SECONDS = 60;
const LONGEST_TIMEOUT_MS = 86_400_000;
/** Makes E2B's home lead to Runtime's unless the image has its own, and
 * prints "same" when /home/user is then /workspace. */
const HOME_LINK =
  "[ -e /home/user ] || sudo ln -s /workspace /home/user || exit 1; if [ /home/user -ef /workspace ]; then echo same; fi";
/** The label that keeps the template a sandbox was made from, so getInfo
 * and list name it whichever client asks; it is not shown in `metadata`. */
export const TEMPLATE_LABEL = "e2b-template";
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
  /** When it ends, at most 24 hours. Leave it out for no time limit: it runs
   * while it works and pauses when idle. Runtime's limits run 60 s to 1 hour:
   * shorter rounds up to 60 s (with a warning); longer gets an hour, moved on
   * while this process runs, up to the time asked for. */
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

/** E2B's own bound since 2.52.0: refused before anything happens. */
const MAX_FORK_COUNT = 20;
function checkForkCount(count: number | undefined) {
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_FORK_COUNT))
    throw new InvalidArgumentError(`count must be an integer between 1 and ${MAX_FORK_COUNT}`);
}

/** Runtime's time limit for `timeoutMs`, in whole seconds: at least a
 * minute (with a warning once), at most 24 hours. */
function timeoutSeconds(timeoutMs: number): number {
  checkTimeout(timeoutMs);
  const seconds = Math.ceil(timeoutMs / 1000);
  if (seconds < MIN_TIMEOUT_SECONDS) {
    if (!warnedShortLease && typeof process !== "undefined") {
      warnedShortLease = true;
      process.emitWarning(
        `timeoutMs ${timeoutMs} is under Runtime's shortest time limit; the sandbox gets 60 s. Call kill() when done.`,
        { code: "RUNTIME_E2B_SHORT_TIMEOUT" },
      );
    }
    return MIN_TIMEOUT_SECONDS;
  }
  return seconds;
}

function checkTimeout(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new InvalidArgumentError(`timeoutMs must be a positive number, not ${timeoutMs}.`);
  if (timeoutMs > LONGEST_TIMEOUT_MS)
    throw new InvalidArgumentError(
      `timeoutMs is at most 24 hours (86_400_000 ms), as on E2B, not ${timeoutMs}.`,
    );
}

/** What the server does when the time limit runs out. E2B kills: a caller
 * that asked for an end (a timeoutMs, or onTimeout "kill") gets a delete, as
 * E2B's kill destroys the sandbox. One that asked for nothing gets E2B's
 * 300 s default as a pause, which keeps everything, since a sandbox nobody
 * asked to end is never ended. */
function onTimeout(
  lifecycle: SandboxLifecycle | undefined,
  timeoutAsked: boolean,
): "pause" | "delete" {
  if (!lifecycle) return timeoutAsked ? "delete" : "pause";
  const action =
    typeof lifecycle.onTimeout === "string" ? lifecycle.onTimeout : lifecycle.onTimeout.action;
  if (typeof lifecycle.onTimeout === "object" && lifecycle.onTimeout.keepMemory === false)
    throw new NotSupportedError(
      "A files-only pause (keepMemory: false)",
      "Runtime's pause keeps memory and files; leave keepMemory out.",
    );
  return action === "pause" ? "pause" : "delete";
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

/** The Runtime image name an E2B template name stands for: E2B's
 * `team/name:tag` without the team, since a Runtime account's images are its
 * own. `name`, `name:tag` and `name@version` are Runtime image names too. */
export function imageNameFor(template: string): string {
  const slash = template.lastIndexOf("/");
  return slash < 0 ? template : template.slice(slash + 1);
}

/** Where a template sends the create: the stock image, a Runtime image by
 * name (with its tag or version) or id, or a Runtime snapshot by id. A name
 * is resolved by the create itself, in the same request. */
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
  return { image: imageNameFor(template) };
}

/** The labels a create sends: E2B's metadata, and the template it was made
 * from, while there is room for it among Runtime's 32 labels. */
function labelsFor(
  metadata: Record<string, string> | undefined,
  template: string,
): { labels?: Record<string, string> } {
  const labels = { ...metadata };
  if (!STOCK_TEMPLATES.has(template) && Object.keys(labels).length < 32 && template.length <= 256)
    labels[TEMPLATE_LABEL] = template;
  return Object.keys(labels).length ? { labels } : {};
}

/** " in the account …", for an error a key of another account explains: the
 * account's name and where its key came from. Nothing when the lookup fails. */
async function accountOf(
  client: Runtime,
  opts: { apiKey?: string; runtime?: { client?: Runtime } },
): Promise<string | undefined> {
  const me = await client.me({ timeoutMs: 5_000 }).catch(() => undefined);
  if (!me) return undefined;
  const source = opts.runtime?.client ? "" : ` (key: ${keySource(opts.apiKey)})`;
  return ` in the account "${me.orgName || me.orgId}"${source}`;
}

/** The create's refusal of a template no Runtime image answers to, as E2B's
 * TemplateError, saying how to build it. */
function templateMissing(template: string, cause: unknown, account?: string): TemplateError {
  const name = imageNameFor(template).replace(/[:@].*$/, "");
  const error = new TemplateError(
    `No Runtime image is named "${imageNameFor(template)}"${account ?? ""}. E2B templates do not run on Runtime; build the same ` +
      `environment as a Runtime image with that name and this call starts from it: ` +
      `\`npx withruntime image build --dockerfile e2b.Dockerfile --name ${name}\`, or ` +
      `runtime.images.build({ name: "${name}", dockerfile }).`,
  );
  error.code = "template_not_found";
  error.cause = cause;
  return error;
}

function state(runtime: RuntimeSandbox): SandboxState | "stopped" {
  const current = runtime.state;
  if (current === "paused" || current === "pausing") return "paused";
  if (current === "stopped" || current === "stopping") return "stopped";
  return "running";
}

/** Whether a paused sandbox is, to code written for E2B, still running:
 * Runtime paused it itself for being idle (E2B never does) and the next
 * call wakes it, so every E2B call on it works as on a running one. */
function idleAsleep(runtime: RuntimeSandbox): boolean {
  const info = runtime.info;
  return state(runtime) === "paused" && info.stopReason === "idle" && info.autoWake !== false;
}

/** The sandbox's state as E2B would say it. */
function e2bState(runtime: RuntimeSandbox): SandboxState {
  const current = state(runtime);
  if (current === "running" || idleAsleep(runtime)) return "running";
  return "paused";
}

/** E2B's endAt: when the sandbox ends by itself. One that never will (no
 * time limit, as a persistent or a pilot's sandbox) reads 24 hours ahead, the
 * furthest an E2B sandbox's end may be, so code that waits until the end, or
 * extends near it, behaves as for the longest E2B sandbox: a JavaScript timer
 * set past 24.8 days would fire at once. (5 October 2026: it read where the
 * sandbox was paid up to, minutes ahead, so a pilot's looked about to end.) */
function endOf(runtime: RuntimeSandbox): Date {
  const { endsAt, expiresAt } = runtime.info;
  if (endsAt) return new Date(endsAt);
  if (endsAt === null && e2bState(runtime) === "running")
    return new Date(Date.now() + LONGEST_TIMEOUT_MS);
  return new Date(expiresAt);
}

function infoOf(runtime: RuntimeSandbox): SandboxInfo {
  const info = runtime.info;
  const { [TEMPLATE_LABEL]: template, ...metadata } = info.labels ?? {};
  const templateId =
    template ??
    (typeof info.image === "string"
      ? info.image
      : typeof info.snapshot === "string"
        ? info.snapshot
        : "base");
  const action = info.onTimeout ?? info.onLeaseEnd;
  return {
    sandboxId: info.id,
    templateId,
    ...(info.name ? { name: info.name } : {}),
    metadata,
    startedAt: new Date(info.createdAt),
    endAt: endOf(runtime),
    state: e2bState(runtime),
    cpuCount: info.vcpu,
    memoryMB: info.memoryMiB,
    envdVersion: "runtime",
    lifecycle: {
      onTimeout: action === "pause" ? "pause" : "kill",
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
  #killed = false;
  /** The /home/user link, once asked for: whether /home/user leads to /workspace. */
  #home: Promise<boolean> | undefined;
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
      homeIsWorkspace: () => (this.#home ?? this.#linkHome()).catch(() => false),
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
    const done = (home: Promise<boolean>) => wait(home.then(() => undefined));
    if (this.#home || !text?.includes("/home/user"))
      return done(this.#home ?? Promise.resolve(false));
    return done(this.#linkHome(signal));
  }

  /** Links /home/user to /workspace unless something is already there, and
   * says whether /home/user then leads to /workspace: an image may have its
   * own /home/user, and E2B's paths are shown only where they are true. */
  #linkHome(signal?: AbortSignal): Promise<boolean> {
    const pending = (async () => {
      const result = await guard("sandbox", () => this.#runtime.exec(HOME_LINK, { signal }));
      if (result.exitCode !== 0) {
        if (typeof process !== "undefined")
          process.emitWarning(`Could not link /home/user to /workspace: ${result.stderr.trim()}`, {
            code: "RUNTIME_E2B_HOME",
          });
        return false;
      }
      return result.stdout.trim() === "same";
    })();
    this.#home = pending;
    pending.catch(() => {
      if (this.#home === pending) this.#home = undefined;
    });
    return pending;
  }

  // ---- create, connect, list -------------------------------------------

  /** Creates a sandbox from `template` (default "base", Runtime's stock image)
   * with E2B's default machine, 2 vCPU and 512 MiB, and waits until it runs.
   * Funding is left to Runtime: the included usage first, then prepaid credit, exactly as withruntime's own create. */
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
    // The server keeps the deadline, up to 24 hours (0381). Without one asked
    // for, E2B's 300 s ends in a pause, never a delete.
    const input: RuntimeCreate = {
      timeoutSeconds: timeoutSeconds(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      onLeaseEnd: onTimeout(opts.lifecycle, opts.timeoutMs !== undefined),
      // With a lifecycle, E2B resumes a paused sandbox on traffic only when
      // asked (autoResume); Runtime's automatic wake is the same thing (0093).
      ...(opts.lifecycle ? { autoWake: opts.lifecycle.autoResume === true } : {}),
      ...labelsFor(opts.metadata, template),
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
    const runtime = await guard("sandbox", () => client.sandboxes.create(create, options)).catch(
      async (error: unknown) => {
        if ((error as { code?: string }).code === "image_not_found")
          throw templateMissing(template, error, await accountOf(client, opts));
        throw error;
      },
    );
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

  /** Deletes the sandbox for good, as E2B's kill destroys it: its disk,
   * memory and shared ports go. False when it was not found or was already
   * deleted. */
  static async kill(sandboxId: string, opts: SandboxApiOpts = {}): Promise<boolean> {
    const client = clientFor(opts);
    try {
      // Read first: a delete answers the same however often it is sent, and
      // E2B says false for one already gone.
      const runtime = await guard("sandbox", () => client.sandboxes.get(sandboxId, request(opts)));
      await guard("sandbox", () => runtime.delete(request(opts)));
      return true;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
  }
  async kill(opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal"> = {}): Promise<boolean> {
    if (this.#killed) return false;
    try {
      await guard("sandbox", () => this.#runtime.delete(request(opts)));
      this.#killed = true;
      return true;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
  }

  /** Sets the sandbox to end `timeoutMs` from now, up to 24 hours, as E2B
   * does; the server keeps the deadline. Runtime cannot bring an end
   * sooner, so that is refused. A sandbox with no time limit (one on a pilot
   * account, kept running by the server) has no end to move, and nothing
   * changes. */
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

  /** Whether the sandbox answers calls, as E2B's health check says: true
   * while it runs, and while Runtime has paused it for being idle, since the
   * next call wakes it. False once paused on request, ended or deleted. */
  async isRunning(opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal"> = {}) {
    try {
      await guard("sandbox", () => this.#runtime.refresh(request(opts)));
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
    return this.#runtime.state === "running" || idleAsleep(this.#runtime);
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
    checkForkCount(opts.count);
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
    checkForkCount(opts.count);
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
    // A sandbox without credit shares ports privately: a host alone would answer 404 or
    // 401 to everyone. Say so now, with the address that works.
    if (this.#runtime.info.funding === "trial")
      throw new PublicPreviewNotAllowedError(this.sandboxId, port);
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
    if (this.#runtime.info.funding === "trial")
      throw new PublicPreviewNotAllowedError(this.sandboxId, port);
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
        ...(opts.timeoutMs === undefined ? {} : { timeoutSeconds: timeoutSeconds(opts.timeoutMs) }),
        ...request(opts),
      }),
    );
  } else if (opts.timeoutMs !== undefined) {
    checkTimeout(opts.timeoutMs);
    // A running one's end moves later, never sooner, as E2B's connect.
    const later = secondsLater(runtime, opts.timeoutMs);
    if (later > 1) await guard("sandbox", () => runtime.extend(Math.ceil(later), request(opts)));
  }
}

/** How many seconds past its current end `now + timeoutMs` is; 0 for a
 * sandbox with no time limit, which has no end to move. A second either way
 * is the clocks and the trip, not a new end. */
function secondsLater(runtime: RuntimeSandbox, timeoutMs: number): number {
  if (runtime.info.endsAt === null) return 0;
  const end = Date.parse(runtime.info.endsAt ?? runtime.info.expiresAt);
  return (Date.now() + timeoutMs - end) / 1000;
}

async function extendTo(
  runtime: RuntimeSandbox,
  timeoutMs: number,
  opts: Pick<ConnectionOpts, "requestTimeoutMs" | "signal">,
) {
  checkTimeout(timeoutMs);
  if (runtime.info.endsAt === null) return;
  const later = secondsLater(runtime, timeoutMs);
  if (later < -1)
    throw new NotSupportedError(
      "Ending a sandbox sooner than its time limit (a shorter setTimeout)",
      "Runtime cannot bring a time limit forward. Call kill() when the work is done.",
    );
  if (later > 1) await guard("sandbox", () => runtime.extend(Math.ceil(later), request(opts)));
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

/** E2B's paginator: `while (p.hasNext) items.push(...(await p.nextItems()))`.
 * Runtime filters by state and metadata itself. A template, `startedAfter`,
 * newest-first order or a saved `nextToken` are done here: every match is
 * read once, then served a page at a time. */
export class SandboxPaginator {
  readonly #client: Runtime;
  readonly #request: RequestOptions;
  readonly #filter: Parameters<Runtime["sandboxes"]["list"]>[0];
  readonly #opts: SandboxListOpts;
  readonly #pageSize: number;
  readonly #local: boolean;
  /** One E2B state asked for alone: Runtime's states are read together and
   * sorted here, since a sandbox Runtime paused for being idle is running
   * to E2B. */
  readonly #only: SandboxState | undefined;
  #page: Awaited<ReturnType<Runtime["sandboxes"]["list"]>> | undefined;
  #all: SandboxInfo[] | undefined;
  #offset: number;
  #hasNext = true;

  constructor(client: Runtime, opts: SandboxListOpts) {
    this.#client = client;
    this.#request = request(opts);
    this.#opts = opts;
    const query = opts.query ?? {};
    if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1))
      throw new InvalidArgumentError(`limit must be a positive whole number, not ${opts.limit}.`);
    this.#pageSize = opts.limit ?? 100;
    this.#offset = opts.nextToken === undefined ? 0 : tokenOffset(opts.nextToken);
    this.#local =
      query.template !== undefined ||
      query.startedAfter !== undefined ||
      opts.order === "desc" ||
      opts.nextToken !== undefined;
    const asked = new Set(query.state?.length ? query.state : ["running", "paused"]);
    this.#only = asked.size === 1 ? ([...asked][0] as SandboxState) : undefined;
    this.#filter = {
      state: [...RUNNING, ...PAUSED],
      ...(query.metadata && Object.keys(query.metadata).length ? { labels: query.metadata } : {}),
      limit: this.#local ? 100 : Math.min(this.#pageSize, 100),
    };
  }
  get hasNext(): boolean {
    return this.#hasNext;
  }
  /** Where the next page starts; `Sandbox.list({ nextToken })` resumes there. */
  get nextToken(): string | undefined {
    return this.#hasNext && this.#offset > 0 ? `runtime:${this.#offset}` : undefined;
  }
  async nextItems(): Promise<SandboxInfo[]> {
    this.#request.signal?.throwIfAborted();
    if (!this.#hasNext) throw new SandboxError("No more items to fetch.");
    if (this.#local) {
      const all = (this.#all ??= await guard("other", () => this.#everyMatch()));
      const items = all.slice(this.#offset, this.#offset + this.#pageSize);
      this.#offset += items.length;
      this.#hasNext = this.#offset < all.length;
      return items;
    }
    const previous = this.#page;
    const page = await guard("other", async () =>
      previous
        ? await previous.next()
        : await this.#client.sandboxes.list(this.#filter, this.#request),
    );
    this.#page = page ?? undefined;
    this.#hasNext = Boolean(page?.hasMore);
    const items = (page?.data ?? []).map(infoOf).filter((info) => this.#wanted(info));
    this.#offset += items.length;
    return items;
  }

  #wanted(info: SandboxInfo): boolean {
    return this.#only === undefined || info.state === this.#only;
  }

  async #everyMatch(): Promise<SandboxInfo[]> {
    const query = this.#opts.query ?? {};
    const templates =
      query.template === undefined
        ? undefined
        : STOCK_TEMPLATES.has(query.template)
          ? new Set(["base", ...STOCK_TEMPLATES])
          : new Set([query.template]);
    const after = query.startedAfter?.getTime();
    const all: SandboxInfo[] = [];
    let page: Awaited<ReturnType<Runtime["sandboxes"]["list"]>> | null =
      await this.#client.sandboxes.list(this.#filter, this.#request);
    while (page) {
      for (const one of page.data) {
        const info = infoOf(one);
        if (!this.#wanted(info)) continue;
        if (templates && !templates.has(info.templateId)) continue;
        if (after !== undefined && info.startedAt.getTime() < after) continue;
        all.push(info);
      }
      page = page.hasMore ? await page.next() : null;
    }
    const sign = this.#opts.order === "desc" ? -1 : 1;
    return all.sort((a, b) => sign * (a.startedAt.getTime() - b.startedAt.getTime()));
  }
}

function tokenOffset(token: string): number {
  const match = /^runtime:(\d+)$/.exec(token);
  if (!match)
    throw new InvalidArgumentError(
      `"${token}" is not a nextToken this package gave; pass the paginator's own nextToken.`,
    );
  return Number(match[1]);
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
