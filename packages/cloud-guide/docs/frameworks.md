# Use Runtime with your AI framework

Keep your framework's model and agent loop, and run the code it writes in a Runtime sandbox.

Every integration below is ready to install. Each runs in its framework's own
agent loop, was tested against real sandboxes, and keeps your model, prompts and
application as they are.

| Framework                                             | Language           | What you add                                                             |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| [OpenAI Agents SDK](#openai-agents-sdk)               | Python, TypeScript | A sandbox client for `SandboxAgent`, or four function tools              |
| [Vercel AI SDK](#vercel-ai-sdk)                       | TypeScript         | `runtimeTools(sbx)` from `withruntime/ai`                                |
| [Claude Agent SDK](#claude-agent-sdk)                 | TypeScript         | `runtimeMcpServer(sbx)` from `withruntime/claude-agent-sdk`              |
| [LangChain and LangGraph](#langchain)                 | Python             | `sandbox_tools(sbx)` as LangChain tools                                  |
| [Deep Agents](#deep-agents)                           | Python             | `RuntimeSandbox(sbx)` as the agent's backend                             |
| [Mastra](#mastra)                                     | TypeScript         | `runtimeTools(sbx)`, which Mastra agents take as they are                |
| [CrewAI](#crewai)                                     | Python             | `sandbox_tools(sbx)` wrapped with CrewAI's `tool`                        |
| [Google ADK](#google-adk)                             | Python             | `sandbox_tools(sbx)` as the agent's tools                                |
| [LlamaIndex](#llamaindex)                             | Python             | `sandbox_tools(sbx)` as `FunctionTool`s                                  |
| [Pydantic AI](#pydantic-ai)                           | Python             | `sandbox_tools(sbx)` as the agent's tools                                |
| [Any other framework](#any-other-framework)           | Python, TypeScript | `withruntime.tools` or `withruntime/tools`: a name, a schema, a function |
| [Claude Code, Codex, Cursor and more](#coding-agents) | Any                | Runtime's MCP server: `npx -y withruntime mcp`                           |

Six integrations have a guide of their own:

| Guide                                               | Language   | What it does                                                                                   |
| --------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| [Harbor and Terminal-Bench](./harbor)               | Python     | `RuntimeEnvironment` runs each trial in its own microVM, from the task's Dockerfile            |
| [Inspect AI](./inspect)                             | Python     | A sandbox named `runtime` runs each sample from its Dockerfile or `compose.yaml`               |
| [LangChain, LangGraph and Deep Agents](./langchain) | Python     | `langchain-withruntime`: a Deep Agents backend, and the four tools for LangChain and LangGraph |
| [Vercel AI SDK harness agents](./vercel-ai-sdk)     | TypeScript | `createRuntimeSandbox()` runs Claude Code, Codex, OpenCode or Pi under `HarnessAgent`          |
| [ComputeSDK](./computesdk)                          | TypeScript | `@computesdk/runtime`, a provider that runs your `compute.sandbox` code unchanged              |
| [Claude Managed Agents](./claude-managed-agents)    | Any        | Runtime's remote MCP server gives a Managed Agent sandboxes beside its own session container   |

**The four tools** are the same in every framework: `runtime_exec` runs a
command, `runtime_read_file` and `runtime_write_file` move text, and
`runtime_list_files` lists a directory. Relative paths are under `/workspace`,
and output is capped so one noisy command cannot flood the model's context.

- Your application creates the sandbox, binds the tools to it and stops it when
  the work ends. The model chooses commands and paths, never the sandbox or the
  account.
- A framework's own local shell and file tools keep running on your machine;
  switch those off when the sandbox tools replace them.
- Check exit codes, not only that a call succeeded.

## OpenAI Agents SDK

`RuntimeCloudSandboxClient` runs a `SandboxAgent` in a Runtime sandbox: its
shell with PTY sessions and stdin, its file edits and image views, and its
manifest. The agent definition does not change. The
[OpenAI Agents SDK guide](./openai-agents-sdk) covers every option.

```python check
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig
from withruntime.openai_agents import RuntimeCloudSandboxClient, RuntimeCloudSandboxClientOptions

agent = SandboxAgent(name="Coder", instructions="Fix the failing test, then run the suite.")
run_config = RunConfig(
    sandbox=SandboxRunConfig(
        client=RuntimeCloudSandboxClient(),
        options=RuntimeCloudSandboxClientOptions(funding="trial"),
    )
)
result = Runner.run_sync(agent, "The tests are in tests/.", run_config=run_config)
print(result.final_output)
```

Install with `pip install "withruntime[openai-agents]"`. In TypeScript:

```ts
import { run } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import { RuntimeCloudSandboxClient } from "withruntime/openai-agents";

export async function fixTests() {
  const agent = new SandboxAgent({ name: "Coder", instructions: "Fix the failing test." });
  const client = new RuntimeCloudSandboxClient({ create: { funding: "trial" } });
  const result = await run(agent, "The tests are in tests/.", { sandbox: { client } });
  return result.finalOutput;
}
```

For an ordinary `Agent`, `runtimeFunctionTools(sbx)` (TypeScript) or
`[function_tool(f) for f in sandbox_tools(sbx)]` (Python) gives it the four tools.

## Vercel AI SDK

`runtimeTools(sbx)` returns the four tools as AI SDK tools, for `generateText`,
`streamText` and agents.

```ts
import { generateText, stepCountIs, type LanguageModel } from "ai";
import { Sandbox } from "withruntime";
import { runtimeTools } from "withruntime/ai";

export async function solve(model: LanguageModel, prompt: string) {
  await using sbx = await Sandbox.create();
  const { text } = await generateText({
    model,
    tools: runtimeTools(sbx),
    stopWhen: stepCountIs(20),
    prompt,
  });
  return text;
}
```

It needs the `ai` package, version 5 or later. To run a whole harness agent in
the sandbox instead, see the [Vercel AI SDK guide](./vercel-ai-sdk).

## Claude Agent SDK

`runtimeMcpServer(sbx)` is an in-process MCP server with the four tools.
`RUNTIME_TOOL_NAMES` lists them for `allowedTools`.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Sandbox } from "withruntime";
import { RUNTIME_TOOL_NAMES, runtimeMcpServer } from "withruntime/claude-agent-sdk";

export async function solve(prompt: string) {
  await using sbx = await Sandbox.create();
  let answer = "";
  for await (const message of query({
    prompt,
    options: {
      mcpServers: { runtime: runtimeMcpServer(sbx) },
      allowedTools: RUNTIME_TOOL_NAMES,
      disallowedTools: ["Bash", "Read", "Write", "Edit"],
    },
  })) {
    if (message.type === "result" && message.subtype === "success") answer = message.result;
  }
  return answer;
}
```

`disallowedTools` keeps the agent's work off your machine. It needs `zod` beside
the SDK. An agent that should create and manage sandboxes itself can connect
Runtime's own MCP server instead, as in [coding agents](#coding-agents).

## LangChain

`sandbox_tools(sbx)` returns the four tools as plain Python functions with type
hints and docstrings, which LangChain's `tool` turns into LangChain tools. They
work in `create_agent`, a LangGraph `ToolNode` and anywhere else LangChain
takes tools.

```python check
from langchain.agents import create_agent
from langchain_core.tools import tool
from withruntime import Sandbox
from withruntime.tools import sandbox_tools


def solve(model, task: str) -> str:
    with Sandbox.create() as sbx:
        agent = create_agent(model, tools=[tool(f) for f in sandbox_tools(sbx)])
        result = agent.invoke({"messages": [{"role": "user", "content": task}]})
        return result["messages"][-1].content
```

The [LangChain guide](./langchain) covers `langchain-withruntime`, the package
LangChain lists.

## Deep Agents

`RuntimeSandbox(sbx)` is a Deep Agents sandbox backend: the agent's `execute`,
`ls`, `read_file`, `write_file`, `edit_file`, `glob` and `grep` all run in the
sandbox.

```python check
from deepagents import create_deep_agent
from withruntime import Sandbox
from withruntime.deepagents import RuntimeSandbox


def solve(task: str) -> str:
    with Sandbox.create() as sbx:
        agent = create_deep_agent(backend=RuntimeSandbox(sbx))
        result = agent.invoke({"messages": [{"role": "user", "content": task}]})
        return result["messages"][-1].content
```

Install with `pip install "withruntime[deepagents]"`.

## Mastra

Mastra agents take AI SDK tools as they are, so `runtimeTools(sbx)` from
`withruntime/ai` is the whole integration:
`new Agent({ id: "coder", name: "Coder", instructions, model, tools: runtimeTools(sbx) })`.

## CrewAI

```python check
from crewai import Agent, Crew, Task
from crewai.tools import tool
from withruntime import Sandbox
from withruntime.tools import sandbox_tools


def fix_tests() -> str:
    with Sandbox.create() as sbx:
        engineer = Agent(
            role="Engineer",
            goal="Make the test suite pass",
            backstory="You work in a Linux sandbox.",
            tools=[tool(f) for f in sandbox_tools(sbx)],
        )
        task = Task(description="Run the tests and fix what fails.", expected_output="A summary", agent=engineer)
        return str(Crew(agents=[engineer], tasks=[task]).kickoff())
```

## Google ADK

ADK wraps plain functions as tools, so the four tools go straight in.

```python check
from google.adk.agents import Agent
from withruntime import Sandbox
from withruntime.tools import sandbox_tools


def coder(model: str, sbx: Sandbox) -> Agent:
    return Agent(
        name="coder",
        model=model,
        instruction="Run code in the sandbox to answer.",
        tools=sandbox_tools(sbx),
    )
```

## LlamaIndex

```python check
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.tools import FunctionTool
from withruntime import Sandbox
from withruntime.tools import sandbox_tools


def coder(llm, sbx: Sandbox) -> FunctionAgent:
    return FunctionAgent(tools=[FunctionTool.from_defaults(fn=f) for f in sandbox_tools(sbx)], llm=llm)
```

## Pydantic AI

```python check
from pydantic_ai import Agent
from withruntime import Sandbox
from withruntime.tools import sandbox_tools


def solve(model, task: str) -> str:
    with Sandbox.create() as sbx:
        return Agent(model, tools=sandbox_tools(sbx)).run_sync(task).output
```

## Any other framework

`sandbox_tools(sbx)` gives any framework that takes typed, documented
functions the four tools. Pass an `AsyncSandbox` and they are coroutines. Try
them without a model:

```python
from withruntime import Sandbox
from withruntime.tools import sandbox_tools

with Sandbox.create() as sbx:
    run, read, write, ls = sandbox_tools(sbx)
    print(write("hello.py", "print(6 * 7)\n"))
    print(run("python3 hello.py"))
    print(ls("."))
```

In TypeScript, `withruntime/tools` gives each tool as a name, a description, a
JSON Schema and a function, ready for any tool format:

```ts
import { Sandbox } from "withruntime";
import { sandboxTools } from "withruntime/tools";

await using sbx = await Sandbox.create();
for (const t of sandboxTools(sbx)) console.log(t.name, Object.keys(t.inputSchema.properties));
const [exec] = sandboxTools(sbx);
console.log(await exec.execute({ command: "python3 -c 'print(6 * 7)'" }));
```

## Coding agents

Claude Code, Codex, Cursor, Windsurf, VS Code, Gemini CLI and any other MCP
client connect to Runtime's own MCP server, which offers every Runtime product
as tools. The first call shows a link and a code to approve in the browser;
there is no key to copy. [MCP](./mcp) covers the tools and the remote endpoint.

```bash no-run
claude mcp add --scope user runtime -- npx -y withruntime mcp
codex mcp add runtime -- npx -y withruntime mcp
gemini mcp add --scope user runtime npx -y withruntime mcp
```

Cursor (`.cursor/mcp.json`) and Windsurf (`~/.codeium/windsurf/mcp_config.json`)
take the same file:

```json
{
  "mcpServers": {
    "runtime": { "command": "npx", "args": ["-y", "withruntime", "mcp"] }
  }
}
```

VS Code takes it in `.vscode/mcp.json`:

```json
{
  "servers": {
    "runtime": { "type": "stdio", "command": "npx", "args": ["-y", "withruntime", "mcp"] }
  }
}
```

## What was verified

- Every sample on this page is typechecked or compiled against the current SDK
  on every build, and the samples that need no model run.
- On 23 September 2026 each integration ran in its framework's own agent loop
  against real trial sandboxes, driven by scripted models so no model was paid
  for: OpenAI Agents SDK 0.22.3 (Python) and 0.18.0 (TypeScript), AI SDK
  7.0.87, Claude Agent SDK 0.3.277, LangChain 1.4, LangGraph 1.2, Deep Agents
  0.7.18, Mastra 1.69.0, Pydantic AI 2.48, Google ADK 2.9, LlamaIndex 0.14 and
  CrewAI 1.15. The OpenAI sandbox client also passed PTY sessions with stdin,
  manifests, users, exposed ports, tar and snapshot persistence, pause and
  resume.
- `claude mcp list`, `codex mcp list` and `cursor-agent mcp list-tools` each
  reached the MCP server from the configuration above.

Official references checked {{checked:vercel}}:
[OpenAI Agents SDK sandbox clients](https://openai.github.io/openai-agents-python/sandbox/clients/),
[Vercel tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
[Claude Agent SDK custom tools](https://platform.claude.com/docs/en/agent-sdk/custom-tools),
[LangChain tools](https://docs.langchain.com/oss/python/langchain/tools),
[Mastra tools](https://mastra.ai/docs/agents/using-tools).
