/** `morphcloud` 0.0.20's MorphCloudClient on Runtime: change the import to
 * `withruntime/morph` and Morph's instances, snapshots and branches run as
 * Runtime sandboxes and snapshots. An instance is a sandbox, a snapshot a
 * Runtime snapshot, metadata its labels, an HTTP service a preview. */
import { createHash } from "node:crypto";
import type { Runtime } from "../client.js";
import { RuntimeError } from "../errors.js";
import type { Preview } from "../products/previews.js";
import { Sandbox } from "../sandbox.js";
import type { Snapshot as NativeSnapshot } from "../snapshots.js";
import type { SandboxInfo } from "../types.js";
import {
  client,
  CompatibilityError,
  only,
  refuse,
  type ClientOptions,
  type RefusedAsync,
} from "../compat/core.js";
export { CompatibilityError };

const PROVIDER = "morph";
/** Morph's base image; on Runtime, the default image. */
export const MORPH_DEFAULT_IMAGE = "morphvm-minimal";
/** Labels the adapter keeps for itself; never shown as metadata. */
const IMAGE_LABEL = "morph.image";
const DIGEST_LABEL = "morph.digest";
const HTTP_LABEL = "morph.http.";
const RESERVED = (key: string) =>
  key === "compat.provider" ||
  key === IMAGE_LABEL ||
  key === DIGEST_LABEL ||
  key.startsWith(HTTP_LABEL);
const SSH =
  "reach a sandbox with `runtime sandboxes ssh <id>` (also VS Code and JetBrains) or sandbox.native.tunnel()";

export enum SnapshotStatus {
  PENDING = "pending",
  READY = "ready",
  FAILED = "failed",
  DELETING = "deleting",
  DELETED = "deleted",
}
export enum InstanceStatus {
  PENDING = "pending",
  READY = "ready",
  PAUSED = "paused",
  SAVING = "saving",
  ERROR = "error",
}
export interface ResourceSpec {
  vcpus: number;
  /** MiB. */
  memory: number;
  /** MiB. */
  diskSize: number;
}
export interface SnapshotRefs {
  imageId: string;
}
export interface InstanceHttpService {
  name: string;
  port: number;
  url: string;
}
export interface InstanceNetworking {
  internalIp?: string;
  httpServices: InstanceHttpService[];
  auth_mode?: string;
}
export interface InstanceRefs {
  snapshotId: string;
  imageId: string;
}
export interface InstanceExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
}
export interface InstanceTTL {
  ttlSeconds?: number;
  ttlExpireAt?: number;
  ttlAction?: "stop" | "pause";
}
export interface InstanceWakeOn {
  wakeOnSsh?: boolean;
  wakeOnHttp?: boolean;
}
export interface ExecOptions {
  /** Seconds; default 24 hours, as Morph's. */
  timeout?: number;
  onStdout?: (content: string) => void;
  onStderr?: (content: string) => void;
}
export interface InstanceSshKey {
  object: "instance_ssh_key";
  private_key: string;
  public_key: string;
  password: string;
}
export interface MorphCloudClientOptions extends ClientOptions {
  /** A Runtime key (`rtcloud_...`); a Morph key is never sent anywhere. */
  apiKey?: string;
  baseUrl?: string;
  verbose?: boolean;
}
export type ImageListOptions = Record<string, never>;
export interface SnapshotListOptions {
  digest?: string;
  metadata?: Record<string, string>;
}
export interface SnapshotCreateOptions {
  imageId?: string;
  vcpus?: number;
  memory?: number;
  diskSize?: number;
  digest?: string;
  metadata?: Record<string, string>;
}
export interface SnapshotGetOptions {
  snapshotId: string;
}
export interface InstanceListOptions {
  metadata?: Record<string, string>;
}
export interface InstanceStartOptions {
  snapshotId: string;
  metadata?: Record<string, string>;
  ttlSeconds?: number;
  ttlAction?: "stop" | "pause";
  /** Seconds to wait until it runs. */
  timeout?: number;
}
export interface InstanceSnapshotOptions {
  digest?: string;
  metadata?: Record<string, string>;
}
export interface InstanceGetOptions {
  instanceId: string;
}
export interface InstanceStopOptions {
  instanceId: string;
}
export interface InstanceBootOptions {
  snapshotId: string;
  vcpus?: number;
  memory?: number;
  diskSize?: number;
  metadata?: Record<string, string>;
  ttlSeconds?: number;
  ttlAction?: "stop" | "pause";
}
export interface SyncOptions {
  delete?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  respectGitignore?: boolean;
}

