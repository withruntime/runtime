import type { Writable } from "node:stream";
import type { Runtime } from "../client.js";
import { RuntimeError } from "../errors.js";
import type { Page } from "../page.js";
import {
  clientFor,
  signalOf,
  type Credentials,
  type RuntimeCreate,
  type RuntimeSandbox,
  type WithRuntime,
} from "./client.js";
import { Command, CommandFinished, exitCodeOf, type LogOutputLine } from "./command.js";
import { APIError, guard, NotSupportedError, translate } from "./errors.js";
import { FileSystem } from "./filesystem.js";
import { Snapshot } from "./snapshot.js";

/* Vercel Sandbox's `Sandbox` over Runtime's. Every call is one or a few calls
   of the withruntime SDK; nothing here speaks HTTP. What Runtime cannot do the
   same way throws NotSupportedError before anything happens. */

/** Vercel's default machine: 2 vCPUs with 2048 MB each (checked 23 September
 * 2026). Runtime gives 2 vCPU and 4096 MiB. */
export const DEFAULT_VCPUS = 2;
export const MEMORY_MIB_PER_VCPU = 2048;
/** Vercel's default timeout, 5 minutes. */
export const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 3600;
/** Commands without a timeout run until the sandbox ends: Runtime's longest. */
const LONGEST_MS = 86_400_000;
/** Vercel's working directory; `/workspace` on Runtime. */
export const HOME = "/vercel/sandbox";
const RUNTIME_HOME = "/workspace";
const HOME_LINK =
  "[ -e /vercel/sandbox ] || { sudo mkdir -p /vercel && sudo ln -s /workspace /vercel/sandbox; }";
/** Vercel's managed images and legacy runtimes: all Runtime's stock image. */
const STOCK_IMAGE =
  /^(vercel\/sandbox\/)?(universal|ubuntu|node:2[246]|python:3\.1[34])(:latest)?$/;
const LEGACY_RUNTIMES = new Set(["node22", "node24", "node26", "python3.13"]);
/** Vercel regions in the United States, where Runtime runs. */
const US_REGIONS = new Set(["iad1", "sfo1", "cle1", "pdx1"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      allow?: string[] | Record<string, unknown[]>;
      subnets?: { allow?: string[]; deny?: string[] };
    };

type Source =
  | {
      type: "git";
      url: string;
      depth?: number;
      revision?: string;
      username?: string;
      password?: string;
    }
  | { type: "tarball"; url: string }
  | { type: "snapshot"; snapshotId: string };

export interface CreateSandboxParams extends Credentials {
  name?: string;
  source?: Source;
  /** Shared at public HTTPS addresses (Runtime previews); `domain(port)`
   * answers from them. */
  ports?: number[];
  /** Milliseconds. Default 300 000; 60 s to 1 hour on Runtime. */
  timeout?: number;
  resources?: { vcpus: number };
  networkPolicy?: NetworkPolicy;
  networkId?: string;
  /** Given to every command run through this object. */
  env?: Record<string, string>;
  /** Stored as Runtime labels. */
  tags?: Record<string, string>;
  region?: string;
  failoverRegions?: string[];
  mounts?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Default true: `stop()` pauses the sandbox, keeping its files (and its
   * memory), and `Sandbox.get({ name })` wakes it. false: `stop()` ends it. */
  persistent?: boolean;
  /** Milliseconds a stopped persistent sandbox is kept, as Runtime's
   * retention (whole days, 1 to 365; 0 is 365). */
  snapshotExpiration?: number;
  /** Refused: Runtime does not enforce snapshot count or eviction policies. */
  keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
  onResume?: (sandbox: Sandbox) => Promise<void>;
  /** A legacy Vercel runtime (node22, node24, node26, python3.13): Runtime's
   * stock image, which has Node.js 24 and Python 3.12. */
  runtime?: string;
  /** A Vercel managed image (Runtime's stock image) or the name of a ready
   * Runtime image. */
  image?: string;
  /** Runtime-only: an explicit client, or fields for the create. */
  withruntime?: WithRuntime;
}

export interface RunCommandParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Runs the command under `sudo`, which needs no password. */
  sudo?: boolean;
  detached?: boolean;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SandboxRoute {
  port: number;
  subdomain: string;
  url: string;
}

function leaseSeconds(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError(`timeout must be a positive number of milliseconds, not ${timeoutMs}.`);
  const seconds = Math.ceil(timeoutMs / 1000);
  if (seconds > MAX_LEASE_SECONDS)
    throw new NotSupportedError(
      `A sandbox timeout of ${timeoutMs} ms (over one hour)`,
      "Runtime leases last up to an hour (3_600_000 ms); call sandbox.extendTimeout(ms) before it ends to keep going, as often as needed.",
    );
  return Math.max(seconds, MIN_LEASE_SECONDS);
}

function refuseCreate(params: CreateSandboxParams) {
  if (params.keepLastSnapshots !== undefined)
    throw new NotSupportedError(
      "Snapshot count and eviction policies (keepLastSnapshots)",
      "Omit it; manage saved snapshots explicitly with Snapshot.list and snapshot.delete.",
    );
  if (params.ports !== undefined) validatePorts(params.ports);
  if (params.mounts && Object.keys(params.mounts).length)
    throw new NotSupportedError(
      "Vercel Drives (mounts)",
      "Use a Runtime volume: withruntime: { create: { volumes: [{ volumeId, path }] } } (runtime.volumes creates one).",
    );
  if (params.networkId !== undefined)
    throw new NotSupportedError(
      "Secure Compute networks (networkId)",
      "Remove it; restrict outbound traffic with networkPolicy instead.",
    );
  if (params.region !== undefined && !US_REGIONS.has(params.region))
    throw new NotSupportedError(
      `The region ${params.region}`,
      "Runtime runs in one US region (east). Remove region, or use iad1.",
    );
  if (params.failoverRegions?.length)
    throw new NotSupportedError(
      "Failover regions (failoverRegions)",
      "Remove it: Runtime runs in one US region.",
    );
}

function validatePorts(ports: number[]): void {
  if (
    !Array.isArray(ports) ||
    ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)
  )
    throw new RangeError("ports must contain only integers from 1 to 65535.");
}

