# Runtime for the OpenAI Agents SDK

Run a `SandboxAgent`'s shell, files and manifest in a Runtime sandbox, in Python or TypeScript, with the agent unchanged.

`RuntimeCloudSandboxClient` is a sandbox client for the OpenAI Agents SDK, like
its Docker, E2B or Modal clients. Change the client in the run configuration
and the same agent runs in a Firecracker microVM with its own kernel, billed
for the CPU it uses.

## Python

```bash no-run
pip install "withruntime[openai-agents]"
```

```python check
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.entries import File
from withruntime.openai_agents import RuntimeCloudSandboxClient, RuntimeCloudSandboxClientOptions

agent = SandboxAgent(
    name="Analyst",
    instructions="Answer from the files in the workspace.",
    default_manifest=Manifest(entries={"sales.csv": File(content=b"month,total\nJuly,120\nAugust,180\n")}),
)
run_config = RunConfig(
    sandbox=SandboxRunConfig(
        client=RuntimeCloudSandboxClient(),
        options=RuntimeCloudSandboxClientOptions(funding="trial"),
    )
)
print(Runner.run_sync(agent, "How much did sales grow?", run_config=run_config).final_output)
```

The key comes from `RUNTIME_API_KEY` or this machine's `npx withruntime login`,
as for the rest of the SDK. Pass `RuntimeCloudSandboxClient(runtime=AsyncRuntime(...))`
to share a client.

## TypeScript

```bash no-run
npm install withruntime @openai/agents
```

```ts
import { run } from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import { RuntimeCloudSandboxClient } from "withruntime/openai-agents";

export async function analyse() {
  const agent = new SandboxAgent({
    name: "Analyst",
    instructions: "Answer from the files in the workspace.",
    defaultManifest: {
      entries: { "sales.csv": { type: "file", content: "month,total\nJuly,120\nAugust,180\n" } },
    },
  });
  const client = new RuntimeCloudSandboxClient({ create: { funding: "trial" } });
  const result = await run(agent, "How much did sales grow?", { sandbox: { client } });
  return result.finalOutput;
}
```

## Options

Every option is optional.

| Python                    | TypeScript              | What it does                                                                                                   |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `funding`, `image`, ...   | `create`                | How to create the sandbox: `funding`, `region`, `image`, a snapshot, `vcpu`, memory, disk, `name`, `labels`    |
| `snapshot_id`             | `create.snapshot`       | Start from a ready Runtime snapshot, with its files, memory and processes                                      |
| `timeout_seconds`         | `create.timeoutSeconds` | A time limit: the sandbox pauses when it runs out. Left out, it runs while it works                            |
| `extra`                   | `create`                | Any other create field, such as `network` or `volumes`                                                         |
| `env`                     | `env`                   | Set for every command, under the manifest's own environment                                                    |
| `exposed_ports`           | `exposedPorts`          | Ports `resolve_exposed_port` may share as Runtime previews                                                     |
| `preview_visibility`      | `previewVisibility`     | `private` (default): the endpoint carries its token in its query; `public`: anyone with the address, paid only |
| `pause_on_exit`           | `pauseOnExit`           | Pause instead of stopping at the end, so resuming wakes the same machine                                       |
| `workspace_persistence`   | —                       | `tar` (default) or `snapshot`, below                                                                           |
| `snapshot_retention_days` | —                       | Days a `snapshot` persistence snapshot is kept                                                                 |
| `exec_timeout_s`          | `execTimeoutMs`         | The longest a command may run: one hour by default, 24 hours at most                                           |

## What runs in the sandbox

- **Shell with PTY sessions.** `exec_command` returns when the command finishes
  or its yield time passes; a command still running keeps a session that
  `write_stdin` polls. With `tty` it gets a terminal and takes typed input.
- **Files.** Reads, writes and `apply_patch` edits of any size, image views,
  listings, and paths outside the workspace that the manifest grants.
- **The manifest.** Files, directories, local files and directories, git
  repositories, environment variables, and users and groups. Commands with a
  `user` run through `sudo -u`; you are root inside your own sandbox.
- **Exposed ports** become Runtime previews at `runtimehost.com`. A private
  preview's endpoint carries its token, so it works as it is in a browser,
  `fetch`, `curl` or a WebSocket client.

## Keep a workspace between runs

Give the run a snapshot store, such as `LocalSnapshotSpec`, and a stopped
session's workspace comes back when it resumes.

- **`workspace_persistence="tar"`** (the default) keeps the workspace as an
  archive; resuming starts a new sandbox and unpacks it.
- **`workspace_persistence="snapshot"`** keeps the whole machine as a Runtime
  snapshot: the workspace, every other file, installed packages, memory, and
  processes started outside the agent's PTY sessions. Resuming starts a copy
  of it. The snapshot is billed as snapshot storage
  ([pricing](./pricing#snapshots-images-and-volumes)).
- **`pause_on_exit`** pauses the sandbox instead, and resuming wakes the same
  machine where it stopped.

In TypeScript, `pauseOnExit` resumes the same machine, and
`persistWorkspace()` and `hydrateWorkspace()` move a workspace as a tar.

## Function tools for an ordinary agent

An `Agent` that is not a `SandboxAgent` can take the four
[framework tools](./frameworks#any-other-framework): `runtime_exec`,
`runtime_read_file`, `runtime_write_file` and `runtime_list_files`.

```python check
from agents import Agent, function_tool
from withruntime import Sandbox
from withruntime.tools import sandbox_tools


def coder(sbx: Sandbox) -> Agent:
    return Agent(name="Coder", tools=[function_tool(f) for f in sandbox_tools(sbx)])
```

In TypeScript, `runtimeFunctionTools(sbx)` from `withruntime/openai-agents`
returns the same four.

## What was verified

On 23 September 2026 both clients ran `SandboxAgent` in the SDK's own runner
against real trial sandboxes, driven by the SDK's scripted test model:
OpenAI Agents SDK 0.22.3 in Python and 0.18.0 in TypeScript. Between them the
runs covered commands, a long command polled through `write_stdin`, a terminal
session, `apply_patch`, manifests with files, users, git repositories and local
directories, a private preview, tar and snapshot persistence, pause and resume,
and cleanup, with no sandbox left running.
