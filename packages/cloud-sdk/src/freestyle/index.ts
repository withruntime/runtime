import type { Runtime } from "../client.js";
import { ConnectionError, RuntimeError } from "../errors.js";
import type { Sandbox, Terminal } from "../sandbox.js";
import type { Snapshot } from "../snapshots.js";
import type { ProcessInfo } from "../types.js";
import {
  all,
  client,
  CompatibilityError,
  create,
  destroy,
  execOptions,
  lookup,
  only,
  quote,
  ready,
  refuse,
  refused,
  validateEnvironment,
  type ClientOptions,
  type Refused,
  type RefusedAsync,
} from "../compat/core.js";
import { GuestFiles } from "../compat/files.js";
export { CompatibilityError };
export type VmState = "starting" | "running" | "pausing" | "paused" | "stopped";

// Errors ----------------------------------------------------------------------

export interface FreestyleErrorBody {
  code: string;
  message: string;
}
/** What every failed Runtime call becomes, as Freestyle throws it for a
 * non-2xx response: `code` is Runtime's error code in upper case
 * (`NOT_FOUND`), `status` its HTTP status, and `cause` the RuntimeError. */
export class FreestyleApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly path?: string;
  constructor(status: number, body: FreestyleErrorBody, path?: string) {
    super(body.message || `Freestyle API error: ${body.code}`);
    this.name = "FreestyleApiError";
    this.code = body.code;
    this.status = status;
    this.path = path;
  }
}
export interface FreestyleConnectionError {
  name?: string;
  message?: string;
  code?: string;
  errno?: string | number;
  syscall?: string;
  address?: string;
  port?: number;
}
/** What a call that got no answer from Runtime becomes, as Freestyle 0.2.17
 * throws a failed fetch: a TypeError whose `cause` is the RuntimeError
 * ConnectionError and whose `errors` carry it as one entry. */
export class FreestyleTransportError extends TypeError {
  readonly errors: FreestyleConnectionError[];
  constructor(cause: unknown, errors: FreestyleConnectionError[]) {
    super(
      `${cause instanceof Error ? cause.message : "fetch failed"} (${errors.map((e) => e.code ?? e.name ?? "Error").join("; ")})`,
      { cause },
    );
    this.name = "FreestyleTransportError";
    this.errors = errors;
  }
  toJSON() {
    return { name: this.name, message: this.message, errors: this.errors };
  }
}
/** A Runtime error as Freestyle's client throws it. */
function translate(error: unknown): unknown {
  if (error instanceof ConnectionError)
    return new FreestyleTransportError(error, [
      { name: error.name, message: error.message, code: error.code },
    ]);
  if (!(error instanceof RuntimeError)) return error;
  const translated = new FreestyleApiError(error.status, {
    code: error.code.toUpperCase(),
    message: error.message,
  });
  Object.defineProperty(translated, "cause", { value: error });
  return translated;
}
async function api<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw translate(error);
  }
}
const notFound = (what: string) =>
  new FreestyleApiError(404, { code: "NOT_FOUND", message: `${what} not found` });
export class FirewallRuleValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "FirewallRuleValidationError";
  }
}
export class TlsRuleValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "TlsRuleValidationError";
  }
}
export class TlsForwardAuthValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "TlsForwardAuthValidationError";
  }
}

// Freestyle products Runtime does not sell as they are --------------------------

const FIREWALL =
  "give a VM's outbound rules at create (firewall.rules to public or CIDR destinations), or use sandbox.network";
const TLS = "serve HTTPS from a sandbox with Runtime previews (sandbox.previews)";
const TUNNELS = "reach a sandbox's ports with sandbox.tunnel()";
const VPC =
  "let sandboxes reach each other with Runtime private networks (runtime.networks.private)";
export const FirewallNamespace: Refused = refused("Freestyle", "FirewallNamespace", FIREWALL);
export const FirewallRulesNamespace: Refused = refused(
  "Freestyle",
  "FirewallRulesNamespace",
  FIREWALL,
);
export const validateFirewallEndpoint: Refused = refused(
  "Freestyle",
  "validateFirewallEndpoint",
  FIREWALL,
);
export const validateFirewallRule: Refused = refused("Freestyle", "validateFirewallRule", FIREWALL);
export const validateFirewallSpec: Refused = refused("Freestyle", "validateFirewallSpec", FIREWALL);
export const TlsNamespace: Refused = refused("Freestyle", "TlsNamespace", TLS);
export const TlsRulesNamespace: Refused = refused("Freestyle", "TlsRulesNamespace", TLS);
export const TlsForwardAuthNamespace: Refused = refused(
  "Freestyle",
  "TlsForwardAuthNamespace",
  TLS,
);
export const hasTlsIdentity: Refused = refused("Freestyle", "hasTlsIdentity", TLS);
export const resolveTlsProtocol: Refused = refused("Freestyle", "resolveTlsProtocol", TLS);
export const validateTlsDomain: Refused = refused("Freestyle", "validateTlsDomain", TLS);
export const validateTlsEndpoint: Refused = refused("Freestyle", "validateTlsEndpoint", TLS);
export const validateTlsForwardAuth: Refused = refused("Freestyle", "validateTlsForwardAuth", TLS);
export const validateTlsMailRoute: Refused = refused("Freestyle", "validateTlsMailRoute", TLS);
export const validateTlsRule: Refused = refused("Freestyle", "validateTlsRule", TLS);
export const validateTlsSpec: Refused = refused("Freestyle", "validateTlsSpec", TLS);
export const TunnelsNamespace: Refused = refused("Freestyle", "TunnelsNamespace", TUNNELS);
export const VpcNamespace: Refused = refused("Freestyle", "VpcNamespace", VPC);
export const Vpc: Refused = refused("Freestyle", "Vpc", VPC);
export const VpcTunnelNamespace: Refused = refused("Freestyle", "VpcTunnelNamespace", VPC);