/** Vercel's network policy as Runtime's rules. Header injection and
 * forwarding rules have no Runtime counterpart and are refused. */
export function networkRules(policy: NetworkPolicy): NonNullable<RuntimeCreate["network"]> {
  if (policy === "allow-all") return { internet: true };
  if (policy === "deny-all") return { internet: false };
  const allow = policy.allow;
  let domains: string[] = [];
  if (Array.isArray(allow)) domains = allow;
  else if (allow) {
    for (const [domain, rules] of Object.entries(allow)) {
      if (rules.length)
        throw new NotSupportedError(
          `Network rules that transform or forward requests (for ${domain})`,
          `Allow the domain with an empty rule list and store the credential as a Runtime secret for it: \`npx withruntime secrets set NAME --host ${domain}\`. The sandbox sees a placeholder, and the egress proxy adds the value.`,
        );
      domains.push(domain);
    }
  }
  const wildcard = domains.includes("*");
  const listed = [...domains.filter((one) => one !== "*"), ...(policy.subnets?.allow ?? [])];
  // A custom policy reaches only what it allows: with nothing allowed, nothing.
  if (!wildcard && !listed.length) return { internet: false };
  return {
    internet: true,
    ...(!wildcard && listed.length ? { allow: listed } : {}),
    ...(policy.subnets?.deny?.length ? { deny: policy.subnets.deny } : {}),
  };
}

/** Where an image or legacy runtime sends the create: the stock image, or a
 * Runtime image by name or id. */
async function resolveImage(
  client: Runtime,
  params: CreateSandboxParams,
): Promise<Partial<RuntimeCreate>> {
  if (params.source?.type === "snapshot") return { snapshot: params.source.snapshotId };
  if (params.runtime !== undefined && !LEGACY_RUNTIMES.has(params.runtime))
    throw new NotSupportedError(
      `The Vercel runtime ${params.runtime}`,
      "Leave runtime out: Runtime's stock image has Node.js 24, Bun and Python 3.12.",
    );
  const image = params.image;
  if (image === undefined || STOCK_IMAGE.test(image)) return {};
  if (UUID.test(image)) return { image };
  const page = await client.images.list({ name: image, state: "ready", limit: 1 });
  const found = page.data[0];
  if (found) return { image: found.id };
  throw new NotSupportedError(
    `The image ${image}, which is not a Runtime image`,
    `Build it as a Runtime image with that name and this call starts from it: \`npx withruntime image build --dockerfile Dockerfile --name ${image}\`, or runtime.images.build({ name: "${image}", image: "<registry reference>" }).`,
  );
}

/** Runtime's state as Vercel's status: a paused sandbox is a stopped
 * persistent one. */
function statusOf(state: string) {
  switch (state) {
    case "starting":
      return "pending";
    case "running":
    case "resuming":
      return "running";
    case "pausing":
    case "stopping":
      return "stopping";
    default:
      return "stopped";
  }
}

/** Runtime's `/workspace` stands for Vercel's `/vercel/sandbox`: relative
 * paths resolve against it, and paths under /vercel/sandbox are rewritten. */
export function toRuntimePath(path: string, cwd?: string): string {
  const base = cwd === undefined ? HOME : toVercelPath(cwd).replace(/\/+$/, "");
  const absolute = path.startsWith("/") ? path : `${base}/${path.replace(/^(?:\.(?:\/+|$))+/, "")}`;
  const normal = absolute.replace(/\/+$/, "") || "/";
  if (normal === HOME || normal.startsWith(`${HOME}/`))
    return RUNTIME_HOME + normal.slice(HOME.length);
  return normal;
}
function toVercelPath(path: string): string {
  return path.startsWith("/") ? path : `${HOME}/${path.replace(/^(?:\.(?:\/+|$))+/, "")}`;
}

type Resolved = { runtime: RuntimeSandbox; client: Runtime; params: CreateSandboxParams };

