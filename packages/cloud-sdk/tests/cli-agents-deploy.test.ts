import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { cliRefusal } from "../src/cli-words";
import { RuntimeError } from "../src/errors";

/* `runtime agents init` and `runtime agents deploy` as a person and a script
   read them: init writes a starter section and never a second one; deploy
   checks the file before it needs a key, prints one line per change with
   its idempotency key, and says when there is nothing to change; a dark
   organization reads the beta's refusal in the command's words. */

const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const out = (lines: string[], json = false) => ({
  json,
  write: (t: string) => lines.push(t),
  error: (t: string) => lines.push(`ERR ${t}`),
});

/** The routes a deploy reads and writes, in memory. */
type Sent = { method: string; path: string; key: string | null };
async function withApi(work: (sent: Sent[]) => Promise<void>) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  const agents: Record<string, unknown>[] = [];
  const triggers: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    sent.push({ method: request.method, path, key: request.headers.get("idempotency-key") });
    if (request.method === "GET" && path === "/v1/agents")
      return Response.json({ data: agents, nextCursor: null });
    if (request.method === "POST" && path === "/v1/agents") {
      const body = (await request.json()) as Record<string, unknown>;
      const agent = {
        id: `00000000-0000-4000-8000-00000000000${agents.length + 1}`,
        name: body.name,
        version: 1,
        definition: {
          idlePauseSeconds: 60,
          maxSessionSeconds: 86400,
          maxConcurrent: 10,
          ...(body.definition as object),
        },
        labels: body.labels,
        warnings: [],
        createdAt: "2026-10-18T18:00:00.000Z",
        updatedAt: "2026-10-18T18:00:00.000Z",
      };
      agents.push(agent);
      return Response.json(agent, { status: 201 });
    }
    if (path.endsWith("/triggers")) {
      const agentId = path.split("/")[3];
      if (request.method === "GET")
        return Response.json({ data: triggers.filter((t) => t.agentId === agentId) });
      const body = (await request.json()) as Record<string, unknown>;
      const trigger = {
        id: `00000000-0000-4000-9000-00000000000${triggers.length + 1}`,
        agentId,
        ...body,
        pausedAt: null,
        pausedWhy: null,
        createdAt: "2026-10-18T18:00:00.000Z",
        updatedAt: "2026-10-18T18:00:00.000Z",
      };
      triggers.push(trigger);
      // A webhook's secret is in this answer alone.
      const secret = body.kind === "webhook" ? { secret: `rtat_${"a".repeat(64)}` } : {};
      return Response.json({ ...trigger, ...secret }, { status: 201 });
    }
    return Response.json({ error: { code: "route_not_found", message: path } }, { status: 404 });
  }) as typeof fetch;
  try {
    await work(sent);
  } finally {
    globalThis.fetch = original;
  }
}

test("init writes a starter agents: section with the repo's AGENTS.md, and never a second", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-init-"));
  writeFileSync(join(dir, "AGENTS.md"), "Work carefully.\n");
  const file = join(dir, "runtime.yml");
  const lines: string[] = [];
  expect(
    await run(["agents", "init", "--template", "codex", "--file", file], env, out(lines)),
  ).toBe(0);
  const text = readFileSync(file, "utf8");
  expect(text).toContain("agents:\n  codex:\n    template: codex");
  expect(text).toContain("    instructionsFile: AGENTS.md");
  expect(text).toContain("runtime secrets set OPENAI_API_KEY --host api.openai.com");
  expect(lines.join("\n")).toBe(
    [
      `Wrote agent codex (Codex CLI) to ${file}, with AGENTS.md as its instructions.`,
      "Next:",
      '  printf %s "$OPENAI_API_KEY" | runtime secrets set OPENAI_API_KEY --host api.openai.com',
      "  runtime agents deploy --dry-run",
      "  runtime agents deploy",
    ].join("\n"),
  );
  await expect(run(["agents", "init", "--file", file], env, out([]))).rejects.toThrow(
    "already has an agents: section",
  );
  // A runtime.yml without one gets it added below what is there.
  const other = join(dir, "other.yml");
  writeFileSync(other, "# ours\n");
  expect(
    await run(["agents", "init", "fixer", "--use", "team", "--file", other], env, out([])),
  ).toBe(0);
  expect(readFileSync(other, "utf8")).toStartWith("# ours\n\n# Runtime Agents.");
  expect(readFileSync(other, "utf8")).toContain("  fixer:\n    template: claude-code");
  expect(readFileSync(other, "utf8")).toContain("    use: team");
  await expect(
    run(["agents", "init", "--template", "nope", "--file", other], env, out([])),
  ).rejects.toThrow("--template takes claude-code, codex");
});

