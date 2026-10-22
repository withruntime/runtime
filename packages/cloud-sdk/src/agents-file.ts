/* runtime.yml on disk: read, parsed as YAML, with the line of each field for
   messages and a reader for `instructionsFile` that stays inside the file's
   folder. Node and Bun only (a browser gets agents/browser.ts, which leaves
   it out, and the browser field maps it to a stub); the
   check and the plan are agents-deploy.ts's. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, visit } from "yaml";
import type { AgentsSource } from "./agents-deploy.js";
import { RuntimeError } from "./errors.js";
import { AGENT_USES, agentTemplate } from "./products/agents.js";

export const AGENTS_FILE = "runtime.yml";

/** Reads a runtime.yml for `agents().deploy`. YAML mistakes are
 * refused here with their line; the agents' fields are checked by deploy. */
export function loadAgentsFile(path: string = AGENTS_FILE): AgentsSource {
  const full = resolve(path);
  if (!existsSync(full))
    throw new RuntimeError({
      message: `${path} is not there.`,
      code: "invalid_file",
      status: 0,
      hint: "Write one with `runtime agents init --template claude-code`, or pass --file.",
      details: { file: path },
    });
  // Its size before a byte is read: a runtime.yml is a few KiB.
  if (statSync(full).size > AGENTS_FILE_MAX_BYTES) throw tooBig(path);
  return parseAgentsFile(readFileSync(full, "utf8"), path, dirname(full));
}

/** The largest runtime.yml read: 256 KiB. */
export const AGENTS_FILE_MAX_BYTES = 256 * 1024;
const tooBig = (file: string) =>
  new RuntimeError({
    message: `${file} is over 256 KiB; a runtime.yml is a few KiB.`,
    code: "invalid_file",
    status: 0,
    hint: "Keep long instructions in a file of their own and name it in instructionsFile.",
    details: { file },
  });
const refused = (file: string, message: string, hint: string) =>
  new RuntimeError({ message, code: "invalid_file", status: 0, hint, details: { file } });

/** runtime.yml's text, parsed. `folder` is where `instructionsFile` is read
 * from; without it, instructionsFile is refused. At most 256 KiB, and no
 * anchors or aliases: a document of aliases of aliases ("billion laughs")
 * would grow past every cap once expanded, so none is expanded at all. */
export function parseAgentsFile(text: string, file = AGENTS_FILE, folder?: string): AgentsSource {
  if (text.length > AGENTS_FILE_MAX_BYTES || Buffer.byteLength(text) > AGENTS_FILE_MAX_BYTES)
    throw tooBig(file);
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length)
    throw refused(
      file,
      doc.errors
        .map((e) => {
          const at = e.linePos?.[0];
          const said = e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "");
          return `${file}${at ? `:${at.line}:${at.col}` : ""}: ${said}`;
        })
        .join("\n"),
      "runtime.yml is YAML; fix the line named and run it again. Nothing was changed.",
    );
  // Parsing keeps an alias as a node; only toJS would expand it.
  let alias: number | undefined;
  visit(doc, {
    Alias(_, node) {
      alias = node.range ? lines.linePos(node.range[0]).line : 0;
      return visit.BREAK;
    },
  });
  if (alias !== undefined)
    throw refused(
      file,
      `${file}${alias ? `:${alias}` : ""}: anchors and aliases (&name, *name) are not taken in runtime.yml.`,
      "Write each value out where it is used. Nothing was changed.",
    );
  const config = doc.toJS({ maxAliasCount: 0 }) as unknown;
  // The line of the deepest key the path reaches: a field's own, or for a
  // missing one, its agent's name.
  const line = (path: readonly (string | number)[]) => {
    let node: unknown = doc.contents;
    let found: number | undefined;
    const at = (n: unknown) =>
      isNode(n) && n.range ? (found = lines.linePos(n.range[0]).line) : undefined;
    for (const part of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === part);
        if (!pair) break;
        at(pair.key);
        node = pair.value;
      } else if (isSeq(node) && typeof part === "number" && node.items[part] !== undefined) {
        node = node.items[part];
        at(node);
      } else break;
    }
    return found;
  };
  return {
    file,
    config,
    line,
    ...(folder === undefined ? {} : { readFile: (name: string) => readInside(folder, name) }),
  };
}

/** A file inside `folder`, never outside it, through a link included. */
function readInside(folder: string, name: string): string {
  const root = realpathSync(folder);
  const target = realpathSync(resolve(root, name));
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || resolve(rel) === rel)
    throw new Error(`${name} is outside ${folder}`);
  return readFileSync(target, "utf8");
}

/** A starter `agents:` section for `runtime agents init`. */
export function starterAgents(options: {
  name: string;
  template: string;
  use?: "support" | "team";
  instructionsFile?: string;
}): string {
  const t = agentTemplate(options.template)!;
  const words = options.instructionsFile
    ? `    instructionsFile: ${options.instructionsFile}${pad(options.instructionsFile.length + 18)}# its instructions, read from the repo`
    : `    instructions: |\n      You work on this repository. Say what you changed and why.`;
  const use = options.use
    ? `    use: ${options.use}${pad(options.use.length + 5)}# ${AGENT_USES[options.use].title.toLowerCase()}: its size and bounds`
    : `    # use: team                  # or support: a size and bounds for that use`;
  return [
    "# Runtime Agents. `runtime agents deploy` makes your account's agents match",
    "# this section; `runtime agents deploy --dry-run` shows what it would change.",
    "agents:",
    `  ${options.name}:`,
    `    template: ${options.template}${pad(options.template.length + 10)}# ${t.title}: its command, and its model key's secret`,
    words,
    use,
    "    # vcpu: 4                    # the default size: 4 vCPU, 8 GiB",
    "    # memoryMiB: 8192",
    "    # maxSessionDollars: 5       # the default budgets: a session stops at $5,",
    "    # maxDayDollars: 100         # and the agent starts nothing new past $100 a day",
    "    # triggers:",
    "    #   - kind: schedule",
    '    #     config: { cron: "0 9 * * 1-5", input: "Triage the new issues." }',
    `# Its model key, stored once as an egress secret the sandbox never sees:`,
    `#   printf %s "$${t.apiKeySecret}" | runtime secrets set ${t.apiKeySecret} --host ${t.apiKeyHost}`,
    "",
  ].join("\n");
}
const pad = (used: number) => " ".repeat(Math.max(1, 29 - used));
