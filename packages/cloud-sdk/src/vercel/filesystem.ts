import { RuntimeError } from "../errors.js";
import type { Files } from "../sandbox.js";
import type { FileEntry } from "../types.js";
import { fsError, translate } from "./errors.js";

/** What `sandbox.fs` needs from its sandbox. */
export interface FsContext {
  readonly name: string;
  files(): Promise<Files>;
  /** Runs argv without a shell; resolves with the exit code and output. */
  run(
    argv: string[],
    options?: { stdin?: Uint8Array; signal?: AbortSignal },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  resolve(path: string, cwd?: string): string;
}

type WriteFileData = string | Uint8Array;
type Encoding = "utf8" | "utf-8" | "ascii" | "latin1" | "base64" | "hex" | "binary";
type ReadOptions = { encoding?: Encoding | null; signal?: AbortSignal } | Encoding | null;

/** Node's Stats, as far as a sandbox file can answer. uid, gid, ino and the
 * other inode fields are 0. */
export class Stats {
  readonly size: number;
  readonly mode: number;
  readonly mtime: Date;
  readonly mtimeMs: number;
  readonly atime: Date;
  readonly atimeMs: number;
  readonly ctime: Date;
  readonly ctimeMs: number;
  readonly birthtime: Date;
  readonly birthtimeMs: number;
  readonly uid: number;
  readonly gid: number;
  readonly dev = 0;
  readonly ino = 0;
  readonly nlink = 1;
  readonly rdev = 0;
  readonly blksize = 4096;
  readonly blocks: number;
  readonly #type: FileEntry["type"];
  constructor(entry: FileEntry) {
    this.#type = entry.type;
    this.uid = entry.uid ?? 0;
    this.gid = entry.gid ?? 0;
    this.size = entry.size;
    const typeBits =
      entry.type === "directory" ? 0o040000 : entry.type === "symlink" ? 0o120000 : 0o100000;
    this.mode = typeBits | ((parseInt(entry.mode, 8) || 0) & 0o7777);
    this.mtime = this.atime = this.ctime = this.birthtime = new Date(entry.modifiedAt);
    this.mtimeMs = this.atimeMs = this.ctimeMs = this.birthtimeMs = this.mtime.getTime();
    this.blocks = Math.ceil(entry.size / 512);
  }
  isFile() {
    return this.#type === "file";
  }
  isDirectory() {
    return this.#type === "directory";
  }
  isSymbolicLink() {
    return this.#type === "symlink";
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

/** Node's Dirent, from a sandbox listing. */
export class Dirent {
  readonly name: string;
  readonly parentPath: string;
  readonly path: string;
  readonly #type: FileEntry["type"];
  constructor(entry: FileEntry, parent: string) {
    this.name = entry.name;
    this.parentPath = parent;
    this.path = entry.path;
    this.#type = entry.type;
  }
  isFile() {
    return this.#type === "file";
  }
  isDirectory() {
    return this.#type === "directory";
  }
  isSymbolicLink() {
    return this.#type === "symlink";
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

const encodingOf = (options: ReadOptions | { encoding?: Encoding } | undefined) =>
  typeof options === "string" ? options : (options?.encoding ?? null);

const bytesOf = (data: WriteFileData, encoding: Encoding | null) =>
  typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : Buffer.from(data);

function missing(error: unknown) {
  return error instanceof RuntimeError && (error.code === "file_not_found" || error.status === 404);
}

/** `sandbox.fs`: node:fs/promises over Runtime's files API and a few
 * commands. Relative paths resolve against the sandbox's working directory,
 * `/vercel/sandbox`, which is `/workspace` on Runtime. Errors carry Node's
 * codes: `ENOENT` for a missing path. */
export class FileSystem {
  readonly #ctx: FsContext;
  constructor(ctx: FsContext) {
    this.#ctx = ctx;
  }

  async #call<T>(syscall: string, path: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (missing(error)) throw fsError("ENOENT", syscall, path);
      throw translate(error, this.#ctx.name);
    }
  }

  /** Runs a coreutils command; a failure is a Node-style error. */
  async #run(
    syscall: string,
    path: string,
    argv: string[],
    options?: { stdin?: Uint8Array; signal?: AbortSignal },
  ): Promise<string> {
    options?.signal?.throwIfAborted();
    const result = await this.#call(syscall, path, () => this.#ctx.run(argv, options));
    if (result.exitCode === 0) return result.stdout;
    // dash, the sh of Debian and Ubuntu (a Runtime sandbox's), says "cannot
    // create ...: Directory nonexistent" for a missing parent.
    if (/No such file or directory|Directory nonexistent/.test(result.stderr))
      throw fsError("ENOENT", syscall, path);
    if (syscall === "unlink" || syscall === "rm") throw fsError("EACCES", syscall, path);
    if (syscall === "rmdir" && /not empty/i.test(result.stderr))
      throw fsError("ENOTEMPTY", syscall, path);
    if (syscall === "readlink") throw fsError("EINVAL", syscall, path);
    if (/File exists/.test(result.stderr)) throw fsError("EEXIST", syscall, path);
    if (/Is a directory/.test(result.stderr)) throw fsError("EISDIR", syscall, path);
    if (/Not a directory/.test(result.stderr)) throw fsError("ENOTDIR", syscall, path);
    if (/Permission denied/.test(result.stderr)) throw fsError("EACCES", syscall, path);
    throw Object.assign(new Error(`${syscall} '${path}' failed: ${result.stderr.trim()}`), {
      code: "EIO",
      syscall,
      path,
    });
  }

  readFile(
    path: string,
    options?: { encoding?: null; signal?: AbortSignal } | null,
  ): Promise<Buffer>;
  readFile(
    path: string,
    options: { encoding: Encoding; signal?: AbortSignal } | Encoding,
  ): Promise<string>;
  async readFile(path: string, options?: ReadOptions): Promise<Buffer | string> {
    const target = this.#ctx.resolve(path);
    if (options && typeof options === "object") options.signal?.throwIfAborted();
    const files = await this.#ctx.files();
    const bytes = await this.#call("open", target, () =>
      files.read(
        target,
        typeof options === "object" && options?.signal ? { signal: options.signal } : {},
      ),
    );
    const encoding = encodingOf(options);
    const buffer = Buffer.from(bytes);
    return encoding ? buffer.toString(encoding) : buffer;
  }

  async writeFile(
    path: string,
    data: WriteFileData,
    options?: { encoding?: Encoding; signal?: AbortSignal } | Encoding,
  ): Promise<void> {
    const target = this.#ctx.resolve(path);
    if (options && typeof options === "object") options.signal?.throwIfAborted();
    const files = await this.#ctx.files();
    await this.#call("open", target, () =>
      files.write(
        target,
        bytesOf(data, encodingOf(options)),
        typeof options === "object" && options.signal ? { signal: options.signal } : {},
      ),
    );
  }

