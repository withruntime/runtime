import type { Runtime } from "../client.js";
import { RuntimeError } from "../errors.js";
import {
  clientFor,
  defaultRegion,
  type RuntimeCreate,
  type RuntimeOptions,
  type RuntimeSandbox,
} from "./client.js";
import {
  checkEnvNames,
  envFileCommand,
  envFileLines,
  parseProcessLine,
  toRuntimePath,
} from "./context.js";
import { codeOf, guard, NotSupportedError, responseError, translate } from "./errors.js";
import { SandboxFileSystem } from "./filesystem.js";
import {
  ARCHIVED,
  DISPLAY_NAME,
  EXTERNAL_ID,
  IDLE_PAUSE,
  LABEL,
  findByExternalId,
  findSandbox,
  LEASE_SECONDS,
  ownLabels,
  STANDBY,
  userLabels,
  whenNameFree,
} from "./lookup.js";
import { paginate, type PaginatedList } from "./pagination.js";
import { portAccess, SandboxPreviews } from "./preview.js";
import { SandboxProcess } from "./process.js";
import { SandboxSessions, sessionSandbox } from "./session.js";
import {
  appendEnvs,
  envRecord,
  KEEP_DAYS,
  refuseApplication,
  SandboxSnapshotsResource,
  startFromSnapshot,
  type Env,
  type SandboxForkResponse,
  type SandboxRestoreResponse,
  type SandboxSnapshot,
} from "./snapshot.js";
import {
  normalizeEnvs,
  normalizePorts,
  normalizeVolumes,
  type Metadata,
  type Sandbox as SandboxModel,
  type SandboxCreateConfiguration,
  type SandboxLifecycle,
  type SandboxNetwork,
  type SandboxSpec,
  type SandboxUpdateMetadata,
  type SandboxUpdateNetwork,
  type SessionWithToken,
  type Status,
  type VolumeAttachment,
} from "./types.js";
import {
  CODEGEN,
  DRIVES,
  SCHEDULES,
  SYSTEM,
  unsupportedPart,
  type UnsupportedPart,
} from "./unsupported.js";

/* Blaxel's SandboxInstance over a Runtime sandbox. Every call is one or a few
   calls of the withruntime SDK; nothing here speaks HTTP. What Runtime cannot
   do the way Blaxel does throws NotSupportedError before anything happens.

   A Blaxel sandbox goes to standby by itself when unused and resumes on the
   next call, and lives until deleted or until its TTL. On Runtime it pauses
   after the shortest idle time Runtime allows (60 s), wakes on the next call,
   pauses rather than ends when its lease runs out, and a paused one is kept
   365 days unless a TTL says otherwise: never deleted before Blaxel would
   delete it (BLAXEL.md, "Standby and lifetime"). */

/** Blaxel's defaults (checked 27 September 2026). */
export const DEFAULT_IMAGE = "blaxel/base-image:latest";
export const DEFAULT_MEMORY = 4096;
/** Blaxel gives a sandbox one vCPU per 2048 MB of memory. */
export const MEMORY_PER_VCPU = 2048;
const MAX_VCPU = 16;
/** Blaxel's stock images whose tools Runtime's stock image has (Node.js,
 * Python, a shell, Docker after `sudo enable-docker`), and the Jupyter server
 * that CodeInterpreter uses, whose work Runtime's interpreter does. */
const STOCK_IMAGE =
  /^(docker\.io\/)?blaxel\/(prod-)?(base|base-image|py-app|ts-app|node|jupyter-server|docker-in-sandbox)(:latest)?$/;
/** Blaxel regions in the United States, where Runtime runs. */
const US_REGIONS = new Set(["us-pdx-1", "us-was-1", "auto"]);
const REGION = "us-was-1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
/** The lease is renewed in the background once this little of it is left. */
const RENEW_BELOW_MS = 10 * 60_000;

export type SandboxListQuery = {
  showTerminated?: boolean;
  cursor?: string;
  limit?: number;
  sort?: "createdAt:desc" | "createdAt:asc" | "name:asc" | "name:desc";
  q?: string;
  anchor?: "end";
  status?: string;
  externalId?: string;
};
export type SandboxForkOptions = {
  targetType?: "sandbox" | "application";
  port?: number;
  traffic?: number;
  customDomain?: string;
  prefix?: string;
  /** A snapshot's id or, of this sandbox's snapshots, its name. */
  snapshotId?: string;
  envs?: Env[];
  /** Blaxel's fork override; Runtime cannot enforce this override during a fork. */
  lifecycle?: SandboxLifecycle;
};
export type SandboxArchiveOptions = { wait?: boolean; maxWait?: number; interval?: number };

/** What a create asked for that no label keeps: shown by `spec` in the
 * client that created the sandbox. */
type Asked = {
  envs?: Record<string, string>;
  network?: SandboxNetwork;
  volumes?: VolumeAttachment[];
};

/** The labels a new sandbox carries: the caller's, and under `blaxel/` what
 * Blaxel keeps and Runtime has no field for, so any client (the Python
 * adapter too) reads the same `spec`. */
