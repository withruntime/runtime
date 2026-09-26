import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Readable } from "node:stream";
import type { FileEntry } from "../types.js";
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

const PERMISSIONS = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];

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

async function bytesOf(source: UploadSource): Promise<Uint8Array> {
  if (typeof source === "string") {
    const { readFile } = await import("node:fs/promises");
    return readFile(source);
  }
  if (source instanceof Uint8Array) return source;
  if (typeof (source as ReadableStream).getReader === "function")
    return new Uint8Array(await new Response(source as ReadableStream).arrayBuffer());
  const chunks: Buffer[] = [];
  for await (const chunk of source as Readable)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
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
  async downloadFile(remotePath: string, localOrTimeout?: string | number): Promise<Buffer | void> {
    const target = await this.#path(remotePath);
    const files = await this.#files();
    if (typeof localOrTimeout !== "string")
      return Buffer.from(await guard("file", () => files.read(target)));
    // Streamed to disk, any size, checked against the file's length.
    await guard("file", () => files.download(target, localOrTimeout));
  }

  /** The file as it arrives, without holding it in memory. It errors with
   * `download_incomplete` if it ends short of the file's length. */
  async downloadFileStream(remotePath: string): Promise<Readable> {
    const { Readable } = await import("node:stream");
    const target = await this.#path(remotePath);
    const files = await this.#files();
    const stream = await guard("file", () => files.readStream(target));
    return Readable.fromWeb(stream as unknown as WebReadableStream<Uint8Array>);
  }

  /** Several files; a file that fails carries `error` instead of `result`. */
  async downloadFiles(files: FileDownloadRequest[]): Promise<FileDownloadResponse[]> {
    const out: FileDownloadResponse[] = [];
    for (const file of files) {
      try {
        if (file.destination) {
          await this.downloadFile(file.source, file.destination);
          out.push({ source: file.source, result: file.destination });
        } else out.push({ source: file.source, result: await this.downloadFile(file.source) });
      } catch (error) {
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
  async uploadFile(source: Buffer | string, remotePath: string): Promise<void> {
    const target = await this.#path(remotePath);
    const bytes = await bytesOf(source);
    const files = await this.#files();
    await guard("file", () => files.write(target, bytes));
  }

  async uploadFileStream(source: UploadSource, remotePath: string): Promise<void> {
    const target = await this.#path(remotePath);
    const bytes = await bytesOf(source);
    const files = await this.#files();
    await guard("file", () => files.write(target, bytes));
  }

  async uploadFiles(files: FileUpload[]): Promise<void> {
    for (const file of files) {
      const target = await this.#path(file.destination);
      const bytes = await bytesOf(file.source);
      const api = await this.#files();
      await guard("file", () => api.write(target, bytes));
    }
  }
}
