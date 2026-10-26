import { expect, test } from "bun:test";
import { run } from "../src/cli";

/* `runtime agents` against a stub API: what each command sends and what a
   person and a script read. A template and a use fill the definition; an
   update keeps what it is not told to change; start --follow prints the log
   until the session ends; a subscription serving customers is warned of. */

const AGENT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const agent = (definition: Record<string, unknown>, warnings: string[] = []) => ({
  id: AGENT,
  name: "helper",
  version: 1,
  definition: { vcpu: 4, memoryMiB: 8192, ...definition },
  labels: {},
  warnings,
  createdAt: "2025-10-09T08:53:20.000Z",
  updatedAt: "2025-10-09T08:53:20.000Z",
});
const session = (state = "queued", lastSeq = 1) => ({
  id: SESSION,
  agentId: AGENT,
  agentVersion: 1,
  key: "customer:42",
  trigger: "api",
  state,
  reason: null,
  result: null,
  sandboxId: null,
  lastSeq,
  labels: {},
  createdAt: "2025-10-09T08:53:20.000Z",
  startedAt: null,
  endedAt: null,
});

type Sent = { method: string; path: string; query: URLSearchParams; body: unknown };
async function withStub(
  routes: (sent: Sent) => unknown,
  work: (lines: string[], sent: Sent[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const call = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body: text ? JSON.parse(text) : undefined,
    };
    sent.push(call);
    const answer = await routes(call);
    if (answer === undefined)
      return Response.json(
        { error: { code: "route_not_found", message: url.pathname } },
        { status: 404 },
      );
    return Response.json(answer);
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    await work(lines, sent);
  } finally {
    globalThis.fetch = original;
  }
}
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const out = (lines: string[], json = false) => ({
  json,
  write: (t: string) => lines.push(t),
  error: (t: string) => lines.push(`ERR ${t}`),
});

test("the help lists agents, and it has its own", async () => {
  const lines: string[] = [];
  expect(await run(["help"], env, out(lines))).toBe(0);
  expect(lines.join("\n")).toMatch(/^ {2}agents /m);
  const own: string[] = [];
  expect(await run(["agents", "help"], env, out(own))).toBe(0);
  expect(own[0]).toStartWith("runtime agents <command>");
  expect(own[0]).toContain("A subscription is for your own team's agents");
});

test("create fills the definition from a template and a use, and warns of a subscription serving customers", async () => {
  await withStub(
    ({ method, path, body }) =>
      method === "POST" && path === "/v1/agents"
        ? agent((body as { definition: Record<string, unknown> }).definition, [
            "subscription_for_customers",
          ])
        : undefined,
    async (lines, sent) => {
      const code = await run(
        [
          "agents",
          "create",
          "helper",
          "--template",
          "claude-code",
          "--use",
          "support",
          "--secret",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "--instructions",
          "Answer briefly.",
        ],
        env,
        out(lines),
      );
      expect(code).toBe(0);
      const body = sent[0]!.body as { name: string; definition: Record<string, unknown> };
      expect(body.name).toBe("helper");
      expect(body.definition).toMatchObject({
        template: "support",
        vcpu: 1,
        memoryMiB: 1024,
        idlePauseSeconds: 10,
        maxConcurrent: 1000,
        instructions: "Answer briefly.",
        secrets: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      });
      expect(String(body.definition.command)).toStartWith("npx -y @anthropic-ai/claude-code");
      expect(lines.some((l) => l.startsWith("ERR Warning:"))).toBe(true);
      expect(lines.at(-1)).toBe(AGENT);
    },
  );
  await expect(run(["agents", "create", "x"], env, out([]))).rejects.toThrow("Give --template");
});