test("deploy --dry-run prints one line per change with its key; deploy makes them; a rerun has nothing to do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-deploy-cli-"));
  writeFileSync(join(dir, "AGENTS.md"), "Fix failing tests.\n");
  const file = join(dir, "runtime.yml");
  writeFileSync(
    file,
    `agents:
  fixer:
    template: claude-code
    use: team
    instructionsFile: AGENTS.md
    triggers:
      - kind: webhook
  helper:
    template: gemini-cli
    instructions: Answer briefly.
`,
  );
  await withApi(async (sent) => {
    const dry: string[] = [];
    expect(await run(["agents", "deploy", "--file", file, "--dry-run"], env, out(dry))).toBe(0);
    expect(dry[0]).toBe(`${file}: 2 agents. Dry run: nothing is changed.`);
    expect(dry.slice(1, 4).map((l) => l.replace(/deploy:[0-9a-f]{32}/, "deploy:<key>"))).toEqual([
      "would create agent fixer (claude-code, 4 vCPU, 8192 MiB)  (key deploy:<key>)",
      "would add trigger webhook to fixer  (key deploy:<key>)",
      "would create agent helper (gemini-cli, 4 vCPU, 8192 MiB)  (key deploy:<key>)",
    ]);
    expect(dry.at(-1)).toBe("3 changes planned. Run `runtime agents deploy` to make them.");
    expect(sent.filter((c) => c.method !== "GET")).toEqual([]);

    const made: string[] = [];
    expect(await run(["agents", "deploy", "--file", file], env, out(made))).toBe(0);
    // The keys the dry run showed, but a new agent's trigger's: its key takes
    // the agent's id once it is made, and the line says the key it was sent.
    // Under it, the webhook's secret, printed this once.
    const shown = dry.slice(1, 4).map((l) => l.replace(/^would /, ""));
    expect(made.slice(1, 5)).toEqual([
      shown[0],
      expect.stringMatching(/^add trigger webhook to fixer {2}\(key deploy:[0-9a-f]{32}\)$/),
      `  secret rtat_${"a".repeat(64)}  (shown this once: each of its calls carries it; keep it now)`,
      shown[2],
    ]);
    expect(made[2]).not.toBe(shown[1]);
    const sentKeys = sent.filter((c) => c.method !== "GET").map((c) => c.key ?? undefined);
    expect(
      [made[1], made[2], made[4]].map((l) => /\(key (deploy:[0-9a-f]{32})\)/.exec(l!)![1]),
    ).toEqual(sentKeys);
    expect(made.at(-1)).toBe("Done: 3 changes.");

    const again: string[] = [];
    expect(await run(["agents", "deploy", "--file", file], env, out(again))).toBe(0);
    expect(again).toEqual([
      `${file}: 2 agents.`,
      "unchanged: fixer, helper",
      `Nothing to change: your agents match ${file}.`,
    ]);

    const json: string[] = [];
    expect(
      await run(["agents", "deploy", "--file", file, "--dry-run", "--json"], env, out(json, true)),
    ).toBe(0);
    expect(JSON.parse(json[0]!)).toMatchObject({
      dryRun: true,
      changes: [],
      unchanged: ["fixer", "helper"],
    });
  });
});

test("a mistake in the file is refused before any key or call, naming file, line, agent and field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-deploy-bad-"));
  const file = join(dir, "runtime.yml");
  writeFileSync(file, "agents:\n  fixer:\n    template: claude-code\n    vcpu: 3\n");
  await withApi(async (sent) => {
    const error = await run(["agents", "deploy", "--file", file], {}, out([])).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).message).toBe(
      `${file}:4: agents.fixer.vcpu takes 1, 2, 4, 8 or 16.`,
    );
    expect(sent).toEqual([]);
  });
  await expect(
    run(["agents", "deploy", "--file", join(dir, "missing.yml")], env, out([])),
  ).rejects.toThrow("missing.yml is not there.");
  // Deleting memory is asked for only with the prune it belongs to.
  await expect(
    run(["agents", "deploy", "--file", file, "--prune-memory"], env, out([])),
  ).rejects.toThrow("--prune-memory goes with --prune.");
});

test("an organization outside the beta reads the refusal in the command's words", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-deploy-dark-"));
  const file = join(dir, "runtime.yml");
  writeFileSync(file, "agents:\n  helper:\n    template: claude-code\n");
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      {
        error: {
          code: "product_in_beta",
          message: "Agents is in a private beta.",
          hint: "Agents is open only to the organizations in its beta for now; ask Runtime support (runtime_support) to join it.",
          details: { product: "agents" },
        },
      },
      { status: 403 },
    )) as unknown as typeof fetch;
  try {
    const lines: string[] = [];
    const error = (await run(
      ["agents", "deploy", "--file", file, "--dry-run"],
      env,
      out(lines),
    ).catch((e: unknown) => e)) as RuntimeError;
    expect(lines).toEqual([`${file}: 1 agent. Dry run: nothing is changed.`]);
    expect(error.code).toBe("product_in_beta");
    expect(cliRefusal(error)).toEqual({
      message: "Agents is in a private beta.",
      hint: 'Agents is open only to the organizations in its beta for now. Ask to join: runtime support "Please add us to the agents beta"',
    });
  } finally {
    globalThis.fetch = original;
  }
});
