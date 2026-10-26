#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkBrowserOrigins,
  connectionOrigins,
  connectionStore,
  resolveCredential,
} from "./credentials.js";
import { me, named } from "./cli-name.js";
import { Runtime } from "./client.js";
import { Sandbox as SandboxHandle, type Sandbox } from "./sandbox.js";
import { NotFoundError, RuntimeError } from "./errors.js";
import { NETWORK_PRODUCTS, networkProductCommand, type NetworkProduct } from "./network-cli.js";
import { billingCommand } from "./billing-cli.js";
import { cliRefusal, describeRecord, newestCpu, productWords, topicHelp } from "./cli-words.js";
import { envFetch } from "./proxy.js";
import { logStream, terminalSafe, terminalSafeLines } from "./terminal.js";
import { VERSION, type RequestOptions } from "./transport.js";
import type { CreateSandbox, FeedbackKind, OutOfMemory, SandboxInfo, Usage } from "./types.js";
import type {
  MetricRange,
  SandboxMetrics,
  UsageExportPage,
  WebhookEventType,
} from "./products/observability.js";
import type { SwitchingSummary, SwitchProvider } from "./products/switching.js";
import type { LimitedKeyAction } from "./products/api-keys.js";
import type { SecretRule, SecretScope, SecretUse } from "./products/secrets.js";
import type { Job, JobAlert, UpdateJob } from "./products/jobs.js";
import type { PlanNow } from "./products/plans.js";
import type { RoomBooking } from "./products/reservations.js";
import type { InterpreterLanguage } from "./products/interpreter.js";
import type { Image } from "./products/images.js";

/* runtime <product> <verb>, and account commands at the top level. */

type Out = {
  json: boolean;
  write: (text: string) => void;
  error: (text: string) => void;
  /** Wait when an output pipe cannot accept another page yet. */
  drain?: () => Promise<void>;
};
type Args = { positional: string[]; flags: Map<string, string[]>; rest: string[] | undefined };

/** A log stream's text (a sandbox process's, an image build's, a job run's)
 * as stdout shows it: escaped on a terminal unless --raw (terminal.ts). */
const logText = (args: Args) => (text: string) =>
  process.stdout.isTTY && !has(args, "raw") ? terminalSafeLines(text) : text;

const HELP = `Runtime Cloud CLI ${VERSION}

Usage: runtime <product> <command> [options]      runtime <command> [options]

Start
  sandboxes run [--keep] [create options] -- <command>
                                               A fresh sandbox runs one command, then is deleted

Account
  login [--agent-name <name>] [--no-browser] [--wait]
                                               Connect this machine (no key to copy)
  login --with-key                             Or paste a key from withruntime.com/account/keys
  billing topup <usd> --new-account --accept-terms [--wait]
                                               No person? Open an account paid in USDC
  logout                                       Revoke this machine's connection
  whoami                                       The organization and agent you act as
  account [ls]                                 The accounts this machine is connected to
  account switch <name|id>                     Use another of them for every command after
  account add                                  Connect another account (choose it in the browser)
  account close --confirm "<account name>"     Close the account for good (owner, key for every product)
  account emails [<category> on|off]           Your optional emails from Runtime: own-deletions, billing, usage, tips
  audit [--action member.] [--limit 50] [--before <next>]
                                               The account's audit log (owner or admin keys)
  sso                                          Single sign-on and SCIM directory sync (owner or
                                               admin keys); an owner changes it on the website
  usage [--csv]                                Balance, free usage and charges; --csv, each resource
  usage export --since <UTC time> --until <UTC time>
                                               Every settlement in the range as CSV; --json, each page
  limits                                       Whether this key is read-only, and its daily spending limit
  reservations book --sandboxes <n> --from <time> --to <time> [--vcpu <n>] [--memory <MiB>]
            [--disk <MiB>] [--region <r>]      Hold room for a burst: confirmed or declined at once
  reservations ls | get <id> | cancel <id>     Your bookings; cancel gives the room back
  secrets set <NAME> --host <host>... [--header <name> [--format '<text {value}>']]
            [--allow '[GET,HEAD] /path/*']...  Store a secret sandboxes use without seeing it; the
            [--only-label key=value[,k=v]]...  value is read from standard input, never an argument.
            [--only-sandbox <id>]...           --allow (paid): only these methods and paths get it.
            [--only-app <app id>]...           --only-label: only sandboxes with those labels (each
            [--all-sandboxes] [--env <VAR>]    flag one selector, any may match); --only-sandbox:
                                               only that sandbox; --only-app: every copy of that App,
                                               any version. A new value keeps the scope;
                                               --all-sandboxes gives it to every sandbox again.
                                               --env: the variable sandboxes see it in, if not NAME;
                                               secrets scoped to different sandboxes may share one
  secrets set <NAME> --keep-value [--host <host>]... [--allow '[GET] /path']...
                                               Narrow where it goes without its value: a subset of
                                               its hosts, only requests its rules allow now.
                                               Anything wider needs the value
  secrets set <NAME> --jobs [--host ...]       A copy scheduled jobs put in their environment
                                               (job create --secret NAME); with --host, both
  secrets scope <NAME> --only-label k=v... | --only-sandbox <id>... | --only-app <id>... | --all-sandboxes
                                               Change which sandboxes get it; no value needed
  secrets ls [--limit N] [--after NAME] | get <NAME>
                                               Names, hosts, placeholders and jobs versions, never values;
                                               by name, a page of N after NAME
  secrets rotate <NAME>                        A new version of the jobs copy, from standard input
  secrets reveal <NAME> [--version N]          Print the jobs copy's value. The sandboxes' copy is
                                               never readable, by anyone
  secrets share <NAME> --agent <id>... | --all | --none
                                               Which of your keys may use the jobs copy besides the one
                                               that stored it (ids: from 'me'); --all: every key
  secrets rm <NAME>                            Delete a secret, every copy
  keys create [--name <name>] [--read-only] [--daily-limit <usd>] [--account-wide]
                                               A new API key for CI, approved by an owner in the browser
  referrals                                    Your referral link: you both get up to $1,000, then
                                               you earn 10% of what they spend for 12 months
  plans                                        The plans you can choose and yours: a monthly fee
                                               that comes back as usage, spent first (beta)
  plans choose <plan> [--yearly] | cancel | resume
                                               Start or change a plan (a first one opens a payment
                                               page), end it at the period's end, or keep it (beta)
  plans add-on <id> | remove-add-on <id>       Add an add-on to the plan, or stop one (beta)
  plans auto-upgrade on|off                    Move up a plan by itself when a limit refuses (beta)
  compare --from <provider> [--days 30]        What your usage would cost at e2b, daytona, vercel,
                                               modal, cloudflare, fly, blaxel, lambda-microvms,
                                               freestyle, prime and others, and what you save
  switch [--from <provider>]                   Moving from e2b, daytona, vercel, modal, cloudflare, fly
                                               or blaxel: record it before your first top-up.
                                               Credit you add within 30 days of signing up is
                                               matched, up to $1,000 in total
  ls                                           Everything you run, every product
  feedback "<text>" [--kind bug|missing_feature|competitor_gap|migration_blocker|docs|pricing|praise|other]
                   [--detail <text>] [--competitor <name>] [--request-id <req_...>]
  feedback --list                              What you reported, and what happened to it
  support "<message>" [--conversation <id>]    Ask Runtime support; read, approve, deny below
  support read <conversationId>
  support approve <actionId> <inputHash> --conversation <id>
  support deny <actionId> --conversation <id>
  docs [topic]                                 Print a docs page (start, cli, api, python...)
  mcp                                          Serve MCP on stdio for agents that need it
  fly-api [--port 4280]                        Answer Fly Machines API calls here, with Runtime sandboxes

Connect
  sandboxes ssh <id|name> [-- <command...>]    Log in over SSH; \`runtime sandboxes ssh help\` for editors
  sandboxes ssh config [--install]             Make \`ssh <id|name>.runtime\` work (VS Code, JetBrains)
  sandboxes code <id|name> [--editor vscode|cursor|windsurf]
                                               Open it in VS Code, Cursor or Windsurf over SSH
  sandboxes port-forward <id|name> <port|local:remote>...
                                               Forward local ports to ports in a sandbox

Observability
  sandboxes metrics <id> [--range 1h]          CPU and memory over time (15m 1h 6h 24h 7d 30d)
  events [--sandbox <id>] [--type <type>]      Lifecycle events, newest first
  webhooks ls | create <url> [--events a,b] | test <id> | deliveries <id>
           | update <id> [--url u] [--events a,b] [--enable|--disable]
           | rotate-secret <id> [--keep <seconds>] | retry <deliveryId> | rm <id>
                                               Signed lifecycle events POSTed to your URL
  otel ls | create <endpoint> [--header K=V]... [--signals logs,metrics] | flush <id> | rm <id>
                                               Events and metrics to an OpenTelemetry endpoint

Products
  sandboxes  Linux microVMs: exec, shell, files, code, previews, network, desktop, browser
  snapshots  Saved sandboxes, disk and memory, to start or fork from
  images     Custom images from a Dockerfile, any public or private image, or a package list
  volumes    Persistent disks to attach to sandboxes
  jobs       A command in a fresh sandbox, once or on a cron schedule, with its logs
  apps       Your web server from an image or a build, copies started by requests (beta)
  functions  Your HTTP handler from an image or a build, asleep until calls come (beta)
  builds     A connected repository's commits built into what an App deploys (beta)
  ci         CI/CD: each push and pull request of a repository checked in sandboxes (beta)
  containers One OCI image's process on its own microVM, at the sandbox rates (beta)
  browsers   Chromium on its own sandbox: a CDP address and screenshots (beta)
  desktops   A Linux desktop on its own sandbox: live view, computer use (beta)
  agents     Claude Code, Codex, Gemini CLI or your own agent in a sandbox per session (beta)
  domains    Your own hostname for a sandbox's port, with HTTPS
  ports      A public TCP port to a sandbox: databases, game servers
  ips        A dedicated outbound address, for allow-lists
  networks   Your networks: a WireGuard tunnel in, your own proxy out, sandboxes reaching
             each other by name
  Each has its own help: \`runtime sandboxes help\`, \`runtime images help\`...
  The singular (\`runtime sandbox\`) is a shortcut for the same product.

Every command takes --json. Keys: RUNTIME_API_KEY, or the connection from \`runtime login\`.
Behind a proxy: HTTPS_PROXY and NO_PROXY are read, on Node and Bun alike.
`;

const SANDBOX_HELP = `runtime sandboxes <command>

  Every <id> below can also be the sandbox's name.

  run [--keep] [--root] [create options] -- <command>         A fresh sandbox runs one command, then is deleted
  ssh <id|name> [-- <command...>] | ssh config [--install]    Log in over SSH, also from VS Code and JetBrains
  code <id|name> [--editor vscode|cursor|windsurf] [--path /workspace] [--print]
                                                              Open it in your editor over SSH, in one step
  port-forward <id|name> <port|local:remote>...               Forward local ports to ports in it
  create [--name n] [--label k=v]... [--env K[=V]]... [--vcpu 2] [--memory 4096] [--disk 4096]
         [--cpu shared|reserved] [--cpu-floor <thousandths>] [--max-cost <usd>] [--max-total-cost <usd>]
         [--timeout <60-86400>] [--on-timeout pause|stop|delete] [--no-wait]
         [--no-internet] [--allow <host>]... [--deny <host>]... [--connect <host:port>]...
         [--image <name:tag|imageId> | --snapshot <snapshotId>] [--volume <volumeId>:/data[:snapshot]]...
         [--spread-from <id>]... [--secret NAME]... [--no-secrets]
         [--idle-pause <seconds>] [--no-auto-wake] [--persistent] [--get-or-create]
         [--user root|sandbox]                                --user root: its commands, processes and
                                                              shells run as root unless one says otherwise
                                                              Create one; prints its id
  ls [--all] [--label k=v]... [--state running]               List (live ones unless --all)
  get <id>                                                    One sandbox, in full
  exec <id> [--cwd /workspace] [--env K[=V]]... [--timeout <s>] [--root]
       [--trace-files <file.json>] -- <command...>
                                              Run and stream output; exits with its code.
                                              --root runs it as root: no sudo needed
  spawn <id> [--pty] [--root] -- <command...> Start in the background; prints a process id
  ps <id>                                     Running and recent processes
  logs <id> <processId> [-f] [--raw]          A process's output so far; -f follows it to the end;
                                              on a terminal control characters show as \\uXXXX
                                              unless --raw
  kill <id> <processId> [--signal SIGTERM]
  shell <id> [--command "bash -l"] [--root]   An interactive terminal
  cp <src> <dst>                              Copy files or directories; name a sandbox
                                              path as <id>:/path, e.g. cp ./app sbx:/workspace/app
  cat <id> <path>                             Print a file
  files <id> [path] [--depth 1] [--glob '**/*.py']
  stop <id> | pause <id> | wake <id> | restart <id>
  stop --label k=v [--label k=v]...           Stop every live sandbox with all those labels
  rm <id>                                     Delete it for good: stops it, deletes its disk and
                                              paused memory, revokes its previews; snapshots stay
  rm --label k=v [--label k=v]...             Delete for good every sandbox with all those labels,
                                              stopped ones too
  switch-image <id> <image> --keep-workspace  Move it to another image, keeping /workspace (your home),
                                              volumes, env and previews; processes restart, the rest of
                                              its disk is lost (snapshot it first to keep everything)
  resize <id> [--vcpu 2] [--memory 4096] [--disk 20480] --restart
                                              Change its size by a restart: the whole disk stays and
                                              --disk only grows it; programs stop (snapshot it first
                                              to keep memory)
  resize <id> --disk 20480                    Grow a running sandbox's disk live, programs running
  extend <id> <seconds>                       Move a time limit on (one with none needs nothing)
  update <id> [--name n] [--label k=v]... [--env K[=V]]... [--unset-env K]... [--idle-pause <seconds>] [--auto-wake on|off]
              [--persistent on|off] [--max-total-cost <usd>|none] [--user root|sandbox]
              [--timeout <60-86400 from now>|0] [--on-timeout pause|stop|delete]
                                              Change its settings; persistent keeps it running until stopped;
                                              --env K alone sends K's value from your own environment,
                                              so it is in no command line or shell history
  snapshot <id> [--name n] [--retention days|credit] Keep its whole machine; prints the snapshot id
  mount <id> <s3|r2|gcs>://<bucket>[/prefix] <path> [--secret NAME] [--region r]
        [--endpoint https://...] [--account-id id] [--read-only]
                                              Your bucket as a directory; the proxy signs, the sandbox never sees the key
  mounts <id> | unmount <id> <path>           Its bucket mounts; unmount one
  tailscale up <id> --auth-key-secret NAME [--hostname h] [--tag tag:x]...
                                              Join your tailnet (paid); the key is a secret set with --jobs
  tailscale status <id> | tailscale down <id> Its tailnet address; take it off the tailnet
  fork <id> [--count 3] [--name n] [--keep-snapshot] [--secret NAME]... [--no-secrets]
                                              Copies of it as it is now, running; prints their ids
  run-code <id> <file|-> [--lang python|javascript|typescript|r|java|bash|go] [--context c] [--out-dir .]
                                              Run a notebook-style cell; charts saved as PNG
  watch <id> <path> [--recursive] [--include <glob>]... [--exclude <glob>]... [--events create,write,remove,rename,chmod]
                                              Print file changes as they happen, until Ctrl-C
  mcp catalog                                 MCP servers a sandbox can run (licence, settings, hosts)
  mcp <id> start <server>... [--secret SERVER.SETTING=SECRET]... [--env SERVER.NAME=value]...
                             [--option SERVER.NAME=value]... [--port 8765] [--replace] [--public]
                                              Start them; prints each URL and the header to send
                                              (--public: URLs that never expire, paid only)
  mcp <id> [status] | mcp <id> stop           Their state and fresh URLs; stop them
  preview <id> <port> [--public] [--ttl <s>]  Share a port at an HTTPS address (--public: paid only)
  preview rotate <id> <port>                  Refuse every token given out for a private port so
                                              far; prints the new token
  previews <id>                               Every shared port
  link <id> <path> [--put] [--expires 1h] [--filename n] [--max-bytes n] [--archive] [--no-wake]
                                              A link anyone can open with no key: GET downloads the
                                              file (--archive: a folder as .tar.gz), --put uploads to it;
                                              --expires 60s to 7d, 1h by default
  link revoke <id>                            End every link made for the sandbox so far
  unshare <id> <port>                         Stop sharing a port
  session create <id> [--origin <url>]... [--ttl <s>] [--name <n>]
                                              A token a web page uses for this sandbox's commands,
                                              files and previews; printed once
  session ls <id> | session revoke <id> <session-id>
                                              Its sessions; end one now
  network <id> [--no-internet|--internet] [--allow <host>]... [--deny <host>]... [--connect <host:port>]...
                                              Show its network rules, or replace them
  identity-token --audience <aud> [--lifetime <seconds>]
                                              Inside a sandbox: an OIDC token naming it, for AWS,
                                              Google Cloud or your own API. Needs no API key
  metrics <id> [--range 15m|1h|6h|24h|7d|30d]
                                              CPU and memory over time, and the latest reading
  desktop <id> start | stop | screenshot [file.png] | open <url> | click <x> <y>
               | type <text> | press <keys> | windows
  desktop <id> record start [--fps 10] [--max-seconds 1800] [--max-mib 512] | record stop <recId>
               | record ls | record fetch <recId> [file.mp4] | record rm <recId>
  browser <id> start [--headed] [--width 1280] [--height 800] | get | stop
                                              Chromium for CDP agents: prints its cdpUrl

Examples
  id=$(runtime sandboxes create)
  runtime sandboxes cp ./invoice.py $id:/workspace/invoice.py
  runtime sandboxes exec $id -- python3 /workspace/invoice.py
  runtime sandboxes stop $id
`;

/** A command's options. Reading one its parse() did not declare is a bug in
 * this file, and says so, so a test that runs the command finds it. */
class Flags extends Map<string, string[]> {
  constructor(readonly known: ReadonlySet<string>) {
    super();
  }
  override get(name: string): string[] | undefined {
    this.#declared(name);
    return super.get(name);
  }
  override has(name: string): boolean {
    this.#declared(name);
    return super.has(name);
  }
  #declared(name: string): void {
    if (!this.known.has(name))
      throw new Error(`The CLI reads --${name}, which this command's parse() does not declare.`);
  }
}

/** A command's arguments: `booleans` are options that take no value, `values`
 * those that take one. Any other option is refused before anything is sent, so
 * `--memory-mib 8192` for `--memory` is a usage error with the right name, not a
 * sandbox created at the default size. Everything after `--` is `rest`. */
function parse(
  argv: string[],
  booleans: readonly string[],
  values: readonly string[],
  /** For a command that runs one: how to write it, so an option that belongs
   * to the command (`python3 -c ...`) is pointed after the `--`. */
  commandAfter?: string,
): Args {
  const known = new Set([...values, ...booleans]);
  const positional: string[] = [];
  const flags = new Flags(known);
  let rest: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length === 2 && !/^-\d/.test(arg))) {
      const [typed, inline] = arg.replace(/^-+/, "").split(/=(.*)/s, 2) as [
        string,
        string | undefined,
      ];
      // A plural of an option is the option once per comma: --hosts a,b is
      // --host a --host b (13 October 2026: a user's first try at a secret).
      const plural =
        !known.has(typed) &&
        typed.endsWith("s") &&
        LISTS.has(typed.slice(0, -1)) &&
        known.has(typed.slice(0, -1));
      const name = plural ? typed.slice(0, -1) : typed;
      if (!known.has(name))
        throw commandAfter && !meantOption(name, known)
          ? usage(
              `Unknown option ${arg.split("=")[0]}. If it belongs to the command, put the command after --: ${commandAfter}`,
            )
          : unknownOption(name, known);
      const boolean = booleans.includes(name);
      const value = inline ?? (boolean ? "true" : argv[++i]);
      if (
        value === undefined ||
        (!boolean && inline === undefined && (value === "--" || /^--?[^\d]/.test(value)))
      )
        throw usage(`--${name} needs a value.`);
      if (boolean && value !== "true" && value !== "false")
        throw usage(`--${name} takes true or false.`);
      const values = plural ? value.split(",").filter(Boolean) : [value];
      flags.set(name, [...(flags.get(name) ?? []), ...values]);
    } else positional.push(arg);
  }
  return { positional, flags, rest };
}

/** Options given once per item, which a plural takes as a comma list. */
const LISTS: ReadonlySet<string> = new Set(["host", "allow", "deny", "connect", "snapshot"]);

/** The declared option a mistyped one most likely meant. --memory-mib for
 * --memory, --timeout-seconds for --timeout: the SDK's spelling of an option is
 * the CLI's with its unit added. */
function meantOption(name: string, known: ReadonlySet<string>): string | undefined {
  return (
    [...known].find((option) => name.startsWith(`${option}-`) || option.startsWith(`${name}-`)) ??
    closest(name, [...known])
  );
}
/** "Unknown option --x", the one that was likely meant, and the ones there are. */
function unknownOption(name: string, known: ReadonlySet<string>): RuntimeError {
  const dash = (option: string) => (option.length === 1 ? `-${option}` : `--${option}`);
  const meant = meantOption(name, known);
  const options = [...known].filter((option) => option.length > 1).map(dash);
  return usage(
    `Unknown option ${dash(name)}.${meant ? ` Did you mean ${dash(meant)}?` : ""}${
      options.length
        ? ` This command takes ${options.join(", ")}.`
        : " This command takes no options."
    }`,
  );
}
const flag = (args: Args, name: string) => args.flags.get(name)?.at(-1);
const has = (args: Args, name: string) => args.flags.get(name)?.at(-1) === "true";
/** Days, or the word `credit` for null: kept while the account has credit. */
const daysOrCredit = (args: Args, name: string): number | null | undefined =>
  flag(args, name) === "credit" ? null : integer(args, name);
const integer = (args: Args, name: string) => {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw usage(`--${name} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw usage(`--${name} is too large to represent exactly.`);
  return parsed;
};
/** A flag that takes one of a few words, checked before anything is sent. */
function oneOf<T extends string>(args: Args, name: string, choices: readonly T[]): T {
  const value = flag(args, name);
  if (!choices.includes(value as T)) throw usage(`--${name} takes ${choices.join(" or ")}.`);
  return value as T;
}
const pairs = (args: Args, name: string) =>
  Object.fromEntries(
    (args.flags.get(name) ?? []).map((pair) => {
      const at = pair.indexOf("=");
      if (at < 1) throw usage(`--${name} takes KEY=VALUE.`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
/** --env KEY=VALUE, or --env KEY alone to take KEY's value from the CLI's own
 * environment, as docker run -e does: the value stays out of the process's
 * arguments and the shell's history. */
const envPairs = (args: Args, from: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    (args.flags.get("env") ?? []).map((pair) => {
      const at = pair.indexOf("=");
      if (at > 0) return [pair.slice(0, at), pair.slice(at + 1)];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair))
        throw usage(
          `--env takes KEY=VALUE, or KEY alone to send KEY's value from your environment.`,
        );
      const value = from[pair];
      if (value === undefined)
        throw usage(`--env ${pair} sends ${pair} from your environment, and it is not set there.`);
      return [pair, value];
    }),
  );

/** What the commands in cli-extras.ts use of this file. */
export const kit = {
  parse: (argv: string[], booleans: readonly string[], values: readonly string[]) =>
    parse(argv, booleans, values),
  flag,
  has,
  integer,
  pairs,
  envPairs,
  need: (value: string | undefined, what: string) => need(value, what),
  table: (rows: string[][]) => table(rows),
  usage: (message: string) => usage(message),
  unknown: (what: string, word: string, choices: readonly string[]) => unknown(what, word, choices),
  /** `sandboxes exec`'s run and output, for any machine that execs. */
  execute: (
    machine: Pick<Sandbox, "id" | "exec">,
    command: string[],
    args: Args,
    out: Out,
    env: NodeJS.ProcessEnv,
  ) => execute(machine, command, args, out, integer(args, "timeout"), env),
  copyFile: (
    from: string,
    to: string,
    use: (id: string) => Promise<Pick<Sandbox, "files">>,
    side: string,
  ) => copyFile(from, to, use, side),
};
export type CliKit = typeof kit;

/** The product being run, so a mistake points at its own help. */
let product = "";
/** `90`, `90s`, `30m`, `1h` or `7d`, in seconds. */
function durationSeconds(text: string): number {
  const found = /^(\d{1,7})([smhd]?)$/.exec(text.trim());
  if (!found) throw usage(`--expires takes a number of seconds or 30m, 1h, 7d; not ${text}.`);
  return Number(found[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }[found[2]!]!;
}

function usage(message: string) {
  return new RuntimeError({
    message,
    code: "usage",
    status: 0,
    hint: product ? `Run \`${me} ${product} help\`.` : `Run \`${me} help\`.`,
  });
}
/** "Unknown command X." and, when one is close, the command that was meant. */
function unknown(what: string, word: string, choices: readonly string[]) {
  const meant = closest(word, choices);
  return usage(`Unknown ${what} ${word}.${meant ? ` Did you mean ${meant}?` : ""}`);
}
/** The choice a mistyped word most likely meant, or none when nothing is close:
 * one edit away (a swap of two letters counts as one), or two for a word longer
 * than five letters, so "exce" finds exec and "bogus" finds nothing. */
function closest(word: string, choices: readonly string[]): string | undefined {
  const distance = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
          d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    return d[a.length]![b.length]!;
  };
  const best = choices
    .map((choice) => [choice, distance(word, choice)] as const)
    .sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= (word.length > 5 ? 2 : 1) ? best[0] : undefined;
}
const COMMANDS = [
  "account",
  "audit",
  "login",
  "logout",
  "whoami",
  "usage",
  "billing",
  "limits",
  "sso",
  "secrets",
  "keys",
  "reservations",
  "referrals",
  "plans",
  "compare",
  "switch",
  "ls",
  "feedback",
  "support",
  "docs",
  "mcp",
  "fly-api",
  "sandboxes",
  "snapshots",
  "images",
  "volumes",
  "jobs",
  "apps",
  "functions",
  "builds",
  "ci",
  "containers",
  "browsers",
  "desktops",
  "agents",
  "domains",
  "ports",
  "ips",
  "networks",
  "webhooks",
  "otel",
  "events",
  "help",
  "version",
];
/** Commands with a help of their own: `runtime <command> help`. */
const OWN_HELP = [
  "sandboxes",
  "sbx",
  "snapshots",
  "images",
  "volumes",
  "jobs",
  "apps",
  "functions",
  "builds",
  "ci",
  "containers",
  "browsers",
  "desktops",
  "agents",
  "keys",
  "reservations",
  "webhooks",
  "webhook",
  "billing",
  "domains",
  "ports",
  "ips",
  "networks",
];
/** Sandbox commands that once sat at the top level. */
const SANDBOX_MOVED = ["run", "ssh", "port-forward", "forward"];
const SANDBOX_VERBS = [
  "run",
  "ssh",
  "code",
  "port-forward",
  "create",
  "ls",
  "get",
  "stop",
  "rm",
  "delete",
  "switch-image",
  "resize",
  "pause",
  "wake",
  "restart",
  "snapshot",
  "mount",
  "mounts",
  "unmount",
  "tailscale",
  "fork",
  "extend",
  "update",
  "exec",
  "spawn",
  "ps",
  "logs",
  "kill",
  "shell",
  "cat",
  "files",
  "cp",
  "run-code",
  "preview",
  "previews",
  "link",
  "unshare",
  "session",
  "network",
  "desktop",
  "browser",
  "metrics",
  "watch",
  "mcp",
  "identity-token",
];
function need(value: string | undefined, what: string): string {
  if (!value) throw usage(`Give ${what}.`);
  return value;
}
/** A port from the command line: a whole number from 1 to 65535, checked
 * before any call so a typo is a usage error, not a 404 from the API. */
function portOf(value: string | undefined, example: string): number {
  const port = Number(need(value, `a port, e.g. ${example}`));
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw usage(`${value} is not a port: give a whole number from 1 to 65535, e.g. ${example}.`);
  return port;
}

/** The client, with the key from RUNTIME_API_KEY or this machine's saved
 * connection. With neither, the first command connects the machine first (a
 * browser approval, nothing to copy) and then does what was asked, so setup
 * is not a separate step. CI, or RUNTIME_NO_LOGIN, answers missing_api_key. */
/** The approval was asked for and not given yet: say where, and that running
 * the same command again picks it up. */