test("create makes a reviewer from the review template, its pool the accounts given", async () => {
  await withStub(
    ({ method, path, body }) =>
      method === "POST" && path === "/v1/agents"
        ? agent((body as { definition: Record<string, unknown> }).definition)
        : undefined,
    async (lines, sent) => {
      const code = await run(
        [
          "agents",
          "create",
          "ci-review",
          "--template",
          "review",
          "--pool",
          "CLAUDE_1",
          "--pool",
          "CLAUDE_2",
          "--pool",
          "CLAUDE_1",
        ],
        env,
        out(lines),
      );
      expect(code).toBe(0);
      const body = sent[0]!.body as { definition: Record<string, unknown> };
      expect(body.definition).toEqual({
        command: "python3 ~/.runtime-agent/runtime-agent review",
        pool: ["CLAUDE_1", "CLAUDE_2"],
        vcpu: 2,
        memoryMiB: 2048,
        maxSessionSeconds: 1800,
      });
    },
  );
});

test("update keeps what it is not told to change", async () => {
  await withStub(
    ({ method, path, body }) => {
      if (method === "GET" && path === "/v1/agents/helper")
        return agent({ command: "claude", instructions: "old" });
      if (method === "PATCH" && path === `/v1/agents/${AGENT}`)
        return {
          ...agent((body as { definition: Record<string, unknown> }).definition),
          version: 2,
        };
    },
    async (lines, sent) => {
      expect(await run(["agents", "update", "helper", "--vcpu", "8"], env, out(lines))).toBe(0);
      expect(sent[1]!.body).toEqual({
        definition: { command: "claude", instructions: "old", vcpu: 8, memoryMiB: 8192 },
      });
      expect(lines.at(-1)).toBe("helper is now version 2.");
    },
  );
});

test("start --follow prints the log until the session ends", async () => {
  let polls = 0;
  await withStub(
    ({ method, path }) => {
      if (method === "POST" && path === "/v1/agents/helper/sessions")
        return { session: session(), joined: false, seq: 1 };
      if (method === "GET" && path === `/v1/agents/sessions/${SESSION}`) return session();
      if (method === "GET" && path === `/v1/agents/sessions/${SESSION}/events`)
        return polls++ === 0
          ? {
              data: [
                {
                  seq: 1,
                  kind: "input",
                  actor: "key_42",
                  body: { text: "hi" },
                  createdAt: "2025-10-09T08:53:20.000Z",
                },
              ],
              ended: false,
            }
          : {
              data: [
                {
                  seq: 2,
                  kind: "reply",
                  actor: "agent",
                  body: { text: "hello" },
                  createdAt: "2025-10-09T08:53:20.000Z",
                },
              ],
              ended: true,
            };
    },
    async (lines, sent) => {
      expect(
        await run(
          ["agents", "start", "helper", "hi", "--key", "customer:42", "--follow"],
          env,
          out(lines),
        ),
      ).toBe(0);
      expect(sent[0]!.body).toEqual({ input: "hi", key: "customer:42" });
      expect(lines.filter((l) => !l.startsWith("ERR"))).toEqual([
        "   1 input  key_42: hi",
        "   2 reply  agent: hello",
      ]);
      expect(
        sent.filter((s) => s.path.endsWith("/events")).map((s) => s.query.get("wait")),
      ).toEqual(["30", "30"]);
    },
  );
});

test("triggers add, pause and list send what the API takes", async () => {
  const trigger = {
    id: "t1",
    agentId: AGENT,
    kind: "schedule",
    config: { cron: "0 9 * * 1-5", input: "Triage new issues" },
    pausedAt: null,
    pausedWhy: null,
    createdAt: "2025-10-09T08:53:20.000Z",
  };
  await withStub(
    ({ method, path }) => {
      if (method === "POST" && path === "/v1/agents/helper/triggers") return trigger;
      if (method === "POST" && path === "/v1/agents/triggers/t1/pause")
        return { ...trigger, pausedAt: "2025-10-09T08:53:20.000Z", pausedWhy: "busy" };
      if (method === "GET" && path === "/v1/agents/helper/triggers") return { data: [trigger] };
    },
    async (lines, sent) => {
      await run(
        [
          "agents",
          "triggers",
          "add",
          "helper",
          "--kind",
          "schedule",
          "--config",
          '{"cron":"0 9 * * 1-5","input":"Triage new issues"}',
        ],
        env,
        out(lines),
      );
      await run(["agents", "triggers", "pause", "t1", "--why", "busy"], env, out(lines));
      await run(["agents", "triggers", "helper", "--json"], env, out(lines, true));
      expect(sent[0]!.body).toEqual({
        kind: "schedule",
        config: { cron: "0 9 * * 1-5", input: "Triage new issues" },
      });
      expect(sent[1]!.body).toEqual({ why: "busy" });
      expect(lines[0]).toBe("t1");
      expect(lines[1]).toBe("t1 paused: busy");
      expect(JSON.parse(lines[2]!)).toEqual([trigger]);
    },
  );
});

