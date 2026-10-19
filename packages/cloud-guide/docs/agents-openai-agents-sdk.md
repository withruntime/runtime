---
launch: agents
---

# The OpenAI Agents SDK as an agent

Your own agent, written on the OpenAI Agents SDK, runs in a sandbox of its own
for each session ([Agents](./agents)). It reaches Runtime's `runtime-agent`
MCP server from `~/.runtime-agent/mcp.json` to wait for words, reply and
finish. Three steps.

## 1. Store a key

```bash no-run
printf %s "$OPENAI_API_KEY" | runtime secrets set OPENAI_API_KEY --host api.openai.com
```

Any OpenAI-compatible endpoint works the same way: store its key as
`OPENAI_API_KEY` with that endpoint's host, and set `env.OPENAI_BASE_URL` in
the definition (for OpenRouter, `https://openrouter.ai/api/v1` and host
`openrouter.ai`).

## 2. Put your code in an image, and create the agent

Your agent is `~/agent.py`, in an image of yours ([custom images](./images))
or a snapshot. A minimal one:

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

A subscription is for your own team's agents; an agent that serves your
customers uses an API key. The OpenAI Agents SDK takes an API key, so this
agent may serve either.
