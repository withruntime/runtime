# Quickstart

Runtime runs Linux machines: each one is a microVM with its own kernel, disk and network, created in milliseconds. This page creates a sandbox, runs a program in it and deletes it.

## Before you begin

1. Create an API key on the [Keys page](https://withruntime.com/account/keys) of the console, or with [`POST /v2/keys`](./reference/keys#create-a-key).
2. Set it as `RUNTIME_API_KEY` in your environment. Every SDK, the CLI and the MCP server read it from there.
3. Install an SDK: `npm install withruntime` (Node.js 22.12 or later, or Bun) or `pip install withruntime` (Python 3.9 or later).

Signing up takes no card. Creating a sandbox needs one: until a card is added at [withruntime.com/account/start](https://withruntime.com/account/start), every call that creates or changes a sandbox answers `402` with the error code `card_required`. Adding the card starts the 7-day Pro trial with $5 of usage. After the trial, Pro costs $25 a month, and that fee is returned as $25 of usage. See [pricing](./pricing).

## Run a program

TypeScript:

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime(); // reads RUNTIME_API_KEY
const sandbox = await runtime.sandboxes.create();
try {
  await sandbox.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
  const result = await sandbox.exec("python3 /workspace/invoice.py");
  console.log(result.stdout); // 750
  if (result.exitCode !== 0) throw new Error(result.stderr);
} finally {
  await sandbox.delete();
}
```

Python:

```python
from withruntime.generated import Runtime

runtime = Runtime()  # reads RUNTIME_API_KEY
sandbox = runtime.sandboxes.create()
try:
    sandbox.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n")
    result = sandbox.exec("python3 /workspace/invoice.py")
    print(result.stdout)  # 750
    assert result.exit_code == 0, result.stderr
finally:
    sandbox.delete()
```

The HTTP API, with curl:

```bash
api=https://api.withruntime.com/v2
auth="Authorization: Bearer $RUNTIME_API_KEY"
id=$(curl -sf -X POST "$api/sandboxes" -H "$auth" -H "Content-Type: application/json" -d '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
trap 'curl -sf -X DELETE "$api/sandboxes/$id" -H "$auth" > /dev/null' EXIT
curl -sf -X POST "$api/sandboxes/$id:exec" -H "$auth" -H "Content-Type: application/json" \
  -d '{"cmd": ["python3", "-c", "print(sum([125, 250, 375]))"]}'
```

What each call does:

- [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox) returns once the sandbox is running. Creates a sandbox. Asked again with the same Idempotency-Key, it returns the same sandbox.
- [`PUT /v2/sandboxes/{id}/files`](./reference/sandboxes#write) Writes the request's bytes to a file as they come, of any size (Content-Length required), its folders made: the file whole when they all came, or as it was. With offset, they are written into it in place.
- [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) Runs a command as a process and returns it once it ended, with its output; with wait false, at once, while it runs. A paused sandbox is resumed first. Asked again with the same Idempotency-Key, it runs nothing more: it returns the first run's process, waiting for its end while it runs. A command that fails is a result with a non-zero `exitCode`, never an error.
- [`DELETE /v2/sandboxes/{id}`](./reference/sandboxes#delete-a-sandbox) ends the sandbox and its billing.

## Next steps

- [Run an agent's code](./agent-loop): a loop that runs model-written code and feeds back its errors.
- [Serve a web app](./web-app): share a port of a sandbox at an HTTPS address.
- [Sandboxes](./sandboxes): what a sandbox is, and its [lifecycle](./lifecycle).
- The [API reference](./reference/overview): every call, field and error.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/start.md and https://withruntime.com/llms.txt, then add Runtime to this project: create a sandbox with the SDK this project's language uses, run the project's real command in it, and delete the sandbox when the command ends. Take the API key from the RUNTIME_API_KEY environment variable and never print it.
>
> This page as Markdown: https://withruntime.com/docs/start.md
