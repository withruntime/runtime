import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENT_TEMPLATES,
  AGENT_USES,
  agents,
  type AgentEvent,
  type AgentSession,
} from "../src/products/agents.js";
import type { Call, Transport } from "../src/transport.js";

/* runtime.agents against a fake transport: each method's route, method and
   body as agents-contract.md has them; a session's events long-poll with
   wait=30 from the last seq read and end with the session; wait() answers
   the ended session; and the templates are the shared data file's, byte for
   byte in meaning (packages/cloud-guide/agent-templates.json). */

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: "s 1",
  agentId: "a",
  agentVersion: 1,
  key: null,
  trigger: "api",
  state: "queued",
  reason: null,
  result: null,
  sandboxId: null,
  lastSeq: 1,
  workflowId: null,
  labels: {},
  overrides: null,
  createdAt: "2025-10-09T08:53:20.000Z",
  startedAt: null,
  endedAt: null,
  ...over,
});
const event = (seq: number, kind: AgentEvent["kind"] = "reply"): AgentEvent => ({
  seq,
  kind,
  actor: "agent",
  body: { text: `e${seq}` },
  createdAt: "2025-10-09T08:53:20.000Z",
});

function fake(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const transport = {
    async json<T>(call: Call): Promise<T> {
      calls.push(call);
      return (await answer(call)) as T;
    },
  } as Transport;
  return { api: agents(transport), calls };
}

test("each method's route, method and body", async () => {
  const { api, calls } = fake((call) =>
    call.path.endsWith("/sessions") && call.method === "POST"
      ? { session: session(), joined: false, seq: 1 }
      : call.path === "/v1/agents" && call.method === "GET"
        ? { data: [], nextCursor: null }
        : call.path.endsWith("/triggers") && call.method === "GET"
          ? { data: [] }
          : session(),
  );
  await api.create({ name: "dev", definition: { command: "claude" } });
  await api.get("dev");
  await api.list();
  await api.update("dev", { command: "codex" });
  await api.delete("dev");
  const s = await api.start("dev", { input: "hi", key: "customer:1" });
  await s.send("more");
  await s.stop();
  await api.triggers.create("dev", { kind: "webhook", config: {} });
  await api.triggers.list("dev");
  await api.triggers.pause("t", "busy");
  await api.triggers.resume("t");
  await api.triggers.delete("t");
  await api.sessions.delete("s 1");
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "POST /v1/agents",
    "GET /v1/agents/dev",
    "GET /v1/agents",
    "PATCH /v1/agents/dev",
    "DELETE /v1/agents/dev",
    "POST /v1/agents/dev/sessions",
    "POST /v1/agents/sessions/s%201/messages",
    "POST /v1/agents/sessions/s%201/stop",
    "POST /v1/agents/dev/triggers",
    "GET /v1/agents/dev/triggers",
    "POST /v1/agents/triggers/t/pause",
    "POST /v1/agents/triggers/t/resume",
    "DELETE /v1/agents/triggers/t",
    "DELETE /v1/agents/sessions/s%201",
  ]);
  expect(calls[3]!.body).toEqual({ definition: { command: "codex" } });
  expect(calls[5]!.body).toEqual({ input: "hi", key: "customer:1" });
  await api.start("dev", {
    input: "hi",
    overrides: { model: "claude-haiku-5-5", disallowedTools: ["Bash"], maxSessionDollars: 1 },
  });
  expect(calls.at(-1)!.body).toEqual({
    input: "hi",
    overrides: { model: "claude-haiku-5-5", disallowedTools: ["Bash"], maxSessionDollars: 1 },
  });
  expect(calls[6]!.body).toEqual({ text: "more" });
  expect(calls[10]!.body).toEqual({ why: "busy" });
});