function notApprovedYet(login: { url?: string; userCode?: string }) {
  return new RuntimeError({
    message: `Not connected yet. Open ${login.url}, check the code ${login.userCode} and choose Connect agent.`,
    code: "connection_pending",
    status: 0,
    hint: "Once it is approved, run the same command again: it picks up this approval, with no new link.",
  });
}
async function client(env: NodeJS.ProcessEnv): Promise<Runtime> {
  let apiKey: string;
  try {
    apiKey = await resolveCredential(env);
  } catch (error) {
    if (
      !(error instanceof RuntimeError) ||
      error.code !== "missing_api_key" ||
      env.CI ||
      env.RUNTIME_NO_LOGIN
    )
      throw error;
    process.stderr.write("This machine is not connected to Runtime yet. Connecting it first.\n");
    const { authenticationCommand } = await import("./login.js");
    const login = await authenticationCommand(["login"], env);
    if (login.pending) throw notApprovedYet(login);
    apiKey = await resolveCredential(env);
  }
  return new Runtime({ apiKey, baseUrl: env.RUNTIME_API_URL, maxRetries: 4 });
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
/** When a sandbox ends by itself (0300, 0381). A paid-ahead lease, expiresAt,
 * is not its time limit; only an older server, which sends no endsAt, gives
 * the end of a limited sandbox's time as expiresAt. */
function sandboxEnd(info: SandboxInfo): string {
  if (info.endsAt === null || (info.endsAt === undefined && !info.timeoutSeconds))
    return "no limit";
  return info.endsAt ?? info.expiresAt ?? "-";
}
function describe(info: SandboxInfo): string {
  return table([
    ["id", info.id],
    ["name", info.name ?? "-"],
    ["state", info.state],
    [
      "shape",
      `${info.vcpu} vCPU, ${info.memoryMiB} MiB memory, ${info.diskMiB} MiB disk (${info.cpu})`,
    ],
    ["region", info.region],
    ["time limit", info.timeoutSeconds ? `${info.timeoutSeconds} s` : "none"],
    ["ends", sandboxEnd(info)],
    ["at its end", info.onLeaseEnd ?? "-"],
    // Why a sandbox is no longer running (troubleshooting.md, "A sandbox
    // stopped on its own"); `get` left both out until 30 September 2026.
    ...(info.pausedAt ? [["paused at", info.pausedAt]] : []),
    ...(info.endedAt ? [["ended", info.endedAt]] : []),
    ...(info.stopReason ? [["stop reason", info.stopReason]] : []),
    ["auto wake", info.autoWake === false ? "off" : "on"],
    ["runs as", info.user === "root" ? "root" : "sandbox user"],
    [
      "idle pause",
      info.idlePauseSeconds
        ? `${info.idlePauseSeconds} s${info.idlePauseUnusedOnly ? " while unused" : " idle"}`
        : "off",
    ],
    ["persistent", info.persistent ? "yes" : "no"],
    [
      "labels",
      Object.entries(info.labels ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "-",
    ],
    // Null is every egress secret that reaches it; [] is none. Absent from
    // older servers, so no line then rather than a guess.
    ...(info.secrets === undefined
      ? []
      : [
          [
            "secrets",
            info.secrets === null
              ? "every one that reaches it"
              : info.secrets.length
                ? info.secrets.join(", ")
                : "none",
          ],
        ]),
    ["charged", dollars(BigInt(Math.round(Number(info.chargedMicros) || 0)))],
  ]);
}

/** `cp` between this machine and a sandbox or an App's copy: exactly one
 * side is `<id>:/path`. A destination ending in / (or a local directory)
 * takes the source's own name inside it, as cp does. */
async function copyFile(
  from: string,
  to: string,
  use: (id: string) => Promise<Pick<Sandbox, "files">>,
  side: string,
): Promise<void> {
  const source = remote(from);
  const target = remote(to);
  const inside = (dir: string, path: string) =>
    `${dir.replace(/\/+$/, "")}/${path.replace(/\/+$/, "").split("/").pop()}`;
  if (source && !target) {
    const local = await import("node:fs/promises").then((fs) => fs.stat(to).catch(() => null));
    await (
      await use(source.id)
    ).files.download(
      source.path,
      to.endsWith("/") || local?.isDirectory() ? inside(to, source.path) : to,
    );
  } else if (!source && target)
    await (
      await use(target.id)
    ).files.upload(from, target.path.endsWith("/") ? inside(target.path, from) : target.path);
  else throw usage(`Name exactly one side as ${side}:/path.`);
}

/** Resolves `<id>:/path` into its parts, or undefined for a local path. */
function remote(spec: string): { id: string; path: string } | undefined {
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127}):(\/.*)$/.exec(spec);
  return match ? { id: match[1]!, path: match[2]! } : undefined;
}