export function labelsFor(
  config: SandboxCreateConfiguration,
  image: string,
): Record<string, string> {
  const ports = normalizePorts(config.ports);
  const mine: Record<string, string> = {
    image,
    memory: String(config.memory || DEFAULT_MEMORY),
    ...(config.externalId ? { externalId: config.externalId } : {}),
    ...(ports ? { ports: ports.map((port) => port.target).join(",") } : {}),
    ...(config.region ? { region: config.region } : {}),
    ...(config.ttl ? { ttl: config.ttl } : {}),
    ...(config.expires ? { expires: config.expires.toISOString() } : {}),
    ...(config.lifecycle ? { lifecycle: JSON.stringify(config.lifecycle) } : {}),
  };
  return {
    ...Object.fromEntries(Object.entries(config.labels ?? {}).map(([k, v]) => [k, String(v)])),
    ...Object.fromEntries(Object.entries(mine).map(([k, v]) => [`${LABEL}${k}`, v])),
  };
}
type Resolved = { runtime: RuntimeSandbox; client: Runtime; asked?: Asked };

/** Port accesses for `sandbox.fetch`, by sandbox and port. */
const accesses = new Map<string, { url: string; token: string | null; until: number }>();

/** A duration as Blaxel writes it ("30m", "24h", "7d", "1w", "1h30m"). */
export function durationMs(value: string): number {
  const match = /^(?:\d+[smhdw])+$/.exec(value.trim());
  if (!match) throw responseError(400, `invalid duration "${value}": use units s, m, h, d or w`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS } as const;
  let total = 0;
  for (const [, count, letter] of value.matchAll(/(\d+)([smhdw])/g))
    total += Number(count) * unit[letter as keyof typeof unit];
  return total;
}

/** The lease and the paused retention that honour Blaxel's TTL, expiry and
 * lifecycle: never deleted before Blaxel would delete it. A fixed deadline
 * within the hour is a lease that ends the sandbox; any other deadline keeps
 * a paused sandbox that many days, rounded up; none keeps it 365 days. */
export function lifetimeOf(asked: {
  ttl?: string | null;
  expires?: Date;
  lifecycle?: SandboxLifecycle | null;
}): {
  timeoutSeconds: number;
  onLeaseEnd: "pause" | "stop";
  days: number;
} {
  const now = Date.now();
  const fixed: number[] = [];
  const idle: number[] = [];
  if (asked.ttl) fixed.push(durationMs(asked.ttl));
  if (asked.expires) fixed.push(asked.expires.getTime() - now);
  for (const policy of asked.lifecycle?.expirationPolicies ?? []) {
    if (policy.action !== undefined && policy.action !== "delete")
      throw new NotSupportedError(
        `The expiration action ${String(policy.action)}`,
        'Use action "delete", the only one Blaxel defines.',
      );
    if (!policy.value) throw responseError(400, "an expiration policy needs a value");
    if (policy.type === "ttl-max-age") fixed.push(durationMs(policy.value));
    else if (policy.type === "ttl-idle") idle.push(durationMs(policy.value));
    else if (policy.type === "date") {
      const at = Date.parse(policy.value);
      if (Number.isNaN(at)) throw responseError(400, `invalid date "${policy.value}"`);
      fixed.push(at - now);
    } else throw responseError(400, `unknown expiration policy type ${String(policy.type)}`);
  }
  if (fixed.some((ms) => ms <= 0)) throw responseError(400, "the sandbox's expiry is in the past");
  const soonest = fixed.length ? Math.min(...fixed) : Infinity;
  const all = [...fixed, ...idle];
  const days = all.length
    ? Math.min(365, Math.max(1, Math.ceil(Math.min(...all) / DAY_MS)))
    : KEEP_DAYS;
  return soonest <= LEASE_SECONDS * 1000
    ? { timeoutSeconds: Math.max(60, Math.ceil(soonest / 1000)), onLeaseEnd: "stop", days }
    : { timeoutSeconds: LEASE_SECONDS, onLeaseEnd: "pause", days };
}

/** Blaxel's network settings as Runtime's rules: allowed and forbidden
 * domains, from the network itself or from its proxy (Blaxel's current
 * place for them). Anything else of the proxy is refused. */
export function networkRules(network: SandboxNetwork): NonNullable<RuntimeCreate["network"]> {
  for (const [field, alternative] of [
    [
      "egress",
      "Runtime's outbound traffic leaves from Runtime's addresses; allow destinations with allowedDomains.",
    ],
    ["firewall", "Allow destinations with allowedDomains and refuse them with forbiddenDomains."],
    ["subnet", "Runtime chooses each sandbox's addresses."],
  ] as const)
    if (network[field] !== undefined)
      throw new NotSupportedError(`A sandbox network's ${field}`, alternative);
  const proxy = (network.proxy ?? {}) as { allowedDomains?: string[]; forbiddenDomains?: string[] };
  const other = Object.keys(proxy).find(
    (key) => key !== "allowedDomains" && key !== "forbiddenDomains",
  );
  if (other !== undefined)
    throw new NotSupportedError(
      `A network proxy's ${other}`,
      "To send credentials to a host without the sandbox seeing them, use Runtime secrets (runtime.secrets): the egress proxy adds them on HTTPS to the hosts you name.",
    );
  const allow = [...(network.allowedDomains ?? []), ...(proxy.allowedDomains ?? [])];
  const deny = [...(network.forbiddenDomains ?? []), ...(proxy.forbiddenDomains ?? [])];
  return { internet: true, ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) };
}

/** A Blaxel create in either of its shapes (a configuration, or a Sandbox
 * model with metadata and spec) as one configuration. */
