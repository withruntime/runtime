# Runtime: instructions for coding agents

This repository holds Runtime's SDKs, the `runtime` CLI, its MCP server and the
agent integrations. [Runtime](https://withruntime.com) runs Linux sandboxes for
AI agents: each is a Firecracker microVM with its own kernel and disk.

## Use Runtime from a project

- Install: `npm install withruntime` (TypeScript SDK, CLI and MCP server) or
  `pip install withruntime` (Python SDK). Go, Java and Ruby SDKs are in `sdks/`.
- Connect once: `npx withruntime login` opens a browser approval; with no
  browser, `npx withruntime login --no-browser` prints a link and a code for
  the person to approve. Until they do, a command exits with
  `connection_pending`; run it again once approved.
- The SDKs read `RUNTIME_API_KEY` when it is set, and the saved connection
  otherwise. Never put a key in a URL, a command line, a browser bundle or a
  committed file.
- MCP: the remote server is `https://api.withruntime.com/mcp` (Streamable
  HTTP, OAuth sign-in), or run it locally with `npx -y withruntime mcp`.
- A project on E2B, Daytona, Vercel Sandbox, Blaxel, Modal, Morph or
  Cloudflare's Sandbox SDK moves by changing its import to Runtime's drop-in
  (`withruntime/e2b` in TypeScript, `withruntime.e2b` in Python, and so on);
  code calling Fly's Machines API points at `npx withruntime fly-api`. The
  steps: https://withruntime.com/docs/migrate.

## Read before writing code

- Quickstart for agents: https://withruntime.com/llms.txt
- Every guide as Markdown: https://withruntime.com/docs/llms.txt
- HTTP API: https://api.withruntime.com/v1/openapi.json
- How an agent gets credentials: https://withruntime.com/auth.md

## Work in this repository

- `packages/cloud-sdk` is the TypeScript SDK, CLI and MCP server; `bun test`
  there runs its tests.
- `sdks/python` is the Python SDK; `python3 -m unittest discover -s tests`
  there runs its tests.
- `integrations/` holds the skills, rules and MCP settings for Claude Code,
  Codex, Cursor, Gemini CLI, VS Code and Windsurf, and the Pydantic AI and
  Google ADK integrations.
- `packages/cloud-guide/docs` are the guides served at
  https://withruntime.com/docs; the SDK tests check samples against them.
- Each release copies this tree from Runtime's main repository. A pull request
  here is reviewed and carried into the next release.

## Agent plugin

The root of this repository is an [Agent Plugin](https://agent-plugins.org):
`plugin.json`, the remote MCP server in `mcp.json`, and the skills in `skills/`
(the same as `integrations/claude-code/skills`).
