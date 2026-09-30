import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
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

/* A small ustar writer and reader for directory uploads and downloads, so the
   SDK needs no dependency. Regular files, directories and symbolic links;
   names up to 255 bytes through the ustar prefix field. */

export function tarHeader(
  name: string,
  size: number,
  mode: number,
  type: "0" | "5" | "2",
  link = "",
  mtime = 0,
): Uint8Array {
  const block = new Uint8Array(512);
  const bytes = new TextEncoder().encode(name);
  let prefix = new Uint8Array();
  let short = bytes;
  if (bytes.length > 100) {
    const split = name.lastIndexOf("/", 155);
    if (split <= 0 || new TextEncoder().encode(name.slice(split + 1)).length > 100)
      throw new Error(`Path too long for a tar archive: ${name}`);
    prefix = new TextEncoder().encode(name.slice(0, split));
    short = new TextEncoder().encode(name.slice(split + 1));
  }
  const put = (offset: number, value: string | Uint8Array, length: number) => {
    const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
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

/** The gzip stream's bytes, decompressed as they arrive. */
function gunzipped(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Readable {
  const input = Readable.from(source, { objectMode: false });
  const output = createGunzip();
  input.on("error", (error) => output.destroy(error));
  input.pipe(output);
  output.on("close", () => input.destroy());
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
async function unpackEntries(bytes: Bytes, root: string): Promise<Link[]> {
  const links: Link[] = [];
  const decode = (slice: Uint8Array) => {
    const end = slice.indexOf(0);
    return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
  };
  let longName: string | undefined;
  let longLink: string | undefined;
  for (;;) {
    const header = await bytes.exactly(512);
    if (!header) throw cutShort();
    if (header.every((byte) => byte === 0)) {
      await bytes.drain();
      return links;
    }
    const text = (start: number, length: number) => decode(header.subarray(start, start + length));
    const size = parseInt(text(124, 12).trim() || "0", 8);
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
    } else if (type === "0" || type === "\0" || type === "7") {
      await mkdir(dirname(destination), { recursive: true });
      const file = await open(destination, "w");
      try {
        for await (const part of bytes.take(size)) await file.write(part);
      } finally {
        await file.close();
      }
      await chmod(destination, mode & 0o777);
      for await (const _ of bytes.take(padding));
    } else await skip();
  }
}

/** Moves what was unpacked in `from` into `to`, merging with what is there
 * and replacing files of the same name, never through a link in `to`. */
async function merge(from: string, to: string, root: string): Promise<void> {
  for (const name of await readdir(from)) {
    const source = join(from, name);
    const destination = join(to, name);
    await assertPlain(root, destination, relative(root, destination));
    const [kind, there] = await Promise.all([
      lstat(source),
      lstat(destination).catch(() => undefined),
    ]);
    if (kind.isDirectory() && there?.isDirectory()) await merge(source, destination, root);
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
): Promise<void> {
  const final = resolve(target);
  await mkdir(dirname(final), { recursive: true });
  const staging = await mkdtemp(`${final}.runtime-partial-`);
  const stream = gunzipped(source);
  try {
    const root = await realpath(staging);
    const links = await unpackEntries(new Bytes(stream), root);
    for (const { destination, link, name } of links) {
      await assertPlain(root, destination, name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(link, destination).catch(() => undefined);
    }
    for (const { destination, link, name } of links) {
      if (await linkStaysInside(root, dirname(destination), link)) continue;
      await unlink(destination).catch(() => undefined);
      throw new Error(`Refusing an archive link that leads outside the target: ${name} -> ${link}`);
    }
    const there = await lstat(final).catch(() => undefined);
    if (!there) await rename(staging, final);
    else await merge(root, await realpath(final), await realpath(final));
  } finally {
    stream.destroy();
    await rm(staging, { recursive: true, force: true });
  }
}

/** Unpacks a whole gzipped tar held in memory, by the same rules. */
export function unpackArchive(archive: Uint8Array, target: string): Promise<void> {
  return unpackStream([archive], target);
}
