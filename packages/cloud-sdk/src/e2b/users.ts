import type { FileEntry } from "../types.js";
import type { RequestOptions } from "../transport.js";
import type { SandboxContext, Username } from "./commands.js";
import { FileNotFoundError, guard, InvalidArgumentError, SandboxError } from "./errors.js";

/* E2B's `user` option, on Runtime. A sandbox's own user is `runtime`, with
   passwordless sudo; E2B's default user is called "user". So "user" (or no
   user) runs as the sandbox's own user, and any other name runs through
   `sudo -u <name>`. The user must already exist: the adapter never makes one,
   and a name the sandbox does not know is refused before anything runs. */

const NAME = /^[a-z_][a-z0-9_.-]{0,31}$/i;
/** Exit codes the scripts below use to say what went wrong. */
const MISSING = 44;
const NOT_DIRECTORY = 45;
const IS_DIRECTORY = 46;
const EXISTS = 47;
/** Base64 text per exec: under the 1 MiB an exec's input may carry. */
const WRITE_CHUNK = 786_432;

/** Only the caller's signal: an exec's own `timeoutMs` is the command's. */
const signalOf = (options: RequestOptions) => (options.signal ? { signal: options.signal } : {});

const checked = new WeakMap<SandboxContext, Map<string, Promise<void>>>();

/** The Linux user a call runs as, or undefined for the sandbox's own. Refuses
 * a user the sandbox does not have, once per user and sandbox. */
export async function runAs(
  ctx: SandboxContext,
  user: Username | undefined,
  options: RequestOptions,
): Promise<string | undefined> {
  if (user === undefined || user === "user") return undefined;
  if (typeof user !== "string" || !NAME.test(user))
    throw new InvalidArgumentError(`"${String(user)}" is not a Linux user name.`);
  if (user === "root") return user;
  let users = checked.get(ctx);
  if (!users) checked.set(ctx, (users = new Map<string, Promise<void>>()));
  let check = users.get(user);
  if (!check) {
    check = (async () => {
      const found = await guard("sandbox", () =>
        ctx.runtime.exec(["id", "-u", "--", user], signalOf(options)),
      );
      if (found.exitCode !== 0)
        throw new InvalidArgumentError(
          `This sandbox has no user "${user}", and Runtime never creates one for you. ` +
            `Make it first, as root: sandbox.commands.run("useradd -m ${user}", { user: "root" }). ` +
            `"user" is the sandbox's own user and "root" is root.`,
        );
    })();
    users.set(user, check);
    check.catch(() => users.delete(user));
  }
  await check;
  return user;
}

/** `bash -c script` as `user`, keeping the environment Runtime gives the
 * command. Without a `cwd` it starts in the user's home, as E2B's does. */
export function commandAs(user: string, script: string, cwdGiven: boolean): string[] {
  return [
    "sudo",
    "-n",
    "-E",
    "-H",
    "-u",
    user,
    "--",
    "/bin/bash",
    "-c",
    cwdGiven ? script : `cd ~ 2>/dev/null\n${script}`,
  ];
}

/** An interactive login shell as `user`, for a PTY. */
export function shellAs(user: string, cwdGiven: boolean): string[] {
  return commandAs(user, "exec /bin/bash -i -l", cwdGiven);
}

/** A running command as E2B lists it, from the command line Runtime keeps
 * (its words joined by spaces, at most 256 characters): `/bin/bash -l -c
 * <script>` for a command, `/bin/bash -i -l` for a PTY, as E2B starts them,
 * whether it runs as the sandbox user or through `commandAs`. Anything else,
 * started outside this package, is its first word and the rest. */
export function listedAs(command: string): { cmd: string; args: string[] } {
  const wrapped = AS_USER.exec(command);
  if (wrapped) {
    const inner = command.slice(wrapped[0].length);
    if (inner === "exec /bin/bash -i -l") return { cmd: "/bin/bash", args: ["-i", "-l"] };
    return { cmd: "/bin/bash", args: ["-l", "-c", inner] };
  }
  if (command.startsWith("bash -c "))
    return { cmd: "/bin/bash", args: ["-l", "-c", command.slice(8)] };
  if (command === "/bin/bash -i -l") return { cmd: "/bin/bash", args: ["-i", "-l"] };
  const [cmd = "", ...args] = command.split(" ");
  return { cmd, args };
}

/** What `commandAs` puts before the script, as the joined command line shows it. */
const AS_USER = /^sudo -n -E -H -u [^ ]+ -- \/bin\/bash -c (?:cd ~ 2>\/dev\/null\n)?/;

/** One `sh -c` script as `user`, with its arguments passed apart, never
 * pasted into the script. */
function script(user: string, text: string, ...args: string[]): string[] {
  return ["sudo", "-n", "-u", user, "--", "/bin/sh", "-c", text, "sh", ...args];
}

/** Each entry `find -printf` prints: eight fields, each ended by NUL. */
const FIELDS = "%y\\0%s\\0%m\\0%u\\0%g\\0%T@\\0%p\\0%l\\0";
const TYPES: Record<string, FileEntry["type"]> = { f: "file", d: "directory", l: "symlink" };

