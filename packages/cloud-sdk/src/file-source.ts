import type { FileHandle } from "node:fs/promises";
import { RuntimeError } from "./errors.js";

export type StreamUploadSource =
  string | Blob | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
export type UploadScope = {
  signal?: AbortSignal;
  check(): void;
  wait<T>(pending: Promise<T>): Promise<T>;
};
export type PreparedFileSource = {
  size: number;
  sha256: string;
  chunkAt(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
};

type SliceableBlob = { slice(start: number, end: number): Pick<Blob, "arrayBuffer"> };

const CHUNK = 1_048_576;
function failure(message: string, code: string, cause?: unknown) {
  return new RuntimeError({ message, code, status: 0, ...(cause === undefined ? {} : { cause }) });
}

async function exact(handle: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const data = new Uint8Array(length);
  let held = 0;
  while (held < length) {
    const read = await handle.read(data, held, length - held, offset + held);
    if (read.bytesRead === 0)
      throw failure(
        "The local upload source changed or ended before its declared size.",
        "source_changed",
      );
    held += read.bytesRead;
  }
  return data;
}

/** ARCHITECTURE.md section 10, Folders over HTTP: unknown-length inputs use
 * bounded private disk staging; known files and Blobs remain repeatable inputs.
 * Size and digest are established before the remote upload can begin. */
export async function prepareFileSource(
  input: StreamUploadSource,
  scope: UploadScope,
): Promise<PreparedFileSource> {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { Readable } = await import("node:stream");
  scope.check();
  const hash = createHash("sha256");
  let size = 0;
  let handle: FileHandle | undefined;
  let staging: string | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  // What is used of a reader, so the code compiles against Node's stream types
  // as well as the DOM's (packages/cloud compiles this file without DOM).
  let reader:
    | {
        read(): Promise<{ done?: boolean; value?: Uint8Array }>;
        cancel(reason?: unknown): Promise<void>;
        releaseLock(): void;
      }
    | undefined;
  const cleanup = async () => {
    try {
      await handle?.close();
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true });
    }
  };
  try {
    if (typeof input === "string") {
      handle = await fs.open(input, "r");
      const info = await handle.stat();
      if (!info.isFile() || !Number.isSafeInteger(info.size))
        throw failure(
          "A streamed file upload requires a regular local file.",
          "invalid_upload_source",
        );
      size = info.size;
      for (let offset = 0; offset < size; offset += CHUNK) {
        scope.check();
        hash.update(await scope.wait(exact(handle, offset, Math.min(CHUNK, size - offset))));
      }
    } else if (input instanceof Blob) {
      // Bun's types leave out Blob.slice when the DOM library is off, as it is
      // where packages/cloud compiles this file; every runtime has it.
      const blob = input as Blob & SliceableBlob;
      size = blob.size;
      for (let offset = 0; offset < size; offset += CHUNK) {
        scope.check();
        hash.update(
          new Uint8Array(await scope.wait(blob.slice(offset, offset + CHUNK).arrayBuffer())),
        );
      }
      return {
        size,
        sha256: hash.digest("hex"),
        chunkAt: async (offset, length) =>
          new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
        close: async () => undefined,
      };
    } else {
      if (
        !input ||
        (typeof (input as ReadableStream).getReader !== "function" &&
          typeof (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function")
      )
        throw failure(
          "A streamed upload requires a byte stream or local file.",
          "invalid_upload_source",
        );
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      staging = await fs.mkdtemp(path.join(tmpdir(), "runtime-upload-"));
      await fs.chmod(staging, 0o700);
      handle = await fs.open(path.join(staging, "source"), "wx+", 0o600);
      const space = await fs.statfs(staging, { bigint: true });
      const available = space.bavail * space.bsize;
      if ("getReader" in input) reader = input.getReader();
      else iterator = input[Symbol.asyncIterator]();
      for (;;) {
        scope.check();
        const next: { done?: boolean; value?: Uint8Array } = await scope.wait<{
          done?: boolean;
          value?: Uint8Array;
        }>(reader ? reader.read() : iterator!.next());
        if (next.done) break;
        if (!(next.value instanceof Uint8Array))
          throw failure("A streamed upload must produce byte chunks.", "invalid_upload_source");
        for (let offset = 0; offset < next.value.length; offset += CHUNK) {
          scope.check();
          const part = next.value.subarray(offset, offset + CHUNK);
          if (!Number.isSafeInteger(size + part.length))
            throw failure(
              "The streamed upload exceeds the native file size range.",
              "upload_too_large",
            );
          if (BigInt(size + part.length) > available)
            throw failure(
              "There is not enough local temporary disk space to stage the streamed upload.",
              "local_disk_full",
            );
          let written = 0;
          while (written < part.length) {
            scope.check();
            const result = await handle.write(part, written, part.length - written, size + written);
            if (result.bytesWritten === 0)
              throw failure(
                "The local temporary file accepted no upload bytes.",
                "local_disk_full",
              );
            written += result.bytesWritten;
          }
          size += part.length;
          hash.update(part);
        }
      }
    }
    scope.check();
    const owned = handle;
    if (!owned) throw failure("The local upload file did not open.", "invalid_upload_source");
    return {
      size,
      sha256: hash.digest("hex"),
      chunkAt: (offset, length) => exact(owned, offset, length),
      close: cleanup,
    };
  } catch (error) {
    // Calling return/cancel can itself throw synchronously. Cleanup still owns
    // the file and directory, and must preserve the original source failure.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Node's pending next() must settle before iterator.return() can finish.
      // Web readers own cancellation directly; arbitrary iterators may not.
      if (input instanceof Readable) input.destroy();
      const closing = reader ? reader.cancel(scope.signal?.reason) : iterator?.return?.();
      if (closing)
        await Promise.race([
          closing,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
    } catch {
      /* Preserve the caller's original failure. */
    } finally {
      if (timer) clearTimeout(timer);
      await cleanup().catch(() => undefined);
    }
    if ((error as NodeJS.ErrnoException)?.code === "ENOSPC")
      throw failure(
        "There is not enough local temporary disk space to stage the streamed upload.",
        "local_disk_full",
        error,
      );
    throw error;
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      /* Cancellation may leave a pending caller-owned read. */
    }
  }
}
