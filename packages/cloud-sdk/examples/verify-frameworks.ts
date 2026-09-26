import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, Runner, type RunItem } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from "@openai/agents/testing";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { runtimeTools } from "../src/ai/index";
import { runtimeMcpServer } from "../src/claude-agent-sdk/index";
import { RuntimeCloudSandboxClient, runtimeFunctionTools } from "../src/openai-agents/index";
import { sandboxTools } from "../src/tools/index";
import { Runtime, type Sandbox } from "../src/index";
import { resolveCredential } from "../src/credentials";

/* Every framework integration against real Runtime sandboxes, with scripted
   models: the frameworks' own agent loops run, and no paid model is called.

     bun examples/verify-frameworks.ts   # RUNTIME_API_KEY or `runtime login`

   Creates trial sandboxes and stops every one of them. */

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const toolOutputs = (items: RunItem[]) =>
  items
    .filter((item) => item.type === "tool_call_output_item")
    .map((item) => JSON.stringify(item.rawItem));

export async function verifyFrameworks(runtime: Runtime, sandbox: Sandbox, key?: string) {
  const results: Record<string, string> = {};

  // withruntime/tools: the four tools every adapter wraps.
  const [exec, read, write, list] = sandboxTools(sandbox);
  assert.match(
    await write.execute({ path: "demo/app.py", content: "print(6 * 7)\n" }),
    /^Wrote 13 bytes/,
  );
  assert.deepEqual(await exec.execute({ command: "python3 demo/app.py" }), {
    exitCode: 0,
    stdout: "42\n",
    stderr: "",
    timedOut: false,
  });
  assert.equal(await read.execute({ path: "demo/app.py" }), "print(6 * 7)\n");
  assert.match(JSON.stringify(await list.execute({ path: "demo" })), /app\.py/);
  assert.equal((await exec.execute({ command: "sleep 5", timeoutSeconds: 1 })).timedOut, true);
  await write.execute({ path: "/tmp/outside.txt", content: "outside" });
  assert.equal(await read.execute({ path: "/tmp/outside.txt" }), "outside");
  results.tools = "passed";

  // withruntime/ai: an AI SDK agent loop calling the tool, then answering.
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "runtime_exec",
            input: JSON.stringify({ command: "echo from-ai-sdk" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    ],
  });
  const generated = await generateText({
    model,
    tools: runtimeTools(sandbox),
    stopWhen: stepCountIs(3),
    prompt: "go",
  });
  assert.match(JSON.stringify(generated.steps[0]?.toolResults), /from-ai-sdk/);
  results.aiSdk = "passed";

  // withruntime/claude-agent-sdk: the in-process MCP server, over MCP.
  const server = runtimeMcpServer(sandbox);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-agent-sdk-check", version: "1" });
  try {
    await server.instance.connect(serverSide);
    await client.connect(clientSide);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "runtime_exec",
      "runtime_list_files",
      "runtime_read_file",
      "runtime_write_file",
    ]);
    const called = await client.callTool({
      name: "runtime_exec",
      arguments: { command: "echo from-claude" },
    });
    assert.notEqual(called.isError, true);
    assert.match(JSON.stringify(called), /from-claude/);
  } finally {
    await client.close();
    await server.instance.close();
  }
  results.claudeAgentSdk = "passed";

  // withruntime/openai-agents, function tools on an ordinary Agent.
  const plain = await new Runner({ tracingDisabled: true }).run(
    new Agent({
      name: "plain",
      model: new ScriptedModel([
        [functionCall("runtime_exec", { command: "echo from-function-tool" }, { callId: "f1" })],
        [assistantMessage("done")],
      ]),
      tools: runtimeFunctionTools(sandbox),
    }),
    "go",
  );
  assert.match(toolOutputs(plain.newItems).join(), /from-function-tool/);
  results.openaiAgentsFunctionTools = "passed";

  // withruntime/openai-agents, the sandbox client under SandboxAgent: shell,
  // a long command polled through write_stdin, a tty, and apply_patch.
  const sandboxClient = new RuntimeCloudSandboxClient({ runtime, create: { funding: "trial" } });
  const scripted = new ScriptedModel([
    [functionCall("exec_command", { cmd: "cat notes.md && whoami && pwd" }, { callId: "s1" })],
    [
      functionCall(
        "exec_command",
        { cmd: "for i in 1 2 3; do echo tick $i; sleep 1; done", yield_time_ms: 500 },
        { callId: "s2" },
      ),
    ],
    // Poll the still-running command by the session id its first answer gave.
    modelResponder((call) => {
      const id = /session ID (\d+)/.exec(JSON.stringify(call.request.input))?.[1];
      return [
        functionCall(
          "write_stdin",
          { session_id: Number(id), chars: "", yield_time_ms: 5000 },
          { callId: "s3" },
        ),
      ];
    }),
    [
      {
        type: "apply_patch_call",
        callId: "s4",
        status: "completed",
        operation: { type: "create_file", path: "hello.txt", diff: "+hello from apply_patch\n" },
      },
    ],
    [functionCall("exec_command", { cmd: "cat hello.txt" }, { callId: "s5" })],
    // A terminal: start python, type into it.
    [
      functionCall(
        "exec_command",
        { cmd: "python3 -q", tty: true, yield_time_ms: 1500 },
        { callId: "s6" },
      ),
    ],
    modelResponder((call) => {
      const ids = [...JSON.stringify(call.request.input).matchAll(/session ID (\d+)/g)];
      const id = Number(ids.at(-1)?.[1]);
      return [
        functionCall(
          "write_stdin",
          { session_id: id, chars: "print(6 * 7)\n", yield_time_ms: 1500 },
          { callId: "s7" },
        ),
      ];
    }),
    [assistantMessage("done")],
  ]);
  const sandboxRun = await new Runner({ tracingDisabled: true }).run(
    new SandboxAgent({
      name: "sandboxed",
      model: scripted,
      instructions: "Work in the sandbox.",
      defaultManifest: {
        entries: { "notes.md": { type: "file", content: "from the manifest\n" } },
      },
    }),
    "go",
    { sandbox: { client: sandboxClient } },
  );
  const outputs = toolOutputs(sandboxRun.newItems).join("\n");
  assert.match(outputs, /from the manifest/);
  assert.match(outputs, /runtime/);
  assert.match(outputs, /tick 1/);
  assert.match(outputs, /tick 3/);
  assert.match(outputs, /hello from apply_patch/);
  assert.match(outputs, /print\(6 \* 7\)\\r\\n42/); // typed into the terminal, answered
  results.openaiAgentsSandboxClient = "passed";

  // Runtime's hosted MCP server, with the same key.
  if (!key) return { ...results, paidModelCalls: 0 };
  const remote = new Client({ name: "coding-agent-check", version: "1" });
  try {
    await remote.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", runtime.transport.baseUrl), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    const result = await remote.callTool({
      name: "runtime_exec",
      arguments: { id: sandbox.id, command: "echo from-remote-mcp" },
    });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /from-remote-mcp/);
  } finally {
    await remote.close();
  }
  results.remoteMcp = "passed";
  return { ...results, paidModelCalls: 0 };
}

if (import.meta.main) {
  const runtime = new Runtime();
  const before = new Set((await (await runtime.sandboxes.list({})).toArray()).map((s) => s.id));
  const sandbox = await runtime.sandboxes.create({ funding: "trial" });
  try {
    console.log(
      JSON.stringify(
        await verifyFrameworks(runtime, sandbox, await resolveCredential(process.env)),
      ),
    );
  } finally {
    await sandbox.stop();
  }
  const left = (await (await runtime.sandboxes.list({})).toArray()).filter(
    (s) => !before.has(s.id) && s.state !== "stopped",
  );
  console.log(JSON.stringify({ leftRunning: left.map((s) => `${s.id} ${s.state}`) }));
}
