# HTTPS API reference

One API for every Runtime Cloud product, at `https://api.withruntime.com`.

The SDKs, the CLI and MCP are thin layers over it. This page is the contract.
The machine-readable one is the public OpenAPI document at
`https://api.withruntime.com/v1/openapi.json`, generated from the same route
definitions the server validates with.

API version: **0.2.0**.

## Requests

Send the key as a bearer token. Keys stay in server-side secret storage; never in
a URL, a browser or a command line others can read.

```bash no-run
curl https://api.withruntime.com/v1/sandboxes \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: wait=60" \
  -d '{}'
```

In a shell, put a variable before a colon in braces: `"${ID}:exec"`. zsh, the
macOS default, reads `$ID:e` as a modifier and sends `/xec`.

Never use `curl -v` or `--trace` with the key: they print the `Authorization`
header.

```bash no-run
curl -sS "https://api.withruntime.com/v1/sandboxes/${ID}:exec" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"command": "python3 -c \"print(6 * 7)\""}'
```

- Resources live at `/v1/<plural>/{id}`. A change that is not a plain update is
  `POST /v1/<plural>/{id}:<verb>`: `:stop`, `:pause`, `:wake`, `:exec`.
- Field names are camelCase. Times are ISO 8601 in UTC. Money is integer
  microdollars: 1,000,000 is one US dollar.
- Unknown fields are refused, and every wrong field is named in one answer.
- `Prefer: wait=N` (seconds, at most 120) on a change answers once the resource
  has settled rather than at once. `GET /v1/sandboxes/{id}?waitFor=running&timeoutSeconds=60`
  waits for a state without polling.

## Responses and errors

Every response carries `x-request-id`. Every error has one shape:

```json
{
  "error": {
    "code": "trial_busy",
    "status": 409,
    "message": "The trial runs 8 sandboxes at once; ... are running.",
    "hint": "Stop one (runtime sandbox stop <id>), or pass funding: \"paid\" to use prepaid credit.",
    "details": { "sandboxIds": ["..."], "concurrent": 8 },
    "requestId": "req_0mud1dtgjogtn2z8t6y"
  }
}
```

Follow the `hint`. Quote the `requestId` when you report a problem. A 5xx never
carries internal detail, only a fixed message and the request id.

| Status | Codes you may see                                                                                                      | Safe next step                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 400    | `invalid_request` (with `details.issues`), `invalid_region`, `invalid_trial`                                           | Fix the named fields                                                   |
| 401    | `unauthorized`                                                                                                         | Check the key                                                          |
| 402    | `trial_exhausted`, `insufficient_funds`, `spending_limit_reached`                                                      | Add credit, pay with `funding: "paid"`, or read `GET /v1/limits`       |
| 402    | `account_blocked`                                                                                                      | A payment is disputed or under review; the message says what clears it |
| 403    | `forbidden` (a read-only key asking to change something is one), `permission_denied`                                   | Do not work around a refusal                                           |
| 404    | `not_found`, `route_not_found`, `file_not_found`                                                                       | Check the id or path                                                   |
| 409    | `no_capacity`, `trial_busy`, `not_running`, `sandbox_paused`, `sandbox_stopped`, `sandbox_not_ready`, `is_a_directory` | Resolve the state, then retry                                          |
| 422    | `idempotency_key_reused`                                                                                               | Same key, same body; or a new key for new work                         |
| 426    | `upgrade_required`                                                                                                     | Move to this API version                                               |
| 429    | `rate_limited`                                                                                                         | Wait `Retry-After`, then retry with the same key                       |
| 503    | `busy`, `host_unavailable`, `api_unavailable`, `guest_busy`                                                            | Retry after `Retry-After` with the same key (the SDKs do)              |
| 503    | `unavailable`, `fork_unavailable`, `previews_unavailable`                                                              | Switched off here on purpose; retrying will not help                   |

**Temporary refusals are safe to retry.** `no_capacity`, `busy`,
`host_unavailable`, `rate_limited` and `trial_busy` clear on their own: retry
with the same key, a growing delay and a bounded deadline.

- The SDKs retry the 429 and 503 codes themselves.
- An SDK create also waits out `trial_busy`, `quota_exceeded` and
  `no_capacity`, for up to two minutes by default, then returns the refusal.
  The error's `retryable` is `true` for `trial_busy` and `no_capacity`, for a
  loop of your own.
