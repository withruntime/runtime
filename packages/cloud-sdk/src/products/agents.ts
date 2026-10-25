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
  /** Where each session's sandbox starts: an image of yours; a snapshot of
   * a machine you set up by hand (a harness logged in to your own
   * subscription included); or a GitHub repository connected to CI/CD,
   * `owner/name`, whose warm snapshot (checked out at /workspace/repo at its
   * production branch's last passing commit, set up) each session starts
   * as a copy of, its harness run there. The default image has Node and
   * Python. */
  from?: { image: string } | { snapshot: string } | { repo: string };
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
  /** Claude accounts, 1 to 16 egress secrets' names: subscription tokens,
   * or API keys for a name holding API_KEY. Each session takes the one with
   * the most usage left; the review template moves to the next when one is
   * out of usage, and waits for the soonest reset when all are. */
  pool?: string[];
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
  /** What one session may cost, its subagents' sessions included, in
   * dollars; it stops with reason `budget` there. Default 5. */
  maxSessionDollars?: number;
  /** What the agent's sessions may cost in a day, in dollars; past it the
   * agent starts nothing new (`budget_reached`) until the next. Default 100. */
  maxDayDollars?: number;
  /** The use it was set up for (`uses`). */
  template?: "support" | "team";
  /** Whose memory a session reads: `key` (the default), each session key
   * its own; `agent`, one all its sessions share, never a support agent's. */
  memory?: { scope: "key" | "agent" };
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
export type AgentAskState = "open" | "answered" | "expired" | "withdrawn" | "closed";
/** One row of the account's inbox: a question a session's harness needs
 * answered to go on. Asks of one agent's sessions sharing a memory, with the same `step` are
 * one row while it is open, and one answer reaches every session asking. */
