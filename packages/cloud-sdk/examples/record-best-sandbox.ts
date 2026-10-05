import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent as MastraAgent } from "@mastra/core/agent";
import { Runner, type RunItem } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import { ScriptedModel, assistantMessage, functionCall } from "@openai/agents/testing";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { runtimeTools } from "../src/ai/index";
import { runtimeMcpServer } from "../src/claude-agent-sdk/index";
import { RuntimeCloudSandboxClient } from "../src/openai-agents/index";
import { Runtime, type Sandbox } from "../src/index";

/* The recorded runs on the "best sandbox for <tool>" pages
   (packages/cloud-guide/learn/compare/best-sandbox-for-*.md), against real
   Runtime sandboxes. Each framework's own agent loop runs with that
   framework's scripted test model, so no model is paid for; coding agents
   that are CLIs are installed and started in the sandbox.

     bun examples/record-best-sandbox.ts [name ...]   # RUNTIME_API_KEY or `runtime login`

   Prints each run's transcript and stops every sandbox it starts. */

const LABELS = { verify: "best-sandbox-pages" };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** An AI SDK model that makes the given tool calls, one a step, then answers. */
function scripted(calls: { tool: string; input: Record<string, unknown> }[]) {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const call = calls[step++];
      if (!call)
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        };
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `c${step}`,
            toolName: call.tool,
            input: JSON.stringify(call.input),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      };
    },
  });
}

const outputsOf = (items: RunItem[]) =>
  items
    .filter((item) => item.type === "tool_call_output_item")
    .map((item) => {
      const raw = item.rawItem as { output?: unknown };
      return raw.output ?? raw;
    });

type Run = (runtime: Runtime, sbx: () => Promise<Sandbox>) => Promise<unknown>;

const PRIMES = "print([n for n in range(2, 60) if all(n % d for d in range(2, n))])\n";

const RUNS: Record<string, Run> = {
  // The in-process MCP server the Agent SDK's query() is given, called over MCP.
  async "claude-agent-sdk"(_runtime, sbx) {
    const server = runtimeMcpServer(await sbx());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "record", version: "1" });
    await server.instance.connect(serverSide);
    await client.connect(clientSide);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      const wrote = await client.callTool({
        name: "runtime_write_file",
        arguments: { path: "primes.py", content: PRIMES },
      });
      const ran = await client.callTool({
        name: "runtime_exec",
        arguments: { command: "python3 primes.py && uname -sr" },
      });
      return { tools, wrote: wrote.content, ran: ran.content };
    } finally {
      await client.close();
      await server.instance.close();
    }
  },

  // A SandboxAgent whose client is Runtime's; the SDK creates and stops the sandbox.
  async "openai-agents-sdk"(runtime) {
    const client = new RuntimeCloudSandboxClient({ runtime, create: { labels: LABELS } });
    const model = new ScriptedModel([
      [
        functionCall(
          "exec_command",
          {
            cmd: "pip install --quiet pytest 2>&1 | tail -1; python3 -m pytest -q 2>&1 | tail -2",
            yield_time_ms: 60_000,
          },
          { callId: "a" },
        ),
      ],
      [
        {
          type: "apply_patch_call",
          callId: "b",
          status: "completed",
          operation: {
            type: "update_file",
            path: "calc.py",
            diff: "@@\n-def add(a, b):\n-    return a - b\n+def add(a, b):\n+    return a + b\n",
          },
        },
      ],
      [
        functionCall(
          "exec_command",
          { cmd: "python3 -m pytest -q 2>&1 | tail -1" },
          { callId: "c" },
        ),
      ],
      [assistantMessage("Fixed add() and the suite passes.")],
    ]);
    const result = await new Runner({ tracingDisabled: true }).run(
      new SandboxAgent({
        name: "Coder",
        model,
        instructions: "Fix the failing test, then run the suite.",
        defaultManifest: {
          entries: {
            "calc.py": { type: "file", content: "def add(a, b):\n    return a - b\n" },
            "test_calc.py": {
              type: "file",
              content: "from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
            },
          },
        },
      }),
      "The tests are in test_calc.py.",
      { sandbox: { client } },
    );
    return { outputs: outputsOf(result.newItems), final: result.finalOutput };
  },

  // generateText with runtimeTools: the AI SDK's own loop.
  async "vercel-ai-sdk"(_runtime, sbx) {
    const result = await generateText({
      model: scripted([
        { tool: "runtime_write_file", input: { path: "fib.mjs", content: FIB } },
        { tool: "runtime_exec", input: { command: "node fib.mjs && node --version" } },
      ]),
      tools: runtimeTools(await sbx()),
      stopWhen: stepCountIs(4),
      prompt: "Print the first 15 Fibonacci numbers with Node.",
    });
    return result.steps.flatMap((step) => step.toolResults.map((r) => r.output));
  },

  // A Mastra Agent given runtimeTools, generate() running its loop.
  async mastra(_runtime, sbx) {
    const agent = new MastraAgent({
      id: "analyst",
      name: "Analyst",
      instructions: "Answer with numbers you computed in the sandbox.",
      model: scripted([
        { tool: "runtime_write_file", input: { path: "sales.csv", content: SALES } },
        {
          tool: "runtime_exec",
          input: {
            command:
              "python3 -c \"import pandas as pd; d=pd.read_csv('sales.csv'); print(d.groupby('region').revenue.sum().to_string())\"",
          },
        },
      ]),
      tools: runtimeTools(await sbx()),
    });
    const result = await agent.generate("Total revenue by region in sales.csv?", { maxSteps: 4 });
    return result.steps.flatMap((step) => step.toolResults.map((r) => r.payload?.result ?? r));
  },

  // Coding agents that are CLIs: install each in a fresh sandbox and start it.
  "claude-code": cli("npm install -g @anthropic-ai/claude-code", "claude --version"),
  codex: cli("npm install -g @openai/codex", "codex --version"),
  cursor: cli("curl -fsSL https://cursor.com/install | bash", "~/.local/bin/agent --version"),
  devin: cli(
    "curl -fsSL https://cli.devin.ai/install.sh | bash",
    "export PATH=$HOME/.local/bin:$HOME/.devin/bin:$PATH; devin --version; devin worker start --help | head -12",
  ),
  openhands: cli(
    "curl -LsSf https://astral.sh/uv/install.sh | sh && ~/.local/bin/uv tool install openhands --python 3.12",
    "~/.local/bin/openhands --version",
  ),
};