function configOf(
  input: SandboxCreateConfiguration | SandboxModel | undefined,
): SandboxCreateConfiguration {
  if (!input) return {};
  if (!("metadata" in input) && !("spec" in input)) return input;
  const model = input as SandboxModel & { withruntime?: SandboxCreateConfiguration["withruntime"] };
  const runtime = model.spec?.runtime ?? {};
  const config: SandboxCreateConfiguration = {};
  if (model.metadata?.name) config.name = model.metadata.name;
  if (model.metadata?.labels) config.labels = model.metadata.labels;
  if (model.metadata?.externalId) config.externalId = model.metadata.externalId;
  if (runtime.image) config.image = runtime.image;
  if (runtime.memory) config.memory = runtime.memory;
  if (runtime.ports) config.ports = runtime.ports;
  if (runtime.envs)
    config.envs = runtime.envs.map((env) => ({ name: env.name ?? "", value: env.value ?? "" }));
  if (runtime.ttl) config.ttl = runtime.ttl;
  if (runtime.expires) config.expires = new Date(runtime.expires);
  if (runtime.extraArgs) config.extraArgs = runtime.extraArgs;
  if (model.spec?.region) config.region = model.spec.region;
  if (model.spec?.lifecycle) config.lifecycle = model.spec.lifecycle;
  if (model.spec?.network) config.network = model.spec.network;
  if (model.spec?.volumes) config.volumes = model.spec.volumes;
  if (model.withruntime) config.withruntime = model.withruntime;
  return config;
}

function checkRegion(region: string | undefined) {
  if (region !== undefined && region !== "" && !US_REGIONS.has(region))
    throw new NotSupportedError(
      `The region ${region}`,
      "Runtime runs in one US region: remove region (and BL_REGION), or use us-was-1.",
    );
}

/** A Blaxel image `ns/name:tag` as the Runtime image name and tag it maps to
 * (Runtime names allow no "/"): every "/" becomes "-" (`ns-name`), and the
 * tag is `latest` when none is given. The Python adapter maps the same way. */
export function imageRef(image: string): { name: string; tag: string } {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  const [name, tag] = colon > slash ? [image.slice(0, colon), image.slice(colon + 1)] : [image, ""];
  return { name: name.replaceAll("/", "-"), tag: tag || "latest" };
}

/** Where an image sends the create: Runtime's stock image, or the ready
 * Runtime image `imageRef` maps it to. */
async function resolveImage(
  client: Runtime,
  image: string | undefined,
): Promise<Partial<RuntimeCreate>> {
  if (image === undefined || STOCK_IMAGE.test(image)) return {};
  if (UUID.test(image)) return { image };
  const { name, tag } = imageRef(image);
  let found: { id: string; state: string } | undefined;
  try {
    found = await client.images.resolve(`${name}:${tag}`);
  } catch (error) {
    // Not an image, or a name Runtime could not hold: the same answer.
    const status = error instanceof RuntimeError ? error.status : undefined;
    if (status !== 400 && status !== 404) throw translate(error);
  }
  if (found && found.state === "ready") return { image: found.id };
  const feature = `The image ${image}, which is not a Runtime image`;
  const alternative = `Build it as a Runtime image named ${name}: \`npx withruntime image build --dockerfile Dockerfile --name ${name} -t ${name}:${tag}\`. The code can keep "${image}": the adapter starts from ${name}:${tag}.`;
  throw new NotSupportedError(
    feature,
    alternative,
    `${feature}, is not supported on Runtime. ${alternative}`,
  );
}

/** Blaxel volumes (by name) as Runtime volumes. */
async function resolveVolumes(client: Runtime, volumes: VolumeAttachment[] | undefined) {
  if (!volumes?.length) return [];
  for (const volume of volumes) {
    if (volume.type === "ephemeral")
      throw new NotSupportedError(
        "Ephemeral volumes",
        "Write scratch files under /workspace (or /tmp); they go with the sandbox.",
      );
    if (volume.readOnly)
      throw new NotSupportedError(
        "Read-only volume mounts",
        'Mount it read-write, or give the sandbox a copy with withruntime: { create: { volumes: [{ volumeId, path, mode: "snapshot" }] } }.',
      );
  }
  return Promise.all(
    volumes.map(async (volume) => {
      const found = (await guard(() => client.volumes.list({ name: volume.name! }))).data[0];
      if (!found)
        throw new NotSupportedError(
          `The volume ${volume.name}, which is not a Runtime volume`,
          `Create it first: runtime.volumes.create({ name: "${volume.name}" }) or \`npx withruntime volume create --name ${volume.name}\`.`,
        );
      return { volumeId: found.id, path: toRuntimePath(volume.mountPath!) };
    }),
  );
}

function statusOf(state: string): Status {
  switch (state) {
    case "starting":
      return "DEPLOYING";
    case "stopping":
      return "DELETING";
    case "stopped":
      return "TERMINATED";
    default:
      return "DEPLOYED";
  }
}

/** A sandbox with Blaxel's methods. `sandbox.withruntime` is the Runtime
 * sandbox underneath, for anything Blaxel has no name for. */
