import { clientFactories, clientProductAliases, type ClientExtensions } from "./products/index.js";
import { usageExport as makeUsageExport } from "./products/observability.js";
import { Machines } from "./machine.js";
import { SANDBOXES, Sandbox } from "./sandbox.js";
import { Snapshots } from "./snapshots.js";
import { DEFAULT_BASE_URL, Transport, missingKey, type RequestOptions } from "./transport.js";
import type { CreateSandbox, DeletedSandbox, FeedbackKind, SandboxInfo, Usage } from "./types.js";

export type { CreateOptions } from "./machine.js";

export type RuntimeOptions = {
  /** Default: the RUNTIME_API_KEY environment variable. */
  apiKey?: string;
  /** Default: RUNTIME_API_URL, then https://api.withruntime.com. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per call, queue and retries included. Default 5 minutes; 0 disables it. */
  timeoutMs?: number;
  /** Retries of transport failures, 429, 502, 503 and 504. Default 4. */
  maxRetries?: number;
  /** Connections held at once, calls and streams (a command's output, a
   * download) together; more wait their turn, first come first served, and
   * reuse them. Default 48: one address may hold 64 connections to the API
   * before it has used a valid key. 8 are kept for calls whatever the
   * streams hold. */
  maxConnections?: number;
  /** Called each time a call has to wait for one of those connections: an
   * adapter warns with it, once, that its caller is being held back. */
  onQueued?: (maxConnections: number) => void;
  /** How long `sandboxes.create` keeps retrying, with the same key and input,
   * when the slots without credit, the account's quota or the region is full
   * (no_credit_running_limit, quota_exceeded, no_capacity and the like). Default 120 000
   * (two minutes); 0 fails at once. The refusal is thrown as it came when the
   * wait runs out. */
  waitForCapacityMs?: number;
};

/** The key `runtime login` saved for this machine and this API origin, found
 * on first use. A constructor override must never receive another API's key. */
const savedKey = async (apiOrigin: string): Promise<string> => {
  if (typeof process === "undefined" || !process.versions?.node) throw missingKey();
  const { resolveCredential } = await import("./credentials.js");
  return resolveCredential({ ...process.env, RUNTIME_API_URL: apiOrigin });
};

const env = (name: string) =>
  typeof process === "undefined"
    ? undefined
    : (process.env as Record<string, string | undefined>)[name];

/** One client for every Runtime Cloud product. Create it once and reuse it:
 * it keeps its connections open. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type
export interface Runtime extends ClientExtensions {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Runtime {
  readonly transport: Transport;
  /** The sandbox product; `sandboxes` remains the same client for compatibility. */
  readonly sandbox: Sandboxes;
  readonly sandboxes: Sandboxes;
  readonly snapshot: Snapshots;
  readonly snapshots: Snapshots;
  readonly feedback: FeedbackApi;
  readonly support: SupportApi;
  readonly account: AccountApi;
  /** Date-range settlements, paged with exact charges and the server's CSV. */
  readonly usageExport: ReturnType<typeof makeUsageExport>;
  constructor(options: RuntimeOptions = {}) {
    // The saved key is found by the origin as given, as `runtime login` saved
    // it; the calls go where that origin is reachable from here, which in a
    // sandbox is runtime.internal (transport.ts, `reachable`).
    const origin = options.baseUrl || env("RUNTIME_API_URL") || DEFAULT_BASE_URL;
    this.transport = new Transport({
      // A key given, then RUNTIME_API_KEY, then (in Node and Bun) the key
      // `runtime login` saved for this machine, read on the first call.
      apiKey: options.apiKey ?? env("RUNTIME_API_KEY") ?? (() => savedKey(origin)),
      baseUrl: options.baseUrl ?? env("RUNTIME_API_URL"),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
      ...(options.onQueued ? { onQueued: options.onQueued } : {}),
      ...(options.waitForCapacityMs !== undefined
        ? { waitForCapacityMs: options.waitForCapacityMs }
        : {}),
    });
    this.sandboxes = new Sandboxes(this.transport);
    this.sandbox = this.sandboxes;
    this.snapshots = new Snapshots(this.transport);
    this.snapshot = this.snapshots;
    this.feedback = new FeedbackApi(this.transport);
    this.support = new SupportApi(this.transport);
    this.account = new AccountApi(this.transport);
    this.usageExport = makeUsageExport(this.transport);
    for (const [name, make] of clientFactories())
      Object.defineProperty(this, name, { value: make(this.transport), enumerable: true });
    for (const [alias, name] of Object.entries(clientProductAliases))
      Object.defineProperty(this, alias, { value: this[name], enumerable: true });
  }
  /** Who this key is: organization, agent and credential. */
  me(options: RequestOptions = {}) {
    return this.transport.json<{
      orgId: string;
      principalId: string;
      credentialId: string | null;
      apiVersion: string;
      /** The account's name. */
      orgName?: string | null;
      /** The role of the member who made this key: owner, admin, developer or billing. */
      role?: string | null;
    }>({
      method: "GET",
      path: "/v1/me",
      ...options,
    });
  }
  /** Balance, holds, free time and per-resource charges, in integer microdollars. */
  /** Credit, holds, free time and per-resource charges. */
  usage(options: RequestOptions = {}) {
    return this.transport.json<Usage>({
      method: "GET",
      path: "/v1/usage",
      ...options,
    });
  }
  /** This account's authenticated API answers, in hourly windows. Counts are
   * exact decimal strings, and an empty window has a null error percentage.
   * A key needs usage permission. */
  usageRequests(range: "24h" | "7d" | "30d" | "90d" = "24h", options: RequestOptions = {}) {
    return this.transport.json<{
      range: "24h" | "7d" | "30d" | "90d";
      since: string;
      until: string;
      calls: string;
      clientErrors: string;
      serverErrors: string;
      errorPercent: number | null;
      operations: Array<{
        operation: string;
        calls: string;
        clientErrors: string;
        serverErrors: string;
        errorPercent: number | null;
      }>;
    }>({
      method: "GET",
      path: "/v1/usage/requests",
      query: { range },
      ...options,
    });
  }
}

