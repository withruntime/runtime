/* runtime.yml's `agents:` section, and the plan that makes an account's
   agents match it (`runtime agents deploy`, `agents().deploy` of withruntime/agents, the
   MCP tool runtime_agents_deploy). Pure: no file system and no network but
   the port it is given, so the CLI, the SDK and the API's own MCP tool run
   the same check and the same plan.

     agents:
       triage:
         template: claude-code          # its command and its model key's secret
         instructionsFile: docs/agent.md  # a file in the repo, or instructions: "..."
         maxSessionDollars: 5
         triggers:
           - kind: schedule
             config: { cron: "0 9 * * 1-5", input: "Triage the new issues." }

   A deploy creates the agents the file names and the account lacks, makes a
   new version of one whose definition differs (and leaves an unchanged one
   alone: no new version), and adds, pauses, resumes or removes triggers to
   match. It deletes an agent only with `prune`, and only one an earlier
   deploy made (labelled managed-by: runtime.yml). Every change carries an
   idempotency key made from what it changes and the state it was planned
   against, so a rerun after a lost answer repeats nothing. */
import type { Runtime } from "./client.js";
import { RuntimeError } from "./errors.js";
import {
  AGENT_TEMPLATES,
  agentTemplate,
  AGENT_USES,
  type Agent,
  type AgentDefinition,
  type AgentTrigger,
  type AgentTriggerKind,
  type CreateAgentTrigger,
} from "./products/agents.js";

/** One trigger as the file writes it. `paused` holds it, saying why. */
export type AgentsFileTrigger = {
  kind: AgentTriggerKind;
  config: Record<string, unknown>;
  paused?: string;
};
/** One agent as the file writes it: a harness template and a use fill in
 * what it leaves out, then each definition field it sets. */
export type AgentsFileAgent = Omit<Partial<AgentDefinition>, "template"> & {
  /** A harness: claude-code, codex, gemini-cli, claude-agent-sdk,
   * openai-agents-sdk. Fills in `command` and `secrets`. */
  template?: string;
  /** support or team: a size and bounds for that use (`agents.uses`). */
  use?: "support" | "team";
  /** A file of the repo, relative to runtime.yml, read as `instructions`. */
  instructionsFile?: string;
  /** Absent: none. A deploy removes the triggers the file does not name. */
  triggers?: AgentsFileTrigger[];
};
/** runtime.yml, as parsed. */
export type AgentsFile = { agents: Record<string, AgentsFileAgent> };
/** A file read from disk (`loadAgentsFile`): its parsed text, its name for
 * messages, a reader for `instructionsFile`, and the line of a field. */
export type AgentsSource = {
  file: string;
  config: unknown;
  readFile?: (path: string) => string;
  line?: (path: readonly (string | number)[]) => number | undefined;
};
/** One agent as a deploy wants it. */
export type DesiredAgent = {
  name: string;
  definition: AgentDefinition;
  triggers: AgentsFileTrigger[];
};

/** What a deploy reads and changes, by the SDK over HTTP or by the API's
 * own store. Each change gets its idempotency key. */
export type AgentsDeployPort = {
  list(): Promise<Agent[]>;
  create(
    input: { name: string; definition: AgentDefinition; labels: Record<string, string> },
    key: string,
  ): Promise<Agent>;
  update(agentId: string, definition: AgentDefinition, key: string): Promise<Agent>;
  delete(agentId: string, key: string): Promise<void>;
  triggers(agentId: string): Promise<AgentTrigger[]>;
  addTrigger(agentId: string, input: CreateAgentTrigger, key: string): Promise<AgentTrigger>;
  pauseTrigger(triggerId: string, why: string, key: string): Promise<AgentTrigger>;
  resumeTrigger(triggerId: string, key: string): Promise<AgentTrigger>;
  removeTrigger(triggerId: string, key: string): Promise<void>;
  /** How many memory files the agent holds: deleting it deletes them. */
  memoryFiles(agentId: string): Promise<number>;
};

export type AgentsDeployChange =
  | {
      action: "create";
      agent: string;
      definition: AgentDefinition;
      key: string;
      text: string;
    }
  | {
      action: "update";
      agent: string;
      agentId: string;
      fromVersion: number;
      fields: string[];
      definition: AgentDefinition;
      key: string;
      text: string;
    }
  | { action: "delete"; agent: string; agentId: string; key: string; text: string }
  | {
      action: "add-trigger";
      agent: string;
      agentId: string | null;
      trigger: AgentsFileTrigger;
      key: string;
      text: string;
      /** Once made: its id, and a webhook's secret, which the API answers
       * this once and never again (a dry run has neither). */
      triggerId?: string;
      secret?: string;
    }
  | {
      action: "pause-trigger";
      agent: string;
      triggerId: string;
      why: string;
      key: string;
      text: string;
    }
  | { action: "resume-trigger"; agent: string; triggerId: string; key: string; text: string }
  | { action: "remove-trigger"; agent: string; triggerId: string; key: string; text: string };

