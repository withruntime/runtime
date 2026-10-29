import {
  ConnectionError,
  DELIBERATE,
  errorFor,
  NOTHING_RAN,
  RuntimeError,
  WAITS_FOR_ROOM,
} from "./errors.js";
import { describeRoute, envFetch, openWebSocket, untrustedCertificate } from "./proxy.js";
import { warningText } from "./product-renames.js";

export const VERSION = "0.48.1";
export const DEFAULT_BASE_URL = "https://api.withruntime.com";
/** Runtime's API as code inside a Runtime sandbox reaches it: the sandbox's
 * own host sends each request on to DEFAULT_BASE_URL over HTTPS. The API runs
 * on that host, whose addresses a sandbox cannot reach directly. Plain HTTP
 * because the hop never leaves the machine: it goes from the program to the
 * guest's own proxy and over the sandbox's private channel to its host. */
export const SANDBOX_BASE_URL = "http://runtime.internal";
/** How a Runtime secret's placeholder starts, the value a sandbox sees in its
 * place (packages/cloud-guide/docs/security.md). */
export const PLACEHOLDER = "rtsec_";
/** Every Runtime sandbox has this file; guest-net.py keeps it current. Tests
 * move it, so the machine running them does not decide what they see. */
export const sandboxMarker = { path: "/run/runtime/environment.json" };

/** True in a Runtime sandbox. Node and Bun only; a browser is never one. */
export function inRuntimeSandbox(marker = sandboxMarker.path): boolean {
  try {
    const host = (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => { existsSync?(path: string): boolean } };
      }
    ).process;
    return host?.getBuiltinModule?.("node:fs")?.existsSync?.(marker) === true;
  } catch {
    return false;
  }
}

/** Where calls go when no base URL is given: RUNTIME_API_URL, then Runtime's
 * public API, which `reachable` turns into runtime.internal in a sandbox. */
export function defaultBaseUrl(
  env: Record<string, string | undefined> = processEnv(),
  inSandbox = inRuntimeSandbox,
): string {
  return reachable(env.RUNTIME_API_URL || DEFAULT_BASE_URL, inSandbox);
}

/** The origin calls for `origin` are sent to from here. In a sandbox the
 * public API is its own host, which it cannot reach directly, so calls for it
 * go to runtime.internal; every other origin is left as it is. */
export function reachable(origin: string, inSandbox = inRuntimeSandbox): string {
  return apiOrigin(origin) === DEFAULT_BASE_URL && inSandbox() ? SANDBOX_BASE_URL : origin;
}
function processEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

export type RequestOptions = {
  /** Sent as Idempotency-Key. Omit it: the SDK makes one per call and keeps
   * it across its own retries, so a retried write never happens twice. Pass
   * your own only to retry a call yourself after the process restarted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Deadline for this call, retries included. 0 disables this deadline;
   * an explicit signal can still cancel the call. */
  timeoutMs?: number;
};

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export type Call = RequestOptions & {
  /** Internal protocol hook: successful headers arrived, before reading the body. */
  onResponse?: (response: Response) => void;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Query;
  body?: unknown;
  /** Raw bytes instead of JSON. */
  bytes?: Uint8Array;
  /** Seconds the server may hold the answer for a long-running result. */
  wait?: number;
  accept?: string;
  /** Internal: headers of Runtime's own operator calls (the never-park mark,
   * `runtime sandboxes never-park`), which the API refuses for anyone else. */
  headers?: Record<string, string>;
  /** Sent as the Bearer token instead of the client's API key: a webhook
   * trigger's secret, which is all its calls carry. */
  bearer?: string;
  /** Whether retrying after an unknown outcome is safe. Default: true for
   * reads and for writes (the key makes them safe); false only for calls
   * the server cannot deduplicate. */
  retry?: boolean;
  /** How long to keep retrying, with the same key and input, a refusal that
   * clears when a sandbox stops or a host frees room (WAITS_FOR_ROOM): a
   * full slots without credit, a full quota, a full region. Then the refusal is thrown as
   * it came. A create, wake or restart sets it; 0 or absent fails at once. */
  waitForCapacityMs?: number;
  /** Called each time a call waits for room, with the refusal it is waiting
   * out and how long it will sleep before sending the call again. */
  onCapacityWait?: (refusal: RuntimeError, waitMs: number) => void;
  /** Internal: when the call's own deadline ends now (performance.now()),
   * set once the call is prepared; absent when it has none. */
  deadlineAt?: () => number;
  /** Internal: moves the call's deadline on by a wait for room, so a wait
   * for capacity never spends the caller's own `timeoutMs`. */
  extendDeadline?: (ms: number) => void;
};

