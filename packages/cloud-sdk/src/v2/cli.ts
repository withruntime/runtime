/* `runtime`: every verb and shortcut the API serves, as commands read from
   its own description (./table.ts). Nothing here names a product: parsing
   argv into a verb's arguments, printing its answer, and the primitives a
   composition of verbs cannot be (standard input and output, a key from
   the environment or from `runtime login`, the stdio MCP bridge) are all
   it does. */

import { readFileSync } from "node:fs";
import { Runtime } from "../generated/index.js";
import { Transport, callRoute, routesOf, type Route } from "../generated/runtime.js";
import { type Command, type Flag, commandsOf, document, kebab } from "./table.js";
import { obj, str } from "./json.js";
import { serveMcp } from "./mcp.js";
import { login, logout, savedKey } from "./login.js";
import { serveMachinesApi } from "./shims/fly.js";

/** This package's version, from its package.json. */
function version(): string {
  for (const p of ["../package.json", "../../package.json"]) {
    try {
      const v = str(obj(JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")))["version"]);
      if (v !== undefined) return v;
    } catch {
      // the next place
    }
  }
  return "unknown";
}

function usage(commands: Command[], from: string): string {
  const products = new Map<string, Command[]>();
  for (const c of commands) products.set(c.product, [...(products.get(c.product) ?? []), c]);
  const lines = [
    "Usage: runtime <product> <verb> [arguments] [--flags]",
    "       runtime <shortcut> [--flags] [-- command...]",
    "",
  ];
  const shortcuts = commands.filter((c) => c.shortcut);
  if (shortcuts.length) {
    lines.push("Shortcuts:");
    for (const c of shortcuts) lines.push(`  ${c.name.padEnd(28)} ${c.doc}`);
    lines.push("");
  }
  lines.push("Commands:");
  for (const [p, cs] of products) {
    if (cs[0]?.shortcut) continue;
    for (const c of cs) lines.push(`  ${`${p} ${c.verb}`.padEnd(28)} ${c.doc}`);
  }
  lines.push(
    "",
    "  login                        Logs this computer in through the browser and saves its key.",
  );
  lines.push("  logout                       Deletes the key runtime login saved.");
  lines.push("  mcp                          Serves Runtime's MCP tools over stdio.");
  lines.push("  ssh <id>                     Opens a shell in a sandbox in this terminal.");
  lines.push(
    "  fly-api [--port 4280]        Serves Fly's Machines API on localhost, over Runtime.",
  );
  lines.push(
    "",
    `Commands are read from the API (${from}). RUNTIME_API_KEY holds the key (runtime login's when unset); RUNTIME_API_URL the API.`,
  );
  return lines.join("\n");
}

function help(c: Command): string {
  const head = c.shortcut
    ? `runtime ${c.name}`
    : `runtime ${c.product} ${c.verb}${c.args.map((a) => ` <${a}>`).join("")}`;
  const lines = [`Usage: ${head} [--flags]`, "", c.doc, ""];
  for (const f of c.flags) {
    if (f.secret)
      lines.push(
        `  ${"--from-file <path>".padEnd(26)} Its ${f.field}, read from this file, or else from standard input; never a flag. ${f.doc}`,
      );
    else
      lines.push(
        `  --${f.flag.padEnd(24)} ${f.type}${f.list ? "[]" : ""}${f.choices ? ` (${f.choices.join(", ")})` : ""}${f.required ? ", required" : ""}. ${f.doc}`,
      );
  }
  if (c.stdin) lines.push("", "Its body is read from standard input.");
  return lines.join("\n");
}

/** One flag's text as its field's type in the API's description, refused here, before anything is sent, when it is
 * not one. 18 Nov 2026: a number went as its text (`--memory-gb 4` as "4"), and the API refused it. */
export function value(f: Flag, raw: string): unknown {
  switch (f.type) {
    case "integer":
      if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new Error(`--${f.flag} takes a whole number, not ${JSON.stringify(raw)}.`);
      return Number(raw);
    case "number":
      if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw) || !Number.isFinite(Number(raw)))
        throw new Error(`--${f.flag} takes a number, not ${JSON.stringify(raw)}.`);
      return Number(raw);
    case "boolean":
      if (raw !== "true" && raw !== "false")
        throw new Error(`--${f.flag} takes true or false, not ${JSON.stringify(raw)}.`);
      return raw === "true";
    case "object":
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`--${f.flag} takes JSON, as '{"key": "value"}'.`);
      }
    case "string":
      if (f.choices && !f.choices.includes(raw))
        throw new Error(
          `--${f.flag} takes one of ${f.choices.join(", ")}, not ${JSON.stringify(raw)}.`,
        );
      return raw;
    default:
      throw new Error(`--${f.flag} is of type ${f.type}, which this CLI does not read.`);
  }
}

