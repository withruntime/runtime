import type { Runtime } from "../client.js";
import type { Image as RuntimeImage } from "../products/images.js";
import type { Volume as RuntimeVolume } from "../products/volumes.js";
import {
  clientFor,
  type DaytonaConfig,
  type RuntimeCreate,
  type RuntimeSandbox,
  type WithRuntime,
} from "./client.js";
import { DaytonaError, DaytonaNotFoundError, guard, NotSupportedError } from "./errors.js";
import type { Image } from "./image.js";
import { LEASE_MAX_SECONDS } from "../compat/lease.js";
import {
  idlePauseOf,
  idleSeconds,
  networkRules,
  notFound,
  retentionDays,
  Sandbox,
  windowSeconds,
  type Lifecycle,
  type SandboxState,
} from "./sandbox.js";

/* Daytona's client over Runtime's. `new Daytona()` then `daytona.create()`
   makes a Runtime sandbox with Daytona's defaults. */

/** Daytona's default machine: 1 vCPU, 1 GiB memory, 3 GiB disk (checked
 * 23 September 2026). */
export const DEFAULT_RESOURCES = { cpu: 1, memory: 1, disk: 3 } as const;
/** Daytona's default autoStopInterval, 15 minutes. */
export const DEFAULT_AUTO_STOP_MINUTES = 15;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Daytona's own snapshots (daytona-small, daytonaio/sandbox:...) are
 * Runtime's stock image: Ubuntu 24.04 with Python 3.12, Node.js 24 and Bun. */
const STOCK_SNAPSHOT = /^daytona(io)?[-/:]|^daytona$/;
/** Daytona's label for a sandbox's code language. */
export const LANGUAGE_LABEL = "code-toolbox-language";
/** The Linux user given at create, so get() and list() run as it too. */
export const USER_LABEL = "compat.daytona-user";
/** The sandbox owner's names: Daytona's and Runtime's. */
const OWNER = new Set(["daytona", "runtime"]);

export enum CodeLanguage {
  PYTHON = "python",
  TYPESCRIPT = "typescript",
  JAVASCRIPT = "javascript",
}

export interface Resources {
  cpu?: number;
  gpu?: number;
  gpuType?: unknown;
  /** GiB. */
  memory?: number;
  /** GiB. */
  disk?: number;
}
export interface VolumeMount {
  volumeId: string;
  mountPath: string;
  subpath?: string;
}
export type CreateSandboxBaseParams = {
  name?: string;
  user?: string;
  language?: CodeLanguage | string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  autoStopInterval?: number;
  autoPauseInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  ttlMinutes?: number;
  volumes?: VolumeMount[];
  networkBlockAll?: boolean;
  networkAllowList?: string;
  domainAllowList?: string;
  outboundProxyUrl?: string;
  otelEndpointOverride?: string;
  ephemeral?: boolean;
  spot?: boolean;
  linkedSandbox?: string;
  secrets?: Record<string, string>;
  /** Runtime-only: an explicit client, or fields for this create. */
  withruntime?: WithRuntime;
};
export type CreateSandboxFromImageParams = CreateSandboxBaseParams & {
  image: string | Image;
  resources?: Resources;
};
export type CreateSandboxFromSnapshotParams = CreateSandboxBaseParams & {
  snapshot?: string;
  resources?: Resources;
};
export type ForkSandboxParams = { name?: string };
export interface ListSandboxesQuery {
  /** Daytona's page size; every sandbox is still listed. */
  limit?: number;
  sort?: "name" | "cpu" | "memoryGib" | "diskGib" | "lastActivityAt" | "createdAt";
  order?: "asc" | "desc";
  /** An id prefix, any case. */
  id?: string;
  /** A name prefix, any case. */
  name?: string;
  labels?: Record<string, string>;
  states?: SandboxState[];
  targets?: string[];
  minCpu?: number;
  maxCpu?: number;
  minMemoryGib?: number;
  maxMemoryGib?: number;
  minDiskGib?: number;
  maxDiskGib?: number;
  isRecoverable?: boolean;
  createdAtAfter?: Date;
  createdAtBefore?: Date;
  lastActivityAfter?: Date;
  lastActivityBefore?: Date;
  [other: string]: unknown;
}

/** A Daytona snapshot: on Runtime, an image (or a snapshot made with
 * sandbox.createSnapshot). */