/** The W3C trace context of the caller's active OpenTelemetry span, when the
 * program uses OpenTelemetry for JavaScript: version 1 of @opentelemetry/api
 * keeps its registered context manager and propagator on globalThis under
 * this symbol, so the SDK reads them without depending on the package. With
 * it, Runtime's span of the call (an export with "traces") is a child of the
 * caller's, in the caller's own trace. Nothing without OpenTelemetry, and
 * never a reason for a call to fail. */
const OTEL_API = Symbol.for("opentelemetry.js.api.1");
type OtelGlobal = {
  context?: { active?(): unknown };
  propagation?: {
    inject?(
      context: unknown,
      carrier: Record<string, string>,
      setter: { set(carrier: Record<string, string>, key: string, value: string): void },
    ): void;
  };
};
export function traceHeaders(): Record<string, string> {
  try {
    const otel = (globalThis as Record<symbol, OtelGlobal | undefined>)[OTEL_API];
    const active = otel?.context?.active?.();
    if (!active || !otel?.propagation?.inject) return {};
    const carrier: Record<string, string> = {};
    otel.propagation.inject(active, carrier, {
      set: (into, key, value) => {
        into[key.toLowerCase()] = String(value);
      },
    });
    const headers: Record<string, string> = {};
    for (const name of ["traceparent", "tracestate"])
      if (typeof carrier[name] === "string" && carrier[name].length <= 512)
        headers[name] = carrier[name];
    return headers;
  } catch {
    return {};
  }
}

/** How long an answer that ran nothing (NOTHING_RAN) is retried for a call
 * that has no deadline of its own. */
const NOTHING_RAN_MS = 300_000;

/** The longest wait the SDK sleeps on for a retry. A refusal that names a
 * longer one (a daily cap, about an hour) is thrown at once, still
 * retryable and with its `retryAfterMs`, for the caller to schedule. */
const LONGEST_RETRY_WAIT_MS = 60_000;

/** How long one attempt waits for its answer to start. The API starts every
 * answer within 120 s: Caddy answers 503 itself past that, and a longer call
 * gets its 200 at 90 s and then its JSON (runtime-late-answer). An attempt
 * with no answer by then is talking to a server that is gone, such as a
 * controller that died with the call in flight while its address moved to
 * the new leader: a client that only waits sends nothing the new leader could
 * refuse, so it waited out the whole deadline and failed (a controller
 * failover drill, 4 October 2026). It is sent again under the same key. */
export const ANSWER_START_MS = 125_000;

export function apiOrigin(value: string): string {
  const url = new URL(value);
  // runtime.internal is reserved and never resolves outside a sandbox, so a
  // key sent there in plain HTTP never leaves the sandbox's host.
  const local = ["localhost", "127.0.0.1", "[::1]", "runtime.internal"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    (url.hostname === "runtime.internal" && (url.protocol !== "http:" || url.port !== "")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Use an HTTPS API origin (or http://runtime.internal inside a sandbox, http://localhost for tests).",
    );
  return url.origin;
}

export function encodeQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      for (const item of value as readonly string[]) params.append(key, item);
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

/** A credential lookup can finish independently, but must not keep its
 * caller waiting after cancellation or hold that caller's queue slot. */
function untilAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause instanceof Error ? cause : new Error("Credential lookup failed.", { cause }));
      },
    );
  });
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Aborted", { cause: signal?.reason });
}

/** At most `maximum` holders at once; the rest wait their turn, first come
 * first served. */
function slots(maximum: number, onWait?: () => void) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async take(signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (active < maximum) {
        active++;
        return;
      }
      onWait?.();
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const at = waiting.indexOf(ready);
          if (at >= 0) waiting.splice(at, 1);
          reject(abortReason(signal));
        };
        waiting.push(ready);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
    give(): void {
      const next = waiting.shift();
      if (next) next();
      else active--;
    },
  };
}

/** A call's hold on its connection slots. */
type Gate = { take(): Promise<void>; lend(): void };

/** Connections a client holds at once by default: under the 64 one address
 * may hold to the API (api.md, "Limits"), with room for a second client. */