// Firewall rules a VM's network settings can carry -------------------------------

export type FirewallProtocol = "tcp" | "udp" | "icmp";
export interface FirewallEndpoint {
  vmId?: string;
  vpcId?: string;
  tunnelId?: string;
  cidr?: string;
  public?: true;
  port?: number;
  protocol?: FirewallProtocol;
}
export interface FirewallRule {
  action: "allow";
  source: FirewallEndpoint;
  destination: FirewallEndpoint;
  description?: string;
}
export interface FirewallRuleData {
  id: string;
  action: "allow";
  source: FirewallEndpoint;
  destination: FirewallEndpoint;
  description?: string | null;
  dependencies: { kind: string; id: string; slug?: string | null; displayName?: string | null }[];
  createdAt: string;
  updatedAt: string;
}
const ADDRESS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
/** An IPv4 address or CIDR, as Runtime's network allow list takes it. */
function cidrOf(value: string): string | undefined {
  const match = ADDRESS.exec(value);
  if (!match || match.slice(1, 5).some((octet) => Number(octet) > 255)) return undefined;
  if (match[5] !== undefined && Number(match[5]) > 32) return undefined;
  return match[5] === undefined ? `${value}/32` : value;
}
/** The network settings for a VM's inline rules: every rule allows this VM
 * outbound, to the public internet or to a CIDR, over the web ports Runtime
 * opens (any, 80 or 443 over TCP). Runtime opens 80 and 443 together, so a
 * destination named with one port alone refuses rather than gets the other.
 * Anything else refuses before allocation. */
function networkFor(rules: FirewallRule[]): { internet: boolean; allow?: string[] } {
  const allow: string[] = [];
  let open = false;
  const ports = new Map<string, Set<number | undefined>>();
  for (const [index, rule] of rules.entries()) {
    only("Freestyle firewall rule", rule, ["action", "source", "destination", "description"]);
    const { destination } = rule;
    if (rule.action !== "allow" || Object.keys(rule.source ?? {}).length)
      throw new CompatibilityError(
        "Freestyle",
        `firewall.rules[${index}]: rules other than this VM's outbound access`,
      );
    only("Freestyle firewall destination", destination ?? {}, [
      "public",
      "cidr",
      "port",
      "protocol",
    ]);
    if (
      (destination.port !== undefined && destination.port !== 80 && destination.port !== 443) ||
      (destination.protocol !== undefined && destination.protocol !== "tcp") ||
      (destination.port !== undefined && destination.protocol === undefined)
    )
      throw new CompatibilityError(
        "Freestyle",
        `firewall.rules[${index}]: ports other than 80 and 443 over TCP; open host:port pairs with sandbox.network.set({ connect })`,
      );
    let target = "public";
    if (destination.public === true && destination.cidr === undefined) open = true;
    else if (destination.public === undefined && typeof destination.cidr === "string") {
      const cidr = cidrOf(destination.cidr);
      if (!cidr)
        throw new FirewallRuleValidationError(
          `firewall.rules[${index}].destination.cidr`,
          `firewall.rules[${index}].destination.cidr \`${destination.cidr}\` is not an IPv4 CIDR`,
        );
      if (!allow.includes(cidr)) allow.push(cidr);
      target = cidr;
    } else
      throw new CompatibilityError(
        "Freestyle",
        `firewall.rules[${index}]: destinations other than public or one CIDR`,
      );
    ports.set(target, (ports.get(target) ?? new Set()).add(destination.port));
  }
  for (const [target, named] of ports)
    if (!named.has(undefined) && !(named.has(80) && named.has(443)))
      throw new CompatibilityError(
        "Freestyle",
        `firewall rules opening ${target} on port ${[...named].join(" or ")} alone; Runtime opens 80 and 443 together`,
      );
  if (open) return { internet: true };
  if (allow.length) return { internet: true, allow };
  return { internet: false };
}
function ruleData(vmId: string, index: number, destination: FirewallEndpoint, at: string) {
  return {
    id: `runtime-network-${vmId}-${index}`,
    action: "allow" as const,
    source: { vmId },
    destination,
    description: null,
    dependencies: [],
    createdAt: at,
    updatedAt: at,
  } satisfies FirewallRuleData;
}

// VMs -------------------------------------------------------------------------

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
function validateMetadata(metadata: Record<string, string> | undefined) {
  for (const key of ["compat.provider", "fs.displayName"])
    if (metadata !== undefined && Object.prototype.hasOwnProperty.call(metadata, key))
      throw new CompatibilityError("Freestyle", `metadata key ${key} reserved by this adapter`);
}
const LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
function validateLinuxUser(user: string): string {
  if (typeof user !== "string" || !LINUX_USER.test(user))
    throw new TypeError("linuxUser must be a Linux user name: lowercase letters, digits, _ and -");
  return user;
}
/** Runs `command` as `user` through sudo. The environment travels in the
 * exec's own environment and sudo keeps it by name: values never enter the
 * command line, which the process list and Runtime's records show. */