export type AgentsDeployResult = {
  file: string;
  dryRun: boolean;
  /** In order; applied unless dryRun. */
  changes: AgentsDeployChange[];
  /** Agents the file names whose definition and triggers already match. */
  unchanged: string[];
  /** Agents of the account the file does not name, kept, and why. */
  leftAlone: { agent: string; why: string }[];
};
export type AgentsDeployOptions = {
  /** Plan only: read the account, change nothing. */
  dryRun?: boolean;
  /** Delete the agents an earlier deploy made that the file no longer names.
   * One that still holds memory files is kept (leftAlone) unless pruneMemory. */
  prune?: boolean;
  /** With prune: delete such an agent even when it holds memory files, and
   * the files with it, for good. */
  pruneMemory?: boolean;
  /** The file's name in messages; runtime.yml by default. */
  file?: string;
  /** Reads `instructionsFile`, relative to the file. */
  readFile?: (path: string) => string;
  /** Called as each change is made. */
  onChange?: (change: AgentsDeployChange) => void;
};

/** The label a deploy puts on the agents it makes; prune deletes only these. */
export const MANAGED_LABEL = { "managed-by": "runtime.yml" } as const;
/** What an agent gets when the file leaves its size out (agents-contract.md). */
const SIZE = { vcpu: 4, memoryMiB: 8192 } as const;
/** What the API writes in when a definition leaves these out: a field the
 * file leaves out matches the agent's when the agent holds this. */