export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Out = defaultOut(argv),
): Promise<number> {
  // Only what comes before -- is the CLI's: a --json after it is the
  // command's, whether or not the CLI was given its own.
  const dash = argv.indexOf("--");
  // CLOUD.md section 4: the plural names the product, the singular is a
  // typing shortcut, and an old word works for 30 days with a warning.
  const words = productWords(
    argv.filter((arg, index) => arg !== "--json" || (dash !== -1 && index > dash)),
  );
  if (words.warning) out.error(`Warning: ${named(words.warning)}`);
  const [first, ...remaining] = words.argv;
  // Sandbox is one product of several, so its commands live under it
  // (23 September 2026): `runtime sandboxes run`, `sandbox ssh` and
  // `sandbox port-forward`. The old top-level forms were removed, not aliased.
  if (first && SANDBOX_MOVED.includes(first))
    throw usage(
      `\`${me} ${first}\` is now \`${me} sandboxes ${first === "forward" ? "port-forward" : first}\`.`,
    );
  const nested =
    (first === "sandbox" || first === "sandboxes" || first === "sbx") &&
    [...SANDBOX_MOVED, "code"].includes(remaining[0] ?? "");
  const command = nested ? remaining[0]! : first;
  const rest = nested ? remaining.slice(1) : remaining;
  // `runtime sandboxes create --help` is how an agent asks what a command takes:
  // answer with the product's help, never by running the command.
  const cut = remaining.indexOf("--");
  const asked =
    (cut < 0 ? remaining : remaining.slice(0, cut)).some(
      (arg) => arg === "--help" || arg === "-h",
    ) ||
    (remaining.length === 1 && remaining[0] === "help");
  // A command without a help of its own answers `help` with its lines of the
  // top-level help, and never takes the word as its input.
  if (first && first !== "help" && asked && !nested && !OWN_HELP.includes(first)) {
    const lines = topicHelp(named(HELP), first);
    if (lines) {
      out.write(out.json ? JSON.stringify({ usage: lines }) : lines);
      return 0;
    }
  }
  if (
    first &&
    (cut < 0 ? remaining : remaining.slice(0, cut)).some((arg) => arg === "--help" || arg === "-h")
  )
    return run(
      nested && command === "ssh"
        ? [first, "ssh", "help"]
        : OWN_HELP.includes(first)
          ? [first, "help"]
          : ["help"],
      env,
      out,
    );
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  product = "";
  if (!command) {
    const connected =
      Boolean(env.RUNTIME_API_KEY) ||
      (await resolveCredential(env).then(
        () => true,
        () => false,
      ));
    const start = connected
      ? "Connected."
      : "Not connected yet: the first command below connects this machine (a browser approval).";
    out.write(
      out.json
        ? JSON.stringify({ connected, usage: HELP })
        : `Runtime Cloud ${VERSION}. ${start}

  ${me} sandboxes run -- python3 < invoice.py
                                   Run a local invoice script, then delete the sandbox
  ${me} sandboxes create                 A sandbox that stays; prints its id
  ${me} sandboxes exec <id> -- <command> Run in it
  ${me} help                             Everything else
`,
    );
    return 0;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    out.write(out.json ? JSON.stringify({ usage: named(HELP) }) : named(HELP));
    return 0;
  }
  if (command === "run") {
    const args = parse(
      rest,
      [...CREATE_FLAGS, "keep", "root"],
      // execute() reads --trace-files for run as for exec.
      [...CREATE_VALUES, "cwd", "env", "trace-files"],
      `${me} sandboxes run -- python3 < invoice.py`,
    );
    const commandLine = args.rest ?? args.positional;
    if (!commandLine.length)
      throw usage(`Give the command after --: ${me} sandboxes run -- python3 < invoice.py`);
    const runtime = await client(env);
    const timeout = integer(args, "timeout");
    const { timeoutSeconds: _lease, ...input } = createInput(args, env);
    const onCapacityWait = waiting(out);
    const sbx = await withVolumeRelease(
      (options) => runtime.sandboxes.create(input, { ...options, onCapacityWait }),
      out,
    );
    let cleanup: Promise<boolean> | undefined;
    // SIGINT and normal completion share one delete, with an absolute
    // deadline across its retries, so cleanup cannot hang. A delete, not a
    // stop: a stopped sandbox keeps its disk, billed, and an account without
    // credit keeps at most 5, so five runs that only stopped refused the
    // sixth (no_credit_kept_limit). --keep is how to keep one.
    const stop = () =>
      (cleanup ??= (async () => {
        const signal = AbortSignal.timeout(30_000);
        try {
          await sbx.delete({ signal });
          return true;
        } catch (error) {
          out.error(
            describeError(
              new RuntimeError({
                code: "cleanup_failed",
                status: 0,
                message: `Could not confirm that sandbox ${sbx.id} was deleted. ${error instanceof Error ? error.message : String(error)}`,
                hint: `Check it and retry cleanup with: ${me} sandboxes rm ${sbx.id}`,
                cause: error,
              }),
              out.json,
            ),
          );
          return false;
        }
      })());
    const interrupted = () => void stop().then(() => process.exit(130));
    if (!has(args, "keep")) process.once("SIGINT", interrupted);
    let code = 1;
    try {
      code = await execute(sbx, commandLine, args, out, timeout, env, has(args, "keep"));
    } finally {
      try {
        if (has(args, "keep"))
          out.error(
            `Kept sandbox ${sbx.id}. Run more with: ${me} sandboxes exec ${sbx.id} -- <command>`,
          );
        else if (!(await stop()) && code === 0) code = 1;
      } finally {
        process.off("SIGINT", interrupted);
      }
    }
    return code;
  }
  if (command === "--version" || command === "version") {
    print(VERSION, { version: VERSION });
    return 0;
  }
  if (command === "login" || command === "logout") {
    const { authenticationCommand } = await import("./login.js");
    const result = await authenticationCommand([command, ...rest], env);
    // Which account it connected to, so a person with several can tell. The
    // connection stands whether or not this read answers.
    const who =
      command === "login" && "connected" in result && result.connected
        ? await (await client(env)).me().catch(() => undefined)
        : undefined;
    const account = who ? (who.orgName ? `${who.orgName} (${who.orgId})` : who.orgId) : undefined;
    print(
      result.pending
        ? `Not connected yet. When it is approved, run any command, or \`${me} login --wait\`; it uses this link.`
        : command === "login"
          ? `Connected${"agentName" in result && result.agentName ? ` as ${String(result.agentName)}` : ""}${account ? ` to ${account}` : ""}.`
          : "Disconnected.",
      who ? { ...result, orgId: who.orgId, orgName: who.orgName ?? null } : result,
    );
    return 0;
  }
  if (command === "whoami") {
    const rt = await client(env);
    // The usage call only adds the funding line: a key that cannot read it
    // still gets its answer.
    const [who, spend] = await Promise.all([rt.me(), rt.usage().catch(() => undefined)]);
    const trialLeft = spend?.trial ? spend.trial.availableMs / 3_600_000 : 0;
    const credit = spend ? BigInt(spend.available) : 0n;
    // A pilot's sandboxes run on the pilot, before anything else and free.
    const funding = !spend
      ? undefined
      : [
          ...(spend.pilot ? [pilotFunding(spend.pilot)] : []),
          ...(trialLeft > 0
            ? [
                `free usage, ${trialLeft.toLocaleString("en-US", { maximumFractionDigits: 1 })} hours left without credit`,
              ]
            : []),
          ...(credit > 0n ? [`${dollars(credit)} of credit`] : []),
        ].join("; ") || "no free usage or credit left: runtime billing";
    print(
      table([
        ["organization", who.orgName ? `${who.orgName} (${who.orgId})` : who.orgId],
        ...(who.role ? [["role", who.role]] : []),
        ...(funding ? [["funding", funding]] : []),
        ["agent", who.principalId],
        ["key", who.credentialId ?? "-"],
        ["api", who.apiVersion],
      ]),
      who,
    );
    return 0;
  }
  if (command === "usage") {
    if (rest[0] === "export") {
      const args = parse(rest.slice(1), [], ["since", "until"]);
      if (args.positional.length || args.rest)
        throw usage(`Use ${me} usage export --since <UTC time> --until <UTC time>.`);
      const since = need(flag(args, "since"), "--since <UTC time>, such as 2026-09-01T00:00:00Z");
      const until = need(flag(args, "until"), "--until <UTC time>, such as 2026-10-01T00:00:00Z");
      const rt = await client(env);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      // The export is final only as far as its earliest page's finalThrough.
      let finalThrough: string | null | undefined;
      for (;;) {
        const page = await rt.usageExport({
          since,
          until,
          ...(cursor ? { cursor } : {}),
          limit: 500,
        });
        if (page.nextCursor !== null && cursors.has(page.nextCursor))
          throw new RuntimeError({
            code: "usage_export_incomplete",
            status: 0,
            message: "The usage export repeated a page cursor and could not finish.",
            hint: "Run the export again; do not treat the partial output as complete.",
          });
        if (out.json) out.write(JSON.stringify(page));
        else if (page.csv) out.write(page.csv);
        await out.drain?.();
        const at = page.finalThrough;
        finalThrough =
          finalThrough === undefined
            ? at
            : finalThrough === null || at === null
              ? null
              : at < finalThrough
                ? at
                : finalThrough;
        if (page.nextCursor === null) {
          out.error(finalLine({ until: page.until, finalThrough: finalThrough ?? null }));
          return 0;
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    }
    const csv = rest.includes("--csv");
    const unknown = rest.find((arg) => arg !== "--csv");
    if (unknown) throw usage(`Unknown option ${unknown}: ${me} usage [--csv | --json]`);
    const value = await (await client(env)).usage();
    if (csv) {
      out.write(usageCsv(value));
      if ((value.resources ?? []).length >= 100)
        out.error("These are the newest 100 resources; older ones are not in this export.");
      return 0;
    }
    print(usageSummary(value), value);
    return 0;
  }
  if (command === "limits") {
    const rt = await client(env);
    // The usage call only adds the pilot's line: a key that cannot read it
    // still gets its limits.
    const [l, spend] = await Promise.all([rt.limits.get(), rt.usage().catch(() => undefined)]);
    // As `usage` shows money: $0.0014 of spend read $0.00 until 30 September 2026.
    const usd = (micros: string) => dollars(micros);
    const access =
      l.access === "read"
        ? "read only: reads every product, cannot start, change or spend"
        : l.access === "full"
          ? "full: every product"
          : (l.access ?? "-");
    print(
      table([
        ["access", access],
        [
          "daily limit",
          l.daily.limitMicros === null
            ? "none (the prepaid balance is the bound)"
            : usd(l.daily.limitMicros),
        ],
        ["used, last 24 hours", usd(l.daily.usedMicros)],
        ...(l.daily.remainingMicros === null ? [] : [["left", usd(l.daily.remainingMicros)]]),
        ...(l.credit ? [["credit", creditLine(l.credit, usd)]] : []),
        ...(l.trial ? [["free time", trialLeft(l.trial)]] : []),
        ...(spend?.pilot
          ? [
              ["pilot", pilotFunding(spend.pilot)],
              ["pilot sandbox hours", pilotLeft(spend.pilot)],
            ]
          : []),
      ]),
      l,
    );
    if (l.credit?.addedBy === "agent" && !out.json)
      out.write(
        `No person pays for this account, so add credit yourself: \`${me} billing topup <usd>\`.`,
      );
    return 0;
  }
  if (command === "secrets") return secretsCommand(rest, env, out);
  if (command === "webhooks" || command === "webhook") return webhooksCommand(rest, env, out);
  if (command === "otel") return otelCommand(rest, env, out);
  if (command === "events") {
    const args = parse(rest, [], ["sandbox", "type", "limit"]);
    const rt = await client(env);
    const sandbox = flag(args, "sandbox");
    const page = await rt.events.list({
      ...(sandbox ? { resourceId: await sandboxIdOf(rt, sandbox) } : {}),
      ...(flag(args, "type") ? { type: flag(args, "type") as WebhookEventType } : {}),
      ...(integer(args, "limit") !== undefined ? { limit: integer(args, "limit")! } : {}),
    });
    print(
      page.data.length
        ? table(
            page.data.map((e) => {
              const subject = (Object.values(e.data)[0] ?? {}) as { stopReason?: string };
              return [e.createdAt, e.type, e.resourceId ?? "-", subject.stopReason ?? ""];
            }),
          )
        : "No events in the last 14 days.",
      page,
    );
    return 0;
  }
  if (command === "keys") return keys(rest, env, out);
  if (command === "reservations") return reservationsCommand(rest, env, out);
  if (command === "sso") {
    const status = await (await client(env)).sso.get();
    print(
      [
        status.connections.length
          ? table([
              ["domain", "provider", "verified", "required", "new people join as"],
              ...status.connections.map((c) => [
                c.domain,
                `${c.provider} ${c.protocol.toUpperCase()}`,
                c.domainVerifiedAt
                  ? c.domainVerifiedAt.slice(0, 10)
                  : `no: TXT ${c.verification.name}`,
                c.requireSso ? "yes" : "no",
                c.defaultRole,
              ]),
            ])
          : "No single sign-on yet.",
        "",
        `Directory sync (SCIM): ${status.scim.tokens} token${status.scim.tokens === 1 ? "" : "s"}, ${status.scim.activeUsers} of ${status.scim.users} people active, ${status.scim.groups.length} groups.`,
        `An owner changes it at ${status.manage}`,
      ].join("\n"),
      status,
    );
    return 0;
  }
  if (command === "account" || command === "accounts") return accountCommand(rest, env, out);
  if (command === "audit") {
    const args = parse(rest, [], ["action", "limit", "before"]);
    const known = new Set(["action", "limit", "before"]);
    for (const name of args.flags.keys())
      if (!known.has(name)) throw usage(`Unknown option --${name}.`);
    const page = await (
      await client(env)
    ).audit.list({
      ...(flag(args, "action") ? { action: flag(args, "action")! } : {}),
      ...(integer(args, "limit") !== undefined ? { limit: integer(args, "limit")! } : {}),
      ...(flag(args, "before") ? { before: flag(args, "before")! } : {}),
    });
    print(
      page.events.length
        ? [
            table([
              ["when (UTC)", "action", "who", "from"],
              ...page.events.map((event) => [
                event.at.slice(0, 19).replace("T", " "),
                event.action,
                event.actor.kind === "runtime"
                  ? "Runtime"
                  : `${event.actor.name ?? event.actor.kind}${event.actor.person ? ` (${event.actor.person})` : ""}`,
                event.ip ?? event.via,
              ]),
            ]),
            ...(page.next ? ["", `Older: ${me} audit --before ${page.next}`] : []),
          ].join("\n")
        : "Nothing recorded yet.",
      page,
    );
    return 0;
  }
  if (command === "billing") {
    product = "billing";
    const origins = connectionOrigins(env);
    const { claimWalletAccount, openWalletAccount, rekeyWalletAccount } =
      await import("./wallet.js");
    return billingCommand(
      rest,
      parse(
        rest,
        ["wait", "new-account", "accept-terms", "new-key"],
        ["below", "amount", "monthly"],
      ),
      out,
      () => client(env),
      undefined,
      {
        open: (input) => {
          checkBrowserOrigins(origins);
          return openWalletAccount(input, { authUrl: origins.auth });
        },
        claim: (code) => {
          checkBrowserOrigins(origins);
          return claimWalletAccount(code, { authUrl: origins.auth });
        },
        rekey: (code) => {
          checkBrowserOrigins(origins);
          return rekeyWalletAccount(code, { authUrl: origins.auth });
        },
        save: (key, orgId) => {
          checkBrowserOrigins(origins);
          return connectionStore(env).save({
            version: 1,
            apiOrigin: origins.api,
            authOrigin: origins.auth,
            key,
            connectionId: "pasted",
            orgId,
            agentName: "Wallet agent",
          });
        },
      },
    );
  }
  if (command === "referrals") {
    parse(rest, [], []);
    const r = await (await client(env)).referrals.get();
    const usd = (micros: string) =>
      `$${(Number(BigInt(micros) / 10_000n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    print(
      [
        `Your link: ${r.link}`,
        "",
        `A company that signs up with it has each payment in its first ${r.windowDays} days matched, up to ${usd(r.maxRewardMicros)},`,
        `and you get the same; its first payment of ${usd(r.minPurchaseMicros)} or more gives each of you at least ${usd(r.rewardMicros)}.`,
        `Then for ${r.shareMonths} months you earn ${r.shareBasisPoints / 100}% of what it spends from credit it paid for`,
        `(up to ${usd(r.yearlyCapMicros)} a year for you, matches and share together).`,
        ...(r.enabled ? [] : ["The program is paused: new sign-ups are not counted right now."]),
        "",
        table([
          ["signed up", String(r.signedUp)],
          ["waiting for a first payment", String(r.pending)],
          ["paying", String(r.payingCompanies)],
          ["earned", usd(r.earnedMicros)],
          ["of which share", usd(r.shareEarnedMicros)],
          [`left this year (${r.year})`, usd(r.capRemainingMicros)],
        ]),
      ].join("\n"),
      r,
    );
    return 0;
  }
  if (command === "plans") {
    product = "plans";
    const args = parse(rest, ["yearly"], []);
    const [verb, id, extra] = args.positional;
    const runtime = await client(env);
    const usd = (micros: string) =>
      `$${(Number(BigInt(micros) / 10_000n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "-");
    const yearly = args.flags.get("yearly")?.at(-1) === "true";
    if (yearly && verb !== "choose") throw usage("--yearly goes with plans choose <plan>.");
    const now = (current: PlanNow | null) =>
      !current
        ? "No plan: you pay for what runs from your credit."
        : [
            `Your plan: ${current.name} (${current.planId}), ${current.status.replace("_", " ")}, ${current.interval === "year" ? "yearly" : "monthly"}.`,
            current.status === "trialing" && current.trialEndsAt
              ? `The trial ends on ${day(current.trialEndsAt)}.`
              : undefined,
            current.cancelAtPeriodEnd
              ? `It ends on ${day(current.periodEnd)}; \`${me} plans resume\` keeps it.`
              : current.nextPlanId
                ? `It moves to ${current.nextPlanId} on ${day(current.periodEnd)}.`
                : `Next fee on ${day(current.periodEnd)}.`,
            current.planUsage
              ? `Plan usage left: ${usd(current.planUsage.leftMicros)} of ${usd(current.planUsage.grantedMicros)}, until ${day(current.planUsage.expiresAt)}.`
              : undefined,
            current.addOns.length
              ? `Add-ons: ${current.addOns
                  .map(
                    (a) =>
                      `${a.id}${a.quantity > 1 ? ` x${a.quantity}` : ""}${a.endsAt ? ` (ends ${day(a.endsAt)})` : ""}`,
                  )
                  .join(", ")}.`
              : undefined,
            current.autoUpgrade
              ? `Auto-upgrade: on; a create a limit refuses moves you up a plan. \`${me} plans auto-upgrade off\` stops it.`
              : "Auto-upgrade: off.",
          ]
            .filter((line) => line !== undefined)
            .join("\n");
    if (verb === undefined || verb === "ls") {
      if (id !== undefined) throw usage(`Unexpected ${id}.`);
      const r = await runtime.plans.list();
      const amount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
      print(
        [
          now(r.current),
          "",
          r.plans.length
            ? table([
                ["plan", "name", "fee a month", "a year", "bonus", "trial", "support"],
                ...r.plans.map((p) => [
                  p.id,
                  p.name,
                  p.collection === "invoice" ? "invoiced" : usd(p.feeMicros),
                  p.yearlyFeeMicros === null ? "-" : usd(p.yearlyFeeMicros),
                  BigInt(p.bonusMicros) > 0n ? usd(p.bonusMicros) : "-",
                  p.trialDays > 0 ? `${p.trialDays} days` : "-",
                  p.support,
                ]),
              ])
            : "No plans are offered yet.",
          ...r.plans
            .filter((p) => p.included.length || p.limits.length || p.addOns.length)
            .flatMap((p) => [
              "",
              `${p.id}:`,
              ...(p.included.length
                ? [
                    `  includes ${p.included.map((i) => `${amount(i.quantity)} ${i.unit} of ${i.product} ${i.meter}`).join(", ")} a month`,
                  ]
                : []),
              ...(p.limits.length
                ? [
                    `  limits ${p.limits.map((l) => `${l.limit} ${l.max === null ? "unlimited" : l.max}`).join(", ")}`,
                  ]
                : []),
              ...(p.addOns.length
                ? [
                    `  add-ons ${p.addOns.map((a) => `${a.id} (${usd(a.feeMicros)} a month)`).join(", ")}`,
                  ]
                : []),
            ]),
          "",
          "A plan's fee comes back as plan usage, spent first each month at the same measured prices;",
          `usage left at the period's end ends with it. Choose one: ${me} plans choose <plan> [--yearly].`,
        ].join("\n"),
        r,
      );
      return 0;
    }
    if (verb === "choose" || verb === "cancel" || verb === "resume") {
      if (verb === "choose" && !id) throw usage(`Say which plan: ${me} plans choose <plan>.`);
      if ((verb === "choose" ? extra : id) !== undefined)
        throw usage(`Unexpected ${verb === "choose" ? extra : id}.`);
      const r =
        verb === "choose"
          ? await runtime.plans.choose(id!, yearly ? { interval: "year" } : {})
          : verb === "cancel"
            ? await runtime.plans.cancel()
            : await runtime.plans.resume();
      print(
        r.checkoutUrl
          ? `A person chooses it and pays the first month here, then the plan starts:\n${r.checkoutUrl}`
          : now(r.current),
        r,
      );
      return 0;
    }
    if (verb === "add-on" || verb === "remove-add-on") {
      if (!id) throw usage(`Say which add-on: ${me} plans ${verb} <id>.`);
      if (extra !== undefined) throw usage(`Unexpected ${extra}.`);
      const r =
        verb === "add-on" ? await runtime.plans.addOn(id) : await runtime.plans.removeAddOn(id);
      print(
        r.checkoutUrl
          ? `A person confirms it here, then the add-on starts:\n${r.checkoutUrl}`
          : now(r.current),
        r,
      );
      return 0;
    }
    if (verb === "auto-upgrade") {
      if (id !== "on" && id !== "off")
        throw usage(`Say on or off: ${me} plans auto-upgrade on|off.`);
      if (extra !== undefined) throw usage(`Unexpected ${extra}.`);
      const r = await runtime.plans.autoUpgrade(id === "on");
      print(now(r.current), r);
      return 0;
    }
    throw usage(
      `Unknown plans command ${verb}: ls, choose <plan> [--yearly], cancel, resume, add-on <id>, remove-add-on <id> or auto-upgrade on|off.`,
    );
  }
  if (command === "compare" || command === "switch") return switching(command, rest, env, out);
  if (command === "mcp") {
    const { serveMcp } = await import("./mcp.js");
    await serveMcp(env);
    /* Its input closed or a signal came: leave once stdout has drained. An
       idle keep-alive connection to the API would otherwise hold the process
       for several seconds after the client asked it to go. */
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    process.exit(0);
  }
  if (command === "fly-api") {
    const args = parse(rest, [], ["port", "host"]);
    const { serveMachinesApi } = await import("./fly/index.js");
    const served = await serveMachinesApi({
      client: await client(env),
      port: args.flags.has("port") ? portOf(flag(args, "port"), "4280") : 4280,
      hostname: flag(args, "host") ?? "127.0.0.1",
    });
    out.write(
      `Fly Machines API on ${served.url}: point FLY_API_HOSTNAME (fly-admin's apiUrl, fly-go's FLY_FLAPS_BASE_URL) here.\nEach request runs as this login, or as the Runtime key (rtcloud_...) in its bearer token. Ctrl-C stops it.\n`,
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await served.close();
    return 0;
  }
  if (command === "docs") {
    const topic = rest[0] ?? "index";
    const response = await envFetch(
      `https://withruntime.com/docs/${topic === "index" ? "start" : encodeURIComponent(topic)}.md`,
      { redirect: "error" },
    );
    if (!response.ok)
      throw usage(`No docs page named ${topic}. Try start, cli, api, javascript, python, mcp.`);
    out.write(await response.text());
    return 0;
  }
  if (command === "feedback") {
    const args = parse(rest, ["list"], ["kind", "detail", "competitor", "request-id"]);
    if (has(args, "list")) {
      const { data } = await (await client(env)).feedback.list();
      print(
        data.length
          ? table([
              ["ID", "KIND", "STATUS", "SUMMARY"],
              ...data.map((f) => [
                f.id,
                f.kind,
                f.sorted === false ? "received, sorting hourly" : f.status,
                f.summary,
              ]),
            ])
          : 'Nothing reported yet. Tell us anything: runtime feedback "..."',
        data,
      );
      return 0;
    }
    const summary = need(
      args.positional.join(" ").trim(),
      'what to tell us, in quotes: runtime feedback "..."',
    );
    const kind = (flag(args, "kind") ?? "other") as FeedbackKind;
    const detail = flag(args, "detail");
    const result = await (
      await client(env)
    ).feedback.submit({
      kind,
      summary: summary.slice(0, 200),
      ...(detail || summary.length > 200 ? { detail: detail ?? summary } : {}),
      ...(flag(args, "competitor") ? { competitor: flag(args, "competitor")! } : {}),
      ...(flag(args, "request-id") ? { requestId: flag(args, "request-id")! } : {}),
    });
    print(
      `Thank you, received ${result.id}${result.duplicate ? " (already filed)" : ""}. It is sorted into an item every hour; follow it with \`${me} feedback --list\`.`,
      result,
    );
    return 0;
  }
  if (command === "support") return support(rest, env, out);
  if (command === "ls") {
    const runtime = await client(env);
    // Every product in one list; a product this account cannot use is left out.
    const quiet = <T>(work: Promise<T>) => work.catch(() => undefined);
    const [sandboxes, snapshots, images, volumes] = await Promise.all([
      runtime.sandboxes.list({ limit: 100 }),
      quiet(runtime.snapshots.list({ limit: 100 })),
      quiet(runtime.images.list({ limit: 100 })),
      quiet(runtime.volumes.list({ limit: 100 })),
    ]);
    const items = [
      ...sandboxes.data.map((s) => s.info),
      ...(snapshots?.data ?? []),
      ...(images?.data ?? []),
      ...(volumes?.data ?? []),
    ] as {
      id: string;
      kind: string;
      name?: string | null;
      state?: string;
      status?: string;
      createdAt: string;
    }[];
    const rows = items.map((item) => [
      item.id,
      item.kind,
      item.name ?? "-",
      item.state ?? item.status ?? "-",
      item.createdAt,
    ]);
    print(
      rows.length
        ? table([["ID", "PRODUCT", "NAME", "STATE", "CREATED"], ...rows])
        : "Nothing yet. Start with: runtime sandboxes create",
      items,
    );
    return 0;
  }
  if (command === "ssh") {
    product = "ssh";
    return (await import("./ssh.js")).sshCommand(rest, env, out, () => client(env), me);
  }
  if (nested && command === "code") {
    product = "ssh";
    return (await import("./ssh.js")).editorCommand(rest, env, out, () => client(env), me);
  }
  if (command === "port-forward" || command === "forward") {
    product = "ssh";
    return (await import("./ssh.js")).portForwardCommand(rest, out, () => client(env), me);
  }
  if (command === "sandbox" || command === "sandboxes" || command === "sbx") {
    product = "sandbox";
    return sandbox(rest, env, out);
  }
  if (command === "snapshot" || command === "snapshots") {
    product = "snapshot";
    return snapshot(rest, env, out);
  }
  if (command === "image" || command === "images") {
    product = "image";
    return imageCommand(rest, env, out);
  }
  if (command === "volume" || command === "volumes") {
    product = "volume";
    return volume(rest, env, out);
  }
  if (command === "job" || command === "jobs") {
    product = "job";
    return jobCommand(rest, env, out);
  }
  if (command === "app" || command === "apps") {
    product = "apps";
    return (await import("./apps-cli.js")).appsCommand(rest, env, out, () => client(env), kit);
  }
  if (command === "function" || command === "functions") {
    product = "functions";
    return (await import("./apps-cli.js")).functionsCommand(rest, env, out, () => client(env), kit);
  }
  if (command === "build" || command === "builds") {
    product = "builds";
    return (await import("./apps-cli.js")).buildsCommand(rest, out, () => client(env), kit);
  }
  if (command === "ci") {
    product = "ci";
    return (await import("./ci-cli.js")).ciCommand(rest, out, () => client(env), kit);
  }
  if (command === "container" || command === "containers") {
    product = "containers";
    return (await import("./apps-cli.js")).containersCommand(
      rest,
      env,
      out,
      () => client(env),
      kit,
    );
  }
  if (["browser", "browsers", "desktop", "desktops"].includes(command)) {
    product = command.endsWith("s") ? command : `${command}s`;
    return (await import("./browsers-cli.js")).machineProductCommand(
      product as "browsers" | "desktops",
      rest,
      out,
      () => client(env),
      kit,
    );
  }
  if (command === "agent" || command === "agents") {
    product = "agents";
    return (await import("./agents-cli.js")).agentsCommand(rest, env, out, () => client(env), kit);
  }
  // WireGuard is inside networks: `runtime networks wireguard peer add`.
  const wireguard = command === "networks" && rest[0] === "wireguard";
  const networkProduct = wireguard ? "wireguard" : command;
  const networkRest = wireguard ? rest.slice(1) : rest;
  if (command !== "wireguard" && (NETWORK_PRODUCTS as readonly string[]).includes(networkProduct)) {
    product = networkProduct;
    return networkProductCommand(
      networkProduct as NetworkProduct,
      networkRest,
      parse(
        networkRest,
        ["ipv6"],
        ["sandbox", "subnet", "public-key", "route", "out", "host", "secret"],
      ),
      out,
      () => client(env),
    );
  }
  throw unknown("command", command, COMMANDS);
}

/** `usage export`'s last word, on stderr beside the CSV: how much of the
 * range can still change. */
export function finalLine(page: Pick<UsageExportPage, "until" | "finalThrough">): string {
  if (page.finalThrough === null)
    return "Charges in this range may still settle; export it again later for a final copy.";
  if (Date.parse(page.finalThrough) >= Date.parse(page.until))
    return "Final: no more charges will settle in this range.";
  return `Final up to ${page.finalThrough}; charges after that may still settle. Export again later for the rest.`;
}

/** `runtime usage` for a person: the balance, the free usage and what each kind
 * of resource was charged, in dollars. --json keeps every figure, and each
 * resource with its rates and CPU time. */
/** One row per resource, for a spreadsheet: when it ran, how big it was, how
 * long it ran, the CPU it used and what it cost. Money is exact dollars to the
 * microdollar (the API's integer microdollars moved six places), so a column
 * sums to the ledger to the last digit. */
export function usageCsv(u: Usage): string {
  const cell = (value: unknown) => {
    const text =
      typeof value === "string" || typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : "";
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const exact = (value: unknown) => {
    const micros = BigInt(typeof value === "number" || typeof value === "string" ? value : 0);
    const sign = micros < 0n ? "-" : "";
    const size = micros < 0n ? -micros : micros;
    return `${sign}${size / 1_000_000n}.${(size % 1_000_000n).toString().padStart(6, "0")}`;
  };
  const head = [
    "resource_id",
    "name",
    "kind",
    "state",
    "created_at",
    "vcpu",
    "memory_mib",
    "running_seconds",
    "active_cpu_seconds",
    "memory_gib_seconds",
    "charged_usd",
    "held_usd",
  ];
  const rows = (u.resources ?? []).map((r) =>
    [
      r.resourceId,
      r.name,
      r.kind,
      r.state ?? r.status,
      r.createdAt,
      r.vcpu,
      r.memoryMiB,
      r.runningSeconds,
      r.activeCpuSeconds,
      r.memoryGiBSeconds,
      exact(r.chargedMicros),
      exact(r.heldMicros),
    ]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...rows].join("\n");
}

/** Milliseconds as hours, to a tenth: "8,731.2". */
const hours = (ms: number) =>
  (ms / 3_600_000).toLocaleString("en-US", { maximumFractionDigits: 1 });

/** The machine time left without credit, as `runtime usage` and `runtime
 * limits` say it: this month's free usage, as hours at 2 vCPU and 4 GiB,
 * or for an account given free hours before 5 October 2026, those hours too. */
function trialLeft(trial: NonNullable<Usage["trial"]>): string {
  const renews = trial.renewsAt ? `, renews ${trial.renewsAt.slice(0, 10)}` : "";
  return trial.totalMs > 0
    ? `${hours(trial.availableMs)} hours left (${hours(trial.totalMs)} free hours given before 5 October 2026, and the free usage${renews})`
    : `${hours(trial.availableMs)} hours at 2 vCPU and 4 GiB left this month${renews}`;
}

/** This month's free usage, one row per product, as `runtime usage`
 * says it. */
function allowanceRows(allowances: NonNullable<Usage["allowances"]>): string[][] {
  const amount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return allowances.map((a) => [
    `included ${a.pool.replace(/-/g, " ")}`,
    `${amount(a.left)} of ${amount(a.quantity)} ${a.unit}s left`,
  ]);
}

/** What Runtime for Startups includes as `runtime usage` says it, in the
 * console's words: machine time left of what it gave, storage as the GB kept
 * free each month and the GB kept now, and what it runs at once. */
function potRows(
  pot: NonNullable<Usage["startupIncluded"]>,
  limits?: Usage["startupLimits"],
): string[][] {
  const amount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const day = (iso: string) => {
    const at = new Date(iso);
    const month = at.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    return `${at.getUTCDate()} ${month} ${at.getUTCFullYear()}`;
  };
  const NAMES: Record<string, string> = {
    "machine-cpu": "vCPU-hours",
    "machine-memory": "memory",
    "saved-copies": "saved copies kept free",
    disks: "volumes",
  };
  const ORDER = ["machine-cpu", "machine-memory", "saved-copies", "disks"];
  const rank = (pool: string) => (ORDER.includes(pool) ? ORDER.indexOf(pool) : ORDER.length);
  const rows = [...pot]
    .sort((a, b) => rank(a.pool) - rank(b.pool))
    .map((p) => {
      const name = `${p.period === "month" ? "Runtime for Startups" : "startup hours"}: ${NAMES[p.pool] ?? p.pool.replace(/-/g, " ")}`;
      const until = p.expiresAt ? ` until ${day(p.expiresAt)}` : "";
      if (p.period === "month") {
        const kept = p.keptGB ?? 0;
        const over =
          kept > p.quantity ? `; past ${amount(p.quantity)} GB bills at the published rate` : "";
        return [
          name,
          `${amount(p.quantity)} GB kept free${until} · ${amount(kept)} GB kept now${over}`,
        ];
      }
      return [name, `${amount(p.left ?? 0)} of ${amount(p.quantity)} ${p.unit}s left${until}`];
    });
  if (limits)
    rows.push(
      ["Runtime for Startups: sandboxes at once", amount(limits.sandboxesAtOnce)],
      ["Runtime for Startups: image builds at once", amount(limits.buildsAtOnce)],
    );
  return rows;
}

/** What a pilot gives, as `runtime whoami` and `runtime limits` say it: the
 * sandboxes it runs free and until when, past which credit does not run
 * them. */
function pilotFunding(pilot: NonNullable<Usage["pilot"]>): string {
  const at = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  return `a pilot: up to ${pilot.sandboxes.toLocaleString("en-US")} sandboxes free, running until ${at(pilot.graceEndsAt)}; credit does not run it; to extend it, write to support`;
}

/** A pilot's sandbox hours left, as `runtime usage` says them. */
function pilotLeft(pilot: NonNullable<Usage["pilot"]>): string {
  const left = `${hours(pilot.leftMs)} of ${pilot.hours.toLocaleString("en-US")} left`;
  // How long they last at the rate its sandboxes run now (an API before
  // 0414 does not say how many run).
  const running = pilot.running ?? 0;
  const pace =
    running > 0
      ? `; at ${running.toLocaleString("en-US")} running, about ${hours(pilot.leftMs / running)} hours`
      : "";
  return pilot.leftMs > 0
    ? `${left}${pace}; new pilot sandboxes until ${pilot.endsAt.slice(0, 16).replace("T", " ")} UTC`
    : "This pilot's sandbox hours are used.";
}

function usageSummary(u: Usage): string {
  const micros = (value: unknown) =>
    typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      ? BigInt(value)
      : 0n;
  const takenBack = micros(u.takenBack);
  const rows: string[][] = [
    ["available", dollars(micros(u.available))],
    ["credited", dollars(micros(u.credited))],
    // spent includes what refunds and disputes took back: say that part on
    // its own line, so "spent" reads as what was used.
    ["used", dollars(micros(u.spent) - takenBack)],
    ...(takenBack > 0n ? [["returned by refunds and disputes", dollars(takenBack)]] : []),
    // What running sandboxes and the hour ahead of stored snapshots, images
    // and volumes are about to use, so an account with nothing running can
    // still show some. Said without "held": no guide teaches holds.
    ["set aside for running sandboxes and this hour's storage", dollars(micros(u.held))],
  ];
  if (micros(u.expired) > 0n) rows.push(["expired or taken back", dollars(micros(u.expired))]);
  if (u.trial) rows.push(["free time", trialLeft(u.trial)]);
  if (u.allowances) rows.push(...allowanceRows(u.allowances));
  // Only a data property is an older server's answer. Do not invoke SDK
  // compatibility getters when a server sends neither generation of fields.
  const pot =
    "startupIncluded" in u
      ? u.startupIncluded
      : (Object.getOwnPropertyDescriptor(u, "pot")?.value as Usage["startupIncluded"]);
  const potLimits =
    "startupLimits" in u
      ? u.startupLimits
      : (Object.getOwnPropertyDescriptor(u, "potLimits")?.value as Usage["startupLimits"]);
  if (pot?.length || potLimits) rows.push(...potRows(pot ?? [], potLimits));
  if (u.pilot) rows.push(["pilot sandbox hours", pilotLeft(u.pilot)]);
  if (u.outbound) {
    const gib = (bytes: number) =>
      `${(bytes / 1_073_741_824).toLocaleString("en-US", { maximumFractionDigits: 1 })} GiB`;
    const left = Math.max(0, u.outbound.allowanceBytes - u.outbound.freeBytes);
    rows.push([
      "outbound traffic this month",
      `${gib(u.outbound.sentBytes)} sent, ${gib(left)} of ${gib(u.outbound.allowanceBytes)} free left, ${dollars(micros(u.outbound.chargedMicros))} charged`,
    ]);
  }
  const kinds = new Map<string, { count: number; charged: bigint; held: bigint }>();
  // Every resource, by kind, from an API that totals them (6 October 2026);
  // an older one sends only its hundred newest, counted here.
  for (const k of u.kinds ?? [])
    kinds.set(k.kind, {
      count: k.resources,
      charged: micros(k.chargedMicros),
      held: micros(k.heldMicros),
    });
  for (const resource of u.kinds ? [] : (u.resources ?? [])) {
    const kind = typeof resource.kind === "string" ? resource.kind : "other";
    const entry = kinds.get(kind) ?? { count: 0, charged: 0n, held: 0n };
    entry.count++;
    entry.charged += micros(resource.chargedMicros);
    entry.held += micros(resource.heldMicros);
    kinds.set(kind, entry);
  }
  const plural = (kind: string, n: number) =>
    n === 1 ? kind : kind.endsWith("x") || kind.endsWith("s") ? `${kind}es` : `${kind}s`;
  const byKind = [...kinds.entries()].sort((a, b) => b[1].count - a[1].count);
  return [
    table(rows),
    "",
    byKind.length
      ? table([
          ["RESOURCES", "COUNT", "CHARGED", "HELD"],
          ...byKind.map(([kind, e]) => [
            plural(kind, e.count),
            e.count.toLocaleString("en-US"),
            dollars(e.charged),
            dollars(e.held),
          ]),
        ])
      : "No resources yet.",
    "",
    `Each resource, with its rates and CPU time: ${me} usage --json, or --csv for a spreadsheet`,
  ].join("\n");
}

const SANDBOX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A sandbox's id from its id or its name, for the filters that take an id. */
async function sandboxIdOf(runtime: Runtime, target: string): Promise<string> {
  return SANDBOX_UUID.test(target)
    ? target
    : (await (await import("./ssh.js")).resolveSandbox(runtime, target)).id;
}

/** What a process has printed so far, in order, without waiting for more. */
async function outputSoFar(runtime: Runtime, sandboxId: string, processId: string) {
  type Read = {
    chunks: { stream: "stdout" | "stderr"; text: string; offset: number }[];
    nextCursor: number;
    truncated: boolean;
    process: { state: string; exitCode: number | null; outOfMemory?: OutOfMemory } | null;
  };
  const chunks: Read["chunks"] = [];
  let cursor = 0;
  let truncated = false;
  let latest: Read["process"] = null;
  // The guest keeps the latest 1 MiB; a read returns at most 192 KiB.
  for (let page = 0; page < 16; page++) {
    const read = await runtime.transport.json<Read>({
      method: "GET",
      path: `/v1/sandboxes/${encodeURIComponent(sandboxId)}/processes/${encodeURIComponent(processId)}/output`,
      query: { cursor, maxBytes: 196_608 },
    });
    chunks.push(...read.chunks);
    truncated ||= read.truncated;
    latest = read.process ?? latest;
    if (read.chunks.length === 0 || read.nextCursor <= cursor) break;
    cursor = read.nextCursor;
  }
  return {
    processId,
    state: latest?.state ?? null,
    exitCode: latest?.exitCode ?? null,
    ...(latest?.outOfMemory ? { outOfMemory: latest.outOfMemory } : {}),
    truncated,
    chunks,
  };
}

/** What a person reads when the sandbox's out-of-memory killer ended a
 * command: the API's message and hint, on standard error. A bare exit -9 (or
 * 137) said nothing of memory until 9 October 2026. */
export function outOfMemoryLines(memory: OutOfMemory | undefined): string | undefined {
  // The words come from an answer, not this CLI: escaped like a log line, so
  // nothing in them can drive the terminal (terminal.ts).
  return memory && typeof memory.message === "string" && typeof memory.hint === "string"
    ? `runtime: ${terminalSafe(memory.message)}\nHint: ${terminalSafe(memory.hint)}`
    : undefined;
}

/** Dollars from integer microdollars: cents from a dollar up, four places
 * below one, and every place below a hundredth of a cent, so a short trial
 * test never reads as $0.0000. */
function creditLine(
  c: NonNullable<Awaited<ReturnType<Runtime["limits"]["get"]>>["credit"]>,
  usd: (micros: string) => string,
): string {
  if (c.state === "empty") return "none left: add credit to keep going";
  const days =
    c.runwayDays === null
      ? "nothing is being spent"
      : `lasts about ${Math.max(1, Math.round(c.runwayDays))} ${Math.round(c.runwayDays) <= 1 ? "day" : "days"} at this month's pace`;
  return `${usd(c.availableMicros)} left, ${days}${c.state === "low" ? " (low)" : ""}`;
}

function dollars(micros: string | bigint): string {
  const value = BigInt(micros);
  const sign = value < 0n ? "-" : "";
  const size = value < 0n ? -value : value;
  const places = size >= 1_000_000n ? 2 : size >= 100n || size === 0n ? 4 : 6;
  const unit = 10n ** BigInt(6 - places);
  const rounded = (size + unit / 2n) / unit;
  const whole = rounded / 10n ** BigInt(places);
  const part = (rounded % 10n ** BigInt(places)).toString().padStart(places, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${part}`;
}

const SWITCH_FROM: Record<string, SwitchProvider> = {
  e2b: "e2b",
  daytona: "daytona",
  vercel: "vercel",
  modal: "modal",
  cloudflare: "cloudflare",
  fly: "fly",
  "fly-machines": "fly",
  blaxel: "blaxel",
};
const RIVAL_NAMES: Record<SwitchProvider, string> = {
  e2b: "E2B",
  daytona: "Daytona",
  vercel: "Vercel Sandbox",
  modal: "Modal",
  cloudflare: "Cloudflare Sandbox",
  fly: "Fly",
  blaxel: "Blaxel",
};

/** The rivals whose SDK runs on Runtime unchanged but for one import, and that
 * import in JavaScript and Python. Held to the guides' own lines by
 * `tests/cli-drop-in.test.ts`. */
const DROP_IN: Partial<Record<SwitchProvider, { js: string; py?: string; also?: string }>> = {
  e2b: {
    js: 'import { Sandbox } from "withruntime/e2b"; // was: from "e2b"',
    py: "from withruntime.e2b import Sandbox  # was: from e2b import Sandbox",
  },
  daytona: {
    js: 'import { Daytona } from "withruntime/daytona"; // was: from "@daytona/sdk"',
    py: "from withruntime.daytona import Daytona  # was: from daytona import Daytona",
  },
  vercel: {
    js: 'import { Sandbox } from "withruntime/vercel"; // was: from "@vercel/sandbox"',
    py: "from withruntime.vercel import sandbox  # was: from vercel import sandbox",
  },
  blaxel: {
    js: 'import { SandboxInstance } from "withruntime/blaxel"; // was: from "@blaxel/core"',
    py: "from withruntime.blaxel import SandboxInstance  # was: from blaxel.core import SandboxInstance",
  },
  modal: {
    js: 'import { ModalClient } from "withruntime/modal"; // was: from "modal"',
    py: "from withruntime import modal  # was: import modal",
  },
  // A Worker-only SDK: no Python. More than the import changes, so say what.
  cloudflare: {
    js: 'import { getSandbox } from "withruntime/cloudflare"; // was: from "@cloudflare/sandbox"',
    also: "Change the `export { Sandbox }` line the same way, delete the `containers` block from the Wrangler config and run `npx wrangler secret put RUNTIME_API_KEY`.",
  },
};

/** Fly's Machines API moves by its address, not an import: the lines of the
 * Fly guide's "From Machines". */
const FLY_MACHINES = [
  "Your Fly Machines code runs on Runtime with one address changed:",
  "  npx withruntime fly-api   # answers on http://127.0.0.1:4280 as your Runtime login",
  "  export FLY_API_HOSTNAME=http://127.0.0.1:4280     # Fly's curl examples",
  "  export FLY_FLAPS_BASE_URL=http://127.0.0.1:4280   # fly-go, Fly's Go client",
];

/** How to move a rival's code across, when one import (or, for Fly's
 * Machines, one address) does it. `from` is the name the caller gave. */
export function dropInLines(provider: SwitchProvider | undefined, from?: string): string[] {
  if (from === "fly-machines") return FLY_MACHINES;
  const drop = provider && DROP_IN[provider];
  if (!drop) return [];
  return [
    `Your ${RIVAL_NAMES[provider]} code runs on Runtime with ${drop.also ? "this import changed" : "one import changed"}:`,
    `  ${drop.js}`,
    ...(drop.py ? [`  ${drop.py}`] : []),
    ...(drop.also ? [drop.also] : []),
  ];
}

/** A date as the CLI writes one: 23 September 2026. */
const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** One line on the welcome match: while it is open, how much of it credit
 * added now can still get; after, what it got. Undefined when there is
 * nothing to say: the offer ended unused. */
function welcomeLine(summary: SwitchingSummary): string | undefined {
  const w = summary.welcome;
  // A server from before the welcome match (0433) answers without it.
  if (!w) return undefined;
  const whole = (micros: string | bigint) => dollars(micros).replace(/\.00$/, "");
  if (w.eligible) {
    // A server from before 0435 answers without what is left.
    const left = w.leftMicros ?? (BigInt(w.maxMicros) - BigInt(w.creditMicros)).toString();
    return BigInt(w.creditMicros) > 0n
      ? `${whole(w.creditMicros)} of ${whole(w.maxMicros)} matched so far; credit you add by ${longDate(w.endsAt)} is matched, up to ${whole(left)} more.`
      : `Credit you add by ${longDate(w.endsAt)} is matched, up to ${whole(w.maxMicros)} in total.`;
  }
  switch (w.status) {
    case "paid":
      return `Your credit was matched: ${dollars(w.creditMicros)} of credit.`;
    case "superseded":
      return "Your payments are matched by your referral instead, which is never less.";
    case "reversed":
      return "The payments that were matched were refunded, so the match was taken back.";
    case "refused":
      return "Your credit was not matched. Ask support if you think that is wrong.";
  }
  return undefined;
}

/** What `switch` says: the switch on record, if any, and the welcome match.
 * A switch already on record is named with its provider and date, so it never
 * reads as if this command recorded it, or recorded the provider it names. */
function switchingLine(summary: SwitchingSummary, provider?: SwitchProvider): string | undefined {
  const sw = summary.switch;
  const welcome = welcomeLine(summary);
  if (!sw) {
    if (!provider || !summary.eligible) return welcome;
    return [
      `Switching from ${RIVAL_NAMES[provider]}? Run \`${me} switch --from ${provider}\` before your first top-up to record it.`,
      welcome,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const from = RIVAL_NAMES[sw.provider];
  const once =
    provider && provider !== sw.provider
      ? ` A switch is recorded once, so it stays ${from}, not ${RIVAL_NAMES[provider]}.`
      : "";
  return [
    `This organization's switch from ${from} was recorded on ${longDate(sw.recordedAt)}.${once}`,
    welcome,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Running time in the largest unit that keeps it above zero: a short
 * trial test is seconds, not "0 hours". */
function runningTime(seconds: number): string {
  const [amount, unit] =
    seconds < 60
      ? [seconds, "second"]
      : seconds < 3600
        ? [seconds / 60, "minute"]
        : [seconds / 3600, "hour"];
  const shown = amount.toLocaleString("en-US", {
    maximumFractionDigits: unit === "second" ? 1 : 2,
  });
  return `${shown} ${unit}${shown === "1" ? "" : "s"}`;
}

/** The sandboxes free usage paid for, said beside what was priced. */
function trialNote(trial: number, all: number, trialSeconds: number): string {
  if (!trial) return "";
  const which =
    trial === all
      ? all === 1
        ? "It"
        : "All of them"
      : `${trial} of them, ${runningTime(trialSeconds)} of that time,`;
  return ` ${which} ran on free usage, which charged nothing; Runtime's side prices ${trial === 1 ? "it" : "them"} at the standard rates, what the same work costs on paid credit.`;
}

async function switching(
  command: "compare" | "switch",
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
): Promise<number> {
  const args = parse(argv, [], command === "compare" ? ["from", "days"] : ["from"]);
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const known = new Set(command === "compare" ? ["from", "days"] : ["from"]);
  for (const name of args.flags.keys())
    if (!known.has(name)) throw usage(`Unknown option --${name}.`);
  if (args.positional.length || args.rest) throw usage(`Unexpected ${args.positional[0] ?? "--"}.`);
  const from = flag(args, "from")?.trim().toLowerCase();
  const api = (await client(env)).switching;

  if (command === "switch") {
    if (!from) {
      const summary = await api.get();
      const record = summary.eligible
        ? `Moving from a rival? Run \`${me} switch --from <provider>\` (${summary.providers.join(", ")}) before your first top-up to record it.`
        : undefined;
      print(
        (summary.switch
          ? switchingLine(summary)
          : [record, welcomeLine(summary)].filter(Boolean).join(" ")) ||
          "A switch is recorded before the first top-up, and this organization has made one already.",
        summary,
      );
      return 0;
    }
    const provider = Object.hasOwn(SWITCH_FROM, from) ? SWITCH_FROM[from] : undefined;
    if (!provider) throw unknown("provider", from, Object.keys(SWITCH_FROM));
    const summary = await api.record({ provider });
    print(
      [
        `Recorded: switching from ${RIVAL_NAMES[provider]}. ${welcomeLine(summary) ?? ""}`.trim(),
        ...dropInLines(provider, from),
      ].join("\n"),
      summary,
    );
    return 0;
  }

  if (!from)
    throw usage(
      `Name the rival: ${me} compare --from e2b (or daytona, vercel, modal, cloudflare, fly, fly-machines, blaxel, lambda-microvms, freestyle, prime...).`,
    );
  /* The server holds the list of rivals it has rates for, and names them all
     when it refuses one, so a rival added there needs no new CLI. */
  const days = integer(args, "days");
  const c = await api.compare({ provider: from, days });
  const saving = BigInt(c.savingMicros);
  const percent = c.savingPercent === null ? "" : ` (${Math.abs(c.savingPercent)}%)`;
  const verdict =
    saving >= 0n
      ? `you save ${dollars(saving)}${percent}`
      : `${c.rival.name} would cost ${dollars(-saving)} less${percent}`;
  const figures = `${dollars(c.runtimeMicros)} on Runtime; the same sandboxes on ${c.rival.name}: ${dollars(c.rivalMicros)}; ${verdict}`;
  const month = c.perMonth ? BigInt(c.perMonth.savingMicros) : undefined;
  const monthly =
    month === undefined
      ? ""
      : month >= 0n
        ? `a saving of about ${dollars(month)} a month`
        : `about ${dollars(-month)} a month more on Runtime`;
  /* The month is projected from the days the usage covers, not from the
     window asked for: say which, or a young account's 7 and 90 days read the
     same with nothing to say why. */
  const covered = c.perMonth?.fromDays ?? c.window.days;
  const pace =
    month === undefined
      ? "."
      : covered < c.window.days
        ? `. Your usage so far covers ${covered <= 1 ? "less than a day" : `${covered.toLocaleString("en-US")} days`}; at that pace, ${monthly}.`
        : c.window.days === 30
          ? `, ${monthly}.`
          : `. At that pace, ${monthly}.`;
  const lines =
    c.basis === "usage"
      ? [
          `Your last ${c.window.days} days: ${figures}${pace}`,
          `Priced: ${c.usage.sandboxes.toLocaleString("en-US")} sandbox${c.usage.sandboxes === 1 ? "" : "es"}, ${runningTime(c.usage.runSeconds)} running.${trialNote(c.usage.trialSandboxes, c.usage.sandboxes, c.usage.trialRunSeconds)}${c.usage.unpricedSandboxes ? ` ${c.usage.unpricedSandboxes} left out: ${c.rival.name} publishes no price for their size.` : ""}`,
        ]
      : [
          `No settled sandboxes in your last ${c.window.days} days yet, so this prices an example: ${c.usage.sandboxes.toLocaleString("en-US")} runs of ${(c.usage.runSeconds / c.usage.sandboxes).toLocaleString("en-US")} seconds using ${(c.usage.activeCpuSeconds / c.usage.sandboxes).toLocaleString("en-US")} CPU-seconds each.`,
          `The example: ${figures}.`,
        ];
  lines.push(
    `${c.rival.name}'s published rates, checked ${longDate(`${c.rival.checked}T12:00:00Z`)}: ${c.rival.rates.join("; ")}. Compute only, with the disk where a rival bills it while running: storage at rest, network, plan fees and free allowances are left out.`,
  );
  const rival = Object.hasOwn(SWITCH_FROM, from) ? SWITCH_FROM[from] : undefined;
  const line = switchingLine(c.switching, rival);
  if (line) lines.push("", line);
  const drop = dropInLines(rival, from);
  if (drop.length) lines.push("", ...drop);
  print(lines.join("\n"), c);
  return 0;
}

async function support(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const args = parse(argv, [], ["conversation"]);
  const api = (await client(env)).support;
  const conversationId = flag(args, "conversation");
  const [first, second, third] = args.positional;
  let reply;
  if (first === "read") reply = await api.read(need(second, "the conversation id"));
  else if (first === "approve")
    reply = await api.message({
      approveActionId: need(second, "the action id"),
      approveInputHash: need(third, "the input hash"),
      ...(conversationId ? { conversationId } : {}),
    });
  else if (first === "deny")
    reply = await api.message({
      denyActionId: need(second, "the action id"),
      ...(conversationId ? { conversationId } : {}),
    });
  else
    reply = await api.message({
      message: need(args.positional.join(" ").trim(), 'a message: runtime support "..."'),
      ...(conversationId ? { conversationId } : {}),
    });
  const actions = (reply.pendingActions ?? []).map(
    (a) =>
      `  ${a.id}  ${a.summary}\n    approve: runtime support approve ${a.id} ${a.inputHash} --conversation ${reply.conversationId}`,
  );
  out.write(
    out.json
      ? JSON.stringify(reply)
      : `${reply.reply ?? (reply.status === "working" ? "Support is working on it. Read again in a minute:" : "")}\n${reply.status === "working" ? `  runtime support read ${reply.conversationId}\n` : ""}${actions.length ? `Proposed actions (nothing runs until you approve):\n${actions.join("\n")}\n` : ""}[${reply.status}] conversation ${reply.conversationId}`,
  );
  return 0;
}

async function sandbox(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    out.write(out.json ? JSON.stringify({ usage: named(SANDBOX_HELP) }) : named(SANDBOX_HELP));
    return 0;
  }
  // Inside a sandbox, with no API key: the sandbox's own request token asks.
  if (verb === "identity-token") {
    const args = parse(rest, [], ["audience", "lifetime"]);
    const audience = need(flag(args, "audience"), "--audience, such as sts.amazonaws.com");
    const lifetime = flag(args, "lifetime");
    const { identityToken } = await import("./identity.js");
    const token = await identityToken({
      audience,
      ...(lifetime === undefined ? {} : { lifetimeSeconds: Number(lifetime) }),
    });
    print(token.token, token);
    return 0;
  }
  const runtime = await client(env);
  /* By id or by name, for every command here, as ssh and port-forward
     always took one. */
  const get = async (id: string | undefined): Promise<Sandbox> =>
    (await import("./ssh.js")).resolveSandbox(runtime, need(id, "a sandbox id or name"));
  /* For a command that needs only the id: an id is used as it is, with no
     lookup first, so `exec` is one request and not two (about 110 ms less
     from Colorado to Virginia). A sandbox that is gone or stopped is refused
     by the command itself, with the same words. */
  const use = async (id: string | undefined): Promise<Sandbox> =>
    SANDBOX_UUID.test(id ?? "")
      ? new SandboxHandle(runtime.transport, { id } as SandboxInfo)
      : get(id);
  /* `stop --label` and `rm --label`: every sandbox with all the labels, each
     named with what happened to it; exits 1 if any failed. */
  const byLabel = (words: string[]) => words.some((word) => /^--label(=|$)/.test(word));
  const everyLabelled = async (act: "stop" | "delete", words: string[]): Promise<number> => {
    const args = parse(words, [], ["label"]);
    if (args.positional.length) throw usage("Give a sandbox id or --label, not both.");
    const labels = pairs(args, "label");
    const { done, failed } =
      act === "stop"
        ? await runtime.sandboxes.stopAll({ labels }).then((r) => ({ ...r, done: r.stopped }))
        : await runtime.sandboxes.deleteAll({ labels }).then((r) => ({ ...r, done: r.deleted }));
    const past = act === "stop" ? "stopped" : "deleted";
    const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
    print(
      [
        done.length || failed.length
          ? `${done.length} ${past}${failed.length ? `, ${failed.length} failed` : ""}.`
          : `No ${act === "stop" ? "live " : ""}sandbox has those labels.`,
        ...done.map((id) => `${id} ${past}`),
        ...failed.map((f) => `${f.id} failed: ${said(f.error)}`),
      ].join("\n"),
      { [past]: done, failed: failed.map((f) => ({ id: f.id, error: said(f.error) })) },
    );
    return failed.length ? 1 : 0;
  };
  switch (verb) {
    case "create": {
      const args = parse(rest, CREATE_FLAGS, CREATE_VALUES);
      const input = createInput(args, env);
      const onCapacityWait = waiting(out);
      const sbx = await withVolumeRelease(
        (options) => runtime.sandboxes.create(input, { ...options, onCapacityWait }),
        out,
      );
      print(sbx.id, sbx.info);
      return 0;
    }
    case "ls":
    case "list": {
      const args = parse(rest, ["all"], ["label", "state"]);
      const page = await runtime.sandboxes.list({
        ...(has(args, "all") ? { includeStopped: true } : {}),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
        ...(args.flags.has("state")
          ? { state: args.flags.get("state") as SandboxInfo["state"][] }
          : {}),
        limit: 100,
      });
      // Every page, oldest first, so the newest are last on the screen. Until
      // 30 September 2026 this stopped at 1,000 and silently left out the
      // newest sandboxes of a busy account.
      const all = await page.toArray(Infinity);
      // Stopped sandboxes are hidden by default; say so, or an agent that
      // stopped everything reads "No sandboxes" as "never had any".
      const hidden =
        out.json || args.flags.size
          ? null
          : await runtime.sandboxes.list({ state: ["stopped"], limit: 50 });
      const stopped = hidden?.data.length
        ? `${hidden.data.length}${hidden.hasMore ? "+" : ""} stopped; runtime sandboxes ls --all shows them.`
        : "";
      const rows = all.map((s) => [
        s.id,
        s.info.name ?? "-",
        s.state,
        `${s.info.vcpu}/${s.info.memoryMiB}`,
        sandboxEnd(s.info),
      ]);
      print(
        [
          rows.length
            ? table([["ID", "NAME", "STATE", "CPU/MIB", "ENDS"], ...rows])
            : stopped
              ? "No live sandboxes."
              : "No sandboxes. Create one: runtime sandboxes create",
          stopped,
        ]
          .filter(Boolean)
          .join("\n"),
        all.map((s) => s.info),
      );
      return 0;
    }
    case "get": {
      const sbx = await get(rest[0]);
      print(describe(sbx.info), sbx.info);
      return 0;
    }
    case "switch-image": {
      const args = parse(rest, ["keep-workspace"], []);
      const [id, image] = args.positional;
      const sbx = await use(
        need(id, `a sandbox, e.g. ${me} sandboxes switch-image <id> app:v2 --keep-workspace`),
      );
      if (!args.flags.has("keep-workspace"))
        throw usage(
          `A switch keeps only /workspace (your home), volumes, env and previews; processes restart and everything else on its disk is lost. Add --keep-workspace to say so, or snapshot it first (${me} sandboxes snapshot ${sbx.id}) to keep everything.`,
        );
      await sbx.switchImage(need(image, "an image, e.g. app:v2"), { keep: "workspace" });
      print(describe(sbx.info), sbx.info);
      return 0;
    }
    case "resize": {
      const args = parse(rest, ["restart"], ["vcpu", "memory", "disk"]);
      const sbx = await use(
        need(
          args.positional[0],
          `a sandbox, e.g. ${me} sandboxes resize <id> --memory 4096 --restart`,
        ),
      );
      const size = {
        ...(integer(args, "vcpu") !== undefined ? { vcpu: integer(args, "vcpu")! } : {}),
        ...(integer(args, "memory") !== undefined ? { memoryMiB: integer(args, "memory")! } : {}),
        ...(integer(args, "disk") !== undefined ? { diskMiB: integer(args, "disk")! } : {}),
      };
      if (size.vcpu === undefined && size.memoryMiB === undefined && size.diskMiB === undefined)
        throw usage(
          `Name a new size, e.g. ${me} sandboxes resize ${sbx.id} --memory 4096 --restart`,
        );
      // A disk alone grows live, or is refused saying it needs --restart.
      const live = size.vcpu === undefined && size.memoryMiB === undefined;
      if (!live && !args.flags.has("restart"))
        throw usage(
          `A resize restarts it: its whole disk stays and its programs stop. Add --restart to say so, or snapshot it first (${me} sandboxes snapshot ${sbx.id}) to keep its memory too.`,
        );
      await sbx.resize(size, { restart: args.flags.has("restart") });
      print(describe(sbx.info), sbx.info);
      return 0;
    }
    case "rm":
    case "delete": {
      if (byLabel(rest)) return everyLabelled("delete", rest);
      const sbx = await use(need(rest[0], `a sandbox, e.g. ${me} sandboxes rm <id>`));
      const gone = await sbx.delete();
      print(`${gone.id} deleted`, gone);
      return 0;
    }
    case "stop":
    case "pause":
    case "wake":
    case "restart": {
      if (verb === "stop" && byLabel(rest)) return everyLabelled("stop", rest);
      const sbx = await get(rest[0]);
      await sbx[verb]();
      print(`${sbx.id} ${sbx.state}`, sbx.info);
      return 0;
    }
    case "mount": {
      const args = parse(rest, ["read-only"], ["secret", "region", "endpoint", "account-id"]);
      const sbx = await use(args.positional[0]);
      const source = need(
        args.positional[1],
        "a bucket, as s3://bucket, r2://bucket or gcs://bucket",
      );
      const found = /^(s3|r2|gcs):\/\/([^/]+)(?:\/(.+))?$/.exec(source);
      if (!found) throw usage("The bucket is s3://bucket[/prefix], r2://bucket or gcs://bucket.");
      const mounted = await sbx.mounts.add({
        provider: found[1] as "s3" | "r2" | "gcs",
        bucket: found[2]!,
        path: need(args.positional[2], "a path to mount it at, such as /data"),
        ...(found[3] ? { prefix: found[3] } : {}),
        ...(flag(args, "secret") ? { secret: flag(args, "secret")! } : {}),
        ...(flag(args, "region") ? { region: flag(args, "region")! } : {}),
        ...(flag(args, "endpoint") ? { endpoint: flag(args, "endpoint")! } : {}),
        ...(flag(args, "account-id") ? { accountId: flag(args, "account-id")! } : {}),
        ...(has(args, "read-only") ? { readOnly: true } : {}),
      });
      print(`${mounted.path} ${mounted.provider}://${mounted.bucket}`, mounted);
      return 0;
    }
    case "mounts": {
      const sbx = await use(rest[0]);
      const all = await sbx.mounts.list();
      print(
        all.length
          ? table([
              ["PATH", "BUCKET", "ENDPOINT", "SECRET", "MOUNTED"],
              ...all.map((m) => [
                m.path,
                `${m.provider}://${m.bucket}${m.prefix ? `/${m.prefix}` : ""}`,
                m.endpoint,
                m.secret ?? "-",
                m.mounted ? "yes" : "no",
              ]),
            ])
          : "No buckets mounted.",
        all,
      );
      return 0;
    }
    case "unmount": {
      const sbx = await use(rest[0]);
      const gone = await sbx.mounts.remove(need(rest[1], "the mounted path"));
      print(`${gone.path} unmounted`, gone);
      return 0;
    }
    case "tailscale": {
      const action = rest[0];
      if (action === "up") {
        const args = parse(rest.slice(1), [], ["auth-key-secret", "hostname", "tag"]);
        const sbx = await use(args.positional[0]);
        const joined = await sbx.tailscale.up({
          authKeySecret: need(
            flag(args, "auth-key-secret"),
            "--auth-key-secret, the name of a secret set with --jobs that holds your Tailscale auth key",
          ),
          ...(flag(args, "hostname") ? { hostname: flag(args, "hostname")! } : {}),
          ...(args.flags.has("tag") ? { tags: args.flags.get("tag")! } : {}),
        });
        print(
          `${joined.hostname} ${joined.addresses.join(" ")}${
            joined.proxy ? ` (reach the tailnet through ${joined.proxy})` : ""
          }`,
          joined,
        );
        return 0;
      }
      if (action === "status") {
        const sbx = await use(rest[1]);
        const now = await sbx.tailscale.status();
        print(
          now.tailnet
            ? `${now.tailnet.hostname} ${now.running ? now.addresses.join(" ") : (now.state ?? "not running")}`
            : "Not on a tailnet.",
          now,
        );
        return 0;
      }
      if (action === "down") {
        const sbx = await use(rest[1]);
        const gone = await sbx.tailscale.down();
        print(gone.left ? "Left the tailnet." : "Not on a tailnet.", gone);
        return 0;
      }
      throw usage("runtime sandboxes tailscale up|status|down <id>");
    }
    case "snapshot": {
      const args = parse(rest, [], ["name", "retention"]);
      const sbx = await get(args.positional[0]);
      const snapshot = await sbx.snapshot({
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
        ...(daysOrCredit(args, "retention") !== undefined
          ? { retentionDays: daysOrCredit(args, "retention")! }
          : {}),
      });
      print(snapshot.id, snapshot);
      return 0;
    }
    case "fork": {
      const args = parse(
        rest,
        ["keep-snapshot", "trial", "paid", "no-secrets"],
        ["count", "name", "secret"],
      );
      const secrets = secretsInput(args);
      const sbx = await get(args.positional[0]);
      const forks = await sbx.fork({
        count: integer(args, "count") ?? 1,
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
        ...(has(args, "keep-snapshot") ? { keepSnapshot: true } : {}),
        ...secrets,
        ...(has(args, "trial")
          ? { funding: "trial" as const }
          : has(args, "paid")
            ? { funding: "paid" as const }
            : {}),
      });
      print(
        forks.map((f) => f.id).join("\n"),
        forks.map((f) => f.info),
      );
      return 0;
    }
    case "update": {
      const args = parse(
        rest,
        [],
        [
          "name",
          "label",
          "env",
          "unset-env",
          "idle-pause",
          "auto-wake",
          "persistent",
          "max-total-cost",
          "timeout",
          "on-timeout",
          "user",
        ],
      );
      const sbx = await get(args.positional[0]);
      const onOff = (name: string) => {
        const value = flag(args, name);
        if (value === undefined) return undefined;
        if (value !== "on" && value !== "off") throw usage(`--${name} takes on or off.`);
        return value === "on";
      };
      const onTimeout = flag(args, "on-timeout")
        ? oneOf(args, "on-timeout", ["pause", "stop", "delete"] as const)
        : undefined;
      const cost = flag(args, "max-total-cost");
      if (cost !== undefined && cost !== "none" && !/^\d+(\.\d{1,6})?$/.test(cost))
        throw usage("--max-total-cost takes dollars, such as 25 or 2.50, or none.");
      const variables = {
        ...(args.flags.has("env") ? envPairs(args, env) : {}),
        ...Object.fromEntries((args.flags.get("unset-env") ?? []).map((name) => [name, null])),
      };
      const settings = {
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
        ...(Object.keys(variables).length ? { env: variables } : {}),
        ...(integer(args, "idle-pause") !== undefined
          ? { idlePauseSeconds: integer(args, "idle-pause")! }
          : {}),
        ...(onOff("auto-wake") === undefined ? {} : { autoWake: onOff("auto-wake")! }),
        ...(onOff("persistent") === undefined ? {} : { persistent: onOff("persistent")! }),
        ...(flag(args, "user") ? { user: oneOf(args, "user", ["sandbox", "root"] as const) } : {}),
        ...(cost === undefined
          ? {}
          : {
              maxTotalCostMicros: cost === "none" ? null : usdMicros(args, "max-total-cost")!,
            }),
        ...(integer(args, "timeout") !== undefined
          ? { timeoutSeconds: integer(args, "timeout")! }
          : {}),
        ...(onTimeout === undefined ? {} : { onTimeout }),
      };
      if (!Object.keys(settings).length)
        throw usage(
          "Say what to change: --name, --label, --env, --unset-env, --idle-pause, --auto-wake, --persistent, --user, --max-total-cost, --timeout or --on-timeout.",
        );
      await sbx.update(settings);
      print(describe(sbx.info), sbx.info);
      return 0;
    }
    case "extend": {
      const sbx = await get(rest[0]);
      const seconds = Number(need(rest[1], "seconds, e.g. runtime sandboxes extend <id> 600"));
      await sbx.extend(seconds);
      print(
        sandboxEnd(sbx.info) === "no limit"
          ? `${sbx.id} has no time limit: it runs while it works, so nothing was extended`
          : `${sbx.id} now ends at ${sandboxEnd(sbx.info)}`,
        sbx.info,
      );
      return 0;
    }
    case "exec": {
      const args = parse(
        rest,
        ["root"],
        ["cwd", "env", "timeout", "trace-files"],
        `${me} sandboxes exec <id> -- ls -la`,
      );
      const command = args.rest ?? args.positional.slice(1);
      if (!command.length)
        throw usage("Give the command after --: runtime sandboxes exec <id> -- ls -la");
      const sbx = await use(args.positional[0]);
      return execute(sbx, command, args, out, integer(args, "timeout"), env);
    }
    case "spawn": {
      const args = parse(
        rest,
        ["pty", "root"],
        ["cwd", "env"],
        `${me} sandboxes spawn <id> -- npm run dev`,
      );
      const command = args.rest ?? [];
      if (!command.length)
        throw usage("Give the command after --: runtime sandboxes spawn <id> -- npm run dev");
      const sbx = await use(args.positional[0]);
      const proc = await sbx.spawn(command.length === 1 ? command[0]! : command, {
        ...(has(args, "pty") ? { pty: { cols: 120, rows: 40 } } : {}),
        ...(has(args, "root") ? { user: "root" as const } : {}),
        ...(flag(args, "cwd") ? { cwd: flag(args, "cwd")! } : {}),
        ...(args.flags.has("env") ? { env: envPairs(args, env) } : {}),
      });
      print(proc.id, proc.info);
      return 0;
    }
    case "ps": {
      const sbx = await use(rest[0]);
      const list = await sbx.processes.list();
      print(
        list.length
          ? table([
              ["PROCESS", "STATE", "EXIT", "USER", "COMMAND"],
              // The command line is the guest's report: escaped, as a log is.
              ...list.map((p) => [
                terminalSafe(String(p.id)),
                terminalSafe(String(p.state)),
                `${typeof p.exitCode === "number" ? p.exitCode : "-"}${p.outOfMemory ? " (out of memory)" : ""}`,
                p.user === "root" ? "root" : "sandbox",
                terminalSafe(String(p.command ?? "")),
              ]),
            ])
          : "No processes.",
        list,
      );
      const killed = list.find((p) => p.outOfMemory)?.outOfMemory;
      if (killed && typeof killed.hint === "string" && !out.json)
        out.error(`Hint: ${terminalSafe(killed.hint)}`);
      return 0;
    }
    case "logs": {
      const args = parse(rest, ["f", "follow", "raw"], []);
      const sbx = await use(args.positional[0]);
      const proc = await sbx.processes.get(need(args.positional[1], "a process id"));
      const [stdout, stderr, shown] = [
        logStream(process.stdout, has(args, "raw")),
        logStream(process.stderr, has(args, "raw")),
        logText(args),
      ];
      if (has(args, "f") || has(args, "follow")) {
        for await (const event of proc.output())
          if (event.type === "stdout") stdout(event.data);
          else if (event.type === "stderr") stderr(event.data);
          else if (out.json) out.write(shown(JSON.stringify(event)));
          else if (event.type === "exit" && event.outOfMemory)
            out.error(outOfMemoryLines(event.outOfMemory)!);
        return 0;
      }
      /* Without -f, what it has printed so far, then back to the prompt, as
         `docker logs` does: a server's log is read, not followed forever. */
      const so = await outputSoFar(runtime, sbx.id, proc.id);
      if (out.json) {
        out.write(shown(JSON.stringify(so)));
        return 0;
      }
      for (const chunk of so.chunks) (chunk.stream === "stderr" ? stderr : stdout)(chunk.text);
      if (so.outOfMemory) out.error(outOfMemoryLines(so.outOfMemory)!);
      if (so.state === "running")
        process.stderr.write(
          `[${proc.id} is still running; follow it: ${me} sandboxes logs ${sbx.id} ${proc.id} -f]\n`,
        );
      return 0;
    }
    case "kill": {
      const args = parse(rest, [], ["signal"]);
      const sbx = await use(args.positional[0]);
      const proc = await sbx.processes.get(need(args.positional[1], "a process id"));
      // A process that has ended has nothing to signal; "Signalled" said it
      // had been until 30 September 2026.
      if (
        proc.info.state === "exited" ||
        proc.info.state === "killed" ||
        proc.info.state === "timed_out"
      ) {
        print(
          `${proc.id} had already ${proc.info.state === "exited" ? "exited" : "ended"}${proc.info.exitCode == null ? "" : ` (exit code ${proc.info.exitCode})`}; nothing to signal.`,
          {
            processId: proc.id,
            state: proc.info.state,
            exitCode: proc.info.exitCode ?? null,
            signalled: false,
          },
        );
        return 0;
      }
      await proc.kill((flag(args, "signal") ?? "SIGTERM") as "SIGTERM");
      print(`Signalled ${proc.id}.`, { processId: proc.id, signalled: true });
      return 0;
    }
    case "shell": {
      const args = parse(rest, ["root"], ["command"]);
      const sbx = await use(args.positional[0]);
      return shell(sbx, flag(args, "command"), has(args, "root"));
    }
    case "cat": {
      const sbx = await use(rest[0]);
      // Streamed, any size; a stream that ends short throws, so exit is 1.
      const { Writable } = await import("node:stream");
      await (
        await sbx.files.readStream(need(rest[1], "a path"))
      ).pipeTo(Writable.toWeb(process.stdout), { preventClose: true, preventAbort: true });
      return 0;
    }
    case "files": {
      const args = parse(rest, [], ["depth", "glob"]);
      const sbx = await use(args.positional[0]);
      const entries = await sbx.files.list(args.positional[1] ?? "/workspace", {
        ...(integer(args, "depth") !== undefined ? { depth: integer(args, "depth")! } : {}),
        ...(flag(args, "glob") ? { glob: flag(args, "glob")! } : {}),
      });
      print(
        entries
          .map(
            (e) =>
              `${e.type === "directory" ? "d" : e.type === "symlink" ? "l" : e.type === "other" ? "?" : "-"} ${String(e.size).padStart(10)}  ${e.path}`,
          )
          .join("\n") || "(empty)",
        entries,
      );
      return 0;
    }
    case "cp": {
      const [from, to] = parse(rest, ["r", "recursive"], []).positional;
      await copyFile(need(from, "a source"), need(to, "a destination"), use, "<sandbox-id>");
      print(`Copied ${from} to ${to}.`, { from, to });
      return 0;
    }
    case "run-code":
      return runCode(await use(rest[0]), rest.slice(1), out);
    case "preview": {
      if (rest[0] === "rotate") {
        const port = portOf(rest[2], "runtime sandboxes preview rotate <id> 3000");
        const sbx = await use(rest[1]);
        const preview = await sbx.previews.rotate(port);
        print(
          preview.visibility === "public"
            ? `Port ${port} is public: it takes no token, so there was none to refuse.`
            : `${preview.urlWithToken ?? preview.url}\nEvery earlier token for port ${port} is refused. New header: x-runtime-preview-token: ${preview.token} (expires ${preview.tokenExpiresAt}).`,
          preview,
        );
        return 0;
      }
      const args = parse(rest, ["public"], ["ttl"]);
      const port = portOf(args.positional[1], "runtime sandboxes preview <id> 3000");
      const sbx = await use(args.positional[0]);
      const preview = await sbx.previews.create(port, {
        ...(has(args, "public") ? { visibility: "public" as const } : {}),
        ...(integer(args, "ttl") !== undefined ? { ttlSeconds: integer(args, "ttl")! } : {}),
      });
      // The link and how to use it, nothing more: the API's `hint` (which
      // carries a referral line) stays in --json, not in the command's words.
      print(
        preview.visibility === "public"
          ? preview.url
          : `${preview.urlWithToken ?? preview.url}\nPrivate: send the header x-runtime-preview-token: ${preview.token} (expires ${preview.tokenExpiresAt}).`,
        preview,
      );
      return 0;
    }
    case "link": {
      if (rest[0] === "revoke") {
        const sbx = await use(need(rest[1], "runtime sandboxes link revoke <id>"));
        const revoked = await sbx.files.revokeLinks();
        print(`Every link made for ${sbx.id} until now is refused.`, revoked);
        return 0;
      }
      const args = parse(rest, ["put", "archive", "no-wake"], ["expires", "filename", "max-bytes"]);
      const example = "runtime sandboxes link <id> /workspace/report.pdf";
      const path = need(args.positional[1], example);
      const sbx = await use(need(args.positional[0], example));
      const expires = flag(args, "expires");
      const expiresInSeconds = expires === undefined ? undefined : durationSeconds(expires);
      const wake = has(args, "no-wake") ? false : undefined;
      const link = has(args, "put")
        ? await sbx.files.uploadUrl(path, {
            expiresInSeconds,
            maxBytes: integer(args, "max-bytes"),
            wake,
          })
        : await sbx.files.downloadUrl(path, {
            expiresInSeconds,
            filename: flag(args, "filename"),
            archive: has(args, "archive") || undefined,
            wake,
          });
      print(
        `${link.url}\n${link.method === "PUT" ? `Upload: curl -T <file> '${link.url}'` : `Download: curl -fLo ${JSON.stringify(link.filename ?? link.path.split("/").pop() ?? "file")}${link.archive ? ".tar.gz" : ""} '${link.url}'`} (works until ${link.expiresAt}).`,
        link,
      );
      return 0;
    }
    case "previews": {
      const list = await (await use(rest[0])).previews.list();
      print(
        list.length
          ? table([
              ["PORT", "VISIBILITY", "URL"],
              ...list.map((p) => [String(p.port), p.visibility, p.url]),
            ])
          : "No shared ports. Share one: runtime sandboxes preview <id> 3000",
        list,
      );
      return 0;
    }
    case "session": {
      const verb = rest[0];
      if (verb === "ls") {
        const list = await (await use(rest[1])).sessions.list();
        print(
          list.length
            ? table([
                ["ID", "STATE", "EXPIRES", "ORIGINS"],
                ...list.map((one) => [
                  one.id,
                  one.state,
                  one.expiresAt,
                  one.origins.join(",") || "-",
                ]),
              ])
            : "No sessions. Make one: runtime sandboxes session create <id> --origin https://app.example.com",
          list,
        );
        return 0;
      }
      if (verb === "revoke") {
        const sessionId = need(
          rest[2],
          "a session id: runtime sandboxes session revoke <id> <session-id>",
        );
        const ended = await (await use(rest[1])).sessions.revoke(sessionId);
        print(`Session ${ended.id} ended.`, ended);
        return 0;
      }
      if (verb !== "create")
        throw usage(
          "runtime sandboxes session create <id> [--origin <url>]..., session ls <id>, or session revoke <id> <session-id>",
        );
      const args = parse(rest.slice(1), [], ["origin", "ttl", "name"]);
      const origins = args.flags.get("origin") ?? [];
      const ttl = integer(args, "ttl");
      const name = flag(args, "name");
      const made = await (
        await use(args.positional[0])
      ).sessions.create({
        ...(ttl === undefined ? {} : { ttlSeconds: ttl }),
        ...(origins.length ? { origins } : {}),
        ...(name === undefined ? {} : { name }),
      });
      print(
        `${made.token}\nFor sandbox ${made.sandboxId} until ${made.expiresAt}${
          made.origins.length ? `, from ${made.origins.join(", ")}` : ", from no browser page"
        }. Shown once: hand it to your page (Sandbox.fromSession), never log it.`,
        made,
      );
      return 0;
    }
    case "unshare": {
      const port = portOf(rest[1], "runtime sandboxes unshare <id> 3000");
      const sbx = await use(rest[0]);
      print(`Port ${port} is no longer shared.`, await sbx.previews.delete(port));
      return 0;
    }
    case "network": {
      const args = parse(rest, ["no-internet", "internet"], ["allow", "deny", "connect"]);
      const sbx = await use(args.positional[0]);
      const rules = ["allow", "deny", "connect"].filter((name) => args.flags.has(name));
      const policy =
        has(args, "no-internet") || has(args, "internet") || rules.length
          ? await sbx.network.set({
              internet: !has(args, "no-internet"),
              ...Object.fromEntries(rules.map((name) => [name, args.flags.get(name)!])),
            })
          : await sbx.network.get();
      print(
        table([
          ["internet", policy.internet ? "on" : "off"],
          [
            "allow",
            policy.allow.join(", ") || (policy.internet ? "(the public web)" : "(nothing)"),
          ],
          ["deny", policy.deny.join(", ") || "-"],
          ["connect", policy.connect.join(", ") || "-"],
          ["enforced", policy.enforced ? "yes" : "not yet; run the same command again"],
        ]),
        policy,
      );
      return 0;
    }
    case "desktop":
      return desktop(await use(rest[0]), rest.slice(1), out);
    case "browser":
      return browser(await use(rest[0]), rest.slice(1), out);
    case "watch":
      return (await import("./cli-extras.js")).watchCommand(
        await use(rest[0]),
        rest.slice(1),
        out,
        kit,
      );
    case "mcp":
      if (rest[0] === "catalog" || rest[0] === undefined) {
        const catalog = await runtime.mcp.catalog();
        print(
          table([
            ["ID", "LICENCE", "VERSION", "NEEDS", "WHAT"],
            ...catalog.map((entry) => [
              entry.id,
              entry.license,
              entry.version,
              entry.env
                .filter((item) => item.required)
                .map((item) => `${item.name}${item.secret ? " (secret)" : ""}`)
                .join(", ") || "-",
              entry.description,
            ]),
          ]),
          catalog,
        );
        return 0;
      }
      return (await import("./cli-extras.js")).mcpCommand(
        await use(rest[0]),
        rest.slice(1),
        out,
        kit,
      );
    case "metrics": {
      const args = parse(rest, [], ["range"]);
      const sbx = await use(args.positional[0]);
      const range = (flag(args, "range") ?? "1h") as MetricRange;
      if (!["15m", "1h", "6h", "24h", "7d", "30d"].includes(range))
        throw usage("--range is one of 15m, 1h, 6h, 24h, 7d, 30d.");
      const m = await sbx.metrics({ range });
      print(metricsText(m), m);
      return 0;
    }
  }
  throw unknown("sandbox command", verb, SANDBOX_VERBS);
}

/** `<volumeId>:/path[:snapshot]`, as the create body wants it. */
function attachment(spec: string): { volumeId: string; path: string; mode: "rw" | "snapshot" } {
  const [volumeId, path, mode = "rw"] = spec.split(":");
  if (!volumeId || !path?.startsWith("/") || (mode !== "rw" && mode !== "snapshot"))
    throw usage("--volume takes <volumeId>:/path, or <volumeId>:/path:snapshot for a copy.");
  return { volumeId, path, mode };
}

/** A secret's value, from standard input only, so it never sits in shell
 * history or a process list. Piped: everything, less one trailing newline.
 * A terminal: one line, not shown. */
/** A pasted secret as the header it becomes: no line breaks (a token copied
 * from a terminal arrives wrapped), no bracketed-paste markers, no space at
 * either end. 13 October 2026: a user's pasted Claude token was refused as
 * "not visible ASCII". A header cannot hold a line break, so none is lost. */
export function cleanSecret(raw: string): string {
  return raw
    .replaceAll("\u001b[200~", "")
    .replaceAll("\u001b[201~", "")
    .replace(/[\r\n]/g, "")
    .trim();
}

async function readSecret(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return cleanSecret(Buffer.concat(chunks).toString("utf8"));
  }
  process.stderr.write("Value (not shown), then Enter: ");
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((done, fail) => {
      let value = "";
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            process.stderr.write("\n");
            return done(cleanSecret(value));
          }
          if (char === "\u0003") {
            stdin.off("data", onData);
            return fail(usage("Cancelled."));
          }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

/** `--allow` values as secret rules: each is `[METHOD[,METHOD]...] PATH`, and
 * rules naming the same methods share one rule's paths. Only the shape is read
 * here; the API holds every rule to the same check the host makes
 * (ARCHITECTURE.md section 10, "Per-path rules on an egress secret") and says
 * which one it refused. */
export function parseSecretRules(values: string[]): SecretRule[] {
  const byMethods = new Map<string, SecretRule>();
  for (const value of values) {
    const words = value.trim().split(/\s+/);
    const path = words.at(-1);
    if (!path || words.length > 2 || !path.startsWith("/"))
      throw usage(
        `--allow takes optional methods and one path, such as --allow "GET,HEAD /repos/acme/*" or --allow /v1/chat/completions; got ${JSON.stringify(value)}.`,
      );
    const methods =
      words.length === 2
        ? [...new Set(words[0]!.toUpperCase().split(",").filter(Boolean))].sort()
        : undefined;
    const key = methods?.join(",") ?? "";
    const rule = byMethods.get(key) ?? { ...(methods ? { methods } : {}), paths: [] };
    if (!rule.paths.includes(path)) rule.paths.push(path);
    byMethods.set(key, rule);
  }
  return [...byMethods.values()];
}
/** `--only-label role=hub,tier=x --only-sandbox <id> --only-app <id>`: a
 * sandbox whose labels hold every pair of any one --only-label gets the
 * secret, and so does each --only-sandbox and every copy of each --only-app.
 * `--all-sandboxes`: every sandbox again. Nothing: undefined, so a
 * replacement keeps the scope it has. */
export function parseSecretScope(
  labels: string[] | undefined,
  sandboxes: string[] | undefined,
  all: boolean,
  apps?: string[],
): SecretScope | undefined {
  if (all && (labels?.length || sandboxes?.length || apps?.length))
    throw usage(
      "--all-sandboxes gives the secret to every sandbox; leave out --only-label, --only-sandbox and --only-app.",
    );
  if (all) return {};
  if (!labels?.length && !sandboxes?.length && !apps?.length) return undefined;
  const selectors = (labels ?? []).map((text) => {
    const selector: Record<string, string> = {};
    for (const pair of text.split(",").filter(Boolean)) {
      const at = pair.indexOf("=");
      if (at < 1)
        throw usage(`--only-label takes key=value pairs, such as role=hub; got "${text}".`);
      selector[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
    if (!Object.keys(selector).length)
      throw usage(`--only-label takes key=value pairs, such as role=hub; got "${text}".`);
    return selector;
  });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of sandboxes ?? [])
    if (!uuid.test(id)) throw usage(`--only-sandbox takes a sandbox id; "${id}" is not one.`);
  for (const id of apps ?? [])
    if (!uuid.test(id))
      throw usage(`--only-app takes an App's id (GET /v1/apps lists them); "${id}" is not one.`);
  const ids = (list: string[]) => [...new Set(list.map((id) => id.toLowerCase()))];
  return {
    ...(selectors.length ? { labels: selectors } : {}),
    ...(sandboxes?.length ? { sandboxes: ids(sandboxes) } : {}),
    ...(apps?.length ? { apps: ids(apps) } : {}),
  };
}
/** Who gets a secret, in a few words. */
export const scopeText = (only: SecretScope | undefined) =>
  only && (only.labels?.length || only.sandboxes?.length || only.apps?.length)
    ? [
        ...(only.labels ?? []).map((selector) =>
          Object.entries(selector)
            .map(([key, value]) => `${key}=${value}`)
            .join(","),
        ),
        ...(only.sandboxes ?? []),
        ...(only.apps ?? []).map((id) => `app ${id}`),
      ].join(" | ")
    : "all";
const ruleText = (rules: SecretRule[] | undefined) =>
  rules?.length
    ? rules
        .map((rule) => `${rule.methods ? `${rule.methods.join(",")} ` : ""}${rule.paths.join(" ")}`)
        .join("; ")
    : "-";

export async function secretsCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
  /** Tests give the value here; the CLI reads standard input. */
  read: () => Promise<string> = readSecret,
): Promise<number> {
  const [verb, ...rest] = argv;
  const args = parse(
    rest,
    ["jobs", "all-sandboxes", "keep-value", "all", "none"],
    [
      "host",
      "header",
      "format",
      "allow",
      "value",
      "version",
      "only-label",
      "only-sandbox",
      "only-app",
      "agent",
      "env",
      "limit",
      "after",
    ],
  );
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const rows = (list: SecretUse[]) =>
    list.length
      ? table([
          ["name", "hosts", "header", "placeholder", "allow", "sandboxes", "jobs"],
          ...list.map(({ name, sandboxes: secret, jobs }) => [
            secret?.env ? `${name} (as ${secret.env})` : name,
            secret ? secret.hosts.join(",") : "-",
            secret?.header ? `${secret.header}: ${secret.format ?? "{value}"}` : "-",
            secret ? secret.placeholder : "-",
            secret ? ruleText(secret.rules) : "-",
            secret ? scopeText(secret.only) : "-",
            jobs ? `v${jobs.version}` : "-",
          ]),
        ])
      : "No secrets.";
  if (verb === "ls" || verb === "list" || verb === undefined) {
    const limit = integer(args, "limit");
    if (limit !== undefined && (limit < 1 || limit > 100))
      throw usage("--limit takes 1 to 100 secrets a page.");
    const after = flag(args, "after");
    const runtime = await client(env);
    // A page of both copies by name, as the API pages each: an organization
    // keeps at most 50 secrets for sandboxes, so both are read whole.
    const every = (await runtime.secrets.all()).filter(
      (s) => after === undefined || s.name > after,
    );
    const all = limit === undefined ? every : every.slice(0, limit);
    const more = all.length < every.length ? all.at(-1)!.name : undefined;
    // --json keeps the sandboxes' list it always printed; the jobs copies
    // are in `runtime secrets get <NAME> --json`.
    print(
      more ? `${rows(all)}\nMore: ${me} secrets ls --limit ${limit} --after ${more}` : rows(all),
      all.flatMap((s) => (s.sandboxes ? [s.sandboxes] : [])),
    );
    return 0;
  }
  const jobsOnly = "Only a secret's copy for jobs has versions and can be read back";
  if (verb === "get") {
    const found = await (
      await client(env)
    ).secrets.get(need(args.positional[0], "the secret's name"));
    print(rows([found]), found);
    return 0;
  }
  if (verb === "set" || verb === "rotate") {
    const name = need(args.positional[0], "the secret's name, such as OPENAI_API_KEY");
    const hosts = args.flags.get("host") ?? [];
    const jobs = verb === "rotate" || has(args, "jobs");
    if (
      verb === "rotate" &&
      (hosts.length ||
        args.flags.has("header") ||
        args.flags.has("allow") ||
        args.flags.has("only-label") ||
        args.flags.has("only-sandbox") ||
        args.flags.has("only-app") ||
        args.flags.has("all-sandboxes") ||
        args.flags.has("env"))
    )
      throw usage(
        `rotate replaces the copy for jobs. ${jobsOnly}; to change the sandboxes' copy, set it again with --host.`,
      );
    if (verb === "set" && has(args, "keep-value")) {
      // Narrowing needs no value: it only takes places away (secrets.narrow).
      if (
        jobs ||
        args.flags.has("value") ||
        args.flags.has("header") ||
        args.flags.has("format") ||
        args.flags.has("only-label") ||
        args.flags.has("only-sandbox") ||
        args.flags.has("only-app") ||
        args.flags.has("all-sandboxes") ||
        args.flags.has("env")
      )
        throw usage(
          `--keep-value changes only --host and --allow, and only to narrower ones. Change who gets it with \`${me} secrets scope\`; anything else needs the value.`,
        );
      const allow = args.flags.get("allow");
      if (!hosts.length && !allow)
        throw usage("With --keep-value, give the narrower --host and/or --allow it keeps.");
      const saved = await (
        await client(env)
      ).secrets.narrow(name, {
        ...(hosts.length ? { hosts } : {}),
        ...(allow ? { rules: parseSecretRules(allow) } : {}),
      });
      print(
        [
          `Narrowed ${saved.name}; its value is unchanged. It goes only to ${saved.hosts.join(", ")}${saved.rules?.length ? `, only in these requests: ${ruleText(saved.rules)}` : ""}.`,
          ...(saved.enforced
            ? []
            : ["A host is catching up; running sandboxes have it within a minute."]),
        ].join("\n"),
        saved,
      );
      return 0;
    }
    if (!hosts.length && !jobs)
      throw usage(
        "Give --host once for each host the value may go to, such as --host api.openai.com, and/or --jobs to let scheduled jobs use it.",
      );
    if (args.flags.has("value"))
      throw usage(
        'The value is read from standard input, never an argument: printf %s "$KEY" | runtime secrets set NAME --host ...',
      );
    const value = await read();
    if (!value)
      throw usage(
        'The value is empty. Pipe it in: printf %s "$KEY" | runtime secrets set NAME --host ...; or, to narrow its hosts and rules without it, add --keep-value.',
      );
    const runtime = await client(env);
    if (verb === "rotate") {
      const rotated = await runtime.secrets.rotate(name, value);
      print(
        `Rotated ${name} for jobs to version ${rotated.version}. Runs bound to the old version are refused it.`,
        rotated,
      );
      return 0;
    }
    if (!hosts.length) {
      if (args.flags.has("env"))
        throw usage(
          "--env names the variable sandboxes see the secret in, so it needs --host; a job names its variable on jobs create (--secret NAME=VAR).",
        );
      const saved = await runtime.secrets.set(name, { value, jobs: true });
      print(
        `Stored ${name} for jobs, version ${saved.jobs.version}. Bind it: ${me} jobs create ... --secret ${name}`,
        saved,
      );
      return 0;
    }
    const header = flag(args, "header");
    const format = flag(args, "format");
    const variable = flag(args, "env");
    const allow = args.flags.get("allow");
    const rules = allow ? parseSecretRules(allow) : undefined;
    const only = parseSecretScope(
      args.flags.get("only-label"),
      args.flags.get("only-sandbox"),
      has(args, "all-sandboxes"),
      args.flags.get("only-app"),
    );
    const saved = await runtime.secrets.set(name, {
      value,
      hosts,
      ...(header ? { header } : {}),
      ...(format ? { format } : {}),
      ...(rules ? { rules } : {}),
      ...(only ? { only } : {}),
      ...(variable ? { env: variable } : {}),
      ...(jobs ? { jobs: true as const } : {}),
    });
    const sees = `${saved.env ?? saved.name}=${saved.placeholder}`;
    print(
      [
        saved.only
          ? `Stored ${saved.name}. Only these sandboxes get it and see ${sees}: ${scopeText(saved.only)}.`
          : `Stored ${saved.name}. Every sandbox sees ${sees}.`,
        saved.header
          ? `Requests to ${saved.hosts.join(", ")} get ${saved.header}: ${saved.format ?? "{value}"} over HTTPS.`
          : `Over HTTPS to ${saved.hosts.join(", ")}, the placeholder becomes the value in the Authorization header or another credential header (x-api-key, x-goog-api-key); in the URL it stays a placeholder.`,
        ...(saved.rules?.length ? [`Only these requests get it: ${ruleText(saved.rules)}.`] : []),
        ...(saved.enforced
          ? []
          : ["A host is catching up; running sandboxes have it within a minute."]),
        ...(saved.jobs
          ? [
              `Also stored for jobs, version ${saved.jobs.version}: --secret ${saved.name} on ${me} jobs create.`,
            ]
          : []),
      ].join("\n"),
      saved,
    );
    return 0;
  }
  if (verb === "scope") {
    const name = need(args.positional[0], "the secret's name");
    const only = parseSecretScope(
      args.flags.get("only-label"),
      args.flags.get("only-sandbox"),
      has(args, "all-sandboxes"),
      args.flags.get("only-app"),
    );
    if (!only)
      throw usage(
        "Say who gets it: --only-label key=value (once per selector), --only-sandbox <id>, --only-app <app id>, or --all-sandboxes.",
      );
    const saved = await (await client(env)).secrets.scope(name, only);
    print(
      `${saved.name}: ${saved.only ? `only ${scopeText(saved.only)}` : "every sandbox"}.${saved.enforced ? "" : " A host is catching up; running sandboxes have it within a minute."}`,
      saved,
    );
    return 0;
  }
  if (verb === "share") {
    const name = need(args.positional[0], "the secret's name");
    const named = args.flags.get("agent") ?? [];
    if (Number(named.length > 0) + Number(has(args, "all")) + Number(has(args, "none")) !== 1)
      throw usage(
        "Say who may use it: --agent <id> (once per agent), --all for every key of yours, or --none for only the key that stored it.",
      );
    const saved = await (await client(env)).secrets.share(name, has(args, "all") ? "all" : named);
    print(
      `${saved.name}: ${
        saved.usableBy === "all"
          ? "every key of yours"
          : `only the key that stored it${saved.usableBy.length ? `, and ${saved.usableBy.length} named agent${saved.usableBy.length === 1 ? "" : "s"}` : ""}`
      }.`,
      saved,
    );
    return 0;
  }
  if (verb === "reveal") {
    const name = need(args.positional[0], "the secret's name");
    const version = flag(args, "version");
    if (version !== undefined && !/^\d+$/.test(version)) throw usage("--version takes a number.");
    const shown = await (
      await client(env)
    ).secrets.reveal(name, version === undefined ? {} : { version: Number(version) });
    print(shown.value, shown);
    return 0;
  }
  if (verb === "rm" || verb === "delete") {
    const name = need(args.positional[0], "the secret's name");
    const removed = await (await client(env)).secrets.delete(name);
    print(
      `Deleted ${name}${removed.from.length > 1 ? " for sandboxes and jobs" : removed.from[0] === "jobs" ? " for jobs" : ""}.`,
      removed,
    );
    return 0;
  }
  throw usage(
    "secrets takes set, scope, ls, get, rotate, share, reveal or rm. Run `runtime help`.",
  );
}

async function readInput(source: string): Promise<string> {
  if (source !== "-") return readFile(source, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function runCode(sbx: Sandbox, argv: string[], out: Out): Promise<number> {
  const args = parse(argv, [], ["lang", "context", "timeout", "out-dir"]);
  const source = need(args.positional[0], "a file, or - to read the code from standard input");
  const code = await readInput(source);
  const byExtension: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    ts: "typescript",
    r: "r",
    java: "java",
    jsh: "java",
    sh: "bash",
    bash: "bash",
    go: "go",
  };
  const language = (flag(args, "lang") ??
    byExtension[source.split(".").pop()?.toLowerCase() ?? ""] ??
    "python") as InterpreterLanguage;
  const timeout = integer(args, "timeout");
  const execution = await sbx.interpreter.run(code, {
    language,
    ...(flag(args, "context") ? { context: flag(args, "context")! } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
    ...(out.json
      ? {}
      : {
          onStdout: (text: string) => process.stdout.write(text),
          onStderr: (text: string) => process.stderr.write(text),
        }),
  });
  const saved: string[] = [];
  const outDir = flag(args, "out-dir") ?? ".";
  if (execution.results.some((r) => r.data["image/png"] || r.refs["image/png"]))
    await mkdir(outDir, { recursive: true });
  for (const [index, result] of execution.results.entries()) {
    const inline = result.data["image/png"];
    const ref = result.refs["image/png"];
    if (typeof inline !== "string" && !ref) continue;
    const bytes =
      typeof inline === "string"
        ? Buffer.from(inline, "base64")
        : await sbx.interpreter.result(ref!);
    const file = join(outDir, `result-${execution.executionCount ?? 0}-${index + 1}.png`);
    await writeFile(file, bytes);
    saved.push(file);
  }
  if (out.json) out.write(JSON.stringify({ ...execution, saved }));
  else {
    for (const result of execution.results) {
      const text = result.data["text/plain"];
      if (typeof text === "string" && !result.data["image/png"]) out.write(text);
    }
    for (const file of saved) out.write(`Saved ${file}`);
    if (execution.error)
      out.error(execution.error.traceback || `${execution.error.name}: ${execution.error.value}`);
    if (execution.status === "timeout") out.error("runtime: the cell timed out.");
  }
  return execution.status === "timeout" ? 124 : execution.error ? 1 : 0;
}

async function desktop(sbx: Sandbox, argv: string[], out: Out): Promise<number> {
  const [action, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const d = sbx.desktop;
  switch (action) {
    case "start": {
      const args = parse(rest, [], ["width", "height"]);
      const started = await d.start({
        ...(integer(args, "width") !== undefined ? { width: integer(args, "width")! } : {}),
        ...(integer(args, "height") !== undefined ? { height: integer(args, "height")! } : {}),
      });
      print(
        `Desktop ${started.size} on ${started.display}. Watch it: ${started.streamUrl}`,
        started,
      );
      return 0;
    }
    case "stop":
      print("Desktop stopped.", await d.stop());
      return 0;
    case "screenshot": {
      const file = rest[0] ?? "screenshot.png";
      await writeFile(file, await d.screenshot());
      print(`Saved ${file}`, { file });
      return 0;
    }
    case "open":
      print("Opened.", await d.open(need(rest[0], "a URL")));
      return 0;
    case "click":
      print("Clicked.", await d.click(Number(need(rest[0], "x")), Number(need(rest[1], "y"))));
      return 0;
    case "type":
      print("Typed.", await d.type(need(rest.join(" "), "the text")));
      return 0;
    case "press":
      print("Pressed.", await d.press(need(rest[0], "keys, e.g. ctrl+l")));
      return 0;
    case "record":
      return (await import("./cli-extras.js")).recordCommand(sbx, rest, out, kit);
    case "windows": {
      const windows = await d.windows();
      print(
        windows.length
          ? table([["WINDOW", "TITLE"], ...windows.map((w) => [w.id, w.title])])
          : "No windows.",
        windows,
      );
      return 0;
    }
  }
  throw usage(
    `${me} sandboxes desktop <id> start|stop|screenshot|open|click|type|press|windows|record`,
  );
}

async function browser(sbx: Sandbox, argv: string[], out: Out): Promise<number> {
  const [action, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  switch (action) {
    case "start": {
      const args = parse(rest, ["headed"], ["width", "height"]);
      const started = await sbx.browser.start({
        ...(args.flags.has("headed") ? { headless: false } : {}),
        ...(integer(args, "width") !== undefined ? { width: integer(args, "width")! } : {}),
        ...(integer(args, "height") !== undefined ? { height: integer(args, "height")! } : {}),
      });
      print(
        `${started.version}${started.headless ? "" : `, on the desktop: ${started.streamUrl}`}\n` +
          `CDP: ${started.cdpUrl}\n(private; it expires ${started.expiresAt ?? "never"})` +
          (started.hint ? `\n${started.hint}` : ""),
        started,
      );
      return 0;
    }
    case "get":
    case undefined: {
      const state = await sbx.browser.get();
      print(
        state.running ? `${state.version}\nCDP: ${state.cdpUrl}` : "No browser running.",
        state,
      );
      return 0;
    }
    case "stop": {
      const stopped = await sbx.browser.stop();
      print(stopped.stopped ? "Browser stopped." : "No browser was running.", stopped);
      return 0;
    }
  }
  throw usage(`${me} sandboxes browser <id> start [--headed]|get|stop`);
}

const KEYS_HELP = `runtime keys <command>

  create [--name <name>] [--read-only] [--daily-limit <usd>] [--account-wide] [--browser]
      A new API key. With a key saved on this machine (or RUNTIME_API_KEY), that
      key makes it at once, with no browser: a key per worker in an agent swarm.
      It never has more than the key that made it, and when that key has a daily
      limit, the keys it made share it, so each needs --daily-limit. Without a
      saved key, or with --browser, it prints a link and a code and an account
      owner approves the key in the browser. The key is printed once, alone on
      stdout, and lasts until revoked. --json prints it as JSON, still alone on
      stdout. --account-wide makes a key that sees and uses every sandbox and
      other resource in the account; without it, a key sees only what it makes.
  create --sandbox <id,...> --actions <action,...> [--name <name>] [--daily-limit <usd>] [--browser]
      A key limited to those sandboxes (up to 20, by id, whichever key made
      them) and those actions on them, made by the saved key, or with no saved
      key (or --browser) approved by an owner or admin in the browser, as
      above: get reads them; create starts, wakes and
      restarts them, and needs --daily-limit when the making key has one; stop
      stops and pauses them; exec runs commands; read_file and write_file reach
      their files. It is served nothing else: no list, no other sandbox, no
      account route, no MCP.
  ls                      This key and the keys it made, with what each spent today
  usage <keyId>           What one of them has spent and holds
  revoke <keyId>          Revoke one: a worker's key when the worker is done

  runtime keys create --name worker-1 --daily-limit 5
  runtime keys create --name ci --daily-limit 25 --browser | gh secret set RUNTIME_API_KEY
  runtime keys create --name watcher --sandbox sbx_id --actions get,create --daily-limit 2
  runtime keys create --name helper --sandbox sbx_a,sbx_b --actions get,exec,read_file,write_file --browser

Making, listing and revoking keys with a key needs one an owner or admin made.
Every key is also at https://withruntime.com/account/keys.
`;

/* `runtime keys`: a key made from the terminal, by this machine's key with no
   browser (14 October 2026), or approved in the browser
   (23 September 2026; ARCHITECTURE.md section 10, "Keys from the
   terminal"). Only the options the keys page offers. */
/* `runtime account`: the accounts this machine is connected to, and which one
   every command uses (ARCHITECTURE.md section 3.9). Each is its own saved
   connection with its own key; the SDK itself stays key-based. */
async function accountCommand(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  product = "account";
  const [verb = "ls", ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const store = connectionStore(env);
  if (verb === "add") {
    const { authenticationCommand } = await import("./login.js");
    const result = await authenticationCommand(["login", "--another-account", ...rest], env);
    if (result.pending) throw notApprovedYet(result);
    await nameSaved(env);
    print(
      `Connected${"orgId" in result && result.orgId ? ` to ${String(result.orgId)}` : ""}.`,
      result,
    );
    return 0;
  }
  if (verb === "switch" || verb === "use") {
    const which = rest.join(" ").trim();
    if (!which) throw usage(`Name the account: ${me} account switch <name|id>.`);
    if (env.RUNTIME_API_KEY)
      throw usage("RUNTIME_API_KEY is set, and it names one account. Unset it to switch.");
    const chosen = await store.use(which);
    if (!chosen)
      throw usage(
        `No saved connection for "${which}". Run \`${me} account\` to list them, or \`${me} account add\` to connect it.`,
      );
    print(`Now using ${chosen.orgName ?? chosen.orgId}.`, {
      orgId: chosen.orgId,
      orgName: chosen.orgName ?? null,
    });
    return 0;
  }
  if (verb === "close") {
    /* ARCHITECTURE.md section 3.1: an owner's key for every product, and the
       account's name typed exactly. Nothing is asked twice: --confirm is the
       confirmation, as the website's typed name is. */
    const args = parse(rest, [], ["confirm"]);
    for (const name of args.flags.keys())
      if (name !== "confirm") throw usage(`Unknown option --${name}.`);
    const confirm = flag(args, "confirm");
    const runtime = await client(env);
    if (!confirm) {
      const who = await runtime.me();
      throw usage(
        `Closing stops and deletes everything in the account, ends every key and cannot be undone. To go ahead, type its name: ${me} account close --confirm "${who.orgName ?? "<account name>"}".`,
      );
    }
    const closed = await runtime.account.close({ confirm });
    // This machine's key died with the account.
    if (!env.RUNTIME_API_KEY) await store.remove().catch(() => undefined);
    print(
      [
        `Closed ${closed.name}. Every key has stopped working.`,
        closed.released
          ? "Nothing was left running or stored."
          : "What was still running is stopping, and everything stored is being deleted.",
        "Credit bought in the last 15 days and not spent is refunded on request: write to support@withruntime.com.",
      ].join("\n"),
      closed,
    );
    return 0;
  }
  if (verb === "emails") {
    /* 0921: which of Runtime's optional emails this key's person gets.
       Bare, it lists them; `<category> on|off` changes one, for that person
       only. */
    const [category, state, ...extra] = rest;
    const categories = ["own-deletions", "billing", "usage", "tips"] as const;
    if (extra.length || (category && !state) || (state && state !== "on" && state !== "off"))
      throw usage(`${me} account emails [<${categories.join("|")}> on|off]`);
    if (category && !(categories as readonly string[]).includes(category))
      throw unknown("email", category, [...categories]);
    const runtime = await client(env);
    const settings = await runtime.account.emails(
      category
        ? { category: category as (typeof categories)[number], enabled: state === "on" }
        : undefined,
    );
    print(
      [
        ...settings.map((each) => `${each.category.padEnd(14)}${each.enabled ? "on" : "off"}`),
        "Always sent: sign-in, invitations, revoked keys, support replies, credit expiry, service credits, and deletions Runtime decides.",
      ].join("\n"),
      { settings },
    );
    return 0;
  }
  if (verb !== "ls" && verb !== "list")
    throw unknown("account command", verb, ["ls", "switch", "add", "close", "emails"]);
  await nameSaved(env).catch(() => undefined);
  const current = await store.read().catch(() => null);
  const saved = [
    ...(current ? [{ ...current, current: true }] : []),
    ...(await store.others()).map((one) => ({ ...one, current: false })),
  ];
  const rows = saved.map((one) => ({
    orgId: one.orgId,
    orgName: one.orgName ?? null,
    agentName: one.agentName,
    current: one.current,
  }));
  print(
    rows.length
      ? table([
          ["", "account", "id", "agent"],
          ...rows.map((row) => [
            row.current ? "*" : "",
            row.orgName ?? "-",
            row.orgId,
            row.agentName,
          ]),
        ])
      : `Not connected. Run \`${me} login\`.`,
    { accounts: rows, environmentKey: Boolean(env.RUNTIME_API_KEY) },
  );
  return 0;
}

/** Fill in the saved connection's account name from the API, once. */
async function nameSaved(env: NodeJS.ProcessEnv) {
  if (env.RUNTIME_API_KEY) return;
  const store = connectionStore(env);
  const saved = await store.read();
  if (!saved || saved.orgName) return;
  const who = await new Runtime({
    apiKey: saved.key,
    baseUrl: env.RUNTIME_API_URL,
    maxRetries: 1,
  }).me();
  if (who.orgName && who.orgId === saved.orgId) {
    const again = await store.read();
    if (again && again.key === saved.key) await store.save({ ...again, orgName: who.orgName });
  }
}

const RESERVATIONS_HELP = `runtime reservations <command>

  book --sandboxes <n> --from <time> --to <time> [--vcpu <n>] [--memory <MiB>]
       [--disk <MiB>] [--region <region>]
      Hold room for n sandboxes of one size for a window of up to 24 hours that
      starts within 14 days. The answer is at once: booked, or declined with
      the most that fits and the nearest window that fits all of them (exit
      code 1). In the window, creates are never refused for room or limits up
      to what you booked. Sandboxes you run bill as usual; booked room none
      of them uses costs a quarter of the memory rate, and the answer says the
      most that comes to if none run. A time is an ISO time, now, or HH:MM on this machine's clock: today, or tomorrow when it
      has passed. --to before --from means the next day.
  keep --sandboxes <n> [--snapshot <id>]... [--for-key] [--vcpu <n>]
       [--memory <MiB>] [--disk <MiB>] [--region <region>]
      Standing room: hold room for n sandboxes from now until you cancel it,
      for a pool that deletes a sandbox after each use and makes another.
      With --snapshot, on the servers holding those snapshots, at their size.
      --for-key keeps it for this key's sandboxes alone. Room none of them
      uses costs a quarter of the memory rate every hour it is held.
  change <id> [--sandboxes <n>] [--snapshot <id>]...
      Change standing room in place; it moves or grows only when all of it fits.
  ls [--limit <n>] [--before <next>]
                          Your bookings, newest first
  get <id>                One booking, with how much of it is in use
  cancel <id>             Give the room back

  runtime reservations book --sandboxes 300 --from 21:00 --to 23:00
  runtime reservations book --sandboxes 50 --vcpu 4 --memory 8192 --from now --to 02:00
  runtime reservations keep --sandboxes 40 --snapshot <id> --for-key

A booking is the whole account's: a compartment's key cannot book or read one.
`;

/** A booking's time on the command line: an ISO time, `now`, or HH:MM on this
 * machine's clock. HH:MM is the next such time at or after `after` (the
 * window's start for `--to`, so an end before the start is the next day, and
 * `now` for `--from`: today, or tomorrow once it has passed). */
export function bookingTime(name: string, value: string, now: number, after: number = now): Date {
  if (value === "now") return new Date(now);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) {
    const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
    if (hours > 23 || minutes > 59) throw usage(`--${name} ${value} is not a time of day.`);
    const at = new Date(after);
    at.setHours(hours, minutes, 0, 0);
    // A start a minute or less ago still reads as now; the server treats it so.
    if (at.getTime() < after - (after === now ? 60_000 : 0)) at.setDate(at.getDate() + 1);
    return at;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at))
    throw usage(
      `--${name} takes an ISO time such as 2026-10-17T21:00:00Z, HH:MM or now; got ${value}.`,
    );
  return new Date(at);
}

/** The words for a booking: the line for a confirmed one, the server's message
 * and what would fit for a declined one. */
function bookingText(b: RoomBooking): string {
  if (b.standing) {
    const where = b.snapshots.length ? " on the servers holding its snapshots" : "";
    const whose = b.forKey ? " for this key" : "";
    if (b.status === "confirmed") {
      const unused =
        b.unusedRateMicros !== "0"
          ? ` Room none of your sandboxes uses costs $${Number(b.unusedRateMicros) / 1e6} per GiB-hour: at most $${(Math.ceil(Number(b.unusedPerHourMicros) / 10_000) / 100).toFixed(2)} an hour if none run.`
          : "";
      return `Holding ${b.sandboxes} sandboxes (${b.vcpu} vCPU, ${b.memoryMiB} MiB) in ${b.region}${where}${whose} until you cancel; ${b.inUse} in use. Creates up to that are never refused for room or limits.${unused} id ${b.id}`;
    }
    if (b.status === "cancelled")
      return `Cancelled the standing room for ${b.sandboxes} sandboxes in ${b.region}. id ${b.id}`;
    return [b.message, `Largest that fits: ${b.largestSandboxes} sandboxes.`].join("\n");
  }
  const window = `from ${new Date(b.startsAt).toLocaleString()} to ${new Date(b.endsAt!).toLocaleString()}`;
  if (b.status === "confirmed") {
    const booked = `Booked ${b.sandboxes} sandboxes (${b.vcpu} vCPU, ${b.memoryMiB} MiB) in ${b.region} ${window}. Creates in the window are never refused for room or limits up to that.`;
    // Bookings made before unused room had a price are never charged for it.
    const unused =
      b.unusedRateMicros && b.unusedRateMicros !== "0"
        ? ` Room none of your sandboxes uses costs $${Number(b.unusedRateMicros) / 1e6} per GiB-hour: at most $${(Math.ceil(Number(b.unusedMaxMicros) / 10_000) / 100).toFixed(2)} if none run, nothing if cancelled at least an hour before the start.`
        : "";
    return `${booked}${unused} id ${b.id}`;
  }
  if (b.status === "cancelled")
    return `Cancelled the booking of ${b.sandboxes} sandboxes in ${b.region} ${window}. id ${b.id}`;
  return [
    b.message,
    `Largest that fits: ${b.largestSandboxes} sandboxes.`,
    b.nearestWindow
      ? `Nearest window for all ${b.sandboxes}: from ${new Date(b.nearestWindow.startsAt).toLocaleString()} to ${new Date(b.nearestWindow.endsAt).toLocaleString()}.`
      : `No window in the next 14 days holds all ${b.sandboxes}.`,
  ].join("\n");
}

async function reservationsCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
): Promise<number> {
  product = "reservations";
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    print(named(RESERVATIONS_HELP), { usage: named(RESERVATIONS_HELP) });
    return 0;
  }
  if (verb === "book") {
    const args = parse(rest, [], ["sandboxes", "from", "to", "vcpu", "memory", "disk", "region"]);
    const count = integer(args, "sandboxes");
    const from = flag(args, "from");
    const to = flag(args, "to");
    if (count === undefined || !from || !to || args.positional.length)
      throw usage(
        `Usage: ${named("runtime reservations book --sandboxes <n> --from <time> --to <time>")}`,
      );
    const now = Date.now();
    const startsAt = bookingTime("from", from, now);
    const endsAt = bookingTime("to", to, now, startsAt.getTime());
    const vcpu = integer(args, "vcpu");
    const memoryMiB = integer(args, "memory");
    const diskMiB = integer(args, "disk");
    const region = flag(args, "region");
    const booking = await (
      await client(env)
    ).reservations.create({
      sandboxes: count,
      startsAt,
      endsAt,
      ...(vcpu !== undefined ? { vcpu } : {}),
      ...(memoryMiB !== undefined ? { memoryMiB } : {}),
      ...(diskMiB !== undefined ? { diskMiB } : {}),
      ...(region ? { region } : {}),
    });
    print(bookingText(booking), booking);
    return booking.status === "declined" ? 1 : 0;
  }
  if (verb === "keep") {
    const args = parse(
      rest,
      ["for-key"],
      ["sandboxes", "snapshot", "vcpu", "memory", "disk", "region"],
    );
    const count = integer(args, "sandboxes");
    if (count === undefined || args.positional.length)
      throw usage(
        `Usage: ${named("runtime reservations keep --sandboxes <n> [--snapshot <id>]...")}`,
      );
    const vcpu = integer(args, "vcpu");
    const memoryMiB = integer(args, "memory");
    const diskMiB = integer(args, "disk");
    const region = flag(args, "region");
    const snapshots = args.flags.get("snapshot") ?? [];
    const booking = await (
      await client(env)
    ).reservations.keep({
      sandboxes: count,
      ...(snapshots.length ? { snapshots } : {}),
      ...(has(args, "for-key") ? { forKey: true } : {}),
      ...(vcpu !== undefined ? { vcpu } : {}),
      ...(memoryMiB !== undefined ? { memoryMiB } : {}),
      ...(diskMiB !== undefined ? { diskMiB } : {}),
      ...(region ? { region } : {}),
    });
    print(bookingText(booking), booking);
    return booking.status === "declined" ? 1 : 0;
  }
  if (verb === "change") {
    const args = parse(rest, [], ["sandboxes", "snapshot"]);
    const id = args.positional[0];
    const count = integer(args, "sandboxes");
    const snapshots = args.flags.get("snapshot");
    if (!id || args.positional.length > 1 || (count === undefined && !snapshots?.length))
      throw usage(
        `Usage: ${named("runtime reservations change <id> [--sandboxes <n>] [--snapshot <id>]...")}`,
      );
    const booking = await (
      await client(env)
    ).reservations.update(id, {
      ...(count !== undefined ? { sandboxes: count } : {}),
      ...(snapshots?.length ? { snapshots } : {}),
    });
    print(bookingText(booking), booking);
    return 0;
  }
  if (verb === "ls" || verb === "list") {
    const args = parse(rest, [], ["limit", "before"]);
    if (args.positional.length) throw usage(`Usage: ${named("runtime reservations ls")}`);
    const limit = integer(args, "limit");
    const cursor = flag(args, "before");
    const page = await (
      await client(env)
    ).reservations.list({
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
    });
    print(
      page.items.length
        ? table([
            ["ID", "STATE", "SANDBOXES", "SIZE", "REGION", "FROM", "TO", "IN USE"],
            ...page.items.map((b) => [
              b.id,
              b.status === "confirmed" ? (b.phase ?? "confirmed") : b.status,
              String(b.sandboxes),
              `${b.vcpu} vCPU, ${b.memoryMiB} MiB`,
              b.region,
              new Date(b.startsAt).toLocaleString(),
              b.endsAt ? new Date(b.endsAt).toLocaleString() : "until cancelled",
              b.status === "confirmed" ? `${b.inUse} (peak ${b.peakInUse})` : "-",
            ]),
          ]) + (page.nextCursor ? `\nMore: ${me} reservations ls --before ${page.nextCursor}` : "")
        : "No bookings.",
      page,
    );
    return 0;
  }
  if (verb === "get" || verb === "cancel") {
    const args = parse(rest, [], []);
    const id = args.positional[0];
    if (!id || args.positional.length > 1)
      throw usage(`Usage: ${named(`runtime reservations ${verb} <id>`)}`);
    const api = (await client(env)).reservations;
    const booking = await (verb === "get" ? api.get(id) : api.cancel(id));
    print(
      bookingText(booking) +
        (verb === "get" && booking.status === "confirmed"
          ? `\nIn use now: ${booking.inUse} (peak ${booking.peakInUse}). Estimate at most ${usdOf(booking.estimateMicros)}.`
          : ""),
      booking,
    );
    return 0;
  }
  throw unknown("reservations command", verb, ["book", "keep", "change", "ls", "get", "cancel"]);
}

/** Dollars from integer microdollars, for a person to read: "$5.00". */
const usdOf = (micros: number | string) =>
  `$${(Number(BigInt(micros) / 10_000n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function keys(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  product = "keys";
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    out.write(out.json ? JSON.stringify({ usage: named(KEYS_HELP) }) : named(KEYS_HELP));
    return 0;
  }
  if (verb === "ls" || verb === "list") {
    const args = parse(rest, [], []);
    if (args.flags.size || args.positional.length)
      throw usage(`Usage: ${named("runtime keys ls")}`);
    const all = await (await client(env)).keys.list();
    print(
      all.length
        ? table([
            ["KEY", "NAME", "ACCESS", "REACH", "DAILY LIMIT", "LAST 24H", "MADE BY", "STATE"],
            ...all.map((k) => [
              k.keyId,
              k.name,
              k.access,
              k.reach,
              k.dailyLimitMicros === null ? "none" : usdOf(k.dailyLimitMicros),
              usdOf(k.dailyUsedMicros),
              k.madeBy ?? "website",
              k.revokedAt ? "revoked" : "live",
            ]),
          ])
        : "No keys.",
      all,
    );
    return 0;
  }
  if (verb === "revoke" || verb === "rm" || verb === "usage") {
    const args = parse(rest, [], []);
    const id = args.positional[0];
    if (!id || args.positional.length > 1 || args.flags.size)
      throw usage(`Usage: ${named(`runtime keys ${verb} <keyId>`)}`);
    const api = (await client(env)).keys;
    if (verb === "usage") {
      const used = await api.usage(id);
      print(
        [
          `${used.name} (${used.keyId})${used.revokedAt ? ", revoked" : ""}`,
          `  last 24 hours  ${usdOf(used.dailyUsedMicros)}${used.dailyLimitMicros === null ? "" : ` of ${usdOf(used.dailyLimitMicros)}`}`,
          `  spent          ${usdOf(used.spentMicros)}`,
          `  held now       ${usdOf(used.heldMicros)}`,
          `  sandboxes      ${used.runningSandboxes} running, ${used.resources} kept in all`,
        ].join("\n"),
        used,
      );
      return 0;
    }
    const revoked = await api.revoke(id);
    print(`Revoked ${revoked.keyId}. It stops working within ten seconds.`, revoked);
    return 0;
  }
  if (verb !== "create") throw unknown("keys command", verb, ["create", "ls", "usage", "revoke"]);
  const args = parse(
    rest,
    ["read-only", "account-wide", "browser"],
    ["name", "daily-limit", "sandbox", "actions"],
  );
  const known = new Set([
    "name",
    "read-only",
    "daily-limit",
    "account-wide",
    "browser",
    "sandbox",
    "actions",
  ]);
  for (const name of args.flags.keys())
    if (!known.has(name)) throw usage(`Unknown option --${name}.`);
  if (args.positional.length || args.rest) throw usage(`Unexpected ${args.positional[0] ?? "--"}.`);
  const readOnly = has(args, "read-only");
  const limit = flag(args, "daily-limit");
  if (flag(args, "sandbox") !== undefined || flag(args, "actions") !== undefined)
    return limitedKey(args, env, out, limit === undefined ? null : limit);
  if (readOnly && limit !== undefined)
    throw usage("A read-only key cannot spend, so it takes no --daily-limit.");
  if (readOnly && has(args, "account-wide"))
    throw usage("A read-only key already sees the whole account, so it takes no --account-wide.");
  const { createKey, dailyLimitMicros } = await import("./keys.js");
  const request = {
    name: flag(args, "name") ?? (readOnly ? "Read-only key" : "My API key"),
    access: readOnly ? ("read" as const) : ("full" as const),
    ...(has(args, "account-wide") ? { reach: "account" as const } : {}),
    dailyLimitMicros: limit === undefined ? null : dailyLimitMicros(limit),
  };
  /* A key on this machine makes the new one itself, with no browser: an
     agent with no person, a swarm's coordinator (14 October 2026). */
  const saved = has(args, "browser")
    ? null
    : env.RUNTIME_API_KEY || (await connectionStore(env).read())?.key || null;
  let key:
    | Awaited<ReturnType<typeof createKey>>
    | (Awaited<ReturnType<Runtime["keys"]["create"]>> & { confirm?: undefined });
  if (saved) {
    key = await new Runtime({
      apiKey: saved,
      baseUrl: env.RUNTIME_API_URL,
      maxRetries: 4,
    }).keys.create({
      name: request.name,
      access: request.access,
      reach: request.reach ?? "agent",
      dailyLimitMicros: request.dailyLimitMicros,
    });
  } else key = await createKey(request, env, { notify: out.error });
  const { confirm, ...made } = key;
  out.write(out.json ? JSON.stringify(made) : made.key);
  const terms = [
    made.access === "read" ? "read only" : "full access",
    made.reach === "account" ? "account-wide" : undefined,
    made.access === "read"
      ? undefined
      : made.dailyLimitMicros === null
        ? "no daily limit"
        : `daily limit ${usdOf(made.dailyLimitMicros)}`,
    made.expires ? `until ${made.expires}` : "until revoked",
  ].filter(Boolean);
  out.error(
    saved
      ? `Created key "${made.name}" (${terms.join(", ")}), made by this machine's key. Store it now: it is not shown again, and Runtime keeps only a hash of it.\nGive it to one worker as RUNTIME_API_KEY; revoke it with ${named("runtime keys revoke")} ${made.keyId} when that worker is done.`
      : `Created key "${made.name}" (${terms.join(", ")}). Store it now: it is not shown again, and Runtime keeps only a hash of it.\nIn CI, give it to your jobs as RUNTIME_API_KEY from the secret store.`,
  );
  await confirm?.();
  return 0;
}

/** `runtime keys create --sandbox ... --actions ...`: a key limited to
 * sandboxes, made by the saved key, or, with no key on this machine or with
 * --browser, asked for and approved by an owner or admin in the browser
 * (0921): an agent whose person reaches Runtime only through a connector
 * holds no key to make one with. */
async function limitedKey(
  args: ReturnType<typeof parse>,
  env: NodeJS.ProcessEnv,
  out: Out,
  limit: string | null,
): Promise<number> {
  for (const refused of ["read-only", "account-wide"])
    if (has(args, refused))
      throw usage(`A key limited to sandboxes reaches only them, so it takes no --${refused}.`);
  const list = (name: string) =>
    (flag(args, name) ?? "")
      .split(",")
      .map((each) => each.trim())
      .filter(Boolean);
  const sandboxes = list("sandbox");
  const actions = list("actions");
  if (!sandboxes.length || !actions.length)
    throw usage(
      `Usage: ${named("runtime keys create --sandbox <id,...> --actions <get,create,stop,exec,read_file,write_file> [--daily-limit <usd>]")}`,
    );
  const { createKey, dailyLimitMicros } = await import("./keys.js");
  const request = {
    name: flag(args, "name") ?? "Sandbox key",
    sandboxes,
    actions: actions as LimitedKeyAction[],
    dailyLimitMicros: limit === null ? null : dailyLimitMicros(limit),
  };
  const saved = has(args, "browser")
    ? null
    : env.RUNTIME_API_KEY || (await connectionStore(env).read())?.key || null;
  const asked = saved
    ? null
    : await createKey({ ...request, access: "full" }, env, { notify: out.error });
  const made = asked
    ? { ...asked, sandboxes, actions }
    : await new Runtime({
        apiKey: saved!,
        baseUrl: env.RUNTIME_API_URL,
        maxRetries: 4,
      }).keys.create(request);
  const { confirm, ...shown } = made as typeof made & { confirm?: () => Promise<void> };
  out.write(out.json ? JSON.stringify(shown) : shown.key);
  out.error(
    `Created key "${shown.name}", limited to ${shown.sandboxes?.length === 1 ? "sandbox" : "sandboxes"} ${(shown.sandboxes ?? []).join(", ")} for ${(shown.actions ?? []).join(", ")}${shown.dailyLimitMicros === null ? "" : `, daily limit ${usdOf(shown.dailyLimitMicros)}`}, ${saved ? "made by this machine's key" : "approved in the browser"}. Store it now: it is not shown again.\nIt calls those sandboxes by id and nothing else; revoke it at https://withruntime.com/account/keys${saved ? ` or with ${named("runtime keys revoke")} ${shown.keyId}` : ""}.`,
  );
  await confirm?.();
  return 0;
}

const SNAPSHOT_HELP = `runtime snapshots <command>

  ls [--sandbox <id>] [--name n]              Your snapshots
  get <id>                                    One snapshot
  extend <id> <days|credit>                   Keep it longer; credit: while you have credit
  rm <id>                                     Delete it
  Take one with \`runtime sandboxes snapshot <sandboxId>\`; start a sandbox from it
  with \`runtime sandboxes create --snapshot <snapshotId>\`.
`;

async function snapshot(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(SNAPSHOT_HELP), { usage: named(SNAPSHOT_HELP) });
    return 0;
  }
  const api = (await client(env)).snapshots;
  switch (verb) {
    case "ls":
    case "list": {
      const args = parse(rest, [], ["sandbox", "name"]);
      const all = await (
        await api.list({
          ...(flag(args, "sandbox")
            ? { sandboxId: await sandboxIdOf(await client(env), flag(args, "sandbox")!) }
            : {}),
          ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
        })
      ).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "NAME", "STATUS", "FROM", "EXPIRES"],
              ...all.map((s) => [
                s.id,
                s.name ?? "-",
                s.status,
                s.sourceSandboxId,
                s.expiresAt ?? "with credit",
              ]),
            ])
          : "No snapshots. Take one: runtime sandboxes snapshot <sandboxId>",
        all,
      );
      return 0;
    }
    case "get": {
      const found = await api.get(need(rest[0], "a snapshot id"));
      print((await import("./cli-extras.js")).describeSnapshot(found, table), found);
      return 0;
    }
    case "extend": {
      const word = parse(rest.slice(1), [], ["days"]);
      const days =
        daysOrCredit(word, "days") ??
        (need(rest[1], "days") === "credit" ? null : Number(need(rest[1], "days")));
      const found = await api.extend(need(rest[0], "a snapshot id"), days);
      print(
        `${found.id} kept ${found.expiresAt === null ? "while you have credit" : `until ${found.expiresAt}`}`,
        found,
      );
      return 0;
    }
    case "rm":
    case "delete": {
      const id = need(rest[0], "a snapshot id");
      await api.delete(id);
      print(`Deleted ${id}.`, { id, deleted: true });
      return 0;
    }
  }
  throw unknown("snapshot command", verb, ["ls", "get", "extend", "rm"]);
}

const IMAGE_HELP = `runtime images <command>

  build [<folder>] [--dockerfile|-f <Dockerfile>] | --from <image> | --pip <pkg>... --apt <pkg>... --npm <pkg>...
        [--name <name>] [--tag|-t name[:tag]]... [--target <stage>] [--build-arg K=V]... [--no-cache]
        [--start <command>] [--ready-port <port> | --ready-command <command>]
        [--max-image-mib 8192] [--disk-mib <1024-32768>] [--timeout <seconds>] [--keep <n>]
                        Build and stream the log; prints the image id when ready.
                        --disk-mib sizes the build's scratch disk, where earlier
                        stages and the context live. --keep, once it is ready,
                        deletes the name's older versions but the newest n
                        (this one among them) and any an App still needs.
                        The folder is the context (without one, the
                        Dockerfile's own folder): everything its .dockerignore
                        leaves in (100 MiB compressed at most) is sent, and a
                        rebuild sends only what changed. -f is read from where
                        you run the command, as docker build reads it.
  ls                    Your images
  versions <name>       Every version of a name, newest first
  get <image>           One image: an id, name, name:tag or name@version
  logs <image> [--follow] [--raw]
                        Its build log; on a terminal control characters
                        show as \\uXXXX unless --raw
  tag <image> <tag>     Point a tag of the image's name at this version
  untag <image> <tag>   Take a tag off
  rm <image>            Delete that version and its tags
  registry ls           Registries you keep credentials for
  registry set <registry> --username <user>
                        Store credentials to pull private images; the token or
                        password is read from standard input and never shown again
  registry set <ecr registry> --access-key-id <id>
                        Amazon ECR: the secret access key is read from standard input
  registry rm <registry>
  Use one: runtime sandboxes create --image app:latest
`;

/** Options `image build` takes with a value. */
const IMAGE_BUILD_VALUES = [
  "f",
  "file",
  "dockerfile",
  "from",
  "pip",
  "apt",
  "npm",
  "t",
  "tag",
  "name",
  "target",
  "build-arg",
  "start",
  "ready-port",
  "ready-command",
  "ready-timeout",
  "max-image-mib",
  "disk-mib",
  "timeout",
  "keep",
];

/** `images build --keep n`: the name's versions older than its newest n,
 * deleted once `built` is ready, so a name rebuilt on each merge does not keep
 * every version (21 October 2026: our website's App, rebuilt from main on
 * each merge, held 221 images on one server, 24 GiB more a day). A
 * version an App still needs is refused by the API (image_in_use) and kept; a
 * build still running is never touched; any other failure is said and kept,
 * since the build itself is done. */
async function keepNewest(
  api: Awaited<ReturnType<typeof client>>["images"],
  built: Image,
  keep: number,
  out: Out,
): Promise<{ deleted: string[]; kept: { id: string; code: string }[] }> {
  // Newest first; the build just made is never among those deleted, even when
  // a later build of the name finished first.
  const older = (await (await api.list({ name: built.name!, limit: 100 })).toArray(Infinity))
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
    .slice(keep)
    .filter(
      (image) => image.id !== built.id && (image.state === "ready" || image.state === "failed"),
    );
  const deleted: string[] = [];
  const kept: { id: string; code: string }[] = [];
  for (const image of older) {
    const named = `${image.name}@${image.version}`;
    try {
      await api.delete(image.id);
      deleted.push(image.id);
      if (!out.json) out.error(`Deleted ${named}`);
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      kept.push({ id: image.id, code: error.code });
      if (!out.json) out.error(`Kept ${named}: ${error.message}`);
    }
  }
  return { deleted, kept };
}

export async function imageCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
  /** Tests give the registry secret here; the CLI reads standard input. */
  read: () => Promise<string> = readSecret,
): Promise<number> {
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(IMAGE_HELP), { usage: named(IMAGE_HELP) });
    return 0;
  }
  const api = (await client(env)).images;
  switch (verb) {
    case "build": {
      const args = parse(rest, ["no-cache"], IMAGE_BUILD_VALUES);
      const list = (name: string) =>
        (args.flags.get(name) ?? []).flatMap((value) => value.split(/[\s,]+/)).filter(Boolean);
      const recipe = { apt: list("apt"), pip: list("pip"), npm: list("npm") };
      const hasRecipe = recipe.apt.length + recipe.pip.length + recipe.npm.length > 0;
      const dockerfile = flag(args, "dockerfile") ?? flag(args, "file") ?? flag(args, "f");
      const folder = args.positional[0];
      const fromDockerfile = dockerfile !== undefined || folder !== undefined;
      const sources = [fromDockerfile || undefined, flag(args, "from"), hasRecipe || undefined];
      if (sources.filter((s) => s !== undefined).length !== 1)
        throw usage(
          "Give exactly one of a folder with a Dockerfile (or -f <Dockerfile>), --from <image>, or --pip/--apt/--npm.",
        );
      const build = {
        ...(integer(args, "max-image-mib") !== undefined
          ? { maxImageMiB: integer(args, "max-image-mib")! }
          : {}),
        ...(integer(args, "disk-mib") !== undefined ? { diskMiB: integer(args, "disk-mib")! } : {}),
        ...(integer(args, "timeout") !== undefined
          ? { timeoutSeconds: integer(args, "timeout")! }
          : {}),
      };
      // -t app, -t app:v2 -t app:latest: one name, its tags.
      let name = flag(args, "name");
      const tags: string[] = [];
      for (const tagged of [...(args.flags.get("t") ?? []), ...(args.flags.get("tag") ?? [])]) {
        const [repository, tag] = tagged.split(":");
        if (!repository) throw usage("-t takes name or name:tag.");
        if (name !== undefined && name !== repository)
          throw usage("Every -t names the same image; give one name and several tags.");
        name = repository;
        if (tag) tags.push(tag);
      }
      const start = {
        ...(flag(args, "start") ? { command: flag(args, "start")! } : {}),
        ...(integer(args, "ready-port") !== undefined
          ? { readyPort: integer(args, "ready-port")! }
          : {}),
        ...(flag(args, "ready-command") ? { readyCommand: flag(args, "ready-command")! } : {}),
        ...(integer(args, "ready-timeout") !== undefined
          ? { readyTimeoutSeconds: integer(args, "ready-timeout")! }
          : {}),
      };
      const common = {
        ...(name ? { name } : {}),
        ...(tags.length ? { tags } : {}),
        ...(Object.keys(build).length ? { build } : {}),
        ...(Object.keys(start).length ? { start } : {}),
        ...(has(args, "no-cache") ? { cache: false } : {}),
      };
      let input: Parameters<typeof api.build>[0];
      if (fromDockerfile) {
        const context = resolve(folder ?? dirname(dockerfile!));
        // -f is read from where the command runs, as `docker build` reads it;
        // a path inside the folder still works, as it always has. Before, a
        // relative -f was read inside the folder only, and without a folder
        // twice over: apps/web/apps/web/Dockerfile (18 October 2026).
        const files = dockerfile
          ? [...new Set([resolve(dockerfile), resolve(context, dockerfile)])]
          : [join(context, "Dockerfile")];
        let file = files[0]!;
        let text: string | undefined;
        for (const candidate of files) {
          text = await readFile(candidate, "utf8").catch(() => undefined);
          if (text !== undefined) {
            file = candidate;
            break;
          }
        }
        if (text === undefined) throw usage(`No Dockerfile at ${files.join(" or ")}.`);
        if (!out.json && file !== join(context, "Dockerfile"))
          out.error(`Using the Dockerfile ${file}`);
        input = {
          ...common,
          dockerfile: text,
          contextDir: context,
          ...(flag(args, "target") ? { target: flag(args, "target")! } : {}),
          ...(args.flags.get("build-arg") ? { buildArgs: pairs(args, "build-arg") } : {}),
        };
        if (!out.json) out.error(`Sending the build context from ${context}`);
      } else if (flag(args, "from")) input = { ...common, image: flag(args, "from")! };
      else
        input = {
          ...common,
          recipe: Object.fromEntries(Object.entries(recipe).filter(([, v]) => v.length)),
        };
      const keep = integer(args, "keep");
      if (keep !== undefined && (keep < 1 || !name))
        throw usage("--keep takes 1 or more, and a --name or -t for the versions it keeps.");
      const built = await api.build(input, {
        ...(out.json ? {} : { onLog: (line) => out.error(line.text) }),
      });
      if (keep === undefined) {
        print(built.id, built);
        return 0;
      }
      const kept = await keepNewest(api, built, keep, out);
      print(built.id, { ...built, ...kept });
      return 0;
    }
    case "ls":
    case "list":
    case "versions": {
      const name = verb === "versions" ? need(rest[0], "a name") : undefined;
      const all = await (await api.list(name ? { name } : {})).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "NAME", "VERSION", "TAGS", "STATE", "MIB", "CREATED"],
              ...all.map((i) => [
                i.id,
                i.name ?? "-",
                i.version === null || i.version === undefined ? "-" : String(i.version),
                i.tags?.length ? i.tags.join(",") : "-",
                i.state,
                String(i.sizeMiB ?? "-"),
                i.createdAt,
              ]),
            ])
          : name
            ? `No versions of ${name}.`
            : "No images. Build one: runtime images build --pip pandas",
        all,
      );
      return 0;
    }
    case "get": {
      const found = await api.resolve(need(rest[0], "an image"));
      print(describeRecord(found, table), found);
      return 0;
    }
    case "logs": {
      const args = parse(rest, ["follow", "f", "raw"], []);
      const id = (await api.resolve(need(args.positional[0], "an image"))).id;
      const shown = logText(args);
      if (has(args, "follow") || has(args, "f")) {
        const lines: string[] = [];
        const done = await api.followLogs(id, (line) =>
          out.json ? lines.push(line.text) : out.write(shown(line.text)),
        );
        if (out.json) out.write(shown(JSON.stringify({ lines, state: done.state })));
        return done.state === "failed" ? 1 : 0;
      }
      let after = 0;
      const lines: string[] = [];
      for (;;) {
        const page = await api.logs(id, after);
        lines.push(...page.lines.map((line) => line.text));
        if (!page.lines.length || page.nextAfter === after) break;
        after = page.nextAfter;
      }
      out.write(shown(out.json ? JSON.stringify(lines) : lines.join("\n") || "(no log yet)"));
      return 0;
    }
    case "tag":
    case "untag": {
      const ref = need(rest[0], "an image");
      const tag = need(rest[1], "a tag");
      const found = verb === "tag" ? await api.tag(ref, tag) : await api.untag(ref, tag);
      print(
        `${found.name ?? found.id}@${found.version ?? "-"} tags: ${found.tags.join(", ") || "none"}`,
        found,
      );
      return 0;
    }
    case "rm":
    case "delete": {
      const found = await api.delete(need(rest[0], "an image"));
      print(`${found.id} ${found.state}`, found);
      return 0;
    }
    case "registry":
    case "registries": {
      const [action, ...more] = rest;
      if (action === "ls" || action === "list" || action === undefined) {
        const all = await api.registries.list();
        print(
          all.length
            ? table([
                ["REGISTRY", "KIND", "USER", "SINCE"],
                ...all.map((r) => [r.registry, r.kind, r.username, r.createdAt]),
              ])
            : "No registry credentials. Store some: runtime images registry set ghcr.io --username you",
          all,
        );
        return 0;
      }
      if (action === "set") {
        const args = parse(more, [], ["username", "access-key-id"]);
        const registry = need(args.positional[0], "a registry, such as ghcr.io");
        const accessKeyId = flag(args, "access-key-id");
        if (accessKeyId === undefined && flag(args, "username") === undefined)
          throw usage("Give --username (or --access-key-id for Amazon ECR).");
        if (!out.json && process.stdin.isTTY)
          out.error(accessKeyId ? "The secret access key:" : "The token or password:");
        const secret = await read();
        if (!secret) throw usage("Nothing on standard input.");
        const saved = await api.registries.set(
          accessKeyId
            ? { registry, accessKeyId, secretAccessKey: secret }
            : { registry, username: flag(args, "username")!, password: secret },
        );
        print(`Stored credentials for ${saved.registry} (${saved.username}).`, saved);
        return 0;
      }
      if (action === "rm" || action === "delete") {
        const gone = await api.registries.delete(need(more[0], "a registry"));
        print(
          gone.deleted ? `Forgot ${gone.registry}.` : `Nothing stored for ${gone.registry}.`,
          gone,
        );
        return 0;
      }
      throw unknown("registry command", action, ["ls", "set", "rm"]);
    }
  }
  throw unknown("image command", verb, [
    "build",
    "ls",
    "versions",
    "get",
    "logs",
    "tag",
    "untag",
    "rm",
    "registry",
  ]);
}