test("sessions delete removes an ended session and its log", async () => {
  await withStub(
    ({ method, path }) => {
      if (method === "DELETE" && path === `/v1/agents/sessions/${SESSION}`) return null;
    },
    async (lines, sent) => {
      expect(await run(["agents", "sessions", "delete", SESSION], env, out(lines))).toBe(0);
      expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
        `DELETE /v1/agents/sessions/${SESSION}`,
      ]);
      expect(lines.at(-1)).toBe(`${SESSION} deleted.`);
    },
  );
});

test("memory ls, search, cat, put and rm send what the API takes, the shared scope by default", async () => {
  const file = (path: string, scope = "") => ({
    scope,
    path,
    bytes: 12,
    updatedAt: "2025-10-09T08:53:20.000Z",
    updatedBy: "key_1",
  });
  const usage = { bytes: 24, files: 2, limitBytes: 1073741824, limitFiles: 100000 };
  await withStub(
    ({ method, path, query }) => {
      if (method === "GET" && path === "/v1/agents/helper/memory")
        return query.has("q")
          ? {
              data: [{ ...file("faq.md"), snippet: "our **refund**\npolicy", rank: 1 }],
              nextCursor: null,
            }
          : { data: [file("faq.md"), file("tone.md", "customer:42")], nextCursor: null, usage };
      if (method === "GET" && path === "/v1/agents/helper/memory/content")
        return { ...file("faq.md"), content: "Refunds within 30 days." };
      if (method === "PUT" && path === "/v1/agents/helper/memory/content")
        return {
          scope: query.get("scope"),
          path: query.get("path"),
          bytes: 12,
          created: true,
          updatedAt: "x",
        };
      if (method === "DELETE" && path === "/v1/agents/helper/memory/content")
        return { deleted: false };
    },
    async (lines, sent) => {
      await run(["agents", "memory", "ls", "helper"], env, out(lines));
      await run(["agents", "memory", "search", "helper", "refund", "policy"], env, out(lines));
      await run(["agents", "memory", "cat", "helper", "faq.md"], env, out(lines));
      await run(
        [
          "agents",
          "memory",
          "put",
          "helper",
          "tone.md",
          "--content",
          "Formal.",
          "--scope",
          "customer:42",
        ],
        env,
        out(lines),
      );
      await run(["agents", "memory", "rm", "helper", "old.md"], env, out(lines));
      expect(sent.map((s) => `${s.method} ${s.path} ${s.query.toString()}`)).toEqual([
        "GET /v1/agents/helper/memory limit=1000",
        "GET /v1/agents/helper/memory q=refund+policy",
        "GET /v1/agents/helper/memory/content scope=&path=faq.md",
        "PUT /v1/agents/helper/memory/content scope=customer%3A42&path=tone.md",
        "DELETE /v1/agents/helper/memory/content scope=&path=old.md",
      ]);
      expect(sent[3]!.body).toEqual({ content: "Formal." });
      expect(lines[0]).toContain("(shared)");
      expect(lines[0]).toContain("customer:42");
      expect(lines[0]).toContain("2 files, 24 bytes in all");
      expect(lines[1]).toContain("our **refund** policy");
      expect(lines[2]).toBe("Refunds within 30 days.");
      expect(lines[3]).toBe("Wrote tone.md in customer:42: 12 bytes.");
      expect(lines[4]).toBe("No old.md in (shared).");
    },
  );
  await expect(run(["agents", "memory", "search", "helper"], env, out([]))).rejects.toThrow(
    "Give the words",
  );
  await expect(run(["agents", "memory", "lsx"], env, out([]))).rejects.toThrow("Did you mean ls?");
  // A put with no text named never reads stdin: a CI step with nothing piped
  // in is told what to give, and no file is replaced with nothing.
  await expect(run(["agents", "memory", "put", "helper", "tone.md"], env, out([]))).rejects.toThrow(
    "- for stdin",
  );
});

