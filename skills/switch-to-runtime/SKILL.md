---
name: switch-to-runtime
description: Move a project's sandbox code from another provider (E2B, Daytona, Modal, Vercel Sandbox, Blaxel, Cloudflare Sandbox, Fly, Docker) to Runtime Cloud, test it on the free trial and report the monthly saving. Use when the user asks to switch, migrate or compare sandbox providers, or to set up Runtime for a project.
---

# Switch a project to Runtime Cloud

Runtime keeps the switch guides current. Read https://withruntime.com/llms.txt
first, then the Switch guide for the old provider it lists (for example
https://withruntime.com/docs/switch-from-e2b.md), and follow it step by step.
For a project with no sandbox code yet, read
https://withruntime.com/docs/start.md instead.

In short, the guide has you:

1. Find the old provider's calls: dependencies, imports, creation, commands,
   files, background processes and cleanup, and the names (never the values)
   of its environment variables.
2. Map each call to Runtime. Code written for E2B, Daytona, Vercel Sandbox or
   Blaxel often needs only its import changed to `withruntime/e2b`,
   `withruntime/daytona`, `withruntime/vercel` or `withruntime/blaxel` (Python
   `withruntime.e2b`, `withruntime.daytona`, `withruntime.vercel`,
   `withruntime.blaxel`). Morph's TypeScript client needs its import changed
   to `withruntime/morph`. Modal Sandboxes code needs its import changed to
   `withruntime/modal` (Python `from withruntime import modal`). A Worker written for Cloudflare's Sandbox SDK
   needs its import changed to `withruntime/cloudflare`, the `containers`
   block deleted from its Wrangler config and a `RUNTIME_API_KEY` secret.
   Code that calls Fly's Machines API needs only its address changed, to
   `npx withruntime fly-api` (`withruntime/fly`).
   Agent frameworks have ready integrations: see
   https://withruntime.com/integrations.
3. Connect with one approval (`npx -y withruntime login`, which prints a link
   to approve in the browser) and run the project's own tests on Runtime.
   Never touch the old provider's account.
4. Report what passed, what did not and why, and the monthly saving the guide
   shows how to work out.

Keep the change reviewable: replace the provider's calls, do not restructure
the application around them.