export class SandboxInstance {
  readonly fs: SandboxFileSystem;
  readonly network: {
    fetch: (port: number, path?: string, init?: RequestInit) => Promise<Response>;
  };
  readonly process: SandboxProcess;
  readonly previews: SandboxPreviews;
  readonly snapshots: SandboxSnapshotsResource;
  /** Tokens a frontend uses to reach this sandbox directly (Runtime's
   * sandbox sessions). */
  readonly sessions: SandboxSessions;
  readonly schedules: UnsupportedPart = unsupportedPart("sandbox.schedules", SCHEDULES);
  readonly codegen: UnsupportedPart = unsupportedPart("sandbox.codegen", CODEGEN);
  readonly system: UnsupportedPart = unsupportedPart("sandbox.system", SYSTEM);
  readonly drives: UnsupportedPart = unsupportedPart("sandbox.drives", DRIVES);
  /** Blaxel's HTTP/2 session; Runtime's SDK keeps its own connections. */
  h2Session: null = null;
  #rt: RuntimeSandbox;
  readonly #client: Runtime;
  readonly #asked: Asked;
  #deleted = false;
  #renewing: Promise<unknown> | undefined;

  /** Use SandboxInstance.create, createIfNotExists or get. */
  constructor(resolved: Resolved) {
    this.#rt = resolved.runtime;
    this.#client = resolved.client;
    this.#asked = resolved.asked ?? {};
    const run = <T>(work: (runtime: RuntimeSandbox) => Promise<T>) => this.#run(work);
    this.fs = new SandboxFileSystem({ run });
    this.process = new SandboxProcess({
      id: this.#rt.id,
      live: () => this.#live(),
      wake: () => this.#wake(),
      keepAwake: (seconds) => this.#keepAwake(seconds),
      keepAliveEnded: () => this.#giveBackIdle(),
    });
    this.previews = new SandboxPreviews({
      sandboxName: this.name,
      run,
      labels: () => this.#rt.info.labels,
      setLabels: (changes) => this.#setLabels(changes),
    });
    this.snapshots = new SandboxSnapshotsResource({
      sandboxName: this.name,
      sandboxId: this.#rt.id,
      client: this.#client,
      run,
      labels: () => this.#rt.info.labels,
    });
    this.sessions = new SandboxSessions({
      id: this.#rt.id,
      run,
      apiUrl: () => this.#client.transport.baseUrl,
    });
    this.network = { fetch: (port, path, init) => this.fetch(port, path, init) };
  }

