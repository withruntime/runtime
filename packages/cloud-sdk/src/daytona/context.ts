import type { RuntimeSandbox } from "./client.js";

/** What a sandbox's modules (process, fs, git, code interpreter) share. */
export interface SandboxContext {
  /** The Runtime sandbox, with its lease renewed if this call is activity
   * that should keep it running (autoStopInterval). */
  live(): Promise<RuntimeSandbox>;
  /** Environment given at create (envVars) or with updateEnv. */
  readonly env: Record<string, string>;
  /** The language of `process.codeRun`: python, javascript or typescript. */
  readonly language: string;
  /** Makes /home/daytona (Daytona's home) lead to /workspace (Runtime's),
   * once, the first time something names it. */
  ensureHome(text: string | undefined): Promise<void>;
  /** The Linux user commands run as (create's `user`), when not the owner. */
  readonly user?: string;
}

/** Daytona's home, and the working directory relative paths resolve from. */
export const DAYTONA_HOME = "/home/daytona";
/** Runtime's. */
export const HOME = "/workspace";
export const HOME_LINK = `[ -e ${DAYTONA_HOME} ] || sudo ln -s ${HOME} ${DAYTONA_HOME}`;
/** Commands without a timeout run until the sandbox ends: Runtime's longest. */
export const LONGEST_MS = 86_400_000;
/** Given to exec so it streams and returns the whole output, as Daytona does:
 * an exec with no output callback returns at most 64 KiB of each stream. */
export const WHOLE_OUTPUT = { onStdout: () => undefined } as const;

/** A Daytona path as a Runtime one: relative paths (and `~`) resolve from the
 * working directory, /workspace on Runtime. */
export function resolvePath(path: string): string {
  if (path === "~" || path === "") return HOME;
  if (path.startsWith("~/")) return `${HOME}/${path.slice(2)}`;
  if (path.startsWith("/")) return path;
  // Only "." components are dropped: ".env" and "..x" keep their dots.
  return `${HOME}/${path.replace(/^(?:\.(?:\/+|$))+/, "")}`.replace(/\/+$/, "") || HOME;
}

/** Quotes a word for bash. */
export function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A command and its environment as Runtime runs them: as given for the
 * sandbox owner; for another user through sudo, its environment carried on
 * the command line (sudo resets it) and umask 002, so files it makes in the
 * shared working directory stay writable by the owner's group. */
export function runAs(
  user: string | undefined,
  argv: readonly string[],
  env: Record<string, string> = {},
): { argv: string[]; env?: Record<string, string> } {
  if (!user) return { argv: [...argv], ...(Object.keys(env).length ? { env } : {}) };
  return {
    argv: [
      "sudo",
      "-u",
      user,
      "-H",
      "--",
      "env",
      ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
      "sh",
      "-c",
      'umask 002; exec "$@"',
      "sh",
      ...argv,
    ],
  };
}