const ASK = "33333333-3333-4333-8333-333333333333";
const inboxRow = (state = "open") => ({
  id: ASK,
  agentId: AGENT,
  step: "backup-bucket-cap",
  question: "Raise the backup bucket's cap?",
  why: "Backups stop at the cap tonight.",
  options: [{ label: "Raise to 20 TB", detail: "About $40 a month more." }, { label: "Keep it" }],
  pick: "Raise to 20 TB",
  labels: { team: "infra" },
  state,
  answer: state === "answered" ? { option: "Raise to 20 TB" } : null,
  answeredBy: null,
  sessions: [
    {
      sessionId: SESSION,
      state: state === "answered" ? "answered" : "asking",
      seq: 2,
      answerSeq: null,
    },
    {
      sessionId: AGENT,
      state: state === "answered" ? "answered" : "asking",
      seq: 3,
      answerSeq: null,
    },
  ],
  expiresAt: null,
  createdAt: "2025-10-09T08:53:20.000Z",
  updatedAt: "2025-10-09T08:53:20.000Z",
  closedAt: null,
});

test("asks lists the inbox, one row per step with its sessions, and answer sends the option and words", async () => {
  await withStub(
    ({ method, path }) => {
      if (method === "GET" && path === "/v1/agents/asks")
        return { data: [inboxRow()], nextCursor: null };
      if (method === "POST" && path === `/v1/agents/asks/${ASK}/answer`)
        return inboxRow("answered");
    },
    async (lines, sent) => {
      expect(
        await run(["agents", "asks", "--label", "team=infra", "--state", "open"], env, out(lines)),
      ).toBe(0);
      expect(sent[0]!.query.getAll("label")).toEqual(["team:infra"]);
      expect(sent[0]!.query.getAll("state")).toEqual(["open"]);
      expect(lines.at(-1)).toContain("step backup-bucket-cap, 2 sessions asking");
      expect(lines.at(-1)).toContain("options: Raise to 20 TB (pick) | Keep it");
      expect(
        await run(
          ["agents", "answer", ASK, "Raise", "to", "20", "TB", "--text", "Done."],
          env,
          out(lines),
        ),
      ).toBe(0);
      expect(sent.at(-1)!.body).toEqual({ option: "Raise to 20 TB", text: "Done." });
      expect(lines.at(-1)).toBe(`${ASK} answered; 2 session(s) woken.`);
      expect(run(["agents", "answer", ASK], env, out(lines))).rejects.toThrow(
        "Give an option's label, --text, or both",
      );
    },
  );
});

