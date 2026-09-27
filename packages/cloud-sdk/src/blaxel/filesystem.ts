import type { FileEvent } from "../products/watch.js";
import type { RuntimeSandbox } from "./client.js";
import { HOME, RUNTIME_HOME, toBlaxelPath, toRuntimePath } from "./context.js";
import {
  codeOf,
  guard,
  NotSupportedError,
  ResponseError,
  responseError,
  translate,
} from "./errors.js";

/* `sandbox.fs` over Runtime's files API and one command each for what the
   files API has no call for (list with owners, find, grep, search, copy,
   remove). Paths are Blaxel's: relative ones, `~` and /blaxel resolve against
   /workspace, Runtime's working directory, as they resolve against /blaxel
   on Blaxel. The search calls follow Blaxel's sandbox API (its Go source,
   checked 27 September 2026): the same defaults, limits and exclusions. */

export type File = {
  group: string;
  lastModified: string;
  name: string;
  owner: string;
  path: string;
  permissions: string;
  size: number;
};
export type FileWithContent = File & { content: string };
export type Subdirectory = { name: string; path: string };
export type Directory = {
  files: Array<File>;
  name: string;
  path: string;
  subdirectories: Array<Subdirectory>;
};
export type SuccessResponse = { message: string; path?: string };
export type FindMatch = { path: string; type: string };
export type FindResponse = { matches: Array<FindMatch>; total: number };
export type FuzzySearchMatch = { path: string; score: number; type: string };
export type FuzzySearchResponse = { matches: Array<FuzzySearchMatch>; total: number };
export type ContentSearchMatch = {
  column: number;
  context?: string;
  line: number;
  path: string;
  text: string;
};
export type ContentSearchResponse = {
  matches: Array<ContentSearchMatch>;
  query: string;
  total: number;
};
export type CopyResponse = { message: string; source: string; destination: string };
export type WatchEvent = {
  op: "CREATE" | "WRITE" | "REMOVE" | "RENAME" | "CHMOD";
  path: string;
  name: string;
  content?: string;
};
export type SandboxFilesystemFile = { path: string; content: string };
export interface FilesystemSearchOptions {
  maxResults?: number;
  patterns?: string[];
  excludeDirs?: string[];
  excludeHidden?: boolean;
}
export interface FilesystemFindOptions {
  type?: "file" | "directory";
  patterns?: string[];
  maxResults?: number;
  excludeDirs?: string[];
  excludeHidden?: boolean;
}
export interface FilesystemGrepOptions {
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
  filePattern?: string;
  excludeDirs?: string[];
}

/** What `sandbox.fs` needs from its sandbox. */
export interface FsContext {
  /** Runs `work` on the live sandbox, woken if it was paused. */
  run<T>(work: (runtime: RuntimeSandbox) => Promise<T>): Promise<T>;
}

/** Runtime's files API writes at most 1 MiB outside /workspace in one call. */
const SMALL = 1_048_576;
/** A tree written in one command while its JSON stays under this. */
const TREE_INLINE = 512 * 1024;

/** Blaxel's FormatPath: `~` is HOME, doubled slashes collapse, empty is ".". */
function formatPath(path: string): string {
  let out = path === "" ? "." : path;
  if (out === "~" || out.startsWith("~/")) out = HOME + out.slice(1);
  return out.replace(/\/{2,}/g, "/");
}

