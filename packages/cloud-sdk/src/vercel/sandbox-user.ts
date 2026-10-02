import { dirname, resolve } from "node:path";
import type { Command, CommandFinished } from "./command.js";
import type { RunCommandParams, Sandbox } from "./sandbox.js";

/* Vercel's multi-user helpers over Runtime's sandbox owner, who has
   passwordless sudo: a user is a real Linux user made with `sudo useradd`,
   and every call as that user is `sudo -u <user>`, exactly as Vercel's own
   SDK does it (checked against @vercel/sandbox 3.5.1). */

const VALID_NAME = /^[a-z_][a-z0-9_-]*$/;
const MAX_NAME_LENGTH = 32;

/** A Linux user or group name Vercel accepts, which is also safe to pass to
 * useradd, groupadd and sudo. */
export function validateName(name: string, kind: string): void {
  if (!name) throw new Error(`Invalid ${kind}: must not be empty`);
  if (name.length > MAX_NAME_LENGTH)
    throw new Error(`Invalid ${kind} "${name}": must be at most ${MAX_NAME_LENGTH} characters`);
  if (!VALID_NAME.test(name))
    throw new Error(
      `Invalid ${kind} "${name}": must match ${VALID_NAME} (lowercase letters, digits, hyphens, underscores)`,
    );
}

/** Thrown when `sandbox.createUser` is called for an existing username. */
export class SandboxUserAlreadyExistsError extends Error {
  readonly username: string;
  constructor(username: string) {
    super(`Failed to create user "${username}": user already exists`);
    this.name = "SandboxUserAlreadyExistsError";
    this.username = username;
  }
}

type Signal = { signal?: AbortSignal };

/** A user in a sandbox, made with `sandbox.createUser` or found with
 * `sandbox.asUser`. Commands and file calls run as this user. */
export class SandboxUser {
  readonly username: string;
  /** `/root` for root, else `/home/<username>`. */
  readonly homeDir: string;
  readonly #sandbox: Sandbox;
  #primaryGroup: Promise<string> | undefined;

  /** Use sandbox.createUser or sandbox.asUser. */
  constructor({ sandbox, username }: { sandbox: Sandbox; username: string }) {
    this.#sandbox = sandbox;
    this.username = username;
    this.homeDir = username === "root" ? "/root" : `/home/${username}`;
  }

