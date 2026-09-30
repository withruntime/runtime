import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* The guides name every command and option the CLI has, and every
   `runtime <product> <command>` a guide names is one the CLI has. The
   commands and options come from the CLI's own help, run as a customer runs
   it, and from the words its code dispatches on, never from a list typed
   here. The guides are the source of truth customers and agents read
   (AGENTS.md, "A change a customer can see changes what they read, in the
   same commit"); on 30 September 2026 the Java and Go folder moves, five API
   routes and a dozen CLI commands were found missing from them.

   The fourteen options still missing then were documented the same day, so
   the only exceptions left are SWITCHED_OFF below. */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const sdk = here("..");
const docs = here("../../cloud-guide/docs/");
const source = ["cli.ts", "network-cli.ts", "billing-cli.ts", "cli-extras.ts"]
  .map((name) => readFileSync(join(sdk, "src", name), "utf8"))
  .join("\n");
/** Every guide but the changelog, which records what was, not what is,
 * with `npx withruntime` read as the `runtime` it runs. */
const guides = readdirSync(docs)
  .filter((name) => name.endsWith(".md") && name !== "changelog.md")
  .map((name) => readFileSync(join(docs, name), "utf8").replaceAll("npx withruntime ", "runtime "))
  .join("\n");

/** The `runtime <product> <command>` a guide names, its shorthand read as a
 * reader does: after `runtime webhooks create`, a backticked `ls` or
 * `rm <id>` under the same heading is `runtime webhooks ls` and
 * `runtime webhooks rm`. */
export function named(markdown: string): Set<string> {
  const out = new Set<string>();
  let product = "";
  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) product = "";
    for (const m of line.matchAll(
      /\bruntime ([a-z-]+)(?: ([a-z][a-z-]*))?|`(?!runtime )([a-z][a-z-]*)[` ]/g,
    )) {
      if (m[1]) {
        product = m[1];
        if (m[2]) out.add(`runtime ${m[1]} ${m[2]}`);
      } else if (product) out.add(`runtime ${product} ${m[3]}`);
    }
  }
  return out;
}

async function help(product?: string): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, join(sdk, "src", "cli.ts"), ...(product ? [product] : []), "help"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, RUNTIME_API_KEY: "rk_help" } },
  );
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text;
}

/** The products with a help of their own, one name each: OWN_HELP in
 * cli.ts, with the aliases (`sbx`, `images`) that print the same help left
 * out. */
async function products(): Promise<Map<string, string>> {
  const list = /const OWN_HELP = \[([\s\S]*?)\];/.exec(source)![1]!;
  const names = [...list.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  const texts = await Promise.all(names.map((name) => help(name)));
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (seen.has(texts[index]!)) continue;
    seen.add(texts[index]!);
    out.set(name, texts[index]!);
  }
  return out;
}

/** A product's commands: the first word of each help line, and of each
 * alternative after a " | ", where the CLI dispatches on that word. */
export function commands(text: string, product = ""): string[] {
  const out = new Set<string>();
  let nested = false;
  for (const line of text.split("\n")) {
    const continued = /^ {3,}\| /.test(line);
    if (!continued && !/^ {2}\S/.test(line)) continue;
    if (continued && nested) continue;
    const parts = line
      .trim()
      .replace(/^\| /, "")
      .replace(new RegExp(`^${product} `), "")
      .split(" | ");
    // `desktop <id> start | stop`: the alternatives are the desktop's own.
    if (!continued) nested = /^[a-z-]+ <[^>]+> [a-z]/.test(parts[0]!);
    if (nested) parts.length = 1;
    for (const part of parts) {
      // A command is followed by its syntax or its description's column; a
      // word followed by more words is a sentence. `tailscale up <id>` is one.
      const word = /^([a-z][a-z-]*)(?=$| {2}| [<[|-]| [a-z-]+(?:$| {2}| [<[|-]))/.exec(part)?.[1];
      if (word && word !== "runtime" && word !== product && dispatched(word)) out.add(word);
    }
  }
  return [...out].sort();
}
const dispatched = (word: string) =>
  new RegExp(`(case |[!=]== |\\[)"${word}"|"${word}":`).test(source);
const options = (text: string) => [...text.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]);

/** `runtime billing` pays in stablecoins, switched off on the deployment
 * until Marc turns it on (1f621467); its guide comes with it. */
const SWITCHED_OFF = new Set([
  "runtime billing topup",
  "runtime billing status",
  "runtime billing claim",
  "--new-account",
  "--accept-terms",
]);

test("the guide reader reads shorthand under a named command, and only there", () => {
  const said = named(
    "- `runtime webhooks create <url>` sends events; `ls`, `rm <id>` manage them.\n## Next\n`get`",
  );
  expect([...said].sort()).toEqual([
    "runtime webhooks create",
    "runtime webhooks ls",
    "runtime webhooks rm",
  ]);
});

test("the command reader finds dispatched commands and leaves prose alone", () => {
  expect(
    commands("  ls                    Your images\n  paid sandbox billed at the rates"),
  ).toEqual(["ls"]);
});

test("every command and option in the CLI's help is named in a guide, and every one a guide names is real", async () => {
  const all = await products();
  expect(all.size).toBeGreaterThan(8);
  const missing = new Set<string>();
  const said = named(guides);
  const top = await help();
  for (const option of options(top)) if (!guides.includes(option)) missing.add(option);
  const known = new Map<string, Set<string>>();
  for (const [product, text] of all) {
    known.set(product, new Set([...commands(text, product), "help"]));
    for (const command of commands(text, product))
      if (!said.has(`runtime ${product} ${command}`)) missing.add(`runtime ${product} ${command}`);
    for (const option of options(text)) if (!guides.includes(option)) missing.add(option);
  }
  const allowed = SWITCHED_OFF;
  expect([...missing].filter((entry) => !allowed.has(entry)).sort()).toEqual([]);
  // The list only shrinks.
  expect([...allowed].filter((entry) => !missing.has(entry)).sort()).toEqual([]);
  // A guide names only commands the CLI has.
  const invented: string[] = [];
  for (const m of guides.matchAll(/\bruntime ([a-z-]+) ([a-z][a-z-]*)\b/g)) {
    const commandsOf = known.get(m[1]!);
    if (commandsOf && !commandsOf.has(m[2]!)) invented.push(m[0]);
  }
  expect([...new Set(invented)].sort()).toEqual([]);
}, 30_000);
