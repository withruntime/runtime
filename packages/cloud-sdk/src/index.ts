/** Runtime Cloud: one client for every product. Sandboxes first.
 *
 *   import { Sandbox } from "withruntime";
 *   await using sbx = await Sandbox.create();
 *   console.log((await sbx.exec("echo hello")).stdout);
 */
import type { Runtime } from "./client.js";
import { defaultClient, type CreateOptions, type RuntimeOptions } from "./client.js";
import { Sandbox as SandboxClass } from "./sandbox.js";
import type { CreateSandbox, KeepAliveOptions } from "./types.js";
import type { RequestOptions } from "./transport.js";
import { identityToken } from "./identity.js";

export {
  Runtime,
  Sandboxes,
  FeedbackApi,
  SupportApi,
  type CreateOptions,
  type RuntimeOptions,
  type SupportReply,
} from "./client.js";
export {
  Files,
  Process,
  Processes,
  SandboxSessions,
  Terminal,
  type CreatedSandboxSession,
  type SandboxSession,
} from "./sandbox.js";
export { Tunnel, TunnelStream, type PortForward } from "./tunnel.js";
export { Page } from "./page.js";
export type { KeyLimits } from "./products/limits.js";
export type { AuditEvent, AuditPage } from "./products/audit.js";
export type {
  UsageExportQuery,
  UsageExportRow,
  UsageExportPage,
} from "./products/observability.js";
export type { JobSecret, Secret, SecretRule, SecretUse, SetSecret } from "./products/secrets.js";
export { SecretPartlyStoredError } from "./products/secrets.js";
export type { McpCatalogEntry, McpGateway, McpServerRequest } from "./products/mcp.js";
export type {
  FileEvent,
  FileEventType,
  WatchHandle,
  WatchNotice,
  WatchOptions,
} from "./products/watch.js";
export type { Mount, MountBucket } from "./products/mounts.js";
export type {
  TailscaleJoin,
  TailscaleJoined,
  TailscaleNode,
  TailscaleStatus,
} from "./products/tailscale.js";
export type { Volume, VolumeBackup, CreateVolume, VolumeAttachment } from "./products/volumes.js";
export type {
  CreateJob,
  Job,
  JobCompute,
  JobDefinition,
  JobLogs,
  JobRun,
  JobRunState,
  JobSchedule,
} from "./products/jobs.js";
export type {
  CheckedDomain,
  DnsRecord,
  Domain,
  EgressAddress,
  TcpPort,
  Tunnel as PrivateTunnel,
  TunnelPeer,
  TunnelPeerCreated,
  SetUpstreamProxy,
  UpstreamProxy,
} from "./products/network-products.js";
export type { PrivateNetwork } from "./products/private-network.js";
export {
  verifyWebhook,
  WebhookVerificationError,
  type MetricPoint,
  type MetricRange,
  type OtelExport,
  type RuntimeEvent,
  type SandboxMetrics,
  type Webhook,
  type WebhookDelivery,
  type WebhookEventType,
} from "./products/observability.js";
export { Snapshots, type Snapshot, type SnapshotOptions } from "./snapshots.js";
export { Transport, VERSION, apiOrigin, type RequestOptions, type Call } from "./transport.js";
export * from "./errors.js";
export type * from "./types.js";

/** A sandbox. `Sandbox.create()` uses RUNTIME_API_KEY; `runtime.sandboxes`
 * does the same with an explicit client. */
export class Sandbox extends SandboxClass {
  /** Creates a sandbox (every field optional) and waits until it is running.
   * With no `timeoutSeconds` it runs while it works and pauses when idle.
   * `keepAlive: true` (or its options) carries one with a time limit past it
   * until you stop it; see `sandbox.keepAlive()`. */
  static async create(
    input: CreateSandbox & { wait?: boolean; keepAlive?: boolean | KeepAliveOptions } = {},
    options: CreateOptions & { client?: Runtime } = {},
  ): Promise<SandboxClass> {
    const { client, ...rest } = options;
    const { keepAlive, ...body } = input;
    const sandbox = await (client ?? defaultClient()).sandboxes.create(body, rest);
    if (keepAlive) sandbox.keepAlive(keepAlive === true ? {} : keepAlive);
    return sandbox;
  }
  /** The sandbox named `name` in this account, ready to use: running as it
   * is, woken if it is paused, restarted if it is stopped and persistent, or
   * created with `input` when no sandbox has the name. `sandbox.info.reused`
   * says which. The other fields apply only when it is created. */
  static async getOrCreate(
    name: string,
    input: Omit<CreateSandbox, "name" | "getOrCreate"> & {
      wait?: boolean;
      keepAlive?: boolean | KeepAliveOptions;
    } = {},
    options: CreateOptions & { client?: Runtime } = {},
  ): Promise<SandboxClass> {
    return Sandbox.create({ ...input, name, getOrCreate: true }, options);
  }
  /** Reconnects to an existing sandbox by id. */
  static async connect(
    id: string,
    options: RequestOptions & { client?: Runtime } = {},
  ): Promise<SandboxClass> {
    const { client, ...rest } = options;
    return (client ?? defaultClient()).sandboxes.get(id, rest);
  }
  static list(
    filter: Parameters<Runtime["sandboxes"]["list"]>[0] = {},
    options: { client?: Runtime } = {},
  ) {
    return (options.client ?? defaultClient()).sandboxes.list(filter);
  }
  /** Inside a sandbox: an OIDC token naming this sandbox, for `audience`
   * (AWS: "sts.amazonaws.com"). No API key needed. See `identityToken`. */
  static identityToken(input: {
    audience: string;
    lifetimeSeconds?: number;
    signal?: AbortSignal;
  }) {
    return identityToken(input);
  }
}
export type { RuntimeOptions as ClientOptions };
export { identityToken, type IdentityToken } from "./identity.js";
export {
  openWalletAccount,
  claimWalletAccount,
  type OpenedWalletAccount,
  type WalletClaim,
  type WalletOptions,
} from "./wallet.js";
export type { Topup } from "./products/billing.js";
export type { SsoConnection, SsoStatus } from "./products/sso.js";