// Errors ----------------------------------------------------------------------

/** Morph throws a plain Error, `HTTP <status> ... Response Body: <json>`, for
 * a failed call. A Runtime error becomes the same shape, with the
 * RuntimeError as its `cause` and its `status` and `code` kept. */
async function api<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.status === 0) throw error;
    const body = { error: { code: error.code, message: error.message, hint: error.hint } };
    const translated = new Error(
      `HTTP ${error.status} ${error.code} for Runtime\nResponse Body: ${JSON.stringify(body, null, 2)}`,
      { cause: error },
    );
    Object.assign(translated, { status: error.status, code: error.code });
    throw translated;
  }
}

// Shapes ----------------------------------------------------------------------

const seconds = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);
const labelsOf = (value: object): Record<string, string> =>
  ((value as { labels?: unknown }).labels as Record<string, string> | undefined) ?? {};
const metadataOf = (labels: Record<string, string>) =>
  Object.fromEntries(Object.entries(labels).filter(([key]) => !RESERVED(key)));
/** Metadata must not write the adapter's own labels. */
function checkMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  if (metadata === undefined) return {};
  if (metadata === null || typeof metadata !== "object")
    throw new TypeError("metadata must be an object");
  for (const [key, value] of Object.entries(metadata)) {
    if (RESERVED(key))
      throw new CompatibilityError(
        "Morph",
        `metadata key ${key}, which the adapter keeps for itself`,
      );
    if (typeof value !== "string") throw new TypeError(`metadata ${key} must be a string`);
  }
  return metadata;
}
const statusOf = (state: SandboxInfo["state"]): InstanceStatus =>
  state === "running"
    ? InstanceStatus.READY
    : state === "paused"
      ? InstanceStatus.PAUSED
      : state === "pausing"
        ? InstanceStatus.SAVING
        : state === "stopping" || state === "stopped"
          ? InstanceStatus.ERROR
          : InstanceStatus.PENDING;
const snapshotStatusOf = (state: NativeSnapshot["state"]): SnapshotStatus =>
  state === "capturing" ? SnapshotStatus.PENDING : (state as SnapshotStatus);
/** A Runtime snapshot name for a Morph digest: digests are any string, names are not. */
const digestName = (digest: string) => `morph-${createHash("sha256").update(digest).digest("hex")}`;
function ttlOf(ttlSeconds?: number, ttlAction?: "stop" | "pause") {
  if (ttlAction !== undefined && ttlAction !== "stop" && ttlAction !== "pause")
    throw new TypeError("ttlAction must be stop or pause");
  if (ttlSeconds === undefined) {
    if (ttlAction !== undefined)
      throw new CompatibilityError("Morph", "ttlAction without ttlSeconds");
    return {};
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400)
    throw new CompatibilityError(
      "Morph",
      "ttlSeconds outside 60 to 86400 whole seconds (Runtime's time limit)",
    );
  // Morph's stop deletes an instance: Runtime's "delete" does the same.
  return {
    timeoutSeconds: ttlSeconds,
    onLeaseEnd: ttlAction === "pause" ? "pause" : "delete",
  } as const;
}
/** A Runtime image for a Morph image id: Morph's base image is Runtime's
 * default; any other id is a Runtime image (id, name, name:tag). */