const SERVER_DEFAULTS: Readonly<Record<string, unknown>> = {
  idlePauseSeconds: 60,
  maxSessionSeconds: 86400,
  maxConcurrent: 10,
  maxSessionDollars: 5,
  maxDayDollars: 100,
  memory: { scope: "key" },
};
const DEFINITION_FIELDS = [
  "from",
  "vcpu",
  "memoryMiB",
  "command",
  "instructions",
  "env",
  "secrets",
  "mcp",
  "volumes",
  "idlePauseSeconds",
  "maxSessionSeconds",
  "maxConcurrent",
  "maxSessionDollars",
  "maxDayDollars",
  "memory",
] as const;
const FILE_FIELDS = ["template", "use", "instructionsFile", "triggers", ...DEFINITION_FIELDS];
const TRIGGER_KINDS: readonly AgentTriggerKind[] = ["slack", "github", "schedule", "webhook"];
const RESERVED = new Set(["sessions", "triggers", "approvals", "templates"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bytes = (text: string) => new TextEncoder().encode(text).length;

type Path = (string | number)[];
type Issue = { agent: string | null; field: string | null; path: Path; message: string };

/** The file's agents, checked as the API checks them, with every mistake
 * named by file, agent and field (and line, when the source knows it).
 * Throws a RuntimeError `invalid_file` listing them all. */
export function checkAgentsFile(
  input: AgentsFile | AgentsSource,
  options: AgentsDeployOptions = {},
) {
  const source = sourceOf(input, options);
  const issues: Issue[] = [];
  const say = (path: Path, message: string) =>
    issues.push({
      agent: typeof path[1] === "string" ? path[1] : null,
      field: path.length > 2 ? path.slice(2).join(".") : null,
      path,
      message,
    });
  const desired: DesiredAgent[] = [];
  const root = source.config;
  // The whole of it first, by a walk that stops at the cap: one value
  // reached by many paths counts each time, so nothing larger is walked,
  // copied or hashed.
  if (!within(root, FILE_MAX_BYTES))
    say([], "is over 256 KiB; keep long instructions in a file named by instructionsFile.");
  else if (!isObject(root)) say([], "is not a map: write `agents:` and your agents under it.");
  else {
    for (const key of Object.keys(root))
      if (key !== "agents")
        say([key], `is not a section runtime.yml takes${hint(key, ["agents"])}`);
    const agents = root.agents;
    if (agents === undefined || agents === null)
      say(["agents"], "is missing: name your agents under `agents:`.");
    else if (!isObject(agents)) say(["agents"], "takes a map of names to agents.");
    else
      for (const [name, entry] of Object.entries(agents)) {
        const made = checkAgent(name, entry, source, say);
        if (made) desired.push(made);
      }
  }
  if (issues.length) {
    const lines = issues.map((i) => {
      const line = source.line?.(i.path);
      const where = `${source.file}${line ? `:${line}` : ""}`;
      const dotted = i.path.length ? `${i.path.join(".")}` : "";
      return `${where}: ${dotted}${dotted ? " " : ""}${i.message}`;
    });
    throw new RuntimeError({
      message: lines.join("\n"),
      code: "invalid_file",
      status: 0,
      hint: "Fix the file and run the command again; nothing was changed.",
      details: {
        file: source.file,
        issues: issues.map((i) => ({
          agent: i.agent,
          field: i.field,
          line: source.line?.(i.path) ?? null,
          message: i.message,
        })),
      },
    });
  }
  return desired;
}

function checkAgent(
  name: string,
  entry: unknown,
  source: AgentsSource,
  say: (path: Path, message: string) => void,
): DesiredAgent | null {
  const at = (...rest: Path): Path => ["agents", name, ...rest];
  const before = { n: 0 };
  const note = (path: Path, message: string) => {
    before.n++;
    say(path, message);
  };
  if (!NAME.test(name))
    note(
      at(),
      "is not an agent name: letters, digits, '.', '_' and '-', starting with a letter or digit, at most 128.",
    );
  else if (RESERVED.has(name.toLowerCase()))
    note(at(), `may not be an agent's name: /v1/agents/${name} is another route.`);
  if (!isObject(entry)) {
    note(at(), "takes a map: template, command, instructions, triggers and the rest.");
    return null;
  }
  for (const key of Object.keys(entry))
    if (!FILE_FIELDS.includes(key))
      note(at(key), `is not a field an agent takes${hint(key, FILE_FIELDS)}`);

  const def: Record<string, unknown> = {};
  const template = entry.template;
  if (template !== undefined) {
    if (typeof template !== "string" || !(template in AGENT_TEMPLATES))
      note(at("template"), `takes ${Object.keys(AGENT_TEMPLATES).join(", ")}.`);
  }
  const use = entry.use;
  if (use !== undefined && use !== "support" && use !== "team")
    note(at("use"), "takes support or team.");
  if (use === "support" || use === "team") Object.assign(def, AGENT_USES[use].definition);
  const found = typeof template === "string" ? agentTemplate(template) : undefined;
  if (found) {
    const t = found.definition;
    def.command = t.command;
    def.secrets = [...t.secrets];
  }

  const integer = (field: string, min: number, max: number) => {
    const v = entry[field];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
      note(at(field), `takes a whole number from ${min} to ${max}.`);
    else def[field] = v;
  };
  const dollars = (field: string, max: number) => {
    const v = entry[field];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0.01 || v > max)
      note(at(field), `takes dollars from 0.01 to ${max}.`);
    else def[field] = v;
  };

  if (entry.command !== undefined) {
    const v = entry.command;
    if (typeof v !== "string" || v.length < 1 || v.length > 8192)
      note(at("command"), "takes the command that runs the harness, 1 to 8192 characters.");
    else def.command = v;
  }
  if (entry.instructions !== undefined && entry.instructionsFile !== undefined)
    note(at("instructionsFile"), "and instructions both give the instructions: keep one.");
  if (entry.instructions !== undefined) {
    const v = entry.instructions;
    if (typeof v !== "string" || bytes(v) > 65536)
      note(at("instructions"), "takes text, at most 64 KiB.");
    else def.instructions = v;
  } else if (entry.instructionsFile !== undefined) {
    const v = entry.instructionsFile;
    if (
      typeof v !== "string" ||
      !v ||
      /^([\\/]|[A-Za-z]:)/.test(v) ||
      v.split(/[\\/]/).includes("..")
    )
      note(
        at("instructionsFile"),
        "takes a path inside the repo, relative to runtime.yml, such as AGENTS.md.",
      );
    else if (!source.readFile)
      note(
        at("instructionsFile"),
        "is read from the repo by `runtime agents deploy` (or loadAgentsFile); here, put the words in instructions.",
      );
    else {
      let text: string | undefined;
      try {
        text = source.readFile(v);
      } catch {
        note(at("instructionsFile"), `names ${v}, which cannot be read.`);
      }
      if (text !== undefined) {
        if (bytes(text) > 65536) note(at("instructionsFile"), `names ${v}, which is over 64 KiB.`);
        else def.instructions = text;
      }
    }
  }
  if (entry.from !== undefined) {
    const v = entry.from;
    const keys = isObject(v) ? Object.keys(v) : [];
    if (
      !isObject(v) ||
      keys.length !== 1 ||
      !(
        (typeof v.image === "string" && /^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,255}$/.test(v.image)) ||
        (typeof v.snapshot === "string" && UUID.test(v.snapshot))
      )
    )
      note(at("from"), "takes { image: name[:tag] } or { snapshot: <snapshot id> }.");
    else def.from = { ...v };
  }
  const snapshot = isObject(def.from) && "snapshot" in def.from;
  if (entry.vcpu !== undefined) {
    if (![1, 2, 4, 8, 16].includes(entry.vcpu as number))
      note(at("vcpu"), "takes 1, 2, 4, 8 or 16.");
    else def.vcpu = entry.vcpu;
  }
  if (entry.memoryMiB !== undefined) {
    const v = entry.memoryMiB;
    if (typeof v !== "number" || !Number.isInteger(v) || v % 256 || v < 512 || v > 65536)
      note(at("memoryMiB"), "takes 512 to 65536, a multiple of 256.");
    else def.memoryMiB = v;
  }
  if (snapshot) {
    for (const field of ["vcpu", "memoryMiB"] as const) {
      if (entry[field] !== undefined)
        note(
          at(field),
          "cannot be set with from.snapshot: a snapshot keeps the size it was taken at.",
        );
      delete def[field];
    }
  } else {
    def.vcpu ??= SIZE.vcpu;
    def.memoryMiB ??= SIZE.memoryMiB;
  }
  if (entry.env !== undefined) {
    const v = entry.env;
    if (!isObject(v) || Object.keys(v).length > 64)
      note(at("env"), "takes a map of at most 64 names to values.");
    else {
      for (const [k, value] of Object.entries(v)) {
        if (!SHELL_NAME.test(k)) note(at("env", k), "is not a variable name.");
        else if (typeof value !== "string")
          note(at("env", k), `takes text: quote it, as ${k}: "${String(value)}".`);
        else if (bytes(value) > 8192) note(at("env", k), "is over 8 KiB.");
      }
      def.env = { ...v };
    }
  }
  if (entry.secrets !== undefined) {
    const v = entry.secrets;
    if (!Array.isArray(v) || v.length > 32)
      note(at("secrets"), "takes a list of at most 32 egress secrets' names.");
    else {
      v.forEach((s, i) => {
        if (typeof s !== "string" || !SHELL_NAME.test(s))
          note(at("secrets", i), "is not a secret's name, such as ANTHROPIC_API_KEY.");
      });
      def.secrets = [...new Set(v)];
    }
  }
  if (entry.mcp !== undefined) {
    const v = entry.mcp;
    if (!Array.isArray(v) || v.length > 16)
      note(at("mcp"), "takes a list of at most 16 { name, url }.");
    else {
      v.forEach((m, i) => {
        if (
          !isObject(m) ||
          Object.keys(m).some((k) => k !== "name" && k !== "url") ||
          typeof m.name !== "string" ||
          !/^[a-z][a-z0-9_-]{0,63}$/.test(m.name) ||
          typeof m.url !== "string" ||
          !/^https:\/\/\S+$/.test(m.url) ||
          m.url.length > 2048
        )
          note(at("mcp", i), "takes { name: lowercase-name, url: https://... }.");
      });
      def.mcp = v;
    }
  }
  if (entry.volumes !== undefined) {
    const v = entry.volumes;
    if (!Array.isArray(v) || v.length > 4)
      note(at("volumes"), "takes a list of at most 4 { volume, path }.");
    else {
      v.forEach((m, i) => {
        if (
          !isObject(m) ||
          Object.keys(m).some((k) => k !== "volume" && k !== "path") ||
          typeof m.volume !== "string" ||
          !UUID.test(m.volume) ||
          typeof m.path !== "string" ||
          !/^\/[A-Za-z0-9._/-]{0,255}$/.test(m.path) ||
          m.path.includes("..")
        )
          note(at("volumes", i), "takes { volume: <volume id>, path: /absolute/path }.");
      });
      def.volumes = v;
    }
  }
  if (entry.memory !== undefined) {
    const v = entry.memory;
    if (
      !isObject(v) ||
      Object.keys(v).some((k) => k !== "scope") ||
      (v.scope !== "key" && v.scope !== "agent")
    )
      note(
        at("memory"),
        "takes { scope: key } (each session key its own, the default) or { scope: agent } (one all its sessions share).",
      );
    else if (v.scope === "agent" && def.template === "support")
      note(
        at("memory", "scope"),
        "may not be agent for a support agent: one customer's session would read another's.",
      );
    else def.memory = { scope: v.scope };
  }
  integer("idlePauseSeconds", 10, 86400);
  integer("maxSessionSeconds", 60, 604800);
  integer("maxConcurrent", 1, 1000);
  dollars("maxSessionDollars", 10000);
  dollars("maxDayDollars", 100000);
  if (def.command === undefined)
    note(
      at("command"),
      `is missing: give template (${Object.keys(AGENT_TEMPLATES).join(", ")}) or command.`,
    );

  const triggers: AgentsFileTrigger[] = [];
  if (entry.triggers !== undefined && entry.triggers !== null) {
    if (!Array.isArray(entry.triggers)) note(at("triggers"), "takes a list of { kind, config }.");
    else {
      const seen = new Set<string>();
      entry.triggers.forEach((t, i) => {
        const made = checkTrigger(t, (rest, message) => note(at("triggers", i, ...rest), message));
        if (!made) return;
        const id = triggerIdentity(made);
        if (seen.has(id))
          note(at("triggers", i), "is the same trigger as one above: name it once.");
        seen.add(id);
        triggers.push(made);
      });
    }
  }
  if (!before.n && !within(def, DEFINITION_MAX_BYTES))
    note(at(), "is over 128 KiB as the API takes it: shorten its instructions, env or lists.");
  if (before.n) return null;
  return { name, definition: def as AgentDefinition, triggers };
}