/** `runtime.sandboxes`: the sandbox product of the machine engine. */
export class Sandboxes extends Machines<Sandbox, SandboxInfo, CreateSandbox, DeletedSandbox> {
  constructor(t: Transport) {
    super(SANDBOXES, t, (transport, info) => new Sandbox(transport, info));
  }
}

export class FeedbackApi {
  constructor(private readonly t: Transport) {}
  /** Tell the Runtime team something. Please do, generously: bugs, missing
   * features, what another provider does better, what blocks a migration. */
  submit(
    input: {
      kind: FeedbackKind;
      summary: string;
      detail?: string;
      competitor?: string;
      resourceId?: string;
      requestId?: string;
      context?: Record<string, unknown>;
    },
    options: RequestOptions = {},
  ) {
    return this.t.json<{ id: string; duplicate: boolean; message?: string }>({
      method: "POST",
      path: "/v1/feedback",
      body: input,
      ...options,
    });
  }
  list(options: { limit?: number } = {}) {
    return this.t.json<{
      data: Array<{
        id: string;
        kind: FeedbackKind;
        summary: string;
        status: string;
        /** False until the hourly triage sorts the report into an item. */
        sorted: boolean;
        /** Plain words on where the report stands. */
        note: string;
        item: unknown;
      }>;
    }>({
      method: "GET",
      path: "/v1/feedback",
      query: { limit: options.limit },
    });
  }
}

export type SupportReply = {
  conversationId: string;
  status: "answered" | "working" | "escalated" | "waiting_customer" | "capped";
  reply?: string;
  pendingActions?: Array<{
    id: string;
    action: string;
    resourceId?: string;
    summary: string;
    inputHash: string;
    expiresAt: string;
  }>;
};

export class SupportApi {
  constructor(private readonly t: Transport) {}
  /** Ask Runtime support. If status is "working", read() it again in a minute. */
  message(input: {
    message?: string;
    conversationId?: string;
    approveActionId?: string;
    approveInputHash?: string;
    denyActionId?: string;
  }) {
    return this.t.json<SupportReply>({
      method: "POST",
      path: "/v1/support/messages",
      body: input,
      retry: false,
      timeoutMs: 120_000,
    });
  }
  read(conversationId: string) {
    return this.t.json<SupportReply>({
      method: "GET",
      path: `/v1/support/conversations/${encodeURIComponent(conversationId)}`,
    });
  }
}

/** What closing the account answered. */
export type ClosedAccount = {
  orgId: string;
  name: string;
  closedAt: string;
  /** False while what was running is still stopping; it is gone within minutes. */
  released: boolean;
};

/** The account this key belongs to: `runtime.account`. */
export class AccountApi {
  constructor(private readonly t: Transport) {}
  /** Close the account for good: stop and delete everything it runs and
   * stores, end every key and dissolve it. `confirm` must be the account's
   * name exactly (`me().orgName`). Needs a key for every product made by an
   * owner. Moves no money: what is unspent of a purchase made in the last 15
   * days is refunded on request; other credit is forfeited. */
  close(input: { confirm: string }, options: RequestOptions = {}) {
    return this.t.json<ClosedAccount>({
      method: "POST",
      path: "/v1/account:close",
      body: { confirm: input.confirm },
      retry: false,
      ...options,
    });
  }
}

let shared: Runtime | undefined;
/** The client behind the static helpers, from the environment. */
export function defaultClient(): Runtime {
  shared ??= new Runtime();
  return shared;
}