function imageOf(imageId: string | undefined): string | undefined {
  if (imageId === undefined || imageId === MORPH_DEFAULT_IMAGE) return undefined;
  if (imageId.startsWith("morphvm-"))
    throw new CompatibilityError(
      "Morph",
      `image ${imageId}; build it as a Runtime image (runtime.images.build) and pass its name`,
    );
  return imageId;
}

// Images ------------------------------------------------------------------------

export class Image {
  readonly object = "image" as const;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly diskSize: number,
    readonly created: number,
    readonly description?: string,
  ) {}
}

// Snapshots ---------------------------------------------------------------------

export class Snapshot {
  readonly id: string;
  readonly object = "snapshot" as const;
  readonly created: number;
  readonly status: SnapshotStatus;
  readonly spec: ResourceSpec;
  readonly refs: SnapshotRefs;
  readonly digest?: string;
  metadata?: Record<string, string>;
  #client: MorphCloudClient;
  constructor(
    readonly native: NativeSnapshot,
    morph: MorphCloudClient,
  ) {
    const labels = labelsOf(native);
    this.id = native.id;
    this.created = seconds(native.createdAt);
    this.status = snapshotStatusOf(native.state);
    this.spec = {
      vcpus: native.shape.vcpu,
      memory: native.shape.memoryMiB,
      diskSize: native.shape.diskMiB,
    };
    this.refs = { imageId: labels[IMAGE_LABEL] ?? MORPH_DEFAULT_IMAGE };
    if (labels[DIGEST_LABEL] !== undefined) this.digest = labels[DIGEST_LABEL];
    this.metadata = metadataOf(labels);
    this.#client = morph;
  }
  async delete(): Promise<void> {
    await api(() => this.#client.runtime.snapshots.delete(this.id));
  }
  /** Morph's chain hash: SHA-256 of the parent's hash, a newline and the effect. */
  static computeChainHash(parentChainHash: string, effectIdentifier: string): string {
    return createHash("sha256")
      .update(parentChainHash)
      .update("\n")
      .update(effectIdentifier)
      .digest("hex");
  }
  /** Runs `command` on a copy of this snapshot and snapshots the result, once:
   * a later setup of the same command on the same snapshot answers the
   * snapshot made the first time. A command that fails throws, and the copy
   * is stopped either way. */
  async setup(command: string): Promise<Snapshot> {
    if (typeof command !== "string") throw new TypeError("command must be a string");
    const morph = this.#client;
    // Morph's effect identifier: its anonymous effect's name ("") and arguments.
    const digest = Snapshot.computeChainHash(
      this.digest || this.id,
      JSON.stringify([command, false, true]),
    );
    const cached = await morph.snapshots.list({ digest });
    if (cached.length > 0) {
      if (morph.verbose) console.log(`✅ [CACHED] ${command}`);
      return cached[0]!;
    }
    if (morph.verbose) console.log(`🚀 [RUN] ${command}`);
    const instance = await morph.instances.start({ snapshotId: this.id });
    try {
      const result = await instance.exec(command, {
        onStdout: (text) => process.stdout.write(text),
        onStderr: (text) => process.stderr.write(text),
      });
      if (result.exit_code !== 0) throw new Error(`Command exited with code ${result.exit_code}`);
      return await instance.snapshot({ digest, metadata: this.metadata });
    } finally {
      await instance.stop();
    }
  }
  /** Adds or changes these metadata keys; the others stay. */
  async setMetadata(metadata: Record<string, string>): Promise<void> {
    const changes = checkMetadata(metadata ?? {});
    const updated = await api(() =>
      this.#client.runtime.snapshots.update(this.id, {
        labels: { ...labelsOf(this.native), ...changes },
      }),
    );
    this.metadata = metadataOf(labelsOf(updated));
  }
}

// Instances ---------------------------------------------------------------------

