import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/client";
import { RuntimeError } from "../src/errors";
import { checkAgentsFile, withDeploy, type AgentsDeployResult } from "../src/agents-deploy";
import { loadAgentsFile, parseAgentsFile, starterAgents } from "../src/agents-file";
import type { Agent, AgentTrigger } from "../src/products/agents";

/* runtime.yml's agents: section: checked as the API checks it, every mistake
   named by file, line, agent and field; and the deploy's plan against a fake
   API that writes in its defaults and replays an idempotency key as the real
   one does: create, update (a new version only when changed), no-op, the
   trigger diff, prune refused without the flag and limited to what a deploy
   made, a rerun repeating nothing, an interrupted deploy finished by the
   next. */

const AGENTS_MD = "You fix failing tests and open a pull request.\n";
const FILE = `# our agents
agents:
  fixer:
    template: claude-code
    use: team
    instructionsFile: AGENTS.md
    triggers:
      - kind: schedule
        config: { cron: "0 9 * * 1-5", input: "Fix what failed overnight." }
      - kind: webhook
  helper:
    template: codex
    instructions: |
      Answer questions about Acme's billing.
    maxConcurrent: 50
    env: { REGION: us-east }
`;

function folder(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "agents-deploy-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** The API's agents routes in memory, defaults and key replays as the
 * database does them. */
class FakeApi {
  /** Memory files each agent holds, by its id. */
  memory = new Map<string, number>();
  agents = new Map<string, Agent>();
  deleted = new Set<string>();
  triggers = new Map<string, AgentTrigger>();
  keys = new Map<string, string>();
  answers = new Map<string, AgentTrigger>();
  calls: { method: string; path: string; key: string | null }[] = [];
  fail?: (method: string, path: string) => boolean;
  #n = 0;
  #id = () => `00000000-0000-4000-8000-${String(++this.#n).padStart(12, "0")}`;
  #t = 0;
  /** A clock that moves on at each change, as the database's does. */
  #now = () => new Date(Date.UTC(2026, 9, 18, 12, 0, 0, ++this.#t)).toISOString();

  withDefaults(definition: Record<string, unknown>) {
    const snapshot = (definition.from as { snapshot?: string } | undefined)?.snapshot;
    return {
      ...(snapshot ? {} : { vcpu: 4, memoryMiB: 8192 }),
      idlePauseSeconds: 60,
      maxSessionSeconds: 86400,
      maxConcurrent: 10,
      maxSessionDollars: 5,
      maxDayDollars: 100,
      memory: { scope: "key" },
      ...definition,
    } as Agent["definition"];
  }
  /** One made by hand (`runtime agents create`), with no deploy label. */
  hand(name: string) {
    const id = this.#id();
    this.agents.set(id, {
      id,
      name,
      version: 1,
      definition: this.withDefaults({ command: "claude" }),
      labels: {},
      warnings: [],
      createdAt: this.#now(),
      updatedAt: this.#now(),
    });
  }
  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname: path } = new URL(request.url);
    const method = request.method;
    const key = request.headers.get("idempotency-key");
    const body =
      method === "GET"
        ? undefined
        : await request.text().then((t) => (t ? JSON.parse(t) : undefined));
    this.calls.push({ method, path, key: method === "GET" ? null : key });
    if (this.fail?.(method, path))
      return Response.json(
        { error: { code: "invalid_request", message: "refused here" } },
        { status: 400 },
      );
    const json = (value: unknown, status = 200) =>
      value === null ? new Response(null, { status: 204 }) : Response.json(value, { status });
    const missing = () =>
      Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    /** A key is the caller's across its account, as the API keeps it, not
     * one path's: a key sent again answers what it first made. */
    const replay = (made: () => string) => {
      const seen = key ? this.keys.get(`${method} ${key}`) : undefined;
      if (seen) return seen;
      const id = made();
      if (key) this.keys.set(`${method} ${key}`, id);
      return id;
    };
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/v1\/agents\/([^/]+)\/memory$/.exec(path))) {
      if (!this.agents.has(m[1]!)) return missing();
      const files = this.memory.get(m[1]!) ?? 0;
      return json({ data: [], nextCursor: null, usage: { bytes: files * 100, files } });
    }
    if (method === "GET" && path === "/v1/agents")
      return json({ data: [...this.agents.values()], nextCursor: null });
    if (method === "POST" && path === "/v1/agents") {
      const id = replay(() => {
        const made = this.#id();
        this.agents.set(made, {
          id: made,
          name: body.name,
          version: 1,
          definition: this.withDefaults(body.definition),
          labels: body.labels ?? {},
          warnings: [],
          createdAt: this.#now(),
          updatedAt: this.#now(),
        });
        return made;
      });
      return this.agents.has(id) ? json(this.agents.get(id), 201) : missing();
    }
    if ((m = /^\/v1\/agents\/triggers\/([^/]+)(\/pause|\/resume)?$/.exec(path))) {
      const t = this.triggers.get(m[1]!);
      if (!t) return missing();
      if (method === "DELETE") {
        this.triggers.delete(t.id);
        return json(null);
      }
      // A known key answers what it answered, and changes nothing, as the
      // router replays it.
      const seen = key ? this.answers.get(`${method} ${path} ${key}`) : undefined;
      if (seen) return json(seen);
      if (m[2] === "/pause")
        Object.assign(t, { pausedAt: this.#now(), pausedWhy: body.why, updatedAt: this.#now() });
      if (m[2] === "/resume")
        Object.assign(t, { pausedAt: null, pausedWhy: null, updatedAt: this.#now() });
      if (method === "PATCH") Object.assign(t, { rules: body.rules, updatedAt: this.#now() });
      if (key) this.answers.set(`${method} ${path} ${key}`, { ...t });
      return json(t);
    }
    if ((m = /^\/v1\/agents\/([^/]+)\/triggers$/.exec(path))) {
      const agent = this.agents.get(m[1]!);
      if (!agent) return missing();
      if (method === "GET")
        return json({ data: [...this.triggers.values()].filter((t) => t.agentId === agent.id) });
      let secret: string | undefined;
      const id = replay(() => {
        const made = this.#id();
        // A webhook's secret is answered once, and kept nowhere a read or a
        // replay answers it, as the API does.
        if (body.kind === "webhook") secret = `rtat_${made.replaceAll("-", "")}`;
        this.triggers.set(made, {
          id: made,
          agentId: agent.id,
          kind: body.kind,
          config: body.config,
          rules: body.rules ?? {},
          pausedAt: null,
          pausedWhy: null,
          createdAt: this.#now(),
          updatedAt: this.#now(),
        });
        return made;
      });
      // A replay of a trigger since deleted answers one that is gone.
      const made = this.triggers.get(id);
      return made ? json({ ...made, ...(secret ? { secret } : {}) }, 201) : missing();
    }
    if ((m = /^\/v1\/agents\/([^/]+)$/.exec(path))) {
      const agent = this.agents.get(m[1]!);
      if (!agent) return missing();
      if (method === "PATCH") {
        Object.assign(agent, {
          definition: this.withDefaults(body.definition),
          version: agent.version + 1,
          updatedAt: this.#now(),
        });
        return json(agent);
      }
      if (method === "DELETE") {
        this.agents.delete(agent.id);
        this.deleted.add(agent.id);
        for (const t of this.triggers.values())
          if (t.agentId === agent.id) this.triggers.delete(t.id);
        return json(null);
      }
      return json(agent);
    }
    return Response.json({ error: { code: "route_not_found", message: path } }, { status: 404 });
  };
  client() {
    return withDeploy(
      new Runtime({
        apiKey: "rk_test",
        baseUrl: "https://api.example.test",
        fetch: this.fetch as typeof fetch,
      }).agents,
    );
  }
  byName(name: string) {
    return [...this.agents.values()].find((a) => a.name === name);
  }
}

const actions = (r: AgentsDeployResult) => r.changes.map((c) => `${c.action} ${c.agent}`);

test("a file is checked as the API checks it: templates, uses and the repo's instructions fill it in", () => {
  const dir = folder({ "runtime.yml": FILE, "AGENTS.md": AGENTS_MD });
  const [fixer, helper] = checkAgentsFile(loadAgentsFile(join(dir, "runtime.yml")));
  expect(fixer!.name).toBe("fixer");
  expect(fixer!.definition).toMatchObject({
    template: "team",
    vcpu: 4,
    memoryMiB: 8192,
    instructions: AGENTS_MD,
    secrets: ["ANTHROPIC_API_KEY"],
  });
  expect(fixer!.definition.command).toStartWith("npx -y @anthropic-ai/claude-code");
  expect(fixer!.triggers).toEqual([
    { kind: "schedule", config: { cron: "0 9 * * 1-5", input: "Fix what failed overnight." } },
    { kind: "webhook", config: {} },
  ]);
  // No use: the default size, 4 vCPU and 8 GiB; the file's fields win.
  expect(helper!.definition).toMatchObject({
    vcpu: 4,
    memoryMiB: 8192,
    maxConcurrent: 50,
    secrets: ["OPENAI_API_KEY"],
    env: { REGION: "us-east" },
    instructions: "Answer questions about Acme's billing.\n",
  });
  expect(helper!.definition).not.toHaveProperty("template");
  expect(helper!.triggers).toEqual([]);
  // The review template: its pool replaced by the file's, a use's size over its own.
  const [reviewer] = checkAgentsFile(
    parseAgentsFile(
      "agents:\n  ci-review:\n    template: review\n    use: team\n    pool: [CLAUDE_1, CLAUDE_2]\n",
      "runtime.yml",
      dir,
    ),
  );
  expect(reviewer!.definition).toMatchObject({
    command: "python3 ~/.runtime-agent/runtime-agent review",
    pool: ["CLAUDE_1", "CLAUDE_2"],
    vcpu: 4,
    maxSessionSeconds: 1800,
  });
  expect(() =>
    checkAgentsFile(
      parseAgentsFile("agents:\n  r:\n    template: review\n    pool: []\n", "runtime.yml", dir),
    ),
  ).toThrow("1 to 16");
  // The starter `runtime agents init` writes is a valid file.
  const starter = parseAgentsFile(
    starterAgents({ name: "claude-code", template: "claude-code", instructionsFile: "AGENTS.md" }),
    "runtime.yml",
    dir,
  );
  expect(checkAgentsFile(starter).map((a) => a.name)).toEqual(["claude-code"]);
});

test("from takes a repository connected to CI/CD, as the API does, and names it when malformed", () => {
  const file = (from: string) =>
    parseAgentsFile(
      `agents:\n  alerts:\n    template: claude-code\n    from: ${from}\n`,
      "runtime.yml",
    );
  const [alerts] = checkAgentsFile(file("{ repo: withruntime/runtime-cloud }"));
  expect(alerts!.definition.from).toEqual({ repo: "withruntime/runtime-cloud" });
  expect(() => checkAgentsFile(file("{ repo: runtime-cloud }"))).toThrow(
    "runtime.yml:4: agents.alerts.from takes { image: name[:tag] }, { snapshot: <snapshot id> } or { repo: owner/name }.",
  );
});

test("model and sessionOverrides are taken as the API takes them, and named when malformed", () => {
  const file = (lines: string) =>
    parseAgentsFile(`agents:\n  helper:\n    template: claude-code\n${lines}`, "runtime.yml");
  const [helper] = checkAgentsFile(
    file(
      "    model: claude-sonnet-5-5\n    sessionOverrides: { models: [claude-opus-5-5], instructions: replace, maxVcpu: 8, maxSessionDollars: 20 }\n",
    ),
  );
  expect(helper!.definition).toMatchObject({
    model: "claude-sonnet-5-5",
    sessionOverrides: {
      models: ["claude-opus-5-5"],
      instructions: "replace",
      maxVcpu: 8,
      maxSessionDollars: 20,
    },
  });
  expect(() => checkAgentsFile(file("    model: bad model\n"))).toThrow(
    "runtime.yml:4: agents.helper.model takes a model as its provider names it, such as claude-opus-5-5.",
  );
  expect(() => checkAgentsFile(file("    sessionOverrides: { maxVcpu: 3 }\n"))).toThrow(
    "agents.helper.sessionOverrides.maxVcpu takes 1, 2, 4, 8 or 16.",
  );
  expect(() => checkAgentsFile(file("    sessionOverrides: { temperature: 1 }\n"))).toThrow(
    "agents.helper.sessionOverrides takes { models, instructions, maxVcpu, maxMemoryMiB, maxSessionDollars }.",
  );
});

test("every mistake is named by file, line, agent and field, all at once", () => {
  const bad = `agents:
  fixer:
    template: claude-cod
    instructons: hello
    vcpu: 3
    env: { PORT: 3000 }
    maxSessionDollars: 0
    triggers:
      - kind: cron
  snap:
    command: ./run.sh
    from: { snapshot: 11111111-1111-4111-8111-111111111111 }
    memoryMiB: 4096
  sessions:
    command: x
  lost:
    use: team
`;
  let error: RuntimeError | undefined;
  try {
    checkAgentsFile(parseAgentsFile(bad, "runtime.yml"));
  } catch (e) {
    error = e as RuntimeError;
  }
  expect(error).toBeInstanceOf(RuntimeError);
  expect(error!.code).toBe("invalid_file");
  expect(error!.message.split("\n")).toEqual([
    "runtime.yml:4: agents.fixer.instructons is not a field an agent takes (did you mean instructions?).",
    "runtime.yml:3: agents.fixer.template takes claude-code, codex, gemini-cli, claude-agent-sdk, openai-agents-sdk, review, judge, browser.",
    "runtime.yml:5: agents.fixer.vcpu takes 1, 2, 4, 8 or 16.",
    'runtime.yml:6: agents.fixer.env.PORT takes text: quote it, as PORT: "3000".',
    "runtime.yml:7: agents.fixer.maxSessionDollars takes dollars from 0.01 to 10000.",
    "runtime.yml:2: agents.fixer.command is missing: give template (claude-code, codex, gemini-cli, claude-agent-sdk, openai-agents-sdk, review, judge, browser) or command.",
    "runtime.yml:9: agents.fixer.triggers.0.kind takes slack, github, schedule, webhook.",
    "runtime.yml:13: agents.snap.memoryMiB cannot be set with from.snapshot: a snapshot keeps the size it was taken at.",
    "runtime.yml:14: agents.sessions may not be an agent's name: /v1/agents/sessions is another route.",
    "runtime.yml:16: agents.lost.command is missing: give template (claude-code, codex, gemini-cli, claude-agent-sdk, openai-agents-sdk, review, judge, browser) or command.",
  ]);
  expect(error!.details!.issues).toContainEqual({
    agent: "fixer",
    field: "vcpu",
    line: 5,
    message: "takes 1, 2, 4, 8 or 16.",
  });
});

test("a YAML mistake, a missing section and a stray one are refused with their line", () => {
  expect(() => parseAgentsFile("agents:\n  a: [1,\n", "runtime.yml")).toThrow(
    /^runtime\.yml:\d+:\d+: /,
  );
  expect(() => parseAgentsFile("agents:\n  a: 1\n  a: 2\n", "runtime.yml")).toThrow(
    /runtime\.yml:3/,
  );
  expect(() => checkAgentsFile(parseAgentsFile("agent:\n  x:\n    command: y\n"))).toThrow(
    "runtime.yml:1: agent is not a section runtime.yml takes (did you mean agents?).",
  );
  expect(() => checkAgentsFile({ agents: null } as never)).toThrow("agents is missing");
  expect(() => loadAgentsFile(join(tmpdir(), "no-such-dir", "runtime.yml"))).toThrow(
    "is not there",
  );
});

test("an alias bomb is refused at once, unexpanded, as is any anchor or alias", () => {
  // Nine levels of nine aliases: 9^9 strings once expanded.
  const levels = ["a: &l0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]"];
  for (let i = 1; i < 9; i++)
    levels.push(`l${i}: &l${i} [${Array.from({ length: 9 }, () => `*l${i - 1}`).join(", ")}]`);
  const bomb = `${levels.join("\n")}\nagents:\n  x:\n    command: *l8\n`;
  const started = performance.now();
  expect(() => parseAgentsFile(bomb, "runtime.yml")).toThrow(
    "runtime.yml:2: anchors and aliases (&name, *name) are not taken in runtime.yml.",
  );
  expect(performance.now() - started).toBeLessThan(200);
  expect(() =>
    parseAgentsFile(
      "base: &base { template: claude-code }\nagents:\n  a:\n    <<: *base\n",
      "runtime.yml",
    ),
  ).toThrow("runtime.yml:4: anchors and aliases");
});

test("a file over 256 KiB is refused before it is parsed, from disk or as text", () => {
  const big = `agents:\n  a:\n    command: x\n    instructions: "${"y".repeat(256 * 1024)}"\n`;
  expect(() => parseAgentsFile(big, "runtime.yml")).toThrow(
    "runtime.yml is over 256 KiB; a runtime.yml is a few KiB.",
  );
  const dir = folder({ "runtime.yml": big });
  expect(() => loadAgentsFile(join(dir, "runtime.yml"))).toThrow("is over 256 KiB");
  // An object of shared parts is refused by its size, never expanded.
  let part: unknown = "y".repeat(100);
  for (let i = 0; i < 30; i++) part = [part, part];
  expect(() => checkAgentsFile({ agents: { a: { command: "x", env: part } } } as never)).toThrow(
    "runtime.yml: is over 256 KiB",
  );
});

test("a trigger takes only its documented keys", () => {
  const file = `agents:
  a:
    command: x
    triggers:
      - kind: webhook
        config: { url: "https://example.com" }
      - kind: slack
        config: { team: T123, channel: C123, extra: 1 }
      - kind: schedule
        config: { cron: "0 9 * * 1-5", timezone: America/Denver, input: Go. }
      - kind: github
        config: { installation: 7, repository: acme/web, events: [pull_request, issue_comment.created] }
`;
  expect(() => checkAgentsFile(parseAgentsFile(file))).toThrow(
    [
      "runtime.yml:6: agents.a.triggers.0.config.url is not a key a webhook trigger takes.",
      "runtime.yml:8: agents.a.triggers.1.config.extra is not a key a slack trigger takes.",
    ].join("\n"),
  );
  const ok = file.replace(/ {8}config: \{ url.*\n/, "").replace(", extra: 1", "");
  expect(checkAgentsFile(parseAgentsFile(ok))[0]!.triggers.map((t) => t.kind)).toEqual([
    "webhook",
    "slack",
    "schedule",
    "github",
  ]);
});

test("instructionsFile is read inside the file's folder only, and only by a loader", () => {
  const dir = folder({ "runtime.yml": "" });
  writeFileSync(join(dir, "..", "outside.md"), "secret");
  symlinkSync(join(dir, "..", "outside.md"), join(dir, "link.md"));
  const file = (path: string) => `agents:\n  a:\n    command: x\n    instructionsFile: ${path}\n`;
  expect(() => checkAgentsFile(parseAgentsFile(file("../outside.md"), "runtime.yml", dir))).toThrow(
    "agents.a.instructionsFile takes a path inside the repo",
  );
  expect(() => checkAgentsFile(parseAgentsFile(file("/etc/passwd"), "runtime.yml", dir))).toThrow(
    "agents.a.instructionsFile takes a path inside the repo",
  );
  expect(() => checkAgentsFile(parseAgentsFile(file("link.md"), "runtime.yml", dir))).toThrow(
    "names link.md, which cannot be read",
  );
  expect(() => checkAgentsFile(parseAgentsFile(file("AGENTS.md")))).toThrow(
    "is read from the repo by `runtime agents deploy`",
  );
});

test("deploy creates, then a rerun is a no-op, then a change is one new version", async () => {
  const api = new FakeApi();
  const dir = folder({ "runtime.yml": FILE, "AGENTS.md": AGENTS_MD });
  const source = () => loadAgentsFile(join(dir, "runtime.yml"));

  // A dry run reads and plans; it writes nothing.
  const planned = await api.client().deploy(source(), { dryRun: true });
  expect(actions(planned)).toEqual([
    "create fixer",
    "add-trigger fixer",
    "add-trigger fixer",
    "create helper",
  ]);
  expect(planned.changes[0]!.text).toBe("create agent fixer (claude-code, 4 vCPU, 8192 MiB)");
  expect(planned.changes[1]!.text).toBe('add trigger schedule "0 9 * * 1-5" to fixer');
  expect(api.writes()).toEqual([]);
  // The same plan carries the same keys, so a rerun is safe.
  const again = await api.client().deploy(source(), { dryRun: true });
  expect(again.changes.map((c) => c.key)).toEqual(planned.changes.map((c) => c.key));
  expect(new Set(planned.changes.map((c) => c.key)).size).toBe(4);
  for (const c of planned.changes) expect(c.key).toMatch(/^deploy:[0-9a-f]{32}$/);

  const made = await api.client().deploy(source());
  expect(actions(made)).toEqual(actions(planned));
  const fixer = api.byName("fixer")!;
  expect(fixer.labels).toEqual({ "managed-by": "runtime.yml" });
  expect([...api.triggers.values()].map((t) => t.kind)).toEqual(["schedule", "webhook"]);
  // Each change was sent with the key it answers: the plan's, but for a new
  // agent's triggers, whose keys take the agent's id once it is made.
  expect(api.writes().map((c) => c.key)).toEqual(made.changes.map((c) => c.key));
  expect(made.changes.map((c, i) => c.key === planned.changes[i]!.key)).toEqual(
    made.changes.map((c) => c.action !== "add-trigger"),
  );

  // A rerun: nothing to change, nothing written, no new version.
  const before = api.writes().length;
  const rerun = await api.client().deploy(source());
  expect(rerun.changes).toEqual([]);
  expect(rerun.unchanged).toEqual(["fixer", "helper"]);
  expect(api.writes().length).toBe(before);

  // One agent's instructions change: it alone gets a new version.
  writeFileSync(join(dir, "AGENTS.md"), "Fix it, and add a test.\n");
  const changed = await api.client().deploy(source());
  expect(changed.changes.map((c) => c.text)).toEqual([
    "update agent fixer: instructions (v1 -> v2)",
  ]);
  expect(changed.unchanged).toEqual(["helper"]);
  expect(api.byName("fixer")!.version).toBe(2);
  expect(api.byName("helper")!.version).toBe(1);

  // A field taken out goes back to the API's default: a change too.
  writeFileSync(join(dir, "runtime.yml"), FILE.replace("    maxConcurrent: 50\n", ""));
  const back = await api.client().deploy(source());
  expect(back.changes.map((c) => c.text)).toEqual([
    "update agent helper: maxConcurrent (v1 -> v2)",
  ]);
  expect(api.byName("helper")!.definition.maxConcurrent).toBe(10);
  expect((await api.client().deploy(source())).changes).toEqual([]);
});

test("memory: the stored default is no change, shared is taken and kept, a support agent's refused", async () => {
  const api = new FakeApi();
  const file = (memory: string) => `agents:
  plain:
    template: claude-code
  team-bot:
    template: claude-code
    use: team
${memory}`;
  const shared = file("    memory: { scope: agent }\n");
  const made = await api.client().deploy(parseAgentsFile(shared, "runtime.yml"));
  expect(actions(made)).toEqual(["create plain", "create team-bot"]);
  expect(api.byName("plain")!.definition.memory).toEqual({ scope: "key" });
  expect(api.byName("team-bot")!.definition.memory).toEqual({ scope: "agent" });
  const rerun = await api.client().deploy(parseAgentsFile(shared, "runtime.yml"));
  expect(rerun.changes).toEqual([]);
  expect(rerun.unchanged).toEqual(["plain", "team-bot"]);
  // Taken out, it goes back to each key its own: one new version.
  const back = await api.client().deploy(parseAgentsFile(file(""), "runtime.yml"));
  expect(back.changes.map((c) => c.text)).toEqual(["update agent team-bot: memory (v1 -> v2)"]);

  const refused = (memory: string, use = "support") => {
    try {
      checkAgentsFile(parseAgentsFile(file(memory).replace("use: team", `use: ${use}`), "x.yml"));
    } catch (e) {
      return (e as RuntimeError).message;
    }
    return "";
  };
  expect(refused("    memory: { scope: agent }\n")).toContain(
    "agents.team-bot.memory.scope may not be agent for a support agent",
  );
  expect(refused("    memory: { scope: everyone }\n", "team")).toContain(
    "agents.team-bot.memory takes { scope: key }",
  );
  expect(refused("    memory: { scope: key }\n")).toBe("");
});

test("triggers are added, paused, resumed and removed to match", async () => {
  const api = new FakeApi();
  const dir = folder({ "AGENTS.md": AGENTS_MD });
  const write = (triggers: string) =>
    writeFileSync(
      join(dir, "runtime.yml"),
      `agents:\n  fixer:\n    template: claude-code\n    triggers:\n${triggers}`,
    );
  const deploy = () => api.client().deploy(loadAgentsFile(join(dir, "runtime.yml")));
  const nightly = `      - kind: schedule\n        config: { cron: "0 2 * * *", input: "Nightly." }\n`;
  const webhook = "      - kind: webhook\n";
  write(nightly + webhook);
  await deploy();
  const [schedule, hook] = [...api.triggers.values()];

  write(`${nightly}        paused: Holding for the release.\n`);
  const paused = await deploy();
  expect(paused.changes.map((c) => c.text)).toEqual([
    `pause trigger ${schedule!.id} (schedule "0 2 * * *") of fixer: Holding for the release.`,
    `remove trigger ${hook!.id} (webhook) of fixer`,
  ]);
  expect(api.triggers.get(schedule!.id)!.pausedWhy).toBe("Holding for the release.");
  expect(api.triggers.has(hook!.id)).toBe(false);
  expect((await deploy()).changes).toEqual([]);

  // Let go, and the webhook named again is a new trigger, not a replay of
  // the removed one.
  write(nightly + webhook);
  const resumed = await deploy();
  expect(actions(resumed)).toEqual(["resume-trigger fixer", "add-trigger fixer"]);
  expect(api.triggers.get(schedule!.id)!.pausedAt).toBeNull();
  const kinds = [...api.triggers.values()].map((t) => `${t.kind}${t.pausedAt ? " paused" : ""}`);
  expect(kinds).toEqual(["schedule", "webhook"]);
  expect([...api.triggers.keys()]).not.toContain(hook!.id);

  // A trigger written paused is held; a new one written paused is made, then held.
  const later = `      - kind: schedule\n        config: { cron: "0 3 * * *", input: "Later." }\n        paused: Later.\n`;
  write(`${webhook}        paused: Not yet.\n${later}`);
  await deploy();
  expect([...api.triggers.values()].map((t) => [t.kind, t.pausedWhy])).toEqual([
    ["webhook", "Not yet."],
    ["schedule", "Later."],
  ]);
  expect((await deploy()).changes).toEqual([]);
});

test("an agent left out of the file is kept without --prune; prune deletes only what a deploy made", async () => {
  const api = new FakeApi();
  api.hand("by-hand");
  const dir = folder({ "AGENTS.md": AGENTS_MD });
  const path = join(dir, "runtime.yml");
  writeFileSync(path, FILE);
  await api.client().deploy(loadAgentsFile(path));
  writeFileSync(path, FILE.slice(0, FILE.indexOf("  helper:")));

  const kept = await api.client().deploy(loadAgentsFile(path));
  expect(kept.changes).toEqual([]);
  expect(kept.leftAlone).toEqual([{ agent: "helper", why: "not in the file; --prune deletes it" }]);
  expect(api.writes().filter((c) => c.method === "DELETE")).toEqual([]);
  expect(api.byName("helper")).toBeDefined();

  const pruned = await api.client().deploy(loadAgentsFile(path), { prune: true });
  expect(actions(pruned)).toEqual(["delete helper"]);
  expect(pruned.leftAlone).toEqual([
    {
      agent: "by-hand",
      why: "made outside a runtime.yml, so --prune keeps it; `runtime agents rm` deletes it",
    },
  ]);
  expect(api.byName("helper")).toBeUndefined();
  expect(api.byName("by-hand")).toBeDefined();
});

test("prune keeps an agent that holds memory files unless pruneMemory, and says how many go", async () => {
  const api = new FakeApi();
  const dir = folder({ "AGENTS.md": AGENTS_MD });
  const path = join(dir, "runtime.yml");
  writeFileSync(path, FILE);
  await api.client().deploy(loadAgentsFile(path));
  api.memory.set(api.byName("helper")!.id, 3);
  writeFileSync(path, FILE.slice(0, FILE.indexOf("  helper:")));

  const kept = await api.client().deploy(loadAgentsFile(path), { prune: true });
  expect(kept.changes).toEqual([]);
  expect(kept.leftAlone).toEqual([
    {
      agent: "helper",
      why: "not in the file, and it holds 3 memory files; --prune-memory deletes it and them, for good",
    },
  ]);
  expect(api.writes().filter((c) => c.method === "DELETE")).toEqual([]);

  const plan = await api.client().deploy(loadAgentsFile(path), {
    prune: true,
    pruneMemory: true,
    dryRun: true,
  });
  expect(plan.changes.map((c) => c.text)).toEqual([
    "delete agent helper (not in the file; its triggers, its 3 memory files and its open sessions go)",
  ]);
  expect(api.byName("helper")).toBeDefined();
  await api.client().deploy(loadAgentsFile(path), { prune: true, pruneMemory: true });
  expect(api.byName("helper")).toBeUndefined();
});

test("an interrupted deploy is finished by the next, repeating nothing", async () => {
  const api = new FakeApi();
  const dir = folder({ "runtime.yml": FILE, "AGENTS.md": AGENTS_MD });
  const source = () => loadAgentsFile(join(dir, "runtime.yml"));
  api.fail = (method, path) =>
    method === "POST" && path.endsWith("/triggers") && api.triggers.size === 1;
  const done: string[] = [];
  await expect(
    api.client().deploy(source(), { onChange: (c) => done.push(c.action) }),
  ).rejects.toThrow("refused here");
  expect(done).toEqual(["create", "add-trigger"]);
  api.fail = undefined;
  const rest = await api.client().deploy(source());
  expect(actions(rest)).toEqual(["add-trigger fixer", "create helper"]);
  expect([...api.agents.values()].map((a) => a.name)).toEqual(["fixer", "helper"]);
  expect(api.triggers.size).toBe(2);
});

test("a create whose key once made an agent deleted since makes it again", async () => {
  const api = new FakeApi();
  const dir = folder({ "AGENTS.md": AGENTS_MD });
  const path = join(dir, "runtime.yml");
  const one = "agents:\n  solo:\n    command: ./agent.sh\n";
  writeFileSync(path, one);
  await api.client().deploy(loadAgentsFile(path));
  const first = api.byName("solo")!.id;
  writeFileSync(path, "agents: {}\n");
  await api.client().deploy(loadAgentsFile(path), { prune: true });
  writeFileSync(path, one);
  // The same plan, so the same key, which the API answers with the deleted
  // agent (404): the deploy makes it again under a fresh key.
  const again = await api.client().deploy(loadAgentsFile(path));
  expect(actions(again)).toEqual(["create solo"]);
  expect(api.byName("solo")!.id).not.toBe(first);
});

test("a trigger paused, resumed and paused again with the same words ends paused: each key is its state's", async () => {
  const api = new FakeApi();
  const dir = folder({});
  const path = join(dir, "runtime.yml");
  const file = (paused: boolean) =>
    `agents:\n  solo:\n    command: ./agent.sh\n    triggers:\n      - kind: webhook\n${paused ? "        paused: Holding for the release.\n" : ""}`;
  const deploy = () => api.client().deploy(loadAgentsFile(path));
  writeFileSync(path, file(false));
  await deploy();
  const [hook] = [...api.triggers.values()];
  const keys: string[] = [];
  for (const paused of [true, false, true]) {
    writeFileSync(path, file(paused));
    const done = await deploy();
    expect(actions(done)).toEqual([`${paused ? "pause" : "resume"}-trigger solo`]);
    keys.push(done.changes[0]!.key);
    expect(api.triggers.get(hook!.id)!.pausedWhy).toBe(paused ? "Holding for the release." : null);
  }
  // The second pause is not the first one's replay.
  expect(new Set(keys).size).toBe(3);
  expect((await deploy()).changes).toEqual([]);
});

test("an agent pruned and made again gets its own triggers, made and held, never the deleted one's", async () => {
  const api = new FakeApi();
  const dir = folder({});
  const path = join(dir, "runtime.yml");
  const one =
    "agents:\n  solo:\n    command: ./agent.sh\n    triggers:\n      - kind: webhook\n        paused: Not yet.\n";
  writeFileSync(path, one);
  await api.client().deploy(loadAgentsFile(path));
  const first = api.byName("solo")!.id;
  writeFileSync(path, "agents: {}\n");
  await api.client().deploy(loadAgentsFile(path), { prune: true });
  expect(api.triggers.size).toBe(0);
  writeFileSync(path, one);
  const again = await api.client().deploy(loadAgentsFile(path));
  expect(actions(again)).toEqual(["create solo", "add-trigger solo"]);
  const solo = api.byName("solo")!;
  expect(solo.id).not.toBe(first);
  expect([...api.triggers.values()].map((t) => [t.agentId, t.kind, t.pausedWhy])).toEqual([
    [solo.id, "webhook", "Not yet."],
  ]);
});

test("a webhook a deploy adds hands back its secret, this once; a dry run and a rerun have none", async () => {
  const api = new FakeApi();
  const dir = folder({});
  const path = join(dir, "runtime.yml");
  writeFileSync(
    path,
    "agents:\n  solo:\n    command: ./agent.sh\n    triggers:\n      - kind: webhook\n",
  );
  const plan = await api.client().deploy(loadAgentsFile(path), { dryRun: true });
  expect(plan.changes.map((c) => ("secret" in c ? c.secret : undefined))).toEqual([
    undefined,
    undefined,
  ]);
  const made = await api.client().deploy(loadAgentsFile(path));
  const [hook] = [...api.triggers.values()];
  expect(made.changes[1]).toMatchObject({
    action: "add-trigger",
    triggerId: hook!.id,
    secret: `rtat_${hook!.id.replaceAll("-", "")}`,
  });
  // Kept nowhere else: the trigger as listed has none, and a rerun adds nothing.
  expect(hook).not.toHaveProperty("secret");
  expect((await api.client().deploy(loadAgentsFile(path))).changes).toEqual([]);
});

test("a trigger's rules are added with it, then changed in place: its secret stays", async () => {
  const api = new FakeApi();
  const dir = folder({});
  const path = join(dir, "runtime.yml");
  const file = (rules: string) =>
    `agents:\n  alerts:\n    command: ./agent.sh\n    triggers:\n      - kind: webhook\n        rules: ${rules}\n`;
  writeFileSync(path, file('{ key: "{cause}", maxStartsPerHour: 60, onEnded: ask }'));
  await api.client().deploy(loadAgentsFile(path));
  const [hook] = [...api.triggers.values()];
  expect(hook!.rules).toEqual({ key: "{cause}", maxStartsPerHour: 60, onEnded: "ask" });
  expect((await api.client().deploy(loadAgentsFile(path))).changes).toEqual([]);
  writeFileSync(path, file('{ key: "{cause}", priority: 10 }'));
  const changed = await api.client().deploy(loadAgentsFile(path));
  expect(changed.changes.map((c) => c.action)).toEqual(["set-trigger-rules"]);
  expect([...api.triggers.values()]).toEqual([
    expect.objectContaining({ id: hook!.id, rules: { key: "{cause}", priority: 10 } }),
  ]);
  // A rule the API would refuse is named before anything is sent.
  expect(() => checkAgentsFile(parseAgentsFile(file("{ onEnded: hold, priority: 500 }")))).toThrow(
    "agents.alerts.triggers.0.rules.onEnded takes",
  );
});
