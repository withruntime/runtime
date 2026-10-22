# openai-agents-withruntime

Run an [OpenAI Agents SDK](https://github.com/openai/openai-agents-python)
`SandboxAgent` in a [Runtime Cloud](https://withruntime.com) sandbox, a
Firecracker microVM with its own Linux kernel. Change the sandbox client in
the run configuration; the agent stays the same.

```bash
pip install openai-agents-withruntime
```

Set `RUNTIME_API_KEY` to a key from
[withruntime.com/account/keys](https://withruntime.com/account/keys), or run
`npx withruntime login` once on the machine.

```python
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.entries import File
from openai_agents_withruntime import RuntimeCloudSandboxClient, RuntimeCloudSandboxClientOptions

agent = SandboxAgent(
    name="Analyst",
    instructions="Answer from the files in the workspace.",
    default_manifest=Manifest(entries={"sales.csv": File(content=b"month,total\nJuly,120\nAugust,180\n")}),
)
run_config = RunConfig(
    sandbox=SandboxRunConfig(
        client=RuntimeCloudSandboxClient(),
        options=RuntimeCloudSandboxClientOptions(),
    )
)
result = await Runner.run(agent, "What was the total for both months?", run_config=run_config)
print(result.final_output)
```

## What it supports

- Commands with timeouts, and terminal sessions for `exec_command` and
  `write_stdin`.
- File reads and writes of any size, inside and outside the workspace, and
  commands as other users.
- Manifests: files, directories, git repositories, users and environment.
- `exposed_ports` as Runtime previews, private by default.
- Workspace persistence as a tar archive, or with
  `workspace_persistence="snapshot"` as a Runtime snapshot of the whole
  machine, files, memory and running processes, which a resumed run starts
  from.
- `pause_on_exit=True`: the sandbox pauses instead of stopping, and a resumed
  `RunState` wakes the same machine.

Options include `image`, `snapshot_id`, `vcpu`, `memory_mib`, `region`,
`timeout_seconds`, `labels` and `env`. The full guide is
[withruntime.com/docs/openai-agents-sdk](https://withruntime.com/docs/openai-agents-sdk).

The client is the one in the `withruntime` SDK (`withruntime.openai_agents`);
this package gives it the name Agents SDK users search for and pins
compatible versions of both.

## Tests

```bash
pip install -e . pytest
python -m pytest tests                          # no account needed
RUNTIME_API_KEY=... python scripts/e2e.py       # a real sandbox, no model calls
```

`scripts/e2e.py` runs a `SandboxAgent` through the SDK's own `Runner` with its
`ScriptedModel`, so it calls no model; it starts one sandbox and checks that
the run's cleanup stopped it.