export class Instance {
  readonly id: string;
  readonly object = "instance" as const;
  readonly created: number;
  status!: InstanceStatus;
  readonly spec: ResourceSpec;
  readonly refs: InstanceRefs;
  networking!: InstanceNetworking;
  ttl!: InstanceTTL;
  wakeOn!: InstanceWakeOn;
  metadata?: Record<string, string>;
  declare readonly ssh: RefusedAsync;
  declare readonly sshKey: RefusedAsync;
  declare readonly sshKeyRotate: RefusedAsync;
  declare readonly reboot: RefusedAsync;
  declare readonly setTTL: RefusedAsync;
  #client: MorphCloudClient;
  #native!: Sandbox;
  constructor(sandbox: Sandbox, morph: MorphCloudClient, previews: Preview[] = []) {
    this.#client = morph;
    this.id = sandbox.id;
    this.created = seconds(sandbox.info.createdAt);
    this.spec = {
      vcpus: sandbox.info.vcpu,
      memory: sandbox.info.memoryMiB,
      diskSize: sandbox.info.diskMiB,
    };
    const snapshotId = sandbox.info.snapshotId ?? sandbox.info.sourceSnapshotId;
    this.refs = {
      snapshotId: typeof snapshotId === "string" ? snapshotId : "",
      imageId: labelsOf(sandbox.info)[IMAGE_LABEL] ?? MORPH_DEFAULT_IMAGE,
    };
    this.#update(sandbox, previews);
  }
  /** The Runtime sandbox behind it, for what Morph has no call for. */
  get native(): Sandbox {
    return this.#native;
  }
  #update(sandbox: Sandbox, previews: Preview[]) {
    this.#native = sandbox;
    const info = sandbox.info;
    const labels = labelsOf(info);
    this.status = statusOf(info.state);
    this.metadata = metadataOf(labels);
    const byPort = new Map(previews.map((p) => [p.port, p]));
    const httpServices: InstanceHttpService[] = [];
    for (const [key, value] of Object.entries(labels)) {
      if (!key.startsWith(HTTP_LABEL)) continue;
      const preview = byPort.get(Number(value));
      if (preview)
        httpServices.push({
          name: key.slice(HTTP_LABEL.length),
          port: preview.port,
          url: preview.url,
        });
    }
    this.networking = { httpServices };
    this.ttl = info.timeoutSeconds
      ? {
          ttlSeconds: info.timeoutSeconds,
          ttlExpireAt: info.endsAt ? seconds(info.endsAt) : undefined,
          ttlAction: info.onLeaseEnd === "pause" ? "pause" : "stop",
        }
      : {};
    const wake = info.autoWake !== false;
    this.wakeOn = { wakeOnSsh: wake, wakeOnHttp: wake };
  }
  async #refresh(): Promise<void> {
    const sandbox = await this.#client.runtime.sandboxes.get(this.id);
    this.#update(sandbox, await previewsOf(sandbox));
  }
  /** Deletes it, with its disk and memory, as Morph's stop does; its snapshots stay. */
  async stop(): Promise<void> {
    await this.#client.instances.stop({ instanceId: this.id });
  }
  /** Keeps memory and disk, and stops compute charges. */
  async pause(): Promise<void> {
    await api(async () => {
      await this.#native.pause();
      await this.#refresh();
    });
  }
  async resume(): Promise<void> {
    await api(async () => {
      await this.#native.wake();
      await this.#refresh();
    });
  }
  /** Adds or changes these metadata keys; the others stay. */
  async setMetadata(metadata: Record<string, string>): Promise<void> {
    const changes = checkMetadata(metadata ?? {});
    await api(async () => {
      await this.#native.update({ labels: { ...labelsOf(this.#native.info), ...changes } });
      await this.#refresh();
    });
  }
  /** Runtime wakes a paused sandbox on any request (an API call, SSH, a
   * visit to a shared port) or on none: both values must agree. */
  async setWakeOn(wakeOnSsh?: boolean, wakeOnHttp?: boolean): Promise<void> {
    if (wakeOnSsh === undefined && wakeOnHttp === undefined) return;
    if (wakeOnSsh !== undefined && wakeOnHttp !== undefined && wakeOnSsh !== wakeOnHttp)
      throw new CompatibilityError(
        "Morph",
        "different wakeOnSsh and wakeOnHttp; Runtime's autoWake covers every kind of request",
      );
    const autoWake = (wakeOnSsh ?? wakeOnHttp)!;
    await api(async () => {
      await this.#native.update({ autoWake });
      await this.#refresh();
    });
  }
  /** Files, memory and running processes; a running instance pauses for the
   * moment it takes, then runs on. */
  async snapshot(options: InstanceSnapshotOptions = {}): Promise<Snapshot> {
    only("Morph snapshot", options, ["digest", "metadata"]);
    const metadata = checkMetadata(options.metadata);
    const digest = options.digest || undefined;
    return api(async () => {
      const native = await this.#native.snapshot({
        ...(digest === undefined ? {} : { name: digestName(digest) }),
        labels: {
          ...metadata,
          [IMAGE_LABEL]: this.refs.imageId,
          ...(digest === undefined ? {} : { [DIGEST_LABEL]: digest }),
        },
      });
      return new Snapshot(native, this.#client);
    });
  }
  /** `count` running copies, with its files, memory and processes, and the
   * snapshot they were started from, which is kept. */
  async branch(count: number): Promise<{ snapshot: Snapshot; instances: Instance[] }> {
    if (!Number.isInteger(count) || count < 1)
      throw new TypeError("count must be a positive integer");
    const morph = this.#client;
    return api(async () => {
      const t = morph.runtime.transport;
      const reply = await t.json<{ sandboxes: SandboxInfo[]; snapshot: NativeSnapshot | null }>({
        method: "POST",
        path: `/v1/sandboxes/${encodeURIComponent(this.id)}:fork`,
        body: { count, keepSnapshot: true },
        wait: 60,
      });
      if (!reply.snapshot) throw new Error("Runtime did not keep the branch's snapshot");
      return {
        snapshot: new Snapshot(reply.snapshot, morph),
        instances: reply.sandboxes.map((info) => new Instance(new Sandbox(t, info), morph)),
      };
    });
  }
  /** Shares `port` at an HTTPS address. With no auth_mode, anyone with the
   * address reaches it (Runtime's public preview, which needs a kept
   * top-up); with auth_mode "api_key", a request needs the preview's token
   * in `x-runtime-preview-token` (native.previews.get(port)). */
  async exposeHttpService(
    name: string,
    port: number,
    auth_mode?: string,
  ): Promise<InstanceHttpService> {
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new TypeError("name must be 1 to 64 letters, digits, dashes or underscores");
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new TypeError("port must be 1 to 65535");
    if (auth_mode !== undefined && auth_mode !== "none" && auth_mode !== "api_key")
      throw new CompatibilityError("Morph", `auth_mode ${auth_mode}`);
    return api(async () => {
      const preview = await this.#native.previews.create(port, {
        visibility: auth_mode === "api_key" ? "private" : "public",
      });
      await this.#native.update({
        labels: { ...labelsOf(this.#native.info), [`${HTTP_LABEL}${name}`]: String(port) },
      });
      await this.#refresh();
      return { name, port, url: preview.url };
    });
  }
  async hideHttpService(name: string): Promise<void> {
    await api(async () => {
      const labels = { ...labelsOf(this.#native.info) };
      const port = labels[`${HTTP_LABEL}${name}`];
      if (port === undefined)
        throw new RuntimeError({
          code: "not_found",
          status: 404,
          message: `HTTP service ${name} not found`,
        });
      delete labels[`${HTTP_LABEL}${name}`];
      if (!Object.entries(labels).some(([k, v]) => k.startsWith(HTTP_LABEL) && v === port))
        await this.#native.previews.delete(Number(port));
      await this.#native.update({ labels });
      await this.#refresh();
    });
  }
  /** A string, or a one-item array, runs in a shell; a longer array runs as
   * its arguments. Output streams to onStdout and onStderr as it comes. */
  async exec(command: string | string[], options: ExecOptions = {}): Promise<InstanceExecResponse> {
    only("Morph exec", options, ["timeout", "onStdout", "onStderr"]);
    const argv = typeof command === "string" ? [command] : command;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string"))
      throw new TypeError("command must be a string or a nonempty array of strings");
    const { timeout, onStdout, onStderr } = options;
    if (timeout !== undefined && !(timeout > 0 && timeout <= 86_400))
      throw new TypeError("timeout must be more than 0 and at most 86400 seconds");
    const result = await api(() =>
      this.#native.exec(argv.length === 1 ? argv[0]! : argv, {
        timeoutMs: Math.ceil((timeout ?? 86_400) * 1000),
        ...(onStdout ? { onStdout } : {}),
        ...(onStderr ? { onStderr } : {}),
      }),
    );
    if (result.timedOut)
      throw new Error(
        `Command execution timed out after ${timeout ?? "24 hours"} ${timeout ? (timeout === 1 ? "second" : "seconds") : ""}`,
      );
    return { exit_code: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
  }
  /** Seconds; waits until it runs, waking it if paused. */
  async waitUntilReady(timeout?: number): Promise<void> {
    const until = timeout === undefined ? Infinity : Date.now() + timeout * 1000;
    await this.#refresh();
    if (this.status === InstanceStatus.PAUSED) await this.resume();
    while (this.status !== InstanceStatus.READY) {
      if (this.status === InstanceStatus.ERROR) throw new Error("Instance encountered an error");
      if (Date.now() > until) throw new Error("Instance did not become ready before timeout");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.#refresh();
    }
  }
  /** Copies a local file or folder into the instance, or out of it: the
   * instance's side is written `<instance id>:<path>`. Without delete, dry
   * runs or .gitignore, which refuse. */
  async sync(source: string, dest: string, options: SyncOptions = {}): Promise<void> {
    only("Morph sync", options, ["delete", "dryRun", "verbose", "respectGitignore"]);
    if (options.delete || options.dryRun || options.respectGitignore)
      throw new CompatibilityError(
        "Morph",
        "sync with delete, dryRun or respectGitignore; copy with sandbox.native.files.upload or download",
      );
    const side = (path: string) => {
      const match = /^([^:]+):(.+)$/.exec(path);
      if (match && match[1] !== this.id)
        throw new CompatibilityError("Morph", `sync with another instance (${match[1]})`);
      return match ? match[2]! : undefined;
    };
    const [from, to] = [side(source), side(dest)];
    if ((from === undefined) === (to === undefined))
      throw new Error("Exactly one of source and dest must be <instance id>:<path>");
    if (options.verbose) console.log(`[INFO] Syncing ${source} to ${dest}`);
    await api(() =>
      to !== undefined
        ? this.#native.files.upload(source, to)
        : this.#native.files.download(from!, dest),
    );
  }
}
refuse("Morph", "Instance", Instance, {
  ssh: SSH,
  sshKey: SSH,
  sshKeyRotate: SSH,
  reboot: "restart its programs with sandbox.native.resize, or start a fresh copy from a snapshot",
  setTTL:
    "give ttlSeconds and ttlAction to instances.start or boot; sandbox.native.extend(seconds) adds time",
});