const JOB_HELP = `runtime jobs <command>

  A job runs a command in a fresh sandbox, once or on a schedule. Each run spends
  the free usage first, then credit at the sandbox rates.

  create <name> (--cron "<min hour day month weekday>" [--timezone Europe/Berlin] | --at <time|now>)
         [--vcpu 2] [--memory 4096] [--disk 4096] [--cpu shared|reserved] [--cpu-floor <thousandths>]
         [--timeout 1800] [--attempts 1] [--backoff 30] [--secret NAME[=ENV_NAME]]...
         [--cwd /workspace/dir] [--max-cost <usd>] [--max-total-cost <usd>] [--region r]
         [--image <name[:tag]|name@version|id>] [--alert-webhook <https url> [--alert-secret NAME]]
         [--alert-email] [--alert-after <runs>] [--volume <volumeId>:/data[:snapshot]]...
         -- <command...>
                                              Schedule it; prints its id. Nothing runs until its time.
                                              --at takes an ISO time (2026-10-01T03:00:00Z) or now.
                                              The command runs as given, no shell: -- bash -lc '...'
                                              --attempts: tries per occurrence when it exits non-zero, 1 to 5.
                                              --secret: a secret stored with --jobs, in the run's
                                              environment as ENV_NAME (NAME by default)
                                              --image: an image of yours each run starts from
                                              --alert-*: when --alert-after runs in a row (1) fail, POST
                                              the webhook (signed with the jobs secret NAME) or email
                                              you; once more when a run succeeds again
                                              --volume: a volume every run attaches, read-write one
                                              run at a time (or :snapshot, a read-only copy), so what
                                              one run writes there the next one reads; the job runs
                                              in the volume's region unless --region says otherwise
  update <id> [--image <ref> | --standard-image] [--vcpu ..] [--memory ..] [--disk ..] [--timeout ..]
         [--attempts ..] [--backoff ..] [--secret NAME[=ENV_NAME]]... [--cwd ..] [--max-total-cost <usd>]
         [--volume <volumeId>:/data[:snapshot]]... [--no-volumes]
         [--alert-webhook <url> [--alert-secret NAME]] [--alert-email] [--alert-after <runs>] [--no-alert]
         [-- <command...>]                    Change it in place: the next run uses it; history stays.
                                              --secret and --volume replace the whole list
  deploy [<dir>] [--name <project>] [--dry-run]
                                              Run Trigger.dev tasks and Inngest functions written
                                              against withruntime/trigger or withruntime/inngest as
                                              jobs: crons on their schedule, the rest on demand
  import <file>... [--parameter NAME=VALUE]... [--cron ..] [--dry-run]
                                              Move jobs from Google Cloud Run (job YAML and its Cloud
                                              Scheduler job) or AWS Batch (job definition and its
                                              EventBridge schedule): same image, command, size and
                                              schedule. \`jobs import help\` says more
  ls                                          Your jobs: state, schedule and next run
  get <id>                                    One job, in full
  runs <id> [--all]                           Its newest 100 runs (--all: every one, oldest first)
  logs <runId|jobId> [-f] [--raw]             A run's output (a job id: its latest run); -f follows it;
                                              on a terminal control characters show as \\uXXXX
                                              unless --raw
  pause <id> | resume <id>                    Stop or restart scheduling; a run already going finishes
  trigger <id>                                Run it now, once; its schedule does not move, and a
                                              paused job stays paused
  reschedule <id> (--cron "<five fields>" [--timezone Europe/Berlin] | --at <time|now>)
                                              A new schedule; the next run is its next time
  cancel <id>                                 End it for good and stop a run in progress

Examples
  runtime jobs create nightly --cron "0 3 * * *" --timezone Europe/Berlin -- python3 /workspace/report.py
  runtime jobs create once --at now -- bash -lc 'echo hello from a job'
  runtime jobs create count --cron "0 * * * *" --volume <volumeId>:/data -- bash -lc 'date >> /data/runs'
  runtime jobs trigger <jobId> && runtime jobs logs <jobId> -f
  runtime jobs reschedule <jobId> --cron "30 4 * * 1-5" --timezone Europe/Berlin
  runtime jobs update <jobId> --image hub:latest --alert-webhook https://example.com/hook --alert-after 3
  runtime jobs import job.yaml scheduler.yaml
  runtime jobs import template.yaml --parameter AWS::Region=us-east-1 --dry-run
`;

