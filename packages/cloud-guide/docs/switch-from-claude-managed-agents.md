---
launch: agents
---

# Switch from Claude Managed Agents

Run code written for Claude Managed Agents on Runtime Agents by changing the client's base URL and key.

Runtime serves Claude Managed Agents' API (agents, environments, sessions and
session events) at `https://api.withruntime.com/anthropic`. Anthropic's SDKs,
in every language, work unchanged when you point them there with a Runtime
API key. Each session runs in its own Runtime sandbox, a Firecracker microVM,
billed on the CPU it uses; between turns the sandbox pauses and costs only
its disk.

## Change two lines

```ts check
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://api.withruntime.com/anthropic",
  apiKey: process.env.RUNTIME_API_KEY,
});
```

```python check
import os

import anthropic

client = anthropic.Anthropic(
    base_url="https://api.withruntime.com/anthropic",
    api_key=os.environ["RUNTIME_API_KEY"],
)
```

Every Runtime SDK returns the same options from `agents.anthropic()`:
`new Anthropic(await runtime.agents.anthropic())` in TypeScript,
`anthropic.Anthropic(**runtime.agents.anthropic())` in Python, and
`client.Agents.Anthropic()` in Go, `runtime.agents().anthropic()` in Java and
`runtime.agents.anthropic` in Ruby.

The rest of your code stays as it is. Anthropic's quickstart, unchanged after
the client:

```ts check
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://api.withruntime.com/anthropic",
  apiKey: process.env.RUNTIME_API_KEY,
});

const agent = await client.beta.agents.create({
  name: "Coding Assistant",
  model: "claude-opus-5-5",
  system: "You are a helpful coding assistant. Write clean, well-documented code.",
  tools: [{ type: "agent_toolset_20260401" }],
});
const environment = await client.beta.environments.create({
  name: "quickstart-env",
  config: { type: "cloud", networking: { type: "unrestricted" } },
});
const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: environment.id,
  title: "Quickstart session",
});

const stream = await client.beta.sessions.events.stream(session.id);
await client.beta.sessions.events.send(session.id, {
  events: [
    {
      type: "user.message",
      content: [
        {
          type: "text",
          text: "Create a Python script that prints the first 20 Fibonacci numbers.",
        },
      ],
    },
  ],
});
for await (const event of stream) {
  if (event.type === "agent.message") {
    for (const block of event.content) if (block.type === "text") process.stdout.write(block.text);
  } else if (event.type === "agent.tool_use") console.log(`\n[Using tool: ${event.name}]`);
  else if (event.type === "session.status_idle") break;
}
```

## Store your Anthropic key once

Sessions call Claude with your own Anthropic API key, stored once as a Runtime
egress secret. The sandbox holds only a placeholder; Runtime's egress proxy
adds the key on requests to `api.anthropic.com`. Model usage is billed by
Anthropic to that key, and the sandbox by Runtime.

```bash no-run
printf %s "$ANTHROPIC_API_KEY" | npx withruntime secrets set ANTHROPIC_API_KEY --host api.anthropic.com
npx withruntime agents switch anthropic   # checks the key is set and prints the base URL
```

Without the secret, `agents.create` returns `403` with the command above. The
MCP server answers the same with `runtime_agents` action `switch`.

## What runs where

| Claude Managed Agents | On Runtime                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent                 | A Runtime agent whose harness is Claude Code, on the agent's model and effort, with its system prompt, its toolset (a tool's `enabled: false` turns it off) and its MCP servers. Each update is a new version.     |
| Environment           | `packages` (apt, cargo, gem, go, npm, pip) install before the session's first turn; a failed install fails the session. `limited` networking is enforced by the sandbox's own network rules from its first packet. |
| Session               | A Runtime session with its own sandbox, started when the session is created. `title` and `metadata` are kept with it.                                                                                              |
| Events                | `user.message`, `user.interrupt`, `agent.message`, `agent.tool_use`, `agent.mcp_tool_use`, `agent.tool_result`, `session.status_running`, `session.status_idle`, `session.status_terminated` and `session.error`.  |

Limited networking allows the hosts you list, the package registries when
`allow_package_managers` is true, the agent's MCP servers when
`allow_mcp_servers` is true, and `api.anthropic.com` and `registry.npmjs.org`,
which the harness itself needs. The event stream sends events from the moment
it opens; list the events for what came before. Errors use Anthropic's error
shape, so the SDKs raise their own typed errors (`NotFoundError`,
`PermissionDeniedError`).

## What returns an error

A call that does not map returns `400 invalid_request_error` with what to do
instead; nothing is accepted and silently ignored.

| Call or field                                                 | Use instead                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A `custom` tool, and `user.custom_tool_result`                | Give the agent the tool as an MCP server (`mcp_servers` and an `mcp_toolset`)                           |
| `permission_policy: always_ask`, and `user.tool_confirmation` | `always_allow` or `auto`; for a person's approval, a Runtime agent's [ask](./agents#asks-and-the-inbox) |
| `skills`, `multiagent`, `agent_with_overrides`                | Instructions in the system prompt; one session per agent                                                |
| A session on an earlier agent version, `agents.versions.list` | The agent's current version                                                                             |
| `vault_ids`, vaults                                           | [Egress secrets](./security#secrets-sandboxes-never-see)                                                |
| Session `resources`                                           | Environment packages, or ask the agent to clone the repository                                          |
| `budget`                                                      | A Runtime agent's `maxSessionDollars`                                                                   |
| `sessions.update`                                             | Set `title` and `metadata` when the session is created                                                  |
| Session threads                                               | The session's own events                                                                                |
| Self-hosted environments                                      | A `cloud` environment                                                                                   |
| Deployments and deployment runs                               | A Runtime agent's [schedule trigger](./agents#triggers)                                                 |
| Memory stores                                                 | A Runtime agent's [memory](./agents#memory)                                                             |
| Image and document blocks in a message                        | Text; put files in the sandbox with a tool                                                              |
| `model.speed: "fast"`, `model.inference_geo`                  | Leave them out                                                                                          |

Every method of Anthropic's TypeScript SDK (`@anthropic-ai/sdk` 0.128.0) for
these APIs is listed with what it does on Runtime in
`agent-platforms-inventory.json`, in the `withruntime` npm package.

## Limits

An agent's name, description, tools, MCP servers and metadata are at most
8 KiB together, and its system prompt 64 KiB. A message is at most 32 KiB of
text. A session's title and metadata are at most 4 KiB together. An account
holds up to ten times its agent quota in environments. Active agents count
against the account's agent quota; an archived agent stops counting once none
of its sessions is open, and stays readable. The rest are Runtime Agents' own
[limits](./limits).