function entries(output: string): FileEntry[] {
  const fields = output.split("\0");
  const out: FileEntry[] = [];
  for (let i = 0; i + 8 <= fields.length; i += 8) {
    const [kind, size, mode, owner, group, mtime, path, link] = fields.slice(i, i + 8) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    out.push({
      name: path.split("/").filter(Boolean).pop() ?? path,
      path,
      type: TYPES[kind] ?? "other",
      size: Number(size) || 0,
      mode: `0${mode}`,
      modifiedAt: new Date(Math.round(Number(mtime) * 1000)).toISOString(),
      owner,
      group,
      ...(kind === "l" && link ? { symlinkTarget: link } : {}),
    });
  }
  return out;
}

/** E2B's file calls as another Linux user: each one a short script run with
 * `sudo -u`, since Runtime's file API acts as the sandbox's own user. Output
 * streams, so a read of any size comes back whole. */
export class FilesAs {
  constructor(
    private readonly ctx: SandboxContext,
    private readonly user: string,
    private readonly options: RequestOptions,
  ) {}

  async #run(argv: string[], stdin?: string) {
    const result = await guard("sandbox", () =>
      this.ctx.runtime.exec(argv, {
        ...(stdin === undefined ? {} : { stdin }),
        // A callback makes the exec stream, so its output is never cut.
        onStdout: () => undefined,
        ...signalOf(this.options),
      }),
    );
    if (result.stdoutTruncated)
      throw new SandboxError("Part of the answer was lost on the way; try again.");
    return result;
  }

  #fail(path: string, result: { exitCode: number | null; stderr: string }): never {
    if (result.exitCode === MISSING) throw new FileNotFoundError(`${path} does not exist.`);
    if (result.exitCode === NOT_DIRECTORY)
      throw new InvalidArgumentError(`${path} is not a directory.`);
    if (result.exitCode === IS_DIRECTORY) throw new InvalidArgumentError(`${path} is a directory.`);
    throw new SandboxError(
      `As the user "${this.user}": ${result.stderr.trim() || `exit status ${result.exitCode}`}`,
    );
  }

  async read(path: string): Promise<Uint8Array> {
    const result = await this.#run(
      script(
        this.user,
        `[ -e "$1" ] || exit ${MISSING}; [ -d "$1" ] && exit ${IS_DIRECTORY}; exec base64 -w 0 -- "$1"`,
        path,
      ),
    );
    if (result.exitCode !== 0) this.#fail(path, result);
    return Uint8Array.from(atob(result.stdout.trim()), (c) => c.charCodeAt(0));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    let text = "";
    for (let i = 0; i < bytes.length; i += 32_768)
      text += String.fromCharCode(...bytes.subarray(i, i + 32_768));
    const encoded = btoa(text);
    let offset = 0;
    do {
      const chunk = encoded.slice(offset, offset + WRITE_CHUNK);
      const result = await this.#run(
        script(
          this.user,
          offset === 0
            ? `mkdir -p -- "$(dirname -- "$1")" && base64 -d > "$1"`
            : `base64 -d >> "$1"`,
          path,
        ),
        chunk,
      );
      if (result.exitCode !== 0) this.#fail(path, result);
      offset += WRITE_CHUNK;
    } while (offset < encoded.length);
  }

  async list(path: string, depth: number): Promise<FileEntry[]> {
    const result = await this.#run(
      script(
        this.user,
        `[ -e "$1" ] || exit ${MISSING}; [ -d "$1" ] || exit ${NOT_DIRECTORY}; ` +
          `exec find "$1" -mindepth 1 -maxdepth "$2" -printf '${FIELDS}'`,
        path,
        String(depth),
      ),
    );
    if (result.exitCode !== 0) this.#fail(path, result);
    return entries(result.stdout);
  }

  async stat(path: string): Promise<FileEntry> {
    const result = await this.#run(
      script(
        this.user,
        `[ -e "$1" ] || [ -L "$1" ] || exit ${MISSING}; exec find "$1" -maxdepth 0 -printf '${FIELDS}'`,
        path,
      ),
    );
    if (result.exitCode !== 0) this.#fail(path, result);
    const [entry] = entries(result.stdout);
    if (!entry) throw new FileNotFoundError(`${path} does not exist.`);
    return entry;
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.#run(script(this.user, `[ -e "$1" ] || [ -L "$1" ]`, path));
    return result.exitCode === 0;
  }

  /** False when it was there already. */
  async makeDir(path: string): Promise<boolean> {
    const result = await this.#run(
      script(this.user, `[ -d "$1" ] && exit ${EXISTS}; mkdir -p -- "$1"`, path),
    );
    if (result.exitCode === EXISTS) return false;
    if (result.exitCode !== 0) this.#fail(path, result);
    return true;
  }

  async rename(from: string, to: string): Promise<void> {
    const result = await this.#run(
      script(
        this.user,
        `[ -e "$1" ] || [ -L "$1" ] || exit ${MISSING}; mv -fT -- "$1" "$2"`,
        from,
        to,
      ),
    );
    if (result.exitCode !== 0) this.#fail(from, result);
  }

  async remove(path: string): Promise<void> {
    const result = await this.#run(script(this.user, `rm -rf -- "$1"`, path));
    if (result.exitCode !== 0) this.#fail(path, result);
  }
}
