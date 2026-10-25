import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentsDeployChange, AgentsDeployResult } from "./agents-deploy.js";
import { me, named } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { Runtime } from "./client.js";
import {
  AGENT_TEMPLATES,
  agentTemplate,
  AGENT_USES,
  agents,
  type AgentAsk,
  type AgentAskState,
  type AgentDefinition,
  type AgentEvent,
  type AgentHeldCall,
  type AgentSessionState,
  type AgentTriggerRules,
  type CreateAgentTrigger,
} from "./products/agents.js";

/* `runtime agents`, kept out of cli.ts as apps-cli.ts is. In a private
   beta: a key outside it is refused product_in_beta, said in the server's
   words and hint (cli-words.ts), never as a stack. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };
type Args = ReturnType<CliKit["parse"]>;

export const AGENT_HELP = `runtime agents <command>

  An agent runs a harness (Claude Code, Codex, Gemini CLI, or your own code on
  an agents SDK) in a sandbox of its own for each session, on your model key.
  In a private beta: outside it, each command says how to ask to join.

  templates                                   The harnesses and uses to start from
  init [name] [--template <harness>] [--use support|team] [--file runtime.yml]
                                              Write a starter agents: section into runtime.yml
  deploy [--file runtime.yml] [--dry-run] [--prune [--prune-memory]]
                                              Make your agents match runtime.yml: create, update
                                              (a new version only when it changed) and set
                                              triggers; one line per change. --prune deletes the
                                              agents a deploy made that the file no longer names,
                                              with their triggers; one holding memory files only
                                              with --prune-memory too, which deletes them for good
  create <name> (--template <harness> | --command "<cmd>") [--use support|team]
         [--instructions <text> | --instructions-file <path>] [--secret NAME]... [--pool NAME]...
         [--env KEY=VALUE]... [--image <image> | --snapshot <id>] [--vcpu n] [--memory n]
         [--max-concurrent n] [--idle-pause n] [--label key=value]...
                                              Make an agent; prints its id. --secret names an egress
                                              secret it may use: its model key, of any provider.
                                              --pool names a Claude account's secret (each one
                                              given replaces the template's): each session takes
                                              the one with the most usage left
  ls                                          Your agents
  get <agent>                                 One agent, in full (an id or its name)
  update <agent> [the options of create]      A new version: what you give changes, the rest stays
  rm <agent>                                  Delete it, its triggers, and stop its sessions
  start <agent> <words...> [--key <key>] [--follow]
                                              A session with these words, or the open one with the
                                              key (such as customer:42); --follow prints its log
                                              until it ends
  send <session> <words...>                   Words into a session
  events <session> [--after <seq>] [--follow] A session's log; --follow until it ends
  sessions [--agent <agent>] [--state <state>]...
                                              Sessions, newest first
  sessions delete <session>                   Delete an ended session and its log; its history is
                                              storage, kept until you delete it
  stop <session>                              Stop a session
  asks [--state <state>]... [--agent <agent>] [--label key=value]...
                                              The inbox: what your agents' sessions need answered,
                                              one row per step however many sessions ask it
  asks get <ask>                              One ask: its options, pick and the sessions asking
  answer <ask> [<option>] [--text <words>]    Answer it with an option's label, words, or both:
                                              every session asking reads it next and wakes
  triggers <agent>                            Its triggers
  triggers add <agent> --kind <slack|github|schedule|webhook> --config '<json>' [--rules '<json>']
  triggers rules <triggerId> '<json>'         Set its rules in place: priority, maxStartsPerHour,
                                              onEnded (start|note|ask), notify (email|webhook)
                                              and a webhook's key ("{cause}"); its secret stays
  triggers call <triggerId> <words...> [--key <key>] [--label key=value]... [--secret <secret>]
                                              Call a webhook as its sender would, by its secret
                                              (or RUNTIME_TRIGGER_SECRET): starts, joins, notes or
                                              holds
  triggers held <triggerId> [--state held|started|dismissed]...
                                              Calls it held for you; none is dropped
  triggers held start <triggerId> <callId>    Start one, with every call held for its key since
  triggers held dismiss <triggerId> <callId>  Dismiss one; nothing runs
  triggers pause <triggerId> --why <words>    Hold it: a webhook's calls are kept for you, saying why
  triggers resume <triggerId>
  triggers rm <triggerId>
  memory ls <agent> [--scope <key>] [--prefix <path>]
                                              Its memory files, with their scope (shared or a key)
  memory search <agent> <words...> [--scope <key>] [--limit n]
                                              Files whose words match, best first
  memory cat <agent> <path> [--scope <key>]   A file's text
  memory put <agent> <path> [<file> | - | --content <text>] [--scope <key>]
                                              Seed or replace a file (from a file, or - for stdin)
  memory rm <agent> <path> [--scope <key>]    Delete a file
                                              Without --scope: the shared memory, which every
                                              session reads and only a shared agent's write

  A subscription is for your own team's agents; an agent that serves your
  customers uses an API key.

Examples
  printf %s "$ANTHROPIC_API_KEY" | runtime secrets set ANTHROPIC_API_KEY --host api.anthropic.com
  runtime agents create helper --template claude-code --use support --instructions "Answer briefly."
  runtime agents start helper "How do I reset my password?" --key customer:42 --follow
  runtime agents memory put helper faq/refunds.md refunds.md
  runtime agents asks && runtime agents answer <ask> "Raise to 20 TB"
  runtime agents init --template claude-code && runtime agents deploy --dry-run
  runtime agents create ci-review --template review --pool CLAUDE_1 --pool CLAUDE_2
`;

const when = (iso: string | null | undefined) => iso ?? "-";
/** A trigger's rules as the CLI takes them: one JSON object. */
function rulesOf(text: string, kit: CliKit): AgentTriggerRules {
  let rules: unknown;
  try {
    rules = JSON.parse(text);
  } catch {
    rules = undefined;
  }
  if (!rules || typeof rules !== "object" || Array.isArray(rules))
    throw kit.usage(
      `Rules are a JSON object, such as '{"key":"{cause}","maxStartsPerHour":60,"onEnded":"ask"}'.`,
    );
  return rules as AgentTriggerRules;
}
const OPTIONS = [
  "template",
  "use",
  "command",
  "instructions",
  "instructions-file",
  "secret",
  "pool",
  "env",
  "image",
  "snapshot",
  "vcpu",
  "memory",
  "max-concurrent",
  "idle-pause",
  "label",
];
const ASK_STATES: readonly AgentAskState[] = ["open", "answered", "expired", "withdrawn", "closed"];
const askLine = (a: AgentAsk) => {
  const options = a.options.map((o) => (o.label === a.pick ? `${o.label} (pick)` : o.label));
  return [
    `${a.id} ${a.state}${a.step ? ` step ${a.step}` : ""}, ${a.sessions.length} session${a.sessions.length === 1 ? "" : "s"} asking`,
    `  ${a.question}`,
    ...(a.why ? [`  why: ${a.why}`] : []),
    ...(options.length ? [`  options: ${options.join(" | ")}`] : []),
    ...(a.expiresAt ? [`  expires ${a.expiresAt}`] : []),
    ...(a.answer
      ? [`  answered: ${[a.answer.option, a.answer.text].filter(Boolean).join(": ")}`]
      : []),
  ].join("\n");
};
const STATES: readonly AgentSessionState[] = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "stopped",
];

