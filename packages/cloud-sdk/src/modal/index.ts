import type { Runtime } from "../client.js";
import {
  ConflictError as NativeConflictError,
  InvalidRequestError,
  NotFoundError as NativeNotFoundError,
  RateLimitError,
  RuntimeError,
  ServiceUnavailableError,
} from "../errors.js";
import type { FileEventType } from "../products/watch.js";
import type { Process, Sandbox as NativeSandbox } from "../sandbox.js";
import type { CreateSandbox } from "../types.js";
import {
  all,
  client,
  CompatibilityError,
  create,
  destroy,
  execOptions,
  only,
  refuse,
  region,
  type ClientOptions,
  type Refused,
  type RefusedAsync,
} from "../compat/core.js";
import { GuestFiles } from "../compat/files.js";
export { CompatibilityError };

// Errors ----------------------------------------------------------------------

export class TimeoutError extends Error {}
export class RemoteError extends Error {}
export class ExecutionError extends Error {}
export class InternalFailure extends Error {}
export class NotFoundError extends Error {}
export class AlreadyExistsError extends Error {}
export class ConflictError extends Error {}
export class InvalidError extends Error {}
export class ResourceExhaustedError extends Error {}
export class SandboxTimeoutError extends TimeoutError {}
export class SnapshotCreationError extends Error {}
export class ClientClosedError extends Error {}
export class SandboxFilesystemError extends Error {}
export class SandboxFilesystemDirectoryNotEmptyError extends SandboxFilesystemError {}
export class SandboxFilesystemFileTooLargeError extends SandboxFilesystemError {}
export class SandboxFilesystemIsADirectoryError extends SandboxFilesystemError {}
export class SandboxFilesystemNotADirectoryError extends SandboxFilesystemError {}
export class SandboxFilesystemNotFoundError extends SandboxFilesystemError {}
export class SandboxFilesystemPathAlreadyExistsError extends SandboxFilesystemError {}
export class SandboxFilesystemPermissionError extends SandboxFilesystemError {}

/** A Runtime failure as the Modal error a caller catches. */
function modalError(error: unknown): unknown {
  if (!(error instanceof RuntimeError)) return error;
  if (error.code === "name_taken") return new AlreadyExistsError(error.message);
  if (error instanceof NativeNotFoundError) return new NotFoundError(error.message);
  if (error instanceof NativeConflictError) return new ConflictError(error.message);
  if (error instanceof InvalidRequestError) return new InvalidError(error.message);
  if (error instanceof RateLimitError || error.code === "quota_exceeded")
    return new ResourceExhaustedError(error.message);
  if (error instanceof ServiceUnavailableError || error.status >= 500)
    return new InternalFailure(error.message);
  return error;
}
async function modal<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw modalError(error);
  }
}
const FILE_ERRORS: Record<string, new (message: string) => SandboxFilesystemError> = {
  file_not_found: SandboxFilesystemNotFoundError,
  path_not_found: SandboxFilesystemNotFoundError,
  is_a_directory: SandboxFilesystemIsADirectoryError,
  not_a_directory: SandboxFilesystemNotADirectoryError,
  directory_not_empty: SandboxFilesystemDirectoryNotEmptyError,
  already_exists: SandboxFilesystemPathAlreadyExistsError,
  permission_denied: SandboxFilesystemPermissionError,
  file_too_large: SandboxFilesystemFileTooLargeError,
  too_large: SandboxFilesystemFileTooLargeError,
};
async function fileCall<T>(path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    const Mapped =
      FILE_ERRORS[error.code] ?? (error.status === 404 ? SandboxFilesystemNotFoundError : null);
    if (!Mapped) throw error;
    throw new Mapped(`${path}: ${error.message}`);
  }
}

// Apps, secrets, volumes, bucket mounts -----------------------------------------

export class App {
  constructor(
    readonly appId: string,
    readonly name?: string,
    readonly environmentName?: string,
  ) {}
}
export class AppService {
  constructor(private readonly client: ModalClient) {}
  async fromName(name: string, params: { createIfMissing?: boolean; environment?: string } = {}) {
    this.client.open();
    only("Modal app", params, ["createIfMissing", "environment"]);
    if (params.environment) throw new CompatibilityError("Modal", "named Modal environments");
    if (
      !params.createIfMissing &&
      !(await all(this.client.runtime, "modal")).some((s) => s.info.labels["modal.app"] === name)
    )
      throw new NotFoundError(`App ${name} has no Runtime sandboxes; pass createIfMissing: true.`);
    return new App(name, name);
  }
}

/** Values the sandbox receives as environment variables, from the caller. */
export class Secret {
  readonly secretId: string;
  constructor(
    readonly values: Record<string, string>,
    readonly name?: string,
  ) {
    this.secretId = `st-${crypto.randomUUID()}`;
  }
}
const RUNTIME_SECRETS =
  "Runtime secrets are used without being seen: runtime.secrets.set({ value, hosts }); or pass values with secrets.fromObject";
export class SecretService {
  constructor(private readonly client: ModalClient) {}
  async fromObject(entries: Record<string, string>, params: { environment?: string } = {}) {
    this.client.open();
    only("Modal secret", params, ["environment"]);
    if (params.environment) throw new CompatibilityError("Modal", "named Modal environments");
    for (const [key, value] of Object.entries(entries))
      if (typeof value !== "string")
        throw new InvalidError(`Secret value for ${key} must be a string`);
    return new Secret({ ...entries });
  }
  declare readonly fromName: RefusedAsync;
  declare readonly delete: RefusedAsync;
}
refuse("Modal", "SecretService", SecretService, {
  fromName: RUNTIME_SECRETS,
  delete: RUNTIME_SECRETS,
});

const FIXED_SIZE =
  "Runtime volumes have a fixed size: create one with runtime.volumes.create({ name, sizeMiB })";