/** The `--alert-*` flags of create and update, as a job's alert; undefined
 * when none is given. The secret is a jobs secret, by name. */
async function alertFlags(
  args: ReturnType<typeof parse>,
  runtime: Awaited<ReturnType<typeof client>>,
): Promise<JobAlert | undefined> {
  const url = flag(args, "alert-webhook");
  const secret = flag(args, "alert-secret");
  const email = has(args, "alert-email");
  const after = integer(args, "alert-after");
  if (secret !== undefined && url === undefined)
    throw usage("--alert-secret signs the --alert-webhook: give the webhook's URL too.");
  if (url === undefined && !email) {
    if (after !== undefined)
      throw usage("--alert-after says when to alert: give --alert-webhook <url> or --alert-email.");
    return undefined;
  }
  let secretId: string | undefined;
  if (secret !== undefined) {
    secretId = (await runtime.secrets.all()).find((s) => s.name === secret)?.jobs?.id;
    if (!secretId)
      throw usage(
        `${secret} has no copy for jobs. Store one: printf %s "$VALUE" | ${me} secrets set ${secret} --jobs`,
      );
  }
  return {
    ...(after !== undefined ? { afterFailures: after } : {}),
    ...(url !== undefined ? { webhook: { url, ...(secretId ? { secretId } : {}) } } : {}),
    ...(email ? { email: true as const } : {}),
  };
}
/** `--secret NAME[=ENV_NAME]`, each a jobs secret by name. */
async function secretFlags(
  args: ReturnType<typeof parse>,
  runtime: Awaited<ReturnType<typeof client>>,
): Promise<Array<{ name: string; secretId: string }> | undefined> {
  const bindings = args.flags.get("secret") ?? [];
  if (!bindings.length) return undefined;
  const known = await runtime.secrets.all();
  return bindings.map((binding) => {
    const [secret, env = secret] = binding.split("=", 2) as [string, string | undefined];
    const found = known.find((s) => s.name === secret)?.jobs;
    if (!found)
      throw usage(
        `${secret} has no copy for jobs. Store one: printf %s "$VALUE" | ${me} secrets set ${secret} --jobs`,
      );
    return { name: env, secretId: found.id };
  });
}

