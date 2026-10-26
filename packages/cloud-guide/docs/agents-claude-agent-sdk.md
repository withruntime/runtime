---
launch: agents
---

# The Claude Agent SDK as an agent

Your own agent, written with Anthropic's Claude Agent SDK, runs in its own
sandbox for each session ([Agents](./agents)). It uses Runtime's
`runtime-agent` MCP server, configured in `~/.runtime-agent/mcp.json`, to wait
for input, reply and finish. Three steps.

## 1. Store a key

```bash no-run
printf %s "$ANTHROPIC_API_KEY" | runtime secrets set ANTHROPIC_API_KEY --host api.anthropic.com
```

The SDK accepts an API key for any use.

## 2. Put your code in an image, and create the agent

Your agent is `~/agent.py`, in your own image ([custom images](./images))
or a snapshot. A minimal example:

```python no-run
import asyncio, json, os
from claude_agent_sdk import ClaudeAgentOptions, query

servers = json.load(open(os.path.expanduser("~/.runtime-agent/mcp.json")))["mcpServers"]
start = open(os.path.expanduser("~/.runtime-agent/start.md")).read()

async def main():
    async for message in query(prompt=start, options=ClaudeAgentOptions(mcp_servers=servers)):
        print(message)

asyncio.run(main())
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.agents.create({
  name: "concierge",
  definition: {
    ...runtime.agents.templates["claude-agent-sdk"].definition,
    ...runtime.agents.uses.support.definition,
    from: { image: "concierge:latest" },
    instructions: "You help Acme's customers book a demo.",
  },
});
```

## 3. Start a session

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const session = await runtime.agents.start("concierge", { input: "Hi!", key: "customer:42" });
for await (const event of session.events())
  if (event.kind === "reply") console.log(event.body.text);
```

## The rule

A subscription is for your own team's agents. An agent that serves your
customers uses an API key. The Claude Agent SDK accepts an API key, so this
agent may serve either.
