import { NotSupportedError } from "./errors.js";

/* What every part of the adapter shares: where Blaxel's paths land on
   Runtime, the sandbox's environment file, and the shell line each Blaxel
   process runs in. */

/** Blaxel's stock images work in /blaxel (WORKDIR and HOME); Runtime's in
 * /workspace. */
export const HOME = "/blaxel";
export const RUNTIME_HOME = "/workspace";

/** The sandbox's envs, kept on the sandbox itself so every process sees them,
 * from any client. Readable by the sandbox user, writable only with sudo. */
export const ENV_FILE = "/etc/runtime-blaxel/env";

/** A Blaxel path as the Runtime path it stands for: relative paths, `~` and
 * `/blaxel` resolve against /workspace, as they resolve against /blaxel on
 * Blaxel; any other absolute path is itself. */
export function toRuntimePath(path: string): string {
  let absolute = path.replace(/\/{2,}/g, "/");
  if (absolute === "~" || absolute.startsWith("~/")) absolute = HOME + absolute.slice(1);
  if (!absolute.startsWith("/")) {
    const relative = absolute.replace(/^(\.\/)+/, "").replace(/^\.$/, "");
    absolute = relative ? `${HOME}/${relative}` : HOME;
  }
  const normal = normalize(absolute);
  if (normal === HOME || normal.startsWith(`${HOME}/`))
    return RUNTIME_HOME + normal.slice(HOME.length);
  return normal;
}

/** A Runtime path as Blaxel code expects to see it: /workspace is /blaxel. */
export function toBlaxelPath(path: string): string {
  if (path === RUNTIME_HOME || path.startsWith(`${RUNTIME_HOME}/`))
    return HOME + path.slice(RUNTIME_HOME.length);
  return path;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Single-quoted for bash: any text, taken literally. */
export function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
function unquote(text: string): string {
  return text.replace(/'\\''/g, "'");
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Refuses an env name no process could receive. */
export function checkEnvNames(names: Iterable<string>): void {
  for (const name of names)
    if (!IDENTIFIER.test(name))
      throw new NotSupportedError(
        `The environment variable name "${name}"`,
        "Use a name of letters, digits and underscores that does not start with a digit.",
      );
}

/** The env file's lines: each exports its variable unless the process was
 * given its own value (named in RUNTIME_BLAXEL_KEEP), so a process's `env`
 * wins over the sandbox's, as in Blaxel. Lines stand alone, so a fork's
 * envs are appended after the source's and win. */
export function envFileLines(envs: Record<string, string>): string {
  checkEnvNames(Object.keys(envs));
  return Object.entries(envs)
    .map(
      ([name, value]) =>
        `case ":\${RUNTIME_BLAXEL_KEEP-}:" in *:${name}:*) ;; *) export ${name}=${quote(value)} ;; esac\n`,
    )
    .join("");
}

/** The envs an env file holds; later lines win, as when it is sourced. */
export function parseEnvFile(text: string): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const [, name, value] of text.matchAll(
    /\*\) export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)' ;; esac/g,
  ))
    envs[name!] = unquote(value!);
  return envs;
}

/** Writes the env file (replacing it, or appending to it): one command, with
 * the content on standard input so no value appears in a command line. */
export function envFileCommand(append: boolean): string[] {
  const script = append
    ? `sudo mkdir -p /etc/runtime-blaxel && sudo sh -c 'cat >> ${ENV_FILE}' && sudo chgrp "$(id -g)" ${ENV_FILE} && sudo chmod 0640 ${ENV_FILE}`
    : `sudo install -D -m 0640 -g "$(id -g)" /dev/stdin ${ENV_FILE}`;
  return ["bash", "-c", script];
}

const MARK = ": rt-blaxel";
/** Marks a keepAlive process's command line, so any client can tell whether
 * one still runs before it gives the sandbox its idle pause back. */
export const KEEP_MARK = ": rt-blaxel-keep";

/** How a Blaxel process becomes root, as on Blaxel: the sandbox user's shell
 * hands over to sudo (passwordless in Runtime's image), keeping every
 * variable, the sandbox user's PATH (sudo's secure_path would drop
 * /workspace/.local/bin) and HOME. `exec` leaves no extra shell: a signal to
 * the process reaches sudo, which Runtime ends with the whole process tree
 * (checked 27 September 2026: SIGTERM exits -15, SIGKILL is killed -9, and
 * no process of the command is left). */