const when = (ms: number | null | undefined) => (ms == null ? "-" : new Date(ms).toISOString());
function scheduleText(job: Job): string {
  const s = job.definition.schedule;
  return s.kind === "once" ? `once at ${when(s.at)}` : `${s.expression} ${s.timezone ?? "UTC"}`;
}
/** Seconds from the command line, `--at`: an ISO time, Unix milliseconds or
 * `now`. A time well in the past is refused: the job would run at once, and
 * that is what `now` says. */
function atTime(value: string, now = Date.now()): number {
  if (value === "now") return now;
  const at = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(at))
    throw usage(`--at takes an ISO time such as 2026-10-01T03:00:00Z, or now; got ${value}.`);
  if (at < now - 60_000)
    throw usage(`--at ${value} is in the past. To run it at once, say --at now.`);
  return at;
}

async function jobCommand(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(JOB_HELP), { usage: named(JOB_HELP) });
    return 0;
  }
  if (verb === "import")
    return (await import("./jobs-import.js")).jobsImportCommand(rest, out, () => client(env), kit);
  if (verb === "deploy")
    return (await import("./jobs-deploy.js")).jobsDeployCommand(rest, out, () => client(env), kit);
  const runtime = await client(env);
  const api = runtime.jobs;
  switch (verb) {
    case "create": {
      const args = parse(
        rest,
        ["alert-email"],
        [
          "cron",
          "timezone",
          "at",
          "vcpu",
          "memory",
          "disk",
          "cpu",
          "cpu-floor",
          "timeout",
          "attempts",
          "backoff",
          "secret",
          "cwd",
          "max-cost",
          "max-total-cost",
          "region",
          "image",
          "alert-webhook",
          "alert-secret",
          "alert-after",
          "volume",
        ],
        `${me} jobs create <name> --cron "0 3 * * *" -- python3 -c '...'`,
      );
      const name = need(args.positional[0], "the job's name, such as nightly-report");
      if (args.positional.length > 1)
        throw usage(
          `Put the command after --: ${me} jobs create ${name} ... -- ${args.positional.slice(1).join(" ")}`,
        );
      const argv = args.rest ?? [];
      if (!argv.length)
        throw usage(`Give the command after --: ${me} jobs create ${name} --at now -- echo hello`);
      const cron = flag(args, "cron");
      const at = flag(args, "at");
      if ((cron === undefined) === (at === undefined))
        throw usage('Give --cron "<five fields>" for a schedule, or --at <time|now> for one run.');
      if (at !== undefined && flag(args, "timezone") !== undefined)
        throw usage("--timezone goes with --cron; --at takes a time with its own offset.");
      const attempts = integer(args, "attempts");
      const backoff = integer(args, "backoff");
      if (backoff !== undefined && attempts === undefined)
        throw usage("--backoff goes with --attempts: the seconds between tries.");
      const secrets = await secretFlags(args, runtime);
      const alert = await alertFlags(args, runtime);
      const cwd = flag(args, "cwd");
      const volumes = (args.flags.get("volume") ?? []).map(attachment);
      // A run starts on its volumes' server, so the job is in their region
      // unless --region says otherwise (and the API names the mismatch).
      const region =
        flag(args, "region") ??
        (volumes.length ? (await runtime.volumes.get(volumes[0]!.volumeId)).region : undefined);
      const job = await api.create({
        name,
        schedule:
          cron !== undefined
            ? { cron, ...(flag(args, "timezone") ? { timezone: flag(args, "timezone")! } : {}) }
            : { at: atTime(at!) },
        command: cwd ? { argv, cwd } : argv,
        ...(integer(args, "timeout") !== undefined
          ? { timeoutSeconds: integer(args, "timeout")! }
          : {}),
        compute: {
          ...(integer(args, "vcpu") !== undefined ? { vcpu: integer(args, "vcpu")! } : {}),
          ...(integer(args, "memory") !== undefined ? { memoryMiB: integer(args, "memory")! } : {}),
          ...(integer(args, "disk") !== undefined ? { diskMiB: integer(args, "disk")! } : {}),
          ...(flag(args, "cpu")
            ? { cpuMode: oneOf(args, "cpu", ["shared", "reserved"] as const) }
            : {}),
          ...(integer(args, "cpu-floor") !== undefined
            ? { cpuFloorMillis: integer(args, "cpu-floor")! }
            : {}),
          ...(region ? { region } : {}),
          ...(usdMicros(args, "max-cost") !== undefined
            ? { maxCostMicros: usdMicros(args, "max-cost")! }
            : {}),
          ...(volumes.length ? { volumes } : {}),
        },
        ...(attempts !== undefined
          ? { retry: { maxAttempts: attempts, backoffSeconds: backoff ?? 30 } }
          : {}),
        ...(secrets ? { secrets } : {}),
        ...(usdMicros(args, "max-total-cost") !== undefined
          ? { maxTotalCostMicros: usdMicros(args, "max-total-cost")! }
          : {}),
        ...(flag(args, "image") ? { image: flag(args, "image")! } : {}),
        ...(alert ? { alert } : {}),
      });
      if (!out.json)
        out.error(
          `Scheduled ${job.name}: ${scheduleText(job)}. Next run ${when(job.nextRunAt)}. Follow it: ${me} jobs logs ${job.id} -f`,
        );
      print(job.id, job);
      return 0;
    }
    case "ls":
    case "list": {
      const all = await (await api.list({ limit: 100 })).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "NAME", "STATE", "SCHEDULE", "NEXT RUN", "BLOCKED"],
              ...all.map((j) => [
                j.id,
                j.name,
                j.state,
                scheduleText(j),
                // A canceled or finished job keeps its last nextRunAt, but runs no more.
                j.state === "active" || j.state === "paused" ? when(j.nextRunAt) : "-",
                j.blockedReason ?? "-",
              ]),
            ])
          : `No jobs. Schedule one: ${me} jobs create hello --at now -- echo hello`,
        all,
      );
      return 0;
    }
    case "get": {
      const found = await api.get(need(rest[0], "a job id"));
      print(JSON.stringify(found, null, 2), found);
      return 0;
    }
    case "runs": {
      // The newest hundred, newest first: a job every minute holds thousands.
      // --all: every run, oldest first.
      const args = parse(rest, ["all"], []);
      const jobId = need(args.positional[0], "a job id");
      const all = has(args, "all")
        ? await (await api.runs(jobId, { limit: 100 })).toArray(Infinity)
        : (await api.runs(jobId, { limit: 100, order: "newest" })).data;
      print(
        all.length
          ? table([
              ["RUN", "ATTEMPT", "STATE", "EXIT", "SCHEDULED", "STARTED", "ENDED", "REASON"],
              ...all.map((r) => [
                r.id,
                String(r.attempt),
                r.state,
                r.exitCode === null ? "-" : String(r.exitCode),
                when(r.scheduledFor),
                when(r.startedAt),
                when(r.endedAt),
                r.reason ?? "-",
              ]),
            ])
          : "No runs yet.",
        all,
      );
      return 0;
    }
    case "logs": {
      const args = parse(rest, ["f", "follow", "raw"], []);
      const id = need(args.positional[0], "a run id or a job id");
      const [stdout, stderr, shown] = [
        logStream(process.stdout, has(args, "raw")),
        logStream(process.stderr, has(args, "raw")),
        logText(args),
      ];
      let runId = id;
      try {
        await api.run(id);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        // A job's id: its latest run.
        const [latest] = (await api.runs(id, { limit: 1, order: "newest" })).data;
        if (!latest) {
          const job = await api.get(id);
          print(`${job.name} has not run yet. Next run ${when(job.nextRunAt)}.`, {
            chunks: [],
            nextCursor: 0,
            truncated: false,
            complete: false,
          });
          return 0;
        }
        runId = latest.id;
      }
      const follow = has(args, "f") || has(args, "follow");
      let cursor = 0;
      for (;;) {
        const page = await api.logs(runId, { cursor, limitBytes: 65536 });
        if (out.json) out.write(shown(JSON.stringify(page)));
        else
          for (const chunk of page.chunks)
            (chunk.stream === "stderr" ? stderr : stdout)(chunk.text);
        cursor = page.nextCursor;
        if (page.complete) {
          if (!follow && out.json) return 0;
          const run = await api.run(runId);
          if (!out.json) {
            if (page.truncated)
              process.stderr.write("[the run printed more than it keeps; this is its last part]\n");
            process.stderr.write(
              `[${run.state}${run.exitCode === null ? "" : `, exit code ${run.exitCode}`}${run.reason ? `, ${run.reason}` : ""}]\n`,
            );
          }
          return follow ? (run.exitCode ?? (run.state === "succeeded" ? 0 : 1)) : 0;
        }
        if (page.chunks.length) continue;
        if (!follow) {
          if (!out.json)
            process.stderr.write(
              `[${runId} is still going; follow it: ${me} jobs logs ${runId} -f]\n`,
            );
          return 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    case "pause":
    case "resume":
    case "cancel": {
      const id = need(rest[0], "a job id");
      const job = await api[verb](id);
      print(`${job.name} ${job.state}.`, job);
      return 0;
    }
    case "trigger": {
      const id = need(rest[0], "a job id");
      const job = await api.trigger(id);
      print(
        `${job.name} runs now${job.state === "paused" ? ", once; it stays paused" : ""}. Follow it: ${me} jobs logs ${job.id} -f`,
        job,
      );
      return 0;
    }
    case "update": {
      const args = parse(
        rest,
        ["alert-email", "no-alert", "standard-image", "no-volumes"],
        [
          "image",
          "vcpu",
          "memory",
          "disk",
          "cpu",
          "cpu-floor",
          "timeout",
          "attempts",
          "backoff",
          "secret",
          "cwd",
          "max-cost",
          "max-total-cost",
          "alert-webhook",
          "alert-secret",
          "alert-after",
          "volume",
        ],
        `${me} jobs update <id> --image hub:latest`,
      );
      const id = need(args.positional[0], "a job id");
      if (flag(args, "image") !== undefined && has(args, "standard-image"))
        throw usage("Give --image <ref> or --standard-image, not both.");
      const volumes = (args.flags.get("volume") ?? []).map(attachment);
      if (volumes.length && has(args, "no-volumes"))
        throw usage("Give --volume to set the volumes or --no-volumes to remove them, not both.");
      const alert = await alertFlags(args, runtime);
      if (alert && has(args, "no-alert"))
        throw usage("Give --alert-* to set the alert or --no-alert to remove it, not both.");
      const argv = args.rest ?? [];
      const cwd = flag(args, "cwd");
      if (cwd !== undefined && !argv.length)
        throw usage(
          `--cwd goes with the command: ${me} jobs update ${id} --cwd ${cwd} -- <command...>`,
        );
      const compute = {
        ...(integer(args, "vcpu") !== undefined ? { vcpu: integer(args, "vcpu")! } : {}),
        ...(integer(args, "memory") !== undefined ? { memoryMiB: integer(args, "memory")! } : {}),
        ...(integer(args, "disk") !== undefined ? { diskMiB: integer(args, "disk")! } : {}),
        ...(flag(args, "cpu")
          ? { cpuMode: oneOf(args, "cpu", ["shared", "reserved"] as const) }
          : {}),
        ...(integer(args, "cpu-floor") !== undefined
          ? { cpuFloorMillis: integer(args, "cpu-floor")! }
          : {}),
        ...(usdMicros(args, "max-cost") !== undefined
          ? { maxCostMicros: usdMicros(args, "max-cost")! }
          : {}),
        ...(volumes.length ? { volumes } : {}),
        ...(has(args, "no-volumes") ? { volumes: [] } : {}),
      };
      const retry = {
        ...(integer(args, "attempts") !== undefined
          ? { maxAttempts: integer(args, "attempts")! }
          : {}),
        ...(integer(args, "backoff") !== undefined
          ? { backoffSeconds: integer(args, "backoff")! }
          : {}),
      };
      const secrets = await secretFlags(args, runtime);
      const changes: UpdateJob = {
        ...(argv.length ? { command: cwd ? { argv, cwd } : argv } : {}),
        ...(flag(args, "image") ? { image: flag(args, "image")! } : {}),
        ...(has(args, "standard-image") ? { image: null } : {}),
        ...(Object.keys(compute).length ? { compute } : {}),
        ...(Object.keys(retry).length ? { retry } : {}),
        ...(integer(args, "timeout") !== undefined
          ? { timeoutSeconds: integer(args, "timeout")! }
          : {}),
        ...(secrets ? { secrets } : {}),
        ...(usdMicros(args, "max-total-cost") !== undefined
          ? { maxTotalCostMicros: usdMicros(args, "max-total-cost")! }
          : {}),
        ...(alert ? { alert } : {}),
        ...(has(args, "no-alert") ? { alert: null } : {}),
      };
      if (!Object.keys(changes).length)
        throw usage(
          `Say what changes: ${me} jobs update ${id} --image hub:latest, --timeout 600, --alert-email, or -- <new command...>`,
        );
      const job = await api.update(id, changes);
      print(
        `${job.name} updated (version ${job.version}); its next run uses it.${job.alert ? ` Alerts after ${job.alert.afterFailures} failing run${job.alert.afterFailures === 1 ? "" : "s"}.` : ""}`,
        job,
      );
      return 0;
    }
    case "reschedule": {
      const args = parse(
        rest,
        [],
        ["cron", "timezone", "at"],
        `${me} jobs reschedule <id> --cron "0 3 * * *" [--timezone Europe/Berlin]`,
      );
      const id = need(args.positional[0], "a job id");
      const cron = flag(args, "cron");
      const at = flag(args, "at");
      if ((cron === undefined) === (at === undefined))
        throw usage('Give --cron "<five fields>" for a schedule, or --at <time|now> for one run.');
      if (at !== undefined && flag(args, "timezone") !== undefined)
        throw usage("--timezone goes with --cron; --at takes a time with its own offset.");
      const job = await api.reschedule(
        id,
        cron !== undefined
          ? { cron, ...(flag(args, "timezone") ? { timezone: flag(args, "timezone")! } : {}) }
          : { at: atTime(at!) },
      );
      print(`${job.name}: ${scheduleText(job)}. Next run ${when(job.nextRunAt)}.`, job);
      return 0;
    }
  }
  throw unknown("job command", verb, [
    "create",
    "ls",
    "get",
    "runs",
    "logs",
    "pause",
    "resume",
    "trigger",
    "reschedule",
    "update",
    "cancel",
  ]);
}

const VOLUME_HELP = `runtime volumes <command>

  create --size-mib <N> [--name n] [--label k=v]... [--shared]
                                              A persistent disk; prints its id
  ls                                          Your volumes
  get <id>                                    One volume, its backups and where it is attached
  resize <id> --size-mib <N>                  Grow a detached volume on its current host
  attach <id> <sandboxId> --path /data        Mount a shared disk in a running sandbox
  detach <id> <attachmentId>                 Flush and unmount its shared attachment
  attachment <id> <attachmentId>             Read the attachment's state and error
  rm <id>                                     Delete it and everything on it (its backups stay)
  backup <id> [--retention-days N] [--no-wait]
                                              Back it up now, off its host; prints the backup id
  backups [<id>]                              Backups, newest first (of one volume, if given)
  restore <backupId> [--name n]               A new volume from a backup, on any host
  backup-rm <backupId>                        Delete a backup
  backup-policy <id> [--daily on|off] [--retention-days N]
                                              Daily backups on or off, and how long each is kept
  backup-policy <id> --every <minutes> | --cron "<m h dom mon dow>" [--keep hourly=24,daily=7,...]
                                              Back up on a schedule of its own (UTC), keeping
                                              last, hourly, daily, weekly, monthly, yearly counts
  backup-policy <id> --no-schedule            Back to daily backups
  Attach one: runtime sandboxes create --volume <id>:/data
  Volumes are backed up off their host daily, or on their own schedule, unless you turn it off.
  Shared commands work where shared disks are enabled.
`;

const KEEP_TIERS = ["last", "hourly", "daily", "weekly", "monthly", "yearly"] as const;

/** `hourly=24,daily=7` as keep counts; the server checks the numbers. */
function keepCounts(text: string): Partial<Record<(typeof KEEP_TIERS)[number], number>> {
  const counts: Partial<Record<(typeof KEEP_TIERS)[number], number>> = {};
  for (const part of text.split(",")) {
    const [name, value, extra] = part.trim().split("=");
    const tier = KEEP_TIERS.find((t) => t === name);
    if (!tier || value === undefined || extra !== undefined || !/^\d+$/.test(value))
      throw usage(
        `--keep takes name=count pairs such as hourly=24,daily=7; names: ${KEEP_TIERS.join(", ")}.`,
      );
    counts[tier] = Number(value);
  }
  return counts;
}

/** "daily backups on, kept 7 days", or the schedule, its keep counts and next run. */
function backupPolicyWords(b: {
  daily: boolean;
  retentionDays: number;
  schedule?: { everyMinutes: number } | { cron: string } | null;
  keep?: Partial<Record<(typeof KEEP_TIERS)[number], number>> | null;
  nextAt?: string | null;
}): string {
  if (!b.schedule) return `daily backups ${b.daily ? "on" : "off"}, kept ${b.retentionDays} days`;
  const when =
    "everyMinutes" in b.schedule
      ? `every ${b.schedule.everyMinutes} minutes`
      : `on cron "${b.schedule.cron.trim()}" (UTC)`;
  const kept = KEEP_TIERS.filter((t) => (b.keep?.[t] ?? 0) > 0)
    .map((t) => `${t} ${b.keep![t]}`)
    .join(", ");
  return `backups ${when}${b.daily ? "" : " (off)"}, keeping ${kept}${b.daily && b.nextAt ? `; next ${b.nextAt}` : ""}`;
}

async function volume(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(VOLUME_HELP), { usage: named(VOLUME_HELP) });
    return 0;
  }
  const api = (await client(env)).volumes;
  switch (verb) {
    case "create": {
      const args = parse(rest, ["shared"], ["size-mib", "name", "label"]);
      const created = await api.create({
        sizeMiB: integer(args, "size-mib") ?? Number(need(undefined, "--size-mib <N>")),
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
        ...(has(args, "shared") ? { shared: true } : {}),
      });
      print(created.id, created);
      return 0;
    }
    case "ls":
    case "list": {
      const all = await (await api.list()).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "NAME", "STATE", "MIB", "BACKED UP", "ATTACHED"],
              ...all.map((v) => [
                v.id,
                v.name ?? "-",
                v.state,
                String(v.sizeMiB),
                v.backedUp ? (v.backups?.lastReadyAt ?? "yes") : "no",
                v.attachments.map((a) => `${a.sandboxId}:${a.path}`).join(", ") || "-",
              ]),
            ])
          : "No volumes. Create one: runtime volumes create --size-mib 10240",
        all,
      );
      return 0;
    }
    case "get": {
      const found = await api.get(need(rest[0], "a volume id"));
      print(describeRecord(found, table), found);
      return 0;
    }
    case "resize": {
      const args = parse(rest, [], ["size-mib"]);
      const id = need(args.positional[0], "a volume id");
      if (args.positional.length !== 1 || args.rest)
        throw usage(`Use ${me} volumes resize <id> --size-mib <N>.`);
      const sizeMiB = integer(args, "size-mib") ?? Number(need(undefined, "--size-mib <N>"));
      const resized = await api.resize(id, { sizeMiB });
      print(describeRecord(resized, table), resized);
      return resized.resize?.state === "failed" ? 1 : 0;
    }
    case "attach": {
      const args = parse(rest, [], ["path"]);
      const id = need(args.positional[0], "a volume id");
      const sandboxId = need(args.positional[1], "a sandbox id");
      const path = need(flag(args, "path"), "--path /data");
      if (args.positional.length !== 2 || args.rest)
        throw usage(`Use ${me} volumes attach <id> <sandboxId> --path /data.`);
      const attachment = await api.attach(id, { sandboxId, path });
      print(describeRecord(attachment, table), attachment);
      return attachment.error ? 1 : 0;
    }
    case "detach":
    case "attachment": {
      const args = parse(rest, [], []);
      const id = need(args.positional[0], "a volume id");
      const attachmentId = need(args.positional[1], "an attachment id");
      if (args.positional.length !== 2 || args.rest)
        throw usage(`Use ${me} volumes ${verb} <id> <attachmentId>.`);
      const attachment =
        verb === "detach"
          ? await api.detach(id, attachmentId)
          : await api.getAttachment(id, attachmentId);
      print(describeRecord(attachment, table), attachment);
      return verb === "detach" && attachment.error ? 1 : 0;
    }
    case "rm":
    case "delete": {
      const id = need(rest[0], "a volume id");
      const found = await withVolumeRelease((options) => api.delete(id, options), out);
      print(`${found.id} ${found.state}`, found);
      return 0;
    }
    case "backup": {
      const args = parse(rest, ["no-wait"], ["retention-days"]);
      const id = need(args.positional[0], "a volume id");
      const days = integer(args, "retention-days");
      const made = await api.backup(
        id,
        days === undefined ? {} : { retentionDays: days },
        has(args, "no-wait") ? { wait: 0 } : {},
      );
      if (!out.json && made.state === "pending")
        out.error(`Copying it off the host; check with: ${me} volumes backups ${id}`);
      print(made.id, made);
      return 0;
    }
    case "backups": {
      const volumeId = rest[0];
      const all = await (await api.backups(volumeId ? { volumeId } : {})).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "VOLUME", "STATE", "TRIGGER", "MIB", "STORED", "TAKEN", "EXPIRES"],
              ...all.map((b) => [
                b.id,
                b.volumeId,
                b.state,
                b.trigger,
                String(b.sizeMiB),
                b.storedBytes === null ? "-" : `${Math.ceil(b.storedBytes / 1048576)} MiB`,
                b.createdAt,
                b.expiresAt ?? "by keep counts",
              ]),
            ])
          : "No backups yet.",
        all,
      );
      return 0;
    }
    case "restore": {
      const args = parse(rest, [], ["name"]);
      const created = await api.restore(
        need(args.positional[0], "a backup id"),
        flag(args, "name") ? { name: flag(args, "name")! } : {},
      );
      if (!out.json && created.state === "creating")
        out.error(`Restoring; check with: ${me} volumes get ${created.id}`);
      print(created.id, created);
      return 0;
    }
    case "backup-rm":
    case "backup-delete": {
      const found = await api.deleteBackup(need(rest[0], "a backup id"));
      print(`${found.id} ${found.state}`, found);
      return 0;
    }
    case "backup-policy": {
      const args = parse(
        rest,
        ["no-schedule"],
        ["daily", "retention-days", "every", "cron", "keep"],
      );
      const id = need(args.positional[0], "a volume id");
      const daily = flag(args, "daily");
      if (daily !== undefined && !["on", "off", "true", "false"].includes(daily))
        throw usage("--daily takes on or off.");
      const days = integer(args, "retention-days");
      const every = integer(args, "every");
      const cron = flag(args, "cron");
      const off = has(args, "no-schedule");
      if ([every !== undefined, cron !== undefined, off].filter(Boolean).length > 1)
        throw usage("Give one of --every, --cron and --no-schedule.");
      const keepText = flag(args, "keep");
      const keep = keepText === undefined ? undefined : keepCounts(keepText);
      if ([daily, days, every, cron, keep].every((x) => x === undefined) && !off)
        throw usage(
          "Give --daily on|off, --retention-days N, --every, --cron, --keep or --no-schedule.",
        );
      const updated = await api.setBackupPolicy(id, {
        ...(daily === undefined ? {} : { daily: daily === "on" || daily === "true" }),
        ...(days === undefined ? {} : { retentionDays: days }),
        ...(every === undefined ? {} : { schedule: { everyMinutes: every } }),
        ...(cron === undefined ? {} : { schedule: { cron } }),
        ...(off ? { schedule: null } : {}),
        ...(keep === undefined ? {} : { keep }),
      });
      print(`${updated.id} ${backupPolicyWords(updated.backups)}`, updated);
      return 0;
    }
  }
  throw unknown("volume command", verb, [
    "create",
    "ls",
    "get",
    "resize",
    "attach",
    "detach",
    "attachment",
    "rm",
    "backup",
    "backups",
    "restore",
    "backup-rm",
    "backup-policy",
  ]);
}