function checkTrigger(
  t: unknown,
  note: (rest: Path, message: string) => void,
): AgentsFileTrigger | null {
  if (!isObject(t)) {
    note([], "takes { kind, config }.");
    return null;
  }
  let ok = true;
  const bad = (rest: Path, message: string) => {
    ok = false;
    note(rest, message);
  };
  for (const key of Object.keys(t))
    if (!["kind", "config", "paused"].includes(key))
      bad([key], `is not a field a trigger takes${hint(key, ["kind", "config", "paused"])}`);
  const kind = t.kind as AgentTriggerKind;
  if (!TRIGGER_KINDS.includes(kind)) {
    bad(["kind"], `takes ${TRIGGER_KINDS.join(", ")}.`);
    return null;
  }
  const config = t.config ?? (kind === "webhook" ? {} : undefined);
  if (!isObject(config)) {
    bad(["config"], `is missing: ${CONFIGS[kind]}.`);
    return null;
  }
  // Only the documented keys, each checked: what is hashed into a key and
  // sent is never more than these.
  const str = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
  const allowed = TRIGGER_KEYS[kind];
  const stray = Object.keys(config).filter((k) => !allowed.includes(k));
  for (const k of stray)
    bad(["config", k], `is not a key a ${kind} trigger takes${hint(k, allowed)}`);
  if (
    !stray.length &&
    ((kind === "slack" &&
      !(str(config.team, /^T[A-Z0-9]{2,31}$/) && str(config.channel, /^[CG][A-Z0-9]{2,31}$/))) ||
      (kind === "github" &&
        !(
          str(config.repository, /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/) &&
          typeof config.installation === "number" &&
          Number.isSafeInteger(config.installation) &&
          config.installation > 0 &&
          (config.events === undefined ||
            (Array.isArray(config.events) &&
              config.events.length <= 20 &&
              config.events.every((e) => str(e, /^[a-z_]{1,64}(\.[a-z_]{1,64})?$/))))
        )) ||
      (kind === "schedule" &&
        !(
          typeof config.cron === "string" &&
          config.cron.length >= 9 &&
          config.cron.length <= 128 &&
          (config.timezone === undefined || str(config.timezone, /^[A-Za-z0-9_+\-/]{1,64}$/)) &&
          typeof config.input === "string" &&
          config.input.length >= 1 &&
          config.input.length <= 32768
        )))
  )
    bad(["config"], `takes ${CONFIGS[kind]}.`);
  const paused = t.paused;
  if (
    paused !== undefined &&
    (typeof paused !== "string" || paused.length < 1 || paused.length > 1024)
  )
    bad(["paused"], "takes the words a held trigger says, 1 to 1024 characters.");
  if (ok && !within(config, TRIGGER_MAX_BYTES)) bad(["config"], "is over 40 KiB.");
  if (!ok) return null;
  return { kind, config, ...(typeof paused === "string" ? { paused } : {}) };
}
const TRIGGER_KEYS: Record<AgentTriggerKind, readonly string[]> = {
  slack: ["team", "channel"],
  github: ["installation", "repository", "events"],
  schedule: ["cron", "timezone", "input"],
  webhook: [],
};
const CONFIGS: Record<AgentTriggerKind, string> = {
  slack: "{ team: T…, channel: C… } (Runtime's Slack app installed in your workspace)",
  github:
    "{ installation: <id>, repository: owner/name, events?: up to 20 such as pull_request } (Runtime's GitHub App)",
  schedule: '{ cron: "0 9 * * 1-5", timezone?: America/Denver, input: "what to do" }',
  webhook: "{} or nothing",
};