- `trial_busy` clears when one of the trial's eight running sandboxes stops or
  pauses. A fork asking for more copies than that never fits.

## Retries and idempotency

Send `Idempotency-Key: <any unique string>` on a change. The server remembers the
key for 24 hours:

- The same key with the same body answers the first result again, marked
  `"replayed": true` and with the header `Idempotency-Replayed: true`. Nothing
  happens twice.
- The same key with a different body is refused with 422 `idempotency_key_reused`.
- A new key is new work.

The SDKs send a key on every change and retry transport failures, 429, 502, 503
and 504 with it. Changing the body while reusing a key is not a retry.

## Limits

These limits are protection, not quotas, and a refusal costs nothing.

- **Per key:** about 50 requests a second, in bursts of up to 200, with 128
  served at once. Past that, a request waits its turn for up to five seconds
  before it is refused.
- **Per organization:** 192 requests in flight across all its keys, and 64
  terminals open, at most 12 of them in one sandbox.

Over a limit you get 429 with `Retry-After`.

## Sandboxes

| Method and path                     | What it does                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /v1/sandboxes`                | Create. Every field optional.                                                                 |
| `GET /v1/sandboxes`                 | List: `state`, `name`, `label=key:value` (repeat), `includeStopped`, `limit`, `cursor`        |
| `GET /v1/sandboxes/{id}`            | Read; `waitFor` and `timeoutSeconds` wait for a state                                         |
| `POST /v1/sandboxes/{id}:stop`      | Stop. Compute ends on confirmed shutdown.                                                     |
| `POST /v1/sandboxes/{id}:pause`     | Answers once the processors stop, where compute billing ends; memory and files are then saved |
| `POST /v1/sandboxes/{id}:wake`      | Restore a paused sandbox; `timeoutSeconds` sets its next lease                                |
| `POST /v1/sandboxes/{id}:extend`    | `{"seconds": 600}` more before the lease ends                                                 |
| `POST /v1/sandboxes/{id}:retention` | `{"days": 30}` to keep a paused sandbox, 1 to 365                                             |
| `POST /v1/sandboxes/{id}:restart`   | Start a stopped persistent sandbox again from its disk                                        |
| `POST /v1/sandboxes/{id}:update`    | Change `name`, `labels`, `autoWake`, `idlePauseSeconds`, `persistent`, `maxTotalCostMicros`   |

The create body:

| Field                | Default                                      | Notes                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `labels`     | none                                         | Your own handle and up to 32 `key: value` tags                                                                                                                                                                                                      |
| `funding`            | trial while it lasts, then paid              | `"trial"` never falls back to paid credit                                                                                                                                                                                                           |
| `region`             | the default region                           | Use a region listed for your account                                                                                                                                                                                                                |
| `vcpu`               | 2                                            | At most 16 on a paid sandbox, 2 on the trial                                                                                                                                                                                                        |
| `memoryMiB`          | 4096                                         | At most 65,536 (64 GiB) on a paid sandbox, 4,096 on the trial; a larger size is refused with `invalid_request` naming the field                                                                                                                     |
| `diskMiB`            | 4096                                         |                                                                                                                                                                                                                                                     |
| `cpu`                | `"shared"`                                   | `"reserved"` guarantees every vCPU                                                                                                                                                                                                                  |
| `cpuFloorMillis`     | 50                                           | Guaranteed CPU while shared, in thousandths of a vCPU                                                                                                                                                                                               |
| `timeoutSeconds`     | 1800                                         | How long it may run before its lease ends, at most 3600                                                                                                                                                                                             |
| `onLeaseEnd`         | `"pause"`                                    | Or `"stop"`                                                                                                                                                                                                                                         |
| `pausable`           | true                                         |                                                                                                                                                                                                                                                     |
| `idlePauseSeconds`   | 300 when `timeoutSeconds` is left out        | Pause after this many seconds with no exec, file, process, terminal, desktop or preview request; 0 is never, otherwise 60 to 86,400. The default counts only until the first request, and is not set with an explicit lease, an image or a snapshot |
| `autoWake`           | true                                         | A request to a paused sandbox wakes it (see below)                                                                                                                                                                                                  |
| `persistent`         | false                                        | Paid only: the lease renews itself while credit lasts, and a stopped sandbox keeps its disk for `:restart`                                                                                                                                          |
| `maxTotalCostMicros` | none                                         | The most the sandbox may cost over its whole life                                                                                                                                                                                                   |
| `getOrCreate`        | false                                        | With `name`: answer the sandbox that holds the name (see below)                                                                                                                                                                                     |
| `network`            | every public port (paid), 80 and 443 (trial) | Same shape as `PUT /v1/sandboxes/{id}/network`                                                                                                                                                                                                      |
| `maxCostMicros`      | none                                         | Refuse the create if its first lease would cost more                                                                                                                                                                                                |
| `image`, `volumes`   | none                                         | A ready image (its id, `name`, `name:tag` or `name@version`) and up to four `{volumeId, path, mode}`. An image with a start command answers once its ready check passes, in `start`                                                                 |
| `snapshot`           | none                                         | A ready snapshot id: start as a copy of it. Not with `image`                                                                                                                                                                                        |

Sizes are limits you ask for. The server checks their combinations against
account limits and the host's measured capacity.

**Wake on request.** A paused sandbox with `autoWake` wakes by itself when a
command, file, process, terminal, desktop or interpreter call reaches it, and
the call runs once it is running, usually within a second. A visit
to one of its shared ports wakes it too: an API client's request waits up to
30 seconds, and a browser is shown a page that reloads itself. The wake is an
ordinary wake: a fresh lease of the sandbox's own `timeoutSeconds`, billed from
the moment it runs. With `autoWake: false` the call fails with `sandbox_paused`
until `:wake`. A wake that cannot be paid for fails with the refusal, such as
`insufficient_funds`, and leaves the sandbox paused.

**Names.** A name is unique in the account while its sandbox can still run:
starting, running, paused, or stopped and persistent. A create that names a
held name fails with `409 name_taken`; `details.sandboxId` names the holder
when your key can reach it. With `getOrCreate: true` the create answers the
holder instead, woken if paused and restarted if stopped and persistent, with
`reused: true`; the other fields apply only when it creates one. A sandbox that
stops for good gives its name up and keeps it in its own record.

**Running for longer than a lease.** `persistent: true`, at create or with
`:update`, renews the lease on the server while the account has credit, up to
`maxTotalCostMicros`, and keeps the disk after a stop, billed as reserved disk.
Without it, `:extend` moves the lease later, up to an hour ahead of now; the
SDKs' `keepAlive` calls it for you.

## Commands and processes

| Method and path                                        | What it does                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `POST /v1/sandboxes/{id}:exec`                         | Run and answer `{exitCode, stdout, stderr, timedOut}`                          |
| `POST /v1/sandboxes/{id}/processes`                    | Start in the background; add `"pty": {"cols", "rows"}` for a terminal          |
| `GET /v1/sandboxes/{id}/processes`                     | Running and recent processes                                                   |
| `GET /v1/sandboxes/{id}/processes/{processId}`         | One process                                                                    |
| `GET /v1/sandboxes/{id}/processes/{processId}/output`  | Output from `cursor`; `waitMs` long-polls; `follow=true` streams               |
| `POST /v1/sandboxes/{id}/processes/{processId}:write`  | `{"data"}` or `{"base64"}`, with `offset` and `eof`; offsets make retries safe |
| `POST /v1/sandboxes/{id}/processes/{processId}:signal` | `{"signal": "SIGTERM"}`                                                        |
| `POST /v1/sandboxes/{id}/processes/{processId}:resize` | `{"cols", "rows"}` for a pty                                                   |

The exec body is `command` (run under `bash -c`) or `argv` (no shell). Optional
fields are `cwd`, `env`, `stdin`, `timeoutMs` (default 60,000; at most 24 hours)
and `stream`. A timeout is a result with `timedOut: true`, not an error. `env`
values are never echoed and are stored only as hashes.

**Streaming.** With `"stream": true` the answer is NDJSON, one event a line:
`start`, `stdout`, `stderr` and `exit`. When a stream passes the server's time
limit it sends `continue` with a cursor, and `…/output?follow=true&cursor=`
resumes from it. A streamed command has no output limit.

**Output limits.** The JSON answer holds at most 64 KiB (65,536 bytes) of each
stream for a command with a `timeoutMs` of 60,000 or less, and up to 1 MiB of
each for a longer one. Past that the rest is dropped, and `stdoutTruncated` or
`stderrTruncated` is `true`.

While a stream is being read, its command waits for the reader rather than lose
output, from its first byte. The sandbox keeps the latest 1 MiB of each
process's output; a reader away for more than 10 seconds while more than that
came out gets `{"type":"truncated","droppedBytes","resumeAt"}` before the output
that remains. For large output, stream it, or write it to a file and read
it with `GET …/files/content`.

## Terminals

`GET /v1/sandboxes/{id}/terminal` with `Upgrade: websocket` and the bearer header
opens a terminal: `cols`, `rows`, `command` (default `bash -l`), `cwd`, or
`processId` to attach to a process started with a pty. Binary frames are terminal
bytes both ways. Text frames are JSON: you send `{"type":"resize","cols":120,"rows":40}`;
the server sends `{"type":"ready","processId":...}` and `{"type":"exit","exitCode":...}`.

A browser's WebSocket cannot send an `Authorization` header, so the terminal on
a sandbox's page at withruntime.com offers a ticket instead:
`Sec-WebSocket-Protocol: runtime.terminal.v1, runtime.ticket.<ticket>`. The
server answers with `runtime.terminal.v1`. A ticket is accepted only from a page
on withruntime.com, opens one terminal in one sandbox and lasts 60 seconds; a
refused one answers `401 unauthorized` or `403 forbidden` and says why. Your
own code uses the bearer header. See
[the browser terminal](./security#the-browser-terminal).

## Tunnels

`GET /v1/sandboxes/{id}/tunnel` with `Upgrade: websocket` and the bearer header
opens a tunnel into the sandbox: TCP connections to any port on its loopback,
and SSH logins, several at once over the one socket. It needs the key's `exec`
permission, like a command. The CLI (`runtime sandbox ssh`, `runtime sandbox port-forward`)
and the SDKs (`sbx.tunnel()`, `sbx.forwardPort()`, `forward_port()`) speak it
for you.

Binary frames both ways are one kind byte, a 32-bit big-endian stream number
and a payload. You send `o` to open a stream with `tcp PORT` or `ssh KEYTYPE
BASE64` (an OpenSSH public key), `d` data, `e` end of your input and `c` to
close. The server answers `o` opened, `d` data, `e` end of output, `c` closed
with a reason (`closed` when nothing listens), `l` sshd's error output, and `a`
on stream 0 with a 64-bit count of the data bytes the sandbox has taken. Keep
at most 1 MiB of data sent beyond the last `a`; a client that sends more is
disconnected. Text frames from the server are JSON: `{"type":"ready"}` first,
`{"type":"error","error":{...}}` before it closes on an error.

## Files

| Method and path                                                 | What it does                                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/sandboxes/{id}/files/content?path=`                    | The file's raw bytes, any size; `x-content-length` gives the length first (and `x-content-sha256` a small file's digest), so check it: a body that ends short failed |
| `PUT /v1/sandboxes/{id}/files/content?path=`                    | Replace the file with the raw request body; makes parents; `mode=755` sets its permissions (644 by default)                                                          |
| `GET /v1/sandboxes/{id}/files/list?path=`                       | Entries; `depth`, `glob`, `hidden`, `limit`                                                                                                                          |
| `GET /v1/sandboxes/{id}/files/stat?path=`                       | Type, size, mode and times, or `{"exists": false}`                                                                                                                   |
| `POST /v1/sandboxes/{id}/files:mkdir`                           | `{"path", "parents"}`                                                                                                                                                |
| `POST /v1/sandboxes/{id}/files:remove`                          | `{"path", "recursive"}`                                                                                                                                              |
| `POST /v1/sandboxes/{id}/files:rename`                          | `{"from", "to", "overwrite"}`                                                                                                                                        |
| `POST /v1/sandboxes/{id}/files:chmod`                           | `{"path", "mode": "755"}`                                                                                                                                            |
| `POST`, `GET /v1/sandboxes/{id}/files/watches`                  | Watch a directory: `{"path", "recursive", "events", "include", "exclude", "batchMs", "timeoutMs"}`; list the watches                                                 |
| `GET /v1/sandboxes/{id}/files/watches/{watchId}/events?cursor=` | Its events after a cursor (`waitMs` up to 8000), or `follow=true` for a stream                                                                                       |
| `DELETE /v1/sandboxes/{id}/files/watches/{watchId}`             | Stop a watch                                                                                                                                                         |
| `POST /v1/sandboxes/{id}/uploads`                               | Begin a large upload under `/workspace`: `{"path", "size", "sha256", "mode"}`                                                                                        |
| `PUT /v1/sandboxes/{id}/uploads/{uploadId}?offset=`             | One chunk of raw bytes; chunks may go in parallel                                                                                                                    |
| `POST /v1/sandboxes/{id}/uploads/{uploadId}:commit`             | Check the digest and move the file into place atomically                                                                                                             |
| `POST /v1/sandboxes/{id}/uploads/{uploadId}:abort`              | Give up                                                                                                                                                              |

