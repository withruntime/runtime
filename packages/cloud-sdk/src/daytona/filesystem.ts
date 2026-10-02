import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Readable } from "node:stream";
import type { FileEntry } from "../types.js";
import type { RequestOptions } from "../transport.js";
import { resolvePath, WHOLE_OUTPUT, type SandboxContext } from "./context.js";
import { DaytonaError, DaytonaFileNotFoundError, guard } from "./errors.js";

export interface FileInfo {
  name: string;
  isDir: boolean;
  size: number;
  modTime: string;
  mode: string;
  permissions: string;
  /** Runtime's listing does not say who owns a file: always "". */
  owner: string;
  group: string;
}
export interface Match {
  file: string;
  line: number;
  content: string;
}
export interface ReplaceResult {
  file?: string;
  success?: boolean;
  error?: string;
}
export interface SearchFilesResponse {
  files: string[];
}
export type FilePermissionsParams = { group?: string; mode?: string; owner?: string };
export interface FileUpload {
  source: string | Buffer | Uint8Array;
  destination: string;
}
export interface FileDownloadRequest {
  source: string;
  destination?: string;
}
export interface FileDownloadResponse {
  source: string;
  result?: Buffer | string;
  error?: string;
  errorDetails?: { message: string; statusCode?: number; code?: string; source?: string };
}
export type UploadSource = Buffer | Uint8Array | string | Readable | ReadableStream<Uint8Array>;
export type UploadProgress = { bytesSent: number };
export type UploadStreamOptions = {
  signal?: AbortSignal;
  timeout?: number;
  onProgress?: (progress: UploadProgress) => void;
};

const PERMISSIONS = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];

function downloadRequest(timeout: number, signal?: AbortSignal): RequestOptions {
  if (!Number.isFinite(timeout) || timeout < 0)
    throw new DaytonaError("Download timeout must be a nonnegative finite number.");
  signal?.throwIfAborted();
  const deadline = timeout > 0 ? AbortSignal.timeout(Math.ceil(timeout * 1000)) : undefined;
  return {
    timeoutMs: 0,
    ...(deadline || signal
      ? {
          signal: deadline && signal ? AbortSignal.any([deadline, signal]) : (deadline ?? signal),
        }
      : {}),
  };
}

/** Wait on client-local setup within the transfer's existing deadline. The
 * setup may finish later; the caller cannot proceed to an upload after abort. */
function waitForRequest<T>(pending: Promise<T>, request: RequestOptions): Promise<T> {
  const signal = request.signal;
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the caller's abort reason as is, as the upstream SDK does
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- passes the pending call's own failure through unchanged
        reject(error);
      },
    );
  });
}

function fileInfo(entry: FileEntry): FileInfo {
  const bits = (parseInt(entry.mode, 8) || 0) & 0o777;
  const kind = entry.type === "directory" ? "d" : entry.type === "symlink" ? "l" : "-";
  return {
    name: entry.name,
    isDir: entry.type === "directory",
    size: entry.size,
    modTime: entry.modifiedAt,
    mode: `${kind}${PERMISSIONS[(bits >> 6) & 7]}${PERMISSIONS[(bits >> 3) & 7]}${PERMISSIONS[bits & 7]}`,
    permissions: `0${bits.toString(8).padStart(3, "0")}`,
    owner: "",
    group: "",
  };
}

/** `sandbox.fs`: Daytona's file calls over Runtime's files API. Relative
 * paths resolve from the working directory, /workspace on Runtime. */
