/** Agents: a coding or support agent's harness (Claude Code, Codex, Gemini
 * CLI, or your own code on an agents SDK) in a sandbox of its own per
 * session, on your own model key. Your app drives its sessions through this
 * API and webhooks. In a private beta: outside it every call is refused with
 * `product_in_beta`.
 *
 *   const agent = await runtime.agents.create({
 *     name: "support",
 *     definition: {
 *       ...runtime.agents.templates["claude-code"].definition,
 *       ...runtime.agents.uses.support.definition,
 *       instructions: "Answer questions about our product. Be brief.",
 *     },
 *   });
 *   const session = await runtime.agents.start("support", { input: "Hi!", key: "customer:42" });
 *   for await (const event of session.events()) if (event.kind === "reply") console.log(event.body.text);
 *
 * A session's sandbox is billed while it runs, at $0.03 per active vCPU-hour
 * and $0.01 per GiB-hour of memory; a waiting session's sandbox is paused.
 * No session fee, no seats. */
import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";

export type AgentDefinition = {
  /** What runs the harness, from the sandbox's home. */
  command: string;
  /** Where each session's sandbox starts: an image of yours, or a snapshot
   * of a machine you set up by hand (a harness logged in to your own
   * subscription included). The default image has Node and Python. */
  from?: { image: string } | { snapshot: string };
  /** 1, 2, 4, 8 or 16; default 4. */
  vcpu?: number;
  /** 512 to 65536, a multiple of 256; default 8192 (8 GiB). */
  memoryMiB?: number;
  /** The agent's standing words, at most 64 KiB. */
  instructions?: string;
  /** Settings the harness sees; never a secret. */
  env?: Record<string, string>;
  /** Names of your egress secrets the sandbox may use: it sees a placeholder,
   * and the egress proxy adds the value toward the secret's hosts. Model
   * keys of any provider go here (ANTHROPIC_API_KEY, OPENAI_API_KEY,
   * GEMINI_API_KEY, OPENROUTER_API_KEY, or an OpenAI-compatible endpoint's
   * key with env.OPENAI_BASE_URL). */
  secrets?: string[];
  /** MCP servers the harness may reach. */
  mcp?: { name: string; url: string }[];
  volumes?: { volume: string; path: string }[];
  /** How long a session's sandbox runs with nothing happening before it
   * pauses; default 60. */
  idlePauseSeconds?: number;
  /** A session's longest life; default 86400. */
  maxSessionSeconds?: number;
  /** Sessions running at once; more wait, queued. Default 10. */
  maxConcurrent?: number;
  /** The use it was set up for (`uses`). */
  template?: "support" | "team";
};
export type Agent = {
  id: string;
  name: string;
  version: number;
  /** With its defaults written in. */
  definition: AgentDefinition;
  labels: Record<string, string>;
  /** `subscription_for_customers`: its secrets name CLAUDE_CODE_OAUTH_TOKEN
   * and it is set up to answer your customers (`template: "support"`). A
   * subscription is for your own team's agents; an agent that serves your
   * customers uses an API key. */
  warnings: "subscription_for_customers"[];
  createdAt: string;
  updatedAt: string;
};
export type AgentSessionState = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
/** One session. Subagents' parentSessionId and rootSessionId, its cost and
 * treeCost, historyBytes and attachmentBytes join it as the API gains
 * them. */
export type AgentSession = {
  id: string;
  agentId: string;
  agentVersion: number;
  key: string | null;
  trigger: "api" | AgentTriggerKind;
  state: AgentSessionState;
  /** Why it ended. */
  reason: string | null;
  /** What the agent said it ended with: a pull request's address, an answer. */
  result: string | null;
  sandboxId: string | null;
  lastSeq: number;
  labels: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};