test("a session's events long-poll from the last seq read and end with it; wait answers it ended", async () => {
  const pages = [
    { data: [event(2), event(3)], ended: false },
    { data: [], ended: false },
    { data: [event(4, "result")], ended: true },
  ];
  let reads = 0;
  const { api, calls } = fake((call) => {
    if (call.path.endsWith("/events")) return pages[reads++];
    if (call.method === "POST") return { session: session(), joined: false, seq: 1 };
    return session(reads >= 3 ? { state: "done", lastSeq: 4 } : {});
  });
  const s = await api.start("dev", { input: "go" });
  const seen: number[] = [];
  for await (const e of s.events({ after: 1 })) seen.push(e.seq);
  expect(seen).toEqual([2, 3, 4]);
  const polls = calls.filter((c) => c.path.endsWith("/events"));
  expect(polls.map((c) => c.query)).toEqual([
    { after: 1, wait: 30 },
    { after: 3, wait: 30 },
    { after: 3, wait: 30 },
  ]);
  expect((await s.wait()).state).toBe("done");
});

test("the templates and uses are the shared data file's", () => {
  const file = JSON.parse(
    readFileSync(new URL("../../cloud-guide/agent-templates.json", import.meta.url), "utf8"),
  );
  expect(AGENT_TEMPLATES).toEqual(file.templates);
  expect(AGENT_USES).toEqual(file.uses);
  const { api } = fake(() => null);
  expect(api.templates).toBe(AGENT_TEMPLATES);
  expect(Object.keys(api.templates)).toEqual([
    "claude-code",
    "codex",
    "gemini-cli",
    "claude-agent-sdk",
    "openai-agents-sdk",
    "review",
    "judge",
    "browser",
  ]);
  expect(Object.keys(api.uses)).toEqual(["support", "team"]);
});

test("memory: list pages with its usage, search, read, write and delete, each scope in the query", async () => {
  const entry = (path: string, scope = "") => ({
    scope,
    path,
    bytes: 10,
    updatedAt: "2025-10-09T08:53:20.000Z",
    updatedBy: "key_1",
  });
  const usage = { bytes: 20, files: 2, limitBytes: 1073741824, limitFiles: 100000 };
  const { api, calls } = fake((call) => {
    if (call.path === "/v1/agents/dev/memory" && call.query?.q !== undefined)
      return { data: [{ ...entry("a.md"), snippet: "**tea**", rank: 0.5 }], nextCursor: null };
    if (call.path === "/v1/agents/dev/memory")
      return call.query?.cursor
        ? { data: [entry("b.md", "customer:1")], nextCursor: null, usage }
        : { data: [entry("a.md")], nextCursor: "c1", usage };
    if (call.method === "PUT")
      return { scope: "customer:1", path: "b.md", bytes: 4, created: true, updatedAt: "x" };
    if (call.method === "DELETE") return { deleted: true };
    return { ...entry("a.md"), content: "tea" };
  });
  const page = await api.memory.list("dev", { prefix: "a", limit: 1 });
  expect(page.usage).toEqual(usage);
  expect((await page.toArray()).map((f) => `${f.scope}/${f.path}`)).toEqual([
    "/a.md",
    "customer:1/b.md",
  ]);
  expect((await api.memory.search("dev", "tea", { scope: "" }))[0]!.snippet).toBe("**tea**");
  expect((await api.memory.read("dev", "a.md")).content).toBe("tea");
  expect((await api.memory.write("dev", "b.md", "more", { scope: "customer:1" })).created).toBe(
    true,
  );
  expect(await api.memory.delete("dev", "notes/x y.md", { scope: "customer:1" })).toBe(true);
  expect(calls.map((c) => [c.method, c.path, c.query, c.body])).toEqual([
    ["GET", "/v1/agents/dev/memory", { prefix: "a", limit: 1 }, undefined],
    ["GET", "/v1/agents/dev/memory", { prefix: "a", limit: 1, cursor: "c1" }, undefined],
    ["GET", "/v1/agents/dev/memory", { scope: "", q: "tea" }, undefined],
    ["GET", "/v1/agents/dev/memory/content", { scope: "", path: "a.md" }, undefined],
    [
      "PUT",
      "/v1/agents/dev/memory/content",
      { scope: "customer:1", path: "b.md" },
      { content: "more" },
    ],
    [
      "DELETE",
      "/v1/agents/dev/memory/content",
      { scope: "customer:1", path: "notes/x y.md" },
      undefined,
    ],
  ]);
});

