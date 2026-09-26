import type { FileEntry } from "../types.js";
import { request } from "./client.js";
import type { SandboxContext, Username } from "./commands.js";
import { FileNotFoundError, guard, NotSupportedError } from "./errors.js";

export enum FileType {
  FILE = "file",
  DIR = "dir",
  SYMLINK = "symlink",
}

export interface WriteInfo {
  name: string;
  type?: FileType;
  path: string;
  metadata?: Record<string, string>;
}
export interface EntryInfo extends WriteInfo {
  size: number;
  mode: number;
  permissions: string;
  /** Runtime's listing does not say who owns a file: always "". */
  owner: string;
  /** Runtime's listing does not say a file's group: always "". */
  group: string;
  modifiedTime?: Date;
  symlinkTarget?: string;
}
export enum FilesystemEventType {
  CHMOD = "chmod",
  CREATE = "create",
  REMOVE = "remove",
  RENAME = "rename",
  WRITE = "write",
}
export interface FilesystemEvent {
  /** Relative to the watched directory. */
  name: string;
  type: FilesystemEventType;
}
export interface WatchOpts extends FilesystemRequestOpts {
  /** How long the watch runs; 0 is Runtime's maximum, 24 hours. Default 60000. */
  timeoutMs?: number;
  recursive?: boolean;
}
export interface E2BWatchHandle {
  stop(): Promise<void>;
}
export type WriteEntry = { path: string; data: string | ArrayBuffer | Blob | ReadableStream };

export interface FilesystemRequestOpts {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  /** Only the default user; see CommandStartOpts.user. */
  user?: Username;
}
export interface FilesystemReadOpts extends FilesystemRequestOpts {
  /** Accepted; Runtime's transfer is already compressed where it helps. */
  gzip?: boolean;
  streamIdleTimeoutMs?: number;
}
export interface FilesystemWriteOpts extends FilesystemRequestOpts {
  /** Accepted; Runtime chooses the transfer. */
  gzip?: boolean;
  useOctetStream?: boolean;
  /** Refused: Runtime does not keep metadata on files. */
  metadata?: Record<string, string>;
}
export interface FilesystemListOpts extends FilesystemRequestOpts {
  depth?: number;
}

/** Runtime's home, where E2B's relative paths land. */
const HOME = "/workspace";

function absolute(path: string) {
  return path.startsWith("/") ? path : `${HOME}/${path.replace(/^\.\//, "")}`;
}

function refuse(opts: FilesystemRequestOpts & { metadata?: Record<string, string> }) {
  if (opts.user !== undefined && opts.user !== "user")
    throw new NotSupportedError(
      `File access as the user "${opts.user}"`,
      "Runtime's file calls act as the sandbox owner; use commands.run('sudo ...') for root-owned paths.",
    );
  if (opts.metadata && Object.keys(opts.metadata).length)
    throw new NotSupportedError(
      "File metadata (user.e2b.* extended attributes)",
      "Keep the metadata beside the file, for example in a JSON file.",
    );
}

const PERMISSIONS = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];

function entryInfo(entry: FileEntry): EntryInfo {
  const mode = parseInt(entry.mode, 8) || 0;
  const bits = mode & 0o777;
  return {
    name: entry.name,
    path: entry.path,
    ...(entry.type === "file"
      ? { type: FileType.FILE }
      : entry.type === "directory"
        ? { type: FileType.DIR }
        : entry.type === "symlink"
          ? { type: FileType.SYMLINK }
          : {}),
    size: entry.size,
    mode,
    permissions:
      PERMISSIONS[(bits >> 6) & 7]! + PERMISSIONS[(bits >> 3) & 7]! + PERMISSIONS[bits & 7]!,
    owner: "",
    group: "",
    modifiedTime: new Date(entry.modifiedAt),
  };
}

async function bytesOf(data: string | ArrayBuffer | Blob | ReadableStream): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob)
    return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(await new Response(data).arrayBuffer());
}

const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** `sandbox.files`: E2B's filesystem module over Runtime's files API. Relative
 * paths resolve against the home directory, as in E2B (Runtime's is
 * /workspace). */
