# pydantic-ai-withruntime

Runtime sandboxes as a [Pydantic AI](https://ai.pydantic.dev) toolset. Each
agent run gets its own [Runtime](https://withruntime.com) sandbox, a
Firecracker microVM with its own Linux kernel. The sandbox is created when the
run starts and stopped when it ends.

```bash
pip install pydantic-ai-withruntime
npx withruntime login   # or set RUNTIME_API_KEY
```

```python
from pydantic_ai import Agent
from pydantic_ai_withruntime import RuntimeToolset

agent = Agent("anthropic:claude-sonnet-4-6", toolsets=[RuntimeToolset()])
print(agent.run_sync("Fit a line to (1,2), (2,4.1), (3,6.2) with numpy and give the slope.").output)
```

The model sees four tools:

| Tool                 | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `runtime_exec`       | Runs a command under `bash -c` and returns its output |
| `runtime_read_file`  | Reads a text file                                     |
| `runtime_write_file` | Creates or replaces a text file                       |
| `runtime_list_files` | Lists a directory with each entry's type and size     |

Relative paths are under `/workspace`. Output past 20,000 characters is cut
from the front, keeping the end, where errors are.

## Options

- `RuntimeToolset(create={...})` sets each run's sandbox: `vcpu`, `memory_mib`,
  `image`, `network`, `labels` and the rest of `sandboxes.create`. Unless you
  set a `timeout_seconds`, each sandbox gets a 30-minute lease that ends in a
  stop, so a crashed process leaves nothing running.
- `RuntimeToolset(sandbox)` uses an `AsyncSandbox` you created. Every run
  shares it, and it is never stopped for you. Use this to keep files between
  runs, for example with `AsyncRuntime().sandboxes.get_or_create("user-42")`.
- `timeout_seconds`, `max_output_chars` and `root` tune the tools.
  `instructions=None` leaves the agent's instructions unchanged.

## Tests

`tests/` runs the toolset under Pydantic AI's own agent loop, with a scripted
`FunctionModel` and a fake client. `scripts/e2e.py` does the same against the
real API with `RUNTIME_API_KEY` set. It passed on 25 September 2026 with
Pydantic AI 2.50.0: two runs, each in its own sandbox, both stopped.
