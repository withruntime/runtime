#!/usr/bin/env node
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
import { serveMcp } from "./mcp.js";
import { login, logout, savedKey } from "./login.js";
import { serveMachinesApi } from "./shims/fly.js";

/** This package's version, from its package.json. */
function version(): string {
  for (const p of ["../package.json", "../../package.json"]) {
    try {
      return String(JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")).version);
    } catch {
      // the next place
    }
  }
  return "unknown";
}

function usage(commands: Command[], from: string): string {
  const products = new Map<string, Command[]>();
  for (const c of commands) products.set(c.product, [...(products.get(c.product) ?? []), c]);
  const lines = ["Usage: runtime <product> <verb> [arguments] [--flags]", "       runtime <shortcut> [--flags] [-- command...]", ""];
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
  lines.push("", "  login                        Logs this computer in through the browser and saves its key.");
  lines.push("  logout                       Deletes the key runtime login saved.");
  lines.push("  mcp                          Serves Runtime's MCP tools over stdio.");
  lines.push("  ssh <id>                     Opens a shell in a sandbox in this terminal.");
  lines.push("  fly-api [--port 4280]        Serves Fly's Machines API on localhost, over Runtime.");
  lines.push("", `Commands are read from the API (${from}). RUNTIME_API_KEY holds the key (runtime login's when unset); RUNTIME_API_URL the API.`);
  return lines.join("\n");
}

function help(c: Command): string {
  const head = c.shortcut ? `runtime ${c.name}` : `runtime ${c.product} ${c.verb}${c.args.map((a) => ` <${a}>`).join("")}`;
  const lines = [`Usage: ${head} [--flags]`, "", c.doc, ""];
  for (const f of c.flags) lines.push(`  --${f.flag.padEnd(24)} ${f.type}${f.list ? "[]" : ""}${f.required ? ", required" : ""}. ${f.doc}`);
  if (c.stdin) lines.push("", "Its body is read from standard input.");
  return lines.join("\n");
}

function value(f: Flag, raw: string): unknown {
  if (f.type === "integer") {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`--${f.flag} takes a whole number.`);
    return n;
  }
  if (f.type === "boolean") return raw !== "false";
  if (f.type === "object") return JSON.parse(raw);
  return raw;
}

/** argv after the command as its arguments by wire name: positionals its
 * path's parts, flags its fields, and after `--`, its command (`cmd`) when
 * it takes one. */
export function parse(c: Command, argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
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
    const f = c.flags.find((x) => x.flag === name || x.flag === kebab(name));
    if (!f) throw new Error(`${c.name} has no flag --${name}. runtime ${c.shortcut ? c.name : `${c.product} ${c.verb}`} --help lists them.`);
    const raw = inline ?? (f.type === "boolean" && (argv[i + 1] === undefined || argv[i + 1]!.startsWith("--")) ? "true" : argv[++i]);
    if (raw === undefined) throw new Error(`--${f.flag} needs a value.`);
    if (f.type === "map") {
      const [k, v] = raw.split(/=(.*)/s, 2) as [string, string | undefined];
      args[f.field] = { ...(args[f.field] as object | undefined), [k]: v ?? "" };
    } else if (f.list) {
      args[f.field] = [...((args[f.field] as unknown[] | undefined) ?? []), value(f, raw)];
    } else {
      args[f.field] = value(f, raw);
    }
  }
  if (positional.length > c.args.length) {
    // A shortcut's command after its flags, without `--`.
    const command = c.flags.find((f) => f.command);
    if (c.args.length === 0 && command && args[command.field] === undefined) {
      args[command.field] = positional;
    } else {
      throw new Error(`${c.name} takes ${c.args.length} argument(s): ${c.args.join(", ") || "none"}.`);
    }
  } else {
    c.args.forEach((n, i) => {
      if (positional[i] !== undefined) args[n] = positional[i];
    });
  }
  for (const n of c.args) if (args[n] === undefined) throw new Error(`${c.name} needs <${n}>.`);
  for (const f of c.flags) if (f.required && args[f.field] === undefined) throw new Error(`${c.name} needs --${f.flag}.`);
  return args;
}

/** A shortcut's steps in order, each verb by its route; a failed step ends
 * it, but for the steps that always run once what they read is in. */
