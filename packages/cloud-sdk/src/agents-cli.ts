import { readFileSync } from "node:fs";
import { me, named } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { Runtime } from "./client.js";
import {
  AGENT_TEMPLATES,
  AGENT_USES,
  agents,
  type AgentDefinition,
  type AgentEvent,
  type AgentSessionState,
  type AgentTemplateKey,
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
  create <name> (--template <harness> | --command "<cmd>") [--use support|team]
         [--instructions <text> | --instructions-file <path>] [--secret NAME]...
         [--env KEY=VALUE]... [--image <image> | --snapshot <id>] [--vcpu n] [--memory n]
         [--max-concurrent n] [--idle-pause n] [--label key=value]...
                                              Make an agent; prints its id. --secret names an egress
                                              secret it may use: its model key, of any provider
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
  triggers <agent>                            Its triggers
  triggers add <agent> --kind <slack|github|schedule|webhook> --config '<json>'
  triggers pause <triggerId> --why <words>    Refuse its events, saying why; nothing else is held
  triggers resume <triggerId>
  triggers rm <triggerId>

  A subscription is for your own team's agents; an agent that serves your
  customers uses an API key.

Examples
  printf %s "$ANTHROPIC_API_KEY" | runtime secrets set ANTHROPIC_API_KEY --host api.anthropic.com
  runtime agents create helper --template claude-code --use support --instructions "Answer briefly."
  runtime agents start helper "How do I reset my password?" --key customer:42 --follow
`;

const when = (iso: string | null | undefined) => iso ?? "-";
const OPTIONS = [
  "template",
  "use",
  "command",
  "instructions",
  "instructions-file",
  "secret",
  "env",
  "image",
  "snapshot",
  "vcpu",
  "memory",
  "max-concurrent",
  "idle-pause",
  "label",
];
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
    ...(template ? AGENT_TEMPLATES[template as AgentTemplateKey].definition : {}),
    ...(use ? AGENT_USES[use].definition : {}),
  };
  const set = (field: string, value: unknown) => {
    if (value !== undefined) definition[field] = value;
  };
  set("command", flag(args, "command"));
  set("instructions", instructions);
  if (secrets)
    set("secrets", [...new Set([...((definition.secrets as string[]) ?? []), ...secrets])]);
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
    case "stop": {
      const session = await (await api.session(need(rest[0], "a session's id"))).stop();
      print(`${session.id} ${session.state}.`, session);
      return 0;
    }
    case "triggers": {
      const [sub, ...more] = rest;
      if (sub === "add") {
        const args = parse(more, [], ["kind", "config"]);
        const target = need(args.positional[0], "an agent's id or name");
        let config: unknown;
        try {
          config = JSON.parse(flag(args, "config") ?? "{}");
        } catch {
          throw usage(
            `--config takes JSON, such as --config '{"cron":"0 9 * * 1-5","input":"Triage new issues"}'.`,
          );
        }
        const trigger = await api.triggers.create(target, {
          kind: need(flag(args, "kind"), "--kind"),
          config,
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
              ["ID", "KIND", "CONFIG", "PAUSED"],
              ...all.map((t) => [t.id, t.kind, JSON.stringify(t.config), t.pausedWhy ?? "-"]),
            ])
          : "No triggers.",
        all,
      );
      return 0;
    }
    default:
      throw unknown("agents command", verb, [
        "templates",
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
        "triggers",
      ]);
  }
}
