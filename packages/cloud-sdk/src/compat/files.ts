import type { Sandbox } from "../sandbox.js";
import { checked, missing, pathAt } from "./core.js";

/** Guest operations use argv, never interpolated shell paths. */
export class GuestFiles {
  constructor(
    private readonly get: () => Promise<Sandbox>,
    readonly cwd = "/workspace",
  ) {}
  path(path: string) {
    return pathAt(path, this.cwd);
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
    const staging = `/workspace/.runtime-compat/write-${crypto.randomUUID()}`;
    await sandbox.files.write(staging, bytes, { mode: 0o600, signal: options.signal });
    try {
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
      await sandbox.files.remove(staging);
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
    const staging = `/workspace/.runtime-compat/append-${crypto.randomUUID()}`;
    await sandbox.files.write(staging, bytes, { mode: 0o600 });
    try {
      await checked(sandbox, [
        "bash",
        "-c",
        'cat -- "$1" >> "$2"',
        "bash",
        staging,
        this.path(path),
      ]);
    } finally {
      await sandbox.files.remove(staging);
    }
  }
}