/** Flags `sandbox create` and `run` take without a value. */
const CREATE_FLAGS = [
  "trial",
  "paid",
  "no-wait",
  "no-internet",
  "no-auto-wake",
  "persistent",
  "get-or-create",
  "no-secrets",
];
/** Says on standard error, once for each reason, why a create has not
 * answered yet: it is waiting for a slot without credit or room, which can take up to
 * two minutes, and silence reads as a hang. */
function waiting(out: Out): (refusal: RuntimeError) => void {
  const said = new Set<string>();
  return (refusal) => {
    // The CLI's volume wait owns this refusal, including its deadline.
    if (refusal.code === "volume_releasing") throw refusal;
    if (said.has(refusal.code)) return;
    said.add(refusal.code);
    out.error(`${refusal.message} Waiting for room, up to 2 minutes; Ctrl-C stops.`);
  };
}
/** A stopping sandbox can take a minute to let go of its volume. Retry only
 * that refusal, with the same key so a create cannot make two sandboxes. */
async function withVolumeRelease<T>(
  operation: (options: RequestOptions) => Promise<T>,
  out: Out,
): Promise<T> {
  const idempotencyKey = crypto.randomUUID();
  let until: number | undefined;
  for (;;) {
    try {
      return await operation({
        idempotencyKey,
        ...(until === undefined
          ? {}
          : { signal: AbortSignal.timeout(Math.max(1, Math.ceil(until - performance.now()))) }),
      });
    } catch (error) {
      if (
        !(error instanceof RuntimeError) ||
        error.code !== "volume_releasing" ||
        error.status !== 409
      )
        throw error;
      if (until === undefined) {
        until = performance.now() + 90_000;
        out.error("Waiting for the volume to be let go, up to 90 seconds; Ctrl-C stops.");
      }
      const left = until - performance.now();
      if (left <= 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, left)));
      if (performance.now() >= until) throw error;
    }
  }
}
/** Options `sandbox create` and `run` take with a value. */
const CREATE_VALUES = [
  "name",
  "label",
  "region",
  "vcpu",
  "memory",
  "disk",
  "cpu",
  "cpu-floor",
  "timeout",
  "on-timeout",
  "idle-pause",
  "max-cost",
  "max-total-cost",
  "allow",
  "deny",
  "connect",
  "image",
  "snapshot",
  "spread-from",
  "secret",
  "volume",
  "env",
  "user",
];
/** Dollars from the command line as integer microdollars: 25, 2.50 or 0.000001. */
function usdMicros(args: Args, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw usage(`--${name} takes dollars, such as 25 or 2.50.`);
  // ARCHITECTURE.md section 10: integer microdollars throughout, with no
  // floating-point money path or rounding drift.
  const [whole, fraction = ""] = value.split(".");
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER))
    throw usage(`--${name} is too large to represent exactly in microdollars.`);
  return Number(micros);
}
/** The egress secrets a new sandbox may use: each --secret adds a name
 * (commas also separate them), --no-secrets is none, and neither leaves it
 * out, for every secret that reaches it. Fixed for the sandbox's life. */
