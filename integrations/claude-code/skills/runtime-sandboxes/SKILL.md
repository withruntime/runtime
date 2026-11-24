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

The `runtime` server uses the key in `RUNTIME_API_KEY`, or the one
`npx -y withruntime login` saved. If the Runtime tools are missing or answer
`unauthorized`, run `npx -y withruntime login` in a terminal: it prints a link
and a code. Show both to the user, wait until they approve in the browser, then
restart the MCP server. Never ask the user to paste a key.

## Run work in a sandbox

1. Choose an `idempotencyKey`, then call `runtime_sandboxes_create`. Check that
   the returned `state` is `running`.
2. Put the code in: `runtime_sandboxes_write` with `id`, `path` and `data` (the
   file's bytes, base64) for a few files, or from the shell
   `tar -cf - -C ./project . | npx -y withruntime sandboxes upload-folder <id> --path /workspace/project`
   for a directory.
3. Call `runtime_sandboxes_exec` with the sandbox `id` and a `command`. Check
   `exitCode`, `timedOut`, `stdoutTruncated` and `stderrTruncated`, not only that
   the call succeeded.
4. For a server or a long job, start it from the shell with
   `npx -y withruntime sandboxes exec <id> --wait false --cmd '<command>'`, which
   returns the running process at once. Follow its output with
   `runtime_sandboxes_process_output` with `id` and `process` (the process's
   `id`).
5. To show a web app, call `runtime_sandboxes_previews_create` with `id` and its
   `port`. A preview is private by default; give the user `urlWithToken`.
6. Copy results out (`runtime_sandboxes_read`, which returns the file's bytes
   base64, or
   `npx -y withruntime sandboxes download-folder <id> --path /workspace/out > out.tar`),
   then call `runtime_sandboxes_delete`, even after a failure. Confirm the
   returned `state` is `deleted` before saying cleanup is done.

`runtime_sandboxes_pause` instead keeps memory and files for later, and a paused
sandbox resumes by itself on the next command. Sandboxes bill for the CPU they
use and the memory they reserve, so delete or pause what you are not using.

## Good habits

- One sandbox per task. Name it (`name`) so it is easy to find again.
- Keep secrets out of commands and files: `runtime_secrets_set` stores a secret,
  and a sandbox created with its name in `secrets` can use it without seeing it.
- For a question about limits, prices or a product, read
  https://withruntime.com/llms.txt rather than guessing.
- When something fails that should work, call `runtime_feedback` with a `kind`
  (`bug`), a short `summary` and the `requestId`, never code or credentials.