async function shortcut(t: Transport, routes: Record<string, Route>, c: Command, args: Record<string, unknown>): Promise<unknown> {
  const s = c.shortcut!;
  const answers: unknown[] = [];
  let failure: unknown;
  for (const step of s.steps) {
    const a: Record<string, unknown> = {};
    let ready = true;
    for (const [name, from] of Object.entries(step.args)) {
      const v = "arg" in from ? args[from.arg] : (answers[from.step] as Record<string, unknown> | undefined)?.[from.field];
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
      failure ??= e;
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
  // A command's result: its own output and exit code, as a shell's.
  const r = answer as { stdout?: unknown; stderr?: unknown; exitCode?: unknown; timedOut?: unknown } | undefined;
  if (r && typeof r.stdout === "string" && typeof r.stderr === "string" && "timedOut" in r) {
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
  const run = sbx.execStream(["bash", "-l"], { pty: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }, stdinOpen: true, outputEncoding: "base64" });
  const shell = await run.started();
  // Input in order: each write after the last, at the offset the shell has taken.
  let offset = 0;
  let sent: Promise<unknown> = Promise.resolve();
  const send = (d: Buffer) => {
    const at = offset;
    offset += d.length;
    sent = sent.then(() => sbx.processes.write(shell.id, { data: d.toString("base64"), offset: at })).catch(() => undefined);
  };
  if (tty) process.stdin.setRawMode(true);
  process.stdin.on("data", send);
  try {
    for await (const chunk of run) process.stdout.write(chunk.base64 ? Buffer.from(chunk.base64, "base64") : chunk.text);
    return (await run.wait()).exitCode ?? 0;
  } finally {
    if (tty) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export async function main(argv: string[]): Promise<number> {
  const baseUrl = (process.env["RUNTIME_API_URL"] ?? "https://api.withruntime.com").replace(/\/$/, "");
  if (argv[0] === "login") return login(baseUrl);
  if (argv[0] === "logout") return logout(baseUrl);
  // The key every command sends, the MCP bridge's and the shims' too: the environment's, else the one login saved.
  if (!process.env["RUNTIME_API_KEY"]) {
    const key = savedKey(baseUrl);
    if (key) process.env["RUNTIME_API_KEY"] = key;
  }
  if (argv[0] === "mcp") return serveMcp(baseUrl);
  if (argv[0] === "ssh") return ssh(baseUrl, argv[1]);
  if (argv[0] === "fly-api") {
    const i = argv.indexOf("--port");
    return serveMachinesApi(i >= 0 ? Number(argv[i + 1]) : 4280, { baseUrl });
  }
  if (argv[0] === "--version" || argv[0] === "version") {
    process.stdout.write(`runtime ${version()}\n`);
    return 0;
  }
  const { doc, from } = await document(baseUrl);
  const commands = commandsOf(doc);
  const [first, second] = argv;
  if (!first || first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(`${usage(commands, from)}\n`);
    return first ? 0 : 2;
  }
  const c =
    commands.find((x) => x.shortcut && x.name === first) ??
    commands.find((x) => !x.shortcut && x.product === first && x.verb === second);
  if (!c) {
    const verbs = commands.filter((x) => x.product === first && !x.shortcut).map((x) => x.verb);
    process.stderr.write(verbs.length ? `runtime ${first}: one of ${verbs.join(", ")}.\n` : `runtime: no command ${first}. runtime --help lists them.\n`);
    return 2;
  }
  const rest = argv.slice(c.shortcut ? 1 : 2);
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${help(c)}\n`);
    return 0;
  }
  const t = new Transport({ baseUrl });
  const routes = routesOf(doc);
  try {
    const args = parse(c, rest);
    if (c.stdin) args["data"] = new Uint8Array(readFileSync(0));
    const answer = c.shortcut ? await shortcut(t, routes, c, args) : await callRoute(t, routes[c.name]!, args);
    return print(answer);
  } catch (e) {
    const err = e as { code?: string; message?: string; requestId?: string };
    process.stderr.write(`runtime: ${err.code ? `${err.code}: ` : ""}${err.message ?? String(e)}${err.requestId ? ` (${err.requestId})` : ""}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/runtime") || process.argv[1]?.endsWith("/cli.js")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