/** The directory listing, file owners included (Go's os.ReadDir order). */
const LISTING = String.raw`
import json, os, stat, sys, datetime, pwd, grp
def name(get, i):
    try: return get(i)[0]
    except Exception: return str(i)
def perm(m):
    bits = m & 0o777
    if m & stat.S_ISUID: bits |= 1 << 23
    if m & stat.S_ISGID: bits |= 1 << 22
    if m & stat.S_ISVTX: bits |= 1 << 20
    if stat.S_ISLNK(m): bits |= 1 << 27
    return format(bits, "o")
def listing(path, shown):
    files, subs = [], []
    for entry in sorted(os.scandir(path), key=lambda e: e.name):
        child = ("" if shown == "/" else shown.rstrip("/")) + "/" + entry.name
        st = os.lstat(entry.path)
        if stat.S_ISDIR(st.st_mode):
            subs.append({"name": entry.name, "path": child})
        else:
            files.append({"name": entry.name, "path": child, "permissions": perm(st.st_mode),
                "size": st.st_size, "owner": name(pwd.getpwuid, st.st_uid), "group": name(grp.getgrgid, st.st_gid),
                "lastModified": datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc).isoformat().replace("+00:00", "Z")})
    return {"name": os.path.basename(shown.rstrip("/")) or "/", "path": shown, "files": files, "subdirectories": subs}
`;
const LS = String.raw`${LISTING}
path, shown = sys.argv[1], sys.argv[2]
try:
    print(json.dumps(listing(path, shown)))
except FileNotFoundError:
    print(json.dumps({"status": 404, "error": "directory not found: " + shown})); sys.exit(3)
except NotADirectoryError:
    print(json.dumps({"status": 422, "error": "not a directory: " + shown})); sys.exit(3)
except PermissionError as e:
    print(json.dumps({"status": 403, "error": str(e)})); sys.exit(3)
`;

/** Many files written in one command, then the root listed. */
const TREE = String.raw`${LISTING}
spec = json.load(sys.stdin)
root = spec["root"]
try:
    for rel, content in spec["files"].items():
        target = os.path.join(root, rel)
        os.makedirs(os.path.dirname(target) or root, exist_ok=True)
        with open(target, "w", encoding="utf-8") as f:
            f.write(content)
except PermissionError as e:
    print(json.dumps({"status": 403, "error": "error writing file: " + str(e)})); sys.exit(3)
except OSError as e:
    print(json.dumps({"status": 422, "error": "error writing file: " + str(e)})); sys.exit(3)
print(json.dumps(listing(root, spec["shown"])))
`;

const DEFAULT_EXCLUDES = [
  "node_modules",
  "vendor",
  ".git",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  ".next",
  "coverage",
];

/** Blaxel's find: files (or directories) under a path, by basename pattern. */
const FIND = String.raw`
import fnmatch, json, os, sys
o = json.loads(sys.argv[1])
root, kind, patterns, limit = o["root"], o["type"], o["patterns"], o["max"]
exclude, hidden = set(o["exclude"]), o["hidden"]
if not os.path.isdir(root):
    print(json.dumps({"status": 500, "error": "error walking directory: no such directory: " + o["shown"]})); sys.exit(3)
found = []
def visit(path, is_dir, top):
    base = os.path.basename(path)
    if not top and is_dir and base in exclude: return False
    if not top and hidden and base.startswith("."): return False
    if (kind == "file") != is_dir:
        if is_dir or not patterns or any(fnmatch.fnmatchcase(base, p) for p in patterns):
            found.append({"path": os.path.relpath(path, root), "type": "directory" if is_dir else "file"})
    return is_dir
def walk(path, top):
    try: entries = sorted(os.scandir(path), key=lambda e: e.name)
    except OSError: return
    for e in entries:
        if visit(e.path, e.is_dir(follow_symlinks=False), False): walk(e.path, False)
visit(root, True, True); walk(root, True)
if limit >= 0: found = found[:limit]
print(json.dumps({"matches": found, "total": len(found)}))
`;