async function previewsOf(sandbox: Sandbox): Promise<Preview[]> {
  if (!Object.keys(labelsOf(sandbox.info)).some((key) => key.startsWith(HTTP_LABEL))) return [];
  return sandbox.previews.list();
}

// Client --------------------------------------------------------------------------

/** Morph's client, on Runtime. `new MorphCloudClient()` reads RUNTIME_API_KEY
 * (or a saved login), never MORPH_API_KEY. */
export class MorphCloudClient {
  readonly runtime: Runtime;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly verbose: boolean;
  declare readonly GET: RefusedAsync;
  declare readonly POST: RefusedAsync;
  declare readonly streamPOST: RefusedAsync;
  declare readonly DELETE: RefusedAsync;
  constructor(options: MorphCloudClientOptions = {}) {
    const { verbose, ...rest } = options;
    this.runtime = client(rest);
    this.baseUrl = this.runtime.transport.baseUrl;
    this.apiKey = "";
    this.verbose = verbose ?? false;
  }

  images = {
    /** Morph's base image, which is Runtime's default image. Build others with runtime.images. */
    list: async (_options: ImageListOptions = {}): Promise<Image[]> => [
      new Image(MORPH_DEFAULT_IMAGE, MORPH_DEFAULT_IMAGE, 4096, 0, "Runtime's default image"),
    ],
  };

