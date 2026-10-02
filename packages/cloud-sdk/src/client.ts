import { WAIT_FOR_TIMEOUT_SECONDS } from "./api-defaults.js";
import { RuntimeError } from "./errors.js";
import type { Page } from "./page.js";
import { clientFactories, clientProductAliases, type ClientExtensions } from "./products/index.js";
import { usageExport as makeUsageExport } from "./products/observability.js";
import { Sandbox, deleteSandbox, sandboxPage } from "./sandbox.js";
import { Snapshots } from "./snapshots.js";
import { Transport, missingKey, type RequestOptions } from "./transport.js";
import type { CreateSandbox, DeletedSandbox, FeedbackKind, SandboxInfo, Usage } from "./types.js";

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
  /** Calls in flight at once; more wait their turn and reuse connections. Default 32. */
  maxConnections?: number;
  /** How long `sandboxes.create` keeps retrying, with the same key and input,
   * when the trial's slots, the account's quota or the region is full
   * (trial_busy, quota_exceeded, no_capacity and the like). Default 120 000
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
    this.transport = new Transport({
      // A key given, then RUNTIME_API_KEY, then (in Node and Bun) the key
      // `runtime login` saved for this machine, read on the first call.
      apiKey: options.apiKey ?? env("RUNTIME_API_KEY") ?? (() => savedKey(this.transport.baseUrl)),
      baseUrl: options.baseUrl ?? env("RUNTIME_API_URL"),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
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
  /** Balance, holds, trial time and per-resource charges, in integer microdollars. */
  /** Credit, holds, trial time and per-resource charges. */
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

/** How `sandboxes.create` waits when every trial slot, the account's quota or
 * the region is full. */
export type CreateOptions = RequestOptions & {
  /** How long to keep retrying a refusal that clears by itself. Default: the
   * client's, two minutes; 0 fails at once. */
  waitForCapacityMs?: number;
  /** Called before each wait, with the refusal and the milliseconds until the
   * next try: to tell a person why nothing has happened yet. */
  onCapacityWait?: (refusal: RuntimeError, waitMs: number) => void;
};

export class Sandboxes {
  constructor(private readonly t: Transport) {}
  /** Creates a sandbox and waits until it is running. Every field is optional:
   * with none you get the free trial while it lasts, the default region and a
   * 2 vCPU / 4 GiB machine from a warm template. `wait: false` returns at once.
   * When every trial slot or the account's quota is taken, it waits for one to
   * free, up to `waitForCapacityMs` (the client's, two minutes by default). */
  async create(
    input: CreateSandbox & { wait?: boolean } = {},
    options: CreateOptions = {},
  ): Promise<Sandbox> {
    const { wait, ...body } = input;
    const info = await this.t.json<SandboxInfo>({
      method: "POST",
      path: "/v1/sandboxes",
      body,
      wait: wait === false ? 0 : 60,
      ...options,
      waitForCapacityMs: options.waitForCapacityMs ?? this.t.waitForCapacityMs,
    });
    const sandbox = new Sandbox(this.t, info);
    if (wait !== false && info.state !== "running") {
      await sandbox.waitFor("running", {
        timeoutSeconds: WAIT_FOR_TIMEOUT_SECONDS,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        idempotencyKey: options.idempotencyKey,
      });
      if (sandbox.state !== "running")
        throw new RuntimeError({
          message: `Sandbox ${info.id} is ${sandbox.state}, not running.`,
          code: "start_failed",
          status: 0,
          hint: "Read it with runtime.sandboxes.get(id); stopReason says why.",
        });
    }
    return sandbox;
  }
  /** The sandbox named `name` in this account, ready to use: running as it
   * is, woken if it is paused, restarted if it is stopped and persistent, or
   * created with `input` when no sandbox has the name. `sandbox.info.reused`
   * says which. The other fields apply only when it is created. */
  async getOrCreate(
    name: string,
    input: Omit<CreateSandbox, "name" | "getOrCreate"> & { wait?: boolean } = {},
    options: CreateOptions = {},
  ): Promise<Sandbox> {
    return this.create({ ...input, name, getOrCreate: true }, options);
  }
  async get(id: string, options: RequestOptions = {}): Promise<Sandbox> {
    return new Sandbox(
      this.t,
      await this.t.json<SandboxInfo>({
        method: "GET",
        path: `/v1/sandboxes/${encodeURIComponent(id)}`,
        ...options,
      }),
    );
  }
  /** Deletes a sandbox for good, by id, without reading it first: see
   * `sandbox.delete()`. Deleting it again answers the same. */
  delete(id: string, options: RequestOptions = {}): Promise<DeletedSandbox> {
    return deleteSandbox(this.t, id, options);
  }
  /** Live sandboxes, oldest first. Await for a page, or `for await` over all.
   * Request options apply to the initial request and every subsequent page. */
  async list(
    filter: {
      state?: SandboxInfo["state"][];
      includeStopped?: boolean;
      /** Every label must match. */
      labels?: Record<string, string>;
      name?: string;
      limit?: number;
    } = {},
    options: RequestOptions = {},
  ): Promise<Page<Sandbox>> {
    const query = {
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.includeStopped ? { includeStopped: true } : {}),
      ...(filter.labels
        ? { label: Object.entries(filter.labels).map(([k, v]) => `${k}:${v}`) }
        : {}),
      ...(filter.name ? { name: filter.name } : {}),
      ...(filter.limit ? { limit: filter.limit } : {}),
    };
    return sandboxPage(
      this.t,
      await this.t.json({ method: "GET", path: "/v1/sandboxes", query, ...options }),
      query,
      options,
    );
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