  async appendFile(
    path: string,
    data: WriteFileData,
    options?: { encoding?: Encoding; signal?: AbortSignal } | Encoding,
  ): Promise<void> {
    const target = this.#ctx.resolve(path);
    // Never read-modify-write: another caller may be appending too. The
    // shell opens with O_APPEND and cat streams bytes without Python. Exec
    // stdin is limited to 1 MiB; larger input uses the chunked files API.
    const bytes = bytesOf(data, encodingOf(options));
    const signal = typeof options === "object" ? options.signal : undefined;
    signal?.throwIfAborted();
    if (bytes.byteLength <= 1_048_576) {
      await this.#run("open", target, ["sh", "-c", 'cat >> "$1"', "runtime-append", target], {
        stdin: bytes,
        ...(signal ? { signal } : {}),
      });
      return;
    }
    if (options && typeof options === "object") options.signal?.throwIfAborted();
    const files = await this.#ctx.files();
    const staging = `/workspace/.runtime/append/${crypto.randomUUID()}`;
    try {
      await this.#call("open", target, () =>
        files.write(staging, bytes, { mode: 0o600, ...(signal ? { signal } : {}) }),
      );
      await this.#run(
        "open",
        target,
        ["sh", "-c", 'cat "$1" >> "$2"', "runtime-append", staging, target],
        signal ? { signal } : undefined,
      );
    } finally {
      // A cleanup failure must not invite retrying a successful append.
      await files.remove(staging).catch(() => undefined);
    }
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean; signal?: AbortSignal } | number,
  ): Promise<void> {
    const target = this.#ctx.resolve(path);
    const recursive = typeof options === "object" && options.recursive === true;
    await this.#run(
      "mkdir",
      target,
      recursive ? ["mkdir", "-p", "--", target] : ["mkdir", "--", target],
      typeof options === "object" ? options : {},
    );
  }

  readdir(
    path: string,
    options?: { signal?: AbortSignal; withFileTypes?: false },
  ): Promise<string[]>;
  readdir(path: string, options: { signal?: AbortSignal; withFileTypes: true }): Promise<Dirent[]>;
  async readdir(
    path: string,
    options: { signal?: AbortSignal; withFileTypes?: boolean } = {},
  ): Promise<string[] | Dirent[]> {
    const target = this.#ctx.resolve(path);
    if (options && typeof options === "object") options.signal?.throwIfAborted();
    const files = await this.#ctx.files();
    const entries = await this.#call("scandir", target, () =>
      files.list(target, {
        depth: 1,
        hidden: options.withFileTypes === true,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    return options.withFileTypes
      ? entries.map((entry) => new Dirent(entry, target))
      : entries.filter((entry) => !entry.name.startsWith(".")).map((entry) => entry.name);
  }

  async lstat(path: string, options: { signal?: AbortSignal } = {}): Promise<Stats> {
    const target = this.#ctx.resolve(path);
    if (options && typeof options === "object") options.signal?.throwIfAborted();
    const files = await this.#ctx.files();
    const found = await this.#call("lstat", target, () => files.stat(target, options));
    if (!found.exists) throw fsError("ENOENT", "lstat", target);
    return new Stats(found);
  }

  /** Follows symbolic links. */
  async stat(path: string, options: { signal?: AbortSignal } = {}): Promise<Stats> {
    const target = this.#ctx.resolve(path);
    const first = await this.lstat(target, options);
    if (!first.isSymbolicLink()) return first;
    return this.lstat(await this.realpath(target, options), options);
  }

  async unlink(path: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const target = this.#ctx.resolve(path);
    await this.#run("unlink", target, ["rm", "--", target], options);
  }

  async rm(
    path: string,
    options: { recursive?: boolean; force?: boolean; signal?: AbortSignal } = {},
  ) {
    const target = this.#ctx.resolve(path);
    const flags = `${options.recursive ? "r" : ""}${options.force ? "f" : ""}`;
    await this.#run(
      "rm",
      target,
      flags ? ["rm", `-${flags}`, "--", target] : ["rm", "--", target],
      options,
    );
  }

  async rmdir(path: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const target = this.#ctx.resolve(path);
    await this.#run("rmdir", target, ["rmdir", "--", target], options);
  }

  async rename(oldPath: string, newPath: string, options: { signal?: AbortSignal } = {}) {
    const from = this.#ctx.resolve(oldPath);
    const to = this.#ctx.resolve(newPath);
    if (options && typeof options === "object") options.signal?.throwIfAborted();
    const files = await this.#ctx.files();
    await this.#call("rename", from, () => files.rename(from, to, { overwrite: true, ...options }));
  }

  async copyFile(src: string, dest: string, options: { signal?: AbortSignal } = {}) {
    const from = this.#ctx.resolve(src);
    const to = this.#ctx.resolve(dest);
    await this.#run("copyfile", from, ["cp", "--", from, to], options);
  }

  async access(path: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const target = this.#ctx.resolve(path);
    if (!(await this.exists(target, options))) throw fsError("ENOENT", "access", target);
  }

  async exists(path: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const target = this.#ctx.resolve(path);
    if (options && typeof options === "object") options.signal?.throwIfAborted();
    // The native stat is lstat: a dangling link exists there. Vercel's public
    // exists/access follow the target, matching test -e in its published SDK.
    const result = await this.#call("access", target, () =>
      this.#ctx.run(["test", "-e", target], options),
    );
    return result.exitCode === 0;
  }

  async chmod(path: string, mode: number | string, options: { signal?: AbortSignal } = {}) {
    const target = this.#ctx.resolve(path);
    const octal = typeof mode === "number" ? mode.toString(8) : mode;
    await this.#run("chmod", target, ["chmod", octal, "--", target], options);
  }

  async chown(path: string, uid: number, gid: number, options: { signal?: AbortSignal } = {}) {
    const target = this.#ctx.resolve(path);
    await this.#run("chown", target, ["sudo", "chown", `${uid}:${gid}`, "--", target], options);
  }

  async symlink(target: string, path: string, options: { signal?: AbortSignal } = {}) {
    const link = this.#ctx.resolve(path);
    await this.#run("symlink", link, ["ln", "-s", "--", target, link], options);
  }

  async readlink(path: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const target = this.#ctx.resolve(path);
    return (await this.#run("readlink", target, ["readlink", "--", target], options)).replace(
      /\n$/,
      "",
    );
  }

  async realpath(path: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const target = this.#ctx.resolve(path);
    return (await this.#run("realpath", target, ["realpath", "-e", "--", target], options)).replace(
      /\n$/,
      "",
    );
  }

  async truncate(path: string, len = 0, options: { signal?: AbortSignal } = {}): Promise<void> {
    const target = this.#ctx.resolve(path);
    await this.#run("open", target, ["truncate", "-s", String(len), "--", target], options);
  }

  async mkdtemp(prefix: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const base = this.#ctx.resolve(prefix);
    return (await this.#run("mkdtemp", base, ["mktemp", "-d", `${base}XXXXXX`], options)).replace(
      /\n$/,
      "",
    );
  }
}