function asUser(user: string, command: string, env: Record<string, string> = {}) {
  validateEnvironment(env);
  const names = Object.keys(env);
  const keep = names.length ? ` --preserve-env=${names.join(",")}` : "";
  return `exec sudo -n -H${keep} -u ${quote(user)} -- bash -c ${quote(command)}`;
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
/** Labels the snapshot API returns beside the typed fields. */
const labelsOf = (s: Snapshot) =>
  (s as Snapshot & { labels?: Record<string, string> }).labels ?? {};
const snapshotData = (s: Snapshot) => ({
  id: s.id,
  sourceVmId: s.sourceSandboxId,
  slug: s.name,
  displayName: labelsOf(s)["fs.displayName"] ?? null,
  public: false,
  createdAt: s.createdAt,
  updatedAt: s.createdAt,
  ttlSeconds: s.retentionDays === null ? null : s.retentionDays * 86400,
});
/** Freestyle keeps a snapshot for a time in seconds; Runtime for whole days. */
function retentionDays(ttlSeconds: number | undefined): number | undefined {
  if (ttlSeconds === undefined) return undefined;
  if (
    !(ttlSeconds > 0) ||
    ttlSeconds > 365 * 86400 ||
    ttlSeconds % 86400 !== 0 ||
    !Number.isFinite(ttlSeconds)
  )
    throw new CompatibilityError("Freestyle", "snapshot retention outside 1 to 365 whole days");
  return ttlSeconds / 86400;
}

export interface FreestyleOptions extends ClientOptions {
  teamId?: string;
  stackAccessToken?: string;
  identityAccessToken?: string;
}
export class Freestyle {
  readonly vms: VmsNamespace;
  declare readonly fetch: RefusedAsync;
  constructor(options: FreestyleOptions = {}) {
    const { teamId, stackAccessToken, identityAccessToken, ...rest } = options;
    if (teamId !== undefined)
      throw new CompatibilityError("Freestyle", "teamId; a Runtime API key is its organization's");
    if (stackAccessToken !== undefined || identityAccessToken !== undefined)
      throw new CompatibilityError(
        "Freestyle",
        "stackAccessToken and identityAccessToken; sign in with a Runtime API key",
      );
    this.vms = new VmsNamespace(client(rest));
  }
  get firewall(): never {
    throw new CompatibilityError("Freestyle", `freestyle.firewall; ${FIREWALL}`);
  }
  get tls(): never {
    throw new CompatibilityError("Freestyle", `freestyle.tls; ${TLS}`);
  }
  get tunnels(): never {
    throw new CompatibilityError("Freestyle", `freestyle.tunnels; ${TUNNELS}`);
  }
  get vpc(): never {
    throw new CompatibilityError("Freestyle", `freestyle.vpc; ${VPC}`);
  }
}
refuse("Freestyle", "Freestyle", Freestyle, {
  fetch: "call Runtime's API with its own client (new Runtime())",
});

export class VmSnapshotsNamespace {
  constructor(private readonly runtime: Runtime) {}
  /** A snapshot by id or by its slug (Runtime's snapshot name). */
  async resolve(id: string): Promise<Snapshot> {
    if (/^[a-f0-9-]{36}$/i.test(id)) return this.runtime.snapshots.get(id);
    const found = (await this.runtime.snapshots.list({ name: id })).data.find((s) => s.name === id);
    if (!found)
      throw new CompatibilityError(
        "Freestyle",
        `snapshot ${id}; import the source environment into Runtime first`,
      );
    return found;
  }
  get(snapshotId: string) {
    return api(async () => snapshotData(await this.resolve(snapshotId)));
  }
  delete(snapshotId: string) {
    return api(async () => this.runtime.snapshots.delete((await this.resolve(snapshotId)).id));
  }
  async list(options: { sourceVmId?: string; limit?: number; offset?: number } = {}) {
    only("Freestyle snapshot list", options, ["sourceVmId", "limit", "offset"]);
    if (options.sourceVmId !== undefined && typeof options.sourceVmId !== "string")
      throw new TypeError("sourceVmId must be a string");
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0))
      throw new TypeError("limit must be a positive safe integer");
    if (
      options.offset !== undefined &&
      (!Number.isSafeInteger(options.offset) || options.offset < 0)
    )
      throw new TypeError("offset must be a nonnegative safe integer");
    return api(async () => {
      const offset = options.offset ?? 0;
      const snapshots: ReturnType<typeof snapshotData>[] = [];
      let totalCount = 0;
      // Count the filtered catalog across every native page without retaining
      // snapshots outside the requested page or Page.toArray's default cap.
      const page = await this.runtime.snapshots.list(
        options.sourceVmId === undefined ? {} : { sandboxId: options.sourceVmId },
      );
      for await (const snapshot of page) {
        if (options.sourceVmId !== undefined && snapshot.sourceSandboxId !== options.sourceVmId)
          continue;
        if (
          totalCount >= offset &&
          (options.limit === undefined || snapshots.length < options.limit)
        )
          snapshots.push(snapshotData(snapshot));
        totalCount++;
      }
      return { snapshots, totalCount };
    });
  }
  /** Renames, relabels and re-times a snapshot: slug is its Runtime name,
   * ttlSeconds whole days from now. */
  async update(
    snapshotId: string,
    options: { slug?: string; displayName?: string; ttlSeconds?: number },
  ) {
    only("Freestyle snapshot update", options, ["slug", "displayName", "ttlSeconds"]);
    const days = retentionDays(options.ttlSeconds);
    if (options.slug !== undefined && (typeof options.slug !== "string" || !options.slug))
      throw new TypeError("slug must be a nonempty string");
    if (options.displayName !== undefined && typeof options.displayName !== "string")
      throw new TypeError("displayName must be a string");
    return api(async () => {
      let snapshot = await this.resolve(snapshotId);
      if (options.slug !== undefined || options.displayName !== undefined)
        snapshot = await this.runtime.snapshots.update(snapshot.id, {
          ...(options.slug === undefined ? {} : { name: options.slug }),
          ...(options.displayName === undefined
            ? {}
            : { labels: { ...labelsOf(snapshot), "fs.displayName": options.displayName } }),
        });
      if (days !== undefined) snapshot = await this.runtime.snapshots.extend(snapshot.id, days);
      return snapshotData(snapshot);
    });
  }
}

