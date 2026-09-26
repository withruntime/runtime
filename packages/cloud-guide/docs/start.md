# Get started with Runtime Cloud

Runtime Cloud gives your agents Linux sandboxes, billed on the CPU they use, and connects them with one browser approval.

Each sandbox is a Firecracker microVM with its own kernel, disk and toolchain.
One API, one CLI, one MCP server and SDKs for JavaScript and Python cover
every Runtime product. New accounts get [100 free hours](./trial), no card.

- **100 free hours, no card:** enough to run your real workload before you pay.
- **Pay for the CPU you use:** $0.025 per active vCPU-hour, measured, and
  $0.0075 per reserved GiB-hour of memory ([pricing](./pricing)).
- **Pause keeps memory**, and a fork copies a running sandbox with its memory
  and processes.
- **Built in:** a desktop, a code interpreter, custom images, volumes, and
  preview URLs that are private by default.

## Give your agent one instruction

Paste this into your coding agent:

> Set up Runtime Cloud for this project and switch any sandbox work it already
> does to Runtime: read https://withruntime.com/llms.txt and follow it. When it
> asks for my approval, show me the link and code.

The agent connects, runs a test and, if the project uses another sandbox
provider, moves that code to Runtime. It reports what passed and what you save
each month. You approve one link in your browser; there is nothing to copy.

## Run your first sandbox

**One line, with Node 22.12 or later:**

```bash
npx withruntime sandbox run --trial -- python3 -c 'print(6 * 7)'
```

The first time, it connects this machine:

1. Your browser opens a Runtime page, or the command prints a link and a code.
2. You sign in with Google or an email link, check the code and choose
   **Connect agent**.
3. A fresh sandbox runs the command, prints 42 and stops.

Exit code zero means the command succeeded. Confirm cleanup with
`npx withruntime sandbox ls --json`, and stop the test sandbox if it is still
there. `--trial` refuses paid funding even when the account has credit. Later
commands reuse the connection.

An agent running it shows you the link and code. If you approve after the
command stopped waiting (50 seconds when no one is at a terminal), the agent
runs it again and it finishes, with no new link.

For several commands in one sandbox, this shell block stops it on exit:

```bash
(
  id=$(npx withruntime sandbox create --trial) || exit
  trap 'npx withruntime sandbox stop "${id}"' EXIT
  npx withruntime sandbox exec "${id}" -- python3 -c 'print(6 * 7)'
)
```

Installed with `npm install --global withruntime`, the command is `runtime`:
`runtime sandbox run --trial -- ls`, `runtime sandbox create --trial`. See
[the CLI](./cli).

## Give an agent Runtime's tools

Add Runtime's MCP server to your agent with one command:

```bash no-run
claude mcp add --scope user runtime -- npx -y withruntime mcp   # Claude Code
codex mcp add runtime -- npx -y withruntime mcp                 # Codex
```

Cursor: add this to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{ "mcpServers": { "runtime": { "command": "npx", "args": ["-y", "withruntime", "mcp"] } } }
```

If this machine is not connected yet, the agent sees one tool,
`runtime_connect`, which gives it a link for you to approve. Then every Runtime
tool appears. See [MCP](./mcp) for other clients and the remote endpoint.

## From code

```ts
import { Sandbox } from "withruntime";

const sbx = await Sandbox.create({ funding: "trial" });
try {
  const result = await sbx.exec("python3 -c 'print(6 * 7)'", { check: true });
  console.log(result.stdout);
} finally {
  await sbx.stop();
}
```

```python
from withruntime import Sandbox

with Sandbox.create(funding="trial") as sbx:
    print(sbx.exec("python3 -c 'print(6 * 7)'", check=True).stdout)
```

- Install with `npm install withruntime` or `pip install withruntime`.
- The SDKs use `RUNTIME_API_KEY` when it is set, and otherwise the key this
  machine saved when it connected, so after the one line above they need no
  setup.
- On a server, create a key at https://withruntime.com/account/keys and give it
  as `RUNTIME_API_KEY` from your secret manager.
- `create()` needs no arguments. It waits until the sandbox is ready, and
  raises `start_failed` if it stops first.
- The examples insist on trial funding, check the command's result, and stop the
  sandbox even after an error. Export anything you need before stopping.

## Connect once in your browser

**One approval gives this machine its own key.** It is encrypted for this
machine alone and saved outside your project: the CLI receives and saves its
own credential automatically, and you do not copy an API key.

- Each connection can use everything the account can, including its prepaid
  credit, so approve only connections you started.
- Browser sign-out does not revoke one; `npx withruntime logout` or the API
  keys page does. See [security](./security).
- On a machine with no browser, `npx withruntime login --no-browser` prints the
  link to open on another device.
- To use a key you already have, `npx withruntime login --with-key` reads it
  from standard input, never from the command line.

Trial requests never fall back to paid credit. Omitting `funding` can use
prepaid credit after the trial is exhausted. Keep `funding: "trial"` for free
use, and choose `funding: "paid"` when you intend to use credit.

## Switch from another provider

**Most sandbox code moves over call for call.** The [switch guide](./migrate)
maps E2B, Daytona, Vercel, Modal, Cloudflare and Fly calls to Runtime's, and
shows how to work out your monthly saving from measured usage. Code written for
E2B, Daytona or Vercel Sandbox runs after changing one import to
`withruntime/e2b`, `withruntime/daytona` or `withruntime/vercel`.
`npx withruntime compare --from <provider>` prints what you save, and
`npx withruntime switch --from <provider>` before your first top-up gets it
matched, up to $100.

## If the first run fails

Keep the error code, request ID and sandbox ID. A lost response is not proof
that nothing ran: inspect the original resource before trying another create.

| Error                             | What to do                                                                |
| --------------------------------- | ------------------------------------------------------------------------- |
| `connection_pending`              | Approve the printed request, then rerun the same command                  |
| `trial_busy` or `trial_exhausted` | Check your trial usage; add `--paid` only when you decide to use credit   |
| `start_failed`                    | Read the sandbox's state and `stopReason`; a stopped sandbox is not ready |

See [troubleshooting](./troubleshooting) for safe retries and cleanup.

## What you can do next

| You want to                                                        | Read                                             |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| Run commands, stream output, start servers                         | [JavaScript](./javascript) or [Python](./python) |
| Drive sandboxes from a terminal or a script                        | [CLI](./cli)                                     |
| Give an agent Runtime tools                                        | [MCP](./mcp)                                     |
| Call the API from any language                                     | [API reference](./api)                           |
| Know what is installed and what the network allows                 | [The sandbox environment](./sandbox-environment) |
| Plug into the OpenAI Agents SDK, Vercel AI SDK, LangChain and more | [Frameworks](./frameworks)                       |
| Switch from E2B, Daytona, Vercel, Modal, Cloudflare or Fly.io      | [Switch guide](./migrate)                        |
| Tell us what to build next, or get help                            | [Feedback and support](./feedback-and-support)   |

Keep important results outside the sandbox: a sandbox is not a backup.
