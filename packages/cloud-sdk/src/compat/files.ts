import type { Sandbox } from "../sandbox.js";
import { checked, missing, pathAt } from "./core.js";

/** Guest operations use argv, never interpolated shell paths. */
export class GuestFiles {
  /** Staging copies whose removal failed; the next staged write or
   * append tries them again. */
  readonly #leftover = new Set<string>();
  constructor(
    private readonly get: () => Promise<Sandbox>,
    readonly cwd = "/workspace",
  ) {}
  path(path: string) {
    return pathAt(path, this.cwd);
  }
  /** Removes a staging copy, and remembers it for the next staged call if the
   * removal fails. It never throws: the write's outcome, including its
   * original failure, stands, and a successful destination write must not
   * invite a replay. */
  async #discard(sandbox: Sandbox, staging: string): Promise<void> {
    try {
      await sandbox.files.remove(staging);
      this.#leftover.delete(staging);
    } catch {
      this.#leftover.add(staging);
    }
  }
  /** Tries again every staging copy an earlier call could not remove. */
  async #sweep(sandbox: Sandbox): Promise<void> {
    for (const staging of [...this.#leftover]) await this.#discard(sandbox, staging);
  }
  async readFile(path: string): Promise<Uint8Array> {
    return (await this.get()).files.read(this.path(path));
  }
  async readTextFile(path: string): Promise<string> {
    return (await this.get()).files.readText(this.path(path));
  }
  async writeFile(
    path: string,
    content: string | Uint8Array,
    options: { mode?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const sandbox = await this.get();
    const target = this.path(path);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (bytes.length <= 1_048_576 || target.startsWith("/workspace/")) {
      await sandbox.files.write(target, content, options);
      return;
    }
    await this.#sweep(sandbox);
    const staging = `/workspace/.runtime-compat/write-${crypto.randomUUID()}`;
    try {
      await sandbox.files.write(staging, bytes, { mode: 0o600, signal: options.signal });
      await checked(
        sandbox,
        [
          "bash",
          "-c",
          'set -e; mkdir -p -- "$(dirname -- "$2")"; temp="$2.runtime-$4"; trap \'rm -f -- "$temp"\' EXIT; cp -- "$1" "$temp"; chmod "$3" "$temp"; mv -f -- "$temp" "$2"',
          "bash",
          staging,
          target,
          (options.mode ?? 0o644).toString(8),
          crypto.randomUUID(),
        ],
        { signal: options.signal },
      );
    } finally {
      await this.#discard(sandbox, staging);
    }
  }
  writeTextFile(path: string, content: string) {
    return this.writeFile(path, content);
  }
  async mkdir(path: string, recursive = false): Promise<void> {
    await (await this.get()).files.mkdir(this.path(path), { parents: recursive });
  }
  async remove(path: string, recursive = false): Promise<void> {
    await (await this.get()).files.remove(this.path(path), { recursive });
  }
  async rename(from: string, to: string, overwrite = false): Promise<void> {
    await (await this.get()).files.rename(this.path(from), this.path(to), { overwrite });
  }
  async copy(from: string, to: string, recursive = false, overwrite = false): Promise<void> {
    const sandbox = await this.get();
    if (!overwrite && (await sandbox.files.exists(this.path(to))))
      throw new Error(`Destination exists: ${to}`);
    if (!overwrite) {
      // cp -n alone reports success when it skips a raced destination. Stage
      // privately, then publish without replacement and verify it moved.
      // mv -n that skips succeeds before coreutils 9.2 and fails from it on
      // (the guest's 9.4 says "not replacing"), so a skip is told by the
      // staged copy still being there beside a destination; with none there,
      // mv's own error stands.
      await checked(sandbox, [
        "bash",
        "-c",
        'set -e; parent=$(dirname -- "$2"); stage="$parent/.runtime-copy-$4"; mkdir -m 700 -- "$stage"; trap \'rm -rf -- "$stage"\' EXIT; if [ "$3" = true ]; then cp -R -- "$1" "$stage/item"; else cp -- "$1" "$stage/item"; fi; mv -n -T -- "$stage/item" "$2" 2>"$stage/mv.err" || :; if [ -e "$stage/item" ] || [ -L "$stage/item" ]; then if [ -e "$2" ] || [ -L "$2" ]; then printf "Destination exists: %s\\n" "$2" >&2; exit 73; fi; cat -- "$stage/mv.err" >&2; exit 1; fi',
        "bash",
        this.path(from),
        this.path(to),
        String(recursive),
        crypto.randomUUID(),
      ]);
      return;
    }
    await checked(sandbox, [
      "cp",
      ...(recursive ? ["-R"] : []),
      "--",
      this.path(from),
      this.path(to),
    ]);
  }
  async exists(path: string): Promise<boolean> {
    return (await this.get()).files.exists(this.path(path));
  }
  async stat(path: string) {
    const entry = await (await this.get()).files.stat(this.path(path));
    if (!entry.exists) missing(path);
    return entry;
  }
  async readdir(path: string) {
    return (await this.get()).files.list(this.path(path), { hidden: true });
  }
  async chmod(path: string, mode: number, recursive = false): Promise<void> {
    await checked(await this.get(), [
      "chmod",
      ...(recursive ? ["-R"] : []),
      (mode & 0o7777).toString(8),
      "--",
      this.path(path),
    ]);
  }
  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const sandbox = await this.get();
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (bytes.byteLength <= 1_048_576) {
      await checked(sandbox, ["bash", "-c", 'cat >> "$1"', "bash", this.path(path)], {
        stdin: bytes,
      });
      return;
    }
    await this.#sweep(sandbox);
    const staging = `/workspace/.runtime-compat/append-${crypto.randomUUID()}`;
    try {
      await sandbox.files.write(staging, bytes, { mode: 0o600 });
      await checked(sandbox, [
        "bash",
        "-c",
        'cat -- "$1" >> "$2"',
        "bash",
        staging,
        this.path(path),
      ]);
    } finally {
      await this.#discard(sandbox, staging);
    }
  }
}