export class VmsNamespace {
  readonly snapshots: VmSnapshotsNamespace;
  constructor(private readonly runtime: Runtime) {
    this.snapshots = new VmSnapshotsNamespace(runtime);
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
    validateMetadata(options.metadata);
    if (!options.firewall || !Array.isArray(options.firewall.rules))
      throw new TypeError("firewall.rules is required");
    only("Freestyle firewall", options.firewall, ["rules"]);
    const network = networkFor(options.firewall.rules);
    return api(async () => {
      const snapshot = options.snapshotId
        ? (await this.snapshots.resolve(options.snapshotId)).id
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
        network,
      });
      return {
        vm: new Vm(this.runtime, s.id),
        vmId: s.id,
        data: data(s),
        firewallRules: options.firewall.rules.map((rule, index) =>
          ruleData(s.id, index, rule.destination, s.info.createdAt),
        ),
        tlsRules: [],
      };
    });
  }
  ref(id: string) {
    return new Vm(this.runtime, id);
  }
  get(id: string) {
    return api(async () => data(await lookup(this.runtime, id)));
  }
  delete(id: string) {
    return api(async () => destroy(await lookup(this.runtime, id)));
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
    const values = (await api(() => all(this.runtime, "freestyle"))).filter(
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

// Files -----------------------------------------------------------------------

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
    const stream = await this.readFileStream(path, options);
    return api(async () => new Uint8Array(await new Response(stream).arrayBuffer()));
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
    const source = await api(async () =>
      (await this.get()).files.readStream(this.files.path(path), { signal: options.signal }),
    );
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
    await api(async () => {
      let mode = options.mode;
      if (mode === undefined)
        mode = (await this.files.exists(path))
          ? parseInt((await this.files.stat(path)).mode, 8)
          : 0o600;
      await this.files.writeFile(path, bytes, { mode, signal: options.signal });
    });
    options.onProgress?.({ completedBytes: bytes.length, totalBytes: bytes.length });
  }
  writeTextFile(path: string, content: string, options: WriteFileOptions = {}) {
    return this.writeFile(path, content, options);
  }
  mkdir(path: string) {
    return api(() => this.files.mkdir(path, true));
  }
  remove(path: string) {
    return api(() => this.files.remove(path, true));
  }
  exists(path: string) {
    return api(() => this.files.exists(path));
  }
  readDir(path: string) {
    return api(async () =>
      (await this.files.readdir(path)).map((e) => ({ name: e.name, kind: e.type })),
    );
  }
  stat(path: string) {
    return api(async () => {
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
    });
  }
}

// Terminals -------------------------------------------------------------------
//
// A Freestyle PTY session is a Runtime process started with a terminal. It
// outlives the connection that opened it: detach() closes the connection and
// the process runs on, as a native terminal attached by process id does. The
// session's number, slug, user and size ride in the process's own command
// line, so any client finds them with the process list and nothing is stored.

export interface PtySessionInfo {
  sessionId: number;
  state: string;
  createdUnix: number;
  cols: number;
  rows: number;
  exitCode?: number | null;
  linuxUser?: string | null;
  slug?: string | null;
}
export interface PtyOpenOptions {
  exec?: string;
  cols?: number;
  rows?: number;
  linuxUser?: string;
  slug?: string;
}
export type PtySessionSelector = number | string;
export interface PtyAttachOptions {
  session: PtySessionSelector;
  linuxUser?: string;
}
export type PtyConnectionState = "connecting" | "connected" | "reconnecting" | "closed" | "exited";
export interface PtyReconnectOptions {
  /** Total time to recover one dropped connection. Default: five minutes. */
  timeoutMs?: number;
  /** Initial backoff, with 30% jitter. Default: 400ms. */
  initialDelayMs?: number;
  /** Backoff ceiling before jitter. Default: 10 seconds. */
  maxDelayMs?: number;
}
export interface PtySessionEvents {
  /** Reattach by itself after a dropped connection (Freestyle 0.2.18). */
  reconnect?: boolean | PtyReconnectOptions;
  /** Longest wait for each connection's terminal. Recovery waits at most 15
   * seconds by default; a first connection, only when this is given. */
  connectTimeoutMs?: number;
  onStateChange?: (state: PtyConnectionState) => void;
  /** Freestyle's exact replay boundaries. A Runtime terminal replays the
   * session's output from its start on each connection without marking where
   * the replay ends, as Freestyle's older guest agents do, so these never
   * fire: the replay begins at the "connected" state. */
  onReplayStart?: (info: { exact: boolean }) => void;
  onReplayEnd?: () => void;
  onData?: (data: Uint8Array) => void;
  onExit?: (exitCode: number) => void;
  onClose?: (info: { wasClean: boolean; code: number; reason: string }) => void;
  onError?: (err: unknown) => void;
}
const PTY = /^: freestyle-pty slug=([a-z0-9-]*) user=([a-z0-9_-]*) cols=(\d+) rows=(\d+); /;
const SLUG = /^(?=.*[a-z-])[a-z0-9-]{1,63}$/;
/** A session's number: FNV-1a of its process id, 31 bits, never 0. */
export function sessionNumber(processId: string): number {
  let hash = 0x811c9dc5;
  for (const char of processId) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return hash >>> 1 || 1;
}
type Session = { info: PtySessionInfo; processId: string; running: boolean };
function session(process: ProcessInfo): Session | undefined {
  const mark = PTY.exec(process.command);
  if (!process.pty || !mark) return undefined;
  const running = process.state === "running";
  return {
    processId: process.id,
    running,
    info: {
      sessionId: sessionNumber(process.id),
      state: running ? "running" : "exited",
      createdUnix: Math.floor(Date.parse(process.startedAt) / 1000),
      cols: Number(mark[3]),
      rows: Number(mark[4]),
      ...(running ? {} : { exitCode: process.exitCode }),
      linuxUser: mark[2] || null,
      // A slug is released when its shell exits.
      slug: running && mark[1] ? mark[1] : null,
    },
  };
}
const dimension = (value: number | undefined, fallback: number, name: string) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
    throw new TypeError(`${name} must be a whole number from 1 to 1000`);
  return value;
};