  /** The Runtime sandbox underneath: metrics, network rules, desktop,
   * terminals and the rest of Runtime's SDK. */
  get withruntime(): RuntimeSandbox {
    return this.#rt;
  }
  /** The sandbox's name, or its Runtime id when it was made without one. */
  get name(): string {
    return this.#rt.info.name ?? this.#rt.id;
  }
  get metadata(): Metadata {
    const info = this.#rt.info;
    const labels = info.labels ?? {};
    return {
      name: this.name,
      labels: userLabels(labels),
      ...(labels[DISPLAY_NAME] ? { displayName: labels[DISPLAY_NAME] } : {}),
      ...(labels[EXTERNAL_ID] ? { externalId: labels[EXTERNAL_ID] } : {}),
      createdAt: info.createdAt,
      updatedAt: info.readyAt ?? info.createdAt,
    };
  }
  /** From the sandbox's labels, so every client sees the same; the envs,
   * network and volumes only in the client that created it. */
  get spec(): SandboxSpec {
    const asked = this.#asked;
    const labels = this.#rt.info.labels ?? {};
    const own = (key: string) => labels[`${LABEL}${key}`];
    const image =
      own("image") ??
      (typeof this.#rt.info.image === "string" ? this.#rt.info.image : DEFAULT_IMAGE);
    const ports = (own("ports") ?? "")
      .split(",")
      .filter(Boolean)
      .map((port) => ({ target: Number(port), protocol: "HTTP" as const }));
    const lifecycle = own("lifecycle");
    const region = own("region");
    return {
      enabled: true,
      region: region && region !== "auto" ? region : REGION,
      runtime: {
        image,
        memory: this.#rt.info.memoryMiB,
        ...(ports.length ? { ports } : {}),
        ...(asked.envs
          ? { envs: Object.entries(asked.envs).map(([name, value]) => ({ name, value })) }
          : {}),
        ...(own("ttl") ? { ttl: own("ttl") } : {}),
        ...(own("expires") ? { expires: own("expires") } : {}),
      },
      ...(lifecycle ? { lifecycle: JSON.parse(lifecycle) as SandboxLifecycle } : {}),
      ...(asked.network ? { network: asked.network } : {}),
      ...(asked.volumes ? { volumes: asked.volumes } : {}),
    };
  }
  get status(): Status {
    const state = this.#rt.state;
    if ((state === "paused" || state === "pausing") && this.#rt.info.labels?.[ARCHIVED] === "1")
      return "ARCHIVED";
    return statusOf(state);
  }
  /** RUNNING, or STANDBY for a paused sandbox. */
  get state(): "RUNNING" | "STANDBY" | undefined {
    const state = this.#rt.state;
    if (state === "paused" || state === "pausing") return "STANDBY";
    if (state === "running" || state === "starting" || state === "resuming") return "RUNNING";
    return undefined;
  }
  get events(): [] {
    return [];
  }
  get errors(): [] {
    return [];
  }
  get lastUsedAt(): string | undefined {
    return this.#rt.info.lastActiveAt ?? undefined;
  }
  get h2Domain(): null {
    return null;
  }
  /** Seconds until Runtime deletes the sandbox: the end of a lease that ends
   * it, or of a paused one's retention; undefined while not yet known. */
  get expiresIn(): number | undefined {
    const info = this.#rt.info;
    const left = (at: string) => Math.max(0, Math.floor((Date.parse(at) - Date.now()) / 1000));
    if (info.state === "paused" && info.pausedExpiresAt) return left(info.pausedExpiresAt);
    if (
      (info.state === "running" || info.state === "starting" || info.state === "resuming") &&
      info.onLeaseEnd === "stop"
    )
      return left(info.expiresAt);
    return undefined;
  }

  #model(status?: Status): SandboxModel {
    const state = this.state;
    return {
      metadata: this.metadata,
      spec: this.spec,
      status: status ?? this.status,
      ...(state ? { state } : {}),
      events: [],
    };
  }

  // ---- the live sandbox ---------------------------------------------------

  /** The sandbox, ready for a call. A paused one wakes by itself on the call
   * (autoWake); one made without autoWake is woken here. A lease nearing its
   * end is renewed in the background, so a sandbox in use is not paused by
   * its lease. */
  async #live(): Promise<RuntimeSandbox> {
    if (this.#deleted) throw responseError(404, `Sandbox ${this.name} was deleted.`);
    const rt = this.#rt;
    const state = rt.state;
    if ((state === "paused" || state === "pausing") && rt.info.autoWake === false)
      await this.#wake();
    else if (
      state === "running" &&
      rt.info.onLeaseEnd === "pause" &&
      !this.#renewing &&
      Date.parse(rt.info.expiresAt) - Date.now() < RENEW_BELOW_MS
    )
      this.#renewing = rt
        .extend(LEASE_SECONDS)
        .catch(() => undefined)
        .finally(() => (this.#renewing = undefined));
    return this.#rt;
  }

  async #wake() {
    await guard(() => this.#rt.wake({}));
  }

  /** Runs `work` on the live sandbox. A call refused because the sandbox was
   * paused (autoWake off) never started, so it is made again once, after a
   * wake. */
  async #run<T>(work: (runtime: RuntimeSandbox) => Promise<T>): Promise<T> {
    const runtime = await this.#live();
    try {
      return await work(runtime);
    } catch (error) {
      if (codeOf(error) !== "sandbox_paused") throw translate(error);
      await this.#wake();
      return guard(() => work(this.#rt));
    }
  }

  /** Keeps the sandbox awake while a keepAlive process runs: its idle pause
   * becomes the process's time limit (off for one without), and its lease
   * covers that time, up to Runtime's hour. The idle pause it had is kept in
   * the `blaxel/idlePauseSeconds` label, written in the same update and only
   * when absent, to be given back once no keepAlive process runs. */
  async #keepAwake(seconds: number) {
    const rt = await this.#live();
    const forever = seconds >= 86_400;
    const idle = forever ? 0 : Math.max(STANDBY.idlePauseSeconds, Math.ceil(seconds));
    const current = rt.info.idlePauseSeconds;
    const raise = current !== 0 && (idle === 0 || current === undefined || idle > current);
    const labels = rt.info.labels ?? {};
    const need =
      Math.min(LEASE_SECONDS, forever ? LEASE_SECONDS : seconds) -
      (Date.parse(rt.info.expiresAt) - Date.now()) / 1000;
    await Promise.all([
      raise
        ? guard(() =>
            rt.update({
              idlePauseSeconds: idle,
              labels: { ...labels, [IDLE_PAUSE]: labels[IDLE_PAUSE] ?? String(current ?? 0) },
            }),
          )
        : undefined,
      rt.info.onLeaseEnd === "pause" && need >= 1
        ? rt.extend(Math.ceil(need)).catch(() => undefined)
        : undefined,
    ]);
  }

  /** Gives the sandbox back the idle pause it had before keepAlive raised it,
   * once no keepAlive process runs, so no idle time is paid for after: the
   * rule the Python adapter follows too. The label `blaxel/idlePauseSeconds`
   * holds the idle pause to give back; a keepAlive process is one whose
   * command line carries ": rt-blaxel-keep". Any client does it when it sees
   * a keepAlive process end (a waited exec, wait, get), after stop or kill,
   * and in SandboxInstance.get. With no label it costs nothing; a failure is
   * left for the next of those, never thrown. */
  async #giveBackIdle(): Promise<void> {
    const rt = this.#rt;
    const labels = rt.info.labels ?? {};
    const saved = labels[IDLE_PAUSE];
    if (saved === undefined || this.#deleted) return;
    try {
      const running = (await rt.processes.list()).some(
        (one) => one.state === "running" && parseProcessLine(one.command)?.keepAlive,
      );
      if (running) return;
      const rest = { ...labels };
      delete rest[IDLE_PAUSE];
      await rt.update({ idlePauseSeconds: Number(saved), labels: rest });
    } catch {
      // Given back at the next chance.
    }
  }

  async #setLabels(changes: Record<string, string | undefined>) {
    const labels = { ...this.#rt.info.labels };
    for (const [key, value] of Object.entries(changes))
      if (value === undefined) delete labels[key];
      else labels[key] = value;
    await guard(() => this.#rt.update({ labels }));
  }

  /** Sets the sandbox up after a create: its envs, in a file every process
   * reads, and (paid sandboxes) how long a paused one is kept. */
  async #setUp(envs: Record<string, string>, days: number) {
    const rt = this.#rt;
    await Promise.all([
      Object.keys(envs).length
        ? guard(() => rt.exec(envFileCommand(false), { stdin: envFileLines(envs) })).then(
            (result) => {
              if (result.exitCode !== 0)
                throw responseError(
                  500,
                  `Setting the sandbox's envs failed: ${result.stderr.trim()}`,
                );
            },
          )
        : undefined,
      rt.info.funding === "paid" ? guard(() => rt.setRetention(days)) : undefined,
    ]);
  }

  // ---- create, get, list ---------------------------------------------------

  /** Creates a sandbox and answers once it runs. Blaxel's defaults: the base
   * image (Runtime's stock image) and 4096 MB, with vCPUs at one per 2048 MB.
   * Funding is left to Runtime: the free trial while the account has trial
   * time, then prepaid credit. A name another live sandbox holds is refused
   * with a 409, as in Blaxel. */
  static async create<T extends typeof SandboxInstance>(
    this: T,
    sandbox?: SandboxCreateConfiguration | SandboxModel,
    { createIfNotExist = false }: { safe?: boolean; createIfNotExist?: boolean } = {},
  ): Promise<InstanceType<T>> {
    const config = configOf(sandbox);
    const region = config.region || defaultRegion();
    checkRegion(region);
    for (const key of Object.keys(config.extraArgs ?? {}))
      if (key !== "iptables")
        throw new NotSupportedError(
          `The extra argument ${key}`,
          "Remove it; iptables (iptables-legacy) is always there on Runtime.",
        );
    const envs = Object.fromEntries(
      (normalizeEnvs(config.envs) ?? []).map((env) => [env.name, env.value]),
    );
    checkEnvNames(Object.keys(envs));
    normalizePorts(config.ports);
    const volumes = normalizeVolumes(config.volumes);
    const lifetime = lifetimeOf(config);
    const network = config.network ? networkRules(config.network) : undefined;
    const memory = config.memory || DEFAULT_MEMORY;
    const client = clientFor(config);
    const [image, mounts] = await Promise.all([
      guard(() => resolveImage(client, config.image)),
      resolveVolumes(client, volumes),
    ]);
    const labels = labelsFor(config, config.image ?? DEFAULT_IMAGE);
    const input: RuntimeCreate = {
      vcpu: Math.min(MAX_VCPU, Math.max(1, Math.round(memory / MEMORY_PER_VCPU))),
      memoryMiB: memory,
      ...STANDBY,
      timeoutSeconds: lifetime.timeoutSeconds,
      onLeaseEnd: lifetime.onLeaseEnd,
      ...(config.name ? { name: config.name } : {}),
      labels,
      ...(network ? { network } : {}),
      ...(mounts.length ? { volumes: mounts } : {}),
      ...image,
      ...(createIfNotExist && config.name ? { getOrCreate: true } : {}),
      ...config.withruntime?.create,
    };
    const runtime = await guard(() => whenNameFree(client, () => client.sandboxes.create(input)));
    const asked: Asked = {
      ...(Object.keys(envs).length ? { envs } : {}),
      ...(config.network ? { network: config.network } : {}),
      ...(volumes ? { volumes } : {}),
    };
    // A sandbox that already held the name is answered as it is.
    if (runtime.info.reused) return new this({ runtime, client }) as InstanceType<T>;
    const instance = new this({ runtime, client, asked }) as InstanceType<T>;
    try {
      await instance.#setUp(envs, lifetime.days);
    } catch (error) {
      await runtime.stop({ wait: false }).catch(() => undefined);
      throw translate(error);
    }
    return instance;
  }

  /** The named sandbox, or a new one when no live sandbox has the name.
   * Runtime settles a race between two callers: both get the same sandbox. */
  static async createIfNotExists<T extends typeof SandboxInstance>(
    this: T,
    sandbox: SandboxCreateConfiguration | SandboxModel,
  ): Promise<InstanceType<T>> {
    return this.create(sandbox, { createIfNotExist: true });
  }

  /** The live sandbox with this name (or Runtime id). It is not woken: the
   * next call wakes it. */
  static async get<T extends typeof SandboxInstance>(
    this: T,
    sandboxName: string,
    options: RuntimeOptions = {},
  ): Promise<InstanceType<T>> {
    const client = clientFor(options);
    const runtime = await guard(() => findSandbox(client, sandboxName));
    const sandbox = new this({ runtime, client }) as InstanceType<T>;
    await sandbox.#giveBackIdle();
    return sandbox;
  }

  /** The newest live sandbox created with this externalId. */
  static async getByExternalId<T extends typeof SandboxInstance>(
    this: T,
    externalId: string,
    options: RuntimeOptions = {},
  ): Promise<InstanceType<T>> {
    const client = clientFor(options);
    const runtime = await guard(() => findByExternalId(client, externalId));
    return new this({ runtime, client }) as InstanceType<T>;
  }

  /** Live sandboxes, oldest first, a page at a time; `for await` walks them
   * all. `externalId` narrows; `showTerminated` adds ended ones. */
  static async list<T extends typeof SandboxInstance>(
    this: T,
    query: SandboxListQuery = {},
    options: RuntimeOptions = {},
  ): Promise<PaginatedList<InstanceType<T>>> {
    for (const field of ["cursor", "q", "anchor"] as const)
      if (query[field] !== undefined)
        throw new NotSupportedError(
          `Listing sandboxes by ${field}`,
          "List them (oldest first) and filter the result yourself; nextPage() walks the pages.",
        );
    if (query.sort !== undefined && query.sort !== "createdAt:asc")
      throw new NotSupportedError(
        `Listing sandboxes sorted by ${query.sort}`,
        "Runtime lists them oldest first: sort the result yourself.",
      );
    if (query.status !== undefined && query.status !== "DEPLOYED")
      throw new NotSupportedError(
        `Listing sandboxes by status ${query.status}`,
        "List them and filter by sandbox.status yourself.",
      );
    const client = clientFor(options);
    const page = await guard(() =>
      client.sandboxes.list({
        ...(query.externalId ? { labels: { [EXTERNAL_ID]: query.externalId } } : {}),
        ...(query.showTerminated ? { includeStopped: true } : {}),
        ...(query.limit ? { limit: Math.min(query.limit, 100) } : {}),
      }),
    );
    return paginate(page, (runtime) => new this({ runtime, client }) as InstanceType<T>);
  }

  /** Deletes the sandbox: it ends at once, its files and memory with it. */
  static async delete(sandboxName: string, options: RuntimeOptions = {}): Promise<SandboxModel> {
    return (await this.get(sandboxName, options)).delete();
  }
  async delete(): Promise<SandboxModel> {
    if (this.#deleted) throw responseError(404, `Sandbox ${this.name} was deleted.`);
    await guard(() => this.#rt.stop({ wait: false }));
    this.#deleted = true;
    for (const key of accesses.keys()) if (key.startsWith(`${this.#rt.id}:`)) accesses.delete(key);
    return this.#model("DELETING");
  }

  // ---- updates -------------------------------------------------------------

  /** Replaces the labels (when given), the display name and the externalId. */
  static async updateMetadata(
    sandboxName: string,
    metadata: SandboxUpdateMetadata,
    options: RuntimeOptions = {},
  ): Promise<SandboxInstance> {
    const sandbox = await this.get(sandboxName, options);
    const current = sandbox.#rt.info.labels;
    const labels = {
      ...(metadata.labels ?? userLabels(current)),
      ...ownLabels(current),
      ...(metadata.displayName !== undefined ? { [DISPLAY_NAME]: metadata.displayName } : {}),
      ...(metadata.externalId !== undefined ? { [EXTERNAL_ID]: metadata.externalId } : {}),
    };
    await guard(() => sandbox.#rt.update({ labels }));
    return sandbox;
  }

  /** A new TTL (null: none): how long a paused sandbox is kept follows it, as
   * at create. A running lease is not shortened. */
  static async updateTtl(
    sandboxName: string,
    ttl: string | null,
    options: RuntimeOptions = {},
  ): Promise<SandboxInstance> {
    const sandbox = await this.get(sandboxName, options);
    const labels = sandbox.#rt.info.labels ?? {};
    const lifetime = lifetimeOf({
      ttl: ttl || null,
      ...(labels[`${LABEL}expires`] ? { expires: new Date(labels[`${LABEL}expires`]!) } : {}),
      ...(labels[`${LABEL}lifecycle`]
        ? { lifecycle: JSON.parse(labels[`${LABEL}lifecycle`]!) as SandboxLifecycle }
        : {}),
    });
    await Promise.all([
      sandbox.#setLabels({ [`${LABEL}ttl`]: ttl || undefined }),
      sandbox.#rt.info.funding === "paid"
        ? guard(() => sandbox.#rt.setRetention(lifetime.days))
        : undefined,
    ]);
    return sandbox;
  }

  /** A new lifecycle (null: none), as updateTtl. */
  static async updateLifecycle(
    sandboxName: string,
    lifecycle: SandboxLifecycle | null,
    options: RuntimeOptions = {},
  ): Promise<SandboxInstance> {
    const sandbox = await this.get(sandboxName, options);
    const labels = sandbox.#rt.info.labels ?? {};
    const lifetime = lifetimeOf({
      lifecycle,
      ...(labels[`${LABEL}ttl`] ? { ttl: labels[`${LABEL}ttl`]! } : {}),
      ...(labels[`${LABEL}expires`] ? { expires: new Date(labels[`${LABEL}expires`]!) } : {}),
    });
    await Promise.all([
      sandbox.#setLabels({
        [`${LABEL}lifecycle`]: lifecycle ? JSON.stringify(lifecycle) : undefined,
      }),
      sandbox.#rt.info.funding === "paid"
        ? guard(() => sandbox.#rt.setRetention(lifetime.days))
        : undefined,
    ]);
    return sandbox;
  }

  /** Replaces the sandbox's network rules. */
  static async updateNetwork(
    sandboxName: string,
    network: SandboxUpdateNetwork,
    options: RuntimeOptions = {},
  ): Promise<SandboxInstance> {
    const sandbox = await this.get(sandboxName, options);
    const rules = networkRules(network.network ?? {});
    await sandbox.#run((runtime) => runtime.network.set(rules));
    if (network.network) sandbox.#asked.network = network.network;
    return sandbox;
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Deprecated in Blaxel: a sandbox is ready when create answers. */
  async wait(_options: { maxWait?: number; interval?: number } = {}): Promise<this> {
    return this;
  }

  /** Archives the sandbox: on Runtime it pauses, keeping its files and also
   * its memory and processes. The next call, or unarchive, wakes it. */
  static async archive(
    sandboxName: string,
    options: SandboxArchiveOptions & RuntimeOptions = {},
  ): Promise<SandboxInstance> {
    return (await this.get(sandboxName, options)).archive(options);
  }
  async archive(options: SandboxArchiveOptions = {}): Promise<this> {
    await this.#live();
    await this.#setLabels({ [ARCHIVED]: "1" });
    if (this.#rt.state !== "paused" && this.#rt.state !== "pausing")
      await guard(() => this.#rt.pause({ wait: options.wait !== false }));
    return this;
  }
  static async unarchive(
    sandboxName: string,
    options: SandboxArchiveOptions & RuntimeOptions = {},
  ): Promise<SandboxInstance> {
    return (await this.get(sandboxName, options)).unarchive(options);
  }
  async unarchive(options: SandboxArchiveOptions = {}): Promise<this> {
    await this.#live();
    await this.#setLabels({ [ARCHIVED]: undefined });
    if (this.#rt.state === "paused" || this.#rt.state === "pausing")
      await guard(() => this.#rt.wake({ wait: options.wait !== false }));
    return this;
  }

  // ---- ports -------------------------------------------------------------------

  /** A request to a port inside the sandbox, through a private preview of
   * that port (made on first use, then reused) and its token. */
  async fetch(port: number, path = "/", init?: RequestInit): Promise<Response> {
    const key = `${this.#rt.id}:${port}`;
    let access = accesses.get(key);
    if (!access || access.until - Date.now() < 60_000) {
      access = await this.#run((runtime) => portAccess(runtime, port));
      accesses.set(key, access);
    }
    const headers = new Headers(init?.headers);
    if (access.token) headers.set("x-runtime-preview-token", access.token);
    return fetch(`${access.url}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers });
  }

  // ---- snapshots and forks ----------------------------------------------------

  /** Deprecated in Blaxel: sandbox.snapshots.create(name). */
  async snapshot(name?: string): Promise<SandboxSnapshot> {
    return modelOfSnapshot(await this.snapshots.create(name));
  }
  /** Deprecated in Blaxel: sandbox.snapshots.list(). */
  async listSnapshots(): Promise<SandboxSnapshot[]> {
    return (await this.snapshots.list()).map(modelOfSnapshot);
  }
  /** Deprecated in Blaxel: sandbox.snapshots.delete(name). */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.snapshots.delete(snapshotId);
  }
  restore(snapshotId: string): Promise<SandboxRestoreResponse> {
    return this.snapshots.restore(snapshotId);
  }

  /** A new sandbox named `targetName`: a copy of this one as it is now
   * (files, memory and running processes), or started from a snapshot with
   * `snapshotId`. `envs` are added over this sandbox's. */
  async fork(targetName: string, options: SandboxForkOptions = {}): Promise<SandboxForkResponse> {
    if (options.lifecycle !== undefined)
      throw new NotSupportedError(
        "Overriding lifecycle during a fork",
        "Omit lifecycle to use the existing Runtime fork behavior.",
      );
    refuseApplication(options);
    const envs = envRecord(options.envs);
    checkEnvNames(Object.keys(envs));
    const labels = userLabels(this.#rt.info.labels);
    if (options.snapshotId !== undefined) {
      const id = await this.snapshots.idOf(options.snapshotId);
      await startFromSnapshot(this.#client, id, targetName, labels, envs);
      return { name: targetName, snapshotId: id, type: "sandbox" };
    }
    const copy = await this.#run((runtime) =>
      whenNameFree(this.#client, () => runtime.fork({ name: targetName, labels })),
    );
    try {
      await Promise.all([
        appendEnvs(copy, envs),
        copy.info.funding === "paid" ? guard(() => copy.setRetention(KEEP_DAYS)) : undefined,
      ]);
    } catch (error) {
      await copy.stop({ wait: false }).catch(() => undefined);
      throw error;
    }
    return { name: targetName, snapshotId: "", type: "sandbox" };
  }

  /** A sandbox reached with a session instead of a key: what a frontend
   * does with the session its backend made. Commands, processes, files and
   * previews work; anything that manages the sandbox is refused by Runtime. */
  static async fromSession<T extends typeof SandboxInstance>(
    this: T,
    session: SessionWithToken,
  ): Promise<InstanceType<T>> {
    const { client, runtime } = await sessionSandbox(session);
    return new this({ runtime, client }) as InstanceType<T>;
  }
}

function modelOfSnapshot(snapshot: {
  id: string;
  name: string;
  status: string;
  workspace: string;
  createdAt: string;
  source?: SandboxSnapshot["source"];
  spec?: SandboxSnapshot["spec"];
}): SandboxSnapshot {
  return {
    id: snapshot.id,
    name: snapshot.name,
    status: snapshot.status,
    workspace: snapshot.workspace,
    createdAt: snapshot.createdAt,
    ...(snapshot.source ? { source: snapshot.source, sandboxName: snapshot.source.name } : {}),
    ...(snapshot.spec ? { spec: snapshot.spec } : {}),
  };
}
