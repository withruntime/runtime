# MCP

Runtime serves two MCP servers over streamable HTTP:

| Server | Address | Sign-in |
| --- | --- | --- |
| Runtime's tools | https://api.withruntime.com/mcp | OAuth in your browser, or your API key as a bearer token |
| Runtime's docs | https://api.withruntime.com/mcp/docs | None |

The tools are the API's calls, generated from the same spec. The server lists 15 tools, so your agent's context stays small:

| Tools | What they do |
| --- | --- |
| `runtime_machines_create`, `_get`, `_list`, `_delete` | Create, read, list and delete a machine of any product: `product` is `sandboxes`, `apps`, `browsers`, `builds`, `ci`, `containers`, `desktops`, `functions`, `notebooks`, `sites` or `workspaces`. |
| `runtime_machines_exec`, `_run_code`, `_read`, `_write`, `_upload_folder`, `_link`, `_screenshot`, `_act` | Run a command or code, move files, and see and drive a machine's screen. A machine's ID names its product (`brw_…` is a browser's), so these take `product` only when `id` is a machine's name. |
| `runtime_run` | Runs one command in a new sandbox and deletes it after. |
| `runtime_search_tools`, `runtime_call_tool` | Find any other call (fork, snapshots, images, volumes, secrets, domains, jobs and the rest) with its arguments, and call it by name. |

Every tool name the server has ever served still answers when called, 1.0's among them, with the arguments it took and in the words it answered then. The docs server serves the API reference as Markdown, with `search_runtime_docs`, `read_runtime_doc` and `list_runtime_docs`.

## Add them to your agent

Add `https://api.withruntime.com/mcp` as a remote MCP server. Your client opens Runtime in your browser, you sign in and choose the account, and the client receives a key for it. The key is listed at [API keys](https://withruntime.com/account/keys) under the client's name and works until you revoke it there.

Claude and Claude Desktop: open **Settings > Connectors**, choose **Add custom connector**, and paste `https://api.withruntime.com/mcp`. Leave the advanced settings empty.

Claude Code:

```bash
claude mcp add --transport http runtime https://api.withruntime.com/mcp
claude mcp add --transport http runtime-docs https://api.withruntime.com/mcp/docs
```

Then run `/mcp` in Claude Code and choose **runtime** to sign in.

Cursor, VS Code and other clients take the same address. A client that cannot sign in through a browser sends an API key instead, as `Authorization: Bearer $RUNTIME_API_KEY`:

```bash
claude mcp add --transport http runtime https://api.withruntime.com/mcp --header "Authorization: Bearer $RUNTIME_API_KEY"
```

For a client that only runs local servers, add the tools over stdio with `npx -y withruntime mcp` (Node.js 22.12 or later). In Claude Desktop's `claude_desktop_config.json`, Cursor's `mcp.json` and most other clients:

```json
{ "mcpServers": { "runtime": { "command": "npx", "args": ["-y", "withruntime", "mcp"] } } }
```

On a computer that is not signed in, the server lists one tool, `runtime_connect`: your agent calls it and shows you a link and a code to approve in your browser, and Runtime's tools are listed once you have. With `RUNTIME_API_KEY` set, or after `npx withruntime login`, it starts signed in.

### Sign-in for client developers

The server follows the MCP authorization specification. A call without a key is answered `401` with `WWW-Authenticate: Bearer resource_metadata="https://api.withruntime.com/.well-known/oauth-protected-resource/mcp"` (RFC 9728). The authorization server's metadata is at `https://api.withruntime.com/.well-known/oauth-authorization-server` (RFC 8414). Clients register with dynamic client registration (RFC 7591), use the authorization code flow with PKCE `S256`, and authenticate with no secret. The access token is a Runtime API key: it does not expire and has no refresh token.

## Docs for agents

Every page of these docs is also Markdown at its address with `.md` added, and [llms.txt](https://withruntime.com/llms.txt) lists them all. Each guide ends with a prompt to give your agent.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/mcp.md. Add Runtime's MCP server, https://api.withruntime.com/mcp, and its docs server to my agent's configuration, sign in when the browser opens, then list the tools you have and create, use and delete one sandbox to show they work.
>
> This page as Markdown: https://withruntime.com/docs/mcp.md