const PTY_EVENTS = [
  "reconnect",
  "connectTimeoutMs",
  "onStateChange",
  "onReplayStart",
  "onReplayEnd",
  "onData",
  "onExit",
  "onClose",
  "onError",
];
const PTY_OPEN = ["exec", "cols", "rows", "linuxUser", "slug", ...PTY_EVENTS];
/** Freestyle 0.2.18 checks its timers before anything is opened. */
function connectionOptions(options: PtySessionEvents): void {
  const { reconnect } = options;
  if (reconnect !== undefined && reconnect !== null && typeof reconnect !== "boolean") {
    if (typeof reconnect !== "object")
      throw new TypeError("reconnect must be true, false or reconnect options");
    only("Freestyle pty reconnect", reconnect, ["timeoutMs", "initialDelayMs", "maxDelayMs"]);
  }
  const timers = {
    connectTimeoutMs: options.connectTimeoutMs,
    ...(typeof reconnect === "object" && reconnect ? reconnect : {}),
  };
  for (const [name, value] of Object.entries(timers))
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
    )
      throw new RangeError(`${name} must be a positive finite timer duration`);
}
const LOST = { wasClean: false, code: 1006, reason: "Connection lost" };
/** A 4xx other than 409 and 429 will not get better by retrying. */
const fatal = (error: unknown) =>
  error instanceof RuntimeError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 409 &&
  error.status !== 429;

/** A stable handle across reattachments; input is never retried or buffered.
 * Each connection is a Runtime terminal attached to the session's process. */
