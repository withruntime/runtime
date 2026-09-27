import { ConnectionError, errorFor, RuntimeError, WAITS_FOR_ROOM } from "./errors.js";
import { describeRoute, envFetch, openWebSocket } from "./proxy.js";

export const VERSION = "0.8.0";
export const DEFAULT_BASE_URL = "https://api.withruntime.com";

export type RequestOptions = {
  /** Sent as Idempotency-Key. Omit it: the SDK makes one per call and keeps
   * it across its own retries, so a retried write never happens twice. Pass
   * your own only to retry a call yourself after the process restarted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Deadline for this call, retries included. */
  timeoutMs?: number;
};

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export type Call = RequestOptions & {
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
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use an HTTPS API origin (or http://localhost for tests).");
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

/** 503s that are a deliberate state, not a passing one: a product switched
 * off here, or paused on purpose. Retrying cannot change them, so they fail
 * at once with their own words. host_unavailable and busy are still retried. */
const DELIBERATE = new Set(["fork_unavailable", "previews_unavailable", "unavailable"]);

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

/** At most `maximum` holders at once; the rest wait their turn, first come
 * first served. */
function slots(maximum: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async take(): Promise<void> {
      if (active < maximum) {
        active++;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
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
    this.baseUrl = apiOrigin(options.baseUrl ?? DEFAULT_BASE_URL);
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
    const apiKey = await this.#key();
    const write = call.method !== "GET";
    const key = write ? (call.idempotencyKey ?? crypto.randomUUID()) : undefined;
    // Time spent waiting for room is added to the call's deadline, not taken
    // from it: once admitted, a create still has its whole timeoutMs.
    const roomMs = Math.max(0, call.waitForCapacityMs ?? 0);
    const roomUntil = performance.now() + roomMs;
    let roomAttempt = 0;
    const deadline = AbortSignal.timeout((call.timeoutMs ?? this.#timeoutMs) + roomMs);
    const signal = call.signal ? AbortSignal.any([call.signal, deadline]) : deadline;
    const url = `${this.baseUrl}${call.path}${encodeQuery(call.query)}`;
    const body = call.bytes ?? (call.body === undefined ? undefined : JSON.stringify(call.body));
    const retry = call.retry ?? true;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      // Called as a plain function: Cloudflare Workers' fetch throws "Illegal
      // invocation" when called as a method of another object (this.#fetch()).
      const send = this.#fetch;
      try {
        // "manual", not "error": Workers accept only "follow" and "manual".
        // The API never redirects, so a redirect is refused here exactly as
        // "error" refused it: thrown, retried, then a connection_error.
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
      } catch (cause) {
        // A proxy variable the SDK cannot use: retrying cannot change it.
        if (cause instanceof RuntimeError) throw cause;
        if (signal.aborted || !retry || attempt >= this.#maxRetries) {
          const route = this.#routed && !signal.aborted ? describeRoute(url, cause) : { via: "" };
          throw new ConnectionError({
            message: signal.aborted
              ? "The call was cancelled or ran past its deadline."
              : write
                ? `No answer from Runtime at ${this.baseUrl}${route.via}. The change may have happened; retrying with the same idempotencyKey is safe.`
                : `No answer from Runtime at ${this.baseUrl}${route.via}.`,
            hint: signal.aborted
              ? "Raise timeoutMs for a long call, or retry with the same idempotencyKey."
              : (route.hint ?? "Check the network, and RUNTIME_API_URL if you set it."),
            code: signal.aborted ? "timeout" : "connection_error",
            status: 0,
            ...(key ? { idempotencyKey: key } : {}),
            cause,
          });
        }
        await sleep(backoff(attempt), signal);
        continue;
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
        if (failed === undefined) return new Response(text, { headers: response.headers });
        late = { status: failed, text };
      } else if (response.ok) return response;
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
        call.onCapacityWait?.(error, pause);
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
    }
  }

  async json<T>(call: Call): Promise<T> {
    await this.#slots.take();
    try {
      const text = await (await this.send(call)).text();
      return (text ? JSON.parse(text) : null) as T;
    } finally {
      this.#slots.give();
    }
  }

  async bytes(call: Call): Promise<Uint8Array> {
    await this.#slots.take();
    try {
      return new Uint8Array(await (await this.send(call)).arrayBuffer());
    } finally {
      this.#slots.give();
    }
  }

  /** A file's bytes, read whole and checked: the API says a body's length
   * (x-content-length) and, when small, its SHA-256 (x-content-sha256) before
   * sending it, and a body that falls short or differs is read again, twice,
   * then refused. Nothing between the API and here reliably turns a stream
   * cut part way into an error: on 25 September 2026 a 50 MB file came back
   * 29 MB long, exit 0. */
  async fileBytes(call: Call): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      await this.#slots.take();
      let failure: RuntimeError;
      try {
        const response = await this.send(call);
        const body = new Uint8Array(await response.arrayBuffer());
        const problem = await checkBody(response.headers, body);
        if (!problem) return body;
        failure = problem;
      } finally {
        this.#slots.give();
      }
      if (attempt >= 2 || call.signal?.aborted) throw failure;
      await sleep(backoff(attempt), call.signal);
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
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) yield JSON.parse(line) as T;
          newline = buffer.indexOf("\n");
        }
      }
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
