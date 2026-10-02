import { ConnectionError, DELIBERATE, errorFor, RuntimeError, WAITS_FOR_ROOM } from "./errors.js";
import { describeRoute, envFetch, openWebSocket } from "./proxy.js";

export const VERSION = "0.11.0";
export const DEFAULT_BASE_URL = "https://api.withruntime.com";
/** Runtime's API as code inside a Runtime sandbox reaches it: the sandbox's
 * own host sends each request on to DEFAULT_BASE_URL over HTTPS. The API runs
 * on that host, whose addresses a sandbox cannot reach directly. Plain HTTP
 * because the hop never leaves the machine: it goes from the program to the
 * guest's own proxy and over the sandbox's private channel to its host. */
export const SANDBOX_BASE_URL = "http://runtime.internal";
/** Every Runtime sandbox has this file; guest-net.py keeps it current. */
const SANDBOX_MARKER = "/run/runtime/environment.json";

/** True in a Runtime sandbox. Node and Bun only; a browser is never one. */
export function inRuntimeSandbox(marker = SANDBOX_MARKER): boolean {
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
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Query;
  body?: unknown;
  /** Raw bytes instead of JSON. */
  bytes?: Uint8Array;
  /** Seconds the server may hold the answer for a long-running result. */
  wait?: number;
  accept?: string;
  /** Whether retrying after an unknown outcome is safe. Default: true for
   * reads and for writes (the key makes them safe); false only for calls
   * the server cannot deduplicate. */
  retry?: boolean;
  /** How long to keep retrying, with the same key and input, a refusal that
   * clears when a sandbox stops or a host frees room (WAITS_FOR_ROOM): a
   * full trial, a full quota, a full region. Then the refusal is thrown as
   * it came. Only a create sets it; 0 or absent fails at once. */
  waitForCapacityMs?: number;
  /** Called each time a call waits for room, with the refusal it is waiting
   * out and how long it will sleep before sending the call again. */
  onCapacityWait?: (refusal: RuntimeError, waitMs: number) => void;
};

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
function slots(maximum: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async take(signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      if (active < maximum) {
        active++;
        return;
      }
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

/** One connection pool, one retry policy, one error shape for every product.
 * Node's and Bun's fetch keep connections alive, so a client reused across
 * calls pays TLS once. Over HTTP/1.1 every call in flight holds its own
 * connection, so a hundred calls at once would open a hundred, past what one
 * address may hold at the edge (64). Answers read whole are therefore held to
 * `maxConnections` at once and the rest queue here, reusing those
 * connections; streams and terminals are long-lived and do not wait behind
 * them. */
export class Transport {
  readonly baseUrl: string;
  #apiKey: string | undefined;
  readonly #findKey: (() => Promise<string>) | undefined;
  readonly #fetch: typeof fetch;
  /** Whether calls go through envFetch, so a failure can name its proxy. */
  readonly #routed: boolean;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #client: string;
  readonly #slots: ReturnType<typeof slots>;
  /** What `sandboxes.create` waits for room by default. */
  readonly waitForCapacityMs: number;
  constructor(options: {
    /** A key, or where to find one when the first call is made. */
    apiKey: string | (() => Promise<string>);
    baseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    maxRetries?: number;
    client?: string;
    /** Calls read whole that may be in flight at once. Default 32. */
    maxConnections?: number;
    /** How long a create waits for room. Default 120 000; 0 fails at once. */
    waitForCapacityMs?: number;
  }) {
    if (typeof options.apiKey === "function") this.#findKey = options.apiKey;
    else if (!options.apiKey || /\s/.test(options.apiKey)) throw missingKey();
    else this.#apiKey = options.apiKey;
    this.baseUrl = apiOrigin(options.baseUrl ? reachable(options.baseUrl) : defaultBaseUrl());
    // The environment's proxy (HTTPS_PROXY, NO_PROXY) on Node and Bun alike;
    // a fetch passed in is used as it is.
    this.#fetch = options.fetch ?? envFetch;
    this.#routed = options.fetch === undefined;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#maxRetries = options.maxRetries ?? 4;
    this.#client = options.client ?? `sdk-js/${VERSION}`;
    this.#slots = slots(Math.max(1, options.maxConnections ?? 32));
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
    const roomMs = Math.max(0, call.waitForCapacityMs ?? 0);
    const deadline = timeoutMs === 0 ? undefined : AbortSignal.timeout(timeoutMs + roomMs);
    const signal = deadline
      ? call.signal
        ? AbortSignal.any([call.signal, deadline])
        : deadline
      : call.signal;
    return {
      ...call,
      timeoutMs: 0,
      ...(signal ? { signal } : {}),
      ...(call.method !== "GET"
        ? { idempotencyKey: call.idempotencyKey ?? crypto.randomUUID() }
        : {}),
    };
  }

  #connectionError(call: Call, cause: unknown): ConnectionError {
    const cancelled = call.signal?.aborted === true;
    const route =
      this.#routed && !cancelled
        ? describeRoute(`${this.baseUrl}${call.path}`, cause)
        : { via: "" };
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

  async #send<T>(call: Call, consume: (response: Response) => Promise<T>): Promise<T> {
    let apiKey: string;
    try {
      call.signal?.throwIfAborted();
      apiKey = await untilAborted(this.#key(), call.signal);
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
        response = await send(url, {
          method: call.method,
          headers: this.#headers(call, key, apiKey),
          redirect: "manual",
          signal,
          ...(body === undefined ? {} : { body: body as NonNullable<RequestInit["body"]> }),
        });
        if (
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          await response.body?.cancel().catch(() => {});
          throw new TypeError(`fetch failed: Runtime answered a redirect (${response.status}).`);
        }
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
        // A full house: wait for a slot or for room, then send the same call
        // again. A request that can never fit (a fork of more copies than the
        // trial runs) is not waited for.
        if (
          retry &&
          roomMs > 0 &&
          WAITS_FOR_ROOM.has(error.code) &&
          error.details?.field !== "count"
        ) {
          const left = roomUntil - performance.now();
          if (left <= 0) throw error;
          const pause = Math.min(left, error.retryAfterMs ?? roomBackoff(roomAttempt++));
          inCallback = true;
          call.onCapacityWait?.(error, pause);
          inCallback = false;
          await sleep(pause, signal);
          continue;
        }
        const retryable = [429, 502, 503, 504].includes(status) && !DELIBERATE.has(error.code);
        if (!retry || !retryable || attempt >= this.#maxRetries) throw error;
        const header = Number(response.headers.get("retry-after"));
        const wait =
          error.retryAfterMs ??
          (Number.isFinite(header) && header > 0 ? header * 1000 : backoff(attempt));
        await sleep(Math.min(30_000, wait) * (0.9 + Math.random() * 0.2), signal);
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
        await sleep(backoff(attempt), signal).catch((cause: unknown) => {
          throw this.#connectionError(call, cause);
        });
      }
      attempt++;
    }
  }

  async #queued<T>(call: Call, consume: (response: Response) => Promise<T>): Promise<T> {
    try {
      await this.#slots.take(call.signal);
    } catch (cause) {
      throw this.#connectionError(call, cause);
    }
    try {
      return await this.#send(call, consume);
    } finally {
      this.#slots.give();
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
    const response = await this.send(call);
    const expected = promisedLength(response.headers);
    const body = response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    let got = 0;
    return body.pipeThrough(
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
    );
  }

  /** Newline-delimited JSON events, as they arrive. */
  async *events<T>(call: Call): AsyncGenerator<T> {
    const response = await this.send({ ...call, accept: "application/x-ndjson" });
    if (!response.body) return;
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
    }
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

function backoff(attempt: number): number {
  return Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random());
}

/** Between tries for room: 0.5 s, 1 s, 2 s, 4 s, then every 8 s, jittered, so
 * a queue of CI jobs spreads out instead of knocking at once. */
function roomBackoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}