  snapshots = {
    list: async (options: SnapshotListOptions = {}): Promise<Snapshot[]> => {
      only("Morph snapshots.list", options, ["digest", "metadata"]);
      const want = options.metadata ?? {};
      const page = await api(() =>
        this.runtime.snapshots.list(options.digest ? { name: digestName(options.digest) } : {}),
      );
      const found: Snapshot[] = [];
      for await (const native of page) {
        if (native.state === "deleting" || native.state === "failed") continue;
        const labels = labelsOf(native);
        if (options.digest && labels[DIGEST_LABEL] !== options.digest) continue;
        if (Object.entries(want).some(([k, v]) => labels[k] !== String(v))) continue;
        found.push(new Snapshot(native, this));
      }
      return found;
    },
    /** A bootable snapshot of an image at a size: Runtime boots a sandbox from
     * the image, snapshots its disk and stops it. With a digest, a snapshot
     * already made with it is answered instead. */
    create: async (options: SnapshotCreateOptions = {}): Promise<Snapshot> => {
      only("Morph snapshots.create", options, [
        "imageId",
        "vcpus",
        "memory",
        "diskSize",
        "digest",
        "metadata",
      ]);
      const metadata = checkMetadata(options.metadata);
      if (options.digest) {
        const cached = await this.snapshots.list({ digest: options.digest });
        if (cached.length > 0) return cached[0]!;
      }
      const image = imageOf(options.imageId);
      const sandbox = await api(() =>
        this.runtime.sandboxes.create({
          ...(image === undefined ? {} : { image }),
          ...(options.vcpus === undefined ? {} : { vcpu: options.vcpus }),
          ...(options.memory === undefined ? {} : { memoryMiB: options.memory }),
          ...(options.diskSize === undefined ? {} : { diskMiB: options.diskSize }),
          labels: { "compat.provider": PROVIDER },
        }),
      );
      try {
        const native = await api(() =>
          sandbox.snapshot({
            mode: "disk",
            ...(options.digest ? { name: digestName(options.digest) } : {}),
            labels: {
              ...metadata,
              [IMAGE_LABEL]: options.imageId ?? MORPH_DEFAULT_IMAGE,
              ...(options.digest ? { [DIGEST_LABEL]: options.digest } : {}),
            },
          }),
        );
        return new Snapshot(native, this);
      } finally {
        // The snapshot stays when its source is deleted.
        await sandbox.delete();
      }
    },
    get: async (options: SnapshotGetOptions): Promise<Snapshot> =>
      new Snapshot(await api(() => this.runtime.snapshots.get(options.snapshotId)), this),
  };