/** The definition the options give, on top of `base` (an agent's own, for
 * an update): a template's command and key, a use's sizes, then each option. */
function definitionOf(args: Args, kit: CliKit, env: NodeJS.ProcessEnv, base?: AgentDefinition) {
  const { flag, integer, usage } = kit;
  const template = flag(args, "template");
  const use = flag(args, "use");
  if (template !== undefined && !(template in AGENT_TEMPLATES))
    throw usage(`--template takes ${Object.keys(AGENT_TEMPLATES).join(", ")}.`);
  if (use !== undefined && use !== "support" && use !== "team")
    throw usage("--use takes support or team.");
  const instructionsFile = flag(args, "instructions-file");
  const instructions =
    instructionsFile !== undefined
      ? readFileSync(instructionsFile, "utf8")
      : flag(args, "instructions");
  const image = flag(args, "image");
  const snapshot = flag(args, "snapshot");
  if (image !== undefined && snapshot !== undefined)
    throw usage("Give --image or --snapshot, not both.");
  const secrets = args.flags.get("secret");
  const definition: Record<string, unknown> = {
    ...(base ?? {}),
    ...(template ? agentTemplate(template)!.definition : {}),
    ...(use ? AGENT_USES[use].definition : {}),
  };
  const set = (field: string, value: unknown) => {
    if (value !== undefined) definition[field] = value;
  };
  set("command", flag(args, "command"));
  set("instructions", instructions);
  if (secrets)
    set("secrets", [...new Set([...((definition.secrets as string[]) ?? []), ...secrets])]);
  const pool = args.flags.get("pool");
  if (pool) set("pool", [...new Set(pool)]);
  if (args.flags.has("env"))
    set("env", {
      ...(definition.env ?? {}),
      ...kit.envPairs(args, env),
    });
  if (image !== undefined) set("from", { image });
  if (snapshot !== undefined) set("from", { snapshot });
  set("vcpu", integer(args, "vcpu"));
  set("memoryMiB", integer(args, "memory"));
  set("maxConcurrent", integer(args, "max-concurrent"));
  set("idlePauseSeconds", integer(args, "idle-pause"));
  return definition as AgentDefinition;
}