export const DEFAULT_MAX_CONNECTIONS = 48;
/** Connections a client keeps for answers read whole, however many streams
 * are open: a stream's reader that makes a call (an output callback writing a
 * file) never waits behind streams, its own included. */
const KEPT_FOR_CALLS = 8;

/** One connection pool, one retry policy, one error shape for every product.
 * Node's and Bun's fetch keep connections alive, so a client reused across
 * calls pays TLS once. Over HTTP/1.1 every call in flight holds its own
 * connection, and one address may hold 64 to the API before it has used a
 * valid key: past that the API's edge holds new ones back until one closes.
 * So a client holds at most `maxConnections` at once,
 * answers and streams together, and the rest queue here, first come first
 * served, and wait rather than fail. Streams (a command's output, a download,
 * a watch) take at most `maxConnections` less KEPT_FOR_CALLS of them. A
 * terminal or tunnel's WebSocket is not counted. */

/** AbortSignal.timeout in whole milliseconds, rounded up, never under 1.
 * Node throws ERR_OUT_OF_RANGE on a fraction (Bun accepts one), so a
 * customer's timeoutMs of 1500.5 would be a RangeError instead of a request;
 * the live promise probe broke this way on 9 October 2026. Every
 * deadline the SDK makes from a customer's or a computed value goes through
 * this. */
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.ceil(ms)));
}
/** A deadline `ms` from now that `extend` moves later; it aborts with a
 * TimeoutError, as AbortSignal.timeout does. */
function movableDeadline(ms: number) {
  const controller = new AbortController();
  let at = performance.now() + ms;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(
      () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
      Math.max(1, Math.ceil(at - performance.now())),
    );
    // Never keeps a process alive by itself, as AbortSignal.timeout does not.
    (timer as { unref?: () => void }).unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    at: () => at,
    extend: (by: number) => {
      if (controller.signal.aborted || by <= 0) return;
      at += by;
      clearTimeout(timer);
      arm();
    },
  };
}
export class Transport {
  readonly baseUrl: string;
  #apiKey: string | undefined;
  readonly #findKey: (() => Promise<string>) | undefined;
  readonly #fetch: typeof fetch;
  /** Whether calls go through envFetch, so a failure can name its proxy. */
  readonly #routed: boolean;
  readonly #timeoutMs: number;
  readonly #answerStartMs: number;
  readonly #maxRetries: number;
  readonly #client: string;
  readonly #slots: ReturnType<typeof slots>;
  readonly #streams: ReturnType<typeof slots>;
  /** What `sandboxes.create` waits for room by default. */
  readonly waitForCapacityMs: number;
  constructor(options: {
    /** A key, or where to find one when the first call is made. */
    apiKey: string | (() => Promise<string>);
    baseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** How long one attempt waits for its answer to start before it is sent
     * again under the same key. Default ANSWER_START_MS. */
    answerStartMs?: number;
    maxRetries?: number;
    client?: string;
    /** Connections held at once, answers and streams together; the rest
     * wait their turn. Default 48: one address may hold 64 to the API. */
    maxConnections?: number;
    /** Called each time a call has to wait for one of those connections. */
    onQueued?: (maxConnections: number) => void;
    /** How long a create waits for room. Default 120 000; 0 fails at once. */
    waitForCapacityMs?: number;
  }) {
    if (typeof options.apiKey === "function") this.#findKey = options.apiKey;
    else if (!options.apiKey || /\s/.test(options.apiKey)) throw missingKey();
    else this.#apiKey = options.apiKey;
    // A secret's placeholder becomes the key only on its way out through the
    // sandbox's proxy; runtime.internal goes to the host without it, so the
    // API sees the placeholder and answers 401 (land-lander, 11 October 2026:
    // every worker's `check --remote`). Such a key's calls take the public API.
    const placeholder = this.#apiKey?.startsWith(PLACEHOLDER) === true;
    const origin = options.baseUrl || processEnv().RUNTIME_API_URL || DEFAULT_BASE_URL;
    this.baseUrl = apiOrigin(placeholder ? origin : reachable(origin));
    // The environment's proxy (HTTPS_PROXY, NO_PROXY) on Node and Bun alike;
    // a fetch passed in is used as it is.
    this.#fetch = options.fetch ?? envFetch;
    this.#routed = options.fetch === undefined;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#answerStartMs = options.answerStartMs ?? ANSWER_START_MS;
    this.#maxRetries = options.maxRetries ?? 4;
    this.#client = options.client ?? `sdk-js/${VERSION}`;
    const most = Math.max(1, options.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
    const queued = options.onQueued && (() => options.onQueued!(most));
    this.#slots = slots(most, queued);
    this.#streams = slots(Math.max(1, most - KEPT_FOR_CALLS), queued);
    this.waitForCapacityMs = Math.max(0, options.waitForCapacityMs ?? 120_000);
  }

  /** The key, found once on first use when it was not given. */
  async #key(): Promise<string> {
    if (this.#apiKey === undefined) {
      const found = await this.#findKey!();
      if (!found || /\s/.test(found)) throw missingKey();
      this.#apiKey = found;
    }
    return this.#apiKey;
  }

