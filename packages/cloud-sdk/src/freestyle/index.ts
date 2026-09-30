import type { Runtime } from "../client.js";
import type { Sandbox } from "../sandbox.js";
import type { Snapshot } from "../snapshots.js";
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
  type ClientOptions,
} from "../compat/core.js";
import { GuestFiles } from "../compat/files.js";
export { CompatibilityError };
export type VmState = "starting" | "running" | "pausing" | "paused" | "stopped";
export interface FirewallRule {
  action: "allow";
  source: Record<string, never>;
  destination: { public: true };
}
export interface CreateVmOptions {
  snapshotId?: string | null;
  slug?: string | null;
  displayName?: string | null;
  idleTimeoutSeconds?: number | null;
  metadata?: Record<string, string>;
  firewall: { rules: FirewallRule[] };
}
export interface ExecOptions {
  command: string;
  linuxUser?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string;
}
const data = (s: Sandbox) => ({
  id: s.id,
  state: s.state,
  slug: s.info.name,
  displayName: s.info.labels["fs.displayName"] ?? null,
  resources: { cpu: s.info.vcpu, memory: s.info.memoryMiB, storage: s.info.diskMiB },
  metadata: Object.fromEntries(
    Object.entries(s.info.labels).filter(
      ([k]) => !["compat.provider", "fs.displayName"].includes(k),
    ),
  ),
  idleTimeoutSeconds: s.info.idlePauseSeconds === 0 ? -1 : s.info.idlePauseSeconds,
  vpcs: [],
  networks: [],
  createdAt: s.info.createdAt,
  updatedAt: s.info.createdAt,
});
const snapshotData = (s: Snapshot) => ({
  id: s.id,
  sourceVmId: s.sourceSandboxId,
  slug: s.name,
  public: false,
  createdAt: s.createdAt,
  updatedAt: s.createdAt,
  ttlSeconds: s.retentionDays * 86400,
});
export class Freestyle {
  readonly vms: VmsNamespace;
  constructor(options: ClientOptions = {}) {
    this.vms = new VmsNamespace(client(options));
  }
}
export class VmsNamespace {
  readonly snapshots;
  constructor(private readonly runtime: Runtime) {
    this.snapshots = {
      get: async (id: string) => snapshotData(await this.resolveSnapshot(id)),
      delete: async (id: string) => runtime.snapshots.delete((await this.resolveSnapshot(id)).id),
      list: async () => ({
        snapshots: (await (await runtime.snapshots.list()).toArray()).map(snapshotData),
      }),
    };
  }
  private async resolveSnapshot(id: string) {
    if (/^[a-f0-9-]{36}$/i.test(id)) return this.runtime.snapshots.get(id);
    const found = (await this.runtime.snapshots.list({ name: id })).data.find((s) => s.name === id);
    if (!found)
      throw new CompatibilityError(
        "Freestyle",
        `snapshot ${id}; import the source environment into Runtime first`,
      );
    return found;
  }
  async create(options: CreateVmOptions) {
    only("Freestyle create", options, [
      "snapshotId",
      "slug",
      "displayName",
      "idleTimeoutSeconds",
      "metadata",
      "firewall",
    ]);
    if (!options.firewall || !Array.isArray(options.firewall.rules))
      throw new TypeError("firewall.rules is required");
    only("Freestyle firewall", options.firewall, ["rules"]);
    for (const r of options.firewall.rules) {
      only("Freestyle firewall rule", r, ["action", "source", "destination"]);
      if (
        r.action !== "allow" ||
        Object.keys(r.source).length ||
        Object.keys(r.destination).length !== 1 ||
        r.destination.public !== true
      )
        throw new CompatibilityError(
          "Freestyle",
          "firewall rules other than unrestricted outbound public access",
        );
    }
    const snapshot = options.snapshotId
      ? (await this.resolveSnapshot(options.snapshotId)).id
      : undefined;
    const s = await create(this.runtime, "freestyle", {
      snapshot,
      name: options.slug ?? undefined,
      labels: { ...options.metadata, "fs.displayName": options.displayName ?? "" },
      persistent: true,
      idlePauseSeconds:
        options.idleTimeoutSeconds === -1 || options.idleTimeoutSeconds == null
          ? 0
          : options.idleTimeoutSeconds,
      network: { internet: options.firewall.rules.length > 0 },
    });
    return {
      vm: new Vm(this.runtime, s.id),
      vmId: s.id,
      data: data(s),
      firewallRules: options.firewall.rules.map((rule) => ({
        ...rule,
        id: `runtime-network-${s.id}`,
        source: { vmId: s.id },
      })),
      tlsRules: [],
    };
  }
  ref(id: string) {
    return new Vm(this.runtime, id);
  }
  async get(id: string) {
    return data(await lookup(this.runtime, id));
  }
  async delete(id: string) {
    await destroy(await lookup(this.runtime, id));
  }
  async list(
    options: {
      state?: string;
      slug?: string;
      metadata?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    only("Freestyle list", options, ["state", "slug", "metadata", "limit", "offset"]);
    const filters =
      options.metadata?.split(",").map((x) => {
        const i = x.indexOf(":");
        return [x.slice(0, i), x.slice(i + 1)];
      }) ?? [];
    const values = (await all(this.runtime, "freestyle")).filter(
      (s) =>
        (!options.state || s.state === options.state) &&
        (!options.slug || s.info.name === options.slug) &&
        filters.every(([k, v]) => s.info.labels[k!] === v),
    );
    return {
      vms: values
        .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100))
        .map(data),
      totalCount: values.length,
      runningCount: values.filter((s) => s.state === "running").length,
      startingCount: values.filter((s) => s.state === "starting").length,
      pausingCount: values.filter((s) => s.state === "pausing").length,
      pausedCount: values.filter((s) => s.state === "paused").length,
      stoppedCount: values.filter((s) => s.state === "stopped").length,
    };
  }
}
export interface ReadFileOptions {
  offset?: number;
  length?: number;
  signal?: AbortSignal;
}
export interface WriteFileOptions {
  mode?: number;
  signal?: AbortSignal;
  chunkSize?: number;
  maxAttempts?: number;
  onProgress?: (progress: { completedBytes: number; totalBytes: number }) => void;
}
export class VmFilesystem {
  private readonly files: GuestFiles;
  constructor(private readonly get: () => Promise<Sandbox>) {
    this.files = new GuestFiles(get, "/");
  }
  async readFile(path: string, options: ReadFileOptions = {}) {
    return new Uint8Array(
      await new Response(await this.readFileStream(path, options)).arrayBuffer(),
    );
  }
  async readTextFile(path: string, options: ReadFileOptions = {}) {
    return new TextDecoder().decode(await this.readFile(path, options));
  }
  async readFileStream(path: string, options: ReadFileOptions = {}) {
    only("Freestyle file read", options, ["offset", "length", "signal"]);
    for (const value of [options.offset, options.length])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new TypeError("File range must contain nonnegative safe integers");
    options.signal?.throwIfAborted();
    const source = await (
      await this.get()
    ).files.readStream(this.files.path(path), { signal: options.signal });
    if (options.offset === undefined && options.length === undefined) return source;
    const reader = source.getReader();
    let skip = options.offset ?? 0,
      remaining = options.length ?? Infinity;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          options.signal?.throwIfAborted();
          if (!remaining) {
            await reader.cancel();
            controller.close();
            return;
          }
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            const start = Math.min(skip, next.value.length);
            skip -= start;
            const chunk = next.value.subarray(start, start + remaining);
            if (chunk.length) {
              remaining -= chunk.length;
              controller.enqueue(chunk);
              return;
            }
          }
        } catch (error) {
          await reader.cancel(error);
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }
  async writeFile(
    path: string,
    content: string | Uint8Array | Blob,
    options: WriteFileOptions = {},
  ) {
    only("Freestyle file write", options, [
      "mode",
      "onProgress",
      "signal",
      "chunkSize",
      "maxAttempts",
    ]);
    if (options.chunkSize !== undefined || options.maxAttempts !== undefined)
      throw new CompatibilityError("Freestyle", "custom upload chunk sizing/retry budgets");
    options.signal?.throwIfAborted();
    const bytes =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : content instanceof Uint8Array
          ? content
          : new Uint8Array(await content.arrayBuffer());
    let mode = options.mode;
    if (mode === undefined)
      mode = (await this.files.exists(path))
        ? parseInt((await this.files.stat(path)).mode, 8)
        : 0o600;
    await this.files.writeFile(path, bytes, { mode, signal: options.signal });
    options.onProgress?.({ completedBytes: bytes.length, totalBytes: bytes.length });
  }
  writeTextFile(path: string, content: string, options: WriteFileOptions = {}) {
    return this.writeFile(path, content, options);
  }
  mkdir(path: string) {
    return this.files.mkdir(path, true);
  }
  remove(path: string) {
    return this.files.remove(path, true);
  }
  exists(path: string) {
    return this.files.exists(path);
  }
  async readDir(path: string) {
    return (await this.files.readdir(path)).map((e) => ({ name: e.name, kind: e.type }));
  }
  async stat(path: string) {
    const e = await this.files.stat(path);
    const s = await this.get();
    const r = await s.exec(["stat", "-c", "%U:%G", "--", this.files.path(path)], { check: true });
    const [owner, group] = r.stdout.trim().split(":");
    return {
      size: e.size,
      isFile: e.type === "file",
      isDirectory: e.type === "directory",
      isSymlink: e.type === "symlink",
      permissions: e.mode,
      owner: owner!,
      group: group!,
      modified: e.modifiedAt,
    };
  }
}
export class Vm {
  readonly fs: VmFilesystem;
  constructor(
    private readonly runtime: Runtime,
    readonly id: string,
  ) {
    this.fs = new VmFilesystem(() => lookup(runtime, id));
  }
  async data() {
    return data(await lookup(this.runtime, this.id));
  }
  async start() {
    return data(await ready(await lookup(this.runtime, this.id)));
  }
  async pause() {
    const s = await lookup(this.runtime, this.id);
    await s.pause();
    return data(s);
  }
  async delete() {
    await destroy(await lookup(this.runtime, this.id));
  }
  async update(options: {
    slug?: string;
    displayName?: string;
    idleTimeoutSeconds?: number;
    metadata?: Record<string, string>;
  }) {
    only("Freestyle update", options, ["slug", "displayName", "idleTimeoutSeconds", "metadata"]);
    const s = await lookup(this.runtime, this.id);
    await s.update({
      name: options.slug,
      idlePauseSeconds: options.idleTimeoutSeconds === -1 ? 0 : options.idleTimeoutSeconds,
      labels: {
        ...s.info.labels,
        ...options.metadata,
        ...(options.displayName === undefined ? {} : { "fs.displayName": options.displayName }),
      },
    });
    return data(s);
  }
  async exec(options: string | ExecOptions) {
    const o = typeof options === "string" ? { command: options } : options;
    only("Freestyle exec", o, ["command", "linuxUser", "timeoutMs", "env", "stdin"]);
    if (o.linuxUser) throw new CompatibilityError("Freestyle", "exec as a different Linux user");
    const s = await lookup(this.runtime, this.id);
    const r = await s.exec(
      o.command,
      await execOptions(s, {
        onStdout: () => undefined,
        onStderr: () => undefined,
        timeoutMs: o.timeoutMs,
        env: o.env,
        stdin:
          o.stdin === undefined
            ? undefined
            : Uint8Array.from(atob(o.stdin), (c) => c.charCodeAt(0)),
      }),
    );
    return { stdout: r.stdout, stderr: r.stderr, statusCode: r.timedOut ? null : r.exitCode };
  }
  async snapshot(options: { slug?: string; displayName?: string; ttlSeconds?: number } = {}) {
    only("Freestyle snapshot", options, ["slug", "displayName", "ttlSeconds"]);
    if (
      options.ttlSeconds !== undefined &&
      (options.ttlSeconds <= 0 || options.ttlSeconds % 86400 !== 0)
    )
      throw new CompatibilityError(
        "Freestyle",
        "snapshot retention other than whole positive days",
      );
    const s = await (
      await lookup(this.runtime, this.id)
    ).snapshot({
      name: options.slug,
      labels: options.displayName ? { "fs.displayName": options.displayName } : undefined,
      retentionDays: options.ttlSeconds === undefined ? undefined : options.ttlSeconds / 86400,
    });
    return { snapshotId: s.id, sourceVmId: s.sourceSandboxId, snapshot: snapshotData(s) };
  }
}