/** Where parse keeps --from-file's path until the secret is read. */
const FROM_FILE = "\u0000fromFile";

/** A command's secret field, from --from-file's file, or else standard input when it is piped in: one trailing
 * newline dropped (what `echo` and editors add). Left out when neither gives one, as a set that keeps the value. */
export function readSecret(
  c: Command,
  args: Record<string, unknown>,
  stdin: () => string | undefined,
): void {
  const f = c.flags.find((x) => x.secret);
  const path = args[FROM_FILE] as string | undefined;
  delete args[FROM_FILE];
  if (!f) return;
  const text = path !== undefined ? readFileSync(path, "utf8") : stdin();
  const value = text?.replace(/\r?\n$/, "");
  if (path !== undefined && !value) throw new Error(`--from-file ${path} is empty.`);
  if (value) args[f.field] = value;
  else if (f.required)
    throw new Error(`${c.name} needs its ${f.field}: pipe it in, or name a file with --from-file.`);
}

/** argv after the command as its arguments by wire name: positionals its
 * path's parts, flags its fields, and after `--`, its command (`cmd`) when
 * it takes one. */
export function parse(c: Command, argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  // A command given by its flag (`--cmd 'npm test && npm run lint'`) is the API's text form, a shell command line
  // (bash -lc); given more than once, a program and its arguments. After `--` it is always the program and its
  // arguments. 18 Nov 2026: one --cmd went as a one-item list, so the text was looked for as a program
  // (program_not_found).
  const flagged = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      const rest = argv.slice(i + 1);
      const command = c.flags.find((f) => f.command);
      if (!command) throw new Error(`${c.name} takes nothing after --.`);
      args[command.field] = rest;
      break;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const secret = c.flags.find((x) => x.secret);
    if (secret && name === "from-file") {
      const path = inline ?? argv[++i];
      if (path === undefined) throw new Error("--from-file needs a path.");
      args[FROM_FILE] = path;
      continue;
    }
    const f = c.flags.find((x) => x.flag === name || x.flag === kebab(name));
    if (f?.secret) {
      throw new Error(
        `--${f.flag} would leave the ${f.field} in shell history and ps. Pipe it in (printf %s "$VALUE" | runtime ${c.product} ${c.verb} ...) or name a file with --from-file.`,
      );
    }
    if (!f)
      throw new Error(
        `${c.name} has no flag --${name}. runtime ${c.shortcut ? c.name : `${c.product} ${c.verb}`} --help lists them.`,
      );
    // A boolean flag alone is true; it takes the next argument only when that is true or false.
    const raw =
      inline ??
      (f.type === "boolean" && argv[i + 1] !== "true" && argv[i + 1] !== "false"
        ? "true"
        : argv[++i]);
    if (raw === undefined) throw new Error(`--${f.flag} needs a value.`);
    if (f.type === "map") {
      const [k, v] = raw.split(/=(.*)/s, 2) as [string, string | undefined];
      args[f.field] = { ...(args[f.field] as object | undefined), [k]: v ?? "" };
    } else if (f.list) {
      if (f.command) flagged.add(f.field);
      args[f.field] = [...((args[f.field] as unknown[] | undefined) ?? []), value(f, raw)];
    } else {
      args[f.field] = value(f, raw);
    }
  }
  for (const field of flagged) {
    const given = args[field] as unknown[];
    if (given.length === 1) args[field] = given[0];
  }
  if (positional.length > c.args.length) {
    // A shortcut's command after its flags, without `--`.
    const command = c.flags.find((f) => f.command);
    if (c.args.length === 0 && command && args[command.field] === undefined) {
      args[command.field] = positional;
    } else {
      throw new Error(
        `${c.name} takes ${c.args.length} argument(s): ${c.args.join(", ") || "none"}.`,
      );
    }
  } else {
    c.args.forEach((n, i) => {
      if (positional[i] !== undefined) args[n] = positional[i];
    });
  }
  for (const n of c.args) if (args[n] === undefined) throw new Error(`${c.name} needs <${n}>.`);
  for (const f of c.flags)
    if (f.required && !f.secret && args[f.field] === undefined)
      throw new Error(`${c.name} needs --${f.flag}.`);
  return args;
}