export class Volume {
  constructor(
    readonly volumeId: string,
    readonly name?: string,
    readonly readOnly = false,
  ) {}
  withMountOptions(params: { readOnly?: boolean; subPath?: string } = {}) {
    only("Modal volume mount", params, ["readOnly", "subPath"]);
    if (params.subPath) throw new CompatibilityError("Modal", "subPath; mount the whole volume");
    return new Volume(this.volumeId, this.name, params.readOnly ?? this.readOnly);
  }
  closeEphemeral(): void {
    throw new InvalidError(`Volume ${this.name ?? this.volumeId} is not ephemeral`);
  }
}
export class VolumeService {
  constructor(private readonly client: ModalClient) {}
  private async find(name: string) {
    const page = await modal(() => this.client.runtime.volumes.list({ name, limit: 100 }));
    return page.data.find((v) => v.name === name && v.state !== "deleted");
  }
  async fromName(name: string, params: { createIfMissing?: boolean; environment?: string } = {}) {
    this.client.open();
    only("Modal volume", params, ["createIfMissing", "environment"]);
    if (params.environment) throw new CompatibilityError("Modal", "named Modal environments");
    const found = await this.find(name);
    if (found) return new Volume(found.id, name);
    if (params.createIfMissing)
      throw new CompatibilityError("Modal", `createIfMissing; ${FIXED_SIZE}`);
    throw new NotFoundError(`Volume ${name} not found`);
  }
  async delete(name: string, params: { allowMissing?: boolean; environment?: string } = {}) {
    this.client.open();
    only("Modal volume delete", params, ["allowMissing", "environment"]);
    if (params.environment) throw new CompatibilityError("Modal", "named Modal environments");
    const found = await this.find(name);
    if (!found) {
      if (params.allowMissing) return;
      throw new NotFoundError(`Volume ${name} not found`);
    }
    await modal(() => this.client.runtime.volumes.delete(found.id));
  }
  declare readonly ephemeral: RefusedAsync;
}
refuse("Modal", "VolumeService", VolumeService, { ephemeral: FIXED_SIZE });

const BUCKET_KEYS =
  "store the bucket key with runtime.secrets.set and mount it with the native sandbox's mounts.add";
export class CloudBucketMount {
  /** Refused at creation: Runtime mounts public buckets here, keyed ones natively. */
  readonly secret?: Secret;
  readonly requesterPays = false;
  readonly oidcAuthRoleArn?: string;
  constructor(
    readonly bucketName: string,
    readonly readOnly = false,
    readonly bucketEndpointUrl?: string,
    readonly keyPrefix?: string,
  ) {}
  declare readonly toProto: Refused;
  /** The native mount for `path`: the provider read from the endpoint's host. */
  native(path: string) {
    const host = this.bucketEndpointUrl ? new URL(this.bucketEndpointUrl).hostname : undefined;
    const r2 = host?.match(/^([0-9a-f]+)\.r2\.cloudflarestorage\.com$/);
    return {
      provider: r2
        ? ("r2" as const)
        : host === "storage.googleapis.com"
          ? ("gcs" as const)
          : ("s3" as const),
      bucket: this.bucketName,
      path,
      ...(r2 ? { accountId: r2[1] } : host ? { endpoint: host } : {}),
      ...(this.keyPrefix ? { prefix: this.keyPrefix } : {}),
      readOnly: this.readOnly,
    };
  }
}
refuse(
  "Modal",
  "CloudBucketMount",
  CloudBucketMount,
  { toProto: "pass it in cloudBucketMounts" },
  { sync: true },
);
export class CloudBucketMountService {
  create(
    bucketName: string,
    params: {
      secret?: Secret;
      readOnly?: boolean;
      requesterPays?: boolean;
      bucketEndpointUrl?: string;
      keyPrefix?: string;
      oidcAuthRoleArn?: string;
    } = {},
  ) {
    only("Modal bucket mount", params, [
      "secret",
      "readOnly",
      "requesterPays",
      "bucketEndpointUrl",
      "keyPrefix",
      "oidcAuthRoleArn",
    ]);
    if (params.secret) throw new CompatibilityError("Modal", `bucket secret; ${BUCKET_KEYS}`);
    if (params.requesterPays || params.oidcAuthRoleArn)
      throw new CompatibilityError("Modal", `requesterPays and oidcAuthRoleArn; ${BUCKET_KEYS}`);
    if (params.bucketEndpointUrl) new URL(params.bucketEndpointUrl);
    return new CloudBucketMount(
      bucketName,
      params.readOnly ?? false,
      params.bucketEndpointUrl,
      params.keyPrefix,
    );
  }
}

export class Proxy {
  declare readonly proxyId: Refused;
}
export class ProxyService {
  declare readonly fromName: RefusedAsync;
}
const STATIC_IPS = "Runtime static egress IPs: runtime.ips";
refuse("Modal", "Proxy", Proxy, { proxyId: STATIC_IPS }, { sync: true });
refuse("Modal", "ProxyService", ProxyService, { fromName: STATIC_IPS });

export class ExperimentalOutboundPolicy {
  declare readonly withHeaderReplacement: Refused;
}
refuse(
  "Modal",
  "ExperimentalOutboundPolicy",
  ExperimentalOutboundPolicy,
  {
    withHeaderReplacement:
      "Runtime secrets set the header on the way out: runtime.secrets.set({ value, hosts, header })",
  },
  { sync: true },
);

// Readiness ---------------------------------------------------------------------

type ProbeSpec = { tcpPort?: number; execArgv?: string[]; intervalMs: number };
export class Probe {
  private constructor(readonly spec: ProbeSpec) {}
  private static interval(name: string, intervalMs: unknown) {
    if (!Number.isInteger(intervalMs))
      throw new InvalidError(`${name}() expects an integer \`intervalMs\``);
    if ((intervalMs as number) <= 0)
      throw new InvalidError(`${name}() expects \`intervalMs\` > 0, got ${String(intervalMs)}`);
  }
  static withTcp(port: number, params: { intervalMs: number } = { intervalMs: 100 }) {
    if (!Number.isInteger(port))
      throw new InvalidError("Probe.withTcp() expects an integer `port`");
    if (port <= 0 || port > 65535)
      throw new InvalidError(`Probe.withTcp() expects \`port\` in [1, 65535], got ${port}`);
    Probe.interval("Probe.withTcp", params.intervalMs);
    return new Probe({ tcpPort: port, intervalMs: params.intervalMs });
  }
  static withExec(argv: string[], params: { intervalMs: number } = { intervalMs: 100 }) {
    if (!Array.isArray(argv) || argv.length === 0)
      throw new InvalidError("Probe.withExec() requires at least one argument");
    if (!argv.every((arg) => typeof arg === "string"))
      throw new InvalidError("Probe.withExec() expects all arguments to be strings");
    Probe.interval("Probe.withExec", params.intervalMs);
    return new Probe({ execArgv: [...argv], intervalMs: params.intervalMs });
  }
  declare readonly toProto: Refused;
}
refuse("Modal", "Probe", Probe, { toProto: "pass it as readinessProbe" }, { sync: true });

