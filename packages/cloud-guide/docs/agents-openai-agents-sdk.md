---
launch: agents
---

# The OpenAI Agents SDK as an agent

Your own agent, written with the OpenAI Agents SDK, runs in its own sandbox
for each session ([Agents](./agents)). It uses Runtime's `runtime-agent` MCP
server, configured in `~/.runtime-agent/mcp.json`, to wait for input, reply and
finish. Three steps.

## 1. Store a key

```bash no-run
printf %s "$OPENAI_API_KEY" | runtime secrets set OPENAI_API_KEY --host api.openai.com
```

Any OpenAI-compatible endpoint works the same way. Store its key as
`OPENAI_API_KEY` with that endpoint's host. Set `env.OPENAI_BASE_URL` in the
definition. For OpenRouter, use `https://openrouter.ai/api/v1` and host
`openrouter.ai`.

## 2. Put your code in an image, and create the agent

Your agent is `~/agent.py`, in your own image ([custom images](./images))
or a snapshot. A minimal example:

```python no-run
import asyncio, json, os
from agents import Agent, Runner
from agents.mcp import MCPServerStdio

server = json.load(open(os.path.expanduser("~/.runtime-agent/mcp.json")))["mcpServers"]["runtime-agent"]
start = open(os.path.expanduser("~/.runtime-agent/start.md")).read()

async def main():
    async with MCPServerStdio(params=server) as runtime:
        agent = Agent(name="concierge", instructions=start, mcp_servers=[runtime])
        await Runner.run(agent, "Begin.")

asyncio.run(main())
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.agents.create({
  name: "concierge",
  definition: {
    ...runtime.agents.templates["openai-agents-sdk"].definition,
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
customers uses an API key. The OpenAI Agents SDK accepts an API key, so this
agent may serve either.
