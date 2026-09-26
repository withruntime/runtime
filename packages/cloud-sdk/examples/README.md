# Framework integrations, against real sandboxes

`verify-frameworks.ts` runs every JavaScript framework integration in its
framework's own agent loop against real Runtime sandboxes, with scripted models
so no model is paid for: `withruntime/tools`, the Vercel AI SDK tools, the
Claude Agent SDK server, the OpenAI Agents function tools and sandbox client
(commands, a polled long command, a terminal, `apply_patch`), and the hosted
MCP endpoint. It stops every sandbox it starts and prints any left running.

```bash
bun examples/verify-frameworks.ts   # RUNTIME_API_KEY, or this machine's `runtime login`
```

The integrations themselves live in `src/tools`, `src/ai`,
`src/claude-agent-sdk` and `src/openai-agents`. The Python counterparts are
`withruntime.tools`, `withruntime.deepagents` and `withruntime.openai_agents`.
