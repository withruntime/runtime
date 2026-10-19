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