export class PtySession {
  #state: PtyConnectionState = "connecting";
  #readyState = 0;
  #terminal: Terminal | undefined;
  #generation = 0;
  #attempt = 0;
  #deadline = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #exited = false;
  #fatal = false;
  #established = false;
  #closeReported = false;
  #dimensions: { cols: number; rows: number } | undefined;
  #removeWake: (() => void) | undefined;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  /** Resolves once the first connection is up. */
  readonly ready: Promise<void>;
  constructor(
    private readonly sandbox: Sandbox,
    private readonly processId: string,
    readonly sessionId: number,
    readonly slug: string | undefined,
    readonly created: boolean,
    private readonly events: PtySessionEvents,
    dimensions?: { cols: number; rows: number },
  ) {
    this.#dimensions = dimensions;
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    void this.ready.catch(() => {});
    if (events.reconnect && typeof window !== "undefined" && typeof document !== "undefined") {
      // A browser back online or back in view retries a dropped session now.
      const wake = () => {
        if (document.visibilityState !== "hidden" && this.#state === "closed") this.reconnect();
      };
      window.addEventListener("online", wake);
      window.addEventListener("pageshow", wake);
      document.addEventListener("visibilitychange", wake);
      this.#removeWake = () => {
        window.removeEventListener("online", wake);
        window.removeEventListener("pageshow", wake);
        document.removeEventListener("visibilitychange", wake);
      };
    }
    void this.#dial();
  }
  #setState(state: PtyConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.events.onStateChange?.(state);
  }
  async #dial(): Promise<void> {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation && !this.#stopped;
    const limit = this.#established
      ? Math.min(this.events.connectTimeoutMs ?? 15_000, Math.max(1, this.#deadline - Date.now()))
      : this.events.connectTimeoutMs;
    try {
      // Before a reattachment, as Freestyle's preflight: a session that is
      // gone, or credentials that no longer work, end it instead of retrying.
      if (this.#established) await this.sandbox.processes.get(this.processId);
      if (!current()) return;
      const opening = this.sandbox.terminal({
        processId: this.processId,
        onData: (data) => {
          if (current()) this.events.onData?.(data);
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const terminal = await (limit === undefined
        ? opening
        : Promise.race([
            opening,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                void opening.then((late) => late.close()).catch(() => {});
                reject(new Error("PTY handshake timed out"));
              }, limit);
            }),
          ]).finally(() => clearTimeout(timer)));
      if (!current()) {
        terminal.close();
        return;
      }
      this.#bind(terminal, generation);
    } catch (error) {
      if (!current()) return;
      if (!this.#established) return this.#finish(translate(error));
      if (fatal(error)) {
        this.#fatal = true;
        this.#finish(translate(error));
      } else this.#scheduleRetry(translate(error));
    }
  }
  #bind(terminal: Terminal, generation: number): void {
    this.#terminal = terminal;
    this.#readyState = 1;
    const recovering = this.#established;
    this.#established = true;
    this.#attempt = 0;
    this.#deadline = 0;
    this.#closeReported = false;
    this.#resolveReady();
    this.#setState("connected");
    if (recovering && this.#dimensions)
      terminal.resize(this.#dimensions.cols, this.#dimensions.rows);
    void terminal.exited.then((exitCode) => this.#ended(generation, exitCode));
  }
  /** The connection ended: with the shell's exit code, or without one when the
   * shell was killed by a signal or the connection dropped. */
  #ended(generation: number, exitCode: number | null): void {
    const current = () => generation === this.#generation && !this.#stopped;
    if (!current()) return;
    this.#readyState = 3;
    if (exitCode !== null) return this.#exit(exitCode);
    this.sandbox.processes.get(this.processId).then(
      (process) => {
        if (!current()) return;
        if (process.state === "running") this.#lost();
        else this.#exit(process.exitCode);
      },
      (error: unknown) => {
        if (current()) this.#lost(translate(error));
      },
    );
  }
  #retire(): void {
    ++this.#generation;
    clearTimeout(this.#retry);
    if (this.#readyState === 1) this.#readyState = 2;
    this.#terminal?.close();
    this.#terminal = undefined;
  }
  #exit(exitCode: number | null): void {
    this.#exited = true;
    this.#retire();
    this.#readyState = 3;
    this.#setState("exited");
    this.#removeWake?.();
    if (exitCode !== null) this.events.onExit?.(exitCode);
    this.#report({ wasClean: true, code: 1000, reason: "" });
  }
  #lost(error?: unknown): void {
    this.#retire();
    this.#readyState = 3;
    if (this.#stopped) return;
    if (!this.events.reconnect || this.#exited || this.#fatal) return this.#finish(error);
    this.#scheduleRetry(error);
  }
  #scheduleRetry(error?: unknown): void {
    const options = typeof this.events.reconnect === "object" ? this.events.reconnect : null;
    this.#deadline ||= Date.now() + (options?.timeoutMs ?? 300_000);
    if (Date.now() >= this.#deadline)
      return this.#finish(error ?? new Error("PTY reconnect timed out"));
    this.#setState("reconnecting");
    const base = Math.min(
      (options?.initialDelayMs ?? 400) * 2 ** this.#attempt++,
      options?.maxDelayMs ?? 10_000,
    );
    const delay = Math.min(
      Math.round(base * (0.7 + Math.random() * 0.6)),
      Math.max(0, this.#deadline - Date.now()),
    );
    this.#retry = setTimeout(() => void this.#dial(), delay);
  }
  #finish(error?: unknown, info = LOST): void {
    clearTimeout(this.#retry);
    if (!this.#established) this.#rejectReady(error ?? new Error("PTY connection failed"));
    this.#setState(this.#exited ? "exited" : "closed");
    if (this.#fatal || this.#exited || !this.#established) this.#removeWake?.();
    this.#report(info, error);
  }
  #report(info: { wasClean: boolean; code: number; reason: string }, error?: unknown): void {
    if (this.#closeReported) return;
    this.#closeReported = true;
    if (error) this.events.onError?.(error);
    this.events.onClose?.(info);
  }
  /** Retry now after a network change or a spent retry budget. Never opens a new shell. */
  reconnect(): void {
    if (this.#stopped || this.#exited || this.#fatal || !this.#established) return;
    this.#retire();
    this.#attempt = 0;
    this.#deadline = 0;
    this.#closeReported = false;
    this.#scheduleRetry();
  }
  /** Send input once. Throws while disconnected; uncertain keystrokes are never replayed. */
  write(data: Uint8Array | string): void {
    if (this.#state !== "connected" || !this.#terminal) throw new Error("PTY is not connected");
    this.#terminal.write(data);
  }
  /** Remembers the size and applies it again after a reattachment. */
  resize(options: { cols: number; rows: number }): void {
    const cols = dimension(options.cols, 80, "cols");
    const rows = dimension(options.rows, 24, "rows");
    this.#dimensions = { cols, rows };
    if (this.#state === "connected") this.#terminal?.resize(cols, rows);
  }
  signal(sig: "sigint" | "sigkill"): void {
    if (sig !== "sigint" && sig !== "sigkill")
      throw new TypeError('signal must be "sigint" or "sigkill"');
    if (this.#state !== "connected") throw new Error("PTY is not connected");
    void (async () => {
      const process = await this.sandbox.processes.get(this.processId);
      await process.kill(sig === "sigint" ? "SIGINT" : "SIGKILL");
    })().catch((error: unknown) => this.events.onError?.(translate(error)));
  }
  /** Cancels recovery and closes the connection; the shell keeps running and
   * attach() finds it. */
  detach(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#retire();
    this.#removeWake?.();
    this.#finish(undefined, { wasClean: true, code: 1000, reason: "Detached" });
  }
  get readyState(): number {
    return this.#readyState;
  }
  get state(): PtyConnectionState {
    return this.#state;
  }
}

export class VmPty {
  constructor(private readonly get: () => Promise<Sandbox>) {}
  private async sessions(sandbox: Sandbox): Promise<Session[]> {
    return (await sandbox.processes.list()).flatMap((process) => session(process) ?? []);
  }
  private async find(sandbox: Sandbox, selector: PtySessionSelector, linuxUser?: string) {
    if (typeof selector !== "number" && typeof selector !== "string")
      throw new TypeError("session must be a session id or a slug");
    const found = (await this.sessions(sandbox))
      .filter((s) =>
        typeof selector === "number" ? s.info.sessionId === selector : s.info.slug === selector,
      )
      .sort((a, b) => a.info.createdUnix - b.info.createdUnix)[0];
    if (!found) throw notFound(`PTY session ${selector}`);
    if (linuxUser !== undefined && found.info.linuxUser !== linuxUser)
      throw notFound(`PTY session ${selector} of ${linuxUser}`);
    return found;
  }
  private async connect(
    sandbox: Sandbox,
    found: Session,
    created: boolean,
    events: PtySessionEvents,
    dimensions?: { cols: number; rows: number },
  ) {
    const session = new PtySession(
      sandbox,
      found.processId,
      found.info.sessionId,
      found.info.slug ?? undefined,
      created,
      events,
      dimensions,
    );
    await session.ready;
    return session;
  }
  async open(options: PtyOpenOptions & PtySessionEvents = {}): Promise<PtySession> {
    only("Freestyle pty open", options, PTY_OPEN);
    connectionOptions(options);
    const cols = dimension(options.cols, 80, "cols");
    const rows = dimension(options.rows, 24, "rows");
    const user = options.linuxUser === undefined ? "" : validateLinuxUser(options.linuxUser);
    if (
      options.slug !== undefined &&
      (typeof options.slug !== "string" || !SLUG.test(options.slug))
    )
      throw new TypeError("slug must be lowercase letters, digits and hyphens, not all digits");
    if (
      options.exec !== undefined &&
      (typeof options.exec !== "string" || options.exec.includes("\0"))
    )
      throw new TypeError("exec must be a command without NUL bytes");
    return api(async () => {
      const sandbox = await this.get();
      if (options.slug !== undefined) {
        const existing = (await this.sessions(sandbox)).find((s) => s.info.slug === options.slug);
        // Get-or-create: a running session with the slug is handed back, exec unrun.
        if (existing) return this.connect(sandbox, existing, false, options, { cols, rows });
      }
      const shell =
        options.exec === undefined
          ? user
            ? `exec sudo -n -H -u ${quote(user)} -- bash -l`
            : "exec bash -l"
          : user
            ? `exec sudo -n -H -u ${quote(user)} -- bash -c ${quote(options.exec)}`
            : options.exec;
      const process = await sandbox.spawn(
        `: freestyle-pty slug=${options.slug ?? ""} user=${user} cols=${cols} rows=${rows}; ${shell}`,
        { pty: { cols, rows } },
      );
      const started = session(process.toJSON());
      if (!started) throw new Error("The started PTY session has no session line");
      return this.connect(sandbox, started, true, options, { cols, rows });
    });
  }
  async attach(options: PtyAttachOptions & PtySessionEvents): Promise<PtySession> {
    only("Freestyle pty attach", options, ["session", "linuxUser", ...PTY_EVENTS]);
    connectionOptions(options);
    if (options.linuxUser !== undefined) validateLinuxUser(options.linuxUser);
    return api(async () => {
      const sandbox = await this.get();
      return this.connect(
        sandbox,
        await this.find(sandbox, options.session, options.linuxUser),
        false,
        options,
      );
    });
  }
  async list(options: { linuxUser?: string } = {}) {
    only("Freestyle pty list", options, ["linuxUser"]);
    if (options.linuxUser !== undefined) validateLinuxUser(options.linuxUser);
    return api(async () => ({
      sessions: (await this.sessions(await this.get()))
        .filter((s) => options.linuxUser === undefined || s.info.linuxUser === options.linuxUser)
        .map((s) => s.info),
    }));
  }
  /** Ends a session's shell. An exited session stays in the list. */
  async close(session: PtySessionSelector, options: { linuxUser?: string } = {}) {
    only("Freestyle pty close", options, ["linuxUser"]);
    if (options.linuxUser !== undefined) validateLinuxUser(options.linuxUser);
    return api(async () => {
      const sandbox = await this.get();
      const found = await this.find(sandbox, session, options.linuxUser);
      if (!found.running) return { sessionId: found.info.sessionId, exitCode: found.info.exitCode };
      await (await sandbox.processes.get(found.processId)).kill("SIGKILL");
      return { sessionId: found.info.sessionId };
    });
  }
}
export class VmLinuxUserPty {
  constructor(
    private readonly pty: VmPty,
    private readonly linuxUser: string,
  ) {}
  async open(options: Omit<PtyOpenOptions, "linuxUser"> & PtySessionEvents = {}) {
    only(
      "Freestyle pty open",
      options,
      PTY_OPEN.filter((key) => key !== "linuxUser"),
    );
    return this.pty.open({ ...options, linuxUser: this.linuxUser });
  }
  attach(options: Omit<PtyAttachOptions, "linuxUser"> & PtySessionEvents) {
    return this.pty.attach({ ...options, linuxUser: this.linuxUser });
  }
  list() {
    return this.pty.list({ linuxUser: this.linuxUser });
  }
  close(session: PtySessionSelector) {
    return this.pty.close(session, { linuxUser: this.linuxUser });
  }
}

interface XtermDisposable {
  dispose(): void;
}
interface XtermSequence {
  prefix?: string;
  intermediates?: string;
  final: string;
}
/** The xterm.js surface connectXterm uses; xterm itself is not a dependency. */
export interface XtermTerminal {
  cols: number;
  rows: number;
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(listener: (data: string) => void): XtermDisposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): XtermDisposable;
  parser: {
    registerCsiHandler(id: XtermSequence, handler: () => boolean): XtermDisposable;
    registerDcsHandler(id: XtermSequence, handler: () => boolean): XtermDisposable;
  };
}
export type ConnectXtermOptions = PtyOpenOptions &
  PtySessionEvents & {
    pty: VmPty | VmLinuxUserPty;
    terminal: XtermTerminal;
    slug: string;
  };
/** Terminal queries a replay may hold (device attributes, status and mode
 * reports, window ops): answering them again would type the answers. */
const XTERM_QUERIES: XtermSequence[] = [
  { final: "c" },
  { prefix: ">", final: "c" },
  { final: "n" },
  { prefix: "?", final: "n" },
  { final: "t" },
  { intermediates: "$", final: "p" },
  { prefix: "?", intermediates: "$", final: "p" },
];
/** Freestyle 0.2.18's connectXterm: xterm.js on a named session that
 * reattaches by itself unless `reconnect: false`. Each connection replays the
 * session's output from its start, so the screen is reset first and the
 * replay's terminal queries go unanswered until it has been written (150ms
 * quiet, at most 2 seconds). dispose() detaches; the shell keeps running. */
export async function connectXterm({
  pty,
  terminal,
  ...options
}: ConnectXtermOptions): Promise<{ session: PtySession; dispose(): void }> {
  only("Freestyle connectXterm", options, PTY_OPEN);
  let muted: XtermDisposable[] = [];
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let cap: ReturnType<typeof setTimeout> | undefined;
  let replay = 0;
  let disposed = false;
  const unmute = () => {
    clearTimeout(quiet);
    clearTimeout(cap);
    for (const handler of muted) handler.dispose();
    muted = [];
  };
  const endReplay = () => {
    clearTimeout(quiet);
    clearTimeout(cap);
    const current = replay;
    // Unmute once xterm has parsed everything written before this point.
    terminal.write("", () => {
      if (current === replay) unmute();
    });
  };
  const beginReplay = () => {
    ++replay;
    unmute();
    terminal.write("\x1bc");
    muted = XTERM_QUERIES.map((id) => terminal.parser.registerCsiHandler(id, () => true));
    muted.push(terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => true));
    quiet = setTimeout(endReplay, 150);
    cap = setTimeout(endReplay, 2_000);
  };
  const stopReplay = () => {
    ++replay;
    unmute();
  };
  try {
    const session = await pty.open({
      ...options,
      reconnect: options.reconnect ?? true,
      cols: options.cols ?? terminal.cols,
      rows: options.rows ?? terminal.rows,
      onStateChange(state) {
        if (state === "connected") beginReplay();
        if (state === "closed" || state === "exited") endReplay();
        options.onStateChange?.(state);
      },
      onData(bytes) {
        if (disposed) return;
        if (muted.length) {
          clearTimeout(quiet);
          quiet = setTimeout(endReplay, 150);
        }
        terminal.write(bytes);
        options.onData?.(bytes);
      },
    });
    const input = terminal.onData((data) => {
      if (session.state === "connected") session.write(data);
    });
    const resize = terminal.onResize((size) => session.resize(size));
    return {
      session,
      dispose() {
        if (disposed) return;
        disposed = true;
        input.dispose();
        resize.dispose();
        session.detach();
        stopReplay();
      },
    };
  } catch (error) {
    stopReplay();
    throw error;
  }
}

export class VmLinuxUser {
  readonly pty: VmLinuxUserPty;
  constructor(
    private readonly vm: Vm,
    private readonly linuxUser: string,
  ) {
    validateLinuxUser(linuxUser);
    this.pty = new VmLinuxUserPty(vm.pty, linuxUser);
  }
  exec(options: string | Omit<ExecOptions, "linuxUser">) {
    const request = typeof options === "string" ? { command: options } : options;
    return this.vm.exec({ ...request, linuxUser: this.linuxUser });
  }
}

export class Vm {
  readonly fs: VmFilesystem;
  readonly pty: VmPty;
  declare readonly resize: RefusedAsync;
  constructor(
    private readonly runtime: Runtime,
    readonly id: string,
  ) {
    this.fs = new VmFilesystem(() => lookup(runtime, id));
    this.pty = new VmPty(() => lookup(runtime, id));
  }
  data() {
    return api(async () => data(await lookup(this.runtime, this.id)));
  }
  start() {
    return api(async () => data(await ready(await lookup(this.runtime, this.id))));
  }
  pause() {
    return api(async () => {
      const s = await lookup(this.runtime, this.id);
      await s.pause();
      return data(s);
    });
  }
  delete() {
    return api(async () => destroy(await lookup(this.runtime, this.id)));
  }
  /** The VM's outbound rules, read back from its network settings. */
  firewallRules() {
    return api(async () => {
      const s = await lookup(this.runtime, this.id);
      const policy = await s.network.get();
      if (policy.deny.length || policy.connect.length)
        throw new CompatibilityError(
          "Freestyle",
          "network rules that deny or open ports; read them with sandbox.network.get()",
        );
      const destinations: FirewallEndpoint[] = !policy.internet
        ? []
        : !policy.allow.length
          ? [{ public: true }]
          : policy.allow.map((entry) => {
              const cidr = cidrOf(entry);
              if (!cidr)
                throw new CompatibilityError(
                  "Freestyle",
                  "network rules that name hosts; read them with sandbox.network.get()",
                );
              return { cidr };
            });
      const at = policy.updatedAt ?? s.info.createdAt;
      const rules = destinations.map((destination, index) =>
        ruleData(s.id, index, destination, at),
      );
      return { rules, totalCount: rules.length };
    });
  }
  linuxUser(linuxUser: string) {
    return new VmLinuxUser(this, linuxUser);
  }
  async update(options: {
    slug?: string;
    displayName?: string;
    idleTimeoutSeconds?: number;
    metadata?: Record<string, string>;
  }) {
    only("Freestyle update", options, ["slug", "displayName", "idleTimeoutSeconds", "metadata"]);
    validateMetadata(options.metadata);
    return api(async () => {
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
    });
  }
  async exec(options: string | ExecOptions) {
    const o = typeof options === "string" ? { command: options } : options;
    only("Freestyle exec", o, ["command", "linuxUser", "timeoutMs", "env", "stdin"]);
    const user = o.linuxUser === undefined ? undefined : validateLinuxUser(o.linuxUser);
    return api(async () => {
      const s = await lookup(this.runtime, this.id);
      const native = await execOptions(s, {
        onStdout: () => undefined,
        onStderr: () => undefined,
        timeoutMs: o.timeoutMs,
        env: o.env,
        stdin:
          o.stdin === undefined
            ? undefined
            : Uint8Array.from(atob(o.stdin), (c) => c.charCodeAt(0)),
      });
      const r = user
        ? await s.exec(asUser(user, o.command, native.env), native)
        : await s.exec(o.command, native);
      return { stdout: r.stdout, stderr: r.stderr, statusCode: r.timedOut ? null : r.exitCode };
    });
  }
  async snapshot(options: { slug?: string; displayName?: string; ttlSeconds?: number } = {}) {
    only("Freestyle snapshot", options, ["slug", "displayName", "ttlSeconds"]);
    const days = retentionDays(options.ttlSeconds);
    return api(async () => {
      const s = await (
        await lookup(this.runtime, this.id)
      ).snapshot({
        name: options.slug,
        labels: options.displayName ? { "fs.displayName": options.displayName } : undefined,
        retentionDays: days,
      });
      return { snapshotId: s.id, sourceVmId: s.sourceSandboxId, snapshot: snapshotData(s) };
    });
  }
}
refuse("Freestyle", "Vm", Vm, {
  resize:
    "Runtime resizes by restarting, which ends running processes: call sandbox.resize() on the native client",
});
