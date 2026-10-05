import {
  chmod,
  copyFile,
  link as hardLink,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import { RuntimeError } from "./errors.js";

/* A small tar writer and reader for directory uploads and downloads, so the
   SDK needs no dependency. Regular files, directories, symbolic links and,
   reading, hard links. A name that does not fit the ustar name and prefix
   fields, or a link target longer than 100 bytes, travels in a GNU long-name
   or long-link entry, which GNU tar, BusyBox tar and every SDK's reader
   take; nothing is cut short. */

const encode = (value: string) => new TextEncoder().encode(value);

/** The ustar prefix and name of `name`, split at a slash so that each fits
 * its field in bytes, or null when no split fits. */
function ustarName(name: string): { prefix: Uint8Array; short: Uint8Array } | null {
  const bytes = encode(name);
  if (bytes.length <= 100) return { prefix: new Uint8Array(), short: bytes };
  for (let split = name.lastIndexOf("/"); split > 0; split = name.lastIndexOf("/", split - 1)) {
    const prefix = encode(name.slice(0, split));
    const short = encode(name.slice(split + 1));
    if (short.length > 100) return null;
    if (prefix.length <= 155) return { prefix, short };
  }
  return null;
}

function headerBlock(
  short: Uint8Array,
  prefix: Uint8Array,
  size: number,
  mode: number,
  type: string,
  link: Uint8Array,
  mtime: number,
): Uint8Array {
  const block = new Uint8Array(512);
  const put = (offset: number, value: string | Uint8Array, length: number) => {
    const data = typeof value === "string" ? encode(value) : value;
    block.set(data.subarray(0, length), offset);
  };
  const octal = (value: number, length: number) =>
    value.toString(8).padStart(length - 1, "0") + "\0";
  put(0, short, 100);
  put(100, octal(mode & 0o7777, 8), 8);
  put(108, octal(0, 8), 8);
  put(116, octal(0, 8), 8);
  put(124, octal(size, 12), 12);
  put(136, octal(mtime, 12), 12);
  put(148, "        ", 8);
  put(156, type, 1);
  put(157, link, 100);
  put(257, "ustar\u000000", 8);
  put(345, prefix, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
  return block;
}

/** A GNU long-name ("L") or long-link ("K") entry carrying `value`. */
function longEntry(type: "L" | "K", value: Uint8Array): Uint8Array {
  const size = value.length + 1;
  const out = new Uint8Array(512 + Math.ceil(size / 512) * 512);
  out.set(
    headerBlock(encode("././@LongLink"), new Uint8Array(), size, 0o644, type, new Uint8Array(), 0),
  );
  out.set(value, 512);
  return out;
}

/** One entry's header: the ustar block, after the long-name and long-link
 * entries it needs. A whole number of 512-byte blocks. */
export function tarHeader(
  name: string,
  size: number,
  mode: number,
  type: "0" | "5" | "2",
  link = "",
  mtime = 0,
): Uint8Array {
  const parts: Uint8Array[] = [];
  let fitted = ustarName(name);
  if (!fitted) {
    parts.push(longEntry("L", encode(name)));
    fitted = { prefix: new Uint8Array(), short: encode(name).subarray(0, 100) };
  }
  const target = encode(link);
  if (target.length > 100) parts.push(longEntry("K", target));
  parts.push(headerBlock(fitted.short, fitted.prefix, size, mode, type, target, mtime));
  return parts.length === 1 ? parts[0]! : new Uint8Array(Buffer.concat(parts));
}

export async function packDirectory(root: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const base = resolve(root);
  async function walk(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const full = join(directory, name);
      const path = relative(base, full).split(sep).join("/");
      const info = await lstat(full);
      const mtime = Math.floor(info.mtimeMs / 1000);
      if (info.isDirectory()) {
        parts.push(tarHeader(`${path}/`, 0, info.mode, "5", "", mtime));
        await walk(full);
      } else if (info.isSymbolicLink()) {
        const { readlink } = await import("node:fs/promises");
        parts.push(tarHeader(path, 0, info.mode, "2", await readlink(full), mtime));
      } else if (info.isFile()) {
        const data = await readFile(full);
        parts.push(tarHeader(path, data.length, info.mode, "0", "", mtime), data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) parts.push(new Uint8Array(pad));
      }
    }
  }
  await walk(base);
  parts.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(parts));
}

/* The archive comes from a sandbox, whose contents the customer's untrusted code
   controls, so nothing in it may write outside `target`. A lexical check on each
   name is not enough: a link `x -> ../outside` followed by `x/file` passes it and
   writes through the link. So no write ever passes through a link, links are made
   only after every file and directory is in place, and each link is then walked
   through the finished tree and removed, failing the unpack, if it leads out. */