Paths are absolute. File errors name the path: `file_not_found`,
`is_a_directory`, `not_a_directory`, `permission_denied`.

A watch's events are `create`, `write` (repeated writes folded, with a
`count`), `remove`, `rename` (with `oldPath`) and `chmod`, in batches every
`batchMs` (100 by default). Notices say when events were missed: `overflow`
(more than 5,000 a second, or the kernel's own queue) and `lost` (a reader more
than 1 MiB behind). A stream ends with `continue` and the cursor after 110
seconds, and with `paused` when the sandbox pauses; reading never wakes a
sandbox, and a read after it wakes carries on from the cursor with nothing lost.
At most four watches run in a sandbox, each for `timeoutMs` (one hour by
default, at most a day).

## Other products

| Method and path                                                                                                                                                | Product              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `POST /v1/sandboxes/{id}/interpreter:run`, `…/interpreter/contexts` (`language`: python, javascript, typescript, r, java, bash, go)                            | Code interpreter     |
| `POST`, `GET /v1/sandboxes/{id}/mounts`, `…/mounts:unmount`                                                                                                    | Bucket mounts        |
| `POST`, `GET /v1/sandboxes/{id}/previews`, `…/previews/{port}`, `…/previews/{port}:rotate`                                                                     | Previews             |
| `POST /v1/sandboxes/{id}/desktop:start`, `:stop`, `:act`, `GET …/desktop/screenshot`                                                                           | Desktop              |
| `POST`, `GET /v1/sandboxes/{id}/desktop/recordings`, `GET …/recordings/{recordingId}`, `…/video`, `:stop`, `DELETE`                                            | Desktop recordings   |
| `GET /v1/mcp/catalog`; `POST`, `GET`, `DELETE /v1/sandboxes/{id}/mcp`                                                                                          | MCP servers          |
| `GET`, `PUT /v1/sandboxes/{id}/network`                                                                                                                        | Network rules        |
| `GET /v1/egress-secrets`, `PUT`, `DELETE /v1/egress-secrets/{name}`                                                                                            | Secrets              |
| `GET`, `PUT`, `DELETE /v1/network/upstream-proxy`                                                                                                              | Your own proxy       |
| `POST`, `GET /v1/feedback`                                                                                                                                     | Feedback             |
| `POST /v1/support/messages`, `GET /v1/support/conversations/{id}`                                                                                              | Support              |
| `GET /v1/me`, `GET /v1/usage`, `GET /v1/limits`, `GET /v1/audit`                                                                                               | Account              |
| `GET /v1/sso`                                                                                                                                                  | Single sign-on       |
| `GET`, `POST /v1/identity/token?audience=` (from inside a sandbox, with its request token)                                                                     | Identity tokens      |
| `GET /v1/usage/compare?provider=e2b&days=30`, `GET /v1/switching`, `POST /v1/switching`                                                                        | Switching            |
| `POST`, `GET /v1/images`, `GET /v1/images/{id}`, `…/logs?follow=true`, `:tag`, `:untag`, `:delete`, `GET /v1/images/resolve?ref=`                              | Custom images        |
| `POST /v1/images/context/missing`, `PUT /v1/images/context/{digest}`                                                                                           | Image build contexts |
| `GET`, `POST /v1/images/registries`, `POST /v1/images/registries:delete`                                                                                       | Private registries   |
| `POST`, `GET /v1/volumes`, `GET /v1/volumes/{id}`, `:delete`, `:backup`, `:backup-policy`; `GET /v1/volume-backups`, `…/{id}`, `:delete`                       | Volumes and backups  |
| `POST /v1/sandboxes/{id}:fork`, `POST /v1/sandboxes/{id}:snapshot`, `GET /v1/snapshots`, `…/{id}`, `:extend`, `:delete`                                        | Forks and snapshots  |
| `GET /v1/sandboxes/{id}/metrics?range=1h`, `GET /v1/events`                                                                                                    | Metrics and events   |
| `POST`, `GET /v1/webhooks`, `GET /v1/webhooks/{id}`, `:update`, `:rotate-secret`, `:test`, `:delete`, `…/deliveries`, `POST /v1/webhook-deliveries/{id}:retry` | Webhooks             |
| `POST`, `GET /v1/otel-exports`, `GET /v1/otel-exports/{id}`, `:update`, `:flush`, `:delete`                                                                    | OpenTelemetry export |