const line = (e: AgentEvent) =>
  `${String(e.seq).padStart(4)} ${e.kind.padEnd(6)} ${e.actor}: ${typeof e.body.text === "string" ? e.body.text : JSON.stringify(e.body)}`;

export async function agentsCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  const { parse, flag, has, need, pairs, table, usage, unknown } = kit;
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(AGENT_HELP), { usage: named(AGENT_HELP) });
    return 0;
  }
  if (verb === "templates") {
    const value = { templates: AGENT_TEMPLATES, uses: AGENT_USES };
    print(
      [
        table([
          ["TEMPLATE", "HARNESS", "MODEL KEY", "SUBSCRIPTION"],
          ...Object.values(AGENT_TEMPLATES).map((t) => [
            t.key,
            t.title,
            `${t.apiKeySecret} (${t.apiKeyHost})`,
            t.subscription ? "yes, for your own team" : "no",
          ]),
        ]),
        "",
        table([
          ["USE", "FOR", "SIZE", "TRIGGERS"],
          ...Object.values(AGENT_USES).map((u) => [
            u.key,
            u.title,
            `${u.definition.vcpu} vCPU, ${u.definition.memoryMiB} MiB`,
            u.triggers.join(", "),
          ]),
        ]),
      ].join("\n"),
      value,
    );
    return 0;
  }
  if (verb === "init") return initFile(rest, out, kit);
  if (verb === "deploy") return deploy(rest, out, client, kit);
  const transport = (await client()).transport;
  const api = agents(transport);
  const follow = async (sessionId: string, after: number) => {
    for await (const e of (await api.session(sessionId)).events({ after }))
      out.write(out.json ? JSON.stringify(e) : line(e));
  };
  switch (verb) {
    case "create": {
      const args = parse(rest, [], OPTIONS);
      const name = need(args.positional[0], "the agent's name");
      const definition = definitionOf(args, kit, env);
      if (!definition.command)
        throw usage(`Give --template (${Object.keys(AGENT_TEMPLATES).join(", ")}) or --command.`);
      const agent = await api.create({
        name,
        definition,
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
      });
      if (!out.json && agent.warnings.includes("subscription_for_customers"))
        out.error(
          "Warning: this agent answers your customers with a subscription's token. A subscription is for your own team's agents; an agent that serves your customers uses an API key.",
        );
      print(agent.id, agent);
      return 0;
    }
    case "ls":
    case "list": {
      parse(rest, [], []);
      const all = await (await api.list({ limit: 100 })).toArray(Infinity);
      print(
        all.length
          ? table([
              ["ID", "NAME", "VERSION", "SIZE", "COMMAND", "CREATED"],
              ...all.map((a) => [
                a.id,
                a.name,
                `v${a.version}`,
                `${a.definition.vcpu} vCPU, ${a.definition.memoryMiB} MiB`,
                a.definition.command.length > 40
                  ? `${a.definition.command.slice(0, 39)}…`
                  : a.definition.command,
                when(a.createdAt),
              ]),
            ])
          : `No agents. Make one: ${me} agents create helper --template claude-code --use support`,
        all,
      );
      return 0;
    }
    case "get": {
      const agent = await api.get(need(rest[0], "an agent's id or name"));
      print(JSON.stringify(agent, null, 2), agent);
      return 0;
    }
    case "update": {
      const args = parse(
        rest,
        [],
        OPTIONS.filter((o) => o !== "label"),
      );
      const current = await api.get(need(args.positional[0], "an agent's id or name"));
      const agent = await api.update(current.id, definitionOf(args, kit, env, current.definition));
      print(`${agent.name} is now version ${agent.version}.`, agent);
      return 0;
    }
    case "rm":
    case "delete": {
      const target = need(rest[0], "an agent's id or name");
      await api.delete(target);
      print(`${target} deleted; its open sessions are stopping.`, { deleted: true });
      return 0;
    }
    case "start": {
      const args = parse(rest, ["follow"], ["key"]);
      const target = need(args.positional[0], "an agent's id or name");
      const input = args.positional.slice(1).join(" ");
      if (!input)
        throw usage(`Give the words: ${me} agents start ${target} "Fix the failing test"`);
      const key = flag(args, "key");
      const session = await api.start(target, {
        input,
        ...(key === undefined ? {} : { key }),
      });
      if (!has(args, "follow")) {
        print(session.id, { session: session.session, joined: session.joined, seq: session.seq });
        return 0;
      }
      if (!out.json) out.error(`Session ${session.id}${session.joined ? " (joined)" : ""}`);
      await follow(session.id, 0);
      return 0;
    }
    case "send": {
      const id = need(rest[0], "a session's id");
      const text = rest.slice(1).join(" ");
      if (!text) throw usage(`Give the words: ${me} agents send ${id} "And the docs too"`);
      const sent = await (await api.session(id)).send(text);
      print(`seq ${sent.seq}`, sent);
      return 0;
    }
    case "events": {
      const args = parse(rest, ["follow"], ["after"]);
      const id = need(args.positional[0], "a session's id");
      const after = kit.integer(args, "after") ?? 0;
      if (has(args, "follow")) {
        await follow(id, after);
        return 0;
      }
      // One read without waiting: what is there now.
      const read = await transport.json<{ data: AgentEvent[]; ended: boolean }>({
        method: "GET",
        path: `/v1/agents/sessions/${encodeURIComponent(id)}/events`,
        query: { after },
      });
      print(read.data.map(line).join("\n") || "No events yet.", read);
      return 0;
    }
    case "sessions": {
      if (rest[0] === "delete" || rest[0] === "rm") {
        const target = need(rest[1], "a session's id");
        await api.sessions.delete(target);
        print(`${target} deleted.`, { deleted: true });
        return 0;
      }
      const args = parse(rest, [], ["agent", "state"]);
      const states = args.flags.get("state");
      for (const state of states ?? [])
        if (!STATES.includes(state as AgentSessionState))
          throw usage(`--state takes ${STATES.join(", ")}.`);
      const agent = flag(args, "agent");
      const page = await api.sessions.list({
        limit: 100,
        ...(agent === undefined ? {} : { agent }),
        ...(states ? { state: states as AgentSessionState[] } : {}),
      });
      print(
        page.data.length
          ? table([
              ["ID", "AGENT", "STATE", "KEY", "TRIGGER", "CREATED"],
              ...page.data.map((s) => [
                s.id,
                s.agentId,
                s.state,
                s.key ?? "-",
                s.trigger,
                when(s.createdAt),
              ]),
            ])
          : "No sessions.",
        page.data,
      );
      return 0;
    }
    case "asks": {
      if (rest[0] === "get") {
        const one = await api.asks.get(need(rest[1], "an ask's id"));
        print(askLine(one), one);
        return 0;
      }
      const args = parse(rest, [], ["state", "agent", "label"]);
      const states = args.flags.get("state");
      for (const state of states ?? [])
        if (!ASK_STATES.includes(state as AgentAskState))
          throw usage(`--state takes ${ASK_STATES.join(", ")}.`);
      const agent = flag(args, "agent");
      const labels = args.flags.has("label") ? pairs(args, "label") : undefined;
      const page = await api.asks.list({
        limit: 100,
        ...(agent === undefined ? {} : { agent }),
        ...(states ? { state: states as AgentAskState[] } : {}),
        ...(labels ? { labels } : {}),
      });
      print(page.data.map(askLine).join("\n\n") || "Nothing to answer.", page.data);
      return 0;
    }
    case "answer": {
      const args = parse(rest, [], ["text"]);
      const id = need(args.positional[0], "an ask's id");
      const option = args.positional.slice(1).join(" ") || undefined;
      const text = flag(args, "text");
      if (option === undefined && text === undefined)
        throw usage(`Give an option's label, --text, or both: ${me} agents answer ${id} "Keep it"`);
      const answered = await api.asks.answer(id, {
        ...(option === undefined ? {} : { option }),
        ...(text === undefined ? {} : { text }),
      });
      print(
        `${answered.id} answered; ${answered.sessions.filter((x) => x.state === "answered").length} session(s) woken.`,
        answered,
      );
      return 0;
    }
    case "stop": {
      const session = await (await api.session(need(rest[0], "a session's id"))).stop();
      print(`${session.id} ${session.state}.`, session);
      return 0;
    }
    case "triggers": {
      const [sub, ...more] = rest;
      if (sub === "add") {
        const args = parse(more, [], ["kind", "config", "rules"]);
        const target = need(args.positional[0], "an agent's id or name");
        let config: unknown;
        try {
          config = JSON.parse(flag(args, "config") ?? "{}");
        } catch {
          throw usage(
            `--config takes JSON, such as --config '{"cron":"0 9 * * 1-5","input":"Triage new issues"}'.`,
          );
        }
        const rules = flag(args, "rules");
        const trigger = await api.triggers.create(target, {
          kind: need(flag(args, "kind"), "--kind"),
          config,
          ...(rules === undefined ? {} : { rules: rulesOf(rules, kit) }),
        } as CreateAgentTrigger);
        // A webhook's secret is answered this once.
        print(
          trigger.secret
            ? `${trigger.id}\nsecret ${trigger.secret} (shown once; each call carries it)`
            : trigger.id,
          trigger,
        );
        return 0;
      }
      if (sub === "rules") {
        const id = need(more[0], "a trigger's id");
        const trigger = await api.triggers.setRules(
          id,
          rulesOf(
            need(more[1], `the rules as JSON: ${me} agents triggers rules ${id} '{"priority":10}'`),
            kit,
          ),
        );
        print(`${trigger.id} rules ${JSON.stringify(trigger.rules)}`, trigger);
        return 0;
      }
      if (sub === "call") {
        const args = parse(more, [], ["key", "label", "secret"]);
        const id = need(args.positional[0], "a trigger's id");
        const text = args.positional.slice(1).join(" ");
        if (!text)
          throw usage(`Give the words: ${me} agents triggers call ${id} "disk full on db-1"`);
        const secret = flag(args, "secret") ?? env.RUNTIME_TRIGGER_SECRET;
        if (!secret)
          throw usage(
            "Give the trigger's secret: --secret rtat_… or RUNTIME_TRIGGER_SECRET, as answered when the webhook was added.",
          );
        const key = flag(args, "key");
        const done = await api.triggers.call(id, secret, {
          text,
          ...(key === undefined ? {} : { key }),
          ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
        });
        print(
          done.outcome === "held"
            ? `held ${done.callId}: ${done.why}`
            : `${done.outcome} ${done.sessionId} seq ${done.seq}`,
          done,
        );
        return 0;
      }
      if (sub === "held") {
        const [action, ...after] = more;
        if (action === "start" || action === "dismiss") {
          const id = need(after[0], "a trigger's id");
          const call = need(after[1], "a held call's id");
          if (action === "start") {
            const started = await api.triggers.startHeld(id, call);
            print(
              `${started.joined ? "joined" : "started"} ${started.session.id} with ${started.calls} held call${started.calls === 1 ? "" : "s"}`,
              started,
            );
          } else {
            const dismissed = await api.triggers.dismissHeld(id, call);
            print(`${dismissed.id} dismissed.`, dismissed);
          }
          return 0;
        }
        const args = parse(more, [], ["state"]);
        const states = args.flags.get("state");
        for (const state of states ?? [])
          if (!["held", "started", "dismissed"].includes(state))
            throw usage("--state takes held, started, dismissed.");
        const page = await api.triggers.held(need(args.positional[0], "a trigger's id"), {
          limit: 100,
          ...(states ? { state: states as AgentHeldCall["state"][] } : {}),
        });
        print(
          page.data.length
            ? table([
                ["ID", "STATE", "WHY", "KEY", "CREATED", "WORDS"],
                ...page.data.map((c) => [
                  c.id,
                  c.state,
                  c.why,
                  c.key ?? "-",
                  when(c.createdAt),
                  c.text.replace(/\s+/g, " ").slice(0, 60),
                ]),
              ])
            : "No held calls.",
          page.data,
        );
        return 0;
      }
      if (sub === "pause") {
        const args = parse(more, [], ["why"]);
        const trigger = await api.triggers.pause(
          need(args.positional[0], "a trigger's id"),
          need(flag(args, "why"), "--why"),
        );
        print(`${trigger.id} paused: ${trigger.pausedWhy}`, trigger);
        return 0;
      }
      if (sub === "resume") {
        const trigger = await api.triggers.resume(need(more[0], "a trigger's id"));
        print(`${trigger.id} resumed.`, trigger);
        return 0;
      }
      if (sub === "rm" || sub === "delete") {
        await api.triggers.delete(need(more[0], "a trigger's id"));
        print(`${more[0]} deleted.`, { deleted: true });
        return 0;
      }
      const all = await api.triggers.list(need(sub, "an agent's id or name"));
      print(
        all.length
          ? table([
              ["ID", "KIND", "CONFIG", "RULES", "PAUSED"],
              ...all.map((t) => [
                t.id,
                t.kind,
                JSON.stringify(t.config),
                Object.keys(t.rules ?? {}).length ? JSON.stringify(t.rules) : "-",
                t.pausedWhy ?? "-",
              ]),
            ])
          : "No triggers.",
        all,
      );
      return 0;
    }
    case "memory":
      return memoryCommand(rest, api, out, kit, print);
    default:
      throw unknown("agents command", verb, [
        "templates",
        "init",
        "deploy",
        "create",
        "ls",
        "get",
        "update",
        "rm",
        "start",
        "send",
        "events",
        "sessions",
        "stop",
        "asks",
        "answer",
        "triggers",
        "memory",
      ]);
  }
}