test("triggers rules, call, held, held start and dismiss send what the API takes; a call carries the secret, not the key", async () => {
  const hook = {
    id: "t2",
    agentId: AGENT,
    kind: "webhook",
    config: {},
    rules: { key: "{cause}", onEnded: "ask" },
    pausedAt: null,
    pausedWhy: null,
    createdAt: "2025-10-09T08:53:20.000Z",
    updatedAt: "2025-10-09T08:53:20.000Z",
  };
  const held = {
    id: "c1",
    triggerId: "t2",
    agentId: AGENT,
    key: "disk",
    text: "disk full\non vin-5",
    labels: {},
    why: "ended",
    state: "held",
    sessionId: null,
    notify: "email",
    createdAt: "2025-10-09T08:53:20.000Z",
    resolvedAt: null,
  };
  const bearers: string[] = [];
  await withStub(
    ({ method, path }) => {
      if (method === "PATCH" && path === "/v1/agents/triggers/t2") return hook;
      if (method === "POST" && path === "/v1/agents/triggers/t2/calls")
        return {
          outcome: "joined",
          sessionId: SESSION,
          seq: 2,
          callId: null,
          why: null,
          replayed: false,
        };
      if (method === "GET" && path === "/v1/agents/triggers/t2/held")
        return { data: [held], nextCursor: null };
      if (method === "POST" && path === "/v1/agents/triggers/t2/held/c1/start")
        return { session: session(), joined: false, calls: 2 };
      if (method === "POST" && path === "/v1/agents/triggers/t2/held/c1/dismiss")
        return { ...held, state: "dismissed" };
    },
    async (lines, sent) => {
      const stubbed = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        bearers.push(new Request(input, init).headers.get("authorization") ?? "");
        return stubbed(input, init);
      }) as typeof fetch;
      await run(
        ["agents", "triggers", "rules", "t2", '{"key":"{cause}","onEnded":"ask"}'],
        env,
        out(lines),
      );
      await run(
        [
          "agents",
          "triggers",
          "call",
          "t2",
          "disk",
          "full",
          "--key",
          "disk",
          "--secret",
          "rtat_s3cret_value_1234",
        ],
        env,
        out(lines),
      );
      await run(["agents", "triggers", "held", "t2", "--state", "held"], env, out(lines));
      await run(["agents", "triggers", "held", "start", "t2", "c1"], env, out(lines));
      await run(["agents", "triggers", "held", "dismiss", "t2", "c1"], env, out(lines));
      expect(sent[0]!.body).toEqual({ rules: { key: "{cause}", onEnded: "ask" } });
      expect(sent[1]!.body).toEqual({ text: "disk full", key: "disk" });
      expect(bearers[1]).toBe("Bearer rtat_s3cret_value_1234");
      expect(bearers[0]).toBe("Bearer rk_cli");
      expect(sent[2]!.query.getAll("state")).toEqual(["held"]);
      expect(lines[0]).toBe('t2 rules {"key":"{cause}","onEnded":"ask"}');
      expect(lines[1]).toBe(`joined ${SESSION} seq 2`);
      expect(lines[2]).toContain("c1");
      expect(lines[2]).toContain("disk full on vin-5");
      expect(lines[3]).toBe(`started ${SESSION} with 2 held calls`);
      expect(lines[4]).toBe("c1 dismissed.");
    },
  );
});

test("a held tool call shows in asks; approve and deny answer it Allow or Deny, a deny with its message", async () => {
  const held = (state = "open", option?: string) => ({
    ...inboxRow(state),
    step: null,
    question: "Bash: rm -rf build",
    why: "The agent's policy for Bash is always_ask.",
    options: [{ label: "Allow" }, { label: "Deny" }],
    pick: null,
    answer: option ? { option } : null,
    sessions: [inboxRow().sessions[0]],
    toolCall: { tool: "Bash", input: { command: "rm -rf build" }, seq: 4, policy: "always_ask" },
  });
  await withStub(
    ({ method, path, body }) => {
      if (method === "GET" && path === "/v1/agents/asks")
        return { data: [held()], nextCursor: null };
      if (method === "POST" && path === `/v1/agents/asks/${ASK}/answer`)
        return held("answered", (body as { option: string }).option);
    },
    async (lines, sent) => {
      expect(await run(["agents", "asks"], env, out(lines))).toBe(0);
      expect(lines.at(-1)).toContain('tool call: Bash {"command":"rm -rf build"}');
      expect(lines.at(-1)).toContain("options: Allow | Deny");
      expect(await run(["agents", "approve", ASK], env, out(lines))).toBe(0);
      expect(sent.at(-1)!.body).toEqual({ option: "Allow" });
      expect(lines.at(-1)).toBe(`${ASK}: Bash allowed.`);
      expect(
        await run(["agents", "deny", ASK, "--message", "Clean dist/ only."], env, out(lines)),
      ).toBe(0);
      expect(sent.at(-1)!.body).toEqual({ option: "Deny", text: "Clean dist/ only." });
      expect(lines.at(-1)).toBe(`${ASK}: Bash denied.`);
    },
  );
});