Forks:

- A fork's copies keep the source's size and CPU (`cpu` and `cpuFloorMillis`),
  and are quoted as a create with them would be.
- Copies keep the source's `labels` unless the fork names others. They get no
  name unless the fork gives one (`name`, then `name-1`, `name-2` for several),
  because names are unique in the account. A snapshot taken without labels
  keeps its sandbox's, and a sandbox created from a snapshot keeps the
  snapshot's unless the create names others.
- The snapshot a fork takes is deleted when the fork ends, whether every copy
  started or not, and is never billed, unless the request says
  `keepSnapshot: true`.
- A fork that fails after its snapshot answers with the failing step's error.
  Its `details.startedSandboxIds` names the copies that did start; they keep
  running until stopped. A retry with the same `Idempotency-Key` answers that
  same error.
- A sandbox created with `pausable: false` cannot be forked (`not_pausable`).
- If a fork stops partway and left its source paused, the source stays paused.
  `GET /v1/notices` holds a `fork-left-paused` notice naming the sandbox, the
  fork's key and how to wake it.

Metrics, events, webhooks and OpenTelemetry export are in
[metrics and webhooks](./observability): what each field means, how deliveries
are signed and retried, and what an export sends.

The OpenAPI document has every field of every route.

## Account

`GET /v1/me` says who a key is: `orgId`, `principalId`, `credentialId`, the
account's `orgName`, and the `role` of the member who made the key (`owner`,
`admin`, `developer` or `billing`), which bounds what the key may do.
`GET /v1/usage` says what the account has and has used. Money is integer
microdollars in strings (1,000,000 is one dollar), exact however large:

| Field       | What it is                                                        |
| ----------- | ----------------------------------------------------------------- |
| `credited`  | Every credit ever added: purchases and grants                     |
| `spent`     | Settled usage, including what refunds and disputes took back      |
| `held`      | Reserved against running and paused work, not yet settled         |
| `expired`   | Credit that expired, or grant credit taken back                   |
| `available` | What can still be spent: `credited - spent - expired - held`      |
| `takenBack` | The part of `spent` that refunds and disputes took                |
| `trial`     | `{totalMs, usedMs, reservedMs, availableMs}`, or null             |
| `outbound`  | This month's outbound traffic, below                              |
| `resources` | The newest hundred resources, with what each used and was charged |

Each resource carries `resourceId`, `name`, `kind`, `state`, `createdAt`,
`vcpu` and `memoryMiB` (null for a kind with no size), `runningSeconds` (the
billed running time), `activeCpuSeconds`, `memoryGiBSeconds`, `rates`, and
`chargedMicros` and `heldMicros`. `chargedMicros` covers every meter, outbound
traffic included. Divide it by `runningSeconds` for what a run cost a second.

`outbound` is the account's outbound traffic this calendar month, UTC:
`month` (`2026-09`), `sentBytes`, `freeBytes` (what the allowance covered),
`billableBytes`, `allowanceBytes` (100 GiB), and `chargedMicros` and
`writtenOffMicros` as strings. `writtenOffMicros` is traffic your balance or a
spending limit could not cover; it is never charged later
([pricing](./pricing#network-products)).

`GET /v1/limits` says what this key may do and what its agent may still spend:

```json
{
  "access": "full",
  "daily": {
    "limitMicros": "25000000",
    "usedMicros": "3100000",
    "remainingMicros": "21900000",
    "window": "24h"
  }
}
```

- `access` is `full` (every action in every product), `read` (a read-only key:
  every read, no change and no spending) or `selected` (the actions the key
  names).
- `daily.limitMicros` is the most the key's agent may commit in any 24 hours,
  or null when the owner set no limit. `usedMicros` counts settled charges plus
  money still on hold.
- Past the limit, a create, wake, extension or renewal fails with 402
  `spending_limit_reached` and charges nothing.

A limit is set, changed or removed only on the website, at
[API keys](https://withruntime.com/account/keys): by the member who made the key,
or by an owner or admin. No key can.

`GET /v1/audit` is the account's audit log, newest first: member and role
changes, keys, connections, limits, credit, network rules, secrets and
deletions, each with `actor`, `at`, `ip`, `requestId` and `via`. Filter with
`action` (`key.created`, or a group such as `member.`), page with
`before=<next>` and `limit` (1 to 200). It needs a key with full access or a
read-only key, made by an owner or admin; see [teams](./teams).

`GET /v1/sso` is the account's single sign-on: each identity provider, its
domain and whether DNS has proven it, the role people join with, whether
single sign-on is required, and SCIM directory sync. It is read only, with the
same keys as the audit log; an owner changes it on the website. See
[single sign-on](./single-sign-on).

`GET /v1/identity/token?audience=sts.amazonaws.com` is for code inside a
sandbox. It takes the sandbox's `RUNTIME_ID_TOKEN_REQUEST_TOKEN` as the bearer,
not an API key, and answers `{"token", "expiresAt", "issuer", "subject",
"audience"}`: an OIDC token naming that sandbox, for 10 minutes by default
(`lifetimeSeconds` 60 to 3600). See [identity tokens](./identity-tokens).

## Domains, TCP ports, addresses and the tunnel

Paid accounts only; see [networking](./networking). Each is its own product,
not a sandbox's:

| Route                                            | What it does                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `POST /v1/domains`                               | `{hostname, sandboxId, port}`: claim a hostname; answers its DNS records |
| `POST /v1/domains/{hostname}:verify`             | Check the TXT record; `active` when it matches                           |
| `GET`, `DELETE /v1/domains/{hostname}`           | One domain; stop serving it                                              |
| `POST /v1/ports`                                 | `{sandboxId, port}`: a public TCP port; answers `connect`                |
| `GET /v1/ports`, `DELETE /v1/ports/{id}`         | List (`?sandboxId=`); close                                              |
| `POST /v1/addresses`                             | `{family}`: reserve a dedicated outbound address (4 or 6)                |
| `GET /v1/addresses`, `DELETE /v1/addresses/{id}` | List; release                                                            |
| `POST`, `GET`, `DELETE /v1/tunnel`               | Create (`{subnet}`), read or delete the WireGuard tunnel                 |
| `POST /v1/tunnel/peers`                          | `{name, publicKey?, routes?}`: add a peer; answers its wg-quick `config` |
| `POST /v1/tunnel/peers/{id}:rotate`              | `{publicKey?}`: a new key for the peer                                   |
| `DELETE /v1/tunnel/peers/{id}`                   | Remove a peer                                                            |

An account that has not added credit gets `payment_required` (402).

## Pages

A list that can grow answers `{"data": [...], "nextCursor": "..."}`. Pass
`nextCursor` back as `cursor`; `null` ends the list. `limit` is 1 to 100, and
up to 500 for `GET /v1/feedback`.

Short lists answer `{"data": [...]}` whole, with no cursor: a sandbox's file
watches, mounts, interpreter contexts and desktop recordings, registry
credentials and the MCP catalogue. A few are shaped their own way:

- **The audit log,** `GET /v1/audit`, answers `{"events": [...], "next": "..."}`,
  newest first. Pass `next` back as `before`; `null` ends the log. `limit` is 1
  to 200.
- **Secrets,** `GET /v1/egress-secrets`, answers `{"secrets": [...]}`.
- **Single sign-on,** `GET /v1/sso`, answers `connections`, `scim` and `manage`.
- **Process output and file-watch events** carry their own `nextCursor` beside
  the chunks or events, and **build logs** answer `lines` with `nextAfter`.

## Versions

This is 0.2.0. The OpenAPI document's `info.version` is the version you are
talking to.

The 0.1.0 routes under `/v1/resources` were removed on 22 September 2026. Each
answers 410 `upgrade_required`, and `details.replacement` names the route that
replaced it. [The migration guide](./migrate) maps each old call to its new one.