test("asks: the inbox lists with labels as label=key:value, gets one and answers it", async () => {
  const { api, calls } = fake((call) =>
    call.method === "GET" && call.path === "/v1/agents/asks"
      ? { data: [], nextCursor: null }
      : { id: "a 1", state: "answered", sessions: [] },
  );
  await api.asks.list({ state: ["open", "expired"], labels: { team: "infra", for: "marc" } });
  await api.asks.get("a 1");
  await api.asks.answer("a 1", { option: "Raise to 20 TB", text: "Done." });
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /v1/agents/asks",
    "GET /v1/agents/asks/a%201",
    "POST /v1/agents/asks/a%201/answer",
  ]);
  expect(calls[0]!.query).toEqual({
    state: ["open", "expired"],
    label: ["team:infra", "for:marc"],
  });
  expect(calls[2]!.body).toEqual({ option: "Raise to 20 TB", text: "Done." });
});

test("workflows: run, follow each change with a 30-second wait past the last version, wait for the result, steps and stop", async () => {
  const flow = (version: number, state = "running", result: string | null = null) => ({
    id: "w 1",
    name: "triage",
    state,
    reason: state === "running" ? null : "done",
    result,
    parentSessionId: null,
    spec: { agent: "dev", phases: [{ name: "a", input: "{{item}}", each: ["x", "y"] }] },
    maxSessions: 100,
    maxConcurrent: 20,
    maxDollars: 10,
    started: 2,
    version,
    labels: {},
    phases: [],
    cost: { dollars: 0, vcpuSeconds: 0, gibSeconds: 0 },
    createdAt: "2025-10-09T08:53:20.000Z",
    updatedAt: "2025-10-09T08:53:20.000Z",
    endedAt: null,
  });
  // Each long poll answers the next version; the third has ended.
  let version = 1;
  const { api, calls } = fake((call) => {
    if (call.method === "POST" && call.path === "/v1/agents/workflows") return flow(1);
    if (call.path.endsWith("/steps")) return { data: [], nextCursor: null };
    if (call.path.endsWith("/stop")) return flow(9, "stopped");
    if (call.path === "/v1/agents/workflows") return { data: [flow(1)], nextCursor: null };
    if (!call.query?.wait) return flow(version);
    version += 1;
    return version >= 3 ? flow(version, "done", '["X", "Y"]') : flow(version);
  });
  const spec = {
    agent: "dev",
    maxConcurrent: 50,
    phases: [{ name: "a", input: "{{item}}", each: ["x", "y"] }],
  };
  const w = await api.workflows.run(spec);
  expect(w.id).toBe("w 1");
  expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/agents/workflows", body: spec });
  const seen: number[] = [];
  for await (const now of w.follow()) seen.push(now.version);
  expect(seen).toEqual([2, 3]);
  const polls = calls.filter((c) => c.query?.wait);
  expect(polls.map((c) => c.query)).toEqual([
    { after: 0, wait: 30 },
    { after: 2, wait: 30 },
  ]);
  expect(polls.every((c) => c.path === "/v1/agents/workflows/w%201" && c.timeoutMs === 0)).toBe(
    true,
  );
  version = 1;
  const ended = await w.wait();
  expect(ended).toMatchObject({ state: "done", result: '["X", "Y"]' });
  await w.steps({ state: ["failed"] });
  await api.workflows.list({ state: ["running"] });
  await w.stop();
  expect(calls.slice(-3).map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /v1/agents/workflows/w%201/steps",
    "GET /v1/agents/workflows",
    "POST /v1/agents/workflows/w%201/stop",
  ]);
});

test("anthropic() is the options Anthropic's SDK takes: Runtime's origin with /anthropic, and the key", async () => {
  const transport = {
    baseUrl: "https://api.withruntime.com",
    apiKey: async () => "rt_live_key",
  } as unknown as Transport;
  expect(await agents(transport).anthropic()).toEqual({
    baseURL: "https://api.withruntime.com/anthropic",
    apiKey: "rt_live_key",
  });
});
