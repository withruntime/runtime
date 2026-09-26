import { mkdir, readdir, readFile, lstat, writeFile, symlink, chmod } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

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

/** Unpacks into `target`, refusing any entry that would land outside it. */
export async function unpackArchive(archive: Uint8Array, target: string): Promise<void> {
  const data = gunzipSync(archive);
  const root = resolve(target);
  await mkdir(root, { recursive: true });
  const text = (start: number, length: number) => {
    const slice = data.subarray(start, start + length);
    const end = slice.indexOf(0);
    return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
  };
  let longName: string | undefined;
  for (let offset = 0; offset + 512 <= data.length;) {
    if (data.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(data[offset + 156] ?? 48);
    const prefix = text(offset + 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100));
    longName = undefined;
    const mode = parseInt(text(offset + 100, 8).trim() || "644", 8);
    const link = text(offset + 157, 100);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = new TextDecoder().decode(body).replace(/\0.*$/s, "");
      continue;
    }
    name = name.replace(/^\.\//, "");
    if (!name || name === "." || name === "./") continue;
    const destination = resolve(root, name);
    if (destination !== root && !destination.startsWith(root + sep))
      throw new Error(`Refusing an archive entry outside the target: ${name}`);
    if (type === "5") await mkdir(destination, { recursive: true });
    else if (type === "2") {
      await mkdir(resolve(destination, ".."), { recursive: true });
      await symlink(link, destination).catch(() => undefined);
    } else if (type === "0" || type === "\0" || type === "7") {
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, body);
      await chmod(destination, mode & 0o777);
    }
  }
}