  #headers(call: Call, key: string | undefined, apiKey: string): Record<string, string> {
    return {
      ...call.headers,
      authorization: `Bearer ${apiKey}`,
      accept: call.accept ?? "application/json",
      "x-runtime-client": this.#client,
      ...(call.bytes
        ? { "content-type": "application/octet-stream" }
        : call.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
      ...(call.wait ? { prefer: `wait=${Math.min(120, Math.ceil(call.wait))}` } : {}),
      ...traceHeaders(),
    };
  }

  /** Sends a call and returns the raw Response once it succeeded. Retries
   * transport failures, 429, 502, 503 and 504 with backoff and jitter, with
   * the same key every time, and waits out a full house for a call that sets
   * waitForCapacityMs. */
  async send(call: Call): Promise<Response> {
    return this.#send(this.#prepare(call), async (response) => response);
  }

  /** Start the deadline before waiting for a connection; keep one key and
   * signal through every retry and the complete response body. */
  #prepare(call: Call): Call {
    const timeoutMs = call.timeoutMs ?? this.#timeoutMs;
    // The deadline is the caller's timeoutMs plus only the time actually
    // spent waiting for room (WAITS_FOR_ROOM), which moves it on as it waits:
    // a wake given timeoutMs 20 on a server that never answers still ends at
    // 20 ms, not two minutes later (lifecycle-deadlines.test.ts).
    const deadline = timeoutMs === 0 ? undefined : movableDeadline(timeoutMs);
    const signal = deadline
      ? call.signal
        ? AbortSignal.any([call.signal, deadline.signal])
        : deadline.signal
      : call.signal;
    const prepared: Call = {
      ...call,
      timeoutMs: 0,
      ...(signal ? { signal } : {}),
      ...(call.method !== "GET"
        ? { idempotencyKey: call.idempotencyKey ?? crypto.randomUUID() }
        : {}),
    };
    if (deadline) {
      prepared.deadlineAt = deadline.at;
      prepared.extendDeadline = deadline.extend;
    }
    return prepared;
  }

  #connectionError(call: Call, cause: unknown): ConnectionError {
    const cancelled = call.signal?.aborted === true;
    const route =
      this.#routed && !cancelled
        ? describeRoute(`${this.baseUrl}${call.path}`, cause)
        : { via: "" };
    // A certificate this machine does not trust answered, most often a proxy
    // that inspects TLS: said as that, never as "no answer" (18 October 2026,
    // the published CLI on Node behind such a proxy, where Bun trusted it).
    const certificate = cancelled ? undefined : untrustedCertificate(cause);
    if (certificate)
      return new ConnectionError({
        message: `Runtime at ${this.baseUrl}${route.via} could not be reached: the TLS certificate presented is not one this machine trusts (${certificate}).`,
        hint: "A proxy or firewall that inspects TLS signs with its own authority: point NODE_EXTRA_CA_CERTS at its certificate (Node), or add it to the system's trusted certificates.",
        code: "connection_error",
        status: 0,
        ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
        cause,
      });
    return new ConnectionError({
      message: cancelled
        ? "The call was cancelled or ran past its deadline."
        : call.method !== "GET"
          ? `No answer from Runtime at ${this.baseUrl}${route.via}. The change may have happened; retrying with the same idempotencyKey is safe.`
          : `No answer from Runtime at ${this.baseUrl}${route.via}.`,
      hint: cancelled
        ? "Raise timeoutMs for a long call, or retry with the same idempotencyKey."
        : (route.hint ?? "Check the network, and RUNTIME_API_URL if you set it."),
      code: cancelled ? "timeout" : "connection_error",
      status: 0,
      ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
      cause,
    });
  }

  /** Sleeps between tries. A call holding a connection slot (`gate`) lends
   * it out while it sleeps, since a sleep holds no connection, and takes a
   * slot again before it sends: a thousand creates waiting out a full region
   * or a 429 would otherwise keep every other call of this client, the stop
   * that frees room included, queued behind them. */
  async #rest(ms: number, signal: AbortSignal | undefined, gate?: Gate): Promise<void> {
    gate?.lend();
    await sleep(ms, signal);
    await gate?.take();
  }

  /** Wait before sending a refused call again. When the call's deadline
   * ends the wait, the refusal stands: on a loaded machine bun can fire
   * AbortSignal.timeout before a shorter setTimeout, and the call then
   * failed as a timeout although the transport had judged the wait to fit
   * (11 October 2026). A caller's own cancel still ends it as a cancel. */
  async #retryAfter(
    refusal: RuntimeError,
    ms: number,
    signal: AbortSignal | undefined,
    gate?: Gate,
  ) {
    await this.#rest(ms, signal, gate).catch((cause: unknown) => {
      throw (signal?.reason as { name?: unknown } | undefined)?.name === "TimeoutError"
        ? refusal
        : cause;
    });
  }

  async #send<T>(call: Call, consume: (response: Response) => Promise<T>, gate?: Gate): Promise<T> {
    let apiKey: string;
    try {
      call.signal?.throwIfAborted();
      apiKey = call.bearer ?? (await untilAborted(this.#key(), call.signal));
    } catch (cause) {
      if (call.signal?.aborted) throw this.#connectionError(call, cause);
      throw cause;
    }
    const key = call.method !== "GET" ? call.idempotencyKey : undefined;
    const roomMs = Math.max(0, call.waitForCapacityMs ?? 0);
    const roomUntil = performance.now() + roomMs;
    let roomAttempt = 0;
    const signal = call.signal;
    const url = `${this.baseUrl}${call.path}${encodeQuery(call.query)}`;
    const body = call.bytes ?? (call.body === undefined ? undefined : JSON.stringify(call.body));
    const retry = call.retry ?? true;
    let attempt = 0;
    // An answer that ran nothing is sent again until the call's deadline.
    // Read at each use: a wait for room moves the call's deadline on.
    const idleFallback = performance.now() + NOTHING_RAN_MS;
    const idleUntil = () => call.deadlineAt?.() ?? idleFallback;
    let idleAttempt = 0;
    // The last try never left, and was sent again at once.
    let resentAtOnce = false;
    for (;;) {
      let response: Response | undefined;
      let inCallback = false;
      // Called as a plain function: Cloudflare Workers' fetch throws "Illegal
      // invocation" when called as a method of another object (this.#fetch()).
      const send = this.#fetch;
      try {
        // "manual", not "error": Workers accept only "follow" and "manual".
        // The API never redirects, so a redirect is refused here exactly as
        // "error" refused it: thrown, retried, then a connection_error.
        signal?.throwIfAborted();
        const started = new AbortController();
        const unanswered = setTimeout(
          () => started.abort(new DOMException("No answer started.", "TimeoutError")),
          this.#answerStartMs,
        );
        try {
          response = await send(url, {
            method: call.method,
            headers: this.#headers(call, key, apiKey),
            redirect: "manual",
            signal: signal ? AbortSignal.any([signal, started.signal]) : started.signal,
            ...(body === undefined ? {} : { body: body as NonNullable<RequestInit["body"]> }),
          });
        } finally {
          clearTimeout(unanswered);
        }
        if (
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          await response.body?.cancel().catch(() => {});
          throw new TypeError(`fetch failed: Runtime answered a redirect (${response.status}).`);
        }
        sayRenamed(response.headers.get("warning"));
        /* An answer that took longer than the API holds its headers (90 s)
         comes as a 200 sent early, and then its JSON: the answer, or
         {"error": ...} when the work failed after the status went
         (runtime-late-answer, api.md). Either way it is read here, so a
         failure is thrown as the error it is, never returned as a success. */
        let late: { status: number; text: string } | undefined;
        if (response.ok && response.headers.get("runtime-late-answer") === "true") {
          const text = await response.text();
          const failed = lateFailure(text);
          if (failed === undefined)
            return await consume(new Response(text, { headers: response.headers }));
          late = { status: failed, text };
        } else if (response.ok) {
          inCallback = true;
          call.onResponse?.(response);
          inCallback = false;
          return await consume(response);
        }
        const status = late?.status ?? response.status;
        // Runtime never answers 407: it is a proxy refusing the tunnel, which
        // Bun's fetch hands back as a response rather than an error.
        if (response.status === 407 && this.#routed) {
          await response.body?.cancel();
          const route = describeRoute(url, 407);
          throw new ConnectionError({
            message: `No answer from Runtime at ${this.baseUrl}${route.via}.`,
            code: "connection_error",
            status: 0,
            ...(route.hint ? { hint: route.hint } : {}),
            ...(key ? { idempotencyKey: key } : {}),
          });
        }
        const text = late?.text ?? (await response.text());
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: { message: text.slice(0, 500) || `HTTP ${status}` } };
        }
        const error = errorFor(status, parsed, key);
        const header = Number(response.headers.get("retry-after"));
        const headerMs = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
        // A full house: wait for a slot or for room, then send the same call
        // again. A request that can never fit (a fork of more copies than the
        // trial runs) is not waited for.
        if (
          retry &&
          roomMs > 0 &&
          WAITS_FOR_ROOM.has(error.code) &&
          error.details?.field !== "count" &&
          // A quota on what is kept says it never clears by waiting.
          error.sentRetryable !== false
        ) {
          const left = roomUntil - performance.now();
          if (left <= 0) throw error;
          const pause = Math.min(left, error.retryAfterMs ?? roomBackoff(roomAttempt++));
          inCallback = true;
          call.onCapacityWait?.(error, pause);
          inCallback = false;
          call.extendDeadline?.(pause);
          await this.#retryAfter(error, pause, signal, gate);
          continue;
        }
        // Nothing ran: safe to send again for any call, past maxRetries,
        // with growing waits, until the deadline; then this refusal stands.
        // A late answer's failure came after the work began, so only a
        // guest's own refusal (`guest_busy`, before anything is journaled)
        // still says nothing ran.
        if (
          [429, 503].includes(status) &&
          NOTHING_RAN.has(error.code) &&
          error.sentRetryable !== false &&
          (!late || error.code === "guest_busy")
        ) {
          const named = error.retryAfterMs ?? headerMs;
          if (named !== undefined && named > LONGEST_RETRY_WAIT_MS) throw withWait(error, named);
          const base = named ?? 250;
          const pause =
            Math.min(30_000, base * 2 ** Math.min(idleAttempt++, 3)) * (0.9 + Math.random() * 0.2);
          if (pause >= idleUntil() - performance.now()) throw error;
          await this.#retryAfter(error, pause, signal, gate);
          continue;
        }
        // The API says whether the same request may succeed; an older
        // server is judged by its status. A refusal for room or for the
        // account's own limit is the room wait's above on a create, wake or
        // restart, which set waitForCapacityMs (0 fails at once); any other
        // call retries what the answer says.
        const retryable =
          (error.sentRetryable ??
            ([429, 502, 503, 504].includes(status) && !DELIBERATE.has(error.code))) &&
          !(call.waitForCapacityMs !== undefined && WAITS_FOR_ROOM.has(error.code));
        if (!retry || !retryable || attempt >= this.#maxRetries) throw error;
        const named = error.retryAfterMs ?? headerMs;
        if (named !== undefined && named > LONGEST_RETRY_WAIT_MS) throw withWait(error, named);
        const wait = named ?? backoff(attempt);
        await this.#rest(Math.min(30_000, wait) * (0.9 + Math.random() * 0.2), signal, gate);
      } catch (cause) {
        // Deliberate API refusals and unusable proxy settings cannot be
        // fixed by repeating the request. Body failures are transport
        // failures too: a write replays under its original key.
        if (inCallback) {
          await response?.body?.cancel().catch(() => undefined);
          throw cause;
        }
        if (cause instanceof RuntimeError) throw cause;
        if (signal?.aborted || !retry || attempt >= this.#maxRetries)
          throw this.#connectionError(call, cause);
        // A connection that never opened sent no byte of the request, so
        // the next try, which may reach another server, goes at once; once
        // in a row, so an API that is down is not hammered. Anything that
        // may have reached a server (a reset, a timeout, a cut answer)
        // keeps the backoff and its key's rules.
        const atOnce: boolean = response === undefined && neverSent(cause) && !resentAtOnce;
        resentAtOnce = atOnce;
        await this.#rest(atOnce ? Math.random() * 50 : backoff(attempt), signal, gate).catch(
          (cause: unknown) => {
            throw cause instanceof RuntimeError ? cause : this.#connectionError(call, cause);
          },
        );
      }
      attempt++;
    }
  }

  /** A hold on `kinds` of slot, taken in order and given back together. */
  #gate(call: Call, kinds: ReturnType<typeof slots>[]): Gate {
    let held = 0;
    const lend = () => {
      while (held > 0) kinds[--held]!.give();
    };
    return {
      take: async () => {
        try {
          for (; held < kinds.length; held++) await kinds[held]!.take(call.signal);
        } catch (cause) {
          lend();
          throw this.#connectionError(call, cause);
        }
      },
      lend,
    };
  }

  async #queued<T>(call: Call, consume: (response: Response) => Promise<T>): Promise<T> {
    const gate = this.#gate(call, [this.#slots]);
    await gate.take();
    try {
      return await this.#send(call, consume, gate);
    } finally {
      gate.lend();
    }
  }

  async json<T>(call: Call): Promise<T> {
    return this.#queued(this.#prepare(call), async (response) => {
      const text = await response.text();
      return (text ? JSON.parse(text) : null) as T;
    });
  }

  async bytes(call: Call): Promise<Uint8Array> {
    return this.#queued(
      this.#prepare(call),
      async (response) => new Uint8Array(await response.arrayBuffer()),
    );
  }

  /** A file's bytes, read whole and checked against its promised length and
   * SHA-256. A short or different body is read again twice, within the same
   * call deadline. */
  async fileBytes(call: Call): Promise<Uint8Array> {
    call = this.#prepare(call);
    for (let attempt = 0; ; attempt++) {
      const { body, problem } = await this.#queued(call, async (response) => {
        const body = new Uint8Array(await response.arrayBuffer());
        return { body, problem: await checkBody(response.headers, body) };
      });
      if (!problem) return body;
      if (attempt >= 2) throw problem;
      await sleep(backoff(attempt), call.signal).catch((cause: unknown) => {
        throw this.#connectionError(call, cause);
      });
    }
  }

  /** A file's bytes as they arrive, for files too big to hold. The stream
   * errors with `download_incomplete` if it ends short of the length the API
   * promised; it is never retried part way. */
  async fileStream(call: Call): Promise<ReadableStream<Uint8Array>> {
    const { response, release } = await this.#opened(this.#prepare(call));
    const expected = promisedLength(response.headers);
    const body = response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    let got = 0;
    const reader = body
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            got += chunk.byteLength;
            if (expected !== undefined && got > expected)
              controller.error(incompleteDownload(got, expected));
            else controller.enqueue(chunk);
          },
          flush(controller) {
            if (expected !== undefined && got !== expected)
              controller.error(incompleteDownload(got, expected));
          },
        }),
      )
      .getReader();
    // The connection is given back when the body ends, fails or is cancelled.
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            release();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        release();
        await reader.cancel(reason);
      },
    });
  }

  /** Sends a call whose answer is a stream, holding a stream slot and a
   * connection slot from before it is sent until `release`: once its body is
   * read, failed or cancelled, or its deadline or signal ends it, whichever
   * comes first, so a stream nobody finishes still gives its slots back at
   * its deadline. */
  async #opened(call: Call): Promise<{ response: Response; release: () => void }> {
    const gate = this.#gate(call, [this.#streams, this.#slots]);
    await gate.take();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      call.signal?.removeEventListener("abort", release);
      gate.lend();
    };
    try {
      const response = await this.#send(call, async (response) => response, gate);
      if (call.signal?.aborted) release();
      else call.signal?.addEventListener("abort", release, { once: true });
      return { response, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Newline-delimited JSON events, as they arrive. */
  async *events<T>(call: Call): AsyncGenerator<T> {
    const { response, release } = await this.#opened(
      this.#prepare({ ...call, accept: "application/x-ndjson" }),
    );
    if (!response.body) return release();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        call.signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          call.signal?.throwIfAborted();
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) yield JSON.parse(line) as T;
          newline = buffer.indexOf("\n");
        }
      }
      call.signal?.throwIfAborted();
      if (buffer.trim()) yield JSON.parse(buffer) as T;
    } finally {
      // Returning early from the iterator must close the HTTP stream too.
      // Cleanup must not replace a parse, network or callback error.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      release();
    }
  }

  /** The key calls are made with: the one given, RUNTIME_API_KEY, or the
   * connection `runtime login` saved. For another platform's SDK pointed at
   * Runtime (`runtime.agents.anthropic()`). */
  async apiKey(): Promise<string> {
    return this.#key();
  }

  /** A WebSocket to an API path, authenticated with the same key. */
  async websocket(path: string, query?: Query): Promise<WebSocket> {
    const apiKey = await this.#key();
    const url = `${this.baseUrl.replace(/^http/, "ws")}${path}${encodeQuery(query)}`;
    return openWebSocket(url, {
      authorization: `Bearer ${apiKey}`,
      "x-runtime-client": this.#client,
    });
  }
}

