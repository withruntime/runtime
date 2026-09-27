# Runtime Cloud MCP

Runtime's MCP server gives an agent every Runtime product as tools, with instructions on first contact, so it needs no wrapper code.

MCP and the HTTPS API share authentication, ownership, spending checks and
idempotency.

## Add it to your agent

One command, no key to copy. Claude Code:

```bash no-run
claude mcp add --scope user runtime -- npx -y withruntime mcp
```

Codex:

```bash no-run
codex mcp add runtime -- npx -y withruntime mcp
```

or, in `~/.codex/config.toml`:

```toml
[mcp_servers.runtime]
command = "npx"
args = ["-y", "withruntime", "mcp"]
```

Cursor, in `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), and any
other client that takes the same shape:

```json
{
  "mcpServers": {
    "runtime": { "command": "npx", "args": ["-y", "withruntime", "mcp"] }
  }
}
```

**The first time, one approval connects it.** When this machine is not
connected, the server offers one tool, `runtime_connect`:

1. The agent calls it and shows you a link and a code.
2. You approve **Connect agent** in your browser.
3. The agent calls it again, and every Runtime tool appears. Nothing to
   restart.

A machine already connected by the CLI (`npx withruntime login`) skips this
step.

Approve only a connection you started and whose code matches. It can manage
resources and spend prepaid credit across your account until you revoke it
with `npx withruntime logout` or on the API keys page.

The command is a bridge: it forwards MCP messages as they are to the remote
server over the saved connection, so no key sits in the agent's configuration.
It needs Node 22.12 or later, loads its one dependency, `undici`, only when a proxy
applies, and does not create an account. For CI, `RUNTIME_API_KEY` from a secret
manager overrides the saved connection.

## Remote connection

Clients that speak MCP over HTTP can skip the bridge. The endpoint is
`https://api.withruntime.com/mcp`, over MCP Streamable HTTP.

**Sign in through the browser, with no key.** Add the address as a custom
connector or remote server, in Claude, ChatGPT, Cursor, VS Code or any client
that supports MCP sign-in:

1. The client opens a Runtime page in your browser.
2. You sign in and approve **Connect** for that app. The page shows where the
   key goes, so check it is the app you are using.
3. The client receives a key of its own and every Runtime tool appears.