export type AgentEvent = {
  seq: number;
  kind: "input" | "answer" | "reply" | "ask" | "status" | "result" | "error" | "note";
  /** A key's principal id, slack:<user>, github:<login>, agent (the
   * harness) or runtime. */
  actor: string;
  /** Words are body.text. */
  body: { text?: string } & Record<string, unknown>;
  createdAt: string;
};
export type AgentTriggerKind = "slack" | "github" | "schedule" | "webhook";
export type AgentTrigger = {
  id: string;
  agentId: string;
  kind: AgentTriggerKind;
  config: Record<string, unknown>;
  pausedAt: string | null;
  pausedWhy: string | null;
  createdAt: string;
  /** A webhook's secret, which each of its calls carries: answered once,
   * when it is added, and never again. Keep it where you keep your keys. */
  secret?: string;
};
export type CreateAgent = {
  name: string;
  definition: AgentDefinition;
  labels?: Record<string, string>;
};
export type StartAgentSession = {
  input: string;
  /** Words with the same key join its open session: a Slack thread, a pull
   * request, one of your customers (`customer:42`). */
  key?: string;
  labels?: Record<string, string>;
};
export type CreateAgentTrigger =
  | { kind: "slack"; config: { team: string; channel: string } }
  | { kind: "github"; config: { installation: number; repository: string; events?: string[] } }
  | { kind: "schedule"; config: { cron: string; timezone?: string; input: string } }
  | { kind: "webhook"; config: Record<string, never> };

/** The five harnesses' names, so `templates["claude-code"]` is known to be there. */
export type AgentTemplateKey =
  "claude-code" | "codex" | "gemini-cli" | "claude-agent-sdk" | "openai-agents-sdk";
/** A harness, as data (packages/cloud-guide/agent-templates.json, the same
 * in every SDK and the guide). `definition` is what an agent's definition
 * takes from it; add a use's (`uses`) and your instructions. */
export type AgentTemplate = {
  key: AgentTemplateKey;
  title: string;
  command: string;
  /** The egress secret its API key is stored as, and the host it is for. */
  apiKeySecret: string;
  apiKeyHost: string;
  /** How your own subscription logs it in, for your own team's agents, or
   * null when it takes an API key alone. */
  subscription: string | null;
  definition: { command: string; secrets: string[] };
};
/** A use: what an agent is for, merged into a template's definition. */
export type AgentUse = {
  key: "support" | "team";
  title: string;
  /** How its sessions are keyed: the key your app passes per customer, or
   * none. */
  sessionKey: string | null;
  triggers: ("api" | AgentTriggerKind)[];
  definition: Partial<AgentDefinition> & { template: "support" | "team" };
};

const START =
  'npx -y @anthropic-ai/claude-code --dangerously-skip-permissions --mcp-config ~/.runtime-agent/mcp.json -p "$(cat ~/.runtime-agent/start.md)"';
const CODEX =
  'npx -y @openai/codex exec --dangerously-bypass-approvals-and-sandbox "$(cat ~/.runtime-agent/start.md)"';
const GEMINI = 'npx -y @google/gemini-cli --yolo -p "$(cat ~/.runtime-agent/start.md)"';

/** The five harnesses (agents-contract.md); tests/agents.test.ts holds them
 * to packages/cloud-guide/agent-templates.json. */
