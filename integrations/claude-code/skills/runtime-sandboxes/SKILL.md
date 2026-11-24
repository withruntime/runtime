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
`npx withruntime login` saved. On a computer with neither, it lists one tool,
`runtime_connect`: call it, show the user the link and code it returns, and call
it again once they have approved in the browser; Runtime's tools are then
listed. Never ask the user to paste a key.

## Run work in a sandbox

The machine tools act on every kind of machine: give `product` (`sandboxes`
here) to `runtime_machines_create` and `runtime_machines_list`; the others take
the machine's `id`, whose prefix (`sbx_`) says its kind.

1. For one command and nothing kept, call `runtime_run` with `cmd`: it creates
   a sandbox, runs the command, returns its result and deletes the sandbox.
2. Otherwise call `runtime_machines_create` with `product` `sandboxes` and a
   `name`. Check that the returned `state` is `running`.
3. Put the code in: `runtime_machines_write` with `id`, `path` and `data` (the
   file's bytes, base64) for a few files, or `runtime_machines_upload_folder`
   with a tar archive, or from the shell
   `tar -cf - -C ./project . | npx -y withruntime sandboxes upload-folder <id> --path /workspace/project`
   for a directory.
4. Call `runtime_machines_exec` with the sandbox `id` and `cmd` (text runs in
   `bash -lc`). Check `exitCode`, `stdoutTruncated` and `stderrTruncated`, not
   only that the call succeeded.
5. For a server or a long job, call `runtime_machines_exec` with `wait` set to
   `false`: it returns the running process at once. Follow its output with
   `runtime_machines_process_output` through `runtime_call_tool`.
6. To show a web app, call `runtime_call_tool` with `runtime_previews_create`
   and the sandbox's `id` and `port`. A preview is private by default; give the
   user `urlWithToken`.
7. Copy results out with `runtime_machines_read` (the file's bytes, base64), or
   `npx -y withruntime sandboxes download-folder <id> --path /workspace/out > out.tar`,
   then call `runtime_machines_delete`, even after a failure. Confirm the
   returned `state` is `deleted` before saying cleanup is done.

`runtime_machines_pause` (through `runtime_call_tool`) instead keeps memory and
files for later, and a paused sandbox resumes by itself on the next command.
Sandboxes bill for the CPU they use and the memory they reserve, so delete or
pause what you are not using.

## Good habits

- One sandbox per task. Name it (`name`) so it is easy to find again.
- Any call not listed (fork, snapshots, images, volumes, secrets, domains,
  jobs): find it with `runtime_search_tools` and call it with
  `runtime_call_tool`.
- Keep secrets out of commands and files: `runtime_secrets_set` stores a secret,
  and a sandbox created with its name in `secrets` can use it without seeing it.
- For a question about limits, prices or a product, read
  https://withruntime.com/llms.txt rather than guessing.
- When something fails that should work, call `runtime_feedback_create`
  (through `runtime_call_tool`) with `kind` `bug`, a short `summary` and the
  `requestId`, never code or credentials.