test("create takes --permissions as JSON, and says how when it is not", async () => {
  await withStub(
    ({ method, path, body }) => {
      if (method === "POST" && path === "/v1/agents")
        return {
          id: AGENT,
          name: "careful",
          version: 1,
          definition: (body as { definition: unknown }).definition,
          labels: {},
          warnings: [],
          createdAt: "2025-10-09T08:53:20.000Z",
          updatedAt: "2025-10-09T08:53:20.000Z",
        };
    },
    async (lines, sent) => {
      const permissions = { default: "auto", tools: { shell: "always_ask" } };
      expect(
        await run(
          [
            "agents",
            "create",
            "careful",
            "--command",
            "claude",
            "--permissions",
            JSON.stringify(permissions),
          ],
          env,
          out(lines),
        ),
      ).toBe(0);
      expect(
        (sent.at(-1)!.body as { definition: { permissions: unknown } }).definition.permissions,
      ).toEqual(permissions);
      await expect(
        run(
          ["agents", "create", "careful", "--command", "claude", "--permissions", "shell"],
          env,
          out(lines),
        ),
      ).rejects.toThrow("--permissions takes JSON");
    },
  );
});

test("switch anthropic says the base URL Anthropic's SDK takes, and whether the model key is set", async () => {
  for (const secrets of [[{ name: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"] }], []])
    await withStub(
      ({ method, path }) =>
        method === "GET" && path === "/v1/egress-secrets" ? { secrets, next: null } : undefined,
      async (lines) => {
        expect(await run(["agents", "switch", "anthropic"], env, out(lines))).toBe(0);
        const said = lines.join("\n");
        expect(said).toContain('baseURL: "https://api.example.test/anthropic"');
        expect(said).not.toContain("rk_cli");
        expect(said).toContain(
          secrets.length
            ? "ANTHROPIC_API_KEY is set (api.anthropic.com)"
            : "runtime secrets set ANTHROPIC_API_KEY --host api.anthropic.com",
        );
        const json: string[] = [];
        expect(await run(["agents", "switch", "anthropic"], env, out(json, true))).toBe(0);
        expect(JSON.parse(json[0]!)).toMatchObject({
          platform: "anthropic",
          baseURL: "https://api.example.test/anthropic",
          modelKey: secrets.length ? { name: "ANTHROPIC_API_KEY" } : null,
        });
      },
    );
  await expect(run(["agents", "switch", "vertex"], env, out([]))).rejects.toMatchObject({
    code: "usage",
    message: expect.stringContaining("takes anthropic"),
  });
});

test("trace reads every page: prints totals, models, tools and each span; --otlp prints OpenTelemetry; --export sends each page to a collector", async () => {
  const trace = {
    sessionId: SESSION,
    totals: {
      turns: 2,
      toolCalls: 1,
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 0,
      costUsd: 0.0218,
      unpricedTurns: 0,
      failedTurns: 0,
      failedToolCalls: 1,
      modelMs: 5000,
      toolMs: 1500,
    },
    models: [
      {
        model: "claude-opus-5-5",
        provider: "anthropic",
        turns: 2,
        unpricedTurns: 0,
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 0,
        costUsd: 0.0218,
      },
    ],
    tools: [{ name: "Bash", calls: 1, failed: 1, durationMs: 1500 }],
    spans: [
      {
        seq: 2,
        kind: "turn",
        id: "0123456789abcdef",
        provider: "anthropic",
        model: "claude-opus-5-5",
        startedAt: "2026-10-26T01:00:00.000Z",
        durationMs: 2500,
        firstTokenMs: 400,
        inputTokens: 600,
        outputTokens: 150,
        cacheReadTokens: 25_000,
        cacheWriteTokens: 0,
        costUsd: 0.0109,
        stopReason: "tool_use",
        status: 200,
        error: null,
        toolCalls: [{ id: "toolu_1", name: "Bash" }],
      },
      {
        seq: 3,
        kind: "tool",
        id: "toolu_1",
        name: "Bash",
        turn: "0123456789abcdef",
        startedAt: "2026-10-26T01:00:02.500Z",
        durationMs: 1500,
        input: '{"command":"bun test"}',
        output: "1 fail",
        error: true,
      },
    ],
  };
  // Two pages of each: the API's spans after `after`, and where to go on.
  const otlpPage = (spans: unknown[]) => ({
    resourceSpans: [{ resource: {}, scopeSpans: [{ scope: { name: "runtime.agents" }, spans }] }],
  });
  const otlp = [otlpPage([{ name: "root" }, { name: "chat" }]), otlpPage([{ name: "tool" }])];
  const pages = {
    json: [
      { ...trace, spans: trace.spans.slice(0, 1), nextAfter: 2 },
      { ...trace, spans: trace.spans.slice(1), nextAfter: null },
    ],
    otlp: [
      { ...otlp[0], nextAfter: 2 },
      { ...otlp[1], nextAfter: null },
    ],
  };
  const collected: { url: string; auth: string | null; body: unknown }[] = [];
  await withStub(
    (sent) =>
      sent.path === `/v1/agents/sessions/${SESSION}/trace`
        ? pages[sent.query.get("format") as "json" | "otlp"][
            sent.query.get("after") === "2" ? 1 : 0
          ]
        : undefined,
    async (lines, sent) => {
      expect(await run(["agents", "trace", SESSION], env, out(lines))).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("2 turns, 1 tool calls, $0.0218");
      expect(text).toContain("1,200 in, 300 out, 50,000 cache read");
      expect(text).toMatch(/claude-opus-5-5\s+2\s+1,200\s+300\s+50,000\s+\$0\.0218/);
      expect(text).toMatch(/Bash\s+1\s+1\s+1\.5 s/);
      expect(text).toContain(
        "turn claude-opus-5-5 2.5 s, 600 in, 150 out, 25,000 cached, $0.0109 -> Bash",
      );
      expect(text).toContain('tool Bash 1.5 s FAILED {"command":"bun test"}');
      expect(sent.map((x) => [x.query.get("format"), x.query.get("after") ?? "0"])).toEqual([
        ["json", "0"],
        ["json", "2"],
      ]);

      // Every page's spans in one request a collector takes.
      lines.length = 0;
      expect(await run(["agents", "trace", SESSION, "--otlp"], env, out(lines))).toBe(0);
      expect(JSON.parse(lines[0]!)).toEqual(
        otlpPage([{ name: "root" }, { name: "chat" }, { name: "tool" }]),
      );

      // The collector: where the OpenTelemetry SDK's own variables say.
      lines.length = 0;
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.startsWith("https://otel.example.test")) {
          collected.push({
            url: request.url,
            auth: request.headers.get("authorization"),
            body: await request.json(),
          });
          return new Response("{}");
        }
        return original(input, init);
      }) as typeof fetch;
      try {
        const otelEnv = {
          ...env,
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test/",
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20otel-key",
        };
        expect(await run(["agents", "trace", SESSION, "--export"], otelEnv, out(lines))).toBe(0);
      } finally {
        globalThis.fetch = original;
      }
      expect(collected).toEqual(
        otlp.map((body) => ({
          url: "https://otel.example.test/v1/traces",
          auth: "Bearer otel-key",
          body,
        })),
      );
      expect(lines).toEqual(["Sent 3 spans to https://otel.example.test/v1/traces."]);

      lines.length = 0;
      await expect(run(["agents", "trace", SESSION, "--export"], env, out(lines))).rejects.toThrow(
        "Give --endpoint, or set OTEL_EXPORTER_OTLP_ENDPOINT",
      );
    },
  );
});