The key belongs to a new agent named after the app. It can manage resources and
spend prepaid credit across your account until you revoke it on the
[API keys page](https://withruntime.com/account/keys), where it is listed with
the app's name. A client that asks for scope `runtime:read` gets a read-only
key.

Claude Code can do the same without the bridge:

```bash no-run
claude mcp add --transport http --scope user runtime https://api.withruntime.com/mcp
```

Then run `/mcp` in Claude Code and choose to authenticate.

**Or send a key.** A server or CI job sends `Authorization: Bearer <key>` with a
key from https://withruntime.com/account/keys, supplied from a secret manager.
Never put a key in the URL, a command line, a browser bundle or a configuration
you commit.

Clients discover sign-in the standard way: a request with no key gets a `401`
whose `WWW-Authenticate` header points at
`https://api.withruntime.com/.well-known/oauth-protected-resource/mcp`, which
names `https://withruntime.com` as the authorization server. It supports OAuth
2.1 with PKCE, dynamic client registration and client metadata documents.

## Tools

The server answers `initialize` with instructions: the quick start, safe retries,
and how to report problems. Read them, then inspect tool results rather than
assuming a completed tool call means the workload succeeded.

The tools describe the interface, but a listed tool is not a promise that its
capability is enabled. Check the [products page](./products) for availability.

| Tool                                                                                                    | What it does                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime_sandbox_create`                                                                                | Create a sandbox and wait for readiness; inspect its returned state.                                                                                                                                         |
| `runtime_sandbox_list`                                                                                  | List by state, name or label, or read one by id                                                                                                                                                              |
| `runtime_sandbox_manage`                                                                                | Stop, pause, wake, extend; retention, persist, restart                                                                                                                                                       |
| `runtime_sandbox_inspect`                                                                               | A sandbox's storage, paused storage, lifetime or recovery point                                                                                                                                              |
| `runtime_sandbox_exec`                                                                                  | Run a command and get its exit code and output, or start it in the background                                                                                                                                |
| `runtime_sandbox_process`                                                                               | Read, feed, signal or list background processes                                                                                                                                                              |
| `runtime_sandbox_files_read`, `runtime_sandbox_files_write`                                             | Read (whole or by line range) and write files                                                                                                                                                                |
| `runtime_sandbox_files_list`, `runtime_sandbox_files_manage`                                            | List and glob; stat, make, move and remove                                                                                                                                                                   |
| `runtime_sandbox_interpreter_run`, `runtime_sandbox_interpreter_contexts`                               | A notebook-style session in Python, JavaScript, TypeScript, R, Java, Bash or Go; charts as images, data frames as tables                                                                                     |
| `runtime_sandbox_files_watch`                                                                           | Watch a directory for file changes: start, read events after a cursor, list, stop                                                                                                                            |
| `runtime_image_build`, `runtime_image_registries`                                                       | Custom images from a recipe, any public or private image, or a Dockerfile, with versions and tags; registry credentials                                                                                      |
| `runtime_image`                                                                                         | `get`, `tag` and `delete` an image version                                                                                                                                                                   |
| `runtime_volume`                                                                                        | Persistent disks to attach at create: `create` (with `fromBackup` to restore a backup), `get`, `delete`                                                                                                      |
| `runtime_volume_backup`                                                                                 | Back a volume up off its server: `create`, `get`, `policy` for daily backups, `delete`                                                                                                                       |
| `runtime_sandbox_fork`                                                                                  | Copies of a sandbox as it is now, with its memory and processes, on the same server                                                                                                                          |
| `runtime_snapshot`                                                                                      | `create` keeps a paused sandbox to start copies from later, copied off its server (not with volumes); `get`, `delete`                                                                                        |
| `runtime_sandbox_mounts`                                                                                | Your S3, R2 or Google Cloud Storage bucket as a directory: `mount`, `list`, `unmount`; the proxy signs, the sandbox never holds the key                                                                      |
| `runtime_sandbox_previews`                                                                              | Share a port at an HTTPS address at `runtimehost.com`, private with a token by default: `create`, `list`, `rotate` (refuses every old token), `delete`                                                       |
| `runtime_sandbox_network`                                                                               | `get` or `set` a sandbox's network rules                                                                                                                                                                     |
| `runtime_sandbox_desktop_act`, `runtime_sandbox_desktop_screenshot`                                     | Drive a desktop in the sandbox                                                                                                                                                                               |
| `runtime_sandbox_desktop_record`                                                                        | Record the desktop to MP4: start, stop, list, delete                                                                                                                                                         |
| `runtime_sandbox_mcp`                                                                                   | The MCP catalog (`catalog`), and running its servers in a sandbox at URLs your agent connects to                                                                                                             |
| `runtime_sandbox_metrics`, `runtime_events_list`                                                        | A sandbox's CPU and memory over time; lifecycle events                                                                                                                                                       |
| `runtime_webhooks_manage`, `runtime_otel_manage`                                                        | Webhooks for lifecycle events, and OpenTelemetry export                                                                                                                                                      |
| `runtime_domain`, `runtime_port`, `runtime_address`, `runtime_tunnel`, `runtime_network_upstream_proxy` | Custom domains, public TCP ports, dedicated outbound addresses, the WireGuard tunnel and your own upstream proxy; see below                                                                                  |
| `runtime_account`                                                                                       | `get` the account, its trial time and credit; `limits` for this key's access and daily spending limit; `referrals` for your link and its credit (you both get up to $500); `sso` for single sign-on and SCIM |
| `runtime_usage_compare`                                                                                 | What your sandboxes would cost at a rival, and what you save a month                                                                                                                                         |
| `runtime_switching_record`                                                                              | Record the provider you are leaving, so your first top-up is matched, up to $100                                                                                                                             |
| `runtime_audit_list`                                                                                    | The account's audit log: members, keys, credit and security changes, with who and from where                                                                                                                 |
| `runtime_secrets`                                                                                       | Secrets sandboxes use without seeing, a placeholder inside and the value added by the proxy: `set`, `list`, `delete`                                                                                         |
| `runtime_feedback`                                                                                      | `submit` a problem or a missing feature; `list` what happened to it                                                                                                                                          |
| `runtime_support`                                                                                       | Ask Runtime support: `message`, then `read` the reply                                                                                                                                                        |
| `runtime_notices`                                                                                       | Account notices: pause expiry, unpaid storage and deletion deadlines                                                                                                                                         |
| `runtime_docs_read`                                                                                     | Read any page of these docs                                                                                                                                                                                  |

Tool names read `runtime_<product>_<verb>`, or `runtime_<product>` for a tool
that takes an `action`, the product spelled as the CLI spells it. The verbs an
agent needs in its first session each have a tool of their own; a product's
rarer verbs share one, and its `action` names the verb: `runtime_volume` with
`"action": "get"` reads a volume. Everything that
acts on one sandbox is `runtime_sandbox_*` and takes the sandbox as `id`;
images, volumes and snapshots are `runtime_image*`, `runtime_volume*` and
`runtime_snapshot`; what spans products, such as the account, usage, secrets,
events, feedback and docs, names no product. Results come back as both text and
`structuredContent`. An error is a tool result with `isError`, a code, a hint
and a `requestId`.

## Renamed tools

On 26 September 2026, 52 tools became 16 that take an `action`, which cut what
the tool list costs an agent's context by nearly a quarter. The old names still answer
until the next release, unlisted: each answer adds a line naming the call that
replaces it. Change any permission rule, prompt or script that names one.

| Before                                                                                          | Now                                                              |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `runtime_domain_add`, `_verify`, `_list`, `_remove`                                             | `runtime_domain` with `add`, `verify`, `list`, `remove`          |
| `runtime_port_open`, `_list`, `_close`                                                          | `runtime_port` with `open`, `list`, `close`                      |
| `runtime_address_list`, `_reserve`, `_release`                                                  | `runtime_address` with `list`, `reserve`, `release`              |
| `runtime_tunnel_create`, `_get`, `_add_peer`, `_rotate_peer`, `_remove_peer`                    | `runtime_tunnel` with the same verbs                             |
| `runtime_network_upstream_proxy_get`, `_set`, `_remove`                                         | `runtime_network_upstream_proxy` with `get`, `set`, `remove`     |
| `runtime_sandbox_network_get`, `_set`                                                           | `runtime_sandbox_network` with `get`, `set`                      |
| `runtime_sandbox_previews_create`, `_list`, `_rotate`, `_delete`                                | `runtime_sandbox_previews` with the same verbs                   |
| `runtime_sandbox_mount`, `runtime_sandbox_mounts`, `runtime_sandbox_unmount`                    | `runtime_sandbox_mounts` with `mount`, `list`, `unmount`         |
| `runtime_image_get`, `_tag`, `_delete`                                                          | `runtime_image` with `get`, `tag`, `delete`                      |
| `runtime_volume_create`, `_get`, `_delete`                                                      | `runtime_volume` with `create`, `get`, `delete`                  |
| `runtime_volume_backup`, `_backup_get`, `_backup_policy`, `_backup_delete`                      | `runtime_volume_backup` with `create`, `get`, `policy`, `delete` |
| `runtime_snapshot_create`, `_get`, `_delete`                                                    | `runtime_snapshot` with `create`, `get`, `delete`                |
| `runtime_secrets_set`, `_list`, `_delete`                                                       | `runtime_secrets` with `set`, `list`, `delete`                   |
| `runtime_account_get`, `runtime_limits_get`, `runtime_referrals_get`, `runtime_account_sso_get` | `runtime_account` with `get`, `limits`, `referrals`, `sso`       |
| `runtime_support_message`, `_read`                                                              | `runtime_support` with `message`, `read`                         |
| `runtime_feedback_submit`, `_list`                                                              | `runtime_feedback` with `submit`, `list`                         |

On 24 September 2026 every tool took its product's name, as the CLI spells it,
with no aliases: `runtime_exec` became `runtime_sandbox_exec`,
`runtime_sandboxes_create` became `runtime_sandbox_create`, and so on. A call to
one of those names fails, and its error names the call that replaces it.

## A typical session

1. Choose a unique `idempotencyKey` before creating. Call
   `runtime_sandbox_create` with `funding: "trial"` and that key. Check that
   the returned state is `running` before executing anything. Trial funding
   never falls back to paid credit.
2. `runtime_sandbox_files_write`, then `runtime_sandbox_exec` with `{"id": "<sandbox id>", "command": "python3 main.py"}`
   (or `"command": ["python3", "main.py"]` to run it without a shell).
   Give each write that accepts `idempotencyKey` its own key; do not add
   unsupported fields to other tools. Check `exitCode`, `timedOut`, output and
   truncation flags; tool or HTTP success alone does not prove program success.
   `runtime_sandbox_exec` returns at most 64 KiB of `stdout` and of `stderr` for a
   command up to 60 seconds, 1 MiB for a longer one; `stdoutTruncated` or
   `stderrTruncated` is `true` when more was dropped. Over MCP, output over
   16,000 characters in all keeps each stream's first line and its end, and
   `outputCut` says how many characters of each were cut. For all of it, write
   the output to a file and read it in parts with `runtime_sandbox_files_read`.
3. For a server or a long job, `runtime_sandbox_exec` with `"background": true`, then
   `runtime_sandbox_process` with `"action": "read"` to follow its output.
4. `runtime_sandbox_manage` with `"action": "stop"` when done, even if a step
   failed. Confirm `stopped` before reporting cleanup complete. Export needed
   outputs before stopping.

**Retries.** When a tool accepts `idempotencyKey`, choose and record a unique
key **before the first call** and pass it explicitly. After a lost reply, reuse
that key with identical input.

A key the server generated for an omitted field cannot be recovered from a lost
reply, so do not repeat that write blindly: read the original resource first.
The SDKs keep their own retry key during a call; this guidance is for direct MCP
calls.

**Errors.** Follow error codes and hints.

- Back off with a bounded deadline on `no_capacity`, `busy` or
  `host_unavailable`, keeping the original write key and input.
- Do not keep retrying `fork_unavailable`, `previews_unavailable` or
  `unavailable`: an operator has switched that capability off.
- If a create stops before becoming ready, read that sandbox's `stopReason` and
  report the failure. Do not call it running or loop over new creates.
- For support or feedback, send a sanitized summary and request ID, never
  credentials or private code and file contents.

## Pause and wake

`runtime_sandbox_manage` with `"action": "pause"` saves files and memory, and
`"wake"` restores them on the same host. Each sandbox keeps only its latest
state, not a history of billed snapshots.

A wake never silently substitutes a fresh boot: missing memory images refuse
it. A full host can also refuse a wake; the paused data remains and no compute
is charged for the failed attempt. See [pricing](./pricing) for paused storage
and retention.

A paused sandbox also wakes by itself when `runtime_sandbox_exec`, a file or terminal
tool, or a visit to a shared port reaches it, unless it was created with
`autoWake: false`. `"action": "update"` changes `autoWake`, `idlePauseSeconds`
(pause after that many seconds with no request; 0 is never), `name` and
`labels`; `"persist"` keeps a paid sandbox running while credit lasts.
`runtime_sandbox_create` with `name` and `getOrCreate: true` returns the
sandbox that already has the name, woken if paused, instead of `name_taken`.

## Domains, TCP ports, addresses and the tunnel

Paid accounts only; see [networking](./networking).

- `runtime_domain` (`add`, `verify`, `list`, `remove`): serve a sandbox's port
  at your own hostname.
- `runtime_port` (`open`, `list`, `close`): a public TCP port to a sandbox.
- `runtime_address` (`reserve`, `list`, `release`): a dedicated outbound
  address.
- `runtime_tunnel` (`create`, `get`, `add_peer`, `rotate_peer`,
  `remove_peer`): the WireGuard tunnel. `add_peer` without `publicKey`
  generates the key pair and returns the private key once, in `config`.
- `runtime_network_upstream_proxy` (`get`, `set`, `remove`): send the
  sandboxes' outbound connections through your own proxy.