/** The status a late answer's body failed with, or undefined when it is an
 * answer. The body is the error the API would have sent as its status. */
const said = new Set<string>();
/** CLOUD.md section 4: a call under a renamed product word is answered with a
 * Warning naming the new word. It is printed once per process, to stderr, so
 * a loop does not drown its own output and stdout stays the caller's. */
export function sayRenamed(
  header: string | null,
  say: (line: string) => void = console.warn,
): void {
  const text = warningText(header);
  if (text === undefined || said.has(text)) return;
  said.add(text);
  say(`Runtime: ${text}`);
}

function lateFailure(text: string): number | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return 502;
  }
  // An API error is a body of `error` alone, with a code; an answer may carry
  // an `error` of its own (a code cell's exception), next to other fields.
  if (!body || typeof body !== "object" || Object.keys(body).length !== 1) return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object" || typeof (error as { code?: unknown }).code !== "string")
    return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 ? status : 500;
}

function promisedLength(headers: Headers): number | undefined {
  const value = headers.get("x-content-length");
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** A download that ended short of (or past) the length the API promised. */
export function incompleteDownload(got: number, expected: number): RuntimeError {
  return new RuntimeError({
    message: `The download ended at ${got} of ${expected} bytes.`,
    code: "download_incomplete",
    status: 0,
    hint: "Read the file again; nothing was written for this read. If it keeps happening, report it with `npx withruntime feedback`.",
    details: { received: got, expected },
  });
}

/** Why a whole body cannot be trusted, or undefined when it can. */
async function checkBody(headers: Headers, body: Uint8Array): Promise<RuntimeError | undefined> {
  const expected = promisedLength(headers);
  if (expected !== undefined && body.byteLength !== expected)
    return incompleteDownload(body.byteLength, expected);
  const sha256 = headers.get("x-content-sha256");
  if (!sha256) return undefined;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>),
  );
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex === sha256.toLowerCase()) return undefined;
  return new RuntimeError({
    message: "The file's bytes did not match the SHA-256 the API sent with them.",
    code: "download_incomplete",
    status: 0,
    hint: "Read the file again. If it keeps happening, report it with `npx withruntime feedback`.",
  });
}