const FIB =
  "let [a, b] = [0, 1];\nconst out = [];\nfor (let i = 0; i < 15; i++) { out.push(a); [a, b] = [b, a + b]; }\nconsole.log(out.join(' '));\n";
const SALES = "region,revenue\nwest,1200\neast,800\nwest,300\nsouth,950\neast,450\n";

function cli(install: string, start: string): Run {
  return async (_runtime, sbx) => {
    const box = await sbx();
    const began = Date.now();
    const installed = await box.exec(`${install} >/tmp/install.log 2>&1; echo exit=$?`, {
      timeoutMs: 600_000,
    });
    const seconds = Math.round((Date.now() - began) / 1000);
    const started = await box.exec(start, { timeoutMs: 60_000 });
    if (!/exit=0/.test(installed.stdout))
      console.error((await box.exec("tail -20 /tmp/install.log")).stdout);
    return {
      install,
      installed: installed.stdout.trim(),
      seconds,
      start,
      out: started.stdout.trim(),
      err: started.stderr.trim(),
    };
  };
}

if (import.meta.main) {
  const runtime = new Runtime();
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(RUNS);
  for (const name of names) {
    const run = RUNS[name];
    assert.ok(run, `no run named ${name}`);
    let box: Sandbox | undefined;
    const sbx = async () => (box ??= await runtime.sandboxes.create({ labels: LABELS }));
    const began = new Date().toISOString();
    try {
      console.log(JSON.stringify({ name, began, result: await run(runtime, sbx) }, null, 2));
    } catch (error) {
      console.log(JSON.stringify({ name, began, error: String(error) }));
    } finally {
      await box?.stop();
    }
  }
  const left = (await (await runtime.sandboxes.list({ labels: LABELS })).toArray()).filter(
    (s) => s.state !== "stopped",
  );
  console.log(JSON.stringify({ leftRunning: left.map((s) => `${s.id} ${s.state}`) }));
}
