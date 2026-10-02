import type { FileEntry } from "../types.js";
import type { WatchHandle } from "../products/watch.js";
import { request } from "./client.js";
import type { SandboxContext, Username } from "./commands.js";
import {
  FileNotFoundError,
  guard,
  InvalidArgumentError,
  NotSupportedError,
  TimeoutError,
} from "./errors.js";
import { FilesAs, runAs } from "./users.js";

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
  /** File owner when returned by the native guest. */
  owner: string;
  /** File group when returned by the native guest. */
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
  entry?: EntryInfo;
}
export interface WatchOpts extends FilesystemRequestOpts {
  /** How long the subscription runs; 0 has no subscription deadline. Default 60000. */
  timeoutMs?: number;
  recursive?: boolean;
  includeEntry?: boolean;
  allowNetworkMounts?: boolean;
}
export interface E2BWatchHandle {
  stop(): Promise<void>;
}
export type WriteEntry = { path: string; data: string | ArrayBuffer | Blob | ReadableStream };

export interface FilesystemRequestOpts {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  /** "user" (the default) acts as the sandbox's own user through Runtime's
   * file API; any other existing user, `root` included, through `sudo -u`. */
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
    owner: entry.owner ?? "",
    group: entry.group ?? "",
    ...(entry.symlinkTarget ? { symlinkTarget: entry.symlinkTarget } : {}),
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
    opts.signal?.throwIfAborted();
    refuse(opts);
    await this.#ctx.ensureHome(path);
    opts.signal?.throwIfAborted();
    return absolute(path);
  }
  /** The calls as another Linux user, or undefined for the sandbox's own. */
  async #as(opts: FilesystemRequestOpts): Promise<FilesAs | undefined> {
    if (opts.user === undefined || opts.user === "user") return undefined;
    const options = request(opts);
    const user = await runAs(this.#ctx, opts.user, options);
    return user ? new FilesAs(this.#ctx, user, options) : undefined;
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
    const as = await this.#as(opts);
    // A real stream, any size, never the whole file held first.
    if (opts.format === "stream" && !as)
      return guard("file", () => this.#files.readStream(file, request(opts)));
    const bytes = as
      ? await as.read(file)
      : await guard("file", () => this.#files.read(file, request(opts)));
    if (opts.format === "stream") return new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
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
    opts.signal?.throwIfAborted();
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
    const as = await this.#as(opts);
    const bytes = await bytesOf(data);
    if (as) await as.write(file, bytes);
    else await guard("file", () => this.#files.write(file, bytes, request(opts)));
    return { name: basename(file), type: FileType.FILE, path: file };
  }

  /** A directory's entries, hidden ones included; `depth` goes deeper. */
  async list(path: string, opts: FilesystemListOpts = {}): Promise<EntryInfo[]> {
    const dir = await this.#path(path, opts);
    const as = await this.#as(opts);
    if (as) return (await as.list(dir, opts.depth ?? 1)).map(entryInfo);
    const entries = await guard("file", () =>
      this.#files.list(dir, { depth: opts.depth ?? 1, hidden: true, ...request(opts) }),
    );
    return entries.map(entryInfo);
  }

  /** Makes a directory and its parents. False when it already existed. */
  async makeDir(path: string, opts: FilesystemRequestOpts = {}): Promise<boolean> {
    const dir = await this.#path(path, opts);
    const as = await this.#as(opts);
    if (as) return as.makeDir(dir);
    if (await guard("file", () => this.#files.exists(dir, request(opts)))) return false;
    await guard("file", () => this.#files.mkdir(dir, { parents: true, ...request(opts) }));
    return true;
  }

  /** Moves a file or directory, replacing a file at the new path, as E2B does. */
  async rename(oldPath: string, newPath: string, opts: FilesystemRequestOpts = {}) {
    const from = await this.#path(oldPath, opts);
    const to = await this.#path(newPath, opts);
    const as = await this.#as(opts);
    if (as) await as.rename(from, to);
    else
      await guard("file", () =>
        this.#files.rename(from, to, { overwrite: true, ...request(opts) }),
      );
    return this.getInfo(to, opts);
  }

  /** Removes a file, or a directory with everything in it. */
  async remove(path: string, opts: FilesystemRequestOpts = {}): Promise<void> {
    const target = await this.#path(path, opts);
    const as = await this.#as(opts);
    if (as) return as.remove(target);
    await guard("file", () => this.#files.remove(target, { recursive: true, ...request(opts) }));
  }

  async exists(path: string, opts: FilesystemRequestOpts = {}): Promise<boolean> {
    const target = await this.#path(path, opts);
    const as = await this.#as(opts);
    if (as) return as.exists(target);
    return guard("file", () => this.#files.exists(target, request(opts)));
  }

  async getInfo(path: string, opts: FilesystemRequestOpts = {}): Promise<EntryInfo> {
    const target = await this.#path(path, opts);
    const as = await this.#as(opts);
    if (as) return entryInfo(await as.stat(target));
    const stat = await guard("file", () => this.#files.stat(target, request(opts)));
    if (!stat.exists) throw new FileNotFoundError(`${target} does not exist.`);
    return entryInfo(stat);
  }

  /** E2B's watchDir on Runtime's file watch. A local deadline preserves
   * subsecond subscriptions; 0 runs until stopped or the sandbox ends. */
  async watchDir(
    path: string,
    onEvent: (event: FilesystemEvent) => void | Promise<void>,
    opts: WatchOpts & { onExit?: (err?: Error) => void | Promise<void> } = {},
  ): Promise<E2BWatchHandle> {
    opts.signal?.throwIfAborted();
    if (opts.user !== undefined && opts.user !== "user")
      throw new NotSupportedError(
        `Watching a directory as the user "${opts.user}"`,
        "Watch it as the sandbox's own user (leave user out); Runtime's watch reports changes made by anyone.",
      );
    if (opts.allowNetworkMounts)
      throw new NotSupportedError(
        "Watching network mounts",
        "Watch a local sandbox directory instead.",
      );
    const lifetime = opts.timeoutMs ?? 60000;
    if (!Number.isFinite(lifetime) || lifetime < 0)
      throw new InvalidArgumentError("timeoutMs must be a nonnegative finite number.");
    const target = await this.#path(path, opts);
    const prefix = target.endsWith("/") ? target : `${target}/`;
    let exited = false;
    let native: WatchHandle | undefined;
    let stopping: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lifetimeAbort = new AbortController();
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, lifetimeAbort.signal])
      : lifetimeAbort.signal;
    const exit = async (error?: Error) => {
      if (exited) return;
      exited = true;
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        await opts.onExit?.(error);
      } catch {
        /* Upstream treats a throwing terminal callback as handled. */
      }
    };
    const stopRemote = () => {
      if (!native) return Promise.resolve();
      return (stopping ??= native.stop());
    };
    const close = async (error?: Error) => {
      const callback = exit(error);
      try {
        await stopRemote();
      } finally {
        await callback;
      }
    };
    const onAbort = () => {
      const error =
        opts.signal?.reason instanceof Error
          ? opts.signal.reason
          : new Error("The watch was aborted.");
      void close(error).catch(() => undefined);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    if (lifetime > 0) {
      const deadline = Date.now() + lifetime;
      const schedule = () => {
        timer = setTimeout(
          () => {
            if (exited) return;
            if (Date.now() < deadline) {
              schedule();
              return;
            }
            const error = new TimeoutError("Filesystem watch timed out.");
            // Mark the terminal result before native cancellation can report a
            // clean end. The same signal also cancels creation still in flight.
            void close(error).catch(() => undefined);
            lifetimeAbort.abort(error);
          },
          Math.min(2147483647, Math.max(0, deadline - Date.now())),
        );
        timer.unref?.();
      };
      schedule();
    }
    try {
      const watch = await guard("file", () =>
        this.#files.watch(
          target,
          async (event) => {
            if (exited) return;
            let entry: EntryInfo | undefined;
            if (opts.includeEntry) {
              try {
                entry = await this.getInfo(event.path, { ...opts, signal });
              } catch (error) {
                if (!(error instanceof FileNotFoundError)) throw error;
              }
            }
            if (!exited)
              await onEvent({
                name: event.path.startsWith(prefix) ? event.path.slice(prefix.length) : event.path,
                type: event.type as FilesystemEventType,
                ...(entry ? { entry } : {}),
              });
          },
          {
            recursive: opts.recursive === true,
            timeoutMs: 0,
            signal,
            onExit: (reason) => {
              void exit(
                reason === "timeout" ? new TimeoutError("Filesystem watch timed out.") : undefined,
              );
            },
            onNotice: (notice) => {
              void close(
                new Error(
                  `Filesystem events were lost (${notice.k}); rescan the directory and start a new watch.`,
                ),
              ).catch(() => undefined);
            },
          },
        ),
      );
      native = watch;
      if (exited) await stopRemote();
      void watch.done?.then(
        () => exit(),
        (error: unknown) =>
          close(error instanceof Error ? error : new Error(String(error))).catch(() => undefined),
      );
      return { stop: () => close() };
    } catch (error) {
      await close(error instanceof Error ? error : new Error(String(error))).catch(() => undefined);
      throw error;
    }
  }
}
