---
name: runtime-sandboxes
description: Run code in a Runtime Cloud sandbox instead of on this machine. Use when a task needs untrusted or unfamiliar code run, packages installed, a long job, a clean Linux machine, several experiments at once, or a web app shared at a URL.
---

# Runtime Cloud sandboxes

A Runtime sandbox is a Firecracker microVM with its own kernel and disk: Ubuntu
24.04 with Python, Node.js, Bun, git and a compiler, `sudo` without a password,
and `/workspace` as home. The `runtime` MCP server in this plugin gives you its
tools. Read the server's instructions and follow them.

## Connect once

If the only Runtime tool is `runtime_connect`, call it, show the user the link
and code it returns, and call it again after they approve. Every Runtime tool
then appears. Never ask the user for a key.

## Run work in a sandbox

1. Choose an `idempotencyKey`, then `runtime_sandbox_create`. Use
   `funding: "trial"` unless the user said to spend paid credit. Check that the
   returned state is `running`.
2. Put the code in: `runtime_sandbox_files_write` for a few files, or from the shell
   `npx -y withruntime sandbox cp ./project <id>:/workspace/project` for a
   directory.
3. `runtime_sandbox_exec` with the sandbox `id` and a `command`. Check `exitCode`,
   `timedOut` and the truncation flags, not only that the call succeeded.
4. For a server or a long job, `runtime_sandbox_exec` with `"background": true`, then
   `runtime_sandbox_process` with `"action": "read"` to follow it.
5. To show a web app, `runtime_sandbox_previews` with `"action": "create"` for its port. Private previews
   need the returned token; give the user `urlWithToken`.
6. Copy results out (`runtime_sandbox_files_read`, or
   `npx -y withruntime sandbox cp <id>:/workspace/out ./out`), then
   `runtime_sandbox_manage` with `"action": "stop"`, even after a failure.
   Confirm `stopped` before saying cleanup is done.

`"action": "pause"` instead keeps memory and files for later, and a paused
sandbox wakes by itself on the next command. Sandboxes bill for the CPU they
use and the memory they reserve, so stop or pause what you are not using.

## Good habits

- One sandbox per task. Name it (`name`) so it is easy to find again.
- Keep secrets out of commands and files: `runtime_secrets` with `"action": "set"` gives a sandbox
  a secret it can use without seeing.
- For a question about limits, prices or a product, call `runtime_docs_read`
  rather than guessing.
- When something fails that should work, `runtime_feedback` with `"action": "submit"` and a short
  summary and the request id, never code or credentials.