/** A sandbox with Vercel's methods. `sandbox.withruntime` is the Runtime
 * sandbox underneath, for anything Vercel has no name for. */
export class Sandbox {
  readonly fs: FileSystem;
  #rt: RuntimeSandbox;
  readonly #client: Runtime;
  readonly #env: Record<string, string>;
  readonly #persistent: boolean;
  readonly #routes = new Map<number, string>();
  readonly #onResume: ((sandbox: Sandbox) => Promise<void>) | undefined;
  #linked: Promise<void> | undefined;
  #deleted = false;

  /** Use Sandbox.create, Sandbox.get or Sandbox.getOrCreate. */
  constructor(resolved: Resolved) {
    this.#rt = resolved.runtime;
    this.#client = resolved.client;
    this.#env = { ...resolved.params.env };
    this.#persistent = resolved.params.persistent ?? resolved.runtime.info.onLeaseEnd !== "stop";
    this.#onResume = resolved.params.onResume;
    this.fs = new FileSystem({
      name: this.name,
      files: async () => (await this.#live()).files,
      run: async (argv, options) => {
        const live = await this.#live();
        return live.exec(argv, options);
      },
      resolve: (path, cwd) => toRuntimePath(path, cwd),
    });
  }

  /** The Runtime sandbox underneath: previews, network, snapshots, desktop,
   * interpreter, processes and the rest of Runtime's SDK. */
  get withruntime(): RuntimeSandbox {
    return this.#rt;
  }
  /** The sandbox's name, or its Runtime id when it was made without one. */
  get name(): string {
    return this.#rt.info.name ?? this.#rt.id;
  }
  get routes(): SandboxRoute[] {
    return [...this.#routes].map(([port, url]) => ({
      port,
      subdomain: new URL(url).hostname.split(".")[0]!,
      url,
    }));
  }
  get persistent(): boolean {
    return this.#persistent;
  }
  get region(): string {
    return "iad1";
  }
  get failoverRegions(): string[] {
    return [];
  }
  get networkId(): string | undefined {
    return undefined;
  }
  get vcpus(): number {
    return this.#rt.info.vcpu;
  }
  /** Megabytes. */
  get memory(): number {
    return this.#rt.info.memoryMiB;
  }
  get runtime(): string | undefined {
    return undefined;
  }
  get image(): string | undefined {
    const image = this.#rt.info.image;
    return typeof image === "string" ? image : undefined;
  }
  get createdAt(): Date {
    return new Date(this.#rt.info.createdAt);
  }
  get updatedAt(): Date {
    return new Date(this.#rt.info.pausedAt ?? this.#rt.info.readyAt ?? this.#rt.info.createdAt);
  }
  get cwd(): string {
    return HOME;
  }
  get status(): "pending" | "running" | "stopping" | "stopped" {
    return statusOf(this.#rt.state);
  }
  /** Milliseconds. */
  get timeout(): number {
    return this.#rt.info.timeoutSeconds * 1000;
  }
  get expiresAt(): Date {
    return new Date(this.#rt.info.expiresAt);
  }
  get tags(): Record<string, string> {
    return { ...this.#rt.info.labels };
  }
  get sourceSnapshotId(): string | undefined {
    const snapshot = this.#rt.info.snapshot;
    return typeof snapshot === "string" ? snapshot : undefined;
  }

  // ---- create, get, list ------------------------------------------------

  /** Creates a sandbox and waits until it runs. Vercel's defaults: 2 vCPUs,
   * 2048 MiB per vCPU, a 5-minute timeout, persistent. Funding is left to
   * Runtime: the free trial while the account has trial time, then prepaid
   * credit, exactly as withruntime's own create. */
  static async create(params: CreateSandboxParams = {}): Promise<Sandbox & AsyncDisposable> {
    refuseCreate(params);
    const client = clientFor(params);
    const persistent = params.persistent ?? true;
    if (params.snapshotExpiration !== undefined && persistent)
      retentionDays(params.snapshotExpiration);
    const vcpus = params.resources?.vcpus ?? DEFAULT_VCPUS;
    const source = await guard(() => resolveImage(client, params));
    const input: RuntimeCreate = {
      ...(source.snapshot ? {} : { vcpu: vcpus, memoryMiB: vcpus * MEMORY_MIB_PER_VCPU }),
      timeoutSeconds: leaseSeconds(params.timeout ?? DEFAULT_TIMEOUT_MS),
      onLeaseEnd: persistent ? "pause" : "stop",
      ...(params.name ? { name: params.name } : {}),
      ...(params.tags && Object.keys(params.tags).length ? { labels: params.tags } : {}),
      ...(params.networkPolicy ? { network: networkRules(params.networkPolicy) } : {}),
      ...source,
      ...params.withruntime?.create,
    };
    const runtime = await guard(() => client.sandboxes.create(input, signalOf(params)));
    const sandbox = new Sandbox({ runtime, client, params: { ...params, persistent } });
    try {
      await sandbox.#setUp(params);
    } catch (error) {
      await runtime.stop({ wait: false }).catch(() => undefined);
      throw translate(error, sandbox.name);
    }
    return sandbox;
  }

  async #setUp(params: CreateSandboxParams) {
    for (const port of params.ports ?? []) await this.#share(port);
    if (params.snapshotExpiration !== undefined && this.#persistent)
      await this.#rt.setRetention(retentionDays(params.snapshotExpiration));
    const source = params.source;
    if (source?.type === "git") {
      const argv = [
        "git",
        ...(source.username !== undefined
          ? [
              "-c",
              'credential.helper=!f() { echo "username=$GIT_USER"; echo "password=$GIT_PASS"; }; f',
            ]
          : []),
        "clone",
        ...(source.depth ? ["--depth", String(source.depth)] : []),
        ...(source.revision && source.depth ? ["--no-single-branch"] : []),
        "--",
        source.url,
        RUNTIME_HOME,
      ];
      const env =
        source.username !== undefined
          ? { GIT_USER: source.username, GIT_PASS: source.password ?? "" }
          : undefined;
      await this.#setupStep(argv, env);
      if (source.revision)
        await this.#setupStep(["git", "-C", RUNTIME_HOME, "checkout", source.revision], env);
    } else if (source?.type === "tarball") {
      await this.#setupStep([
        "sh",
        "-c",
        'curl -fsSL "$1" | tar -xz -C /workspace',
        "sh",
        source.url,
      ]);
    }
  }

  async #setupStep(argv: string[], env?: Record<string, string>) {
    const result = await this.#rt.exec(argv, { timeoutMs: 600_000, ...(env ? { env } : {}) });
    if (result.exitCode !== 0)
      throw new APIError(new Response(null, { status: 400 }), {
        message: `Setting up the sandbox's source failed (${argv.slice(0, 3).join(" ")}): ${result.stderr.trim()}`,
        sandboxName: this.name,
      });
  }

  /** A sandbox by name (or Runtime id), woken if it is paused unless
   * `resume: false`. */
  static async get(
    params: {
      name: string;
      resume?: boolean;
      signal?: AbortSignal;
      onResume?: (sandbox: Sandbox) => Promise<void>;
    } & Credentials & { withruntime?: WithRuntime },
  ): Promise<Sandbox> {
    params.signal?.throwIfAborted();
    const client = clientFor(params);
    const runtime = await guard(() => find(client, params.name, params), params.name);
    const sandbox = new Sandbox({
      runtime,
      client,
      params: params.onResume ? { onResume: params.onResume } : {},
    });
    if (params.resume !== false) await sandbox.#live(params);
    return sandbox;
  }

  /** The named sandbox, or a new one with that name when there is none. */
  static async getOrCreate(
    params: CreateSandboxParams & {
      resume?: boolean;
      onCreate?: (sandbox: Sandbox) => Promise<void>;
    } = {},
  ): Promise<Sandbox> {
    if (params.name !== undefined) {
      try {
        return await Sandbox.get({ ...params, name: params.name });
      } catch (error) {
        if (!(error instanceof APIError && error.response.status === 404)) throw error;
      }
    }
    const sandbox = await Sandbox.create(params);
    await params.onCreate?.(sandbox);
    return sandbox;
  }

  /** A new sandbox copied from a running one, memory and all (a Runtime
   * fork). `sourceSandbox` is its name. */
  static async fork(
    params: Omit<CreateSandboxParams, "source"> & { sourceSandbox: string },
  ): Promise<Sandbox & AsyncDisposable> {
    const unsupported = (
      [
        "resources",
        "ports",
        "timeout",
        "networkPolicy",
        "image",
        "tags",
        "env",
        "persistent",
        "snapshotExpiration",
        "keepLastSnapshots",
        "onResume",
        "runtime",
      ] as const
    ).find((field) => params[field] !== undefined);
    if (unsupported)
      throw new NotSupportedError(
        `Overriding ${unsupported} on a fork`,
        "Omit the override to use Runtime's existing fork behavior.",
      );
    refuseCreate(params);
    const source = await Sandbox.get({ ...params, name: params.sourceSandbox });
    const copy = await guard(
      () => source.#rt.fork({ ...(params.name ? { name: params.name } : {}), ...signalOf(params) }),
      params.sourceSandbox,
    );
    return new Sandbox({
      runtime: copy,
      client: source.#client,
      params: { persistent: source.#persistent, env: source.#env },
    });
  }

  /** Running and stopped (paused) sandboxes, oldest first, with Vercel's
   * paginator: `for await (const s of await Sandbox.list())`. */
  static async list(
    params: {
      tags?: Record<string, string>;
      limit?: number;
      signal?: AbortSignal;
    } & Credentials & {
        withruntime?: WithRuntime;
      } & Record<string, unknown> = {},
  ) {
    params.signal?.throwIfAborted();
    for (const field of ["since", "until", "cursor", "sortBy", "sortOrder", "namePrefix"])
      if (params[field] !== undefined)
        throw new NotSupportedError(
          `Listing sandboxes by ${field}`,
          "List them all (oldest first) and filter the result yourself.",
        );
    const client = clientFor(params);
    const page = await guard(() =>
      client.sandboxes.list(
        {
          ...(params.tags ? { labels: params.tags } : {}),
          ...(params.limit ? { limit: Math.min(params.limit, 100) } : {}),
        },
        signalOf(params),
      ),
    );
    return paginate(page, params.signal);
  }

  // ---- commands ---------------------------------------------------------

  /** Wakes the sandbox if it was paused (a stopped persistent sandbox, in
   * Vercel's words), as Vercel resumes one on the next call. */
  async #live(opts: { signal?: AbortSignal } = {}): Promise<RuntimeSandbox> {
    opts.signal?.throwIfAborted();
    if (this.#deleted)
      throw new APIError(new Response(null, { status: 410 }), {
        message: `Sandbox ${this.name} was deleted.`,
        sandboxName: this.name,
      });
    const state = this.#rt.state;
    if (state === "paused" || state === "pausing") await this.#wake(opts);
    return this.#rt;
  }

  async #wake(opts: { signal?: AbortSignal } = {}) {
    await guard(() => this.#rt.wake(signalOf(opts)), this.name);
    await this.#onResume?.(this);
  }

  /** Runs `work` on the live sandbox; if the lease paused it meanwhile, wakes
   * it and runs `work` once more. */
  async #withResume<T>(
    work: (runtime: RuntimeSandbox) => Promise<T>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    opts.signal?.throwIfAborted();
    const runtime = await this.#live(opts);
    try {
      return await work(runtime);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === "sandbox_paused"))
        throw translate(error, this.name);
      await guard(() => runtime.refresh(signalOf(opts)), this.name);
      await this.#wake(opts);
      return guard(() => work(this.#rt), this.name);
    }
  }

  async #linkHome(text: string, opts: { signal?: AbortSignal } = {}) {
    opts.signal?.throwIfAborted();
    if (this.#linked || !text.includes(HOME)) return this.#linked;
    this.#linked = (async () => {
      await this.#rt.exec(HOME_LINK, signalOf(opts)).catch(() => opts.signal?.throwIfAborted());
    })();
    try {
      await this.#linked;
    } catch (error) {
      this.#linked = undefined;
      throw error;
    }
  }

  /** Runs a command. It waits and resolves with a CommandFinished (a
   * non-zero exit is not an error), or with `detached: true` resolves at once
   * with a Command. */
  runCommand(
    command: string,
    args?: string[],
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CommandFinished>;
  runCommand(params: RunCommandParams & { detached: true }): Promise<Command>;
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(
    commandOrParams: string | RunCommandParams,
    args?: string[],
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Command | CommandFinished> {
    const params: RunCommandParams =
      typeof commandOrParams === "string"
        ? { cmd: commandOrParams, ...(args ? { args } : {}), ...opts }
        : commandOrParams;
    const argv = [
      ...(params.sudo ? ["sudo", "--preserve-env"] : []),
      params.cmd,
      ...(params.args ?? []),
    ];
    const cwd = params.cwd === undefined ? RUNTIME_HOME : toRuntimePath(params.cwd);
    const env = { ...this.#env, ...params.env };
    await this.#live(params);
    await this.#linkHome(
      `${argv.join(" ")}\n${params.cwd ?? ""}\n${Object.values(env).join("\n")}`,
      params,
    );
    const timeoutMs = params.timeoutMs ?? LONGEST_MS;
    const common = {
      cwd,
      ...(Object.keys(env).length ? { env } : {}),
      timeoutMs,
      ...signalOf(params),
    };
    const startedAt = Date.now();
    const vercelCwd = params.cwd === undefined ? HOME : toVercelPath(params.cwd);
    if (params.detached) {
      const process = await this.#withResume((runtime) => runtime.spawn(argv, common), params);
      const command = new Command({
        id: process.id,
        cwd: vercelCwd,
        startedAt,
        sandboxName: this.name,
        process,
      });
      if (params.stdout || params.stderr) void pipe(command, params);
      return command;
    }
    const lines: LogOutputLine[] = [];
    const record = (stream: "stdout" | "stderr", writer?: Writable) => (data: string) => {
      lines.push({ stream, data });
      writer?.write(data);
    };
    const result = await this.#withResume(
      (runtime) =>
        runtime.exec(argv, {
          ...common,
          onStdout: record("stdout", params.stdout),
          onStderr: record("stderr", params.stderr),
        }),
      params,
    );
    return new CommandFinished(
      {
        id: result.processId ?? `cmd_${startedAt}`,
        cwd: vercelCwd,
        startedAt,
        sandboxName: this.name,
        lines,
      },
      exitCodeOf(result.exitCode, result.timedOut),
      result.durationMs ?? Date.now() - startedAt,
    );
  }

  /** A command started earlier, by its cmdId. */
  async getCommand(cmdId: string, opts: { signal?: AbortSignal } = {}): Promise<Command> {
    const process = await this.#withResume(
      (runtime) => runtime.processes.get(cmdId, signalOf(opts)),
      opts,
    );
    return new Command({
      id: process.id,
      cwd: process.info.cwd,
      startedAt: Date.parse(process.info.startedAt),
      sandboxName: this.name,
      process,
    });
  }

  // ---- files ------------------------------------------------------------

  async mkDir(path: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const target = toRuntimePath(path);
    await this.#withResume(
      (runtime) => runtime.files.mkdir(target, { parents: true, ...signalOf(opts) }),
      opts,
    );
  }

  /** The file's bytes as a Node stream, or null when there is no file. */
  async readFile(
    file: { path: string; cwd?: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<NodeJS.ReadableStream | null> {
    const buffer = await this.readFileToBuffer(file, opts);
    if (buffer === null) return null;
    const { Readable } = await import("node:stream");
    return Readable.from([buffer]);
  }

  /** The file as a Buffer, or null when there is no file. */
  async readFileToBuffer(
    file: { path: string; cwd?: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<Buffer | null> {
    const target = toRuntimePath(file.path, file.cwd);
    try {
      return Buffer.from(
        await this.#withResume((runtime) => runtime.files.read(target, signalOf(opts)), opts),
      );
    } catch (error) {
      if (error instanceof APIError && error.response.status === 404) return null;
      throw error;
    }
  }

  /** Copies a sandbox file to the local disk; null when there is no file. */
  async downloadFile(
    src: { path: string; cwd?: string },
    dst: { path: string; cwd?: string },
    opts: { mkdirRecursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<string | null> {
    const buffer = await this.readFileToBuffer(src, opts);
    if (buffer === null) return null;
    opts.signal?.throwIfAborted();
    const { mkdir, writeFile } = await import("node:fs/promises");
    const paths = await import("node:path");
    const target = paths.resolve(dst.cwd ?? process.cwd(), dst.path);
    opts.signal?.throwIfAborted();
    if (opts.mkdirRecursive) await mkdir(paths.dirname(target), { recursive: true });
    await writeFile(target, buffer, signalOf(opts));
    return target;
  }

  /** Writes files, making their directories. Relative paths land in the
   * working directory; `mode` sets permissions. */
  async writeFiles(
    files: { path: string; content: string | Uint8Array; mode?: number }[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const modes: string[] = [];
    await this.#withResume(async (runtime) => {
      for (const file of files) {
        const target = toRuntimePath(file.path);
        await runtime.files.write(target, file.content, signalOf(opts));
        if (file.mode !== undefined) modes.push(file.mode.toString(8), target);
      }
      if (!modes.length) return;
      const script = 'while [ "$#" -gt 0 ]; do chmod "$1" "$2" || exit 1; shift 2; done';
      const result = await runtime.exec(["sh", "-c", script, "sh", ...modes], signalOf(opts));
      if (result.exitCode !== 0)
        throw new APIError(new Response(null, { status: 400 }), {
          message: `Setting file modes failed: ${result.stderr.trim()}`,
          sandboxName: this.name,
        });
    }, opts);
  }

  // ---- ports ------------------------------------------------------------

  async #share(port: number, opts: { signal?: AbortSignal } = {}) {
    opts.signal?.throwIfAborted();
    const preview = await guard(
      () => this.#rt.previews.create(port, { visibility: "public" }, signalOf(opts)),
      this.name,
    );
    this.#routes.set(port, preview.url.replace(/\/$/, ""));
  }

  /** The public address of a port listed in `ports`, such as
   * `https://3000-<id>.runtimehost.com`. A browser sees a one-time page
   * naming Runtime before the site. */
  domain(port: number): string {
    const url = this.#routes.get(port);
    if (!url)
      throw new Error(
        `No route for port ${port}. List it in Sandbox.create({ ports: [${port}] }) or sandbox.update({ ports }).`,
      );
    return url;
  }

  // ---- lifecycle --------------------------------------------------------

  /** Ends the session. A persistent sandbox is paused, keeping its files and
   * memory, and wakes on the next call or Sandbox.get; any other ends. */
  async stop(opts: { signal?: AbortSignal } = {}): Promise<{ name: string; status: string }> {
    await guard(() => this.#rt.refresh(signalOf(opts)), this.name);
    const state = this.#rt.state;
    if (state !== "stopped" && state !== "stopping" && state !== "paused") {
      if (this.#persistent) await guard(() => this.#rt.pause(signalOf(opts)), this.name);
      else await guard(() => this.#rt.stop(signalOf(opts)), this.name);
    }
    return { name: this.name, status: this.status };
  }

  /** Ends the sandbox for good. */
  async delete(
    opts: { deleteOrphanSnapshots?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (opts.deleteOrphanSnapshots)
      throw new NotSupportedError(
        "Deleting a sandbox's snapshots with it (deleteOrphanSnapshots)",
        "Delete them with Snapshot.get({ snapshotId }) and snapshot.delete(), or runtime.snapshots.delete(id).",
      );
    await guard(() => this.#rt.refresh(signalOf(opts)), this.name);
    if (this.#rt.state !== "stopped")
      await guard(() => this.#rt.stop({ wait: false, ...signalOf(opts) }), this.name);
    this.#deleted = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#deleted) return;
    await this.stop().catch(() => undefined);
  }

  /** Moves the end `duration` milliseconds later (at most an hour ahead of
   * now on Runtime). */
  async extendTimeout(duration: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (!Number.isFinite(duration) || duration <= 0)
      throw new RangeError(`duration must be a positive number of milliseconds, not ${duration}.`);
    await this.#withResume(
      (runtime) => runtime.extend(Math.ceil(duration / 1000), signalOf(opts)),
      opts,
    );
  }

  /** Replaces the network rules; returns the policy given. */
  async updateNetworkPolicy(networkPolicy: NetworkPolicy, opts: { signal?: AbortSignal } = {}) {
    opts.signal?.throwIfAborted();
    const rules = networkRules(networkPolicy);
    await this.#withResume((runtime) => runtime.network.set(rules, signalOf(opts)), opts);
    return networkPolicy;
  }

  /** Changes what Runtime can change on a sandbox: `timeout`, `ports`,
   * `networkPolicy` and `snapshotExpiration`. Anything else is refused before
   * anything changes. */
  async update(
    params: {
      timeout?: number;
      ports?: number[];
      networkPolicy?: NetworkPolicy;
      snapshotExpiration?: number;
    } & Record<string, unknown>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    opts.signal?.throwIfAborted();
    const allowed = new Set(["timeout", "ports", "networkPolicy", "snapshotExpiration"]);
    const other = Object.keys(params).find((key) => params[key] !== undefined && !allowed.has(key));
    if (other)
      throw new NotSupportedError(
        `Changing ${other} on an existing sandbox`,
        "Create a new sandbox with it (Runtime cannot change a sandbox's machine, persistence, tags or region after creation).",
      );
    const rules =
      params.networkPolicy === undefined ? undefined : networkRules(params.networkPolicy);
    const retention =
      params.snapshotExpiration === undefined
        ? undefined
        : retentionDays(params.snapshotExpiration);
    if (params.ports !== undefined) validatePorts(params.ports);
    const wanted = params.ports === undefined ? undefined : new Set(params.ports);
    if (params.timeout !== undefined) {
      const current = this.timeout;
      if (params.timeout < current)
        throw new NotSupportedError(
          "Shortening a sandbox's timeout",
          "Runtime leases only move later. Call stop() when the work is done.",
        );
      if (params.timeout > current) await this.extendTimeout(params.timeout - current, opts);
    }
    if (rules !== undefined)
      await this.#withResume((runtime) => runtime.network.set(rules, signalOf(opts)), opts);
    if (retention !== undefined)
      await guard(() => this.#rt.setRetention(retention, signalOf(opts)), this.name);
    if (wanted !== undefined) {
      for (const port of [...this.#routes.keys()])
        if (!wanted.has(port)) {
          await guard(() => this.#rt.previews.delete(port, signalOf(opts)), this.name);
          this.#routes.delete(port);
        }
      for (const port of wanted) if (!this.#routes.has(port)) await this.#share(port, opts);
    }
  }

  /** Keeps the sandbox's filesystem as a disk-only snapshot, then stops
   * the source. Restoring it starts fresh processes, as Vercel does. Start
   * from it with `Sandbox.create({ source: { type: "snapshot", snapshotId } })`. */
  async snapshot(opts: { expiration?: number; signal?: AbortSignal } = {}): Promise<Snapshot> {
    opts.signal?.throwIfAborted();
    const retention = opts.expiration === undefined ? undefined : retentionDays(opts.expiration);
    const taken = await this.#withResume(
      (runtime) =>
        runtime.snapshot({
          mode: "disk",
          ...(retention !== undefined ? { retentionDays: retention } : {}),
          ...signalOf(opts),
        }),
      opts,
    );
    try {
      await guard(() => this.#rt.stop(signalOf(opts)), this.name);
      if (this.#rt.state !== "stopped")
        await guard(() => this.#rt.waitFor("stopped", signalOf(opts)), this.name);
    } catch (error) {
      const recovery = { snapshotId: taken.id, sourceSandboxId: this.#rt.id };
      if (error instanceof APIError) {
        const json = error.json as { error?: Record<string, unknown> } | undefined;
        error.json = {
          ...json,
          error: {
            ...json?.error,
            details: { ...((json?.error?.details as object) ?? {}), ...recovery },
          },
        };
      } else if (error instanceof Error && Object.isExtensible(error)) {
        Object.assign(error, recovery);
      }
      throw error;
    }
    if (this.#rt.state !== "stopped") {
      const code = "snapshot_source_stop_timeout";
      const message = `Snapshot ${taken.id} was saved, but sandbox ${this.name} did not finish stopping.`;
      const error = new APIError(new Response(null, { status: 409 }), {
        message,
        sandboxName: this.name,
        json: {
          error: { code, message, details: { snapshotId: taken.id, sourceSandboxId: this.#rt.id } },
        },
      });
      error.code = code;
      throw error;
    }
    return new Snapshot(taken, this.#client);
  }

  // ---- what Runtime does differently -----------------------------------

  openInteractive(): Promise<never> {
    return Promise.reject(
      new NotSupportedError(
        "Vercel's interactive shell (openInteractive)",
        "Use `await sandbox.withruntime.terminal({ cols, rows, onData })`, or `npx withruntime sandbox shell <id>`.",
      ),
    );
  }
  getDefaultUser(): Promise<{ username: string; group: string }> {
    return Promise.resolve({ username: "runtime", group: "runtime" });
  }
  createUser(): Promise<never> {
    return usersRefused();
  }
  asUser(): never {
    throw usersError();
  }
  createGroup(): Promise<never> {
    return usersRefused();
  }
  addUserToGroup(): Promise<never> {
    return usersRefused();
  }
  removeUserFromGroup(): Promise<never> {
    return usersRefused();
  }
  currentSession(): never {
    throw new NotSupportedError(
      "Vercel sessions (currentSession)",
      "A Runtime sandbox is its own session: call the methods on the sandbox.",
    );
  }
  listSessions(): Promise<never> {
    return Promise.reject(
      new NotSupportedError(
        "Listing a sandbox's sessions",
        "A Runtime sandbox has one session: itself.",
      ),
    );
  }
  listSnapshots(): Promise<never> {
    return Promise.reject(
      new NotSupportedError(
        "Listing a sandbox's snapshots from the sandbox",
        "Use Snapshot.list({ name }) or runtime.snapshots.list({ sandboxId }).",
      ),
    );
  }
}

function usersError() {
  return new NotSupportedError(
    "Extra Linux users and groups (createUser, asUser, groups)",
    "Commands run as the sandbox owner with passwordless sudo; run `sudo useradd ...` and `sudo -u <user> ...` with runCommand.",
  );
}
function usersRefused(): Promise<never> {
  return Promise.reject(usersError());
}

/** Milliseconds as whole days for Runtime's retention: 1 to 365, and 0 (no
 * expiration) as 365. */
export function retentionDays(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0)
    throw new RangeError(
      `Snapshot expiration must be a nonnegative finite number of milliseconds, not ${ms}.`,
    );
  if (ms === 0) return 365;
  return Math.min(365, Math.max(1, Math.ceil(ms / 86_400_000)));
}

async function pipe(command: Command, params: RunCommandParams) {
  try {
    for await (const line of command.logs())
      (line.stream === "stdout" ? params.stdout : params.stderr)?.write(line.data);
  } catch {
    // The command's own wait() reports a broken stream.
  }
}

/** The newest live sandbox with this name, or the sandbox with this Runtime
 * id. A 404 when there is none. */
async function find(
  client: Runtime,
  name: string,
  opts: { signal?: AbortSignal } = {},
): Promise<RuntimeSandbox> {
  opts.signal?.throwIfAborted();
  if (UUID.test(name)) return client.sandboxes.get(name, signalOf(opts));
  const page = await client.sandboxes.list({ name }, signalOf(opts));
  const all = await page.toArray(1000);
  opts.signal?.throwIfAborted();
  const found = all.filter((one) => one.state !== "stopped").at(-1);
  if (!found)
    throw new RuntimeError({
      message: `Sandbox ${name} was not found.`,
      code: "not_found",
      status: 404,
      hint: "Sandbox.getOrCreate({ name }) makes it when it is missing.",
    });
  return found;
}

type ListItem = {
  name: string;
  persistent: boolean;
  createdAt: number;
  updatedAt: number;
  currentSessionId: string;
  status: "pending" | "running" | "stopping" | "stopped";
  region: string;
  vcpus: number;
  memory: number;
  timeout: number;
  expiresAt: number;
  tags: Record<string, string>;
};

function itemOf(runtime: RuntimeSandbox): ListItem {
  const info = runtime.info;
  return {
    name: info.name ?? info.id,
    persistent: info.onLeaseEnd !== "stop",
    createdAt: Date.parse(info.createdAt),
    updatedAt: Date.parse(info.pausedAt ?? info.readyAt ?? info.createdAt),
    currentSessionId: info.id,
    status: statusOf(info.state),
    region: "iad1",
    vcpus: info.vcpu,
    memory: info.memoryMiB,
    timeout: info.timeoutSeconds * 1000,
    expiresAt: Date.parse(info.expiresAt),
    tags: { ...info.labels },
  };
}

/** Vercel's paginator over a Runtime page: the first page's fields, async
 * iteration over every item, `pages()` and `toArray()`. */
function paginate(first: Page<RuntimeSandbox>, signal?: AbortSignal) {
  const toPage = (page: Page<RuntimeSandbox>) => ({
    sandboxes: page.data.map(itemOf),
    pagination: { count: page.data.length, next: page.nextCursor },
  });
  return Object.assign(toPage(first), {
    async *pages() {
      for await (const page of first.pages()) {
        signal?.throwIfAborted();
        yield toPage(page);
      }
    },
    async *[Symbol.asyncIterator]() {
      for await (const item of first) {
        signal?.throwIfAborted();
        yield itemOf(item);
      }
    },
    async toArray() {
      signal?.throwIfAborted();
      const items = await first.toArray();
      signal?.throwIfAborted();
      return items.map(itemOf);
    },
  });
}