async function linkAt(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Throws unless `destination` is inside `root` and no part of the way to it,
    itself included, is a link. */
async function assertPlain(root: string, destination: string, name: string): Promise<void> {
  if (destination !== root && !destination.startsWith(root + sep))
    throw new Error(`Refusing an archive entry outside the target: ${name}`);
  let path = root;
  for (const part of relative(root, destination).split(sep).filter(Boolean)) {
    path = join(path, part);
    if (await linkAt(path))
      throw new Error(`Refusing an archive entry that passes through a link: ${name}`);
  }
}

/** Where following `link` from `directory` leads, or undefined when the way
    leaves `root` or turns at a link before its last step. The last step may
    be a link; that link is checked on its own. */
async function linkStaysInside(root: string, directory: string, link: string) {
  if (isAbsolute(link)) return false;
  const parts = link.split("/").filter((part) => part && part !== ".");
  let path = directory;
  for (const [index, part] of parts.entries()) {
    path = part === ".." ? dirname(path) : join(path, part);
    if (path !== root && !path.startsWith(root + sep)) return false;
    if (index < parts.length - 1 && part !== ".." && (await linkAt(path))) return false;
  }
  return true;
}

/** A folder that did not arrive whole: tar in the sandbox stopped part way
 * (a file it may not read, one that changed as it was read), which ends the
 * gzip stream short, or the connection was lost (ARCHITECTURE.md section 10,
 * "Folders over HTTP"). */
function cutShort(cause?: unknown): RuntimeError {
  return new RuntimeError({
    message:
      "The folder's archive arrived cut short: tar in the sandbox stopped part way, or the connection was lost. Nothing was written.",
    hint: "Try again. If it fails the same way, a file in the folder cannot be read by the sandbox user or changes as it is read.",
    code: "download_incomplete",
    status: 0,
    ...(cause === undefined ? {} : { cause }),
  });
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new RuntimeError({
      message: "The download was cancelled or ran past its deadline.",
      code: "timeout",
      status: 0,
      cause: signal.reason,
    });
}

/** Linux path names fit well below this generous metadata-only memory bound. */
const MAX_LONG_NAME_BYTES = 65_536;

function archiveSize(field: string): number {
  const text = field.trim();
  if (text !== "" && !/^[0-7]+$/.test(text))
    throw new Error("The archive contains an invalid file size.");
  const size = text === "" ? 0 : parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0 || size > Number.MAX_SAFE_INTEGER - 511)
    throw new Error("The archive contains an invalid file size.");
  return size;
}

/** The gzip check protects the compressed bytes; tar's own checksum also
 * protects the header that determines each file's name, kind and length. */
function checkHeader(header: Uint8Array, field: string): void {
  const text = field.trim();
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < header.length; index++) {
    const byte = index >= 148 && index < 156 ? 32 : header[index]!;
    unsigned += byte;
    signed += byte < 128 ? byte : byte - 256;
  }
  const expected = /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN;
  // Older tar implementations used signed bytes for non-ASCII path names.
  if (expected !== unsigned && expected !== signed)
    throw new Error("The archive contains an invalid header checksum.");
}

/** Validate links against the tree a merge will produce. Staged entries
 * take precedence; paths absent there retain the existing target's entry.
 * A link safe in staging may otherwise lead through an old escaping link. */
async function mergedLinkStaysInside(
  staging: string,
  root: string,
  destination: string,
  link: string,
): Promise<boolean> {
  let path = dirname(join(root, relative(staging, destination)));
  const pending = link.split("/");
  const followed = new Set<string>();
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    path = part === ".." ? dirname(path) : join(path, part);
    if (path !== root && !path.startsWith(root + sep)) return false;
    const staged = join(staging, relative(root, path));
    const stagedKind = await lstat(staged).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    const actual = stagedKind ? staged : path;
    const kind =
      stagedKind ??
      (await lstat(actual).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      }));
    if (!kind?.isSymbolicLink()) continue;
    if (followed.has(path)) return false;
    followed.add(path);
    const next = await readlink(actual);
    if (isAbsolute(next)) {
      // An existing absolute link is safe only when it stays in this root.
      if (next !== root && !next.startsWith(root + sep)) return false;
      path = root;
      pending.unshift(...relative(root, next).split(sep));
    } else {
      path = dirname(path);
      pending.unshift(...next.split("/"));
    }
  }
  return true;
}