const scopeName = (scope: string) => scope || "(shared)";

/** `runtime agents memory`: an agent's built-in memory, by scope and path.
 * Without --scope, cat, put and rm mean the shared memory, which every
 * session reads (a per-key session read-only, what you put there alone);
 * ls and search mean every scope. */
async function memoryCommand(
  argv: string[],
  api: ReturnType<typeof agents>,
  out: Out,
  kit: CliKit,
  print: (human: string, value: unknown) => void,
): Promise<number> {
  const { parse, flag, need, table, usage, unknown } = kit;
  const [sub, ...rest] = argv;
  switch (sub) {
    case "ls":
    case "list": {
      const args = parse(rest, [], ["scope", "prefix"]);
      const agent = need(args.positional[0], "an agent's id or name");
      const scope = flag(args, "scope");
      const prefix = flag(args, "prefix");
      const first = await api.memory.list(agent, {
        limit: 1000,
        ...(scope === undefined ? {} : { scope }),
        ...(prefix === undefined ? {} : { prefix }),
      });
      const all = await first.toArray(Infinity);
      const { usage: used } = first;
      print(
        [
          all.length
            ? table([
                ["SCOPE", "PATH", "BYTES", "UPDATED"],
                ...all.map((f) => [scopeName(f.scope), f.path, String(f.bytes), f.updatedAt]),
              ])
            : "No memory files.",
          `${used.files} files, ${used.bytes} bytes in all (at most ${used.limitFiles} files, ${used.limitBytes} bytes).`,
        ].join("\n"),
        { data: all, usage: used },
      );
      return 0;
    }
    case "search": {
      const args = parse(rest, [], ["scope", "limit"]);
      const agent = need(args.positional[0], "an agent's id or name");
      const words = args.positional.slice(1).join(" ");
      if (!words)
        throw usage(`Give the words: ${me} agents memory search ${agent} "refund policy"`);
      const scope = flag(args, "scope");
      const limit = kit.integer(args, "limit");
      const hits = await api.memory.search(agent, words, {
        ...(scope === undefined ? {} : { scope }),
        ...(limit === undefined ? {} : { limit }),
      });
      print(
        hits.length
          ? table([
              ["SCOPE", "PATH", "SNIPPET"],
              ...hits.map((h) => [scopeName(h.scope), h.path, h.snippet.replace(/\s+/g, " ")]),
            ])
          : "Nothing matches.",
        hits,
      );
      return 0;
    }
    case "cat":
    case "read": {
      const args = parse(rest, [], ["scope"]);
      const agent = need(args.positional[0], "an agent's id or name");
      const file = await api.memory.read(agent, need(args.positional[1], "a file's path"), {
        scope: flag(args, "scope") ?? "",
      });
      print(file.content, file);
      return 0;
    }
    case "put":
    case "write": {
      const args = parse(rest, [], ["scope", "content"]);
      const agent = need(args.positional[0], "an agent's id or name");
      const path = need(args.positional[1], "a file's path");
      const source = args.positional[2];
      const given = flag(args, "content");
      if (given !== undefined && source !== undefined)
        throw usage("Give a file or --content, not both.");
      let content = given;
      if (content === undefined) {
        if (source !== undefined && source !== "-") content = readFileSync(source, "utf8");
        // stdin only when named: a CI step with nothing piped in would
        // otherwise replace the file with nothing.
        else if (source === "-") {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
          content = Buffer.concat(chunks).toString("utf8");
        } else
          throw usage(
            `Give the text: a file (${me} agents memory put ${agent} ${path} notes.md), - for stdin, or --content.`,
          );
      }
      const written = await api.memory.write(agent, path, content, {
        scope: flag(args, "scope") ?? "",
      });
      print(
        `${written.created ? "Wrote" : "Replaced"} ${path} in ${scopeName(written.scope)}: ${written.bytes} bytes.`,
        written,
      );
      return 0;
    }
    case "rm":
    case "delete": {
      const args = parse(rest, [], ["scope"]);
      const agent = need(args.positional[0], "an agent's id or name");
      const path = need(args.positional[1], "a file's path");
      const scope = flag(args, "scope") ?? "";
      const deleted = await api.memory.delete(agent, path, { scope });
      print(
        deleted
          ? `${path} deleted from ${scopeName(scope)}.`
          : `No ${path} in ${scopeName(scope)}.`,
        { deleted },
      );
      return 0;
    }
    default:
      if (!sub) throw usage("agents memory takes ls, search, cat, put or rm.");
      throw unknown("agents memory command", sub, ["ls", "search", "cat", "put", "rm"]);
  }
}