const AS_ROOT = 'export __rt_cmd; exec sudo -E env "PATH=$PATH" "HOME=$HOME" bash -c';

/** The shell line a Blaxel process runs as. The Python adapter writes the
 * same line, byte for byte, so either reads what the other started:
 *
 *   : rt-blaxel '<name>'; [: rt-blaxel-keep; ]export HOST="${HOST:-0.0.0.0}";
 *   [ -r /etc/runtime-blaxel/env ] && . /etc/runtime-blaxel/env;
 *   unset RUNTIME_BLAXEL_KEEP; [{ [ -e /blaxel ] || sudo ln -s /workspace
 *   /blaxel; } 2>/dev/null; ]__rt_cmd='<command>'; export __rt_cmd; exec sudo
 *   -E env "PATH=$PATH" "HOME=$HOME" bash -c '<run>'
 *
 * joined with "; " on one line, where <run> is `eval "$__rt_cmd"`, or the
 * restart loop below. Quotes are single, with ' written '\''. */
export function processLine(
  command: string,
  options: { name: string; maxRestarts?: number; linkHome?: boolean; keepAlive?: boolean },
): string {
  // Runtime keeps the first 256 characters of a command line: the name and
  // the keepAlive mark come first, so a long command costs only its own tail.
  const prelude = [
    `${MARK} ${quote(options.name)}`,
    ...(options.keepAlive ? [KEEP_MARK] : []),
    'export HOST="${HOST:-0.0.0.0}"',
    `[ -r ${ENV_FILE} ] && . ${ENV_FILE}`,
    "unset RUNTIME_BLAXEL_KEEP",
    ...(options.linkHome
      ? [`{ [ -e ${HOME} ] || sudo ln -s ${RUNTIME_HOME} ${HOME}; } 2>/dev/null`]
      : []),
    `__rt_cmd=${quote(command)}`,
  ];
  if (options.maxRestarts === undefined)
    return [...prelude, `${AS_ROOT} ${quote('eval "$__rt_cmd"')}`].join("; ");
  const limit = options.maxRestarts < 0 ? "unlimited" : String(options.maxRestarts);
  // Blaxel's restart loop: a failed run starts again, up to maxRestarts times
  // (negative is unlimited), with the same note in the output.
  const loop =
    `__rt_n=0; while :; do ( eval "$__rt_cmd" ); __rt_c=$?; [ $__rt_c -eq 0 ] && exit 0; ` +
    `${options.maxRestarts < 0 ? "" : `[ $__rt_n -ge ${options.maxRestarts} ] && exit $__rt_c; `}` +
    `__rt_n=$((__rt_n+1)); printf '\\n[Process failed with exit code %d. Attempting restart %d/%s...]\\n' $__rt_c $__rt_n '${limit}'; done`;
  return [...prelude, `${AS_ROOT} ${quote(loop)}`].join("; ");
}

/** The Blaxel name and command of a process this adapter started, from the
 * command Runtime recorded (cut at 256 characters: a long command is cut
 * too, its name kept); undefined for any other process. */
export function parseProcessLine(
  line: string,
): { name: string; command: string; keepAlive: boolean } | undefined {
  const name = /: rt-blaxel '((?:[^']|'\\'')*)'/.exec(line);
  if (!name) return undefined;
  const whole = /__rt_cmd='((?:[^']|'\\'')*)'/.exec(line);
  const partial = /__rt_cmd='(.*)$/.exec(line);
  const command = whole ? whole[1]! : partial ? partial[1]!.replace(/'\\?'?$/, "") : "";
  return {
    name: unquote(name[1]!),
    command: unquote(command),
    keepAlive: line.includes(`${KEEP_MARK};`),
  };
}

/** A time as Blaxel's sandbox API writes it: "Mon, 02 Jan 2006 15:04:05 GMT". */
export function httpDate(time: string | number | Date | null | undefined): string {
  if (time === null || time === undefined || time === "") return "";
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? "" : date.toUTCString();
}

/** A random name, as Blaxel gives an unnamed process. */
export function randomName(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  let name = "";
  for (let i = 0; i < 8; i++) name += letters[Math.floor(Math.random() * letters.length)];
  return name;
}