/** The gzip stream's bytes, decompressed as they arrive. */
function gunzipped(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  signal?: AbortSignal,
): Readable {
  const input = Readable.from(source, { objectMode: false });
  const output = createGunzip();
  // A filesystem await may precede async iteration; retain early stream
  // errors for that iterator without an unhandled EventEmitter error.
  output.on("error", () => undefined);
  input.on("error", (error) => output.destroy(error));
  input.pipe(output);
  const abort = () => {
    try {
      checkSignal(signal);
    } catch (error) {
      output.destroy(error as Error);
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  output.on("close", () => {
    signal?.removeEventListener("abort", abort);
    input.destroy();
  });
  return output;
}

/** Exact byte counts from a stream of chunks, holding at most one chunk. */
class Bytes {
  #chunks: AsyncIterator<Uint8Array>;
  #held: Uint8Array = new Uint8Array(0);
  constructor(source: AsyncIterable<Uint8Array>) {
    this.#chunks = source[Symbol.asyncIterator]();
  }
  async #more(): Promise<boolean> {
    let next: IteratorResult<Uint8Array>;
    try {
      next = await this.#chunks.next();
    } catch (error) {
      throw error instanceof RuntimeError ? error : cutShort(error);
    }
    if (next.done) return false;
    this.#held = this.#held.length ? Buffer.concat([this.#held, next.value]) : next.value;
    return true;
  }
  /** `n` bytes, or undefined at a clean end before any of them. */
  async exactly(n: number): Promise<Uint8Array | undefined> {
    while (this.#held.length < n) {
      if (await this.#more()) continue;
      if (this.#held.length === 0) return undefined;
      throw cutShort();
    }
    const out = this.#held.subarray(0, n);
    this.#held = this.#held.subarray(n);
    return out;
  }
  /** The next `n` bytes as they arrive. */
  async *take(n: number): AsyncGenerator<Uint8Array> {
    while (n > 0) {
      if (this.#held.length === 0 && !(await this.#more())) throw cutShort();
      const out = this.#held.subarray(0, n);
      this.#held = this.#held.subarray(out.length);
      n -= out.length;
      yield out;
    }
  }
  /** Reads to the end, so the gzip stream's own check has run. */
  async drain(): Promise<void> {
    this.#held = new Uint8Array(0);
    while (await this.#more()) this.#held = new Uint8Array(0);
  }
}

type Link = { destination: string; link: string; name: string };

/** Unpacks a tar stream into `root`, a fresh folder: files and folders as they
 * arrive, links noted to make at the end. Throws unless the archive's end
 * arrived. */
async function unpackEntries(bytes: Bytes, root: string, signal?: AbortSignal): Promise<Link[]> {
  const links: Link[] = [];
  const decode = (slice: Uint8Array) => {
    const end = slice.indexOf(0);
    return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
  };
  let longName: string | undefined;
  let longLink: string | undefined;
  for (;;) {
    checkSignal(signal);
    const header = await bytes.exactly(512);
    if (!header) throw cutShort();
    if (header.every((byte) => byte === 0)) {
      const terminator = await bytes.exactly(512);
      if (!terminator || !terminator.every((byte) => byte === 0)) throw cutShort();
      await bytes.drain();
      return links;
    }
    const text = (start: number, length: number) => decode(header.subarray(start, start + length));
    const size = archiveSize(text(124, 12));
    checkHeader(header, text(148, 8));
    const type = String.fromCharCode(header[156] ?? 48);
    const prefix = text(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    const link = longLink ?? text(157, 100);
    longName = undefined;
    longLink = undefined;
    const mode = parseInt(text(100, 8).trim() || "644", 8);
    const padding = Math.ceil(size / 512) * 512 - size;
    const skip = async () => {
      for await (const _ of bytes.take(size + padding));
    };
    if (type === "L" || type === "K") {
      if (size > MAX_LONG_NAME_BYTES)
        throw new Error("The archive contains oversized path metadata.");
      const parts: Uint8Array[] = [];
      for await (const part of bytes.take(size)) parts.push(Uint8Array.from(part));
      for await (const _ of bytes.take(padding));
      const value = new TextDecoder().decode(Buffer.concat(parts)).replace(/\0.*$/s, "");
      if (type === "L") longName = value;
      else longLink = value;
      continue;
    }
    name = name.replace(/^\.\//, "");
    if (!name || name === "." || name === "./") {
      await skip();
      continue;
    }
    const destination = resolve(root, name);
    await assertPlain(root, destination, name);
    if (type === "5") {
      await mkdir(destination, { recursive: true });
      await skip();
    } else if (type === "2") {
      links.push({ destination, link, name });
      await skip();
    } else if (type === "1") {
      await hardLinkEntry(root, destination, link, name);
      await skip();
    } else if (type === "0" || type === "\0" || type === "7") {
      await mkdir(dirname(destination), { recursive: true });
      // A name already unpacked may share its file with a hard link; writing
      // through it would change the link's copy too.
      await unlink(destination).catch(() => undefined);
      const file = await open(destination, "w");
      try {
        for await (const part of bytes.take(size)) {
          let written = 0;
          while (written < part.length) {
            checkSignal(signal);
            const result = await file.write(part.subarray(written));
            if (result.bytesWritten === 0) throw new Error("The local file accepted no bytes.");
            written += result.bytesWritten;
          }
        }
      } finally {
        await file.close();
      }
      await chmod(destination, mode & 0o777);
      for await (const _ of bytes.take(padding));
    } else await skip();
  }
}

/** A second name for a file the archive already carried: tar writes the
 * first name as a file and every other as a hard link to it. The link names
 * a plain file unpacked earlier in this archive, or the unpack fails; it
 * never reaches outside, through a link or ahead. */
async function hardLinkEntry(root: string, destination: string, link: string, name: string) {
  const named = link.replace(/^(\.\/)+/, "");
  const source = resolve(root, named);
  if (!named || isAbsolute(named) || source === root || !source.startsWith(root + sep))
    throw new Error(
      `Refusing an archive hard link that leads outside the target: ${name} -> ${link}`,
    );
  await assertPlain(root, source, named);
  if (!(await lstat(source).catch(() => undefined))?.isFile())
    throw new Error(
      `Refusing an archive hard link to a file it does not carry: ${name} -> ${link}`,
    );
  if (source === destination) return;
  await mkdir(dirname(destination), { recursive: true });
  await unlink(destination).catch(() => undefined);
  await hardLink(source, destination).catch(() => copyFile(source, destination));
}

/** Moves what was unpacked in `from` into `to`, merging with what is there
 * and replacing files of the same name, never through a link in `to`. */
async function merge(from: string, to: string, root: string, signal?: AbortSignal): Promise<void> {
  for (const name of await readdir(from)) {
    checkSignal(signal);
    const source = join(from, name);
    const destination = join(to, name);
    await assertPlain(root, destination, relative(root, destination));
    const [kind, there] = await Promise.all([
      lstat(source),
      lstat(destination).catch(() => undefined),
    ]);
    checkSignal(signal);
    if (kind.isDirectory() && there?.isDirectory()) await merge(source, destination, root, signal);
    else await rename(source, destination);
  }
}

/** Unpacks a gzipped tar that arrives as a stream into `target`, refusing any
 * entry that would land outside it, holding no more than a chunk at a time.
 * It unpacks into a folder beside the target and moves it into place only
 * once the whole archive arrived, so an archive cut short leaves nothing
 * behind that could pass for the folder. A target that exists is merged
 * into, files of the same name replaced. */
export async function unpackStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  target: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  checkSignal(options.signal);
  const final = resolve(target);
  await mkdir(dirname(final), { recursive: true });
  const staging = await mkdtemp(`${final}.runtime-partial-`);
  const stream = gunzipped(source, options.signal);
  try {
    const root = await realpath(staging);
    const links = await unpackEntries(new Bytes(stream), root, options.signal);
    for (const { destination, link, name } of links) {
      checkSignal(options.signal);
      await assertPlain(root, destination, name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(link, destination).catch(() => undefined);
    }
    for (const { destination, link, name } of links) {
      checkSignal(options.signal);
      if (await linkStaysInside(root, dirname(destination), link)) continue;
      await unlink(destination).catch(() => undefined);
      throw new Error(`Refusing an archive link that leads outside the target: ${name} -> ${link}`);
    }
    const there = await lstat(final).catch(() => undefined);
    checkSignal(options.signal);
    if (!there) await rename(staging, final);
    else {
      const targetRoot = await realpath(final);
      for (const { destination, link, name } of links) {
        checkSignal(options.signal);
        if (!(await mergedLinkStaysInside(root, targetRoot, destination, link)))
          throw new Error(
            `Refusing an archive link that leads outside the target: ${name} -> ${link}`,
          );
      }
      await merge(root, targetRoot, targetRoot, options.signal);
    }
  } finally {
    stream.destroy();
    await rm(staging, { recursive: true, force: true });
  }
}

/** Unpacks a whole gzipped tar held in memory, by the same rules. */
export function unpackArchive(archive: Uint8Array, target: string): Promise<void> {
  return unpackStream([archive], target);
}