// Images ------------------------------------------------------------------------

export class Image {
  private built?: string;
  constructor(
    /** Absent only for an Image that is already built. */
    private readonly runtime: Runtime | undefined,
    private readonly tag?: string,
    id?: string,
    private readonly commands: string[] = [],
    private readonly env: Record<string, string> = {},
    private readonly cache = true,
    /** The id is a native disk snapshot (snapshotFilesystem), not an image. */
    readonly snapshot = false,
  ) {
    this.built = id;
  }
  get imageId() {
    if (!this.built) throw new Error("Image is not built; await image.build(app) first.");
    return this.built;
  }
  dockerfileCommands(
    commands: string[],
    params: { env?: Record<string, string>; forceBuild?: boolean } = {},
  ) {
    only("Modal image", params, ["env", "forceBuild"]);
    if (!this.tag)
      throw new CompatibilityError(
        "Modal",
        "extending a prebuilt Runtime image through Dockerfile layers",
      );
    return new Image(
      this.runtime,
      this.tag,
      undefined,
      [...this.commands, ...commands],
      { ...this.env, ...params.env },
      params.forceBuild ? false : this.cache,
    );
  }
  async build(_app?: App): Promise<Image> {
    if (!this.built) {
      const built = await modal(() =>
        this.commands.length
          ? this.runtime!.images.build({
              dockerfile: [`FROM ${this.tag}`, ...this.commands].join("\n"),
              env: this.env,
              cache: this.cache,
            })
          : this.runtime!.images.build({ image: this.tag!, env: this.env, cache: this.cache }),
      );
      this.built = built.id;
    }
    return this;
  }
  declare readonly publish: RefusedAsync;
}
refuse("Modal", "Image", Image, {
  publish: "build it under a name: runtime.images.build({ name }), then images.fromName",
});
const REGISTRY_LOGIN =
  "store the registry login with runtime.images.registries, then use images.fromRegistry";
export class ImageService {
  constructor(private readonly client: ModalClient) {}
  fromRegistry(tag: string, secret?: Secret) {
    this.client.open();
    if (secret) throw new CompatibilityError("Modal", `registry Secret; ${REGISTRY_LOGIN}`);
    return new Image(this.client.runtime, tag);
  }
  async fromId(imageId: string) {
    this.client.open();
    return new Image(
      this.client.runtime,
      undefined,
      (await modal(() => this.client.runtime.images.get(imageId))).id,
    );
  }
  async fromName(name: string, params: { environment?: string } = {}) {
    this.client.open();
    only("Modal image name", params, ["environment"]);
    if (params.environment) throw new CompatibilityError("Modal", "named Modal environments");
    return new Image(
      this.client.runtime,
      undefined,
      (await modal(() => this.client.runtime.images.resolve(name))).id,
    );
  }
  async delete(imageId: string, _params: Record<never, never> = {}) {
    this.client.open();
    await modal(() => this.client.runtime.images.delete(imageId));
  }
  declare readonly fromAwsEcr: Refused;
  declare readonly fromGcpArtifactRegistry: Refused;
}
refuse(
  "Modal",
  "ImageService",
  ImageService,
  { fromAwsEcr: REGISTRY_LOGIN, fromGcpArtifactRegistry: REGISTRY_LOGIN },
  { sync: true },
);

// Snapshots ---------------------------------------------------------------------

export class SandboxSnapshot {
  constructor(readonly snapshotId: string) {}
}
export class SandboxSnapshotService {
  constructor(private readonly client: ModalClient) {}
  async fromId(snapshotId: string) {
    this.client.open();
    const snapshot = await modal(() => this.client.runtime.snapshots.get(snapshotId));
    if (snapshot.state === "deleted" || snapshot.state === "deleting")
      throw new NotFoundError(`Sandbox snapshot ${snapshotId} not found`);
    return new SandboxSnapshot(snapshot.id);
  }
}

// Client ------------------------------------------------------------------------