/** No key given, none in RUNTIME_API_KEY, and none saved by `runtime login`. */
export function missingKey(): RuntimeError {
  return new RuntimeError({
    message: "No Runtime key found: RUNTIME_API_KEY is not set and this machine is not connected.",
    code: "missing_api_key",
    status: 0,
    hint: "Run `npx -y withruntime login` (a browser approval; nothing to copy), set RUNTIME_API_KEY to a key from https://withruntime.com/account/keys, or pass { apiKey }.",
  });
}

/** Error codes of a connection that never opened (Node's and Bun's), so no
 * byte of the request left this machine. */
const NEVER_OPENED = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

/** Whether a fetch failure is a connection that never opened: its code, or
 * one of its causes', says so. A timeout or a reset never counts. */
export function neverSent(cause: unknown): boolean {
  for (let at = cause, depth = 0; at && depth < 5; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && NEVER_OPENED.has(code)) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** `error` thrown for a wait too long to sleep on, carrying that wait as
 * `retryAfterMs` when only the Retry-After header named it. */
function withWait(error: RuntimeError, ms: number): RuntimeError {
  if (error.retryAfterMs === undefined)
    (error as { retryAfterMs?: number }).retryAfterMs = Math.round(ms);
  return error;
}

function backoff(attempt: number): number {
  return Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random());
}

/** Between tries for room: 0.5 s, 1 s, 2 s, 4 s, then every 8 s, jittered, so
 * a queue of CI jobs spreads out instead of knocking at once. */
function roomBackoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}