export const AGENT_TEMPLATES: Readonly<Record<AgentTemplateKey, AgentTemplate>> = {
  "claude-code": {
    key: "claude-code",
    title: "Claude Code",
    command: START,
    apiKeySecret: "ANTHROPIC_API_KEY",
    apiKeyHost: "api.anthropic.com",
    subscription:
      "token: run `claude setup-token` on your own computer (Pro/Max), then `runtime secrets set CLAUDE_CODE_OAUTH_TOKEN` scoped to api.anthropic.com",
    definition: { command: START, secrets: ["ANTHROPIC_API_KEY"] },
  },
  codex: {
    key: "codex",
    title: "Codex CLI",
    command: CODEX,
    apiKeySecret: "OPENAI_API_KEY",
    apiKeyHost: "api.openai.com",
    subscription:
      "login once in the sandbox's terminal: `npx -y @openai/codex login --device-auth`, kept in the snapshot or a volume at `~/.codex`",
    definition: { command: CODEX, secrets: ["OPENAI_API_KEY"] },
  },
  "gemini-cli": {
    key: "gemini-cli",
    title: "Gemini CLI",
    command: GEMINI,
    apiKeySecret: "GEMINI_API_KEY",
    apiKeyHost: "generativelanguage.googleapis.com",
    subscription: "login once in the sandbox's terminal (Sign in with Google), kept at `~/.gemini`",
    definition: { command: GEMINI, secrets: ["GEMINI_API_KEY"] },
  },
  "claude-agent-sdk": {
    key: "claude-agent-sdk",
    title: "Claude Agent SDK",
    command: "python3 ~/agent.py",
    apiKeySecret: "ANTHROPIC_API_KEY",
    apiKeyHost: "api.anthropic.com",
    subscription: null,
    definition: { command: "python3 ~/agent.py", secrets: ["ANTHROPIC_API_KEY"] },
  },
  "openai-agents-sdk": {
    key: "openai-agents-sdk",
    title: "OpenAI Agents SDK",
    command: "python3 ~/agent.py",
    apiKeySecret: "OPENAI_API_KEY",
    apiKeyHost: "api.openai.com",
    subscription: null,
    definition: { command: "python3 ~/agent.py", secrets: ["OPENAI_API_KEY"] },
  },
};
export const AGENT_USES: Readonly<Record<"support" | "team", AgentUse>> = {
  support: {
    key: "support",
    title: "Your customers",
    sessionKey: "customer:<id>",
    triggers: ["api", "webhook"],
    definition: {
      template: "support",
      vcpu: 1,
      memoryMiB: 1024,
      idlePauseSeconds: 10,
      maxConcurrent: 1000,
    },
  },
  team: {
    key: "team",
    title: "Your team",
    sessionKey: null,
    triggers: ["slack", "github"],
    definition: { template: "team", vcpu: 4, memoryMiB: 8192 },
  },
};

const enc = encodeURIComponent;
const ENDED: readonly AgentSessionState[] = ["done", "failed", "stopped"];
type Wire<T> = { data: T[]; nextCursor: string | null };

/** One session, to talk to and follow. */
export type AgentSessionHandle = {
  readonly id: string;
  /** The session as it was when started or read. */
  readonly session: AgentSession;
  /** Whether the start's words joined a session already open with its key. */
  readonly joined: boolean;
  /** The seq of the words that started or joined it. */
  readonly seq: number;
  /** Words in; answers their seq. */
  send(text: string, options?: RequestOptions): Promise<{ seq: number }>;
  /** Its log after `after` (0 by default), each event as it comes, waiting
   * up to 30 seconds a call; ends when the session has ended. */
  events(options?: { after?: number; signal?: AbortSignal }): AsyncGenerator<AgentEvent>;
  stop(options?: RequestOptions): Promise<AgentSession>;
  /** Until it has ended; answers it then. */
  wait(options?: { signal?: AbortSignal }): Promise<AgentSession>;
  get(options?: RequestOptions): Promise<AgentSession>;
};