export class Filesystem {
  readonly #ctx: SandboxContext;
  constructor(ctx: SandboxContext) {
    this.#ctx = ctx;
  }
  get #files() {
    return this.#ctx.runtime.files;
  }
  async #path(path: string, opts: FilesystemRequestOpts & { metadata?: Record<string, string> }) {
    refuse(opts);
    await this.#ctx.ensureHome(path);
    return absolute(path);
  }

  read(path: string, opts?: FilesystemReadOpts & { format?: "text" }): Promise<string>;
  read(path: string, opts: FilesystemReadOpts & { format: "bytes" }): Promise<Uint8Array>;
  read(path: string, opts: FilesystemReadOpts & { format: "blob" }): Promise<Blob>;
  read(
    path: string,
    opts: FilesystemReadOpts & { format: "stream" },
  ): Promise<ReadableStream<Uint8Array>>;
  async read(
    path: string,
    opts: FilesystemReadOpts & { format?: "text" | "bytes" | "blob" | "stream" } = {},
  ): Promise<string | Uint8Array | Blob | ReadableStream<Uint8Array>> {
    const file = await this.#path(path, opts);
    // A real stream, any size, never the whole file held first.
    if (opts.format === "stream")
      return guard("file", () => this.#files.readStream(file, request(opts)));
    const bytes = await guard("file", () => this.#files.read(file, request(opts)));
    switch (opts.format) {
      case "bytes":
        return bytes;
      case "blob":
        return new Blob([bytes as Uint8Array<ArrayBuffer>]);
      default:
        return new TextDecoder().decode(bytes);
    }
  }

  /** Writes a file, making its directories, and overwrites one that exists. */
  write(
    path: string,
    data: string | ArrayBuffer | Blob | ReadableStream,
    opts?: FilesystemWriteOpts,
  ): Promise<WriteInfo>;
  write(files: WriteEntry[], opts?: FilesystemWriteOpts): Promise<WriteInfo[]>;
  async write(
    pathOrFiles: string | WriteEntry[],
    dataOrOpts?: string | ArrayBuffer | Blob | ReadableStream | FilesystemWriteOpts,
    maybeOpts?: FilesystemWriteOpts,
  ): Promise<WriteInfo | WriteInfo[]> {
    if (Array.isArray(pathOrFiles))
      return this.writeFiles(pathOrFiles, (dataOrOpts ?? {}) as FilesystemWriteOpts);
    return this.#writeOne(
      pathOrFiles,
      dataOrOpts as string | ArrayBuffer | Blob | ReadableStream,
      maybeOpts ?? {},
    );
  }

  async writeFiles(files: WriteEntry[], opts: FilesystemWriteOpts = {}): Promise<WriteInfo[]> {
    const written: WriteInfo[] = [];
    for (const file of files) written.push(await this.#writeOne(file.path, file.data, opts));
    return written;
  }

  async #writeOne(
    path: string,
    data: string | ArrayBuffer | Blob | ReadableStream,
    opts: FilesystemWriteOpts,
  ): Promise<WriteInfo> {
    const file = await this.#path(path, opts);
    const bytes = await bytesOf(data);
    await guard("file", () => this.#files.write(file, bytes, request(opts)));
    return { name: basename(file), type: FileType.FILE, path: file };
  }

  /** A directory's entries, hidden ones included; `depth` goes deeper. */
  async list(path: string, opts: FilesystemListOpts = {}): Promise<EntryInfo[]> {
    const dir = await this.#path(path, opts);
    const entries = await guard("file", () =>
      this.#files.list(dir, { depth: opts.depth ?? 1, hidden: true }),
    );
    return entries.map(entryInfo);
  }

  /** Makes a directory and its parents. False when it already existed. */
  async makeDir(path: string, opts: FilesystemRequestOpts = {}): Promise<boolean> {
    const dir = await this.#path(path, opts);
    if (await guard("file", () => this.#files.exists(dir))) return false;
    await guard("file", () => this.#files.mkdir(dir, { parents: true }));
    return true;
  }

  /** Moves a file or directory, replacing a file at the new path, as E2B does. */
  async rename(oldPath: string, newPath: string, opts: FilesystemRequestOpts = {}) {
    const from = await this.#path(oldPath, opts);
    const to = await this.#path(newPath, opts);
    await guard("file", () => this.#files.rename(from, to, { overwrite: true }));
    return this.getInfo(to, opts);
  }

  /** Removes a file, or a directory with everything in it. */
  async remove(path: string, opts: FilesystemRequestOpts = {}): Promise<void> {
    const target = await this.#path(path, opts);
    await guard("file", () => this.#files.remove(target, { recursive: true }));
  }

  async exists(path: string, opts: FilesystemRequestOpts = {}): Promise<boolean> {
    const target = await this.#path(path, opts);
    return guard("file", () => this.#files.exists(target));
  }

  async getInfo(path: string, opts: FilesystemRequestOpts = {}): Promise<EntryInfo> {
    const target = await this.#path(path, opts);
    const stat = await guard("file", () => this.#files.stat(target));
    if (!stat.exists) throw new FileNotFoundError(`${target} does not exist.`);
    return entryInfo(stat);
  }

  /** E2B's watchDir on Runtime's file watch: the same events (CREATE, WRITE,
   * REMOVE, RENAME, CHMOD) with names relative to the directory, stopped
   * with `handle.stop()`. `timeoutMs` 0 is Runtime's 24-hour maximum. */
  async watchDir(
    path: string,
    onEvent: (event: FilesystemEvent) => void | Promise<void>,
    opts: WatchOpts & { onExit?: (err?: Error) => void | Promise<void> } = {},
  ): Promise<E2BWatchHandle> {
    const target = await this.#path(path, opts);
    const prefix = target.endsWith("/") ? target : `${target}/`;
    const lifetime = opts.timeoutMs === 0 ? 86_400_000 : (opts.timeoutMs ?? 60_000);
    const watch = await guard("file", () =>
      this.#files.watch(
        target,
        (event) =>
          onEvent({
            name: event.path.startsWith(prefix) ? event.path.slice(prefix.length) : event.path,
            type: event.type as FilesystemEventType,
          }),
        {
          recursive: opts.recursive === true,
          timeoutMs: Math.max(1_000, Math.min(86_400_000, lifetime)),
          onExit: (reason) => {
            if (reason === "stopped") return;
            void opts.onExit?.(
              reason === "timeout" || reason === "paused"
                ? undefined
                : new Error(`The watch ended: ${reason}`),
            );
          },
        },
      ),
    );
    return { stop: () => watch.stop() };
  }
}