/** `runtime agents init`: a starter agents: section, into a new runtime.yml
 * or added to one that has none yet. The YAML parser loads only here and in
 * deploy. */
async function initFile(argv: string[], out: Out, kit: CliKit): Promise<number> {
  const { parse, flag, usage } = kit;
  const { AGENTS_FILE, parseAgentsFile, starterAgents } = await import("./agents-file.js");
  const args = parse(argv, [], ["template", "use", "file"]);
  const template = flag(args, "template") ?? "claude-code";
  if (!(template in AGENT_TEMPLATES))
    throw usage(`--template takes ${Object.keys(AGENT_TEMPLATES).join(", ")}.`);
  const use = flag(args, "use");
  if (use !== undefined && use !== "support" && use !== "team")
    throw usage("--use takes support or team.");
  const name = args.positional[0] ?? template;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))
    throw usage(
      "An agent's name is letters, digits, '.', '_' and '-', starting with a letter or digit.",
    );
  const file = flag(args, "file") ?? AGENTS_FILE;
  const folder = dirname(resolve(file));
  const instructionsFile = ["AGENTS.md", "CLAUDE.md"].find((f) => existsSync(join(folder, f)));
  const text = starterAgents({
    name,
    template,
    ...(use ? { use } : {}),
    ...(instructionsFile ? { instructionsFile } : {}),
  });
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8");
    const config = parseAgentsFile(existing, file).config;
    if (typeof config === "object" && config !== null && "agents" in config)
      throw usage(
        `${file} already has an agents: section. Add ${name} under it by hand, or run \`${me} agents deploy\`.`,
      );
    writeFileSync(file, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}\n${text}`);
  } else writeFileSync(file, text);
  const t = agentTemplate(template)!;
  say(
    out,
    [
      `Wrote agent ${name} (${t.title}) to ${file}${instructionsFile ? `, with ${instructionsFile} as its instructions` : ""}.`,
      "Next:",
      `  printf %s "$${t.apiKeySecret}" | ${me} secrets set ${t.apiKeySecret} --host ${t.apiKeyHost}`,
      `  ${me} agents deploy --dry-run`,
      `  ${me} agents deploy`,
    ].join("\n"),
    { file, name, template, text },
  );
  return 0;
}

/** `runtime agents deploy`: the file is read and checked before any key is
 * needed, then the plan is made against the account and each change made in
 * turn, printed as it is made with its idempotency key. */
async function deploy(
  argv: string[],
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  const { parse, flag, has } = kit;
  const { AGENTS_FILE, loadAgentsFile } = await import("./agents-file.js");
  const { checkAgentsFile, withDeploy } = await import("./agents-deploy.js");
  const args = parse(argv, ["dry-run", "prune", "prune-memory"], ["file"]);
  if (has(args, "prune-memory") && !has(args, "prune"))
    throw kit.usage("--prune-memory goes with --prune.");
  const dryRun = has(args, "dry-run");
  const source = loadAgentsFile(flag(args, "file") ?? AGENTS_FILE);
  const count = checkAgentsFile(source).length;
  const api = withDeploy(agents((await client()).transport));
  const shown = (c: AgentsDeployChange) => `${dryRun ? "would " : ""}${c.text}  (key ${c.key})`;
  if (!out.json)
    out.write(
      `${source.file}: ${count} agent${count === 1 ? "" : "s"}${dryRun ? ". Dry run: nothing is changed." : "."}`,
    );
  let made = 0;
  let result: AgentsDeployResult;
  try {
    result = await api.deploy(source, {
      dryRun,
      prune: has(args, "prune"),
      pruneMemory: has(args, "prune-memory"),
      onChange: (change) => {
        made++;
        if (out.json) return;
        out.write(shown(change));
        if (change.action === "add-trigger" && change.secret)
          out.write(
            `  secret ${change.secret}  (shown this once: each of its calls carries it; keep it now)`,
          );
      },
    });
  } catch (error) {
    if (made && !out.json)
      out.error(
        `Stopped after ${made} change${made === 1 ? "" : "s"}. Run \`${me} agents deploy\` again to make the rest: each change's key makes a rerun safe.`,
      );
    throw error;
  }
  if (out.json) {
    out.write(JSON.stringify(result));
    return 0;
  }
  if (dryRun) for (const change of result.changes) out.write(shown(change));
  if (result.unchanged.length) out.write(`unchanged: ${result.unchanged.join(", ")}`);
  for (const kept of result.leftAlone) out.write(`left alone: ${kept.agent} (${kept.why})`);
  const n = result.changes.length;
  out.write(
    n === 0
      ? `Nothing to change: your agents match ${source.file}.`
      : dryRun
        ? `${n} change${n === 1 ? "" : "s"} planned. Run \`${me} agents deploy\` to make ${n === 1 ? "it" : "them"}.`
        : `Done: ${n} change${n === 1 ? "" : "s"}.`,
  );
  return 0;
}

function say(out: Out, human: string, value: unknown) {
  out.write(out.json ? JSON.stringify(value) : human);
}
