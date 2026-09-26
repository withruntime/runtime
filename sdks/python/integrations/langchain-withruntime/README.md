# langchain-withruntime

[![PyPI - Version](https://img.shields.io/pypi/v/langchain-withruntime?label=%20)](https://pypi.org/project/langchain-withruntime/#history)
[![PyPI - License](https://img.shields.io/pypi/l/langchain-withruntime)](https://www.apache.org/licenses/LICENSE-2.0)
[![PyPI - Downloads](https://img.shields.io/pepy/dt/langchain-withruntime)](https://pypistats.org/packages/langchain-withruntime)

Runtime sandbox integration for [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview).

[Runtime](https://withruntime.com) runs each sandbox in a Firecracker microVM
with its own kernel. `RuntimeSandbox` is a Deep Agents sandbox backend: the
agent's `execute`, `ls`, `read_file`, `write_file`, `edit_file`, `glob` and
`grep` tools all run in one sandbox.

## Quick install

```bash
pip install langchain-withruntime
```

This installs the Runtime SDK, [`withruntime`](https://pypi.org/project/withruntime/),
and Deep Agents. Set `RUNTIME_API_KEY` to a key from
https://withruntime.com/account/keys, or run `npx -y withruntime login` once on
this machine. A new account starts on a free trial with no card.

## Use it

```python
from deepagents import create_deep_agent
from withruntime import Sandbox

from langchain_withruntime import RuntimeSandbox

with Sandbox.create() as sbx:
    agent = create_deep_agent(
        model="anthropic:claude-sonnet-4-6",
        backend=RuntimeSandbox(sbx),
    )
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "Write fib.py, run it, and show the first 10 numbers."}]}
    )
    print(result["messages"][-1].content)
```

Leaving the `with` block stops the sandbox. The backend works on its own too:

```python
from withruntime import Sandbox

from langchain_withruntime import RuntimeSandbox

with Sandbox.create() as sbx:
    backend = RuntimeSandbox(sbx, timeout_seconds=300)
    print(backend.execute("python3 --version").output)
    backend.write("/workspace/notes.txt", "hello\n")
    print(backend.read("/workspace/notes.txt").file_data["content"])
```

- `timeout_seconds` (default 1800) is the limit for a command that names none;
  a command that runs past it is stopped and its output says so.
- `max_output_chars` (default 100,000) keeps the end of a longer output and
  marks it truncated.
- `Sandbox.create()` takes the sandbox's settings: `image`, `region`, `vcpu`,
  `memory_mib`, `timeout_seconds` (its lease), `network` and more. See the
  [Python SDK guide](https://withruntime.com/docs/python).

## Deep Agents Code

The package registers a `runtime` sandbox provider for Deep Agents Code:

```bash
dcode install langchain-withruntime --package
dcode --sandbox runtime
```

Each session gets a new sandbox, stopped when the session ends.
`--sandbox-id <id>` attaches to a sandbox that is already running and leaves it
running. `RuntimeProvider` is the same
lifecycle in code:

```python
from langchain_withruntime import RuntimeProvider

provider = RuntimeProvider()
backend = provider.get_or_create(timeout=900)  # a new sandbox with a 15 minute lease
try:
    print(backend.execute("uname -r").output)
finally:
    provider.delete(sandbox_id=backend.id)
```

## Where it comes from

`RuntimeSandbox` is maintained in the Runtime SDK as `withruntime.deepagents`
(`pip install "withruntime[deepagents]"` gives the same class). This package
installs it under the `langchain-<provider>` name the other Deep Agents sandbox
packages use and adds the Deep Agents Code provider.

## Tests

```bash
pip install -e . pytest pytest-asyncio langchain-tests
pytest tests/unit_tests                         # offline
RUNTIME_API_KEY=... pytest tests/integration_tests  # real sandboxes
RUNTIME_API_KEY=... python scripts/e2e.py           # a Deep Agent with a scripted model
```

The offline tests run LangChain's standard `SandboxIntegrationTests` against a
stand-in sandbox that executes on the local machine (Linux).

## Documentation

- [LangChain, LangGraph and Deep Agents on Runtime](https://withruntime.com/docs/langchain)
- [Runtime documentation](https://withruntime.com/docs)

## License

Apache-2.0