export type ModalClientParams = ClientOptions & {
  tokenId?: string;
  tokenSecret?: string;
  environment?: string;
  oauthRefreshToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthJwtKey?: string;
  endpoint?: string;
  maxThrottleWaitSecs?: number;
  logger?: unknown;
  logLevel?: string;
  grpcMiddleware?: unknown[];
  cpClient?: unknown;
};
export class ModalClient {
  readonly runtime: Runtime;
  readonly apps: AppService;
  readonly images: ImageService;
  readonly sandboxes: SandboxService;
  readonly secrets: SecretService;
  readonly volumes: VolumeService;
  readonly cloudBucketMounts = new CloudBucketMountService();
  readonly sandboxSnapshots: SandboxSnapshotService;
  readonly proxies = new ProxyService();
  #closed = false;
  constructor(options: ModalClientParams = {}) {
    if (
      options.endpoint !== undefined ||
      options.oauthRefreshToken !== undefined ||
      options.oauthClientId !== undefined ||
      options.oauthClientSecret !== undefined ||
      options.oauthJwtKey !== undefined ||
      options.maxThrottleWaitSecs !== undefined ||
      options.logger !== undefined ||
      options.logLevel !== undefined ||
      options.grpcMiddleware !== undefined ||
      options.cpClient !== undefined
    )
      throw new CompatibilityError(
        "Modal",
        "Modal endpoints, OAuth, gRPC and logger options; set RUNTIME_API_KEY or pass apiKey",
      );
    only("Modal client", options, [
      "apiKey",
      "baseUrl",
      "fetch",
      "client",
      "timeoutMs",
      "maxRetries",
      "tokenId",
      "tokenSecret",
      "environment",
    ]);
    if (options.environment) throw new CompatibilityError("Modal", "named Modal environments");
    this.runtime = client(options);
    this.apps = new AppService(this);
    this.images = new ImageService(this);
    this.sandboxes = new SandboxService(this.runtime, this);
    this.secrets = new SecretService(this);
    this.volumes = new VolumeService(this);
    this.sandboxSnapshots = new SandboxSnapshotService(this);
  }
  /** Throws once close() was called, as Modal's client does. */
  open() {
    if (this.#closed) throw new ClientClosedError("The Modal client was closed");
  }
  environmentName(environment?: string): string {
    if (environment) throw new CompatibilityError("Modal", "named Modal environments");
    return "";
  }
  /** The Modal SDK version whose interface this adapter implements. */
  version(): string {
    return "0.11.0";
  }
  close() {
    // The transport owns no background connection; later calls fail as Modal's do.
    this.#closed = true;
  }
  declare readonly cpClient: Refused;
  declare readonly ipClient: Refused;
  declare readonly profile: Refused;
  declare readonly logger: Refused;
  declare readonly getImageBuilderVersion: RefusedAsync;
}
const NO_MODAL_SERVER =
  "Runtime has no Modal control plane; use the native client at modal.runtime";
refuse(
  "Modal",
  "ModalClient",
  ModalClient,
  {
    cpClient: NO_MODAL_SERVER,
    ipClient: NO_MODAL_SERVER,
    profile: NO_MODAL_SERVER,
    logger: NO_MODAL_SERVER,
  },
  { sync: true },
);
refuse("Modal", "ModalClient", ModalClient, {
  getImageBuilderVersion:
    "Runtime images record theirs: (await runtime.images.get(id)).build.builderVersion",
});

// Sandboxes ---------------------------------------------------------------------

export type SandboxCreateParams = {
  name?: string;
  cpu?: number;
  cpuLimit?: number;
  memoryMiB?: number;
  memoryLimitMiB?: number;
  runtime?: "gvisor" | "vm";
  timeoutMs?: number;
  workdir?: string;
  command?: string[];
  env?: Record<string, string>;
  encryptedPorts?: number[];
  blockNetwork?: boolean;
  outboundDomainAllowlist?: string[];
  outboundCidrAllowlist?: string[];
  tags?: Record<string, string>;
  regions?: string[];
  gpu?: string;
  pty?: boolean;
  secrets?: Secret[];
  volumes?: Record<string, Volume>;
  cloudBucketMounts?: Record<string, CloudBucketMount>;
  readinessProbe?: Probe;
  experimentalEnableSnapshot?: boolean;
};
export type SandboxExecParams = {
  mode?: "text" | "binary";
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
  workdir?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  pty?: boolean;
  secrets?: Secret[];
};
/** Modal's outbound allowlists as Runtime network rules, never wider than
 * Modal's: a missing list or a wildcard entry allows everything, an empty
 * list blocks all egress. Runtime's rules are one list a connection matches
 * any entry of, so a domain list and a CIDR list that both narrow are
 * refused rather than joined into a wider rule. */
function egress(domains?: string[], cidrs?: string[]): { internet: boolean; allow?: string[] } {
  if (domains?.length === 0 || cidrs?.length === 0) return { internet: false };
  const anyDomain = !domains || domains.includes("*");
  const anyCidr = !cidrs || cidrs.some((c) => c === "0.0.0.0/0" || c === "::/0");
  if (anyDomain && anyCidr) return { internet: true };
  if (!anyDomain && !anyCidr)
    throw new CompatibilityError(
      "Modal",
      "a domain allowlist and a CIDR allowlist at once; pass one list of domains and CIDR ranges to sandbox.native.network.set({ internet: true, allow })",
    );
  return { internet: true, allow: anyDomain ? cidrs! : domains };
}
const ENVIRONMENTS = "named Modal environments";
const CREATE_OPTIONS = [
  "name",
  "cpu",
  "cpuLimit",
  "memoryMiB",
  "memoryLimitMiB",
  "runtime",
  "timeoutMs",
  "workdir",
  "command",
  "env",
  "encryptedPorts",
  "blockNetwork",
  "outboundDomainAllowlist",
  "outboundCidrAllowlist",
  "tags",
  "regions",
  "gpu",
  "pty",
  "secrets",
  "volumes",
  "cloudBucketMounts",
  "readinessProbe",
  "experimentalEnableSnapshot",
] as const;
export class SandboxService {
  constructor(
    private readonly runtime: Runtime,
    private readonly client?: ModalClient,
  ) {}
  async create(app: App, image: Image, params: SandboxCreateParams = {}) {
    this.client?.open();
    only("Modal sandbox", params, CREATE_OPTIONS);
    if (params.gpu) throw new CompatibilityError("Modal", "GPU allocation");
    if (params.runtime === "gvisor")
      throw new CompatibilityError(
        "Modal",
        'gVisor; Runtime sandboxes are Firecracker VMs (runtime: "vm")',
      );
    if (params.cpuLimit !== undefined && params.cpuLimit !== params.cpu)
      throw new CompatibilityError("Modal", "separate CPU reservation and hard limit");
    if (params.memoryLimitMiB !== undefined && params.memoryLimitMiB !== params.memoryMiB)
      throw new CompatibilityError("Modal", "separate memory reservation and hard limit");
    if (params.regions && params.regions.length !== 1)
      throw new CompatibilityError("Modal", "multiple region placement");
    if (params.cpu !== undefined && !Number.isInteger(params.cpu))
      throw new CompatibilityError("Modal", "fractional CPU reservations");
    if (image.snapshot && (params.cpu !== undefined || params.memoryMiB !== undefined))
      throw new CompatibilityError(
        "Modal",
        "cpu or memoryMiB with a snapshot image; it keeps the snapshot's shape, resize it after",
      );
    if (params.blockNetwork && (params.outboundDomainAllowlist || params.outboundCidrAllowlist))
      throw new TypeError("blockNetwork cannot be combined with allowlists");
    if (params.runtime !== undefined && params.runtime !== "vm")
      throw new InvalidError(`Unknown sandbox runtime ${String(params.runtime)}`);
    const network = params.blockNetwork
      ? { internet: false }
      : egress(params.outboundDomainAllowlist, params.outboundCidrAllowlist);
    const placement = region("Modal", params.regions?.[0]);
    const built = await image.build(app);
    const volumes = Object.entries(params.volumes ?? {}).map(([path, v]) => {
      if (!(v instanceof Volume)) throw new InvalidError(`volumes[${path}] must be a Volume`);
      return {
        volumeId: v.volumeId,
        path,
        mode: v.readOnly ? ("snapshot" as const) : ("rw" as const),
      };
    });
    const mounts = Object.entries(params.cloudBucketMounts ?? {}).map(([path, m]) => {
      if (!(m instanceof CloudBucketMount))
        throw new InvalidError(`cloudBucketMounts[${path}] must be a CloudBucketMount`);
      return m.native(path);
    });
    let primary: Process | undefined;
    const input: CreateSandbox = {
      name: params.name ? `${app.name ?? app.appId}-${params.name}` : undefined,
      labels: {
        "modal.app": app.name ?? app.appId,
        ...(params.name ? { "modal.name": params.name } : {}),
        "modal.tags": JSON.stringify(params.tags ?? {}),
        ...(params.readinessProbe
          ? { "modal.probe": JSON.stringify(params.readinessProbe.spec) }
          : {}),
        ...(volumes.some((v) => v.mode === "snapshot") ? { "modal.readonly": "1" } : {}),
      },
      ...(image.snapshot ? { snapshot: built.imageId } : { image: built.imageId }),
      ...(image.snapshot
        ? {}
        : { cpu: "reserved" as const, vcpu: params.cpu, memoryMiB: params.memoryMiB }),
      region: placement,
      ...(volumes.length ? { volumes } : {}),
      // A timeout is the customer's limit, and the sandbox never pauses
      // for idleness before it. None is no time limit (0300): it runs while
      // it works and pauses when idle.
      ...(params.timeoutMs === undefined
        ? {}
        : { timeoutSeconds: Math.ceil(params.timeoutMs / 1000), idlePauseSeconds: 0 }),
      onLeaseEnd: "stop",
      network,
    };
    const s = await modal(() =>
      create(
        this.runtime,
        "modal",
        input,
        Object.assign(
          {} as Record<string, string>,
          ...(params.secrets?.map((s) => s.values) ?? []),
          params.env ?? {},
        ) as Record<string, string>,
        async (s) => {
          for (const mount of mounts) await s.mounts.add(mount);
          primary = await s.spawn(params.command ?? ["sleep", "infinity"], {
            ...(await execOptions(s, { cwd: params.workdir })),
            stdin: "pipe",
            pty: params.pty ? {} : undefined,
          });
          await s.update({ labels: { ...s.info.labels, "modal.entrypoint": primary.id } });
          for (const port of params.encryptedPorts ?? [])
            await s.previews.create(port, { visibility: "public" });
        },
      ),
    );
    const sandbox = new Sandbox(s, new ContainerProcess(primary!, "text"), this.client);
    sandbox.monitorEntrypoint();
    return sandbox;
  }
  async experimentalCreate(app: App, image: Image, params: SandboxCreateParams = {}) {
    only("Modal sandbox", params, CREATE_OPTIONS);
    return this.create(app, image, params);
  }
  async fromId(id: string) {
    this.client?.open();
    const s = await modal(() => this.runtime.sandboxes.get(id));
    const p = s.info.labels["modal.entrypoint"];
    if (!p) throw new NotFoundError("Sandbox is not a Modal-compatible sandbox");
    return new Sandbox(
      s,
      new ContainerProcess(await modal(() => s.processes.get(p)), "text"),
      this.client,
    );
  }
  async fromName(appName: string, name: string, params: { environment?: string } = {}) {
    this.client?.open();
    only("Modal sandbox name", params, ["environment"]);
    if (params.environment) throw new CompatibilityError("Modal", ENVIRONMENTS);
    const s = (await all(this.runtime, "modal")).find(
      (s) =>
        s.info.labels["modal.app"] === appName &&
        s.info.labels["modal.name"] === name &&
        s.state === "running",
    );
    if (!s) throw new NotFoundError(`Sandbox ${name} not found`);
    return this.fromId(s.id);
  }
  experimentalFromName(appName: string, name: string, params: { environment?: string } = {}) {
    return this.fromName(appName, name, params);
  }
  /** A new sandbox continuing a memory snapshot: its files, memory and
   * running entrypoint, under the snapshot's app and tags. */
  async experimentalFromSnapshot(snapshot: SandboxSnapshot, params: { name?: string | null } = {}) {
    this.client?.open();
    only("Modal snapshot restore", params, ["name"]);
    const saved = await modal(() => this.runtime.snapshots.get(snapshot.snapshotId));
    const labels = (saved.labels ?? {}) as Record<string, string>;
    const entrypoint = labels["modal.entrypoint"];
    if (!entrypoint || saved.mode === "disk")
      throw new InvalidError(
        `Snapshot ${snapshot.snapshotId} was not taken with sandbox.experimentalSnapshot()`,
      );
    const app = labels["modal.app"]!;
    const s = await modal(() =>
      create(this.runtime, "modal", {
        snapshot: saved.id,
        ...(params.name ? { name: `${app}-${params.name}` } : {}),
        labels: {
          ...Object.fromEntries(Object.entries(labels).filter(([k]) => k.startsWith("modal."))),
          ...(params.name ? { "modal.name": params.name } : {}),
        },
        onLeaseEnd: "stop",
      }),
    );
    let process: Process;
    try {
      process = await s.processes.get(entrypoint);
    } catch (error) {
      await destroy(s);
      throw modalError(error);
    }
    const sandbox = new Sandbox(s, new ContainerProcess(process, "text"), this.client);
    sandbox.monitorEntrypoint();
    return sandbox;
  }
  async *list(
    params: { appId?: string; tags?: Record<string, string>; environment?: string } = {},
  ) {
    this.client?.open();
    only("Modal list", params, ["appId", "tags", "environment"]);
    if (params.environment) throw new CompatibilityError("Modal", ENVIRONMENTS);
    for (const s of await all(this.runtime, "modal"))
      if (
        s.state === "running" &&
        (!params.appId || s.info.labels["modal.app"] === params.appId) &&
        Object.entries(params.tags ?? {}).every(
          ([k, v]) =>
            (JSON.parse(s.info.labels["modal.tags"] ?? "{}") as Record<string, string>)[k] === v,
        )
      )
        yield await this.fromId(s.id);
  }
  experimentalList(
    params: { appId?: string; tags?: Record<string, string>; environment?: string } = {},
  ) {
    return this.list(params);
  }
}
export class ModalReadStream<R extends string | Uint8Array = string> extends ReadableStream<R> {
  constructor(
    process: Process,
    channel: "stdout" | "stderr",
    mode: "text" | "binary",
    ignore = false,
  ) {
    const iterator = mode === "binary" ? process.outputBytes() : process.output();
    super({
      async pull(controller) {
        if (ignore) {
          controller.close();
          return;
        }
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              controller.close();
              return;
            }
            if (next.value.type === "truncated") throw new Error("Process output was truncated");
            if (next.value.type === channel) {
              controller.enqueue(next.value.data as R);
              return;
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    });
  }
  async readBytes() {
    const reader = this.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const bytes =
          typeof next.value === "string" ? new TextEncoder().encode(next.value) : next.value;
        chunks.push(bytes as Uint8Array);
        size += bytes.length;
      }
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
  async readText() {
    return new TextDecoder().decode(await this.readBytes());
  }
}
export class ModalWriteStream<R extends string | Uint8Array = string> extends WritableStream<R> {
  constructor(private readonly process: Process) {
    super({ write: (data) => process.write(data), close: () => process.write("", { eof: true }) });
  }
  async writeText(text: string) {
    const writer = this.getWriter();
    try {
      await writer.write(text as R);
    } finally {
      writer.releaseLock();
    }
  }
  async writeBytes(bytes: Uint8Array) {
    const writer = this.getWriter();
    try {
      await writer.write(bytes as R);
    } finally {
      writer.releaseLock();
    }
  }
}
export class ContainerProcess<R extends string | Uint8Array = string> {
  readonly stdin: ModalWriteStream<R>;
  readonly stdout: ModalReadStream<R>;
  readonly stderr: ModalReadStream<R>;
  constructor(
    readonly native: Process,
    mode: "text" | "binary",
    params: SandboxExecParams = {},
  ) {
    this.stdin = new ModalWriteStream<R>(native);
    this.stdout = new ModalReadStream<R>(native, "stdout", mode, params.stdout === "ignore");
    this.stderr = new ModalReadStream<R>(native, "stderr", mode, params.stderr === "ignore");
  }
  async wait() {
    const r = await this.native.wait();
    if (r.timedOut) throw new SandboxTimeoutError("Process timed out");
    return r.exitCode ?? -1;
  }
  closeStdin() {
    return this.native.write("", { eof: true });
  }
  async _poll() {
    const p = await this.native.refresh();
    return p.state === "running" ? null : p.exitCode;
  }
}

/** Host and port of a sandbox port's public HTTPS address. Runtime previews
 * are HTTPS only, so there is no unencrypted address. */
export class Tunnel {
  constructor(
    public host: string,
    public port: number,
    public unencryptedHost?: string,
    public unencryptedPort?: number,
  ) {}
  get url() {
    return this.port === 443 ? `https://${this.host}` : `https://${this.host}:${this.port}`;
  }
  get tlsSocket(): [string, number] {
    return [this.host, this.port];
  }
  get tcpSocket(): [string, number] {
    if (!this.unencryptedHost || this.unencryptedPort === undefined)
      throw new InvalidError("This tunnel is not configured for unencrypted TCP.");
    return [this.unencryptedHost, this.unencryptedPort];
  }
}

const NEW_SANDBOX_FROM_SNAPSHOT =
  "take sandbox.snapshotFilesystem() and start a new sandbox from that image";
export class SandboxLogsManager {
  declare readonly fetch: Refused;
  declare readonly tail: Refused;
}
refuse(
  "Modal",
  "SandboxLogsManager",
  SandboxLogsManager,
  {
    fetch: "read sandbox.stdout and sandbox.stderr",
    tail: "read sandbox.stdout and sandbox.stderr",
  },
  { sync: true },
);
const SECOND_SANDBOX = "start a second Runtime sandbox and join both to a private network";
export class SidecarService {
  declare readonly create: RefusedAsync;
  declare readonly get: RefusedAsync;
  declare readonly list: Refused;
}
refuse("Modal", "SidecarService", SidecarService, { create: SECOND_SANDBOX, get: SECOND_SANDBOX });
refuse("Modal", "SidecarService", SidecarService, { list: SECOND_SANDBOX }, { sync: true });
export class SidecarContainer {
  declare readonly containerId: Refused;
  declare readonly containerName: Refused;
  declare readonly filesystem: Refused;
  declare readonly exec: RefusedAsync;
  declare readonly mountImage: RefusedAsync;
  declare readonly poll: RefusedAsync;
  declare readonly reloadVolumes: RefusedAsync;
  declare readonly snapshotDirectory: RefusedAsync;
  declare readonly snapshotFilesystem: RefusedAsync;
  declare readonly terminate: RefusedAsync;
  declare readonly unmountImage: RefusedAsync;
  declare readonly wait: RefusedAsync;
}
refuse(
  "Modal",
  "SidecarContainer",
  SidecarContainer,
  { containerId: SECOND_SANDBOX, containerName: SECOND_SANDBOX, filesystem: SECOND_SANDBOX },
  { sync: true },
);
refuse(
  "Modal",
  "SidecarContainer",
  SidecarContainer,
  Object.fromEntries(
    [
      "exec",
      "mountImage",
      "poll",
      "reloadVolumes",
      "snapshotDirectory",
      "snapshotFilesystem",
      "terminate",
      "unmountImage",
      "wait",
    ].map((m) => [m, SECOND_SANDBOX]),
  ),
);

export class Sandbox {
  readonly filesystem: SandboxFilesystem;
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly logs = new SandboxLogsManager();
  readonly experimentalSidecars = new SidecarService();
  private detached = false;
  private lifecycle?: Promise<number>;
  monitorEntrypoint() {
    this.lifecycle = this.primary.wait().then(async (code) => {
      await destroy(this.native);
      return code;
    });
    this.lifecycle.catch(() => undefined);
  }
  constructor(
    readonly native: NativeSandbox,
    private readonly primary: ContainerProcess,
    private readonly client?: ModalClient,
  ) {
    this.filesystem = new SandboxFilesystem(native);
    this.stdin = primary.stdin;
    this.stdout = primary.stdout;
    this.stderr = primary.stderr;
  }
  get sandboxId() {
    return this.native.id;
  }
  private attached() {
    this.client?.open();
    if (this.detached) throw new ClientClosedError("Sandbox is detached");
  }
  exec(
    command: string[],
    params?: SandboxExecParams & { mode?: "text" },
  ): Promise<ContainerProcess<string>>;
  exec(
    command: string[],
    params: SandboxExecParams & { mode: "binary" },
  ): Promise<ContainerProcess<Uint8Array>>;
  async exec(
    command: string[],
    params: SandboxExecParams = {},
  ): Promise<ContainerProcess<string | Uint8Array>> {
    this.attached();
    only("Modal exec", params, [
      "mode",
      "stdout",
      "stderr",
      "workdir",
      "timeoutMs",
      "env",
      "pty",
      "secrets",
    ]);
    const p = await this.native.spawn(command, {
      ...(await execOptions(this.native, {
        cwd: params.workdir,
        timeoutMs: params.timeoutMs === 0 ? 86_400_000 : params.timeoutMs,
        env: Object.assign(
          {} as Record<string, string>,
          ...(params.secrets?.map((s) => s.values) ?? []),
          params.env ?? {},
        ) as Record<string, string>,
      })),
      stdin: "pipe",
      ...(params.mode === "binary" ? { outputEncoding: "base64" as const } : {}),
      pty: params.pty ? {} : undefined,
    });
    return new ContainerProcess(p, params.mode ?? "text", params);
  }
  async setTags(tags: Record<string, string>) {
    this.attached();
    await this.native.update({
      labels: {
        ...Object.fromEntries(
          Object.entries(this.native.info.labels).filter(
            ([k]) => k.startsWith("modal.") || k === "compat.provider",
          ),
        ),
        "modal.tags": JSON.stringify(tags),
      },
    });
  }
  async getTags(): Promise<Record<string, string>> {
    this.attached();
    await this.native.refresh();
    return JSON.parse(this.native.info.labels["modal.tags"] ?? "{}") as Record<string, string>;
  }
  /** Names the sandbox so sandboxes.fromName(app, name) finds it. */
  async experimentalSetName(name: string) {
    this.attached();
    if (!name) throw new InvalidError("Sandbox name must not be empty");
    const app = this.native.info.labels["modal.app"]!;
    await modal(() =>
      this.native.update({
        name: `${app}-${name}`,
        labels: { ...this.native.info.labels, "modal.name": name },
      }),
    );
  }
  async terminate(params: { wait?: boolean } = {}) {
    await destroy(this.native);
    return params.wait ? this.primary.wait() : undefined;
  }
  detach() {
    this.detached = true;
  }
  async wait() {
    if (this.lifecycle) return this.lifecycle;
    const code = await this.primary.wait();
    await destroy(this.native);
    return code;
  }
  poll() {
    return this.primary._poll();
  }
  /** Runs the sandbox's readinessProbe until it passes. */
  async waitUntilReady(timeoutMs = 300_000) {
    this.attached();
    if (timeoutMs <= 0) throw new InvalidError(`timeoutMs must be positive, got ${timeoutMs}`);
    const raw = this.native.info.labels["modal.probe"];
    if (!raw) throw new InvalidError("Sandbox has no readinessProbe");
    const probe = JSON.parse(raw) as ProbeSpec;
    const argv = probe.execArgv ?? ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${probe.tcpPort}`];
    const until = performance.now() + timeoutMs;
    while (true) {
      const left = Math.ceil(until - performance.now());
      if (left <= 0) throw new TimeoutError("Timeout expired");
      const result = await this.native.exec(argv, { timeoutMs: left });
      if (result.exitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(probe.intervalMs, left)));
    }
  }
  async tunnels(timeoutMs = 50_000) {
    this.attached();
    const tunnels: Record<number, Tunnel> = {};
    for (const p of await this.native.previews.list({ timeoutMs }))
      tunnels[p.port] = new Tunnel(new URL(p.url).hostname, 443);
    return tunnels;
  }
  async updateNetworkPolicy(params: {
    outboundCidrAllowlist?: string[];
    outboundDomainAllowlist?: string[];
  }) {
    this.attached();
    only("Modal network policy", params, ["outboundCidrAllowlist", "outboundDomainAllowlist"]);
    if (!params.outboundCidrAllowlist || !params.outboundDomainAllowlist)
      throw new InvalidError(
        "Both outboundCidrAllowlist and outboundDomainAllowlist must be provided",
      );
    await this.native.network.set(
      egress(params.outboundDomainAllowlist, params.outboundCidrAllowlist),
    );
  }
  /** Runtime volumes are block devices with one writer: a read-write mount
   * always shows the latest writes. A read-only mount is a copy taken at
   * start, which cannot reload. */
  async reloadVolumes(params: { timeoutMs?: number } = {}) {
    this.attached();
    only("Modal reload volumes", params, ["timeoutMs"]);
    if (this.native.info.labels["modal.readonly"])
      throw new CompatibilityError(
        "Modal",
        "reloading a read-only volume; it is a copy taken at start",
      );
  }
  /** The whole sandbox, memory and running processes included. */
  async experimentalSnapshot() {
    this.attached();
    const snapshot = await modal(() =>
      this.native.snapshot({
        labels: Object.fromEntries(
          Object.entries(this.native.info.labels).filter(([k]) => k.startsWith("modal.")),
        ),
      }),
    ).catch((error: unknown) => {
      throw error instanceof Error && !(error instanceof NotFoundError)
        ? new SnapshotCreationError(error.message)
        : error;
    });
    return new SandboxSnapshot(snapshot.id);
  }
  /** The sandbox's files as an Image new sandboxes start from. `ttlMs` is
   * kept in whole days. */
  async snapshotFilesystem(params: { timeoutMs?: number; ttlMs?: number | null } = {}) {
    this.attached();
    only("Modal filesystem snapshot", params, ["timeoutMs", "ttlMs"]);
    const day = 86_400_000;
    if (
      params.ttlMs === null ||
      (params.ttlMs !== undefined && (!Number.isInteger(params.ttlMs / day) || params.ttlMs <= 0))
    )
      throw new CompatibilityError(
        "Modal",
        "ttlMs that is null or not whole days; Runtime keeps snapshots for a number of days",
      );
    const snapshot = await this.native
      .snapshot({
        mode: "disk",
        ...(params.ttlMs === undefined ? {} : { retentionDays: params.ttlMs / day }),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      })
      .catch((error: unknown) => {
        throw error instanceof RuntimeError && error.code === "timeout"
          ? new TimeoutError(error.message)
          : new SnapshotCreationError(error instanceof Error ? error.message : String(error));
      });
    return new Image(undefined, undefined, snapshot.id, [], {}, true, true);
  }
  declare readonly createConnectToken: RefusedAsync;
  declare readonly experimentalGetExitSnapshot: RefusedAsync;
  declare readonly snapshotDirectory: RefusedAsync;
  declare readonly mountImage: RefusedAsync;
  declare readonly unmountImage: RefusedAsync;
  declare readonly experimentalUpdateOutboundPolicy: RefusedAsync;
}
refuse("Modal", "Sandbox", Sandbox, {
  createConnectToken:
    "a private preview: sandbox.native.previews.create(port), sending its token as x-runtime-preview-token",
  experimentalGetExitSnapshot: NEW_SANDBOX_FROM_SNAPSHOT,
  snapshotDirectory: NEW_SANDBOX_FROM_SNAPSHOT,
  mountImage: NEW_SANDBOX_FROM_SNAPSHOT,
  unmountImage: NEW_SANDBOX_FROM_SNAPSHOT,
  experimentalUpdateOutboundPolicy:
    "updateNetworkPolicy for allowlists; runtime.secrets.set({ value, hosts, header }) for header replacement",
});

// Files -------------------------------------------------------------------------

type FileWatchEventType = "Access" | "Create" | "Modify" | "Remove" | "Unknown";
const WATCHED: Record<Exclude<FileWatchEventType, "Unknown">, FileEventType[]> = {
  Access: ["access"],
  Create: ["create"],
  Modify: ["write", "chmod", "rename"],
  Remove: ["remove"],
};
export class SandboxFilesystem {
  private readonly files: GuestFiles;
  constructor(private readonly native: NativeSandbox) {
    this.files = new GuestFiles(async () => native, "/");
  }
  readBytes(path: string) {
    return fileCall(path, () => this.files.readFile(path));
  }
  readText(path: string) {
    return fileCall(path, () => this.files.readTextFile(path));
  }
  writeBytes(content: Uint8Array | ArrayBuffer, path: string) {
    return fileCall(path, () =>
      this.files.writeFile(path, content instanceof Uint8Array ? content : new Uint8Array(content)),
    );
  }
  writeText(content: string, path: string) {
    return fileCall(path, () => this.files.writeTextFile(path, content));
  }
  makeDirectory(path: string, options: { createParents?: boolean } = {}) {
    return fileCall(path, () => this.files.mkdir(path, options.createParents ?? true));
  }
  remove(path: string, options: { recursive?: boolean } = {}) {
    return fileCall(path, () => this.files.remove(path, options.recursive));
  }
  copyFromLocal(localPath: string, remotePath: string) {
    return fileCall(remotePath, () => this.native.files.upload(localPath, remotePath));
  }
  copyToLocal(remotePath: string, localPath: string) {
    return fileCall(remotePath, () => this.native.files.download(remotePath, localPath));
  }
  async listFiles(path: string) {
    const entries = await fileCall(path, () => this.files.readdir(path));
    return Promise.all(
      entries.sort((a, b) => a.name.localeCompare(b.name)).map((e) => this.stat(e.path)),
    );
  }
  async stat(path: string) {
    const e = await fileCall(path, () => this.files.stat(path));
    const r = await this.native.exec(["stat", "-c", "%U:%G", "--", this.files.path(path)], {
      check: true,
    });
    const [owner, group] = r.stdout.trim().split(":");
    return {
      name: e.name,
      path: e.path,
      type: e.type,
      size: e.size,
      mode: parseInt(e.mode, 8),
      permissions: e.mode,
      owner: owner!,
      group: group!,
      modifiedTime: Date.parse(e.modifiedAt) / 1000,
      symlinkTarget:
        e.type === "symlink"
          ? (
              await this.native.exec(["readlink", "--", this.files.path(path)], { check: true })
            ).stdout.trimEnd()
          : null,
    };
  }
  /** Changes under `remotePath` until `timeoutMs` passes or the loop stops. */
  async *watch(
    remotePath: string,
    params: { filter?: FileWatchEventType[]; recursive?: boolean; timeoutMs?: number } = {},
  ): AsyncIterable<{ eventType: FileWatchEventType; paths: string[] }> {
    only("Modal watch", params, ["filter", "recursive", "timeoutMs"]);
    if (!remotePath.startsWith("/"))
      throw new InvalidError(`watch() expects an absolute path, got ${remotePath}`);
    const types = (params.filter ?? (["Access", "Create", "Modify", "Remove"] as const)).flatMap(
      (t) => (t === "Unknown" ? [] : WATCHED[t]),
    );
    const queue: { eventType: FileWatchEventType; paths: string[] }[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const handle = await fileCall(remotePath, () =>
      this.native.files.watch(remotePath, undefined, {
        recursive: params.recursive ?? false,
        events: [...new Set(types)],
        timeoutMs: params.timeoutMs ?? 0,
        onBatch: (events) => {
          for (const e of events)
            queue.push({
              eventType:
                e.type === "create"
                  ? "Create"
                  : e.type === "remove"
                    ? "Remove"
                    : e.type === "access"
                      ? "Access"
                      : "Modify",
              paths: e.type === "rename" && e.oldPath ? [e.oldPath, e.path] : [e.path],
            });
          notify();
        },
        onExit: () => {
          ended = true;
          notify();
        },
      }),
    );
    try {
      while (true) {
        const next = queue.shift();
        if (next) yield next;
        else if (ended) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      if (!ended) await handle.stop().catch(() => undefined);
    }
  }
}