  /** `sudo -u <user>`, in `cwd` (the user's home by default), with `env`
   * given through `env` so it survives sudo. */
  #wrap(params: { cmd: string; args?: string[]; env?: Record<string, string>; cwd?: string }) {
    const env = Object.entries(params.env ?? {}).map(([key, value]) => `${key}=${value}`);
    return {
      cmd: "sudo",
      args: [
        "-u",
        this.username,
        "--",
        "bash",
        "-c",
        'cd "$1" || exit 1; shift; exec "$@"',
        "bash",
        params.cwd ?? this.homeDir,
        ...(env.length ? ["env", ...env] : []),
        params.cmd,
        ...(params.args ?? []),
      ],
    };
  }

  #resolve(path: string): string {
    return path.startsWith("/") ? path : `${this.homeDir}/${path}`;
  }

  /** Runs a command as this user. `sudo: true` runs it as root instead. */
  runCommand(
    command: string,
    args?: string[],
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CommandFinished>;
  runCommand(params: RunCommandParams & { detached: true }): Promise<Command>;
  runCommand(params: RunCommandParams): Promise<CommandFinished>;
  runCommand(
    commandOrParams: string | RunCommandParams,
    args?: string[],
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Command | CommandFinished> {
    if (typeof commandOrParams === "string")
      return this.#sandbox.runCommand({
        ...this.#wrap({ cmd: commandOrParams, ...(args ? { args } : {}) }),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    const params = commandOrParams;
    if (params.sudo) return this.#sandbox.runCommand({ ...params });
    const wrapped = this.#wrap(params);
    return this.#sandbox.runCommand({
      cmd: wrapped.cmd,
      args: wrapped.args,
      ...(params.detached ? { detached: true } : {}),
      ...(params.stdout ? { stdout: params.stdout } : {}),
      ...(params.stderr ? { stderr: params.stderr } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
  }

  /** Writes files into this user's home (or absolute paths), then gives them
   * and the directories made for them to this user. */
  async writeFiles(
    files: { path: string; content: string | Uint8Array; mode?: number }[],
    opts: Signal = {},
  ): Promise<void> {
    const absolute = files.map((file) => ({ ...file, path: this.#resolve(file.path) }));
    await this.#sandbox.writeFiles(absolute, opts);
    const paths = absolute.map((file) => file.path);
    if (!paths.length) return;
    await this.#chown(paths, `${this.username}:${await this.#group(opts.signal)}`, opts.signal);
    const dirs = this.#ancestorsUnderHome(paths);
    if (dirs.length) {
      const { group } = await this.#sandbox.getDefaultUser(opts);
      await this.#chown(dirs, `${this.username}:${group}`, opts.signal);
      await this.#chmod(dirs, "770", opts.signal);
    }
  }

  /** The file as this user may read it, as a stream; null when missing. */
  async readFile(
    file: { path: string; cwd?: string },
    opts: Signal = {},
  ): Promise<NodeJS.ReadableStream | null> {
    const buffer = await this.#cat(file, opts);
    if (buffer === null) return null;
    const { Readable } = await import("node:stream");
    return Readable.from([buffer]);
  }

  /** The file as this user may read it; null when missing. */
  readFileToBuffer(
    file: { path: string; cwd?: string },
    opts: Signal = {},
  ): Promise<Buffer | null> {
    return this.#cat(file, opts);
  }

  /** Copies a file this user may read to the local disk; null when missing. */
  async downloadFile(
    src: { path: string; cwd?: string },
    dst: { path: string; cwd?: string },
    opts: { mkdirRecursive?: boolean; signal?: AbortSignal } = {},
  ): Promise<string | null> {
    const buffer = await this.#cat(src, opts);
    if (buffer === null) return null;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const target = resolve(dst.cwd ?? "", dst.path);
    if (opts.mkdirRecursive) await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer, opts.signal ? { signal: opts.signal } : {});
    return target;
  }

  /** Reads as this user with `base64`, so the user's own permissions apply
   * and binary files arrive whole. */
  async #cat(file: { path: string; cwd?: string }, opts: Signal): Promise<Buffer | null> {
    const path = file.path.startsWith("/") ? file.path : `${file.cwd ?? this.homeDir}/${file.path}`;
    const result = await this.runCommand({
      cmd: "base64",
      args: [path],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (result.exitCode !== 0) {
      const stderr = await result.stderr();
      if (/No such file or directory/i.test(stderr)) return null;
      throw new Error(`Failed to read ${path}: ${stderr}`);
    }
    return Buffer.from(await result.stdout(), "base64");
  }

  /** Makes a directory owned by this user. */
  async mkDir(path: string, opts: Signal = {}): Promise<void> {
    const absolute = this.#resolve(path);
    await this.#sandbox.mkDir(absolute, opts);
    const dirs = [absolute, ...this.#ancestorsUnderHome([absolute])];
    const { group } = await this.#sandbox.getDefaultUser(opts);
    await this.#chown(dirs, `${this.username}:${group}`, opts.signal);
    await this.#chmod(dirs, "770", opts.signal);
  }

  async addToGroup(groupname: string, opts: Signal = {}): Promise<void> {
    validateName(groupname, "group name");
    await this.#sandbox.addUserToGroup(this.username, groupname, opts);
  }

  async removeFromGroup(groupname: string, opts: Signal = {}): Promise<void> {
    validateName(groupname, "group name");
    await this.#sandbox.removeUserFromGroup(this.username, groupname, opts);
  }

  /** The user's primary group, read from the sandbox once. */
  #group(signal?: AbortSignal): Promise<string> {
    this.#primaryGroup ??= (async () => {
      const result = await this.#sandbox.runCommand({
        cmd: "id",
        args: ["-gn", this.username],
        ...(signal ? { signal } : {}),
      });
      if (result.exitCode !== 0)
        throw new Error(
          `Failed to resolve the primary group of "${this.username}": ${await result.stderr()}`,
        );
      const group = (await result.stdout()).trim();
      if (!group) throw new Error(`Failed to resolve the primary group of "${this.username}"`);
      return group;
    })().catch((error: unknown) => {
      this.#primaryGroup = undefined;
      throw error;
    });
    return this.#primaryGroup;
  }

  async #chown(paths: string[], owner: string, signal?: AbortSignal) {
    await rootOrThrow(
      this.#sandbox,
      "chown",
      [owner, ...paths],
      signal,
      () => `Failed to set ownership on ${paths.join(", ")}`,
    );
  }

  async #chmod(paths: string[], mode: string, signal?: AbortSignal) {
    await rootOrThrow(
      this.#sandbox,
      "chmod",
      [mode, ...paths],
      signal,
      () => `Failed to set permissions on ${paths.join(", ")}`,
    );
  }

  /** The directories strictly between this user's home and each path. */
  #ancestorsUnderHome(paths: string[]): string[] {
    const dirs = new Set<string>();
    const prefix = `${this.homeDir}/`;
    for (const path of paths) {
      let dir = path.slice(0, path.lastIndexOf("/"));
      while (dir.length > this.homeDir.length && dir.startsWith(prefix)) {
        dirs.add(dir);
        dir = dir.slice(0, dir.lastIndexOf("/"));
      }
    }
    return [...dirs];
  }
}

/** Runs `cmd args` under sudo; a non-zero exit throws `what(): <stderr>`. */
export async function rootOrThrow(
  sandbox: Sandbox,
  cmd: string,
  args: string[],
  signal: AbortSignal | undefined,
  what: () => string,
): Promise<CommandFinished> {
  const result = await sandbox.runCommand({ cmd, args, sudo: true, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new Error(`${what()}: ${await result.stderr()}`);
  return result;
}