/** Blaxel's grep: a plain substring, line by line, in regular files. */
const GREP = String.raw`
import fnmatch, json, os, sys
o = json.loads(sys.argv[1])
root, query, case, limit, pattern = o["root"], o["query"], o["case"], o["max"], o["pattern"]
exclude = set(o["exclude"])
if not os.path.isdir(root):
    print(json.dumps({"status": 400, "error": "specified directory does not exist: " + o["shown"]})); sys.exit(3)
needle = query if case else query.lower()
matches = []
def scan(path):
    try:
        with open(path, "rb") as f: data = f.read()
    except OSError: return True
    for number, line in enumerate(data.decode("utf-8", "replace").split("\n")):
        hay = line if case else line.lower()
        at = hay.find(needle)
        if at >= 0:
            matches.append({"path": os.path.relpath(path, root), "line": number + 1,
                "column": len(hay[:at].encode("utf-8")) + 1, "text": line})
            if limit >= 0 and len(matches) >= limit: return False
    return True
def walk(path):
    try: entries = sorted(os.scandir(path), key=lambda e: e.name)
    except OSError: return True
    for e in entries:
        if e.is_dir(follow_symlinks=False):
            if e.name in exclude: continue
            if not walk(e.path): return False
        elif e.is_file(follow_symlinks=False):
            if pattern and not fnmatch.fnmatchcase(e.name, pattern): continue
            if not scan(e.path): return False
    return True
walk(root)
print(json.dumps({"query": query, "matches": matches, "total": len(matches)}))
`;

/** A fuzzy search over paths: every character of the query in order, scored
 * higher for consecutive characters and for ones that start a word. */
const SEARCH = String.raw`
import json, os, sys
o = json.loads(sys.argv[1])
root, query, limit = o["root"], o["query"].lower(), o["max"]
exclude, hidden = set(o["exclude"]), o["hidden"]
def score(text):
    low, at, total, run, last = text.lower(), 0, 0, 0, -2
    for ch in query:
        i = low.find(ch, at)
        if i < 0: return None
        run = run + 1 if i == last + 1 else 1
        total += 16 + 4 * (run - 1)
        if i == 0 or text[i - 1] in "/_-. ": total += 8
        total -= min(i - at, 3)
        last, at = i, i + 1
    return total
found = []
def walk(path):
    try: entries = sorted(os.scandir(path), key=lambda e: e.name)
    except OSError: return
    for e in entries:
        is_dir = e.is_dir(follow_symlinks=False)
        if hidden and e.name.startswith("."): continue
        if is_dir and e.name in exclude: continue
        rel = os.path.relpath(e.path, root)
        s = score(rel)
        if s is not None: found.append({"path": rel, "score": s, "type": "directory" if is_dir else "file"})
        if is_dir: walk(e.path)
walk(root)
found.sort(key=lambda m: -m["score"])
if limit > 0: found = found[:limit]
print(json.dumps({"matches": found, "total": len(found)}))
`;

/** Blaxel's maxResults: a default, capped at 1000, 0 for all; anything else
 * is refused. */
function maxResults(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0)
    throw responseError(400, `invalid maxResults: ${value}`);
  return value === 0 ? -1 : Math.min(value, 1000);
}

/** The search root: "", "/" and "." are the working directory, as in Blaxel's
 * grep and search. */
function searchRoot(path: string): string {
  return path === "" || path === "/" || path === "."
    ? RUNTIME_HOME
    : toRuntimePath(formatPath(path));
}

