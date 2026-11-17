# MCP

Runtime serves two MCP servers over streamable HTTP:

| Server | Address | Key |
| --- | --- | --- |
| Runtime's tools | https://api.withruntime.com/mcp | Your API key, as a bearer token |
| Runtime's docs | https://api.withruntime.com/mcp/docs | None |

The tools are the API's calls, generated from the same spec: for example `runtime_sandboxes_create`, `runtime_sandboxes_exec` and `runtime_sandboxes_previews_create`. The docs server serves the API reference as Markdown, with `search_runtime_docs`, `read_runtime_doc` and `list_runtime_docs`.

## Add them to your agent

Claude Code:

```bash
claude mcp add --transport http runtime https://api.withruntime.com/mcp --header "Authorization: Bearer $RUNTIME_API_KEY"
claude mcp add --transport http runtime-docs https://api.withruntime.com/mcp/docs
```

Other clients take the same addresses. For a client that only runs local servers, add the tools over stdio with `npx -y withruntime mcp`.

## Docs for agents

Every page of these docs is also Markdown at its address with `.md` added, and [llms.txt](https://withruntime.com/llms.txt) lists them all. Each guide ends with a prompt to give your agent.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/mcp.md. Add Runtime's MCP server and its docs server to my agent's configuration, with the key from RUNTIME_API_KEY, then list the tools you have and create, use and delete one sandbox to show they work.
>
> This page as Markdown: https://withruntime.com/docs/mcp.md
