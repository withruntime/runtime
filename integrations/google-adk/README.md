# google-adk-withruntime

[Runtime](https://withruntime.com) sandboxes for
[Google ADK](https://google.github.io/adk-docs/). Each sandbox is a
Firecracker microVM with its own Linux kernel. There are two ways to use one:

```bash
pip install google-adk-withruntime
npx withruntime login   # or set RUNTIME_API_KEY
```

```python
from google.adk.agents import Agent
from google_adk_withruntime import RuntimeCodeExecutor, RuntimeToolset

# The model writes Python blocks; ADK runs them in the sandbox.
analyst = Agent(model="gemini-flash-latest", name="analyst", code_executor=RuntimeCodeExecutor())

# The model calls shell and file tools in the sandbox.
coder = Agent(model="gemini-flash-latest", name="coder", tools=[RuntimeToolset()])
```

- **`RuntimeCodeExecutor`** is an ADK code executor, like
  `ContainerCodeExecutor` or `GkeCodeExecutor`, with no Docker daemon or
  cluster to run. Every block of one executor runs in the same sandbox, each
  in a new `python3` process in `/workspace`, so files carry over. A block
  past `timeout_seconds` (300 by default) is killed and reports exit code 124.
  `create={...}` sets the sandbox (`vcpu`, `memory_mib`, `image`, `network`),
  and `sandbox_id=` runs in one you own.
- **`RuntimeToolset`** gives the model `runtime_exec`, `runtime_read_file`,
  `runtime_write_file` and `runtime_list_files`. It starts its sandbox on
  first use and stops it when the runner closes it. Pass an `AsyncSandbox` to
  use one you own instead; it is never stopped for you.

Both give their own sandbox a 30-minute lease that ends in a stop, so a
crashed process leaves nothing running. The executor keeps that lease
extended while it is open.

## Tests

`tests/` runs both against fake clients;
`uv run --resolution lowest-direct --group test pytest` runs them at the lowest
versions `pyproject.toml` allows. `scripts/e2e.py` runs both through
ADK's own `Runner`, driven by a scripted model, against the real API with
`RUNTIME_API_KEY` set. It passed on 25 September 2026 with google-adk 2.10.0:
ADK ran the model's block in a sandbox, `runtime_exec` ran through function
calling, and both sandboxes were stopped.