export class FileSystem {
  readonly #ctx: SandboxContext;
  constructor(ctx: SandboxContext) {
    this.#ctx = ctx;
  }
  async #path(path: string) {
    await this.#ctx.ensureHome(path);
    return resolvePath(path);
  }
  async #files() {
    return (await this.#ctx.live()).files;
  }
  async #run(argv: string[]): Promise<string> {
    const runtime = await this.#ctx.live();
    const result = await guard("sandbox", () => runtime.exec(argv));
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || `${argv[0]} exited with ${result.exitCode}`;
      if (/No such file or directory/.test(message))
        throw new DaytonaFileNotFoundError(message, 404);
      throw new DaytonaError(message, 400);
    }
    return result.stdout;
  }

  /** Makes a directory and its parents, with `mode` (such as "755"). */
  async createFolder(path: string, mode: string): Promise<void> {
    const target = await this.#path(path);
    await this.#run(["mkdir", "-p", "-m", mode, "--", target]);
    await this.#own(target);
  }

  /** Gives what this client wrote to create's `user`, so its commands may
   * change it; the owner's files stay the owner's. */
  async #own(target: string) {
    if (this.#ctx.user) await this.#run(["sudo", "chown", this.#ctx.user, "--", target]);
  }

  async deleteFile(path: string, recursive = false): Promise<void> {
    const target = await this.#path(path);
    const files = await this.#files();
    const removed = await guard("file", () => files.remove(target, { recursive }));
    if (!removed) throw new DaytonaFileNotFoundError(`${target} does not exist.`, 404);
  }

  /** The file's bytes, or with a local path, the file written there. */
  downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  downloadFile(remotePath: string, localPath: string, timeout?: number): Promise<void>;
  async downloadFile(
    remotePath: string,
    localOrTimeout?: string | number,
    timeout = 30 * 60,
  ): Promise<Buffer | void> {
    // The numeric second argument is the published buffer overload. In that
    // overload zero falls back to the default, as the pinned SDK does.
    const request = downloadRequest(
      typeof localOrTimeout === "number" && localOrTimeout !== 0 ? localOrTimeout : timeout,
    );
    return this.#downloadFile(
      remotePath,
      typeof localOrTimeout === "string" ? localOrTimeout : undefined,
      request,
    );
  }

  async #downloadFile(
    remotePath: string,
    localPath: string | undefined,
    request: RequestOptions,
  ): Promise<Buffer | void> {
    request.signal?.throwIfAborted();
    const target = await this.#path(remotePath);
    const files = await this.#files();
    request.signal?.throwIfAborted();
    if (localPath === undefined)
      return Buffer.from(await guard("file", () => files.read(target, request)));
    // Streamed to disk, any size, checked against the file's length.
    await guard("file", () => files.download(target, localPath, request));
  }

  /** The file as it arrives, without holding it in memory. It errors with
   * `download_incomplete` if it ends short of the file's length. */
  async downloadFileStream(
    remotePath: string,
    timeoutOrOptions?: number | { timeout?: number; signal?: AbortSignal },
  ): Promise<Readable> {
    const options =
      typeof timeoutOrOptions === "number"
        ? { timeout: timeoutOrOptions }
        : (timeoutOrOptions ?? {});
    const request = downloadRequest(options.timeout ?? 30 * 60, options.signal);
    const { Readable } = await import("node:stream");
    const target = await this.#path(remotePath);
    const files = await this.#files();
    request.signal?.throwIfAborted();
    const stream = await guard("file", () => files.readStream(target, request));
    return Readable.fromWeb(stream as unknown as WebReadableStream<Uint8Array>);
  }

  /** Several files; a file that fails carries `error` instead of `result`. */
  async downloadFiles(
    files: FileDownloadRequest[],
    timeout = 30 * 60,
  ): Promise<FileDownloadResponse[]> {
    const request = downloadRequest(timeout);
    const out: FileDownloadResponse[] = [];
    for (const file of files) {
      request.signal?.throwIfAborted();
      try {
        if (file.destination) {
          await this.#downloadFile(file.source, file.destination, request);
          out.push({ source: file.source, result: file.destination });
        } else
          out.push({
            source: file.source,
            result: (await this.#downloadFile(file.source, undefined, request)) as Buffer,
          });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const failure = error as DaytonaError;
        out.push({
          source: file.source,
          error: failure.message,
          errorDetails: {
            message: failure.message,
            ...(failure.statusCode ? { statusCode: failure.statusCode } : {}),
            ...(failure.code ? { code: failure.code } : {}),
          },
        });
      }
    }
    return out;
  }

  /** Lines matching `pattern` (a grep pattern) in files under `path`. */
  async findFiles(path: string, pattern: string): Promise<Match[]> {
    const target = await this.#path(path);
    const runtime = await this.#ctx.live();
    const result = await guard("sandbox", () =>
      runtime.exec(["grep", "-rnI", "--", pattern, target], WHOLE_OUTPUT),
    );
    if (result.exitCode !== 0 && result.exitCode !== 1)
      throw new DaytonaError(result.stderr.trim() || "grep failed", 400);
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^(.*?):(\d+):(.*)$/.exec(line);
        return match
          ? { file: match[1]!, line: Number(match[2]), content: match[3]! }
          : { file: line, line: 0, content: "" };
      });
  }

  async getFileDetails(path: string): Promise<FileInfo> {
    const target = await this.#path(path);
    const files = await this.#files();
    const found = await guard("file", () => files.stat(target));
    if (!found.exists) throw new DaytonaFileNotFoundError(`${target} does not exist.`, 404);
    return fileInfo(found);
  }

  async listFiles(path: string, options: { depth?: number } = {}): Promise<FileInfo[]> {
    const target = await this.#path(path);
    const files = await this.#files();
    const entries = await guard("file", () =>
      files.list(target, { depth: options.depth ?? 1, hidden: true }),
    );
    return entries.map(fileInfo);
  }

  async moveFiles(source: string, destination: string): Promise<void> {
    const from = await this.#path(source);
    const to = await this.#path(destination);
    const files = await this.#files();
    await guard("file", () => files.rename(from, to, { overwrite: true }));
  }

  /** Replaces every occurrence of `pattern` (plain text) in each file. */
  async replaceInFiles(
    files: string[],
    pattern: string,
    newValue: string,
  ): Promise<ReplaceResult[]> {
    const api = await this.#files();
    const results: ReplaceResult[] = [];
    for (const file of files) {
      const target = await this.#path(file);
      try {
        const text = new TextDecoder().decode(await guard("file", () => api.read(target)));
        await guard("file", () => api.write(target, text.split(pattern).join(newValue)));
        results.push({ file, success: true });
      } catch (error) {
        results.push({ file, success: false, error: (error as Error).message });
      }
    }
    return results;
  }

  /** Paths under `path` matching a glob such as `*.py`. */
  async searchFiles(path: string, pattern: string): Promise<SearchFilesResponse> {
    const target = await this.#path(path);
    const files = await this.#files();
    const glob = pattern.includes("/") || pattern.startsWith("**") ? pattern : `**/${pattern}`;
    const entries = await guard("file", () => files.list(target, { glob, hidden: true }));
    return { files: entries.map((entry) => entry.path) };
  }

  async setFilePermissions(path: string, permissions: FilePermissionsParams): Promise<void> {
    const target = await this.#path(path);
    if (permissions.mode) await this.#run(["chmod", permissions.mode, "--", target]);
    if (permissions.owner || permissions.group)
      await this.#run([
        "sudo",
        "chown",
        `${permissions.owner ?? ""}${permissions.group ? `:${permissions.group}` : ""}`,
        "--",
        target,
      ]);
  }

  /** Writes a file (from bytes, or from a local path), making its
   * directories and replacing one that exists. */
  uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
  uploadFile(localPath: string, remotePath: string, timeout?: number): Promise<void>;
  async uploadFile(source: Buffer | string, remotePath: string, timeout = 30 * 60): Promise<void> {
    await this.#uploadFile(source, remotePath, downloadRequest(timeout));
  }

  async #uploadFile(
    source: UploadSource,
    remotePath: string,
    request: RequestOptions,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void> {
    request.signal?.throwIfAborted();
    const readable =
      typeof source !== "string" && typeof (source as Readable).destroy === "function"
        ? (source as Readable)
        : undefined;
    const stopInput = () => {
      readable?.destroy();
    };
    request.signal?.addEventListener("abort", stopInput, { once: true });
    try {
      const target = await waitForRequest(this.#path(remotePath), request);
      request.signal?.throwIfAborted();
      const files = await waitForRequest(this.#files(), request);
      request.signal?.throwIfAborted();
      // Node Readables can emit strings after setEncoding; Daytona uploads
      // their UTF-8 bytes. The generator retains only the current source chunk.
      const input =
        typeof source === "string" ||
        source instanceof Uint8Array ||
        typeof (source as ReadableStream).getReader === "function"
          ? source
          : (async function* () {
              for await (const chunk of source as Readable)
                yield typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Uint8Array);
            })();
      await guard("file", () =>
        input instanceof Uint8Array && !onProgress
          ? files.write(target, input, request)
          : files.writeStream(target, input, {
              ...request,
              ...(onProgress ? { onProgress } : {}),
            }),
      );
      await this.#own(target);
    } finally {
      request.signal?.removeEventListener("abort", stopInput);
    }
  }

  /** Uploads with bounded memory. Unknown-length streams stage in a private
   * temporary file before the native atomic upload; local paths avoid staging. */
  async uploadFileStream(
    source: UploadSource,
    remotePath: string,
    options: UploadStreamOptions = {},
  ): Promise<void> {
    const cancelled = () => new DaytonaError(`Upload cancelled: ${remotePath}`);
    if (options.signal?.aborted) throw cancelled();
    const request = downloadRequest(options.timeout ?? 30 * 60, options.signal);
    try {
      await this.#uploadFile(source, remotePath, request, options.onProgress);
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      throw error;
    }
  }

  async uploadFiles(files: FileUpload[], timeout = 30 * 60): Promise<void> {
    const request = downloadRequest(timeout);
    for (const file of files) {
      await this.#uploadFile(file.source, file.destination, request);
    }
  }
}
