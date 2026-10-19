/** Cloudflare's stream helpers and type guards: the adapter's streams are
 * server-sent events in Cloudflare's own shapes, so these read them as
 * Cloudflare's do. */

export type FileMetadata = {
  mimeType: string;
  size: number;
  isBinary: boolean;
  encoding: "utf-8" | "base64";
};
export type FileChunk = string | Uint8Array;
export type FileStreamEvent =
  | ({ type: "metadata" } & FileMetadata)
  | { type: "chunk"; data: string }
  | { type: "complete"; bytesRead: number }
  | { type: "error"; error: string };

/** One `data:` line per event, as Cloudflare's container sends them. */
export function sseStream<T>(
  events: (send: (event: T) => void, signal: AbortSignal) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encode = new TextEncoder();
  const cancelled = new AbortController();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await events((event) => {
          if (!cancelled.signal.aborted)
            controller.enqueue(encode.encode(`data: ${JSON.stringify(event)}\n\n`));
        }, cancelled.signal);
        if (!cancelled.signal.aborted) controller.close();
      } catch (error) {
        if (!cancelled.signal.aborted) controller.error(error);
      }
    },
    cancel(reason) {
      cancelled.abort(reason);
    },
  });
}

/** The events of a server-sent-events stream, each `data:` parsed as JSON;
 * `[DONE]`, blank and unparsable data are skipped, as Cloudflare's do. */
export async function* parseSSEStream<T>(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const aborted = () => {
    if (signal?.aborted) throw new Error("Operation was aborted");
  };
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort);
  const parse = function* (final: boolean) {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? "" : lines.pop()!;
    for (const line of lines) {
      if (line === "") {
        const text = data.join("\n");
        data = [];
        if (text.trim() === "" || text === "[DONE]") continue;
        try {
          yield JSON.parse(text) as T;
        } catch {
          // Cloudflare skips data that is not JSON.
        }
      } else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
    }
  };
  try {
    for (;;) {
      aborted();
      const { done, value } = await reader.read();
      aborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* parse(false);
    }
    buffer += "\n\n";
    yield* parse(true);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** The events of a server-sent-events Response, as parseSSEStream reads them. */
export async function* responseToAsyncIterable<T>(
  response: Response,
  signal?: AbortSignal,
): AsyncIterable<T> {
  if (!response.ok) throw new Error(`Response not ok: ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error("No response body");
  yield* parseSSEStream<T>(response.body, signal);
}
/** Events as a server-sent-events stream, one `data:` line each, then
 * `data: [DONE]`, as Cloudflare's helper writes them. */
export function asyncIterableToSSEStream<T>(
  events: AsyncIterable<T>,
  options: { signal?: AbortSignal; serialize?: (event: T) => string } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const serialize = options.serialize ?? ((event: T) => JSON.stringify(event));
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          if (options.signal?.aborted) throw new Error("Operation was aborted");
          controller.enqueue(encoder.encode(`data: ${serialize(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** A `readFileStream()` stream's chunks: strings for text, bytes for binary.
 * Returns the file's metadata. */
export async function* streamFile(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<FileChunk, FileMetadata> {
  let metadata: FileMetadata | null = null;
  for await (const event of parseSSEStream<FileStreamEvent>(stream))
    switch (event.type) {
      case "metadata":
        metadata = {
          mimeType: event.mimeType,
          size: event.size,
          isBinary: event.isBinary,
          encoding: event.encoding,
        };
        break;
      case "chunk":
        if (!metadata) throw new Error("Received chunk before metadata");
        yield metadata.isBinary && metadata.encoding === "base64"
          ? Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0))
          : event.data;
        break;
      case "complete":
        if (!metadata) throw new Error("Stream completed without metadata");
        return metadata;
      case "error":
        throw new Error(`File streaming error: ${event.error}`);
    }
  throw new Error("Stream ended unexpectedly");
}

/** A whole `readFileStream()` file in memory, with its metadata. */
export async function collectFile(
  stream: ReadableStream<Uint8Array>,
): Promise<{ content: string | Uint8Array; metadata: FileMetadata }> {
  const chunks: FileChunk[] = [];
  const reading = streamFile(stream);
  let next = await reading.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await reading.next();
  }
  const metadata = next.value;
  if (!metadata.isBinary)
    return { content: chunks.filter((c) => typeof c === "string").join(""), metadata };
  const bytes = chunks.filter((c): c is Uint8Array => c instanceof Uint8Array);
  const content = new Uint8Array(bytes.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of bytes) {
    content.set(chunk, offset);
    offset += chunk.length;
  }
  return { content, metadata };
}

export function isExecResult(value: unknown): boolean {
  const v = value as Record<string, unknown> | null | undefined;
  return (
    !!v &&
    typeof v.success === "boolean" &&
    typeof v.exitCode === "number" &&
    typeof v.stdout === "string" &&
    typeof v.stderr === "string"
  );
}
export function isProcess(value: unknown): boolean {
  const v = value as Record<string, unknown> | null | undefined;
  return (
    !!v && typeof v.id === "string" && typeof v.command === "string" && typeof v.status === "string"
  );
}
export function isProcessStatus(value: string): boolean {
  return ["starting", "running", "completed", "failed", "killed", "error"].includes(value);
}
