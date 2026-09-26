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

| Tool                                                                         | What it does                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `runtime_sandbox_create`                                                     | Create a sandbox and wait for readiness; inspect its returned state.                                                     |
| `runtime_sandbox_list`                                                       | List by state, name or label, or read one by id                                                                          |
| `runtime_sandbox_manage`                                                     | Stop, pause, wake, extend; retention, persist, restart                                                                   |
| `runtime_sandbox_inspect`                                                    | A sandbox's storage, paused storage, lifetime or recovery point                                                          |
| `runtime_sandbox_exec`                                                       | Run a command and get its exit code and output, or start it in the background                                            |
| `runtime_sandbox_process`                                                    | Read, feed, signal or list background processes                                                                          |
| `runtime_sandbox_files_read`, `runtime_sandbox_files_write`                  | Read (whole or by line range) and write files                                                                            |
| `runtime_sandbox_files_list`, `runtime_sandbox_files_manage`                 | List and glob; stat, make, move and remove                                                                               |
| `runtime_sandbox_interpreter_run`, `runtime_sandbox_interpreter_contexts`    | A notebook-style session in Python, JavaScript, TypeScript, R, Java, Bash or Go; charts as images, data frames as tables |
| `runtime_sandbox_files_watch`                                                | Watch a directory for file changes: start, read events after a cursor, list, stop                                        |
| `runtime_image_build`, `_get`, `_tag`, `_registries`, `_delete`              | Custom images from a recipe, any public or private image, or a Dockerfile, with versions and tags                        |
| `runtime_volume_create`, `_get`, `_delete`                                   | Persistent disks to attach at create; `create` with `fromBackup` restores a backup                                       |
| `runtime_volume_backup`, `_backup_get`, `_backup_policy`, `_backup_delete`   | Back a volume up off its server, list backups, daily backups on or off                                                   |
| `runtime_sandbox_fork`                                                       | Copies of a sandbox as it is now, with its memory and processes, on the same server                                      |
| `runtime_snapshot_create`                                                    | Keep a paused sandbox to start copies from later, copied off its server; not with volumes                                |
| `runtime_snapshot_get`, `_delete`                                            | Read, list or delete snapshots                                                                                           |
| `runtime_sandbox_mount`, `runtime_sandbox_mounts`, `runtime_sandbox_unmount` | Your S3, R2 or Google Cloud Storage bucket as a directory; the proxy signs, the sandbox never holds the key              |
| `runtime_sandbox_previews_create`, `_list`, `_rotate`, `_delete`             | Share a port at an HTTPS address at `runtimehost.com`, private with a token by default; rotate refuses every old token   |
| `runtime_sandbox_network_get`, `_set`                                        | Read or replace a sandbox's network rules                                                                                |
| `runtime_sandbox_desktop_act`, `runtime_sandbox_desktop_screenshot`          | Drive a desktop in the sandbox                                                                                           |
| `runtime_sandbox_desktop_record`                                             | Record the desktop to MP4: start, stop, list, delete                                                                     |
| `runtime_sandbox_mcp`                                                        | The MCP catalog (`catalog`), and running its servers in a sandbox at URLs your agent connects to                         |
| `runtime_sandbox_metrics`, `runtime_events_list`                             | A sandbox's CPU and memory over time; lifecycle events                                                                   |
| `runtime_webhooks_manage`, `runtime_otel_manage`                             | Webhooks for lifecycle events, and OpenTelemetry export; each takes an `action`                                          |
| `runtime_account_get`                                                        | The account, its trial time and its credit                                                                               |
| `runtime_referrals_get`                                                      | Your referral link and the credit it has earned (you both get up to $500)                                                |
| `runtime_usage_compare`                                                      | What your sandboxes would cost at a rival, and what you save a month                                                     |
| `runtime_switching_record`                                                   | Record the provider you are leaving, so your first top-up is matched, up to $100                                         |
| `runtime_limits_get`                                                         | Whether this key is read-only, and its daily spending limit with what is left                                            |
| `runtime_audit_list`                                                         | The account's audit log: members, keys, credit and security changes, with who and from where                             |
| `runtime_account_sso_get`                                                    | Single sign-on and SCIM directory sync: providers, domains, whether SSO is required, group roles                         |
| `runtime_secrets_set`, `runtime_secrets_list`, `runtime_secrets_delete`      | Secrets sandboxes use without seeing: a placeholder inside, the value added by the proxy                                 |
| `runtime_feedback_submit`, `runtime_feedback_list`                           | Report a problem or a missing feature; see what happened to it                                                           |
| `runtime_support_message`, `runtime_support_read`                            | Ask Runtime support                                                                                                      |
| `runtime_notices`                                                            | Account notices: pause expiry, unpaid storage and deletion deadlines; takes an `action`                                  |
| `runtime_docs_read`                                                          | Read any page of these docs                                                                                              |