export interface Snapshot {
  id: string;
  name: string;
  imageName: string;
  state: "active" | "building" | "pending" | "error" | "removing";
  size: number | null;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  general: boolean;
  cpu: number;
  gpu: number;
  mem: number;
  disk: number;
}
export interface PaginatedSnapshots {
  items: Snapshot[];
  total: number;
  page: number;
  totalPages: number;
}
export interface CreateSnapshotParams {
  name: string;
  image: string | Image;
  resources?: Resources;
  entrypoint?: string[];
  regionId?: string;
}
export interface Volume {
  id: string;
  name: string;
  organizationId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  errorReason: string | null;
}

/** An image name Runtime accepts: letters, digits, dot, dash and underscore. */
const imageName = (reference: string) => reference.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 128);

function snapshotOf(image: RuntimeImage): Snapshot {
  const state =
    image.state === "ready"
      ? "active"
      : image.state === "failed"
        ? "error"
        : image.state === "deleting" || image.state === "deleted"
          ? "removing"
          : image.state === "queued"
            ? "pending"
            : "building";
  return {
    id: image.id,
    name: image.name ?? image.id,
    imageName: image.name ?? image.id,
    state,
    size: image.sizeBytes === null ? null : image.sizeBytes / 1_073_741_824,
    errorReason: image.error,
    createdAt: image.createdAt,
    updatedAt: image.readyAt ?? image.createdAt,
    lastUsedAt: null,
    general: false,
    cpu: 0,
    gpu: 0,
    mem: 0,
    disk: 0,
  };
}

function volumeOf(volume: RuntimeVolume): Volume {
  return {
    id: volume.id,
    name: volume.name ?? volume.id,
    organizationId: "",
    state: volume.state === "ready" ? "ready" : volume.state,
    createdAt: volume.createdAt,
    updatedAt: volume.readyAt ?? volume.createdAt,
    lastUsedAt: null,
    errorReason: volume.error,
  };
}

/** Builds (or finds, when built before) the Runtime image for a Daytona
 * image: a registry reference or a declarative Image. */
async function imageFor(
  client: Runtime,
  image: string | Image,
  onLogs?: (chunk: string) => void,
  name?: string,
): Promise<RuntimeImage> {
  const built = typeof image === "string" ? undefined : await image.build();
  const wanted = name ?? (built ? built.name : imageName(image as string));
  const existing = (await client.images.list({ name: wanted, state: "ready", limit: 1 })).data[0];
  if (existing) return existing;
  return client.images.build(
    built
      ? { name: wanted, dockerfile: built.dockerfile, files: built.files }
      : { name: wanted, image: image as string },
    onLogs ? { onLog: (line) => onLogs(`${line.text}\n`) } : {},
  );
}

/** `daytona.snapshot`: Daytona snapshots as Runtime images. */
export class SnapshotService {
  readonly #client: Runtime;
  constructor(client: Runtime) {
    this.#client = client;
  }

