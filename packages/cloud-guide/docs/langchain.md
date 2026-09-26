# Runtime for LangChain, LangGraph and Deep Agents

Run a Deep Agent's shell and files, or a LangChain or LangGraph agent's tools, in a Runtime sandbox.

A Deep Agent takes a sandbox as its backend. `RuntimeSandbox` is that backend,
like Deep Agents' Daytona, E2B or Modal sandboxes: pass it to
`create_deep_agent` and the agent's `execute`, `ls`, `read_file`, `write_file`,
`edit_file`, `glob` and `grep` tools run in a Firecracker microVM with its own
kernel, billed for the CPU it uses. LangChain and LangGraph agents get four
sandbox tools instead.

## Deep Agents

```bash no-run
pip install langchain-withruntime
```

`langchain-withruntime` installs the Runtime SDK and Deep Agents.
`pip install "withruntime[deepagents]"` gives the same backend as
`withruntime.deepagents.RuntimeSandbox`.

```python check
from deepagents import create_deep_agent
from langchain_withruntime import RuntimeSandbox
from withruntime import Sandbox


def solve(model, task: str) -> str:
    with Sandbox.create() as sbx:
        agent = create_deep_agent(model=model, backend=RuntimeSandbox(sbx))
        result = agent.invoke({"messages": [{"role": "user", "content": task}]})
        return result["messages"][-1].content
```

The key comes from `RUNTIME_API_KEY` or this machine's `npx withruntime login`,
as for the rest of the SDK. Leaving the `with` block stops the sandbox.
`Sandbox.create()` takes the sandbox's settings, such as `image`, `region`,
`vcpu`, `memory_mib` and `timeout_seconds`; see the [Python guide](./python).

`RuntimeSandbox(sbx)` takes two options:

| Option             | Default | What it does                                                                                 |
| ------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `timeout_seconds`  | 1800    | The limit for a command that names none. A command past it is stopped and its output says so |
| `max_output_chars` | none    | Keep only the end of a longer output and mark it truncated                                   |

Output comes back whole by default. Deep Agents moves a long result out of the
model's context on its own, and its file tools read the output of the commands
they run, so `max_output_chars` applies to those too.

### Deep Agents Code

The package registers a `runtime` sandbox provider, so Deep Agents Code runs a
session in a new Runtime sandbox and stops it when the session ends:

```bash no-run
dcode install langchain-withruntime --package
dcode --sandbox runtime
```

`--sandbox-id` attaches to a sandbox that is already running and leaves it
running. `RuntimeProvider` is the same lifecycle in your own code:

```python check
from langchain_withruntime import RuntimeProvider

provider = RuntimeProvider()
backend = provider.get_or_create(timeout=900)  # a new sandbox with a 15 minute lease
try:
    print(backend.execute("uname -r").output)
finally:
    provider.delete(sandbox_id=backend.id)
```

`get_or_create` passes other keywords to `Sandbox.create`, and `delete` stops
the sandbox.

## LangChain

`sandbox_tools(sbx)` returns four tools as plain Python functions:
`runtime_exec`, `runtime_read_file`, `runtime_write_file` and
`runtime_list_files`. LangChain's `tool` turns them into LangChain tools for
`create_agent` or anything else that takes tools.

```bash no-run
pip install withruntime langchain
```

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

## LangGraph

The same tools go in a `ToolNode`:

```python check
from langchain_core.tools import tool
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from withruntime.tools import sandbox_tools


def build(model, sbx):
    tools = [tool(f) for f in sandbox_tools(sbx)]
    bound = model.bind_tools(tools)

    def call_model(state: MessagesState):
        return {"messages": [bound.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("model", call_model)
    graph.add_node("tools", ToolNode(tools))
    graph.add_edge(START, "model")
    graph.add_conditional_edges("model", tools_condition)
    graph.add_edge("tools", "model")
    return graph.compile()
```

Relative paths are under `/workspace`, and each tool's output is capped so one
noisy command cannot flood the model's context. The
[frameworks guide](./frameworks) has the same tools for other frameworks.

## What runs in the sandbox

- **Commands.** `execute` runs its command under `bash -c` in `/workspace`,
  the sandbox's home directory. Its output is stdout then stderr; a command
  that runs out of time is stopped, and the output says so.
- **Files.** `write_file` and `edit_file` create parent directories. Files
  under `/workspace` move through Runtime's Files API; files anywhere else move
  through a staged copy in `/workspace/.deepagents-staging` that is removed
  afterwards. The file tools act as the sandbox user, `runtime`, so `/tmp`
  works and a system directory does not; `execute` can still run `sudo`.
- **Search and reading.** `ls`, `read_file`, `edit_file`, `glob` and the
  preflight of `write_file` run short `python3` scripts in the sandbox, and
  `grep` runs GNU `grep`. The default image has both; a custom
  [image](./images) needs them too.
- **Deep Agents' own files**, such as its to-do list and memory, stay in the
  agent's state, as with every Deep Agents sandbox.

## What was verified

On 25 September 2026, with Deep Agents 0.7.19, LangChain 1.4.2, LangGraph
1.2.12, langchain-tests 1.1.9, Deep Agents Code 0.1.77 and Python 3.12, and
with the sandbox replaced by a stand-in that runs each command on a Linux
machine and serves `/workspace` from a directory:

- LangChain's standard sandbox suite, `SandboxIntegrationTests`, ran against
  `RuntimeSandbox`: 79 of its 86 cases passed. The other seven expect
  behaviour Deep Agents 0.7 changed (`write_file` now overwrites a file, and
  `glob` returns absolute paths); they fail the same way on a bare
  `BaseSandbox` with no Runtime code in it.
- `create_deep_agent`, driven by a scripted model, called `write_file`,
  `edit_file`, `read_file`, `execute`, `ls`, `glob` and `grep` through
  `RuntimeSandbox`, and each returned what it should.
- Deep Agents Code found the `runtime` provider through its entry point.
- The LangChain and LangGraph samples above ran to a final answer with a
  scripted model calling `runtime_exec` on a stand-in sandbox.

That run found one defect, fixed in `withruntime` 0.6.1: `RuntimeSandbox` cut
any output past 100,000 characters, which broke `read_file` on files larger
than about 75 KB. `langchain-withruntime` requires 0.6.1 or later.

On 23 September 2026, `RuntimeSandbox` ran in Deep Agents 0.7.18's own
agent loop against real trial sandboxes, driven by a scripted model, as the
[frameworks guide](./frameworks#what-was-verified) records.
