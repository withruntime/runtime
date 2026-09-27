---
name: switch-to-runtime
description: Move a project's sandbox code from another provider (E2B, Daytona, Modal, Vercel Sandbox, Blaxel, Cloudflare Sandbox, Fly, Docker) to Runtime Cloud, test it on the free trial and report the monthly saving. Use when the user asks to switch, migrate or compare sandbox providers, or to set up Runtime for a project.
---

# Switch a project to Runtime Cloud

Runtime keeps the switch guide current. Read it first with the `runtime` MCP
server: `runtime_docs_read` with topic `migrate` (or
https://withruntime.com/docs/migrate.md), and follow it step by step. For a
project with no sandbox code yet, read topic `start` instead.

In short, the guide has you:

1. Find the old provider's calls: dependencies, imports, creation, commands,
   files, background processes and cleanup, and the names (never the values)
   of its environment variables.
2. Map each call to Runtime. Code written for E2B, Daytona, Vercel Sandbox or
   Blaxel often needs only its import changed to `withruntime/e2b`,
   `withruntime/daytona`, `withruntime/vercel` or `withruntime/blaxel` (Python
   `withruntime.e2b`, `withruntime.daytona`, `withruntime.vercel`,
   `withruntime.blaxel`).
   Agent frameworks have ready integrations: see topic `frameworks`.
3. Connect with one approval (`runtime_connect`, or `npx -y withruntime login`)
   and run the project's own tests on the free trial with `funding: "trial"`.
   Never spend paid credit, and never touch the old provider's account.
4. Report what passed, what did not and why, and the monthly saving the guide
   shows how to work out.

Keep the change reviewable: replace the provider's calls, do not restructure
the application around them.