  async list(
    queryOrPage?: { page?: number; limit?: number; sourceSandboxId?: string } | number,
    maybeLimit?: number,
  ): Promise<PaginatedSnapshots> {
    const query =
      typeof queryOrPage === "object" ? queryOrPage : { page: queryOrPage, limit: maybeLimit };
    if (query.sourceSandboxId !== undefined)
      throw new NotSupportedError(
        "Listing snapshots by source sandbox",
        "Use runtime.snapshots.list({ sandboxId }) through sandbox.withruntime.",
      );
    const all = await guard("other", async () =>
      (await this.#client.images.list()).toArray(10_000),
    );
    const limit = query.limit ?? 100;
    const page = query.page ?? 1;
    const items = all.filter((one) => one.state !== "deleted").map(snapshotOf);
    return {
      items: items.slice((page - 1) * limit, page * limit),
      total: items.length,
      page,
      totalPages: Math.max(1, Math.ceil(items.length / limit)),
    };
  }

  async get(idOrName: string): Promise<Snapshot> {
    if (UUID.test(idOrName))
      return snapshotOf(await guard("other", () => this.#client.images.get(idOrName)));
    const found = (
      await guard("other", () => this.#client.images.list({ name: imageName(idOrName), limit: 1 }))
    ).data[0];
    if (!found) throw notFound(`Snapshot ${idOrName}`);
    return snapshotOf(found);
  }

  /** Builds a Runtime image named `name` from a registry image or a Daytona
   * Image, streaming the build log to `onLogs`. */
  async create(
    params: CreateSnapshotParams,
    options: { onLogs?: (chunk: string) => void; timeout?: number } = {},
  ): Promise<Snapshot> {
    if (params.regionId)
      throw new NotSupportedError(
        "Choosing a snapshot region (regionId)",
        "Omit regionId: Runtime places image builds on its available hosts.",
      );
    if (params.resources)
      throw new NotSupportedError(
        "Resources on a snapshot",
        "Pass resources when creating each sandbox from it: daytona.create({ snapshot, resources }).",
      );
    if (params.entrypoint)
      throw new NotSupportedError(
        "An entrypoint on a snapshot",
        "Start the program in a session after create: process.executeSessionCommand(id, { command, runAsync: true }).",
      );
    const image = await guard("other", () =>
      imageFor(this.#client, params.image, options.onLogs, imageName(params.name)),
    );
    return snapshotOf(image);
  }

  async delete(snapshot: Snapshot | string): Promise<void> {
    const id = typeof snapshot === "string" ? (await this.get(snapshot)).id : snapshot.id;
    await guard("other", () => this.#client.images.delete(id));
  }

  /** Runtime images do not go inactive: returns the snapshot as it is. */
  async activate(snapshot: Snapshot | string): Promise<Snapshot> {
    return this.get(typeof snapshot === "string" ? snapshot : snapshot.id);
  }
}

/** `daytona.volume`: Daytona volumes as Runtime volumes. */
export class VolumeService {
  readonly #client: Runtime;
  constructor(client: Runtime) {
    this.#client = client;
  }
  async list(): Promise<Volume[]> {
    const all = await guard("other", async () =>
      (await this.#client.volumes.list()).toArray(10_000),
    );
    return all.filter((one) => one.state !== "deleted").map(volumeOf);
  }
  async get(name: string, create = false): Promise<Volume> {
    const found = (await guard("other", () => this.#client.volumes.list({ name, limit: 1 })))
      .data[0];
    if (found) return volumeOf(found);
    if (create) return this.create(name);
    throw notFound(`Volume ${name}`);
  }
  create(name: string): Promise<Volume> {
    return Promise.reject(
      new NotSupportedError(
        `Creating the volume ${name} without a size`,
        `Runtime volumes have a fixed size: runtime.volumes.create({ name: "${name}", sizeMiB: 10240 }), then mount it by name.`,
      ),
    );
  }
  async delete(volume: Volume): Promise<void> {
    await guard("other", () => this.#client.volumes.delete(volume.id));
  }
}

function unsupportedService(name: string, alternative: string) {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property === "symbol" || property === "then") return undefined;
        return () => Promise.reject(new NotSupportedError(`Daytona's ${name}`, alternative));
      },
    },
  );
}

/** Daytona's client. Uses RUNTIME_API_KEY (or a Runtime key in apiKey or
 * DAYTONA_API_KEY, or the saved `npx withruntime login`). */
export class Daytona implements AsyncDisposable {
  readonly snapshot: SnapshotService;
  readonly volume: VolumeService;
  readonly secret: unknown;
  readonly warmPool: unknown;
  readonly #client: Runtime;
  readonly #create: Partial<RuntimeCreate>;

  constructor(config: DaytonaConfig = {}) {
    this.#client = clientFor(config);
    this.#create = config.withruntime?.create ?? {};
    this.snapshot = new SnapshotService(this.#client);
    this.volume = new VolumeService(this.#client);
    this.secret = unsupportedService(
      "secrets",
      "Use a Runtime secret: `npx withruntime secrets set NAME --host api.example.com`. The sandbox sees a placeholder, and the egress proxy adds the value on HTTPS to that host.",
    );
    this.warmPool = unsupportedService(
      "warm pools",
      "Runtime starts sandboxes from warm templates already; nothing to configure.",
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {}

  /** Creates a sandbox and waits until it runs, with Daytona's defaults: 1
   * vCPU, 1 GiB, 3 GiB disk, pausing after 15 minutes without calls. Funding
   * is left to Runtime: the free trial while the account has trial time, then
   * prepaid credit, exactly as withruntime's own create. */
  async create(
    params: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams = {},
    options: { timeout?: number; onSnapshotCreateLogs?: (chunk: string) => void } = {},
  ): Promise<Sandbox> {
    refuseCreate(params);
    const client = params.withruntime?.client ?? this.#client;
    const lifecycle = lifecycleOf(params);
    const resources = { ...DEFAULT_RESOURCES, ...params.resources };
    const source = await this.#source(client, params, options.onSnapshotCreateLogs);
    const volumes = await this.#volumes(client, params.volumes);
    const network = networkRules(params);
    // Daytona keeps the language in this label, so a sandbox found later with
    // get() or list() runs codeRun in the language it was made for.
    const user = params.user !== undefined && !OWNER.has(params.user) ? params.user : undefined;
    const tagged = {
      ...params.labels,
      ...(params.language && params.language !== "python"
        ? { [LANGUAGE_LABEL]: params.language }
        : {}),
      ...(user ? { [USER_LABEL]: user } : {}),
    };
    const labels = Object.keys(tagged).length ? tagged : undefined;
    const input: RuntimeCreate = {
      ...(source.snapshot
        ? {}
        : {
            vcpu: resources.cpu,
            memoryMiB: Math.round(resources.memory * 1024),
            diskMiB: Math.round(resources.disk * 1024),
          }),
      // A time to live is a time limit, kept by the lease. Without one there
      // is none: it runs while it works and autoStopInterval is its idle
      // pause, counted by the sandbox itself, so a long command is never
      // frozen for want of calls from this client (0300).
      ...(lifecycle.deadline
        ? {
            timeoutSeconds: Math.max(
              60,
              Math.min(
                lifecycle.windowSeconds,
                Math.floor((lifecycle.deadline - Date.now()) / 1000),
              ),
            ),
          }
        : { idlePauseSeconds: idlePauseOf(lifecycle.autoStopInterval) }),
      onLeaseEnd: lifecycle.ephemeral || lifecycle.deadline ? "stop" : "pause",
      ...(params.name ? { name: params.name } : {}),
      ...(labels ? { labels } : {}),
      ...(network ? { network } : {}),
      ...(volumes.length ? { volumes } : {}),
      ...source,
      ...this.#create,
      ...params.withruntime?.create,
    };
    const runtime = await guard("sandbox", () => client.sandboxes.create(input));
    if (user) await asUser(runtime, user);
    if (lifecycle.autoDeleteInterval > 0)
      await guard("sandbox", () =>
        runtime.setRetention(retentionDays(lifecycle.autoDeleteInterval)),
      ).catch(async (error: unknown) => {
        await runtime.stop({ wait: false }).catch(() => undefined);
        throw error;
      });
    const env = {
      ...params.envVars,
      ...(params.outboundProxyUrl
        ? { HTTP_PROXY: params.outboundProxyUrl, HTTPS_PROXY: params.outboundProxyUrl }
        : {}),
    };
    return new Sandbox(runtime, client, {
      env,
      language: params.language ?? "python",
      public: params.public ?? false,
      lifecycle,
      ...("snapshot" in params && params.snapshot ? { snapshot: params.snapshot } : {}),
      ...(user ? { user } : {}),
    });
  }

  async #source(
    client: Runtime,
    params: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams,
    onLogs?: (chunk: string) => void,
  ): Promise<Partial<RuntimeCreate>> {
    if ("image" in params && params.image !== undefined) {
      const image = await guard("other", () => imageFor(client, params.image, onLogs));
      return { image: image.id };
    }
    const name = "snapshot" in params ? params.snapshot : undefined;
    if (name === undefined || STOCK_SNAPSHOT.test(name)) return {};
    if (UUID.test(name)) {
      try {
        await client.images.get(name);
        return { image: name };
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
      return { snapshot: name };
    }
    const image = (
      await guard("other", () =>
        client.images.list({ name: imageName(name), state: "ready", limit: 1 }),
      )
    ).data[0];
    if (image) return { image: image.id };
    const snapshot = (
      await guard("other", () => client.snapshots.list({ name, state: "ready", limit: 1 }))
    ).data[0];
    if (snapshot) return { snapshot: snapshot.id };
    throw new DaytonaNotFoundError(
      `No Runtime image or snapshot is named "${name}". Daytona snapshots do not move to Runtime; build the same ` +
        `environment as a Runtime image with that name: daytona.snapshot.create({ name: "${name}", image }) with this ` +
        `package, or \`npx withruntime image build --dockerfile Dockerfile --name ${imageName(name)}\`.`,
      404,
    );
  }

  async #volumes(client: Runtime, mounts: VolumeMount[] | undefined) {
    const out: { volumeId: string; path: string }[] = [];
    for (const mount of mounts ?? []) {
      let id = mount.volumeId;
      if (!UUID.test(id)) {
        const found = (await guard("other", () => client.volumes.list({ name: id, limit: 1 })))
          .data[0];
        if (!found) throw notFound(`Volume ${id}`);
        id = found.id;
      }
      out.push({ volumeId: id, path: mount.mountPath });
    }
    return out;
  }

  /** A sandbox by id or name. */
  async get(sandboxIdOrName: string): Promise<Sandbox> {
    const runtime = await guard("sandbox", () => find(this.#client, sandboxIdOrName));
    return this.#adopt(runtime);
  }

  #adopt(runtime: RuntimeSandbox): Sandbox {
    const onLeaseEnd = runtime.info.onLeaseEnd;
    const user = runtime.info.labels[USER_LABEL];
    return new Sandbox(runtime, this.#client, {
      env: {},
      language: runtime.info.labels[LANGUAGE_LABEL] ?? "python",
      public: false,
      ...(user ? { user } : {}),
      lifecycle: runtime.info.timeoutSeconds
        ? {
            windowSeconds: runtime.info.timeoutSeconds,
            idleSeconds: runtime.info.timeoutSeconds,
            ephemeral: onLeaseEnd === "stop",
            autoStopInterval: Math.round(runtime.info.timeoutSeconds / 60),
            autoArchiveInterval: 0,
            autoDeleteInterval: -1,
          }
        : {
            // No time limit: its idle pause is its autoStopInterval.
            windowSeconds: LEASE_MAX_SECONDS,
            idleSeconds: Infinity,
            ephemeral: onLeaseEnd === "stop",
            autoStopInterval: Math.round((runtime.info.idlePauseSeconds ?? 0) / 60),
            autoArchiveInterval: 0,
            autoDeleteInterval: -1,
          },
    });
  }

  /** Live and stopped (paused) sandboxes, oldest first. Await it for the old
   * paginated shape, `{ items, total, page, totalPages }`. */
  list(query: ListSandboxesQuery = {}): AsyncIterableIterator<Sandbox> &
    PromiseLike<{
      items: Sandbox[];
      total: number;
      page: number;
      totalPages: number;
    }> {
    const other = Object.keys(query).find((key) => query[key] !== undefined && !LISTED.has(key));
    if (other)
      throw new NotSupportedError(
        `Listing sandboxes by ${other}`,
        other === "isPublic"
          ? "Runtime previews are public or private per port: filter by a label you set at create."
          : "Filter by a label you set at create, or narrow the result yourself.",
      );
    if (query.sort !== undefined && !SORTS[query.sort])
      throw new RangeError(`sort is one of ${Object.keys(SORTS).join(", ")}.`);
    if (query.order !== undefined && query.order !== "asc" && query.order !== "desc")
      throw new RangeError('order is "asc" or "desc".');
    const states = query.states?.flatMap((state): RuntimeSandbox["state"][] =>
      state === "started"
        ? ["running"]
        : state === "starting"
          ? ["starting", "resuming"]
          : state === "stopping"
            ? ["pausing"]
            : state === "stopped" || state === "paused"
              ? ["paused"]
              : [],
    );
    const filter = {
      ...(query.labels ? { labels: query.labels } : {}),
      ...(states ? { state: states } : {}),
      ...(query.limit ? { limit: Math.min(query.limit, 100) } : {}),
    };
    const here = Object.keys(query).some(
      (key) => query[key] !== undefined && !["limit", "labels", "states"].includes(key),
    );
    const client = this.#client;
    const adopt = (runtime: RuntimeSandbox) => this.#adopt(runtime);
    const everything = async () => {
      const page = await guard("other", () => client.sandboxes.list(filter));
      return arrange(await page.toArray(10_000), query);
    };
    async function* iterate() {
      if (here) {
        for (const runtime of await everything()) yield adopt(runtime);
        return;
      }
      const page = await guard("other", () => client.sandboxes.list(filter));
      for await (const runtime of page) yield adopt(runtime);
    }
    const iterator = iterate();
    return Object.assign(iterator, {
      then<A, B>(
        onFulfilled?:
          | ((value: {
              items: Sandbox[];
              total: number;
              page: number;
              totalPages: number;
            }) => A | PromiseLike<A>)
          | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ): PromiseLike<A | B> {
        const all = (async () => {
          const items = (await everything()).map(adopt);
          return { items, total: items.length, page: 1, totalPages: 1 };
        })();
        return all.then(onFulfilled, onRejected);
      },
    });
  }

  start(sandbox: Sandbox, timeout?: number): Promise<void> {
    return sandbox.start(timeout);
  }
  stop(sandbox: Sandbox): Promise<void> {
    return sandbox.stop();
  }
  delete(sandbox: Sandbox, timeout?: number): Promise<void> {
    return sandbox.delete(timeout);
  }
  /** Daytona's older name for delete. */
  remove(sandbox: Sandbox, timeout?: number): Promise<void> {
    return sandbox.delete(timeout);
  }
  fork(sandbox: Sandbox, params?: ForkSandboxParams, timeout?: number): Promise<Sandbox> {
    return sandbox.fork(params, timeout);
  }
  _experimental_fork(
    sandbox: Sandbox,
    params?: ForkSandboxParams,
    timeout?: number,
  ): Promise<Sandbox> {
    return sandbox.fork(params, timeout);
  }
}

function refuseCreate(params: CreateSandboxBaseParams & { resources?: Resources }) {
  const gpuType = params.resources?.gpuType;
  if (
    params.resources?.gpu ||
    (gpuType !== undefined &&
      gpuType !== null &&
      gpuType !== "" &&
      (!Array.isArray(gpuType) || gpuType.length > 0))
  )
    throw new NotSupportedError(
      "GPUs",
      "Runtime runs sandboxes on CPUs; remove gpu and gpuType from resources.",
    );
  if (params.volumes?.some((mount) => mount.subpath))
    throw new NotSupportedError("Mounting part of a volume (subpath)", "Mount the whole volume.");
  const refusals: Array<[keyof CreateSandboxBaseParams, string, string]> = [
    ["spot", "Spot GPU sandboxes (spot)", "Remove it: Runtime runs sandboxes on CPUs."],
    [
      "linkedSandbox",
      "Linked sandboxes (linkedSandbox)",
      "Run both programs in one sandbox, or connect them through a preview address.",
    ],
    [
      "secrets",
      "Daytona secrets",
      "Use a Runtime secret: `npx withruntime secrets set NAME --host api.example.com`. The sandbox sees a placeholder, and the egress proxy adds the value on HTTPS to that host.",
    ],
    [
      "otelEndpointOverride",
      "Sending sandbox telemetry elsewhere (otelEndpointOverride)",
      "Remove it: runtime.otel.create() exports every sandbox's events and CPU and memory metrics over OTLP/HTTP.",
    ],
  ];
  for (const [field, feature, alternative] of refusals)
    if (params[field] !== undefined) throw new NotSupportedError(feature, alternative);
  if (params.user !== undefined && !/^[a-z_][a-z0-9_-]{0,31}$/.test(params.user))
    throw new DaytonaError(`Invalid user name ${JSON.stringify(params.user)}.`, 400);
  if (
    params.language !== undefined &&
    !["python", "javascript", "typescript"].includes(params.language)
  )
    throw new NotSupportedError(
      `The language ${params.language}`,
      "Use python, javascript or typescript; run anything else with process.executeCommand.",
    );
  if (
    params.autoStopInterval !== undefined &&
    params.autoPauseInterval !== undefined &&
    params.autoStopInterval !== 0 &&
    params.autoPauseInterval !== 0
  )
    throw new DaytonaError(
      "At most one of autoStopInterval and autoPauseInterval may be non-zero.",
      400,
    );
}

/** Daytona's lifecycle settings as the lease Runtime keeps. */
export function lifecycleOf(params: CreateSandboxBaseParams): Lifecycle {
  const autoStop =
    params.autoPauseInterval || (params.autoStopInterval ?? DEFAULT_AUTO_STOP_MINUTES);
  const autoDelete = params.ephemeral ? 0 : (params.autoDeleteInterval ?? -1);
  return {
    windowSeconds: windowSeconds(autoStop),
    idleSeconds: idleSeconds(autoStop),
    ...(params.ttlMinutes ? { deadline: Date.now() + params.ttlMinutes * 60_000 } : {}),
    ephemeral: autoDelete === 0,
    autoStopInterval: autoStop,
    autoArchiveInterval: params.autoArchiveInterval ?? 10_080,
    autoDeleteInterval: autoDelete,
  };
}

/** What list() takes; isPublic, snapshots and autoDestroyAt are refused. */
const LISTED = new Set([
  "limit",
  "sort",
  "order",
  "id",
  "name",
  "labels",
  "states",
  "targets",
  "minCpu",
  "maxCpu",
  "minMemoryGib",
  "maxMemoryGib",
  "minDiskGib",
  "maxDiskGib",
  "isRecoverable",
  "createdAtAfter",
  "createdAtBefore",
  "lastActivityAfter",
  "lastActivityBefore",
]);

const lastActivity = (one: RuntimeSandbox) =>
  Date.parse(one.info.lastActiveAt ?? one.info.readyAt ?? one.info.createdAt);
const SORTS: Record<string, (one: RuntimeSandbox) => number | string> = {
  name: (one) => one.info.name ?? one.id,
  cpu: (one) => one.info.vcpu,
  memoryGib: (one) => one.info.memoryMiB / 1024,
  diskGib: (one) => one.info.diskMiB / 1024,
  lastActivityAt: lastActivity,
  createdAt: (one) => Date.parse(one.info.createdAt),
};

/** Daytona's list filters and sorting, applied here: Runtime filters by
 * labels and state only. Sorted descending unless `order` says, as Daytona
 * does; unsorted lists keep Runtime's order, oldest first. */
function arrange(all: RuntimeSandbox[], query: ListSandboxesQuery): RuntimeSandbox[] {
  const within = (value: number, min?: number, max?: number) =>
    (min === undefined || value >= min) && (max === undefined || value <= max);
  const time = (date: Date | undefined) => (date === undefined ? undefined : date.getTime());
  const kept = all.filter(
    (one) =>
      (query.id === undefined || one.id.toLowerCase().startsWith(query.id.toLowerCase())) &&
      (query.name === undefined ||
        (one.info.name ?? one.id).toLowerCase().startsWith(query.name.toLowerCase())) &&
      (query.targets === undefined || query.targets.includes("us")) &&
      (query.isRecoverable === undefined || query.isRecoverable === false) &&
      within(one.info.vcpu, query.minCpu, query.maxCpu) &&
      within(one.info.memoryMiB / 1024, query.minMemoryGib, query.maxMemoryGib) &&
      within(one.info.diskMiB / 1024, query.minDiskGib, query.maxDiskGib) &&
      within(
        Date.parse(one.info.createdAt),
        time(query.createdAtAfter),
        time(query.createdAtBefore),
      ) &&
      within(lastActivity(one), time(query.lastActivityAfter), time(query.lastActivityBefore)),
  );
  const key = query.sort === undefined ? undefined : SORTS[query.sort]!;
  if (!key) return query.order === "desc" ? kept.reverse() : kept;
  const sign = query.order === "asc" ? 1 : -1;
  return kept.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return sign * (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number));
  });
}

/** Readies a new sandbox to run as `user`: the user must be in the image, as
 * on Daytona. It joins the owner's group, and the working directory takes
 * that group for what is made in it, so both may change each other's files.
 * A user the image lacks ends the sandbox and says how to add it. */
async function asUser(runtime: RuntimeSandbox, user: string): Promise<void> {
  const ready = await guard("sandbox", () =>
    runtime.exec([
      "sh",
      "-c",
      'id -u "$1" >/dev/null 2>&1 || exit 3; [ "$1" = root ] || { sudo usermod -aG runtime "$1" && sudo chmod 2775 /workspace; }',
      "sh",
      user,
    ]),
  ).catch(async (error: unknown) => {
    await runtime.stop({ wait: false }).catch(() => undefined);
    throw error;
  });
  if (ready.exitCode === 0) return;
  await runtime.stop({ wait: false }).catch(() => undefined);
  throw new DaytonaError(
    ready.exitCode === 3
      ? `The user "${user}" does not exist in this sandbox's image. Add it to the image (RUN useradd -m ${user}), or leave user out to run as the sandbox owner, who has passwordless sudo.`
      : `The sandbox could not be readied for the user "${user}": ${ready.stderr.trim() || `exit ${ready.exitCode}`}`,
    400,
  );
}

/** The sandbox with this Runtime id, or the newest live one with this name. */
async function find(client: Runtime, idOrName: string): Promise<RuntimeSandbox> {
  if (UUID.test(idOrName)) return client.sandboxes.get(idOrName);
  const all = await (await client.sandboxes.list({ name: idOrName })).toArray(1000);
  const found = all.at(-1);
  if (!found) throw notFound(`Sandbox ${idOrName}`);
  return found;
}
