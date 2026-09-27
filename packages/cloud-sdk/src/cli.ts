#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectionOrigins, connectionStore, resolveCredential } from "./credentials.js";
import { me, named } from "./cli-name.js";
import { Runtime } from "./client.js";
import { Sandbox as SandboxHandle, type Sandbox } from "./sandbox.js";
import { RuntimeError } from "./errors.js";
import { NETWORK_PRODUCTS, networkProductCommand, type NetworkProduct } from "./network-cli.js";
import { billingCommand } from "./billing-cli.js";
import { envFetch } from "./proxy.js";
import { VERSION } from "./transport.js";
import type { CreateSandbox, FeedbackKind, SandboxInfo, Usage } from "./types.js";
import type { MetricRange, SandboxMetrics, WebhookEventType } from "./products/observability.js";
import type { SwitchingSummary, SwitchProvider } from "./products/switching.js";
import type { Secret, SecretRule } from "./products/secrets.js";
import type { InterpreterLanguage } from "./products/interpreter.js";

/* runtime <product> <verb>, and account commands at the top level. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };
type Args = { positional: string[]; flags: Map<string, string[]>; rest: string[] | undefined };

const HELP = `Runtime Cloud CLI ${VERSION}

Usage: runtime <product> <command> [options]      runtime <command> [options]

Start
  sandbox run [--keep] [create options] -- <command>
                                               A fresh sandbox runs one command, then stops

Account
  login [--agent-name <name>] [--no-browser] [--wait]
                                               Connect this machine (no key to copy)
  login --with-key                             Or paste a key from withruntime.com/account/keys
  logout                                       Revoke this machine's connection
  whoami                                       The organization and agent you act as
  account [ls]                                 The accounts this machine is connected to
  account switch <name|id>                     Use another of them for every command after
  account add                                  Connect another account (choose it in the browser)
  account close --confirm "<account name>"     Close the account for good (owner, key for every product)
  audit [--action member.] [--limit 50] [--before <next>]
                                               The account's audit log (owner or admin keys)
  sso                                          Single sign-on and SCIM directory sync (owner or
                                               admin keys); an owner changes it on the website
  usage [--csv]                                Balance, trial time and charges; --csv, each resource
  limits                                       Whether this key is read-only, and its daily spending limit
  secrets set <NAME> --host <host>... [--header <name> [--format '<text {value}>']]
            [--allow '[GET,HEAD] /path/*']...  Store a secret sandboxes use without seeing it; the
                                               value is read from standard input, never an argument.
                                               --allow (paid): only these methods and paths get it
  secrets ls                                   Names, hosts and placeholders, never values
  secrets rm <NAME>                            Delete a secret
  keys create [--name <name>] [--read-only] [--daily-limit <usd>]
                                               A new API key for CI, approved by an owner in the browser
  referrals                                    Your referral link: you both get up to $500
  compare --from <provider> [--days 30]        What your usage would cost at e2b, daytona, vercel,
                                               modal, cloudflare, fly, blaxel, lambda-microvms,
                                               freestyle, prime and others, and what you save
  switch [--from <provider>]                   Moving from e2b, daytona, vercel, modal, cloudflare, fly
                                               or blaxel: record it before your first top-up, and
                                               that top-up is matched, up to $100
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

Connect
  sandbox ssh <id|name> [-- <command...>]      Log in over SSH; \`runtime sandbox ssh help\` for editors
  sandbox ssh config [--install]               Make \`ssh <id|name>.runtime\` work (VS Code, JetBrains)
  sandbox port-forward <id|name> <port|local:remote>...
                                               Forward local ports to ports in a sandbox

Observability
  sandbox metrics <id> [--range 1h]            CPU and memory over time (15m 1h 6h 24h 7d 30d)
  events [--sandbox <id>] [--type <type>]      Lifecycle events, newest first
  webhooks ls | create <url> [--events a,b] | test <id> | deliveries <id>
           | update <id> [--url u] [--events a,b] [--enable|--disable]
           | rotate-secret <id> [--keep <seconds>] | retry <deliveryId> | rm <id>
                                               Signed lifecycle events POSTed to your URL
  otel ls | create <endpoint> [--header K=V]... [--signals logs,metrics] | flush <id> | rm <id>
                                               Events and metrics to an OpenTelemetry endpoint

Products
  sandbox   Linux microVMs: exec, shell, files, code, previews, network, desktop
  snapshot  Saved sandboxes, disk and memory, to start or fork from
  image     Custom images from a Dockerfile, any public or private image, or a package list
  volume    Persistent disks to attach to sandboxes
  domain    Your own hostname for a sandbox's port, with HTTPS
  port      A public TCP port to a sandbox: databases, game servers
  address   A dedicated outbound address, for allow-lists
  tunnel    A WireGuard tunnel from your own network into your sandboxes
  network   Account-wide network settings: send outbound traffic through your own proxy
  Each has its own help: \`runtime sandbox help\`, \`runtime image help\`...

Every command takes --json. Keys: RUNTIME_API_KEY, or the connection from \`runtime login\`.
Behind a proxy: HTTPS_PROXY and NO_PROXY are read, on Node and Bun alike.
`;

const SANDBOX_HELP = `runtime sandbox <command>

  Every <id> below can also be the sandbox's name.

  run [--keep] [create options] -- <command>                  A fresh sandbox runs one command, then stops
  ssh <id|name> [-- <command...>] | ssh config [--install]    Log in over SSH, also from VS Code and JetBrains
  port-forward <id|name> <port|local:remote>...               Forward local ports to ports in it
  create [--name n] [--label k=v]... [--vcpu 2] [--memory 4096] [--disk 4096]
         [--cpu shared|reserved] [--cpu-floor <thousandths>] [--max-cost <usd>] [--max-total-cost <usd>]
         [--timeout <seconds>] [--on-timeout pause|stop] [--trial|--paid] [--no-wait]
         [--no-internet] [--allow <host>]... [--deny <host>]... [--connect <host:port>]...
         [--image <name:tag|imageId> | --snapshot <snapshotId>] [--volume <volumeId>:/data[:snapshot]]...
         [--idle-pause <seconds>] [--no-auto-wake] [--persistent] [--get-or-create]
                                                              Create one; prints its id
  ls [--all] [--label k=v]... [--state running]               List (live ones unless --all)
  get <id>                                                    One sandbox, in full
  exec <id> [--cwd /workspace] [--env K=V]... [--timeout <s>] -- <command...>
                                              Run and stream output; exits with its code
  spawn <id> [--pty] -- <command...>          Start in the background; prints a process id
  ps <id>                                     Running and recent processes
  logs <id> <processId> [-f]                  A process's output so far; -f follows it to the end
  kill <id> <processId> [--signal SIGTERM]
  shell <id> [--command "bash -l"]            An interactive terminal
  cp <src> <dst>                              Copy files or directories; name a sandbox
                                              path as <id>:/path, e.g. cp ./app sbx:/workspace/app
  cat <id> <path>                             Print a file
  files <id> [path] [--depth 2] [--glob '**/*.py']
  stop <id> | pause <id> | wake <id> | restart <id>
  extend <id> <seconds>                       More time before the lease ends
  update <id> [--name n] [--label k=v]... [--idle-pause <seconds>] [--auto-wake on|off]
              [--persistent on|off] [--max-total-cost <usd>|none]
                                              Change its settings; persistent keeps it running
  snapshot <id> [--name n] [--retention days] Keep its whole machine; prints the snapshot id
  mount <id> <s3|r2|gcs>://<bucket>[/prefix] <path> [--secret NAME] [--region r]
        [--endpoint https://...] [--account-id id] [--read-only]
                                              Your bucket as a directory; the proxy signs, the sandbox never sees the key
  mounts <id> | unmount <id> <path>           Its bucket mounts; unmount one
  fork <id> [--count 3] [--name n] [--keep-snapshot] [--trial|--paid]
                                              Copies of it as it is now, running; prints their ids
  run-code <id> <file|-> [--lang python|javascript|typescript|r|java|bash|go] [--context c] [--out-dir .]
                                              Run a notebook-style cell; charts saved as PNG
  watch <id> <path> [--recursive] [--include <glob>]... [--exclude <glob>]... [--events create,write,remove,rename,chmod]
                                              Print file changes as they happen, until Ctrl-C
  mcp catalog                                 MCP servers a sandbox can run (licence, settings, hosts)
  mcp <id> start <server>... [--secret SERVER.SETTING=SECRET]... [--env SERVER.NAME=value]...
                             [--option SERVER.NAME=value]... [--port 8765] [--replace]
                                              Start them; prints each URL and the header to send
  mcp <id> [status] | mcp <id> stop           Their state and fresh URLs; stop them
  preview <id> <port> [--public] [--ttl <s>]  Share a port at an HTTPS address (--public: paid only)
  preview rotate <id> <port>                  Refuse every token given out for a private port so
                                              far; prints the new token
  previews <id>                               Every shared port
  unshare <id> <port>                         Stop sharing a port
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

Examples
  id=$(runtime sandbox create)
  runtime sandbox exec $id -- python3 -c 'print(6*7)'
  runtime sandbox cp ./project $id:/workspace/project
  runtime sandbox stop $id
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
      const [name, inline] = arg.replace(/^-+/, "").split(/=(.*)/s, 2) as [
        string,
        string | undefined,
      ];
      if (!known.has(name))
        throw commandAfter && !meantOption(name, known)
          ? usage(
              `Unknown option ${arg.split("=")[0]}. If it belongs to the command, put the command after --: ${commandAfter}`,
            )
          : unknownOption(name, known);
      const value = inline ?? (booleans.includes(name) ? "true" : argv[++i]);
      if (value === undefined) throw usage(`--${name} needs a value.`);
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else positional.push(arg);
  }
  return { positional, flags, rest };
}

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
const integer = (args: Args, name: string) => {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw usage(`--${name} must be a whole number.`);
  return Number(value);
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

/** What the commands in cli-extras.ts use of this file. */
const kit = {
  parse: (argv: string[], booleans: readonly string[], values: readonly string[]) =>
    parse(argv, booleans, values),
  flag,
  has,
  integer,
  pairs,
  need: (value: string | undefined, what: string) => need(value, what),
  table: (rows: string[][]) => table(rows),
  usage: (message: string) => usage(message),
};
export type CliKit = typeof kit;

/** The product being run, so a mistake points at its own help. */
let product = "";
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
  "referrals",
  "compare",
  "switch",
  "ls",
  "feedback",
  "support",
  "docs",
  "mcp",
  "sandbox",
  "snapshot",
  "image",
  "volume",
  "domain",
  "port",
  "address",
  "tunnel",
  "network",
  "webhooks",
  "otel",
  "events",
  "help",
  "version",
];
/** Commands with a help of their own: `runtime <command> help`. */
const OWN_HELP = [
  "sandbox",
  "sandboxes",
  "sbx",
  "snapshot",
  "snapshots",
  "image",
  "images",
  "volume",
  "volumes",
  "keys",
  "webhooks",
  "webhook",
  "billing",
  "domain",
  "domains",
  "port",
  "ports",
  "address",
  "addresses",
  "tunnel",
  "tunnels",
  "network",
];
/** Sandbox commands that once sat at the top level. */
const SANDBOX_MOVED = ["run", "ssh", "port-forward", "forward"];
const SANDBOX_VERBS = [
  "run",
  "ssh",
  "port-forward",
  "create",
  "ls",
  "get",
  "stop",
  "pause",
  "wake",
  "restart",
  "snapshot",
  "mount",
  "mounts",
  "unmount",
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
  "unshare",
  "network",
  "desktop",
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
function describe(info: SandboxInfo): string {
  return table([
    ["id", info.id],
    ["name", info.name ?? "-"],
    ["state", info.state],
    [
      "shape",
      `${info.vcpu} vCPU, ${info.memoryMiB} MiB memory, ${info.diskMiB} MiB disk (${info.cpu})`,
    ],
    ["funding", info.funding],
    ["region", info.region],
    ["expires", info.expiresAt ?? "-"],
    ["auto wake", info.autoWake === false ? "off" : "on"],
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
    ["charged", dollars(BigInt(Math.round(Number(info.chargedMicros) || 0)))],
  ]);
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
  const [first, ...remaining] = argv.filter(
    (arg, index) => arg !== "--json" || (dash !== -1 && index > dash),
  );
  // Sandbox is one product of several, so its commands live under it
  // (AGENTS.md, 23 September 2026): `runtime sandbox run`, `sandbox ssh` and
  // `sandbox port-forward`. The old top-level forms were removed, not aliased.
  if (first && SANDBOX_MOVED.includes(first))
    throw usage(
      `\`${me} ${first}\` is now \`${me} sandbox ${first === "forward" ? "port-forward" : first}\`.`,
    );
  const nested =
    (first === "sandbox" || first === "sandboxes" || first === "sbx") &&
    SANDBOX_MOVED.includes(remaining[0] ?? "");
  const command = nested ? remaining[0]! : first;
  const rest = nested ? remaining.slice(1) : remaining;
  // `runtime sandbox create --help` is how an agent asks what a command takes:
  // answer with the product's help, never by running the command.
  const cut = remaining.indexOf("--");
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

  ${me} sandbox run -- python3 -c 'print(6*7)'
                                   A fresh sandbox runs one command, then stops
  ${me} sandbox create                   A sandbox that stays; prints its id
  ${me} sandbox exec <id> -- <command>   Run in it
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
      [...CREATE_FLAGS, "keep"],
      [...CREATE_VALUES, "cwd", "env"],
      `${me} sandbox run -- python3 -c 'print(6*7)'`,
    );
    const commandLine = args.rest ?? args.positional;
    if (!commandLine.length)
      throw usage(`Give the command after --: ${me} sandbox run -- python3 -c 'print(6*7)'`);
    const runtime = await client(env);
    const timeout = integer(args, "timeout");
    const { timeoutSeconds: _lease, ...input } = createInput(args);
    const sbx = await runtime.sandboxes.create(input, { onCapacityWait: waiting(out) });
    let cleanup: Promise<boolean> | undefined;
    // SIGINT and normal completion share one stop. Keep an absolute deadline
    // across the stop retries and final state check, so cleanup cannot hang.
    const stop = () =>
      (cleanup ??= (async () => {
        const signal = AbortSignal.timeout(30_000);
        try {
          await sbx.stop({ wait: false, signal });
          if (sbx.state !== "stopped") await sbx.waitFor("stopped", { timeoutSeconds: 25, signal });
          if (sbx.state !== "stopped") throw new Error(`Sandbox is still ${sbx.state}.`);
          return true;
        } catch (error) {
          out.error(
            describeError(
              new RuntimeError({
                code: "cleanup_failed",
                status: 0,
                message: `Could not confirm that sandbox ${sbx.id} stopped. ${error instanceof Error ? error.message : String(error)}`,
                hint: `Check it and retry cleanup with: ${me} sandbox stop ${sbx.id}`,
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
      code = await execute(sbx, commandLine, args, out, timeout, has(args, "keep"));
    } finally {
      try {
        if (has(args, "keep"))
          out.error(
            `Kept sandbox ${sbx.id}. Run more with: ${me} sandbox exec ${sbx.id} -- <command>`,
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
    const funding = !spend
      ? undefined
      : [
          ...(trialLeft > 0
            ? [
                `free trial, ${trialLeft.toLocaleString("en-US", { maximumFractionDigits: 1 })} hours left`,
              ]
            : []),
          ...(credit > 0n ? [`${dollars(credit)} of credit`] : []),
        ].join("; ") || "no trial time or credit left: runtime billing";
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
    const l = await (await client(env)).limits.get();
    const usd = (micros: string) =>
      `$${(Number(BigInt(micros) / 10_000n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
      ]),
      l,
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
      ...(integer(args, "limit") ? { limit: integer(args, "limit")! } : {}),
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
      ...(integer(args, "limit") ? { limit: integer(args, "limit")! } : {}),
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
    const { claimWalletAccount, openWalletAccount } = await import("./wallet.js");
    return billingCommand(
      rest,
      parse(rest, ["wait", "new-account", "accept-terms"], []),
      out,
      () => client(env),
      undefined,
      {
        open: (input) => openWalletAccount(input, { authUrl: origins.auth }),
        claim: (code) => claimWalletAccount(code, { authUrl: origins.auth }),
        save: (key, orgId) =>
          connectionStore(env).save({
            version: 1,
            apiOrigin: origins.api,
            authOrigin: origins.auth,
            key,
            connectionId: "pasted",
            orgId,
            agentName: "Wallet agent",
          }),
      },
    );
  }
  if (command === "referrals") {
    const r = await (await client(env)).referrals.get();
    const usd = (micros: string) =>
      `$${(Number(BigInt(micros) / 10_000n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    print(
      [
        `Your link: ${r.link}`,
        "",
        `When a company signs up with it and makes its first top-up of ${usd(r.minPurchaseMicros)} or more,`,
        `you each get credit equal to that top-up: at least ${usd(r.rewardMicros)}, at most ${usd(r.maxRewardMicros)}`,
        `(up to ${usd(r.yearlyCapMicros)} a year for you).`,
        ...(r.enabled ? [] : ["The program is paused: new sign-ups are not counted right now."]),
        "",
        table([
          ["signed up", String(r.signedUp)],
          ["waiting for a first top-up", String(r.pending)],
          ["paid", String(r.paid)],
          ["earned", usd(r.earnedMicros)],
          [`left this year (${r.year})`, usd(r.capRemainingMicros)],
        ]),
      ].join("\n"),
      r,
    );
    return 0;
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
        : "Nothing yet. Start with: runtime sandbox create",
      items,
    );
    return 0;
  }
  if (command === "ssh") {
    product = "ssh";
    return (await import("./ssh.js")).sshCommand(rest, env, out, () => client(env), me);
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
  const networkProduct =
    { domains: "domain", ports: "port", addresses: "address", tunnels: "tunnel" }[command] ??
    command;
  if ((NETWORK_PRODUCTS as readonly string[]).includes(networkProduct)) {
    product = networkProduct;
    return networkProductCommand(
      networkProduct as NetworkProduct,
      rest,
      parse(rest, ["ipv6"], ["sandbox", "subnet", "public-key", "route", "out", "host", "secret"]),
      out,
      () => client(env),
    );
  }
  throw unknown("command", command, COMMANDS);
}

/** `runtime usage` for a person: the balance, the trial and what each kind
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

function usageSummary(u: Usage): string {
  const micros = (value: unknown) =>
    typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      ? BigInt(value)
      : 0n;
  const hours = (ms: number) =>
    (ms / 3_600_000).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const takenBack = micros(u.takenBack);
  const rows: string[][] = [
    ["available", dollars(micros(u.available))],
    ["credited", dollars(micros(u.credited))],
    // spent includes what refunds and disputes took back: say that part on
    // its own line, so "spent" reads as what was used.
    ["used", dollars(micros(u.spent) - takenBack)],
    ...(takenBack > 0n ? [["returned by refunds and disputes", dollars(takenBack)]] : []),
    // Holds cover running sandboxes and the hour ahead of stored snapshots,
    // images and volumes (pricing guide), so an account with nothing running
    // can still show one.
    ["held for running sandboxes and this hour's storage", dollars(micros(u.held))],
  ];
  if (micros(u.expired) > 0n) rows.push(["expired or taken back", dollars(micros(u.expired))]);
  if (u.trial)
    rows.push([
      "free trial",
      `${hours(u.trial.availableMs)} of ${hours(u.trial.totalMs)} hours left${u.trial.reservedMs > 0 ? `, ${hours(u.trial.reservedMs)} held by running sandboxes` : ""}`,
    ]);
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
  for (const resource of u.resources ?? []) {
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
    process: { state: string; exitCode: number | null } | null;
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
    truncated,
    chunks,
  };
}

/** Dollars from integer microdollars: cents from a dollar up, four places
 * below one, and every place below a hundredth of a cent, so a short trial
 * test never reads as $0.0000. */
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

/** A date as the CLI writes one: 23 September 2026. */
const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** One line on the switching credit: how to claim it, or what it did. A
 * switch already on record is named with its provider and date, so it never
 * reads as if this command recorded it, or recorded the provider it names. */
function switchingLine(summary: SwitchingSummary, provider?: SwitchProvider): string | undefined {
  const cap = dollars(summary.maxMicros);
  const sw = summary.switch;
  if (!sw) {
    if (!summary.eligible || !provider) return undefined;
    return `Switching from ${RIVAL_NAMES[provider]}? Run \`${me} switch --from ${provider}\` before your first top-up and we match that top-up, up to ${cap}.`;
  }
  const from = RIVAL_NAMES[sw.provider];
  const recorded = `This organization's switch from ${from} was recorded on ${longDate(sw.recordedAt)}`;
  const once =
    provider && provider !== sw.provider
      ? ` A switch is recorded once, so it stays ${from}, not ${RIVAL_NAMES[provider]}.`
      : "";
  switch (sw.status) {
    case "pending":
      return `${recorded}: its first top-up is matched, up to ${cap}, once the payment settles.${once}`;
    case "paid":
      return `${recorded} and matched its first top-up: ${dollars(sw.creditMicros)} of credit.${once}`;
    case "superseded":
      return `${recorded}; its first top-up was matched by a referral instead, which is never less than the switching credit.${once}`;
    case "reversed":
      return `${recorded}; the top-up it matched was refunded, so the credit was taken back.${once}`;
    case "refused":
      return sw.refusedReason === "program_off"
        ? `${recorded}; the switching credit was paused when its first top-up arrived.${once}`
        : `${recorded}; its first top-up was not matched. Ask support if you think that is wrong.${once}`;
  }
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

/** The sandboxes the free trial paid for, said beside what was priced. */
function trialNote(trial: number, all: number, trialSeconds: number): string {
  if (!trial) return "";
  const which =
    trial === all
      ? all === 1
        ? "It"
        : "All of them"
      : `${trial} of them, ${runningTime(trialSeconds)} of that time,`;
  return ` ${which} ran on the free trial, which charged nothing; Runtime's side prices ${trial === 1 ? "it" : "them"} at the standard rates, what the same work costs on paid credit.`;
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
      print(
        switchingLine(summary) ??
          (summary.eligible
            ? `Moving from a rival? Run \`${me} switch --from <provider>\` (${summary.providers.join(", ")}) before your first top-up, and that top-up is matched, up to ${dollars(summary.maxMicros)}.`
            : "The switching credit matches a first top-up, and this organization has made one already."),
        summary,
      );
      return 0;
    }
    const provider = SWITCH_FROM[from];
    if (!provider || from === "fly-machines")
      throw unknown("provider", from, Object.keys(RIVAL_NAMES));
    const summary = await api.record({ provider });
    print(
      `Recorded: switching from ${RIVAL_NAMES[provider]}. ${switchingLine(summary) ?? ""}`.trim(),
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
  const line = switchingLine(
    c.switching,
    Object.hasOwn(SWITCH_FROM, from) ? SWITCH_FROM[from] : undefined,
  );
  if (line) lines.push("", line);
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
  switch (verb) {
    case "create": {
      const args = parse(rest, CREATE_FLAGS, CREATE_VALUES);
      const sbx = await runtime.sandboxes.create(createInput(args), {
        onCapacityWait: waiting(out),
      });
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
      });
      const all = await page.toArray(1000);
      // Stopped sandboxes are hidden by default; say so, or an agent that
      // stopped everything reads "No sandboxes" as "never had any".
      const hidden =
        out.json || args.flags.size
          ? null
          : await runtime.sandboxes.list({ state: ["stopped"], limit: 50 });
      const stopped = hidden?.data.length
        ? `${hidden.data.length}${hidden.hasMore ? "+" : ""} stopped; runtime sandbox ls --all shows them.`
        : "";
      const rows = all.map((s) => [
        s.id,
        s.info.name ?? "-",
        s.state,
        `${s.info.vcpu}/${s.info.memoryMiB}`,
        s.info.funding,
        s.info.expiresAt ?? "-",
      ]);
      print(
        [
          rows.length
            ? table([["ID", "NAME", "STATE", "CPU/MIB", "FUNDING", "EXPIRES"], ...rows])
            : stopped
              ? "No live sandboxes."
              : "No sandboxes. Create one: runtime sandbox create",
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
    case "stop":
    case "pause":
    case "wake":
    case "restart": {
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
    case "snapshot": {
      const args = parse(rest, [], ["name", "retention"]);
      const sbx = await get(args.positional[0]);
      const snapshot = await sbx.snapshot({
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
        ...(integer(args, "retention") ? { retentionDays: integer(args, "retention")! } : {}),
      });
      print(snapshot.id, snapshot);
      return 0;
    }
    case "fork": {
      const args = parse(rest, ["keep-snapshot", "trial", "paid"], ["count", "name"]);
      const sbx = await get(args.positional[0]);
      const forks = await sbx.fork({
        count: integer(args, "count") ?? 1,
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
        ...(has(args, "keep-snapshot") ? { keepSnapshot: true } : {}),
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
        ["name", "label", "idle-pause", "auto-wake", "persistent", "max-total-cost"],
      );
      const sbx = await get(args.positional[0]);
      const onOff = (name: string) => {
        const value = flag(args, name);
        if (value === undefined) return undefined;
        if (value !== "on" && value !== "off") throw usage(`--${name} takes on or off.`);
        return value === "on";
      };
      const cost = flag(args, "max-total-cost");
      if (cost !== undefined && cost !== "none" && !/^\d+(\.\d{1,6})?$/.test(cost))
        throw usage("--max-total-cost takes dollars, such as 25 or 2.50, or none.");
      const settings = {
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
        ...(integer(args, "idle-pause") !== undefined
          ? { idlePauseSeconds: integer(args, "idle-pause")! }
          : {}),
        ...(onOff("auto-wake") === undefined ? {} : { autoWake: onOff("auto-wake")! }),
        ...(onOff("persistent") === undefined ? {} : { persistent: onOff("persistent")! }),
        ...(cost === undefined
          ? {}
          : {
              maxTotalCostMicros: cost === "none" ? null : Math.round(Number(cost) * 1e6),
            }),
      };
      if (!Object.keys(settings).length)
        throw usage(
          "Say what to change: --name, --label, --idle-pause, --auto-wake, --persistent or --max-total-cost.",
        );
      await sbx.update(settings);
      print(describe(sbx.info), sbx.info);
      return 0;
    }
    case "extend": {
      const sbx = await get(rest[0]);
      const seconds = Number(need(rest[1], "seconds, e.g. runtime sandbox extend <id> 600"));
      await sbx.extend(seconds);
      print(`${sbx.id} now ends at ${sbx.info.expiresAt}`, sbx.info);
      return 0;
    }
    case "exec": {
      const args = parse(rest, [], ["cwd", "env", "timeout"], `${me} sandbox exec <id> -- ls -la`);
      const command = args.rest ?? args.positional.slice(1);
      if (!command.length)
        throw usage("Give the command after --: runtime sandbox exec <id> -- ls -la");
      const sbx = await use(args.positional[0]);
      return execute(sbx, command, args, out, integer(args, "timeout"));
    }
    case "spawn": {
      const args = parse(rest, ["pty"], ["cwd", "env"], `${me} sandbox spawn <id> -- npm run dev`);
      const command = args.rest ?? [];
      if (!command.length)
        throw usage("Give the command after --: runtime sandbox spawn <id> -- npm run dev");
      const sbx = await use(args.positional[0]);
      const proc = await sbx.spawn(command.length === 1 ? command[0]! : command, {
        ...(has(args, "pty") ? { pty: { cols: 120, rows: 40 } } : {}),
        ...(flag(args, "cwd") ? { cwd: flag(args, "cwd")! } : {}),
        ...(args.flags.has("env") ? { env: pairs(args, "env") } : {}),
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
              ["PROCESS", "STATE", "EXIT", "COMMAND"],
              ...list.map((p) => [p.id, p.state, String(p.exitCode ?? "-"), p.command]),
            ])
          : "No processes.",
        list,
      );
      return 0;
    }
    case "logs": {
      const args = parse(rest, ["f", "follow"], []);
      const sbx = await use(args.positional[0]);
      const proc = await sbx.processes.get(need(args.positional[1], "a process id"));
      if (has(args, "f") || has(args, "follow")) {
        for await (const event of proc.output())
          if (event.type === "stdout") process.stdout.write(event.data);
          else if (event.type === "stderr") process.stderr.write(event.data);
          else if (out.json) out.write(JSON.stringify(event));
        return 0;
      }
      /* Without -f, what it has printed so far, then back to the prompt, as
         `docker logs` does: a server's log is read, not followed forever. */
      const so = await outputSoFar(runtime, sbx.id, proc.id);
      if (out.json) {
        out.write(JSON.stringify(so));
        return 0;
      }
      for (const chunk of so.chunks)
        (chunk.stream === "stderr" ? process.stderr : process.stdout).write(chunk.text);
      if (so.state === "running")
        process.stderr.write(
          `[${proc.id} is still running; follow it: ${me} sandbox logs ${sbx.id} ${proc.id} -f]\n`,
        );
      return 0;
    }
    case "kill": {
      const args = parse(rest, [], ["signal"]);
      const sbx = await use(args.positional[0]);
      const proc = await sbx.processes.get(need(args.positional[1], "a process id"));
      await proc.kill((flag(args, "signal") ?? "SIGTERM") as "SIGTERM");
      print(`Signalled ${proc.id}.`, { processId: proc.id });
      return 0;
    }
    case "shell": {
      const args = parse(rest, [], ["command"]);
      const sbx = await use(args.positional[0]);
      return shell(sbx, flag(args, "command"));
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
        ...(integer(args, "depth") ? { depth: integer(args, "depth")! } : {}),
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
      const source = remote(need(from, "a source"));
      const target = remote(need(to, "a destination"));
      // A destination ending in / (or a local directory) takes the source's
      // own name inside it, as cp does.
      const inside = (dir: string, path: string) =>
        `${dir.replace(/\/+$/, "")}/${path.replace(/\/+$/, "").split("/").pop()}`;
      if (source && !target) {
        const local = await import("node:fs/promises").then((fs) => fs.stat(to!).catch(() => null));
        await (
          await use(source.id)
        ).files.download(
          source.path,
          to!.endsWith("/") || local?.isDirectory() ? inside(to!, source.path) : to!,
        );
      } else if (!source && target)
        await (
          await use(target.id)
        ).files.upload(from!, target.path.endsWith("/") ? inside(target.path, from!) : target.path);
      else throw usage("Name exactly one side as <sandbox-id>:/path.");
      print(`Copied ${from} to ${to}.`, { from, to });
      return 0;
    }
    case "run-code":
      return runCode(await use(rest[0]), rest.slice(1), out);
    case "preview": {
      if (rest[0] === "rotate") {
        const port = portOf(rest[2], "runtime sandbox preview rotate <id> 3000");
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
      const port = portOf(args.positional[1], "runtime sandbox preview <id> 3000");
      const sbx = await use(args.positional[0]);
      const preview = await sbx.previews.create(port, {
        ...(has(args, "public") ? { visibility: "public" as const } : {}),
        ...(integer(args, "ttl") ? { ttlSeconds: integer(args, "ttl")! } : {}),
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
    case "previews": {
      const list = await (await use(rest[0])).previews.list();
      print(
        list.length
          ? table([
              ["PORT", "VISIBILITY", "URL"],
              ...list.map((p) => [String(p.port), p.visibility, p.url]),
            ])
          : "No shared ports. Share one: runtime sandbox preview <id> 3000",
        list,
      );
      return 0;
    }
    case "unshare": {
      const port = portOf(rest[1], "runtime sandbox unshare <id> 3000");
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
async function readSecret(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
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
            return done(value);
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
  const args = parse(rest, [], ["host", "header", "format", "allow", "value"]);
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const rows = (list: Secret[]) =>
    list.length
      ? table([
          ["name", "hosts", "header", "placeholder", "allow"],
          ...list.map((secret) => [
            secret.name,
            secret.hosts.join(","),
            secret.header ? `${secret.header}: ${secret.format ?? "{value}"}` : "-",
            secret.placeholder,
            ruleText(secret.rules),
          ]),
        ])
      : "No secrets.";
  if (verb === "ls" || verb === "list" || verb === undefined) {
    const list = await (await client(env)).secrets.list();
    print(rows(list), list);
    return 0;
  }
  if (verb === "set") {
    const name = need(args.positional[0], "the secret's name, such as OPENAI_API_KEY");
    const hosts = args.flags.get("host") ?? [];
    if (!hosts.length)
      throw usage(
        "Give --host once for each host the value may go to, such as --host api.openai.com.",
      );
    if (args.flags.has("value"))
      throw usage(
        'The value is read from standard input, never an argument: printf %s "$KEY" | runtime secrets set NAME --host ...',
      );
    const value = await read();
    if (!value)
      throw usage(
        'The value is empty. Pipe it in: printf %s "$KEY" | runtime secrets set NAME --host ...',
      );
    const header = flag(args, "header");
    const format = flag(args, "format");
    const allow = args.flags.get("allow");
    const rules = allow ? parseSecretRules(allow) : undefined;
    const saved = await (
      await client(env)
    ).secrets.set(name, {
      value,
      hosts,
      ...(header ? { header } : {}),
      ...(format ? { format } : {}),
      ...(rules ? { rules } : {}),
    });
    print(
      [
        `Stored ${saved.name}. Sandboxes see ${saved.name}=${saved.placeholder}.`,
        saved.header
          ? `Requests to ${saved.hosts.join(", ")} get ${saved.header}: ${saved.format ?? "{value}"} over HTTPS.`
          : `Over HTTPS to ${saved.hosts.join(", ")}, the placeholder becomes the value in the URL and headers.`,
        ...(saved.rules?.length ? [`Only these requests get it: ${ruleText(saved.rules)}.`] : []),
        ...(saved.enforced
          ? []
          : ["A host is catching up; running sandboxes have it within a minute."]),
      ].join("\n"),
      saved,
    );
    return 0;
  }
  if (verb === "rm" || verb === "delete") {
    const name = need(args.positional[0], "the secret's name");
    const removed = await (await client(env)).secrets.delete(name);
    print(`Deleted ${name}.`, removed);
    return 0;
  }
  throw usage("secrets takes set, ls or rm. Run `runtime help`.");
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
    ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
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
        ...(integer(args, "width") ? { width: integer(args, "width")! } : {}),
        ...(integer(args, "height") ? { height: integer(args, "height")! } : {}),
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
    `${me} sandbox desktop <id> start|stop|screenshot|open|click|type|press|windows|record`,
  );
}

const KEYS_HELP = `runtime keys <command>

  create [--name <name>] [--read-only] [--daily-limit <usd>]
      A new API key, for a CI runner or any place with no browser. Prints a link
      and a code; an account owner approves the key in the browser, seeing its
      name, access and limit. The key is printed once, alone on stdout, and
      lasts until revoked. --json prints it as JSON, still alone on stdout.

  runtime keys create --name ci --daily-limit 25 | gh secret set RUNTIME_API_KEY

List, limit and revoke keys at https://withruntime.com/account/keys.
`;

/* `runtime keys create`: a key made from the terminal and approved in the
   browser. Marc, 23 September 2026; ARCHITECTURE.md section 10, "Keys from the
   terminal". Only the options the keys page offers. No key can list, create or
   revoke keys through the API, so `ls` and `revoke` send you to the page. */
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
  if (verb !== "ls" && verb !== "list")
    throw unknown("account command", verb, ["ls", "switch", "add", "close"]);
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

async function keys(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  product = "keys";
  const [verb, ...rest] = argv;
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    out.write(out.json ? JSON.stringify({ usage: named(KEYS_HELP) }) : named(KEYS_HELP));
    return 0;
  }
  if (verb === "ls" || verb === "list" || verb === "revoke")
    throw usage(
      "List and revoke keys at https://withruntime.com/account/keys. No key can list or revoke keys.",
    );
  if (verb !== "create") throw unknown("keys command", verb, ["create"]);
  const args = parse(rest, ["read-only"], ["name", "daily-limit"]);
  const known = new Set(["name", "read-only", "daily-limit"]);
  for (const name of args.flags.keys())
    if (!known.has(name)) throw usage(`Unknown option --${name}.`);
  if (args.positional.length || args.rest) throw usage(`Unexpected ${args.positional[0] ?? "--"}.`);
  const readOnly = has(args, "read-only");
  const limit = flag(args, "daily-limit");
  if (readOnly && limit !== undefined)
    throw usage("A read-only key cannot spend, so it takes no --daily-limit.");
  const { createKey, dailyLimitMicros } = await import("./keys.js");
  const created = await createKey(
    {
      name: flag(args, "name") ?? (readOnly ? "Read-only key" : "My API key"),
      access: readOnly ? "read" : "full",
      dailyLimitMicros: limit === undefined ? null : dailyLimitMicros(limit),
    },
    env,
    { notify: out.error },
  );
  const { confirm, ...key } = created;
  out.write(out.json ? JSON.stringify(key) : key.key);
  const terms = [
    key.access === "read" ? "read only" : "full access",
    key.access === "read"
      ? undefined
      : key.dailyLimitMicros === null
        ? "no daily limit"
        : `daily limit $${(Number(BigInt(key.dailyLimitMicros) / 10_000n) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    "until revoked",
  ].filter(Boolean);
  out.error(
    `Created key "${key.name}" (${terms.join(", ")}). Store it now: it is not shown again, and Runtime keeps only a hash of it.\nIn CI, give it to your jobs as RUNTIME_API_KEY from the secret store.`,
  );
  await confirm();
  return 0;
}

const SNAPSHOT_HELP = `runtime snapshot <command>

  ls [--sandbox <id>] [--name n]              Your snapshots
  get <id>                                    One snapshot
  extend <id> <days>                          Keep it longer
  rm <id>                                     Delete it
  Take one with \`runtime sandbox snapshot <sandboxId>\`; start a sandbox from it
  with \`runtime sandbox create --snapshot <snapshotId>\`.
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
      ).toArray(1000);
      print(
        all.length
          ? table([
              ["ID", "NAME", "STATUS", "FROM", "EXPIRES"],
              ...all.map((s) => [s.id, s.name ?? "-", s.status, s.sourceSandboxId, s.expiresAt]),
            ])
          : "No snapshots. Take one: runtime sandbox snapshot <sandboxId>",
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
      const days =
        integer(parse(rest.slice(1), [], ["days"]), "days") ?? Number(need(rest[1], "days"));
      const found = await api.extend(need(rest[0], "a snapshot id"), days);
      print(`${found.id} kept until ${found.expiresAt}`, found);
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

const IMAGE_HELP = `runtime image <command>

  build [<folder>] [-f <Dockerfile>] | --from <image> | --pip <pkg>... --apt <pkg>... --npm <pkg>...
        [-t name[:tag]]... [--target <stage>] [--build-arg K=V]... [--no-cache]
        [--start <command>] [--ready-port <port> | --ready-command <command>]
        [--max-image-mib 8192] [--disk-mib <1024-32768>] [--timeout <seconds>]
                        Build and stream the log; prints the image id when ready.
                        --disk-mib sizes the build's scratch disk, where earlier
                        stages and the context live.
                        A Dockerfile's folder is the context: everything its
                        .dockerignore leaves in (100 MiB compressed at most) is
                        sent, and a rebuild sends only what changed.
  ls                    Your images
  versions <name>       Every version of a name, newest first
  get <image>           One image: an id, name, name:tag or name@version
  logs <image> [--follow]
                        Its build log
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
  Use one: runtime sandbox create --image app:latest
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
];

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
        ...(integer(args, "max-image-mib") ? { maxImageMiB: integer(args, "max-image-mib")! } : {}),
        ...(integer(args, "disk-mib") ? { diskMiB: integer(args, "disk-mib")! } : {}),
        ...(integer(args, "timeout") ? { timeoutSeconds: integer(args, "timeout")! } : {}),
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
        ...(integer(args, "ready-port") ? { readyPort: integer(args, "ready-port")! } : {}),
        ...(flag(args, "ready-command") ? { readyCommand: flag(args, "ready-command")! } : {}),
        ...(integer(args, "ready-timeout")
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
        const file = resolve(context, dockerfile ?? "Dockerfile");
        const text = await readFile(file, "utf8").catch(() => {
          throw usage(`No Dockerfile at ${file}.`);
        });
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
      const built = await api.build(input, {
        ...(out.json ? {} : { onLog: (line) => out.error(line.text) }),
      });
      print(built.id, built);
      return 0;
    }
    case "ls":
    case "list":
    case "versions": {
      const name = verb === "versions" ? need(rest[0], "a name") : undefined;
      const all = await (await api.list(name ? { name } : {})).toArray(1000);
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
            : "No images. Build one: runtime image build --pip pandas",
        all,
      );
      return 0;
    }
    case "get": {
      const found = await api.resolve(need(rest[0], "an image"));
      print(JSON.stringify(found, null, 2), found);
      return 0;
    }
    case "logs": {
      const args = parse(rest, ["follow", "f"], []);
      const id = (await api.resolve(need(args.positional[0], "an image"))).id;
      if (has(args, "follow") || has(args, "f")) {
        const lines: string[] = [];
        const done = await api.followLogs(id, (line) =>
          out.json ? lines.push(line.text) : out.write(line.text),
        );
        if (out.json) print("", { lines, state: done.state });
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
      print(lines.join("\n") || "(no log yet)", lines);
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
            : "No registry credentials. Store some: runtime image registry set ghcr.io --username you",
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

const VOLUME_HELP = `runtime volume <command>

  create --size-mib <N> [--name n]            A persistent ext4 disk; prints its id
  ls                                          Your volumes
  get <id>                                    One volume, its backups and where it is attached
  rm <id>                                     Delete it and everything on it (its backups stay)
  backup <id> [--retention-days N] [--no-wait]
                                              Back it up now, off its host; prints the backup id
  backups [<id>]                              Backups, newest first (of one volume, if given)
  restore <backupId> [--name n]               A new volume from a backup, on any host
  backup-rm <backupId>                        Delete a backup
  backup-policy <id> [--daily on|off] [--retention-days N]
                                              Daily backups on or off, and how long each is kept
  Attach one: runtime sandbox create --volume <id>:/data
  Volumes are backed up off their host daily unless you turn it off.
`;

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
      const args = parse(rest, [], ["size-mib", "name"]);
      const created = await api.create({
        sizeMiB: integer(args, "size-mib") ?? Number(need(undefined, "--size-mib <N>")),
        ...(flag(args, "name") ? { name: flag(args, "name")! } : {}),
      });
      print(created.id, created);
      return 0;
    }
    case "ls":
    case "list": {
      const all = await (await api.list()).toArray(1000);
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
          : "No volumes. Create one: runtime volume create --size-mib 10240",
        all,
      );
      return 0;
    }
    case "get": {
      const found = await api.get(need(rest[0], "a volume id"));
      print(JSON.stringify(found, null, 2), found);
      return 0;
    }
    case "rm":
    case "delete": {
      const found = await api.delete(need(rest[0], "a volume id"));
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
        out.error(`Copying it off the host; check with: ${me} volume backups ${id}`);
      print(made.id, made);
      return 0;
    }
    case "backups": {
      const volumeId = rest[0];
      const all = await (await api.backups(volumeId ? { volumeId } : {})).toArray(1000);
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
                b.expiresAt,
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
        out.error(`Restoring; check with: ${me} volume get ${created.id}`);
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
      const args = parse(rest, [], ["daily", "retention-days"]);
      const id = need(args.positional[0], "a volume id");
      const daily = flag(args, "daily");
      if (daily !== undefined && !["on", "off", "true", "false"].includes(daily))
        throw usage("--daily takes on or off.");
      const days = integer(args, "retention-days");
      if (daily === undefined && days === undefined)
        throw usage("Give --daily on|off, --retention-days N or both.");
      const updated = await api.setBackupPolicy(id, {
        ...(daily === undefined ? {} : { daily: daily === "on" || daily === "true" }),
        ...(days === undefined ? {} : { retentionDays: days }),
      });
      print(
        `${updated.id} daily backups ${updated.backups.daily ? "on" : "off"}, kept ${updated.backups.retentionDays} days`,
        updated,
      );
      return 0;
    }
  }
  throw unknown("volume command", verb, [
    "create",
    "ls",
    "get",
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
];
/** Says on standard error, once for each reason, why a create has not
 * answered yet: it is waiting for a trial slot or room, which can take up to
 * two minutes, and silence reads as a hang. */
function waiting(out: Out): (refusal: RuntimeError) => void {
  const said = new Set<string>();
  return (refusal) => {
    if (said.has(refusal.code)) return;
    said.add(refusal.code);
    out.error(`${refusal.message} Waiting for room, up to 2 minutes; Ctrl-C stops.`);
  };
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
  "volume",
];
/** Dollars from the command line as integer microdollars: 25, 2.50 or 0.000001. */
function usdMicros(args: Args, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw usage(`--${name} takes dollars, such as 25 or 2.50.`);
  return Math.round(Number(value) * 1e6);
}
/** A create body from the command line's flags. */
function createInput(args: Args): CreateSandbox & { wait?: boolean } {
  const rules = ["allow", "deny", "connect"].filter((name) => args.flags.has(name));
  return {
    ...(flag(args, "image") ? { image: flag(args, "image")! } : {}),
    ...(flag(args, "snapshot") ? { snapshot: flag(args, "snapshot")! } : {}),
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
    ...(integer(args, "vcpu") ? { vcpu: integer(args, "vcpu")! } : {}),
    ...(integer(args, "memory") ? { memoryMiB: integer(args, "memory")! } : {}),
    ...(integer(args, "disk") ? { diskMiB: integer(args, "disk")! } : {}),
    ...(flag(args, "cpu") ? { cpu: oneOf(args, "cpu", ["shared", "reserved"] as const) } : {}),
    ...(integer(args, "cpu-floor") ? { cpuFloorMillis: integer(args, "cpu-floor")! } : {}),
    ...(flag(args, "region") ? { region: flag(args, "region")! } : {}),
    ...(usdMicros(args, "max-cost") ? { maxCostMicros: usdMicros(args, "max-cost")! } : {}),
    ...(usdMicros(args, "max-total-cost")
      ? { maxTotalCostMicros: usdMicros(args, "max-total-cost")! }
      : {}),
    ...(integer(args, "timeout") ? { timeoutSeconds: integer(args, "timeout")! } : {}),
    ...(flag(args, "on-timeout")
      ? { onLeaseEnd: oneOf(args, "on-timeout", ["pause", "stop"] as const) }
      : {}),
    ...(integer(args, "idle-pause") !== undefined
      ? { idlePauseSeconds: integer(args, "idle-pause")! }
      : {}),
    ...(has(args, "no-auto-wake") ? { autoWake: false } : {}),
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
  sbx: Sandbox,
  command: string[],
  args: Args,
  out: Out,
  timeout: number | undefined,
  /** `run` stops its whole sandbox on Ctrl-C, so it handles the signal itself. */
  ownInterrupt = true,
): Promise<number> {
  const target = command.length === 1 ? command[0]! : command;
  const extras = await import("./cli-extras.js");
  const stdin = await extras.pipedStdin();
  const options = {
    ...(stdin ? { stdin } : {}),
    ...(flag(args, "cwd") ? { cwd: flag(args, "cwd")! } : {}),
    ...(args.flags.has("env") ? { env: pairs(args, "env") } : {}),
    ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
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
  if (out.json) out.write(JSON.stringify(result));
  // Here the output streamed, whose timeout is 24 hours unless one was given
  // (Sandbox.exec); `--json` answers the result and prints no such line.
  else if (result.timedOut)
    out.error(
      `runtime: timed out after ${timeout ? `${timeout} s` : "24 h"}; the command's process group was killed.`,
    );
  // Never drop output silently: say so, and do not exit 0.
  const lost = extras.lostOutput(result, sbx.id);
  if (lost && !out.json) out.error(lost);
  const code = result.timedOut ? 124 : Math.min(255, Math.max(0, result.exitCode ?? 1));
  return lost && code === 0 ? 1 : code;
}

async function shell(sbx: Sandbox, command?: string): Promise<number> {
  const stdin = process.stdin;
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const terminal = await sbx.terminal({
    ...size(),
    ...(command ? { command } : {}),
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
        },
      });
    return `Error [${error.code}]: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ""}${
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
  const cpu = m.points.map((p) => p.cpuPercent);
  const memory = m.points.map((p) => p.memoryBytes);
  const peak = Math.max(0, ...m.points.map((p) => p.cpuPeakPercent ?? p.cpuPercent ?? 0));
  const latest = m.latest;
  return [
    table([
      ["state", m.state],
      [
        "cpu now",
        latest?.cpuPercent == null
          ? "no reading in the last 15 minutes"
          : `${latest.cpuPercent}% of ${m.vcpu} vCPU (${latest.cpuCores} cores)`,
      ],
      ["memory now", latest ? `${mib(latest.memoryBytes)} of ${mib(m.memoryLimitBytes)}` : "-"],
      [`cpu, ${m.range}`, m.points.length ? `${spark(cpu)}  peak ${peak}%` : "no readings"],
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
        ...(integer(args, "limit") ? { limit: integer(args, "limit")! } : {}),
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
