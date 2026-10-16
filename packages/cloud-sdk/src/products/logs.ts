import { RuntimeError, InvalidRequestError } from "../errors.js";
import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";

/** Native logsd hit_json. Nanoseconds stay strings so no precision is lost. */
export type LogLine = {
  time: string;
  timeUnixNano: string;
  severity: number;
  severityText: string;
  body: unknown;
  labels: Record<string, string>;
  attributes: Record<string, unknown>;
  traceId: string | null;
  spanId: string | null;
};
export type LogSearch = {
  query: string;
  start?: string;
  end?: string;
  limit?: number;
  direction?: "forward" | "backward";
  cursor?: string;
};
export type LogSearchResult = {
  lines: LogLine[];
  next?: string | null;
  stats: {
    ms: number;
    blocks: number;
    skippedByTime: number;
    skippedByLabels: number;
    skippedByWords: number;
    scanned: number;
    bytesRead: number;
  };
};
export type TailGap = { gap: true; from: string; to: string };
export type TailLine = LogLine & { cursor: string; gap?: false };
export type TailEvent = TailLine | TailGap;
export type LogQuery = {
  query: string;
  time?: string;
  limit?: number;
  direction?: "forward" | "backward";
};
export type LogRange = Omit<LogQuery, "time"> & {
  start?: string;
  end?: string;
  step?: string;
  interval?: string;
};
export type LokiResult = {
  status: "success";
  data: (
    | {
        resultType: "streams";
        result: {
          stream: Record<string, string>;
          values: [string, string, Record<string, string>?][];
        }[];
      }
    | {
        resultType: "matrix";
        result: { metric: Record<string, string>; values: [number, string][] }[];
      }
    | {
        resultType: "vector";
        result: { metric: Record<string, string>; value: [number, string] }[];
      }
    | { resultType: "scalar"; result: [number, string] }
  ) & { stats?: Record<string, unknown> };
};
export type LabelResult = { status: "success"; data: string[] };
export type ViewInput = {
  name: string;
  labels: Record<string, string>;
  query: string;
  defaultRange?: string;
};
export type SavedView = ViewInput & { id: string; state: string; createdAt: string };
export type AlertInput = {
  name: string;
  labels: Record<string, string>;
  query: string;
  condition: string;
  for: string;
  actions: Record<string, unknown>[];
};
export type Alert = AlertInput & { id: string; state: string; createdAt: string };
/** OTLP/HTTP JSON; the server validates the signal's complete OTLP schema. */
export type OtlpLogs = { resourceLogs: Record<string, unknown>[] };
export type OtlpTraces = { resourceSpans: Record<string, unknown>[] };
export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: { key: string; value: Record<string, unknown> }[];
  status?: { code?: number; message?: string };
};
export type Trace = {
  resourceSpans: {
    resource?: { attributes?: { key: string; value: Record<string, unknown> }[] };
    scopeSpans: { spans: TraceSpan[] }[];
  }[];
};
export type TraceSearchResult = {
  traces: {
    traceID: string;
    rootServiceName: string;
    rootTraceName: string;
    startTimeUnixNano: string;
    durationMs: number;
  }[];
  metrics?: Record<string, unknown>;
};

const enc = encodeURIComponent;
const protocol = (message: string) =>
  new RuntimeError({
    code: "invalid_stream",
    status: 422,
    message,
    hint: "Reconnect the log tail. If this repeats, report the request to support.",
  });

