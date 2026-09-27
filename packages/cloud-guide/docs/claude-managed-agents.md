# Runtime for Claude Managed Agents

Give a Claude Managed Agent Runtime's sandboxes through Runtime's remote MCP server: machines it creates, runs, shares and keeps, beside its own session container.

Claude Managed Agents runs the agent loop and a container for each session on
Anthropic's side. Add Runtime's MCP server to the agent and it can also create
Runtime sandboxes: Firecracker microVMs with their own kernel. They can run
for days, pause with their memory and wake in under a second, share a
port at an HTTPS address, fork, run Docker, and start from your own images.
Runtime bills them for the CPU they use. The Runtime key stays in an
Anthropic vault and never enters the session's container.

## Set it up

You need an Anthropic API key with Managed Agents access and a Runtime key.
Create the Runtime key on the [API keys page](https://withruntime.com/account/keys)
and give it a daily spending limit
([read-only keys and daily limits](./security#read-only-keys-and-daily-limits)),
so the agent's sandboxes can never spend past it.

```bash no-run
pip install anthropic
export RUNTIME_API_KEY=...   # from your secret manager
```

Four calls, made once in a setup script. Store the ids they return:

```python check
import os

import anthropic

client = anthropic.Anthropic()
RUNTIME_MCP = "https://api.withruntime.com/mcp"

# 1. A vault holds the Runtime key. Anthropic adds it to requests to the MCP server.
vault = client.beta.vaults.create(display_name="Runtime")
client.beta.vaults.credentials.create(
    vault.id,
    display_name="Runtime key",
    auth={"type": "static_bearer", "mcp_server_url": RUNTIME_MCP, "token": os.environ["RUNTIME_API_KEY"]},
)

# 2. The agent declares Runtime's server and may use its tools.
agent = client.beta.agents.create(
    name="Builder",
    model="claude-opus-5",
    system="Build and run software in Runtime sandboxes. Stop every sandbox you start unless asked to keep it.",
    mcp_servers=[{"type": "url", "name": "runtime", "url": RUNTIME_MCP}],
    tools=[
        {"type": "agent_toolset_20260401", "default_config": {"enabled": True}},
        {"type": "mcp_toolset", "mcp_server_name": "runtime"},
    ],
)

# 3. An environment for the session's own container.
environment = client.beta.environments.create(
    name="builder", config={"type": "cloud", "networking": {"type": "unrestricted"}}
)

print(vault.id, agent.id, environment.id)
```

Then every run starts a session with the vault attached and sends the task:

```python check
import anthropic

client = anthropic.Anthropic()


def run(agent_id: str, environment_id: str, vault_id: str, task: str) -> str:
    session = client.beta.sessions.create(agent=agent_id, environment_id=environment_id, vault_ids=[vault_id])
    text = []
    with client.beta.sessions.events.stream(session_id=session.id) as stream:
        client.beta.sessions.events.send(
            session_id=session.id,
            events=[{"type": "user.message", "content": [{"type": "text", "text": task}]}],
        )
        for event in stream:
            if event.type == "agent.message":
                text += [block.text for block in event.content if block.type == "text"]
            elif event.type in ("session.status_idle", "session.status_terminated"):
                break
    return "".join(text)
```

A production client also handles a dropped stream and tool confirmations;
Anthropic's
[Managed Agents documentation](https://platform.claude.com/docs/en/managed-agents/overview)
covers both.

## What the agent can do with Runtime

The agent sees every tool of Runtime's [MCP server](./mcp#tools), named
`runtime_<product>_<verb>`. The ones a builder uses most:

| Tool                          | What the agent does with it                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `runtime_sandbox_create`      | Start a sandbox of the size it needs, from Runtime's base image or yours       |
| `runtime_sandbox_exec`        | Run a command and read its exit code and output, or start it in the background |
| `runtime_sandbox_files_write` | Write the files it generated                                                   |
| `runtime_sandbox_previews`    | Share a port at a private HTTPS address under `runtimehost.com`                |
| `runtime_sandbox_manage`      | Pause, wake, extend or stop                                                    |
| `runtime_sandbox_fork`        | Copy a running sandbox, memory included, to try two approaches at once         |
| `runtime_image_build`         | Build an image from a Dockerfile once, so later sandboxes start ready          |

A pattern that uses both machines: the agent writes and tests code in its
session container, then deploys the result to a named Runtime sandbox with a
preview. That sandbox outlives the session. The next session finds it by name,
wakes it, and carries on.

## Keep the agent inside its budget

- **The daily spending limit** on the Runtime key bounds every sandbox the
  agent starts. A create or wake past it fails with `spending_limit_reached`,
  and nothing is charged.
- **A bounded lease.** Sandboxes stop at the end of their lease unless
  extended. Tell the agent in its system prompt to set `timeoutSeconds` and to
  stop what it starts, as the example does.
- **A read-only key** gives a reviewing agent the
  sandboxes, their files and their cost, and nothing it can change.
- **A session budget** on the Managed Agents side caps the model spend of one
  session, independently of Runtime.

## What it costs

CPU is billed as used, $0.025 per vCPU-hour with a floor of 50 millicores, and
reserved memory at $0.0075 per GiB-hour. A 2 vCPU, 4 GiB sandbox costs $0.08 an
hour with both CPUs busy and $0.03125 an hour while it waits. A paused sandbox
pays only storage ([pricing](./pricing)). New accounts get 100 free sandbox
hours, no card.

## What was verified

- On 25 September 2026 an MCP client sent a Runtime key as
  `Authorization: Bearer` to `https://api.withruntime.com/mcp`, the way a vault
  `static_bearer` credential does. It listed 76 tools, created a sandbox, ran
  `uname` and `python3 --version` in it, and stopped it, all in 1.4 seconds.
- The vault, agent and session calls above match `anthropic` 1.8.0 for Python
  on the same day: `vaults.create(display_name=...)`, a `static_bearer`
  credential with `token` and `mcp_server_url`, and `mcp_servers` with
  `mcp_toolset` on the agent.

Official reference checked 25 September 2026:
[Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview).
