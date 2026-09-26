import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";

/* Observability: a sandbox's CPU and memory over time, the account's
 * lifecycle events, webhooks, and OpenTelemetry export.
 *
 *   const m = await sbx.metrics({ range: "1h" });
 *   const hook = await runtime.webhooks.create({ url: "https://example.com/hooks/runtime" });
 *   const event = await verifyWebhook(body, request.headers.get("runtime-signature"), secret);
 */

export type MetricRange = "15m" | "1h" | "6h" | "24h" | "7d" | "30d";
export type MetricPoint = {
  /** Start of the bucket, ISO 8601. */
  at: string;
  /** Average CPU, percent of all the sandbox's vCPUs (0-100). */
  cpuPercent: number | null;
  /** The same average as a number of cores. */
  cpuCores: number | null;
  /** The busiest interval between two readings in the bucket. */
  cpuPeakPercent: number | null;
  /** Average resident memory, bytes. */
  memoryBytes: number;
  memoryPeakBytes: number;
  /** Host readings in the bucket. */
  samples: number;
};
export type SandboxMetrics = {
  sandboxId: string;
  range: MetricRange;
  stepSeconds: number;
  since: string;
  until: string;
  vcpu: number;
  memoryLimitBytes: number;
  diskLimitBytes: number;
  state: string;
  /** The newest reading, or null when there is none in the last 15 minutes. */
  latest: MetricPoint | null;
  points: MetricPoint[];
};

export type WebhookEventType =
  | "sandbox.created"
  | "sandbox.running"
  | "sandbox.paused"
  | "sandbox.woken"
  | "sandbox.stopped"
  | "sandbox.start_failed"
  | "sandbox.wake_failed"
  | "snapshot.ready"
  | "snapshot.failed"
  | "snapshot.deleted"
  | "volume.ready"
  | "volume.failed"
  | "volume.deleted";
/** An event as /v1/events lists it and a webhook delivers it. */
export type RuntimeEvent = {
  id: string;
  type: WebhookEventType | "webhook.test";
  createdAt: string;
  resourceId?: string | null;
  /** The resource as it was: `data.sandbox`, `data.snapshot` or `data.volume`. */
  data: Record<string, unknown>;
};
export type Webhook = {
  id: string;
  url: string;
  description: string | null;
  events: Array<WebhookEventType | "*">;
  enabled: boolean;
  /** The secret's last four characters. */
  secretHint: string;
  previousSecretExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** The first failure since the last success, or null while it succeeds. */
  failingSince: string | null;
  /** The signing secret: only on create and rotateSecret. Keep it. */
  secret?: string;
};
export type WebhookDelivery = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  resourceId: string | null;
  state: "pending" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  /** The HTTP status your endpoint answered. */
  lastStatus: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
};
export type OtelExport = {
  id: string;
  endpoint: string;
  /** Header names only; values are never shown back. */
  headerNames: string[];
  signals: Array<"logs" | "metrics">;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  failures: number;
  exportedEvents: number;
  exportedPoints: number;
};
type List<T> = { data: T[]; nextCursor: string | null };

/** `sbx.metrics()`: this sandbox's measured CPU and memory. */
export function sandboxMetrics(t: Transport, sandbox: Sandbox) {
  return (options: { range?: MetricRange } & RequestOptions = {}) => {
    const { range, ...rest } = options;
    return t.json<SandboxMetrics>({
      method: "GET",
      path: `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/metrics`,
      query: { range },
      ...rest,
    });
  };
}

/** `runtime.events.list()`: lifecycle events, newest first. */
export function events(t: Transport) {
  return {
    list: (
      filter: {
        resourceId?: string;
        type?: WebhookEventType;
        cursor?: string;
        limit?: number;
      } = {},
      options?: RequestOptions,
    ) =>
      t.json<List<RuntimeEvent>>({ method: "GET", path: "/v1/events", query: filter, ...options }),
  };
}

/** `runtime.webhooks`: signed lifecycle events POSTed to your URL. */
export function webhooks(t: Transport) {
  const one = (id: string, verb = "") => `/v1/webhooks/${encodeURIComponent(id)}${verb}`;
  return {
    /** Returns the webhook with `secret`, shown this once. */
    create: (
      input: { url: string; events?: Array<WebhookEventType | "*">; description?: string },
      options?: RequestOptions,
    ) => t.json<Webhook>({ method: "POST", path: "/v1/webhooks", body: input, ...options }),
    list: (options?: RequestOptions) =>
      t.json<List<Webhook>>({ method: "GET", path: "/v1/webhooks", ...options }),
    get: (id: string, options?: RequestOptions) =>
      t.json<Webhook>({ method: "GET", path: one(id), ...options }),
    update: (
      id: string,
      patch: {
        url?: string;
        events?: Array<WebhookEventType | "*">;
        description?: string | null;
        enabled?: boolean;
      },
      options?: RequestOptions,
    ) => t.json<Webhook>({ method: "POST", path: one(id, ":update"), body: patch, ...options }),
    /** A new secret, returned once. The old one keeps signing beside it for
     * `keepPreviousSeconds` (a day by default, a week at most; 0 ends it now). */
    rotateSecret: (
      id: string,
      input: { keepPreviousSeconds?: number } = {},
      options?: RequestOptions,
    ) =>
      t.json<Webhook>({ method: "POST", path: one(id, ":rotate-secret"), body: input, ...options }),
    delete: (id: string, options?: RequestOptions) =>
      t.json<Webhook>({ method: "POST", path: one(id, ":delete"), ...options }),
    /** Sends a signed `webhook.test` now and answers how your endpoint replied. */
    test: (id: string, options?: RequestOptions) =>
      t.json<WebhookDelivery>({ method: "POST", path: one(id, ":test"), wait: 10, ...options }),
    deliveries: (
      id: string,
      filter: { state?: WebhookDelivery["state"]; cursor?: string; limit?: number } = {},
      options?: RequestOptions,
    ) =>
      t.json<List<WebhookDelivery>>({
        method: "GET",
        path: one(id, "/deliveries"),
        query: filter,
        ...options,
      }),
    /** Sends one delivery again, once, now. */
    retry: (deliveryId: string, options?: RequestOptions) =>
      t.json<WebhookDelivery>({
        method: "POST",
        path: `/v1/webhook-deliveries/${encodeURIComponent(deliveryId)}:retry`,
        ...options,
      }),
  };
}