Tool names read `runtime_<product>_<verb>`, the product spelled as the CLI spells
it. Everything that acts on one sandbox is `runtime_sandbox_*` and takes the
sandbox as `id`; images, volumes and snapshots are `runtime_image_*`,
`runtime_volume_*` and `runtime_snapshot_*`; what spans products, such as the
account, usage, secrets, events, feedback and docs, names no product. A tool
that takes an `action` is `runtime_<product>` alone. Results come back as both
text and `structuredContent`. An error is a tool result with `isError`, a code, a
hint and a `requestId`.

## Renamed tools

On 24 September 2026 every tool took its product's name, as the CLI spells it.
This is a breaking change with no aliases: a call to an old name fails, and its
error names the new one. Restart your agent, or run `/mcp` in Claude Code, so
it lists the tools again, and change any permission rule, prompt or script that
names an old tool.

| Before                                                           | Now                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `runtime_sandboxes_create`, `_list`, `_manage`, `_fork`          | `runtime_sandbox_create`, `_list`, `_manage`, `_fork`                     |
| `runtime_sandboxes_inspect`, `runtime_sandboxes_metrics`         | `runtime_sandbox_inspect`, `runtime_sandbox_metrics`                      |
| `runtime_exec`, `runtime_process`                                | `runtime_sandbox_exec`, `runtime_sandbox_process`                         |
| `runtime_files_read`, `_write`, `_list`, `_manage`               | `runtime_sandbox_files_read`, `_write`, `_list`, `_manage`                |
| `runtime_interpreter_run`, `_contexts`                           | `runtime_sandbox_interpreter_run`, `_contexts`, with `id` for `sandboxId` |
| `runtime_desktops_act`, `_screenshot`                            | `runtime_sandbox_desktop_act`, `_screenshot`, with `id` for `sandboxId`   |
| `runtime_previews_create`, `_list`, `_delete`                    | `runtime_sandbox_previews_create`, `_list`, `_delete`, with `id`          |
| `runtime_network_policies_get`, `_set`                           | `runtime_sandbox_network_get`, `_set`, with `id` for `sandboxId`          |
| `runtime_images_build`, `_get`, `_tag`, `_registries`, `_delete` | `runtime_image_build`, `_get`, `_tag`, `_registries`, `_delete`           |
| `runtime_volumes_create`, `_get`, `_delete`                      | `runtime_volume_create`, `_get`, `_delete`                                |
| `runtime_snapshots_create`, `_get`, `_delete`                    | `runtime_snapshot_create`, `_get`, `_delete`                              |

The tools that span products keep their names: `runtime_account_get`,
`runtime_usage_compare`, `runtime_secrets_*`, `runtime_events_list`,
`runtime_webhooks_manage`, `runtime_feedback_*`, `runtime_support_*`,
`runtime_docs_read` and the rest.

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

- `runtime_domain_add`, `runtime_domain_verify`, `runtime_domain_list`,
  `runtime_domain_remove`: serve a sandbox's port at your own hostname.
- `runtime_port_open`, `runtime_port_list`, `runtime_port_close`: a public TCP
  port to a sandbox.
- `runtime_address_reserve`, `runtime_address_list`, `runtime_address_release`:
  a dedicated outbound address.
- `runtime_tunnel_create`, `runtime_tunnel_get`, `runtime_tunnel_add_peer`,
  `runtime_tunnel_rotate_peer`, `runtime_tunnel_remove_peer`: the WireGuard
  tunnel. `runtime_tunnel_add_peer` without `publicKey` generates the key pair
  and returns the private key once, in `config`.
