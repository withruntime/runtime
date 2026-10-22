# smolagents-withruntime

Run the Python a [smolagents](https://github.com/huggingface/smolagents)
`CodeAgent` writes in a [Runtime Cloud](https://withruntime.com) sandbox, a
Firecracker microVM with its own Linux kernel, instead of in your own process.
It is a smolagents remote executor, like the E2B, Modal and Blaxel ones:
variables, imports and files persist between the agent's steps.

```bash
pip install smolagents-withruntime
```

Set `RUNTIME_API_KEY` to a key from
[withruntime.com/account/keys](https://withruntime.com/account/keys), or run
`npx withruntime login` once on the machine.

```python
from smolagents import CodeAgent, InferenceClientModel
from smolagents_withruntime import RuntimeExecutor

agent = CodeAgent(
    tools=[],
    model=InferenceClientModel(),
    executor=RuntimeExecutor(["pandas"]),  # packages to install first
)
try:
    agent.run("Load https://example.com/data.csv and give me the mean of the second column.")
finally:
    agent.cleanup()  # stops the sandbox
```

`RuntimeExecutor(additional_imports, logger=None, allow_pickle=False, *, sandbox=None, timeout_seconds=60, **create)`:

- `**create` takes sandbox fields for a new sandbox, such as `image`, `vcpu`,
  `memory_mib`, `network` or `labels`. The executor owns that sandbox and
  `cleanup()` stops it.
- `sandbox=` runs in a `withruntime.Sandbox` you already have; `cleanup()`
  leaves it running.
- `timeout_seconds` bounds each code step.
- A cell's main result comes back as its value; a figure a cell shows, such as
  a matplotlib plot, comes back as a PIL image.

The package registers `runtime` in the `smolagents.executors` entry point
group, so once smolagents loads executors from it
([huggingface/smolagents#2722](https://github.com/huggingface/smolagents/issues/2722)),
`CodeAgent(..., executor_type="runtime")` works too.

## Tests

```bash
pip install -e . pytest
python -m pytest tests                     # no account needed
RUNTIME_API_KEY=... python scripts/e2e.py  # a real sandbox, no model calls
```