/** `runtime.otel`: push events (as logs) and CPU and memory (as metrics) to an
 * OpenTelemetry endpoint over OTLP/HTTP. */
export function otel(t: Transport) {
  const one = (id: string, verb = "") => `/v1/otel-exports/${encodeURIComponent(id)}${verb}`;
  return {
    create: (
      input: {
        /** The OTLP/HTTP base URL, as OTEL_EXPORTER_OTLP_ENDPOINT. */
        endpoint: string;
        /** For the endpoint's authentication; never shown back. */
        headers?: Record<string, string>;
        signals?: Array<"logs" | "metrics">;
      },
      options?: RequestOptions,
    ) => t.json<OtelExport>({ method: "POST", path: "/v1/otel-exports", body: input, ...options }),
    list: (options?: RequestOptions) =>
      t.json<List<OtelExport>>({ method: "GET", path: "/v1/otel-exports", ...options }),
    get: (id: string, options?: RequestOptions) =>
      t.json<OtelExport>({ method: "GET", path: one(id), ...options }),
    update: (
      id: string,
      patch: {
        endpoint?: string;
        headers?: Record<string, string>;
        signals?: Array<"logs" | "metrics">;
        enabled?: boolean;
      },
      options?: RequestOptions,
    ) => t.json<OtelExport>({ method: "POST", path: one(id, ":update"), body: patch, ...options }),
    /** Push now instead of at the next interval. */
    flush: (id: string, options?: RequestOptions) =>
      t.json<OtelExport>({ method: "POST", path: one(id, ":flush"), ...options }),
    delete: (id: string, options?: RequestOptions) =>
      t.json<OtelExport>({ method: "POST", path: one(id, ":delete"), ...options }),
  };
}

// ------------------------------------------------------------------ verify

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checks a webhook's `Runtime-Signature` header against the raw body and
 * your secret (or secrets, during a rotation), and returns the event. Throws
 * `WebhookVerificationError` when the signature does not match or is older
 * than `toleranceSeconds` (300 by default), which stops a captured delivery
 * being replayed. Pass the body exactly as received, before any JSON parsing.
 *
 *   app.post("/hooks/runtime", express.raw({ type: "application/json" }), async (req, res) => {
 *     const event = await verifyWebhook(req.body, req.get("runtime-signature"), process.env.RUNTIME_WEBHOOK_SECRET!);
 *     if (event.type === "sandbox.stopped") ...
 *     res.sendStatus(204);
 *   });
 *
 * Works wherever Web Crypto does: Node 18+, Bun, Deno, Cloudflare Workers, browsers. */
export async function verifyWebhook(
  body: string | Uint8Array,
  header: string | null | undefined,
  secret: string | readonly string[],
  options: { toleranceSeconds?: number; now?: number } = {},
): Promise<RuntimeEvent> {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  if (!header) throw new WebhookVerificationError("Missing Runtime-Signature header.");
  const parts = header.split(",").map((part) => part.trim().split("="));
  const t = Number(parts.find(([key]) => key === "t")?.[1]);
  const given = parts.filter(([key, value]) => key === "v1" && value).map(([, value]) => value!);
  if (!Number.isSafeInteger(t) || !given.length)
    throw new WebhookVerificationError("Malformed Runtime-Signature header.");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (options.toleranceSeconds ?? 300))
    throw new WebhookVerificationError("The signature is too old; the delivery may be a replay.");
  const encoder = new TextEncoder();
  for (const key of typeof secret === "string" ? [secret] : secret) {
    const hmac = await crypto.subtle.importKey(
      "raw",
      encoder.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = hex(await crypto.subtle.sign("HMAC", hmac, encoder.encode(`${t}.${text}`)));
    if (given.some((value) => sameText(value, expected))) {
      try {
        return JSON.parse(text) as RuntimeEvent;
      } catch {
        throw new WebhookVerificationError("The body is not JSON.");
      }
    }
  }
  throw new WebhookVerificationError("No signature matches the secret.");
}