/** A shortcut's steps in order, each verb by its route; a failed step ends
 * it, but for the steps that always run once what they read is in. */
async function shortcut(
  t: Transport,
  routes: Record<string, Route>,
  c: Command,
  args: Record<string, unknown>,
): Promise<unknown> {
  const s = c.shortcut!;
  const answers: unknown[] = [];
  let failure: Error | undefined;
  for (const step of s.steps) {
    const a: Record<string, unknown> = {};
    let ready = true;
    for (const [name, from] of Object.entries(step.args)) {
      const v =
        "arg" in from
          ? args[from.arg]
          : (answers[from.step] as Record<string, unknown> | undefined)?.[from.field];
      if ("step" in from && answers[from.step] === undefined) ready = false;
      if (v !== undefined && v !== null) a[name] = v;
    }
    if (!ready || (failure !== undefined && !step.always)) {
      answers.push(undefined);
      continue;
    }
    const route = routes[step.verb];
    if (!route) throw new Error(`${s.name}: the API serves no ${step.verb}.`);
    try {
      answers.push(await callRoute(t, route, a));
    } catch (e) {
      failure ??= e instanceof Error ? e : new Error(String(e));
      answers.push(undefined);
    }
  }
  if (failure !== undefined) throw failure;
  return answers[s.answer];
}

function print(answer: unknown): number {
  if (answer instanceof Uint8Array) {
    process.stdout.write(answer);
    return 0;
  }
  // A command's result (a process that ended, with its output): its own output and exit code, as a shell's. 18 Nov
  // 2026: this read 1.0's `timedOut`, which v2's process has not, so `runtime sandboxes exec` printed the process's
  // JSON instead.
  const r = answer as
    | {
        object?: unknown;
        state?: unknown;
        stdout?: unknown;
        stderr?: unknown;
        exitCode?: unknown;
        timedOut?: unknown;
      }
    | undefined;
  if (
    r &&
    typeof r.stdout === "string" &&
    typeof r.stderr === "string" &&
    ((r.object === "process" && r.state !== "running") || "timedOut" in r)
  ) {
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    return typeof r.exitCode === "number" ? r.exitCode : 124;
  }
  if (answer !== undefined) process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  return 0;
}

/** `runtime ssh <id>`: this terminal attached to a shell in the sandbox, a
 * process on a pty through the generated core (no SSH server or key in it):
 * its output streamed as it is written, each keystroke sent as its input. */