/** Makes the account's agents match the file: the plan, then (unless
 * dryRun) each change in order. A failed change stops the deploy; what was
 * done stays done, and running it again finishes the rest. */
export async function deployAgents(
  port: AgentsDeployPort,
  input: AgentsFile | AgentsSource,
  options: AgentsDeployOptions = {},
): Promise<AgentsDeployResult> {
  const source = sourceOf(input, options);
  const desired = checkAgentsFile(source, options);
  const plan = await planAgents(port, desired, options);
  const result = { file: source.file, dryRun: options.dryRun === true, ...plan };
  if (options.dryRun) return result;
  const ids = new Map<string, string>();
  for (const change of plan.changes) {
    await apply(port, change, ids);
    options.onChange?.(change);
  }
  return result;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a deploy would change, reading the account through `port`. */
export async function planAgents(
  port: AgentsDeployPort,
  desired: DesiredAgent[],
  options: { prune?: boolean; pruneMemory?: boolean } = {},
): Promise<Pick<AgentsDeployResult, "changes" | "unchanged" | "leftAlone">> {
  const changes: AgentsDeployChange[] = [];
  const unchanged: string[] = [];
  const leftAlone: AgentsDeployResult["leftAlone"] = [];
  const current = await port.list();
  const byName = new Map(current.map((a) => [a.name, a]));
  for (const want of desired) {
    const have = byName.get(want.name);
    const before = changes.length;
    if (!have) {
      changes.push({
        action: "create",
        agent: want.name,
        definition: want.definition,
        key: await keyOf("create", want.name, want.definition),
        text: `create agent ${want.name} (${describe(want.definition)})`,
      });
      for (const [i, trigger] of want.triggers.entries())
        changes.push({
          action: "add-trigger",
          agent: want.name,
          agentId: null,
          trigger,
          key: await keyOf("add-trigger", want.name, "new", i, trigger),
          text: `add trigger ${triggerText(trigger)} to ${want.name}`,
        });
      continue;
    }
    const fields = changedFields(have.definition, want.definition);
    if (fields.length)
      changes.push({
        action: "update",
        agent: want.name,
        agentId: have.id,
        fromVersion: have.version,
        fields,
        definition: want.definition,
        key: await keyOf("update", have.id, have.version, want.definition),
        text: `update agent ${want.name}: ${fields.join(", ")} (v${have.version} -> v${have.version + 1})`,
      });
    const triggers = await port.triggers(have.id);
    const state = triggers.map((t) => t.id).sort();
    const open = [...triggers];
    const adds: AgentsFileTrigger[] = [];
    for (const trigger of want.triggers) {
      const at = open.findIndex((t) => triggerIdentity(t) === triggerIdentity(trigger));
      if (at < 0) {
        adds.push(trigger);
        continue;
      }
      const [match] = open.splice(at, 1);
      if (trigger.paused !== undefined && match!.pausedWhy !== trigger.paused)
        changes.push({
          action: "pause-trigger",
          agent: want.name,
          triggerId: match!.id,
          why: trigger.paused,
          key: await keyOf("pause-trigger", match!.id, trigger.paused, match!.updatedAt),
          text: `pause trigger ${match!.id} (${triggerText(trigger)}) of ${want.name}: ${trigger.paused}`,
        });
      else if (trigger.paused === undefined && match!.pausedAt !== null)
        changes.push({
          action: "resume-trigger",
          agent: want.name,
          triggerId: match!.id,
          key: await keyOf("resume-trigger", match!.id, match!.updatedAt),
          text: `resume trigger ${match!.id} (${triggerText(trigger)}) of ${want.name}`,
        });
    }
    for (const gone of open)
      changes.push({
        action: "remove-trigger",
        agent: want.name,
        triggerId: gone.id,
        key: await keyOf("remove-trigger", gone.id),
        text: `remove trigger ${gone.id} (${triggerText(gone)}) of ${want.name}`,
      });
    // The account's triggers as they stand are in the key: a trigger removed
    // and named again later is a new trigger, never a replay of the old one.
    for (const [i, trigger] of adds.entries())
      changes.push({
        action: "add-trigger",
        agent: want.name,
        agentId: have.id,
        trigger,
        key: await keyOf("add-trigger", have.id, state, i, trigger),
        text: `add trigger ${triggerText(trigger)} to ${want.name}`,
      });
    if (changes.length === before) unchanged.push(want.name);
  }
  const named = new Set(desired.map((d) => d.name));
  for (const agent of current) {
    if (named.has(agent.name)) continue;
    const managed = agent.labels?.["managed-by"] === MANAGED_LABEL["managed-by"];
    // Deleting an agent deletes its memory, for good: often its users' own
    // notes. A renamed or dropped agent that still holds some is kept unless
    // the caller says the files may go too.
    const files = managed && options.prune ? await port.memoryFiles(agent.id) : 0;
    if (managed && options.prune && files > 0 && !options.pruneMemory)
      leftAlone.push({
        agent: agent.name,
        why: `not in the file, and it holds ${plural(files, "memory file")}; --prune-memory deletes it and them, for good`,
      });
    else if (managed && options.prune)
      changes.push({
        action: "delete",
        agent: agent.name,
        agentId: agent.id,
        key: await keyOf("delete", agent.id),
        text: `delete agent ${agent.name} (not in the file; its triggers${files ? `, its ${plural(files, "memory file")}` : ""} and its open sessions go)`,
      });
    else if (managed)
      leftAlone.push({ agent: agent.name, why: "not in the file; --prune deletes it" });
    else if (options.prune)
      leftAlone.push({
        agent: agent.name,
        why: "made outside a runtime.yml, so --prune keeps it; `runtime agents rm` deletes it",
      });
  }
  return { changes, unchanged, leftAlone };
}

async function apply(port: AgentsDeployPort, change: AgentsDeployChange, ids: Map<string, string>) {
  switch (change.action) {
    case "create": {
      const input = {
        name: change.agent,
        definition: change.definition,
        labels: { ...MANAGED_LABEL },
      };
      let made: Agent;
      try {
        made = await port.create(input, change.key);
      } catch (error) {
        // The same key once made an agent of this name that was deleted
        // since: the key answers that one. Make it again, with a new key.
        if (!(error instanceof RuntimeError && error.code === "not_found")) throw error;
        made = await port.create(input, `${change.key}.${Math.random().toString(16).slice(2, 10)}`);
      }
      ids.set(change.agent, made.id);
      return;
    }
    case "update":
      await port.update(change.agentId, change.definition, change.key);
      return;
    case "delete":
      await port.delete(change.agentId, change.key);
      return;
    case "add-trigger": {
      const agentId = change.agentId ?? ids.get(change.agent);
      if (!agentId) throw new Error(`deploy: ${change.agent} was not made before its trigger`);
      // A new agent's trigger is keyed by the agent it is added to as well:
      // an agent of the same name deleted and made again is another agent, so
      // its triggers never replay the deleted one's answers.
      // The change answers the key it was sent with.
      if (!change.agentId) change.key = await keyOf(change.key, agentId);
      const key = change.key;
      const made = await port.addTrigger(
        agentId,
        { kind: change.trigger.kind, config: change.trigger.config } as CreateAgentTrigger,
        key,
      );
      change.triggerId = made.id;
      if (made.secret) change.secret = made.secret;
      if (change.trigger.paused !== undefined)
        await port.pauseTrigger(
          made.id,
          change.trigger.paused,
          await keyOf("pause-trigger", made.id, change.trigger.paused, made.updatedAt),
        );
      return;
    }
    case "pause-trigger":
      await port.pauseTrigger(change.triggerId, change.why, change.key);
      return;
    case "resume-trigger":
      await port.resumeTrigger(change.triggerId, change.key);
      return;
    case "remove-trigger":
      await port.removeTrigger(change.triggerId, change.key);
      return;
  }
}

/** The fields whose value differs. A field the file leaves out matches the
 * API's default for it, and a snapshot's size is the snapshot's. */
export function changedFields(current: AgentDefinition, desired: AgentDefinition): string[] {
  const have: Record<string, unknown> = { ...current };
  const want: Record<string, unknown> = { ...desired };
  for (const [field, value] of Object.entries(SERVER_DEFAULTS))
    if (!(field in want) && canonical(have[field]) === canonical(value)) delete have[field];
  if (isObject(want.from) && "snapshot" in want.from)
    for (const field of ["vcpu", "memoryMiB"]) if (!(field in want)) delete have[field];
  const fields = new Set([...Object.keys(have), ...Object.keys(want)]);
  return [...fields].filter((f) => canonical(have[f]) !== canonical(want[f])).sort();
}

/** JSON with every map's keys sorted, so equal values read equal. */
export function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_, v: unknown) =>
    isObject(v) && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