export type AgentAsk = {
  id: string;
  /** The agent of the session that asked first. */
  agentId: string;
  /** What it waits on, in the asker's words. */
  step: string | null;
  question: string;
  /** Why it matters. */
  why: string | null;
  options: { label: string; detail?: string }[];
  /** The recommended option's label; taken as the answer when it expires. */
  pick: string | null;
  /** Who sees it: its agent's labels with the ask's own over them. */
  labels: Record<string, string>;
  state: AgentAskState;
  /** An option's label and/or words; `expired` when the pick was taken at
   * expiry. */
  answer: { option?: string; text?: string; expired?: boolean } | null;
  /** A key's principal id, or `runtime` for a pick taken at expiry. */
  answeredBy: string | null;
  /** The sessions asking it, each with its ask event's seq and the answer
   * event that woke it. */
  sessions: {
    sessionId: string;
    state: "asking" | "answered" | "expired" | "withdrawn" | "ended";
    seq: number;
    answerSeq: number | null;
  }[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};
export type ListAgentAsks = {
  /** Open by default. */
  state?: AgentAskState[];
  agent?: string;
  /** Asks carrying every one of these labels: who sees an ask. */
  labels?: Record<string, string>;
  cursor?: string;
  limit?: number;
};
/** An option's label, words, or both. */
export type AnswerAgentAsk = { option?: string; text?: string };
export type AgentTriggerKind = "slack" | "github" | "schedule" | "webhook";
/** A trigger's rules, each optional. */
export type AgentTriggerRules = {
  /** Queue order of its sessions when the agent's maxConcurrent is full:
   * -100 to 100, higher first, then oldest. Default 0. */
  priority?: number;
  /** Sessions it may start in an hour; a call past it is held for you.
   * Joining an open session is never capped. Default none. */
  maxStartsPerHour?: number;
  /** A call whose key's last session has ended: "start" a new one (the
   * default), "note" it in the ended session's log and run nothing, or
   * "ask" you (the call is held until you start it). */
  onEnded?: "start" | "note" | "ask";
  /** Where a held call is told: "email" to who added the trigger (the
   * default), or "webhook", the account's webhooks' agent.call.held alone. */
  notify?: "email" | "webhook";
  /** A webhook's only: the key of a call that sends none, from its JSON's
   * fields: "{cause}", "{alert.host}:{check}". */
  key?: string;
};
export type AgentTrigger = {
  id: string;
  agentId: string;
  kind: AgentTriggerKind;
  config: Record<string, unknown>;
  rules: AgentTriggerRules;
  pausedAt: string | null;
  pausedWhy: string | null;
  createdAt: string;
  /** When it last changed: made, paused or resumed. */
  updatedAt: string;
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
export type CreateAgentTrigger = (
  | { kind: "slack"; config: { team: string; channel: string } }
  | { kind: "github"; config: { installation: number; repository: string; events?: string[] } }
  | { kind: "schedule"; config: { cron: string; timezone?: string; input: string } }
  | { kind: "webhook"; config: Record<string, never> }
) & { rules?: AgentTriggerRules };
/** One call to a webhook trigger: its words, and the key and labels of the
 * session it starts or joins. */
export type AgentTriggerCall = {
  text: string;
  key?: string;
  labels?: Record<string, string>;
};
/** What a call did: started a session, joined its key's open one, was
 * noted in its key's ended one, or was held for you (`why`). */
export type AgentTriggerCallOutcome = {
  outcome: "started" | "joined" | "noted" | "held";
  sessionId: string | null;
  seq: number | null;
  callId: string | null;
  why: AgentHeldCall["why"] | null;
  replayed: boolean;
};
/** A call a trigger held for you because no session could take it. None is
 * ever dropped. */
export type AgentHeldCall = {
  id: string;
  triggerId: string;
  agentId: string;
  key: string | null;
  text: string;
  labels: Record<string, string>;
  /** The trigger was paused; it had started maxStartsPerHour sessions this
   * hour; its key's session had ended and onEnded is "ask"; the agent's day
   * budget was spent; the account's sessions were at their limit; Agents
   * was closed to the account. */
  why: "paused" | "rate" | "ended" | "budget" | "quota" | "closed";
  state: "held" | "started" | "dismissed";
  sessionId: string | null;
  notify: "email" | "webhook";
  createdAt: string;
  resolvedAt: string | null;
};

/** The harnesses' names, so `templates["claude-code"]` is known to be there. */
export type AgentTemplateKey =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "claude-agent-sdk"
  | "openai-agents-sdk"
  | "review"
  | "judge";

/** A file of an agent's memory (`memory.list`). `scope` is whose: empty for
 * the shared memory, which every session reads (one keeping memory per key
 * reads what you wrote there, and never changes it), or a session key
 * (`customer:42`) for that key's alone. */
export type AgentMemoryEntry = {
  scope: string;
  path: string;
  /** Its text and path, in bytes, as billed. */
  bytes: number;
  updatedAt: string;
  /** A key's principal id, or session:<id> when the agent wrote it. */
  updatedBy: string;
};
export type AgentMemoryFile = AgentMemoryEntry & { content: string };
export type AgentMemoryHit = {
  scope: string;
  path: string;
  /** Its words around the match, matches in **bold**. */
  snippet: string;
  /** Higher is better. */
  rank: number;
  bytes: number;
  updatedAt: string;
};
export type AgentMemoryWritten = {
  scope: string;
  path: string;
  bytes: number;
  /** True for a new file, false for one replaced. */
  created: boolean;
  updatedAt: string;
};
/** The agent's whole memory, every scope: what storage is billed on. */
export type AgentMemoryUsage = {
  bytes: number;
  files: number;
  limitBytes: number;
  limitFiles: number;
};
export type AgentMemoryPage = Page<AgentMemoryEntry> & { readonly usage: AgentMemoryUsage };

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
  definition: Pick<
    AgentDefinition,
    "secrets" | "pool" | "vcpu" | "memoryMiB" | "maxSessionSeconds"
  > & { command: string };
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
const REVIEW = "python3 ~/.runtime-agent/runtime-agent review";
const JUDGE = "python3 ~/.runtime-agent/runtime-agent judge";

/** The harnesses (agents-contract.md); tests/agents.test.ts holds them
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
  review: {
    key: "review",
    title: "Code review",
    command: REVIEW,
    apiKeySecret: "ANTHROPIC_API_KEY",
    apiKeyHost: "api.anthropic.com",
    subscription:
      "a token per account: run `claude setup-token` on your own computer (Pro/Max) for each, store each with `runtime secrets set CLAUDE_1` scoped to api.anthropic.com, then name them all in pool (--pool CLAUDE_1 --pool CLAUDE_2)",
    definition: {
      command: REVIEW,
      pool: ["ANTHROPIC_API_KEY"],
      vcpu: 2,
      memoryMiB: 2048,
      maxSessionSeconds: 1800,
    },
  },
  judge: {
    key: "judge",
    title: "Your rules",
    command: JUDGE,
    apiKeySecret: "ANTHROPIC_API_KEY",
    apiKeyHost: "api.anthropic.com",
    subscription:
      "a token per account, as for review: `runtime secrets set CLAUDE_1` scoped to api.anthropic.com for each, then name them all in pool; its instructions are the rules that block",
    definition: {
      command: JUDGE,
      pool: ["ANTHROPIC_API_KEY"],
      vcpu: 2,
      memoryMiB: 2048,
      maxSessionSeconds: 1800,
    },
  },
};

/** A harness by a key read from a file or a flag, or undefined. */
export function agentTemplate(key: string): AgentTemplate | undefined {
  return Object.hasOwn(AGENT_TEMPLATES, key) ? AGENT_TEMPLATES[key as AgentTemplateKey] : undefined;
}
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
  const listAsks = async (
    query: ListAgentAsks = {},
    options?: RequestOptions,
  ): Promise<Page<AgentAsk>> => {
    const { labels, ...rest } = query;
    const page = await t.json<Wire<AgentAsk>>({
      method: "GET",
      path: "/v1/agents/asks",
      query: {
        ...rest,
        ...(labels ? { label: Object.entries(labels).map(([k, v]) => `${k}:${v}`) } : {}),
      },
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) =>
      listAsks({ ...query, cursor }, options),
    );
  };
  const listHeld = async (
    trigger: string,
    query: { state?: AgentHeldCall["state"][]; cursor?: string; limit?: number } = {},
    options?: RequestOptions,
  ): Promise<Page<AgentHeldCall>> => {
    const page = await t.json<Wire<AgentHeldCall>>({
      method: "GET",
      path: `/v1/agents/triggers/${enc(trigger)}/held`,
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) =>
      listHeld(trigger, { ...query, cursor }, options),
    );
  };
  const listMemory = async (
    agent: string,
    query: { scope?: string; prefix?: string; cursor?: string; limit?: number } = {},
    options?: RequestOptions,
  ): Promise<AgentMemoryPage> => {
    const page = await t.json<Wire<AgentMemoryEntry> & { usage: AgentMemoryUsage }>({
      method: "GET",
      path: `/v1/agents/${enc(agent)}/memory`,
      query,
      ...options,
    });
    return Object.assign(
      new Page(page.data, page.nextCursor, (cursor) =>
        listMemory(agent, { ...query, cursor }, options),
      ),
      { usage: page.usage },
    );
  };
  const memoryFile = (
    method: "GET" | "PUT" | "DELETE",
    agent: string,
    path: string,
    scope = "",
  ) => ({
    method,
    path: `/v1/agents/${enc(agent)}/memory/content`,
    query: { scope, path },
  });
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
    /** The account's inbox: the questions its agents' sessions need answered
     * to go on, one row per step however many sessions ask it. */
    asks: {
      /** Newest first; open ones unless `state` says otherwise. */
      list: listAsks,
      get: (id: string, options?: RequestOptions) =>
        t.json<AgentAsk>({ method: "GET", path: `/v1/agents/asks/${enc(id)}`, ...options }),
      /** Every session asking it reads the answer next, and wakes. An ask no
       * longer open is refused with `ask_closed`. */
      answer: (id: string, answer: AnswerAgentAsk, options?: RequestOptions) =>
        t.json<AgentAsk>({
          method: "POST",
          path: `/v1/agents/asks/${enc(id)}/answer`,
          body: answer,
          ...options,
        }),
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
      /** Held: a webhook's calls are kept for you (see `held`), saying
       * `why`; nothing else is held. */
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
      /** Its rules, whole, in place: its secret stays. `{}` is every default. */
      setRules: (id: string, rules: AgentTriggerRules, options?: RequestOptions) =>
        t.json<AgentTrigger>({
          method: "PATCH",
          path: `/v1/agents/triggers/${enc(id)}`,
          body: { rules },
          ...options,
        }),
      /** A webhook trigger's call, as its sender makes it: by the trigger's
       * secret, never your key. A call with the key of an open session joins
       * it. Pass `idempotencyKey` to make a retry the same call. */
      call: (id: string, secret: string, call: AgentTriggerCall, options?: RequestOptions) =>
        t.json<AgentTriggerCallOutcome>({
          method: "POST",
          path: `/v1/agents/triggers/${enc(id)}/calls`,
          body: call,
          bearer: secret,
          ...options,
        }),
      /** Calls it held for you, newest first. */
      held: listHeld,
      /** Start a held call: one session with it and every call held for its
       * key since, oldest first. */
      startHeld: (id: string, call: string, options?: RequestOptions) =>
        t.json<{ session: AgentSession; joined: boolean; calls: number }>({
          method: "POST",
          path: `/v1/agents/triggers/${enc(id)}/held/${enc(call)}/start`,
          body: {},
          ...options,
        }),
      /** Dismiss a held call: nothing runs. */
      dismissHeld: (id: string, call: string, options?: RequestOptions) =>
        t.json<AgentHeldCall>({
          method: "POST",
          path: `/v1/agents/triggers/${enc(id)}/held/${enc(call)}/dismiss`,
          body: {},
          ...options,
        }),
    },
    /** Its built-in memory: text files kept across sessions, which the
     * agent reads, writes and searches from inside its sessions. A scope is
     * whose: "" (the default) for what every session reads, or a session key
     * ("customer:42") for that key's alone. Up to 1 MiB a file, 1 GiB and
     * 100,000 files an agent, billed as storage. */
    memory: {
      /** Its files by scope and path, a page at a time, with its usage.
       * Without scope, every scope. */
      list: listMemory,
      /** The files whose words or paths match, best first, each with a
       * snippet: words, "a phrase", or, -not. Without scope, every scope. */
      search: async (
        agent: string,
        q: string,
        query: { scope?: string; limit?: number } = {},
        options?: RequestOptions,
      ): Promise<AgentMemoryHit[]> =>
        (
          await t.json<{ data: AgentMemoryHit[] }>({
            method: "GET",
            path: `/v1/agents/${enc(agent)}/memory`,
            query: { ...query, q },
            ...options,
          })
        ).data,
      /** One file, with its text; not_found when there is none. */
      read: (
        agent: string,
        path: string,
        query: { scope?: string } = {},
        options?: RequestOptions,
      ) => t.json<AgentMemoryFile>({ ...memoryFile("GET", agent, path, query.scope), ...options }),
      /** Seeds or replaces a file. */
      write: (
        agent: string,
        path: string,
        content: string,
        query: { scope?: string } = {},
        options?: RequestOptions,
      ) =>
        t.json<AgentMemoryWritten>({
          ...memoryFile("PUT", agent, path, query.scope),
          body: { content },
          ...options,
        }),
      /** Answers whether there was a file. */
      delete: async (
        agent: string,
        path: string,
        query: { scope?: string } = {},
        options?: RequestOptions,
      ): Promise<boolean> =>
        (
          await t.json<{ deleted: boolean }>({
            ...memoryFile("DELETE", agent, path, query.scope),
            ...options,
          })
        ).deleted,
    },
    /** The harnesses, as data: claude-code, codex, gemini-cli,
     * claude-agent-sdk, openai-agents-sdk, review (a CI/CD agent step's
     * reviewer) and judge (an agent step held to your instructions alone). */
    templates: AGENT_TEMPLATES,
    /** The uses, as data: support (your customers) and team (your team). */
    uses: AGENT_USES,
  };
}