function bytesOf(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/** `sandbox.fs`. */
export class SandboxFileSystem {
  readonly #ctx: FsContext;
  constructor(ctx: FsContext) {
    this.#ctx = ctx;
  }

  /** Runs a Python script in the sandbox and answers its JSON. A script that
   * reports `{ status, error }` becomes that ResponseError. */
  async #script<T>(script: string, args: string[], stdin?: string): Promise<T> {
    const argv = ["python3", "-c", script, ...args];
    const run = (timeoutMs: number) =>
      this.#ctx.run((runtime) =>
        runtime.exec(argv, { timeoutMs, ...(stdin === undefined ? {} : { stdin }) }),
      );
    let result = await run(60_000);
    // A short exec holds 64 KiB of output; a longer one streams all of it.
    if (result.stdoutTruncated && stdin === undefined) result = await run(120_000);
    if (result.exitCode === 127)
      throw new NotSupportedError(
        "This file call on an image without python3",
        "Use Runtime's stock image, or install python3 in your image (the adapter runs a short script for it).",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw responseError(500, result.stderr.trim() || "the file command failed");
    }
    const failure = parsed as { status?: number; error?: string };
    if (result.exitCode !== 0 && failure?.error)
      throw responseError(failure.status ?? 500, failure.error);
    return parsed as T;
  }

  /** Writes bytes anywhere, as Blaxel's root-owned sandbox API can: outside
   * /workspace, a path the sandbox user may not write, one whose directory is
   * missing, or a file over 1 MiB goes through /workspace and is moved into
   * place with sudo. */
  async #writeBytes(target: string, bytes: Uint8Array): Promise<void> {
    const inWorkspace = target === RUNTIME_HOME || target.startsWith(`${RUNTIME_HOME}/`);
    if (inWorkspace || bytes.length <= SMALL) {
      try {
        await this.#ctx.run((runtime) => runtime.files.write(target, bytes));
        return;
      } catch (error) {
        // The files API acts as the sandbox user: it cannot write where only
        // root may (a directory a root process made, even in /workspace),
        // nor, outside /workspace, make a missing parent.
        const code = codeOf(error);
        if (code !== "permission_denied" && (inWorkspace || code !== "file_not_found")) throw error;
      }
    }
    const staging = `${RUNTIME_HOME}/.runtime-blaxel-${crypto.randomUUID()}`;
    await this.#ctx.run((runtime) => runtime.files.write(staging, bytes));
    await this.#sudo(
      'mkdir -p "$(dirname "$2")" && mv -f "$1" "$2"',
      [staging, target],
      `error writing file ${target}`,
    );
  }

  /** A file's bytes. One only root may read (a root process made it private)
   * is copied, with sudo, to a staging file the sandbox user owns, read, and
   * the copy removed. */
  async #readBytes(target: string): Promise<Uint8Array> {
    try {
      return await this.#ctx.run((runtime) => runtime.files.read(target));
    } catch (error) {
      if (codeOf(error) !== "permission_denied") throw error;
    }
    const staging = await this.#stageForReading(target);
    try {
      return await this.#ctx.run((runtime) => runtime.files.read(staging));
    } finally {
      await this.#ctx.run((runtime) => runtime.files.remove(staging)).catch(() => undefined);
    }
  }

  async #stageForReading(target: string): Promise<string> {
    const staging = `/tmp/.runtime-blaxel-${crypto.randomUUID()}`;
    await this.#sudo(
      'install -m 0600 -o "$SUDO_UID" -g "$SUDO_GID" -- "$1" "$2"',
      [target, staging],
      `error reading file ${target}`,
    );
    return staging;
  }

  async #sudo(script: string, args: string[], failure: string): Promise<void> {
    const result = await this.#ctx.run((runtime) =>
      runtime.exec(["sudo", "sh", "-c", script, "sh", ...args]),
    );
    if (result.exitCode !== 0)
      throw responseError(422, `${failure}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }

  /** Makes a directory and its parents. */
  async mkdir(path: string, permissions = "0755"): Promise<SuccessResponse> {
    const shown = formatPath(path);
    const target = toRuntimePath(shown);
    if (!/^[0-7]{3,4}$/.test(permissions))
      throw responseError(422, `invalid permissions format '${permissions}'`);
    try {
      await this.#ctx.run((runtime) => runtime.files.mkdir(target, { parents: true }));
      if (Number.parseInt(permissions, 8) !== 0o755)
        await this.#ctx.run((runtime) => runtime.exec(["chmod", permissions, "--", target]));
    } catch (error) {
      if (codeOf(error) !== "permission_denied") throw error;
      await this.#sudo(
        'mkdir -p -m "$1" -- "$2" && chown "$SUDO_UID:$SUDO_GID" -- "$2"',
        [permissions, target],
        "error creating directory",
      );
    }
    return { message: "Directory created successfully", path: shown };
  }

  /** Writes a text file, making its directories. */
  async write(path: string, content: string): Promise<SuccessResponse> {
    const shown = formatPath(path);
    await this.#writeBytes(toRuntimePath(shown), bytesOf(content));
    return { message: "File created/updated successfully", path: shown };
  }

  /** Writes bytes: a Buffer, Blob, File or Uint8Array, or a string naming a
   * local file to upload. */
  async writeBinary(
    path: string,
    content: Buffer | Blob | Uint8Array | string,
  ): Promise<SuccessResponse> {
    const shown = formatPath(path);
    let bytes: Uint8Array;
    if (typeof content === "string") {
      const { readFile } = await import("node:fs/promises");
      bytes = await readFile(content);
    } else if (content instanceof Uint8Array) bytes = content;
    else if (ArrayBuffer.isView(content))
      bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    else if (content && typeof content.arrayBuffer === "function")
      bytes = new Uint8Array(await content.arrayBuffer());
    else {
      const kind = (content as object | null)?.constructor?.name ?? typeof content;
      throw new Error(`Unsupported content type: ${kind}`);
    }
    await this.#writeBytes(toRuntimePath(shown), bytes);
    return { message: "Binary file uploaded successfully", path: shown };
  }

  /** Writes files under `destinationPath` (the working directory by
   * default) and answers the listing of it: one command for a small tree. */
  async writeTree(
    files: SandboxFilesystemFile[],
    destinationPath: string | null = null,
  ): Promise<Directory | undefined> {
    const shown = formatPath(destinationPath ?? "");
    const root = toRuntimePath(shown);
    const display = shown === "." ? HOME : shown;
    const tree = Object.fromEntries(files.map((file) => [file.path, file.content]));
    const spec = JSON.stringify({ root, shown: display, files: tree });
    if (spec.length <= TREE_INLINE)
      try {
        return await this.#script<Directory>(TREE, [], spec);
      } catch (error) {
        // A root the sandbox user may not write: file by file, through sudo.
        if (!(error instanceof ResponseError && error.status === 403)) throw error;
      }
    const entries = Object.entries(tree);
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const [rel, content] = entries[next++]!;
        await this.#writeBytes(toRuntimePath(`${root}/${rel}`), bytesOf(content));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
    return this.ls(display);
  }

  /** A text file's content. */
  async read(path: string): Promise<string> {
    const target = toRuntimePath(formatPath(path));
    try {
      return new TextDecoder().decode(await this.#readBytes(target));
    } catch (error) {
      if (codeOf(error) === "is_a_directory") throw new Error("Unsupported file type");
      throw error;
    }
  }

  /** A file's bytes, as a Blob. */
  async readBinary(path: string): Promise<Blob> {
    const target = toRuntimePath(formatPath(path));
    const bytes = await this.#readBytes(target);
    return new Blob([bytes as Uint8Array<ArrayBuffer>]);
  }

  /** Copies a sandbox file to the local disk with `mode` (default 0o644). */
  async download(
    src: string,
    destinationPath: string,
    { mode = 0o644 }: { mode?: number } = {},
  ): Promise<void> {
    const target = toRuntimePath(formatPath(src));
    try {
      await this.#ctx.run((runtime) => runtime.files.download(target, destinationPath));
    } catch (error) {
      if (codeOf(error) !== "permission_denied") throw error;
      const staging = await this.#stageForReading(target);
      try {
        await this.#ctx.run((runtime) => runtime.files.download(staging, destinationPath));
      } finally {
        await this.#ctx.run((runtime) => runtime.files.remove(staging)).catch(() => undefined);
      }
    }
    const { chmod } = await import("node:fs/promises");
    await chmod(destinationPath, mode);
  }

  /** Removes a file, or a directory (its contents too with `recursive`). */
  async rm(path: string, recursive = false): Promise<SuccessResponse> {
    const shown = formatPath(path);
    const target = toRuntimePath(shown);
    const script = String.raw`p="$1"
if [ -d "$p" ] && [ ! -L "$p" ]; then
  if [ "$2" = 1 ]; then rm -rf -- "$p" 2>/dev/null || sudo rm -rf -- "$p" || exit 3
  else
    if [ -n "$(ls -A -- "$p" 2>/dev/null)" ]; then echo "directory not empty" >&2; exit 4; fi
    rmdir -- "$p" 2>/dev/null || sudo rmdir -- "$p" || exit 3
  fi
  echo Directory
elif [ -e "$p" ] || [ -L "$p" ]; then rm -f -- "$p" 2>/dev/null || sudo rm -f -- "$p" || exit 3; echo File
else exit 2; fi`;
    const result = await this.#ctx.run((runtime) =>
      runtime.exec(["bash", "-c", script, "rm", target, recursive ? "1" : "0"]),
    );
    if (result.exitCode === 2) throw responseError(404, "file or directory not found");
    if (result.exitCode === 4)
      throw responseError(422, "error deleting directory: directory not empty");
    if (result.exitCode !== 0)
      throw responseError(422, `error deleting ${shown}: ${result.stderr.trim()}`);
    return { message: `${result.stdout.trim()} deleted successfully`, path: shown };
  }

  /** A directory's files and subdirectories, as Blaxel lists them. */
  async ls(path: string): Promise<Directory> {
    const shown = formatPath(path);
    const target = toRuntimePath(shown);
    const display = shown === "." ? HOME : shown;
    try {
      return await this.#script<Directory>(LS, [target, display]);
    } catch (error) {
      if (!(error instanceof NotSupportedError)) throw error;
    }
    // No python3 in the image: the files API, which does not know owners.
    const entries = await this.#ctx.run((runtime) =>
      runtime.files.list(target, { depth: 1, hidden: true }),
    );
    const child = (name: string) => `${display === "/" ? "" : display.replace(/\/$/, "")}/${name}`;
    return {
      name: display.split("/").filter(Boolean).pop() ?? "/",
      path: display,
      files: entries
        .filter((entry) => entry.type !== "directory")
        .map((entry) => ({
          name: entry.name,
          path: child(entry.name),
          permissions: (Number.parseInt(entry.mode, 8) & 0o777).toString(8),
          size: entry.size,
          lastModified: entry.modifiedAt,
          owner: "",
          group: "",
        })),
      subdirectories: entries
        .filter((entry) => entry.type === "directory")
        .map((entry) => ({ name: entry.name, path: child(entry.name) })),
    };
  }

  /** Paths under `path` fuzzily matching `query`, best first. */
  async search(
    query: string,
    path = "/",
    options: FilesystemSearchOptions = {},
  ): Promise<FuzzySearchResponse> {
    if (!query) throw responseError(400, "query parameter is required");
    return this.#script(SEARCH, [
      JSON.stringify({
        root: searchRoot(path),
        query,
        max: maxResults(options.maxResults, 20),
        exclude: options.excludeDirs?.length ? options.excludeDirs : DEFAULT_EXCLUDES,
        hidden: options.excludeHidden ?? true,
      }),
    ]);
  }

  /** Files (or directories) under `path` whose name matches a pattern. */
  async find(path: string, options: FilesystemFindOptions = {}): Promise<FindResponse> {
    const type = options.type ?? "file";
    if (type !== "file" && type !== "directory")
      throw responseError(400, `invalid search type: ${String(type)}`);
    const shown = formatPath(path);
    return this.#script(FIND, [
      JSON.stringify({
        root: toRuntimePath(shown),
        shown,
        type,
        patterns: options.patterns ?? [],
        max: maxResults(options.maxResults, 20),
        exclude: options.excludeDirs?.length ? options.excludeDirs : DEFAULT_EXCLUDES,
        hidden: options.excludeHidden ?? true,
      }),
    ]);
  }

  /** Lines containing `query` (a plain string, case-insensitive by default)
   * in the files under `path`. */
  async grep(
    query: string,
    path = "/",
    options: FilesystemGrepOptions = {},
  ): Promise<ContentSearchResponse> {
    if (!query) throw responseError(400, "query parameter is required");
    return this.#script(GREP, [
      JSON.stringify({
        root: searchRoot(path),
        shown: path,
        query,
        case: options.caseSensitive ?? false,
        max: maxResults(options.maxResults, 100),
        pattern: options.filePattern ?? "",
        exclude: options.excludeDirs?.length ? options.excludeDirs : DEFAULT_EXCLUDES,
      }),
    ]);
  }

  /** Copies a file or directory (cp -r). */
  async cp(
    source: string,
    destination: string,
    _options: { maxWait?: number } = {},
  ): Promise<CopyResponse> {
    const from = toRuntimePath(formatPath(source));
    const to = toRuntimePath(formatPath(destination));
    const result = await this.#ctx.run((runtime) =>
      runtime.exec([
        "sh",
        "-c",
        'cp -r -- "$1" "$2" 2>/dev/null || sudo cp -r -- "$1" "$2"',
        "cp",
        from,
        to,
      ]),
    );
    if (result.exitCode !== 0)
      throw new Error(`Could not copy ${source} to ${destination} cause: ${result.stderr.trim()}`);
    return { message: "Files copied", source, destination };
  }

  /** Calls `callback` for each change in `path` (and below it for
   * `path/**`) until `close()`. `withContent` adds a created or written
   * file's text; `ignore` skips paths. */
  watch(
    path: string,
    callback: (fileEvent: WatchEvent) => void | Promise<void>,
    options?: { onError?: (error: Error) => void; withContent?: boolean; ignore?: string[] },
  ): { close: () => void } {
    const recursive = /\/\*\*\/?$/.test(path);
    const shown = formatPath(recursive ? path.replace(/\/\*\*\/?$/, "") || "/" : path);
    const target = toRuntimePath(shown);
    const backToBlaxel = shown === "." || shown.startsWith(HOME) || !shown.startsWith("/");
    const exclude = (options?.ignore ?? []).flatMap((ignored) => {
      const full = toRuntimePath(formatPath(ignored));
      if (full === target || !full.startsWith(`${target}/`)) return [];
      const rel = full.slice(target.length + 1);
      return [rel, `${rel}/**`];
    });
    let closed = false;
    let handle: { stop(): Promise<void> } | undefined;
    const deliverOne = async (event: FileEvent) => {
      const full = event.path;
      const slash = full.lastIndexOf("/");
      const dir = slash <= 0 ? "/" : full.slice(0, slash);
      const out: WatchEvent = {
        op: event.type.toUpperCase() as WatchEvent["op"],
        path: backToBlaxel ? toBlaxelPath(dir) : dir,
        name: full.slice(slash + 1),
      };
      if (options?.withContent && (out.op === "CREATE" || out.op === "WRITE") && !event.isDir) {
        const content = await this.#readBytes(full).then(
          (bytes) => new TextDecoder().decode(bytes),
          () => undefined,
        );
        if (content !== undefined) out.content = content;
      }
      if (!closed) await callback(out);
    };
    // One at a time and in order, as Blaxel awaits each callback: an event
    // whose content is being read holds back the ones after it.
    let chain = Promise.resolve();
    const deliver = (event: FileEvent) => {
      chain = chain
        .then(() => deliverOne(event))
        .catch((error: unknown) => {
          options?.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
      return chain;
    };
    void (async () => {
      try {
        const made = await this.#ctx.run((runtime) =>
          runtime.files.watch(target, deliver, {
            recursive,
            ...(exclude.length ? { exclude } : {}),
          }),
        );
        if (closed) await made.stop();
        else handle = made;
      } catch (error) {
        closed = true;
        const failure = translate(error);
        options?.onError?.(failure instanceof Error ? failure : new Error(String(failure)));
      }
    })();
    return {
      close: () => {
        closed = true;
        void handle?.stop().catch(() => undefined);
      },
    };
  }
}

/** Blaxel's own retry helper: Runtime's SDK retries transient failures
 * itself, so this runs `fn` once. */
export async function retryOnTransient<T>(fn: () => Promise<T>): Promise<T> {
  return guard(fn);
}