function secretsInput(args: Args): { secrets?: string[] } {
  const names = args.flags.get("secret");
  if (has(args, "no-secrets")) {
    if (names) throw usage("Give --secret or --no-secrets, not both.");
    return { secrets: [] };
  }
  if (!names) return {};
  return {
    secrets: names
      .flatMap((value) => value.split(","))
      .map((name) => {
        if (!name.trim()) throw usage("--secret needs a non-empty value.");
        return name.trim();
      }),
  };
}
/** A create body from the command line's flags. */
function createInput(args: Args, env: NodeJS.ProcessEnv): CreateSandbox & { wait?: boolean } {
  for (const name of ["image", "snapshot", "volume", "name", "region", "connect"])
    if (args.flags.get(name)?.some((value) => !value.trim()))
      throw usage(`--${name} needs a non-empty value.`);
  const rules = ["allow", "deny", "connect"].filter((name) => args.flags.has(name));
  return {
    ...(flag(args, "image") ? { image: flag(args, "image")! } : {}),
    ...(flag(args, "snapshot") ? { snapshot: flag(args, "snapshot")! } : {}),
    ...(args.flags.has("spread-from")
      ? {
          spreadFrom: args.flags
            .get("spread-from")!
            .flatMap((value) => value.split(","))
            .map((id) => {
              if (!id.trim()) throw usage("--spread-from needs a non-empty value.");
              return id.trim();
            }),
        }
      : {}),
    ...secretsInput(args),
    ...(args.flags.has("volume") ? { volumes: args.flags.get("volume")!.map(attachment) } : {}),
    ...(has(args, "no-internet") || rules.length
      ? {
          network: {
            internet: !has(args, "no-internet"),
            ...Object.fromEntries(rules.map((name) => [name, args.flags.get(name)!])),
          },
        }
      : {}),
    ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
    ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
    ...(args.flags.has("env") ? { env: envPairs(args, env) } : {}),
    ...(integer(args, "vcpu") !== undefined ? { vcpu: integer(args, "vcpu")! } : {}),
    ...(integer(args, "memory") !== undefined ? { memoryMiB: integer(args, "memory")! } : {}),
    ...(integer(args, "disk") !== undefined ? { diskMiB: integer(args, "disk")! } : {}),
    ...(flag(args, "cpu") ? { cpu: oneOf(args, "cpu", ["shared", "reserved"] as const) } : {}),
    ...(integer(args, "cpu-floor") !== undefined
      ? { cpuFloorMillis: integer(args, "cpu-floor")! }
      : {}),
    ...(flag(args, "region") ? { region: flag(args, "region")! } : {}),
    ...(usdMicros(args, "max-cost") !== undefined
      ? { maxCostMicros: usdMicros(args, "max-cost")! }
      : {}),
    ...(usdMicros(args, "max-total-cost") !== undefined
      ? { maxTotalCostMicros: usdMicros(args, "max-total-cost")! }
      : {}),
    ...(integer(args, "timeout") !== undefined
      ? { timeoutSeconds: integer(args, "timeout")! }
      : {}),
    ...(flag(args, "on-timeout")
      ? { onLeaseEnd: oneOf(args, "on-timeout", ["pause", "stop", "delete"] as const) }
      : {}),
    ...(integer(args, "idle-pause") !== undefined
      ? { idlePauseSeconds: integer(args, "idle-pause")! }
      : {}),
    ...(has(args, "no-auto-wake") ? { autoWake: false } : {}),
    ...(flag(args, "user") ? { user: oneOf(args, "user", ["sandbox", "root"] as const) } : {}),
    ...(has(args, "persistent") ? { persistent: true } : {}),
    ...(has(args, "get-or-create") ? { getOrCreate: true } : {}),
    ...(has(args, "trial")
      ? { funding: "trial" as const }
      : has(args, "paid")
        ? { funding: "paid" as const }
        : {}),
    ...(has(args, "no-wait") ? { wait: false } : {}),
  };
}

/** Runs a command in a sandbox, streaming its output, and answers its exit code
 * (124 on a timeout), so a script's `set -e` behaves. */
async function execute(
  sbx: Pick<Sandbox, "id" | "exec">,
  command: string[],
  args: Args,
  out: Out,
  timeout: number | undefined,
  env: NodeJS.ProcessEnv,
  /** `run` stops its whole sandbox on Ctrl-C, so it handles the signal itself. */
  ownInterrupt = true,
): Promise<number> {
  const target = command.length === 1 ? command[0]! : command;
  // Only `sandboxes exec` takes --trace-files; `run`, `apps exec` and the
  // drop-in machines' exec share this runner without it.
  const traced =
    !(args.flags instanceof Flags) || args.flags.known.has("trace-files")
      ? flag(args, "trace-files")
      : undefined;
  const extras = await import("./cli-extras.js");
  const stdin = await extras.pipedStdin();
  const options = {
    ...(stdin ? { stdin } : {}),
    ...(flag(args, "cwd") ? { cwd: flag(args, "cwd")! } : {}),
    ...(args.flags.has("env") ? { env: envPairs(args, env) } : {}),
    ...(has(args, "root") ? { user: "root" as const } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
    ...(traced ? { traceFiles: true } : {}),
  };
  // Ctrl-C stops the command in the sandbox too, and says so; without this
  // the CLI exited and the command ran on unseen.
  const interrupt = new AbortController();
  const onInterrupt = () => interrupt.abort(new Error("Interrupted"));
  if (ownInterrupt) process.once("SIGINT", onInterrupt);
  let result: Awaited<ReturnType<Sandbox["exec"]>>;
  try {
    result = out.json
      ? await sbx.exec(target, { ...options, signal: interrupt.signal })
      : await sbx.exec(target, {
          ...options,
          signal: interrupt.signal,
          onStdout: (t) => process.stdout.write(t),
          onStderr: (t) => process.stderr.write(t),
        });
  } catch (error) {
    if (!interrupt.signal.aborted) throw error;
    out.error(describeError(error, out.json));
    return 130;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  // What it read and wrote, as JSON, for a cache keyed by what a test read.
  if (traced) await writeFile(traced, `${JSON.stringify(result.files ?? null)}\n`);
  if (out.json) out.write(JSON.stringify(result));
  // Here the output streamed, whose timeout is 24 hours unless one was given
  // (Sandbox.exec); `--json` answers the result and prints no such line.
  else if (result.timedOut)
    out.error(
      `runtime: timed out after ${timeout ? `${timeout} s` : "24 h"}; the command's process group was killed.`,
    );
  const memory = outOfMemoryLines(result.outOfMemory);
  if (memory && !out.json) out.error(memory);
  // Never drop output silently: say so, and do not exit 0.
  const lost = extras.lostOutput(result, sbx.id);
  if (lost && !out.json) out.error(lost);
  /* A command a signal ended comes back as minus the signal (-9 after the
     out-of-memory killer's SIGKILL); a shell says 128 + the signal. Clamped
     to 0 until 30 September 2026, a killed command exited 0. */
  const exit = result.exitCode ?? 1;
  const code = result.timedOut ? 124 : Math.min(255, exit < 0 ? 128 - exit : exit);
  return lost && code === 0 ? 1 : code;
}

async function shell(sbx: Sandbox, command?: string, root = false): Promise<number> {
  const stdin = process.stdin;
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const terminal = await sbx.terminal({
    ...size(),
    ...(command ? { command } : {}),
    ...(root ? { user: "root" as const } : {}),
    onData: (data) => process.stdout.write(data),
  });
  if (stdin.isTTY) stdin.setRawMode(true);
  const unhook = (await import("./cli-extras.js")).pipeShellInput(stdin, terminal);
  stdin.resume();
  const onResize = () => terminal.resize(size().cols, size().rows);
  process.stdout.on("resize", onResize);
  const code = await terminal.exited;
  unhook();
  process.stdout.off("resize", onResize);
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  return code ?? 0;
}

function defaultOut(argv: string[]): Out {
  const json =
    argv.includes("--json") &&
    (argv.indexOf("--") === -1 || argv.indexOf("--json") < argv.indexOf("--"));
  return {
    json,
    write: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
    drain: async () => {
      if (process.stdout.writableNeedDrain) await once(process.stdout, "drain");
    },
    error: (text) => process.stderr.write(`${text}\n`),
  };
}

export function describeError(error: unknown, json: boolean): string {
  if (error instanceof RuntimeError) {
    if (json)
      return JSON.stringify({
        error: {
          code: error.code,
          status: error.status,
          message: error.message,
          hint: error.hint,
          requestId: error.requestId,
          idempotencyKey: error.idempotencyKey,
          details: error.details,
          retryable: error.retryable,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        },
      });
    // In the command line's words: the option, not the request's field.
    const { message, hint } = cliRefusal(error);
    // Said only when the same command, run again, may work: and when, if the
    // API named it (a daily cap's hour).
    const again = error.retryable
      ? `\nRetryable: yes${
          error.retryAfterMs !== undefined
            ? `, after ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} s`
            : ""
        }`
      : "";
    return `Error [${error.code}]: ${message}${hint ? `\nHint: ${hint}` : ""}${again}${
      error.requestId
        ? // A refusal of what was sent is the caller's to fix; only a failure
          // of ours is worth a report.
          error.status >= 400 && error.status < 500
          ? `\nRequest: ${error.requestId}`
          : `\nRequest: ${error.requestId} (report it: runtime feedback "..." --request-id ${error.requestId})`
        : ""
    }`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return json ? JSON.stringify({ error: { code: "cli_error", message } }) : `Error: ${message}`;
}

if (
  import.meta.main ||
  (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
) {
  const argv = process.argv.slice(2);
  const out = defaultOut(argv);
  run(argv, process.env, out).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      out.error(describeError(error, out.json));
      process.exitCode = 1;
    },
  );
}

// ------------------------------------------------------------------ observability

/** A sparkline of up to 60 points, oldest first. */
function spark(values: Array<number | null>): string {
  const bars = "▁▂▃▄▅▆▇█";
  const known = values.filter((v): v is number => v !== null);
  const top = Math.max(1, ...known);
  const step = Math.max(1, Math.ceil(values.length / 60));
  const out: string[] = [];
  for (let i = 0; i < values.length; i += step) {
    const slice = values.slice(i, i + step).filter((v): v is number => v !== null);
    out.push(slice.length ? bars[Math.min(7, Math.round((Math.max(...slice) / top) * 7))]! : " ");
  }
  return out.join("");
}
const mib = (bytes: number) => `${Math.round(bytes / 1_048_576).toLocaleString("en-US")} MiB`;
function metricsText(m: SandboxMetrics): string {
  const waiting = (value: number | null | undefined) =>
    value == null ? "not measured" : `${value}%`;
  const waitingHistory = (field: "cpuWaitPercent" | "memoryStallPercent") =>
    m.points.some((point) => point[field] != null)
      ? spark(m.points.map((point) => point[field] ?? null))
      : "not measured";
  const cpu = m.points.map((p) => p.cpuPercent);
  const memory = m.points.map((p) => p.memoryBytes);
  const peak = Math.max(0, ...m.points.map((p) => p.cpuPeakPercent ?? p.cpuPercent ?? 0));
  // `latest` is the newest reading of the last 15 minutes whatever the state,
  // so a sandbox paused a minute ago still has one from before it slept. Only a
  // running sandbox has a now.
  const latest = m.state === "running" ? m.latest : null;
  const still = m.state === "running" ? null : `none: it is ${m.state}`;
  const cpuNow = newestCpu(m);
  return [
    table([
      ["state", m.state],
      [
        "cpu now",
        still ??
          (cpuNow
            ? `${cpuNow.percent}% of ${m.vcpu} vCPU${cpuNow.cores == null ? "" : ` (${cpuNow.cores} cores)`}${cpuNow.ago ? `, ${cpuNow.ago}` : ""}`
            : "no reading in this range"),
      ],
      [
        "memory now",
        still ?? (latest ? `${mib(latest.memoryBytes)} of ${mib(m.memoryLimitBytes)}` : "-"),
      ],
      ["cpu wait now", still ?? waiting(latest?.cpuWaitPercent)],
      ["memory stalls now", still ?? waiting(latest?.memoryStallPercent)],
      [`cpu, ${m.range}`, m.points.length ? `${spark(cpu)}  peak ${peak}%` : "no readings"],
      [`cpu wait, ${m.range}`, waitingHistory("cpuWaitPercent")],
      [`memory stalls, ${m.range}`, waitingHistory("memoryStallPercent")],
      [
        `memory, ${m.range}`,
        m.points.length
          ? `${spark(memory)}  peak ${mib(Math.max(...m.points.map((p) => p.memoryPeakBytes)))}`
          : "no readings",
      ],
    ]),
  ].join("\n");
}

const WEBHOOK_VERBS = [
  "ls",
  "create",
  "get",
  "update",
  "test",
  "deliveries",
  "retry",
  "rotate-secret",
  "rm",
];
async function webhooksCommand(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const [verb = "ls", ...rest] = argv;
  product = "webhooks";
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (verb === "help" || verb === "--help") {
    out.write(
      HELP.split("\n")
        .filter((line) => /webhooks|^\s{11}\|/.test(line))
        .join("\n"),
    );
    return 0;
  }
  const hooks = (await client(env)).webhooks;
  const args = parse(
    rest,
    ["enable", "disable"],
    ["events", "description", "url", "keep", "limit"],
  );
  const id = () => need(args.positional[0], "a webhook id");
  const events = () =>
    flag(args, "events")
      ?.split(",")
      .map((e) => e.trim())
      .filter(Boolean) as Array<WebhookEventType | "*"> | undefined;
  const row = (h: {
    id: string;
    url: string;
    enabled: boolean;
    events: string[];
    failingSince: string | null;
  }) => [
    h.id,
    h.url,
    h.enabled ? (h.failingSince ? `failing since ${h.failingSince}` : "on") : "off",
    h.events.join(","),
  ];
  switch (verb) {
    case "ls":
    case "list": {
      const page = await hooks.list();
      print(
        page.data.length
          ? table(page.data.map(row))
          : "No webhooks. Add one: runtime webhooks create <url>",
        page,
      );
      return 0;
    }
    case "get": {
      const h = await hooks.get(id());
      print(table([row(h)]), h);
      return 0;
    }
    case "create":
    case "add": {
      const h = await hooks.create({
        url: need(args.positional[0], "the https URL to send to"),
        ...(events() ? { events: events()! } : {}),
        ...(flag(args, "description") ? { description: flag(args, "description")! } : {}),
      });
      print(
        `${h.id}\nSigning secret (shown once, keep it): ${h.secret}\nVerify deliveries with verifyWebhook from the withruntime SDK.`,
        h,
      );
      return 0;
    }
    case "update": {
      const h = await hooks.update(id(), {
        ...(flag(args, "url") ? { url: flag(args, "url")! } : {}),
        ...(events() ? { events: events()! } : {}),
        ...(has(args, "enable") ? { enabled: true } : {}),
        ...(has(args, "disable") ? { enabled: false } : {}),
      });
      print(table([row(h)]), h);
      return 0;
    }
    case "rotate-secret": {
      const keep = integer(args, "keep");
      const h = await hooks.rotateSecret(
        id(),
        keep === undefined ? {} : { keepPreviousSeconds: keep },
      );
      print(
        `New signing secret (shown once): ${h.secret}${h.previousSecretExpiresAt ? `\nThe old one also signs until ${h.previousSecretExpiresAt}.` : ""}`,
        h,
      );
      return 0;
    }
    case "test": {
      const d = await hooks.test(id());
      print(
        d.state === "succeeded"
          ? `Delivered: your endpoint answered ${d.lastStatus} in ${d.lastDurationMs} ms.`
          : d.state === "pending"
            ? "Sent; no answer yet. See it with: runtime webhooks deliveries " + id()
            : `Not delivered: ${d.lastError ?? d.state}${d.lastStatus ? ` (HTTP ${d.lastStatus})` : ""}.`,
        d,
      );
      return d.state === "failed" ? 1 : 0;
    }
    case "deliveries": {
      const page = await hooks.deliveries(id(), {
        ...(integer(args, "limit") !== undefined ? { limit: integer(args, "limit")! } : {}),
      });
      print(
        page.data.length
          ? table(
              page.data.map((d) => [
                d.id,
                d.createdAt,
                d.eventType,
                d.state,
                `${d.attempts}/${d.maxAttempts}`,
                d.lastStatus ? String(d.lastStatus) : (d.lastError ?? "-"),
              ]),
            )
          : "No deliveries yet.",
        page,
      );
      return 0;
    }
    case "retry": {
      const d = await hooks.retry(need(args.positional[0], "a delivery id"));
      print(`Queued ${d.id} to send again.`, d);
      return 0;
    }
    case "rm":
    case "delete": {
      print("Deleted.", await hooks.delete(id()));
      return 0;
    }
  }
  throw unknown("webhooks command", verb, WEBHOOK_VERBS);
}

const OTEL_VERBS = ["ls", "create", "get", "update", "flush", "rm"];
async function otelCommand(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const [verb = "ls", ...rest] = argv;
  product = "otel";
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const otel = (await client(env)).otel;
  const args = parse(rest, ["enable", "disable"], ["endpoint", "header", "signals"]);
  const id = () => need(args.positional[0], "an export id");
  const signals = () =>
    flag(args, "signals")
      ?.split(",")
      .map((s) => s.trim()) as Array<"logs" | "metrics"> | undefined;
  const row = (x: {
    id: string;
    endpoint: string;
    enabled: boolean;
    signals: string[];
    lastSuccessAt: string | null;
    lastError: string | null;
  }) => [
    x.id,
    x.endpoint,
    x.enabled ? "on" : "off",
    x.signals.join(","),
    x.lastError
      ? `last error: ${x.lastError}`
      : x.lastSuccessAt
        ? `sent ${x.lastSuccessAt}`
        : "not sent yet",
  ];
  switch (verb) {
    case "ls":
    case "list": {
      const page = await otel.list();
      print(
        page.data.length
          ? table(page.data.map(row))
          : "No exports. Add one: runtime otel create <endpoint>",
        page,
      );
      return 0;
    }
    case "get": {
      const x = await otel.get(id());
      print(table([row(x)]), x);
      return 0;
    }
    case "create":
    case "add": {
      const x = await otel.create({
        endpoint: need(args.positional[0], "the OTLP/HTTP endpoint"),
        ...(args.flags.has("header") ? { headers: pairs(args, "header") } : {}),
        ...(signals() ? { signals: signals()! } : {}),
      });
      print(
        `${x.id}\nPushing ${x.signals.join(" and ")} to ${x.endpoint} about every 30 seconds.`,
        x,
      );
      return 0;
    }
    case "update": {
      const x = await otel.update(id(), {
        ...(flag(args, "endpoint") ? { endpoint: flag(args, "endpoint")! } : {}),
        ...(args.flags.has("header") ? { headers: pairs(args, "header") } : {}),
        ...(signals() ? { signals: signals()! } : {}),
        ...(has(args, "enable") ? { enabled: true } : {}),
        ...(has(args, "disable") ? { enabled: false } : {}),
      });
      print(table([row(x)]), x);
      return 0;
    }
    case "flush": {
      print(
        "Pushing now; `runtime otel get <id>` shows the answer in a few seconds.",
        await otel.flush(id()),
      );
      return 0;
    }
    case "rm":
    case "delete": {
      print("Deleted.", await otel.delete(id()));
      return 0;
    }
  }
  throw unknown("otel command", verb, OTEL_VERBS);
}