const triggerIdentity = (t: { kind: string; config: unknown }) =>
  `${t.kind} ${canonical(t.config)}`;
function triggerText(t: { kind: string; config: Record<string, unknown> }): string {
  const c = t.config;
  const what =
    t.kind === "schedule"
      ? `"${String(c.cron)}"`
      : t.kind === "github"
        ? String(c.repository)
        : t.kind === "slack"
          ? `${String(c.team)}/${String(c.channel)}`
          : "";
  return what ? `${t.kind} ${what}` : t.kind;
}
function describe(d: AgentDefinition): string {
  const size = d.vcpu !== undefined ? `${d.vcpu} vCPU, ${d.memoryMiB} MiB` : "the snapshot's size";
  const harness = Object.values(AGENT_TEMPLATES).find((t) => t.command === d.command);
  return `${harness ? `${harness.key}, ` : ""}${size}`;
}

/** An idempotency key from what a change does and what it was planned
 * against: the same rerun sends the same key. */
async function keyOf(...parts: unknown[]): Promise<string> {
  const data = new TextEncoder().encode(parts.map(canonical).join("\n"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return `deploy:${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function sourceOf(input: AgentsFile | AgentsSource, options: AgentsDeployOptions): AgentsSource {
  if (isObject(input) && "config" in input && typeof input.file === "string")
    return {
      ...input,
      ...(options.readFile ? { readFile: options.readFile } : {}),
    };
  return {
    file: options.file ?? "runtime.yml",
    config: input,
    ...(options.readFile ? { readFile: options.readFile } : {}),
  };
}
/** The largest file, definition and trigger config a deploy reads, in
 * bytes of JSON (the API's own cap on a definition is 128 KiB). */
const FILE_MAX_BYTES = 256 * 1024;
const DEFINITION_MAX_BYTES = 128 * 1024;
const TRIGGER_MAX_BYTES = 40 * 1024;
/** Whether `value`, as JSON, is at most about `limit` bytes. Walks with a
 * budget and stops when it is spent, so a value of shared parts (each part
 * counted every time it is reached) or a cycle is refused at once, never
 * expanded. */
export function within(value: unknown, limit: number): boolean {
  let left = limit;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") left -= v.length + 2;
    else if (Array.isArray(v)) {
      left -= 2 + v.length;
      for (const item of v) stack.push(item);
    } else if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v);
      left -= 2 + entries.length;
      for (const [k, item] of entries) {
        left -= k.length + 3;
        stack.push(item);
      }
    } else left -= 8;
    if (left < 0) return false;
  }
  return true;
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** " (did you mean X?)." when a known word is close, else ".". */
function hint(word: string, known: readonly string[]): string {
  const lower = word.toLowerCase();
  const near = known.find((k) => {
    const l = k.toLowerCase();
    if (l === lower || l.startsWith(lower) || lower.startsWith(l)) return true;
    return distance(l, lower) <= (Math.max(l.length, lower.length) > 5 ? 2 : 1);
  });
  return near ? ` (did you mean ${near}?).` : ".";
}
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

/** The deploy's reads and changes over the client's own calls, each change
 * sent with its idempotency key. */
function clientPort(api: Runtime["agents"]): AgentsDeployPort {
  return {
    list: async () => (await api.list({ limit: 100 })).toArray(Infinity),
    create: (input, idempotencyKey) => api.create(input, { idempotencyKey }),
    update: (agentId, definition, idempotencyKey) =>
      api.update(agentId, definition, { idempotencyKey }),
    delete: (agentId, idempotencyKey) => api.delete(agentId, { idempotencyKey }),
    triggers: (agentId) => api.triggers.list(agentId),
    addTrigger: (agentId, input, idempotencyKey) =>
      api.triggers.create(agentId, input, { idempotencyKey }),
    pauseTrigger: (id, why, idempotencyKey) => api.triggers.pause(id, why, { idempotencyKey }),
    resumeTrigger: (id, idempotencyKey) => api.triggers.resume(id, { idempotencyKey }),
    removeTrigger: (id, idempotencyKey) => api.triggers.delete(id, { idempotencyKey }),
    memoryFiles: async (agentId) => (await api.memory.list(agentId, { limit: 1 })).usage.files,
  };
}

/** The agents client with `deploy`. It lives here, not on `runtime.agents`,
 * so code that loads only the main client (Runtime's own hub among it) never
 * loads the deploy (agents/hub-loads.ts). */
export type AgentsClient = Runtime["agents"] & {
  /** Makes your agents match a runtime.yml's `agents:` section: creates
   * the missing, makes a new version of a changed one (an unchanged one
   * gets none), and adds, pauses, resumes or removes triggers. Deletes an
   * agent only with `prune`, and only one a deploy made, and one holding
   * memory files only with `pruneMemory` as well. `dryRun` reads
   * and plans, changing nothing. Every change has an idempotency key, so a
   * rerun is safe. The same plan as `runtime agents deploy`.
   *
   *   import { agents, loadAgentsFile } from "withruntime/agents";
   *   const plan = await agents().deploy(loadAgentsFile("runtime.yml"), { dryRun: true });
   *   for (const change of plan.changes) console.log(change.text);
   */
  deploy(
    file: AgentsFile | AgentsSource,
    options?: AgentsDeployOptions,
  ): Promise<AgentsDeployResult>;
};

/** `api` with `deploy`. */
export function withDeploy(api: Runtime["agents"]): AgentsClient {
  return {
    ...api,
    deploy: (file, options = {}) => deployAgents(clientPort(api), file, options),
  };
}