  instances = {
    /** Running and paused instances whose metadata match. */
    list: async (options: InstanceListOptions = {}): Promise<Instance[]> => {
      only("Morph instances.list", options, ["metadata"]);
      const labels = Object.fromEntries(
        Object.entries(options.metadata ?? {}).map(([k, v]) => [k, String(v)]),
      );
      const page = await api(() =>
        this.runtime.sandboxes.list(Object.keys(labels).length ? { labels } : {}),
      );
      const found: Instance[] = [];
      for await (const sandbox of page)
        found.push(new Instance(sandbox, this, await previewsOf(sandbox)));
      return found;
    },
    /** A running copy of a snapshot: files, and memory and processes when the
     * snapshot kept them. */
    start: async (options: InstanceStartOptions): Promise<Instance> => {
      only("Morph instances.start", options, [
        "snapshotId",
        "metadata",
        "ttlSeconds",
        "ttlAction",
        "timeout",
      ]);
      const metadata = checkMetadata(options.metadata);
      const ttl = ttlOf(options.ttlSeconds, options.ttlAction);
      const snapshot = await api(() => this.runtime.snapshots.get(options.snapshotId));
      const image = labelsOf(snapshot)[IMAGE_LABEL];
      const sandbox = await api(() =>
        this.runtime.sandboxes.create(
          {
            snapshot: options.snapshotId,
            ...ttl,
            labels: {
              ...metadata,
              "compat.provider": PROVIDER,
              ...(image === undefined ? {} : { [IMAGE_LABEL]: image }),
            },
          },
          options.timeout === undefined ? {} : { timeoutMs: Math.ceil(options.timeout * 1000) },
        ),
      );
      const instance = new Instance(sandbox, this);
      Object.assign(instance.refs, { snapshotId: options.snapshotId });
      return instance;
    },
    /** As start; a different vcpus or memory restarts it at that size (its
     * files kept, its programs started afresh). The disk keeps the snapshot's size. */
    boot: async (options: InstanceBootOptions): Promise<Instance> => {
      only("Morph instances.boot", options, [
        "snapshotId",
        "vcpus",
        "memory",
        "diskSize",
        "metadata",
        "ttlSeconds",
        "ttlAction",
      ]);
      const instance = await this.instances.start({
        snapshotId: options.snapshotId,
        metadata: options.metadata,
        ttlSeconds: options.ttlSeconds,
        ttlAction: options.ttlAction,
      });
      if (options.diskSize !== undefined && options.diskSize !== instance.spec.diskSize) {
        await instance.stop();
        throw new CompatibilityError(
          "Morph",
          "boot with another diskSize; snapshot a sandbox created with that diskMiB",
        );
      }
      const size = {
        ...(options.vcpus !== undefined && options.vcpus !== instance.spec.vcpus
          ? { vcpu: options.vcpus }
          : {}),
        ...(options.memory !== undefined && options.memory !== instance.spec.memory
          ? { memoryMiB: options.memory }
          : {}),
      };
      if (Object.keys(size).length === 0) return instance;
      try {
        const sandbox = await api(() => instance.native.resize(size));
        const resized = new Instance(sandbox, this);
        Object.assign(resized.refs, { snapshotId: options.snapshotId });
        return resized;
      } catch (error) {
        await instance.stop();
        throw error;
      }
    },
    get: async (options: InstanceGetOptions): Promise<Instance> => {
      const sandbox = await api(() => this.runtime.sandboxes.get(options.instanceId));
      return new Instance(sandbox, this, await previewsOf(sandbox));
    },
    /** Deletes it, with its disk and memory, as Morph's stop does; its snapshots stay. */
    stop: async (options: InstanceStopOptions): Promise<void> => {
      await api(() => this.runtime.sandboxes.delete(options.instanceId));
    },
  };
}
refuse("Morph", "MorphCloudClient", MorphCloudClient, {
  GET: "call Runtime's API with its own client (new Runtime())",
  POST: "call Runtime's API with its own client (new Runtime())",
  streamPOST: "call Runtime's API with its own client (new Runtime())",
  DELETE: "call Runtime's API with its own client (new Runtime())",
});