export function agents(t: Transport) {
  const getSession = (id: string, options?: RequestOptions) =>
    t.json<AgentSession>({ method: "GET", path: `/v1/agents/sessions/${enc(id)}`, ...options });
  async function* events(
    id: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentEvent> {
    let after = options.after ?? 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const read = await t.json<{ data: AgentEvent[]; ended: boolean }>({
        method: "GET",
        path: `/v1/agents/sessions/${enc(id)}/events`,
        query: { after, wait: 30 },
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: 0,
      });
      for (const event of read.data) {
        after = event.seq;
        yield event;
      }
      if (read.ended) return;
    }
  }
  const handle = (
    session: AgentSession,
    joined = false,
    seq = session.lastSeq,
  ): AgentSessionHandle => ({
    id: session.id,
    session,
    joined,
    seq,
    send: (text, options) =>
      t.json<{ seq: number }>({
        method: "POST",
        path: `/v1/agents/sessions/${enc(session.id)}/messages`,
        body: { text },
        ...options,
      }),
    events: (options) => events(session.id, options),
    stop: (options) =>
      t.json<AgentSession>({
        method: "POST",
        path: `/v1/agents/sessions/${enc(session.id)}/stop`,
        body: {},
        ...options,
      }),
    async wait(options = {}) {
      const now = await getSession(session.id, options);
      if (ENDED.includes(now.state)) return now;
      for await (const _ of events(session.id, { after: now.lastSeq, ...options }));
      return getSession(session.id, options);
    },
    get: (options) => getSession(session.id, options),
  });
  const list = async (
    query: { cursor?: string; limit?: number } = {},
    options?: RequestOptions,
  ): Promise<Page<Agent>> => {
    const page = await t.json<Wire<Agent>>({
      method: "GET",
      path: "/v1/agents",
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  const listSessions = async (
    query: { agent?: string; state?: AgentSessionState[]; cursor?: string; limit?: number } = {},
    options?: RequestOptions,
  ): Promise<Page<AgentSession>> => {
    const page = await t.json<Wire<AgentSession>>({
      method: "GET",
      path: "/v1/agents/sessions",
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) =>
      listSessions({ ...query, cursor }, options),
    );
  };
  return {
    /** An agent: a name and a definition its sessions start from. */
    create: (input: CreateAgent, options?: RequestOptions) =>
      t.json<Agent>({ method: "POST", path: "/v1/agents", body: input, ...options }),
    /** By its id or its name. */
    get: (agent: string, options?: RequestOptions) =>
      t.json<Agent>({ method: "GET", path: `/v1/agents/${enc(agent)}`, ...options }),
    /** Your agents, oldest first. Await for a page, or `for await` for all. */
    list,
    /** A new version of the definition, whole; sessions already started keep theirs. */
    update: (agent: string, definition: AgentDefinition, options?: RequestOptions) =>
      t.json<Agent>({
        method: "PATCH",
        path: `/v1/agents/${enc(agent)}`,
        body: { definition },
        ...options,
      }),
    /** Its triggers go and its open sessions stop. */
    delete: async (agent: string, options?: RequestOptions): Promise<void> => {
      await t.json<null>({ method: "DELETE", path: `/v1/agents/${enc(agent)}`, ...options });
    },
    /** A session with its first words, or the open one with the same key joined. */
    async start(
      agent: string,
      input: StartAgentSession,
      options?: RequestOptions,
    ): Promise<AgentSessionHandle> {
      const out = await t.json<{ session: AgentSession; joined: boolean; seq: number }>({
        method: "POST",
        path: `/v1/agents/${enc(agent)}/sessions`,
        body: input,
        ...options,
      });
      return handle(out.session, out.joined, out.seq);
    },
    /** A session you already have, by its id. */
    async session(id: string, options?: RequestOptions): Promise<AgentSessionHandle> {
      return handle(await getSession(id, options));
    },
    sessions: {
      get: getSession,
      /** Newest first; of one agent, or in some states. */
      list: listSessions,
      /** An ended session and its log go. Its history is storage like any
       * other, kept until you delete it; an open session is refused
       * (`session_open`): stop it first. */
      delete: async (id: string, options?: RequestOptions): Promise<void> => {
        await t.json<null>({
          method: "DELETE",
          path: `/v1/agents/sessions/${enc(id)}`,
          ...options,
        });
      },
    },
    triggers: {
      create: (agent: string, input: CreateAgentTrigger, options?: RequestOptions) =>
        t.json<AgentTrigger>({
          method: "POST",
          path: `/v1/agents/${enc(agent)}/triggers`,
          body: input,
          ...options,
        }),
      list: async (agent: string, options?: RequestOptions) =>
        (
          await t.json<{ data: AgentTrigger[] }>({
            method: "GET",
            path: `/v1/agents/${enc(agent)}/triggers`,
            ...options,
          })
        ).data,
      /** Its events are refused, saying `why`; nothing else is held. */
      pause: (id: string, why: string, options?: RequestOptions) =>
        t.json<AgentTrigger>({
          method: "POST",
          path: `/v1/agents/triggers/${enc(id)}/pause`,
          body: { why },
          ...options,
        }),
      resume: (id: string, options?: RequestOptions) =>
        t.json<AgentTrigger>({
          method: "POST",
          path: `/v1/agents/triggers/${enc(id)}/resume`,
          body: {},
          ...options,
        }),
      delete: async (id: string, options?: RequestOptions): Promise<void> => {
        await t.json<null>({
          method: "DELETE",
          path: `/v1/agents/triggers/${enc(id)}`,
          ...options,
        });
      },
    },
    /** The harnesses, as data: claude-code, codex, gemini-cli,
     * claude-agent-sdk, openai-agents-sdk. */
    templates: AGENT_TEMPLATES,
    /** The uses, as data: support (your customers) and team (your team). */
    uses: AGENT_USES,
  };
}