async function ssh(baseUrl: string, id: string | undefined): Promise<number> {
  if (!id) {
    process.stderr.write("Usage: runtime ssh <sandbox-id>\n");
    return 2;
  }
  const sbx = await new Runtime({ baseUrl }).sandboxes.get(id);
  const tty = process.stdin.isTTY;
  const run = sbx.execStream(["bash", "-l"], {
    pty: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
    stdinOpen: true,
    outputEncoding: "base64",
  });
  const shell = await run.started();
  // Input in order: each write after the last, at the offset the shell has taken.
  let offset = 0;
  let sent: Promise<unknown> = Promise.resolve();
  const send = (d: Buffer) => {
    const at = offset;
    offset += d.length;
    sent = sent
      .then(() => sbx.processes.write(shell.id, { data: d.toString("base64"), offset: at }))
      .catch(() => undefined);
  };
  if (tty) process.stdin.setRawMode(true);
  process.stdin.on("data", send);
  try {
    for await (const chunk of run)
      process.stdout.write(chunk.base64 ? Buffer.from(chunk.base64, "base64") : chunk.text);
    return (await run.wait()).exitCode ?? 0;
  } finally {
    if (tty) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

/** The commands this file serves itself, ahead of the API's: each by its name, given the API's URL and what follows. */
export const own: Record<string, (baseUrl: string, rest: string[]) => number | Promise<number>> = {
  login: (baseUrl) => login(baseUrl),
  logout: (baseUrl) => logout(baseUrl),
  mcp: (baseUrl) => serveMcp(baseUrl),
  ssh: (baseUrl, rest) => ssh(baseUrl, rest[0]),
  "fly-api": (baseUrl, rest) => {
    const i = rest.indexOf("--port");
    return serveMachinesApi(i >= 0 ? Number(rest[i + 1]) : 4280, { baseUrl });
  },
  version: () => {
    process.stdout.write(`runtime ${version()}\n`);
    return 0;
  },
};
own["--version"] = own["version"]!;

/** The API's command argv names (a shortcut by its name, a verb by its product and verb), and what follows it; an
 * argv that names none is refused, with the verbs its product has. */
export function find(commands: Command[], argv: string[]): { c: Command; rest: string[] } {
  const [first, second] = argv;
  const c =
    commands.find((x) => x.shortcut && x.name === first) ??
    commands.find((x) => !x.shortcut && x.product === first && x.verb === second);
  if (!c) {
    const verbs = commands.filter((x) => x.product === first && !x.shortcut).map((x) => x.verb);
    throw new Error(verbs.length ? `runtime ${first}: one of ${verbs.join(", ")}.` : `runtime: no command ${first}. runtime --help lists them.`);
  }
  return { c, rest: argv.slice(c.shortcut ? 1 : 2) };
}

export async function main(argv: string[]): Promise<number> {
  const baseUrl = (process.env["RUNTIME_API_URL"] ?? "https://api.withruntime.com").replace(/\/$/, "");
  // The key every command sends, the MCP bridge's and the shims' too: the environment's, else the one login saved.
  if (argv[0] !== "login" && argv[0] !== "logout" && !process.env["RUNTIME_API_KEY"]) {
    const key = savedKey(baseUrl);
    if (key) process.env["RUNTIME_API_KEY"] = key;
  }
  const mine = Object.hasOwn(own, argv[0] ?? "") ? own[argv[0]!] : undefined;
  if (mine) return mine(baseUrl, argv.slice(1));
  const { doc, from } = await document(baseUrl);
  const commands = commandsOf(doc);
  const first = argv[0];
  if (!first || first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(`${usage(commands, from)}\n`);
    return first ? 0 : 2;
  }
  let found: { c: Command; rest: string[] };
  try {
    found = find(commands, argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const { c, rest } = found;
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${help(c)}\n`);
    return 0;
  }
  const t = new Transport({ baseUrl });
  const routes = routesOf(doc);
  try {
    const args = parse(c, rest);
    if (c.stdin) args["data"] = new Uint8Array(readFileSync(0));
    readSecret(c, args, () => (process.stdin.isTTY ? undefined : readFileSync(0, "utf8")));
    const answer = c.shortcut
      ? await shortcut(t, routes, c, args)
      : await callRoute(t, routes[c.name]!, args);
    return print(answer);
  } catch (e) {
    const err = e as { code?: string; message?: string; requestId?: string };
    process.stderr.write(
      `runtime: ${err.code ? `${err.code}: ` : ""}${err.message ?? String(e)}${err.requestId ? ` (${err.requestId})` : ""}\n`,
    );
    return 1;
  }
}