/** Shared CRUD keeps the saved log and trace views on identical contracts. */
function resources<Input, Resource>(t: Transport, path: string) {
  const list = async (
    query: { limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<Resource>> => {
    const page = await t.json<{ data: Resource[]; nextCursor: string | null }>({
      method: "GET",
      path,
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  return {
    create: (body: Input, options?: RequestOptions) =>
      t.json<Resource>({ method: "POST", path, body, ...options }),
    get: (id: string, options?: RequestOptions) =>
      t.json<Resource>({ method: "GET", path: `${path}/${enc(id)}`, ...options }),
    list,
    update: (id: string, body: Partial<Input>, options?: RequestOptions) =>
      t.json<Resource>({ method: "PUT", path: `${path}/${enc(id)}`, body, ...options }),
    delete: (id: string, options?: RequestOptions) =>
      t.json<void>({ method: "DELETE", path: `${path}/${enc(id)}`, ...options }),
  };
}
function ingest(t: Transport, path: string, body: OtlpLogs | OtlpTraces, options?: RequestOptions) {
  if (new TextEncoder().encode(JSON.stringify(body)).length > 1_048_576)
    throw new InvalidRequestError({
      code: "payload_too_large",
      status: 413,
      message: "OTLP JSON exceeds 1 MiB.",
      hint: "Split the write into smaller batches, each with its own idempotency key.",
    });
  return t.json<{
    partialSuccess?: { rejectedLogRecords?: string; rejectedSpans?: string; errorMessage?: string };
  }>({ method: "POST", path, body, ...options });
}

/** Parse SSE incrementally, including split UTF-8, CRLF and multi-line data.
 * Incomplete events at disconnect are discarded and replayed from the cursor.
 * A finite event bound prevents a broken peer from growing memory forever. */
async function* events(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    id = "",
    event = "",
    data: string[] = [],
    size = 0;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read().catch((cause: unknown) => {
        signal?.throwIfAborted();
        throw new RuntimeError({
          code: "tail_connection_lost",
          status: 503,
          message: "The log stream disconnected.",
          hint: "The SDK resumes from the last delivered cursor.",
          cause,
        });
      });
      signal?.throwIfAborted();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match || (match[0] === "\r" && match.index === buffer.length - 1)) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        size += line.length + 1;
        if (size > 1_048_576) throw protocol("A log event exceeds 1 MiB of text.");
        if (!line) {
          if (data.length) yield { id, event, data: data.join("\n") };
          id = "";
          event = "";
          data = [];
          size = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "id" && !value.includes("\0")) id = value;
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }
      }
      if (buffer.length + size > 1_048_576) throw protocol("A log event exceeds 1 MiB of text.");
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
      );
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Hidden until Logs launches. */
export function logs(t: Transport) {
  const search = (body: LogSearch, options?: RequestOptions) =>
    t.json<LogSearchResult>({ method: "POST", path: "/v1/logs:search", body, ...options });
  return {
    search,
    async *pages(input: LogSearch, options?: RequestOptions): AsyncGenerator<LogSearchResult> {
      let cursor = input.cursor;
      const seen = new Set<string>();
      if (cursor) seen.add(cursor);
      do {
        const page = await search({ ...input, ...(cursor ? { cursor } : {}) }, options);
        yield page;
        cursor = page.next ?? undefined;
        if (cursor && seen.has(cursor)) throw protocol("Search repeated a paging cursor.");
        if (cursor) seen.add(cursor);
      } while (cursor);
    },
    /** The record's cursor, not timestamp or text, identifies a line. The
     * server replays strictly after it. An echoed boundary is ignored; two
     * identical lines at different record positions are both delivered. */
    async *tail(
      query: string,
      options: RequestOptions & { cursor?: string; start?: string; reconnectMs?: number } = {},
    ): AsyncGenerator<TailEvent> {
      const { cursor: initial, start, reconnectMs = 250, ...request } = options;
      let cursor = initial,
        failures = 0;
      if (!Number.isFinite(reconnectMs) || reconnectMs < 0)
        throw protocol("Reconnect delay must be a finite, nonnegative number.");
      for (;;) {
        request.signal?.throwIfAborted();
        try {
          const stream = await t.fileStream({
            method: "GET",
            path: "/v1/logs/tail",
            query: { query, cursor, start },
            accept: "text/event-stream",
            ...request,
            timeoutMs: request.timeoutMs ?? 0,
            onResponse(response) {
              if (
                !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
              )
                throw protocol("Log tail did not return text/event-stream.");
            },
          });
          for await (const event of events(stream, request.signal)) {
            let value: unknown;
            try {
              value = JSON.parse(event.data);
            } catch {
              throw protocol("Log tail returned invalid JSON.");
            }
            if (event.event === "error") {
              // A reader failure is retryable, but its resume id has not been
              // delivered as a line. Keep the last acknowledged line cursor.
              throw new RuntimeError({
                code: "tail_interrupted",
                status: 503,
                message: "The log reader stopped.",
                hint: "The SDK resumes from the last delivered cursor.",
              });
            }
            if (!event.id) throw protocol("Log tail event has no record cursor.");
            if (event.id === cursor) continue;
            if (event.event === "start") {
              // Where the server's tail begins: a reconnect before the first
              // line resumes here, so nothing written meanwhile is missed.
              cursor = event.id;
              continue;
            }
            if (event.event === "gap") {
              const gap = value as (Partial<TailGap> & { cursor?: string }) | null;
              const from = gap?.from ?? cursor;
              const to = gap?.to ?? gap?.cursor;
              if (typeof from !== "string" || typeof to !== "string" || to !== event.id)
                throw protocol("Log tail gap has invalid cursors.");
              cursor = event.id;
              yield { gap: true, from, to };
            } else {
              const line = value as Partial<LogLine> | null;
              if (
                !line ||
                typeof line.timeUnixNano !== "string" ||
                typeof line.time !== "string" ||
                !line.labels ||
                !("body" in line)
              )
                throw protocol("Log tail returned an invalid line.");
              cursor = event.id;
              yield { ...(line as LogLine), cursor };
            }
            failures = 0;
          }
        } catch (error) {
          request.signal?.throwIfAborted();
          if (error instanceof RuntimeError && !error.retryable) throw error;
          if (!(error instanceof RuntimeError) && !(error instanceof TypeError)) throw error;
        }
        await pause(
          Math.min(10_000, Math.max(0, reconnectMs) * 2 ** Math.min(failures++, 6)),
          request.signal,
        );
      }
    },
    query: (query: LogQuery, options?: RequestOptions) =>
      t.json<LokiResult>({ method: "GET", path: "/v1/logs/query", query, ...options }),
    queryRange: (query: LogRange, options?: RequestOptions) =>
      t.json<LokiResult>({ method: "GET", path: "/v1/logs/query_range", query, ...options }),
    labels: (query: { start?: string; end?: string } = {}, options?: RequestOptions) =>
      t.json<LabelResult>({ method: "GET", path: "/v1/logs/labels", query, ...options }),
    labelValues: (
      name: string,
      query: { start?: string; end?: string } = {},
      options?: RequestOptions,
    ) =>
      t.json<LabelResult>({
        method: "GET",
        path: `/v1/logs/labels/${enc(name)}/values`,
        query,
        ...options,
      }),
    views: resources<ViewInput, SavedView>(t, "/v1/logs/views"),
    ingest: (body: OtlpLogs, options?: RequestOptions) => ingest(t, "/v1/logs", body, options),
  };
}
export function traces(t: Transport) {
  return {
    get: (id: string, options?: RequestOptions) =>
      t.json<Trace>({ method: "GET", path: `/v1/traces/${enc(id)}`, ...options }),
    search: (q: string, options?: RequestOptions) =>
      t.json<TraceSearchResult>({
        method: "GET",
        path: "/v1/traces:search",
        query: { q },
        ...options,
      }),
    tags: (options?: RequestOptions) =>
      t.json<{ tagNames: string[] }>({ method: "GET", path: "/v1/traces/tags", ...options }),
    views: resources<ViewInput, SavedView>(t, "/v1/traces/views"),
    ingest: (body: OtlpTraces, options?: RequestOptions) => ingest(t, "/v1/traces", body, options),
  };
}
export function alerts(t: Transport) {
  return {
    ...resources<AlertInput, Alert>(t, "/v1/alerts"),
    test: (id: string, options?: RequestOptions) =>
      t.json<{ firing: boolean; matches: number }>({
        method: "POST",
        path: `/v1/alerts/${enc(id)}/test`,
        body: {},
        ...options,
      }),
    silence: (id: string, input: { until: string; reason?: string }, options?: RequestOptions) =>
      t.json<Alert>({
        method: "POST",
        path: `/v1/alerts/${enc(id)}/silence`,
        body: input,
        ...options,
      }),
  };
}
export type ObservabilityClient = {
  logs: ReturnType<typeof logs>;
  traces: ReturnType<typeof traces>;
  alerts: ReturnType<typeof alerts>;
};
