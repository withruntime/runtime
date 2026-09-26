import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { tarHeader } from "./tar.js";

/* A Dockerfile's build context, made from a folder the way `docker build`
 * makes it: every file the .dockerignore does not exclude, in one gzipped tar
 * archive, with a list of the files and their SHA-256 for the server to
 * resolve COPY against. The archive is deterministic (sorted, no times, no
 * owners), so an unchanged folder gives the same chunks and a rebuild
 * uploads nothing. Node and Bun only: it reads the file system. */

export const CONTEXT_LIMITS = {
  /** The archive, compressed: what is uploaded. */
  bytes: 100 * 1_048_576,
  files: 20_000,
  chunkBytes: 1_048_576,
};

export type ContextFile = { path: string; sha256: string; size: number; mode: number };
export type PackedContext = {
  archive: Uint8Array;
  files: ContextFile[];
  /** The .dockerignore that was applied, sent so the server applies it too. */
  dockerignore?: string;
};

/** A .dockerignore as Docker reads it: `#` comments, `!` re-includes, `**`
 * crosses directories, a pattern naming a directory excludes what is in it,
 * and the last matching pattern decides. The same rules as the server's
 * (packages/cloud/src/images/dockerfile.ts `dockerignoreFilter`). */
export function dockerignoreFilter(text: string | undefined): (path: string) => boolean {
  if (text === undefined || text.trim() === "") return () => false;
  const rules: { negate: boolean; regex: RegExp }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1).trim();
    line = normalize(line.replace(/^\/+/, "")).replace(/\/+$/, "");
    if (!line || line === ".") continue;
    let source = "";
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (char === "*" && line[i + 1] === "*") {
        if (line[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else if (char === "[") {
        const end = line.indexOf("]", i + 1);
        if (end < 0) source += "\\[";
        else {
          source += `[${line
            .slice(i + 1, end)
            .replace(/^!/, "^")
            .replace(/\\/g, "\\\\")}]`;
          i = end;
        }
      } else if (char === "\\" && i + 1 < line.length) {
        source += line[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      } else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    try {
      rules.push({ negate, regex: new RegExp(`^${source}$`) });
    } catch {
      throw new Error(`.dockerignore: invalid pattern ${JSON.stringify(raw.trim())}`);
    }
  }
  return (path) => {
    const parts = path.split("/");
    let excluded = false;
    for (const rule of rules) {
      let hit = false;
      for (let n = parts.length; n >= 1 && !hit; n--)
        hit = rule.regex.test(parts.slice(0, n).join("/"));
      if (hit) excluded = !rule.negate;
    }
    return excluded;
  };
}

/** posix.normalize, without importing a path module into this function. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/") || ".";
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Buffer.from(digest).toString("hex");
}

/** The context of a folder: its .dockerignore (or `<Dockerfile>.dockerignore`)
 * applied, `.git` left out when there is none. Symbolic links are left out:
 * COPY reads files. */
export async function packContext(
  folder: string,
  options: { dockerignore?: string; dockerfile?: string } = {},
): Promise<PackedContext> {
  const root = resolve(folder);
  let dockerignore = options.dockerignore;
  if (dockerignore === undefined)
    for (const candidate of [
      ...(options.dockerfile ? [`${resolve(root, options.dockerfile)}.dockerignore`] : []),
      join(root, ".dockerignore"),
    ]) {
      dockerignore = await readFile(candidate, "utf8").catch(() => undefined);
      if (dockerignore !== undefined) break;
    }
  const ignored = dockerignoreFilter(dockerignore ?? ".git\n");
  const reincludes = /^\s*!/m.test(dockerignore ?? "");
  const files: ContextFile[] = [];
  const parts: Uint8Array[] = [];
  let total = 0;
  async function walk(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const full = join(directory, name);
      const path = relative(root, full).split(sep).join("/");
      const info = await lstat(full);
      if (info.isDirectory()) {
        // A directory excluded outright is not walked, unless a later `!`
        // rule could bring something in it back.
        if (ignored(path) && !reincludes) continue;
        await walk(full);
      } else if (info.isFile()) {
        if (ignored(path)) continue;
        if (files.length >= CONTEXT_LIMITS.files)
          throw new Error(
            `The build context has more than ${CONTEXT_LIMITS.files} files. Leave some out with a .dockerignore.`,
          );
        const data = new Uint8Array(await readFile(full));
        total += data.length;
        const mode = info.mode & 0o777;
        files.push({ path, sha256: await sha256(data), size: data.length, mode });
        parts.push(tarHeader(path, data.length, mode, "0", "", 0), data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) parts.push(new Uint8Array(pad));
      }
    }
  }
  await walk(root);
  parts.push(new Uint8Array(1024));
  const tar = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) || 1024);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  const archive = new Uint8Array(gzipSync(tar, { level: 6 }));
  if (archive.length > CONTEXT_LIMITS.bytes)
    throw new Error(
      `The build context is ${Math.ceil(archive.length / 1_048_576)} MiB compressed (${Math.ceil(total / 1_048_576)} MiB of files); the most is ${CONTEXT_LIMITS.bytes / 1_048_576} MiB. Leave build outputs and dependencies out with a .dockerignore.`,
    );
  return { archive, files, ...(dockerignore === undefined ? {} : { dockerignore }) };
}

/** The archive cut into the 1 MiB chunks the server stores by digest. */
export async function chunkArchive(archive: Uint8Array): Promise<{
  sha256: string;
  size: number;
  chunks: { sha256: string; bytes: Uint8Array }[];
}> {
  const chunks: { sha256: string; bytes: Uint8Array }[] = [];
  for (let at = 0; at < archive.length; at += CONTEXT_LIMITS.chunkBytes) {
    const bytes = archive.subarray(at, Math.min(archive.length, at + CONTEXT_LIMITS.chunkBytes));
    chunks.push({ sha256: await sha256(bytes), bytes });
  }
  return { sha256: await sha256(archive), size: archive.length, chunks };
}
