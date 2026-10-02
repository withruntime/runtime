import type { Runtime } from "../client.js";
import type { Snapshot as RuntimeSnapshot } from "../snapshots.js";
import {
  clientFor,
  type RuntimeCreate,
  type RuntimeOptions,
  type RuntimeSandbox,
} from "./client.js";
import { envFileCommand, envFileLines } from "./context.js";
import { guard, isNotFound, NotSupportedError, responseError } from "./errors.js";
import { findSandbox, LEASE_SECONDS, STANDBY, userLabels, whenNameFree } from "./lookup.js";
import { paginate, type PaginatedList } from "./pagination.js";

/* Blaxel snapshots over Runtime snapshots. A Runtime snapshot keeps the
   sandbox's whole machine (files, memory and running processes); Blaxel's
   keeps what a fork needs to run. Taking one pauses a running sandbox for a
   moment and wakes it. Kept 365 days (a Blaxel snapshot lasts until deleted). */

export type SandboxSnapshotSource = { readonly deleted?: boolean; kind?: "sandbox"; name: string };
export type SandboxSnapshotSpec = { image?: string; memory?: number; region?: string };
export type SandboxSnapshot = {
  createdAt: string;
  createdBy?: string;
  readonly id: string;
  name: string;
  sandboxName?: string;
  source?: SandboxSnapshotSource;
  spec?: SandboxSnapshotSpec;
  status: string;
  workspace: string;
};
export type SandboxForkResponse = {
  name?: string;
  snapshotId?: string;
  type?: "sandbox" | "application";
};
export type SandboxRestoreResponse = { name: string; snapshotId: string };
export type Env = { name?: string; secret?: boolean; value?: string };
export type SnapshotCreateConfiguration = {
  name?: string;
  source: { name: string; kind?: "sandbox" };
};
export type SnapshotForkOptions = {
  targetType?: "sandbox" | "application";
  port?: number;
  traffic?: number;
  customDomain?: string;
  prefix?: string;
  envs?: Env[];
};
export type SnapshotListQuery = {
  cursor?: string;
  limit?: number;
  sort?: string;
  q?: string;
  anchor?: "end";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Blaxel snapshot is kept until deleted: Runtime's longest. */
const SNAPSHOT_DAYS = 365;
/** Paused sandboxes are kept this long when no TTL says otherwise. */
export const KEEP_DAYS = 365;

export function snapshotModel(snapshot: RuntimeSnapshot, sandboxName?: string): SandboxSnapshot {
  return {
    id: snapshot.id,
    name: snapshot.name ?? snapshot.id,
    createdAt: snapshot.createdAt,
    status: snapshot.state.toUpperCase(),
    workspace: "",
    ...(sandboxName ? { sandboxName } : {}),
    source: { kind: "sandbox", name: sandboxName ?? snapshot.sourceSandboxId },
    spec: { memory: snapshot.shape?.memoryMiB, region: "us-was-1" },
  };
}

/** Envs as a record; a nameless one is refused. */
export function envRecord(envs: Env[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (envs ?? []).map((env) => {
      if (!env.name) throw responseError(400, "every env needs a name");
      return [env.name, env.value ?? ""];
    }),
  );
}

/** Appends envs to a sandbox's env file: they win over the ones it has. */
export async function appendEnvs(runtime: RuntimeSandbox, envs: Record<string, string>) {
  if (!Object.keys(envs).length) return;
  const result = await guard(() =>
    runtime.exec(envFileCommand(true), { stdin: envFileLines(envs) }),
  );
  if (result.exitCode !== 0)
    throw responseError(500, `Setting the sandbox's envs failed: ${result.stderr.trim()}`);
}

/** A new sandbox named `name`, started from a snapshot, behaving as a Blaxel
 * sandbox. */
export async function startFromSnapshot(
  client: Runtime,
  snapshotId: string,
  name: string,
  labels: Record<string, string>,
  envs: Record<string, string>,
): Promise<RuntimeSandbox> {
  const input: RuntimeCreate = {
    snapshot: snapshotId,
    name,
    labels,
    ...STANDBY,
    timeoutSeconds: LEASE_SECONDS,
    onLeaseEnd: "pause",
  };
  const runtime = await guard(() => whenNameFree(client, () => client.sandboxes.create(input)));
  try {
    await Promise.all([
      appendEnvs(runtime, envs),
      runtime.info.funding === "paid" ? guard(() => runtime.setRetention(KEEP_DAYS)) : undefined,
    ]);
  } catch (error) {
    await runtime.stop({ wait: false }).catch(() => undefined);
    throw error;
  }
  return runtime;
}

function refuseApplication(options: { targetType?: string } = {}) {
  if (options.targetType === "application")
    throw new NotSupportedError(
      "Forking into an application",
      "Fork into a sandbox and share its port with sandbox.previews.create.",
    );
}

/** A snapshot, as Blaxel's Snapshot class. */
export class Snapshot {
  readonly #snapshot: SandboxSnapshot;
  readonly #client: Runtime;
  constructor(snapshot: SandboxSnapshot, client: Runtime) {
    this.#snapshot = snapshot;
    this.#client = client;
  }
  get name(): string {
    return this.#snapshot.name;
  }
  get id(): string {
    return this.#snapshot.id;
  }
  get status(): string {
    return this.#snapshot.status;
  }
  get workspace(): string {
    return this.#snapshot.workspace;
  }
  get createdAt(): string {
    return this.#snapshot.createdAt;
  }
  get source(): SandboxSnapshotSource | undefined {
    return this.#snapshot.source;
  }
  get spec(): SandboxSnapshotSpec | undefined {
    return this.#snapshot.spec;
  }

  /** Takes a snapshot of the sandbox named in `source`. */
  static async create(
    config: SnapshotCreateConfiguration,
    options: RuntimeOptions = {},
  ): Promise<Snapshot> {
    if (config.source.kind !== undefined && config.source.kind !== "sandbox")
      throw new NotSupportedError(
        `A snapshot of a ${String(config.source.kind)}`,
        "Snapshot a sandbox.",
      );
    const client = clientFor(options);
    const runtime = await guard(() => findSandbox(client, config.source.name));
    const taken = await guard(() =>
      runtime.snapshot({
        ...(config.name ? { name: config.name } : {}),
        labels: userLabels(runtime.info.labels),
        retentionDays: SNAPSHOT_DAYS,
      }),
    );
    return new Snapshot(snapshotModel(taken, config.source.name), client);
  }

  /** A snapshot by its id. */
  static async get(snapshotId: string, options: RuntimeOptions = {}): Promise<Snapshot> {
    const client = clientFor(options);
    return new Snapshot(snapshotModel(await guard(() => client.snapshots.get(snapshotId))), client);
  }

  /** The account's snapshots, a page at a time; `for await` walks them all. */
  static async list(
    query: SnapshotListQuery = {},
    options: RuntimeOptions = {},
  ): Promise<PaginatedList<Snapshot>> {
    for (const field of ["cursor", "q", "anchor"] as const)
      if (query[field] !== undefined)
        throw new NotSupportedError(
          `Listing snapshots by ${field}`,
          "List them (oldest first) and filter the result yourself; nextPage() walks the pages.",
        );
    if (query.sort !== undefined && query.sort !== "createdAt:asc")
      throw new NotSupportedError(
        `Listing snapshots sorted by ${query.sort}`,
        "Runtime lists them oldest first: sort the result yourself.",
      );
    const client = clientFor(options);
    const page = await guard(() =>
      client.snapshots.list(query.limit ? { limit: Math.min(query.limit, 100) } : {}),
    );
    return paginate(page, (one) => new Snapshot(snapshotModel(one), client));
  }

  static async delete(snapshotId: string, options: RuntimeOptions = {}): Promise<void> {
    const client = clientFor(options);
    await guard(() => client.snapshots.delete(snapshotId));
  }
  async delete(): Promise<void> {
    await guard(() => this.#client.snapshots.delete(this.id));
  }

  /** A new sandbox named `targetName`, started from this snapshot. */
  async fork(targetName: string, options: SnapshotForkOptions = {}): Promise<SandboxForkResponse> {
    refuseApplication(options);
    await startFromSnapshot(this.#client, this.id, targetName, {}, envRecord(options.envs));
    return { name: targetName, snapshotId: this.id, type: "sandbox" };
  }
}

/** What `sandbox.snapshots` needs from its sandbox. */
export interface SnapshotContext {
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly client: Runtime;
  run<T>(work: (runtime: RuntimeSandbox) => Promise<T>): Promise<T>;
  labels(): Record<string, string>;
}

/** `sandbox.snapshots`: this sandbox's snapshots, by name. */
export class SandboxSnapshotsResource {
  readonly #ctx: SnapshotContext;
  constructor(ctx: SnapshotContext) {
    this.#ctx = ctx;
  }
  get sandboxName(): string {
    return this.#ctx.sandboxName;
  }

  async create(name?: string): Promise<Snapshot> {
    const taken = await this.#ctx.run((runtime) =>
      runtime.snapshot({
        ...(name ? { name } : {}),
        labels: userLabels(this.#ctx.labels()),
        retentionDays: SNAPSHOT_DAYS,
      }),
    );
    return new Snapshot(snapshotModel(taken, this.sandboxName), this.#ctx.client);
  }

  async list(): Promise<Snapshot[]> {
    const page = await guard(() =>
      this.#ctx.client.snapshots.list({ sandboxId: this.#ctx.sandboxId }),
    );
    const all = await guard(() => page.toArray());
    return all.map((one) => new Snapshot(snapshotModel(one, this.sandboxName), this.#ctx.client));
  }

  /** This sandbox's newest snapshot with that name, or with that id. */
  async get(snapshotName: string): Promise<Snapshot> {
    return new Snapshot(
      snapshotModel(await this.#find(snapshotName), this.sandboxName),
      this.#ctx.client,
    );
  }

  async #find(nameOrId: string): Promise<RuntimeSnapshot> {
    const client = this.#ctx.client;
    const page = await guard(() =>
      client.snapshots.list({ sandboxId: this.#ctx.sandboxId, name: nameOrId }),
    );
    const named = page.data.filter((one) => one.name === nameOrId).at(-1);
    if (named) return named;
    if (UUID.test(nameOrId))
      try {
        const byId = await guard(() => client.snapshots.get(nameOrId));
        if (byId.sourceSandboxId === this.#ctx.sandboxId) return byId;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    throw responseError(404, `snapshot ${nameOrId} not found`);
  }

  /** The id of a snapshot named, or given by id, for a fork. */
  async idOf(nameOrId: string): Promise<string> {
    return (await this.#find(nameOrId)).id;
  }

  async delete(snapshotName: string): Promise<void> {
    const found = await this.#find(snapshotName);
    await guard(() => this.#ctx.client.snapshots.delete(found.id));
  }

  restore(_snapshotName: string): Promise<never> {
    return Promise.reject(
      new NotSupportedError(
        "Restoring a sandbox to its snapshot in place",
        "Start a new sandbox from it: sandbox.fork(newName, { snapshotId }) or snapshot.fork(newName). The new sandbox has its own name and preview addresses.",
      ),
    );
  }
}

export { refuseApplication };
