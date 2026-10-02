# HTTPS API reference

One API for every Runtime Cloud product, at `https://api.withruntime.com`.

The SDKs, the CLI and MCP are thin layers over it. This page is the contract.
The machine-readable one is the public OpenAPI document at
`https://api.withruntime.com/v1/openapi.json`, generated from the same route
definitions the server validates with.

API version: **0.2.0**.

## Requests

Send the key as a bearer token. Keys stay in server-side secret storage; never in
a URL, a browser or a command line others can read. A browser uses a
[session](#sessions) instead.

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

A key sees and uses what its own agent made: another key's sandbox answers 404
`not_found`. An account-wide key, which an owner or admin makes at
[API keys](https://withruntime.com/account/keys) or approves for
`runtime keys create --account-wide`, sees and uses everything in the account,
and `getOrCreate` returns a sandbox another key named. The API cannot make or
change keys ([keys in a team](./teams#keys-in-a-team)).

```bash no-run
curl -sS "https://api.withruntime.com/v1/sandboxes/${ID}:exec" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"command": "python3 -c \"print(sum([125, 250, 375]))\""}'
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

**A 5xx says whose fault it is.** A message that says the fault is ours, not
your request's, was reported to us automatically, with its `requestId`. Retry with the same key; write to us only if it keeps
failing.

| Status   | Codes you may see                                                                                                                            | Safe next step                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 400      | `invalid_request` (with `details.issues`), `invalid_region`, `invalid_trial`, `disk_too_small`                                               | Fix the named fields                                                                                                          |
| 401      | `unauthorized`                                                                                                                               | Check the key                                                                                                                 |
| 402      | `trial_exhausted`, `insufficient_funds`, `spending_limit_reached`                                                                            | Add credit, pay with `funding: "paid"`, or read `GET /v1/limits`                                                              |
| 402      | `payment_required`, `trial_unavailable`                                                                                                      | A paid-only feature, or no trial on this account: add credit ([pricing](./pricing#how-many-at-once) says what counts as paid) |
| 402      | `account_blocked`                                                                                                                            | A payment is disputed or under review; the message says what clears it                                                        |
| 403      | `forbidden` (a read-only key asking to change something is one), `permission_denied`, `connect_not_allowed`                                  | Do not work around a refusal                                                                                                  |
| 404      | `not_found`, `route_not_found`, `file_not_found`, `image_not_found`, `snapshot_not_found`                                                    | Check the id, name or path                                                                                                    |
| 405      | `method_not_allowed`                                                                                                                         | Use the method this page lists for the path                                                                                   |
| 409      | `no_capacity`, `trial_busy`, `trial_domain_limit`, `quota_exceeded`, `build_in_progress`, `volume_releasing`                                 | Clears when something else ends or finishes: wait, then retry with the same key                                               |
| 409      | `not_running`, `sandbox_paused`, `sandbox_stopped`, `sandbox_not_ready`, `is_a_directory`, `name_taken`, `volume_attached`, `fence_conflict` | Resolve the state, then retry                                                                                                 |
| 409      | `lease_too_short`                                                                                                                            | The command's timeout outlasts the lease: extend the sandbox, or give the command a shorter timeout                           |
| 422      | `idempotency_key_reused`                                                                                                                     | Same key, same body; or a new key for new work                                                                                |
| 426      | `upgrade_required`                                                                                                                           | Move to this API version                                                                                                      |
| 429      | `rate_limited`, `trial_build_limit`                                                                                                          | Wait `Retry-After`, then retry with the same key                                                                              |
| 503      | `busy`, `host_unavailable`, `api_unavailable`, `guest_busy`                                                                                  | Retry after `Retry-After` with the same key (the SDKs do)                                                                     |
| 503      | `unavailable`, `fork_unavailable`, `previews_unavailable`                                                                                    | Switched off here on purpose; retrying will not help                                                                          |
| 502, 504 | `interpreter_failed`, `mcp_failed`, `watch_failed`, `recording_failed`, `tunnel_unavailable`                                                 | Something in your sandbox failed; the message says what                                                                       |
| 5xx      | `internal_error`, `guest_failed`, `host_unknown` and any other code                                                                          | A fault on our side, reported to us; retry with the same key                                                                  |

**Temporary refusals are safe to retry.** `no_capacity`, `busy`,
`host_unavailable`, `rate_limited` and `trial_busy` clear on their own: retry
with the same key, a growing delay and a bounded deadline.

- The SDKs retry the 429 and 503 codes themselves.
- An SDK create also waits out `trial_busy`, `quota_exceeded` and
  `no_capacity`, for up to two minutes by default, then returns the refusal.
  The error's `retryable` is `true` for `trial_busy` and `no_capacity`, for a
  loop of your own.
- `no_capacity` answers with a `Retry-After` header, the wait before a first
  retry, for a client that reads only HTTP. The SDKs keep their own growing
  delay.
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
Streaming responses count as requests in flight until their bodies finish or
you cancel them. Receiving the headers does not release a request slot.

## Sandboxes

| Method and path                        | What it does                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/sandboxes`                   | Create. Every field optional.                                                                                                   |
| `GET /v1/sandboxes`                    | List: `state`, `name`, `label=key:value` (repeat), `includeStopped`, `limit`, `cursor`                                          |
| `GET /v1/sandboxes/{id}`               | Read; `waitFor` and `timeoutSeconds` wait for a state                                                                           |
| `POST /v1/sandboxes/{id}:stop`         | Stop. Answers at once, where compute billing ends; a kept disk is written out after                                             |
| `DELETE /v1/sandboxes/{id}`            | Delete for good, in any state (see "Deleting a sandbox" below)                                                                  |
| `POST /v1/sandboxes/{id}:pause`        | Answers once the processors stop, where compute billing ends; memory and files are then saved                                   |
| `POST /v1/sandboxes/{id}:wake`         | Restore a paused sandbox; `timeoutSeconds` sets its next lease                                                                  |
| `POST /v1/sandboxes/{id}:extend`       | `{"seconds": 600}` more before the lease ends                                                                                   |
| `POST /v1/sandboxes/{id}:retention`    | `{"days": 30}` to keep a paused sandbox, 1 to 365                                                                               |
| `POST /v1/sandboxes/{id}:restart`      | Start a stopped persistent sandbox again from its disk                                                                          |
| `POST /v1/sandboxes/{id}:update`       | Change `name`, `labels`, `env`, `autoWake`, `idlePauseSeconds`, `persistent`, `maxTotalCostMicros`, `tailscale` (`null` leaves) |
| `POST /v1/sandboxes/{id}:switch-image` | Move it to another image, keeping `/workspace` (see "Switching its image" below)                                                |

The create body:

| Field                | Default                                      | Notes                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `labels`     | none                                         | Your own handle and up to 32 `key: value` tags                                                                                                                                                                                                                             |
| `env`                | none                                         | Environment variables for every command, process, terminal, SSH session and image start command in it (see "Its environment" below)                                                                                                                                        |
| `funding`            | trial while it lasts, then paid              | `"trial"` never falls back to paid credit                                                                                                                                                                                                                                  |
| `region`             | the default region                           | Use a region listed for your account                                                                                                                                                                                                                                       |
| `vcpu`               | 2                                            | At most 16 on a paid sandbox, 2 on the trial                                                                                                                                                                                                                               |
| `memoryMiB`          | 4096                                         | At least 128; at most 65,536 (64 GiB) on a paid sandbox, 4,096 on the trial; a size outside that is refused with `invalid_request` naming the field                                                                                                                        |
| `diskMiB`            | 4096                                         | At least 3,072; at most 10,240 on the trial. A paid sandbox may ask for up to 16,777,216, and is placed only on a server with that much free disk                                                                                                                          |
| `cpu`                | `"shared"`                                   | `"reserved"` guarantees every vCPU                                                                                                                                                                                                                                         |
| `cpuFloorMillis`     | 50                                           | Guaranteed CPU while shared, in thousandths of a vCPU: at most `vcpu` x 1000 (16,000 at 16 vCPU), and 250 on the trial                                                                                                                                                     |
| `timeoutSeconds`     | 1800                                         | How long it may run before its lease ends, 60 to 3600. On the trial, a sandbox still working at its end is extended until the trial hours run out                                                                                                                          |
| `onLeaseEnd`         | `"pause"`                                    | `"pause"` keeps memory and files when `timeoutSeconds` runs out; wake it later. `"stop"` ends it, and an ordinary sandbox's disk with it. `"stop"` is the default with `pausable: false`                                                                                   |
| `pausable`           | true                                         |                                                                                                                                                                                                                                                                            |
| `idlePauseSeconds`   | {{idle-pause-seconds}}                       | Pause after this many seconds with nothing happening: no request, no command or terminal running, no open connection, no traffic and no CPU use. 0 is never, otherwise {{idle-pause-min}} to {{idle-pause-max}}. Not set on a sandbox that cannot pause or is `persistent` |
| `autoWake`           | true                                         | A request to a paused sandbox wakes it (see below)                                                                                                                                                                                                                         |
| `persistent`         | false                                        | Paid only: the lease renews itself while credit lasts, and a stopped sandbox keeps its disk for `:restart`. Set to `false` with `:update` and a stopped one's disk is deleted                                                                                              |
| `maxTotalCostMicros` | none                                         | The most the sandbox may cost over its whole life                                                                                                                                                                                                                          |
| `getOrCreate`        | false                                        | With `name`: answer the sandbox that holds the name (see below)                                                                                                                                                                                                            |
| `network`            | every public port (paid), 80 and 443 (trial) | Same shape as `PUT /v1/sandboxes/{id}/network`                                                                                                                                                                                                                             |
| `maxCostMicros`      | none                                         | Refuse the create if its first lease would cost more                                                                                                                                                                                                                       |
| `image`, `volumes`   | none                                         | A ready image (its id, `name`, `name:tag` or `name@version`) and up to four `{volumeId, path, mode}`. An image with a start command answers once its ready check passes, in `start`                                                                                        |
| `snapshot`           | none                                         | A ready snapshot id: start as a copy of it. Not with `image`                                                                                                                                                                                                               |
| `tailscale`          | none                                         | Paid only: `{authKeySecret, hostname?, tags?}` joins your Tailscale network once it runs (see "On your tailnet" below)                                                                                                                                                     |

Sizes are limits you ask for. The server checks their combinations against
account limits and the host's measured capacity.

**Wake on request.** A paused sandbox with `autoWake` wakes by itself when a
command, file, process, terminal, desktop or interpreter call reaches it, and
the call runs once it is running, usually within a second. A visit
to one of its shared ports wakes it too: an API client's request waits up to
30 seconds, and a browser is shown a page that reloads itself. The wake is an
ordinary wake: a fresh lease of the sandbox's own `timeoutSeconds`, or the lease
it paused with when that ends later, billed from the moment it runs. With `autoWake: false` the call fails with `sandbox_paused`
until `:wake`. A wake that cannot be paid for fails with the refusal, such as
`insufficient_funds`, and leaves the sandbox paused.

**Names.** A name is unique in the account while its sandbox can still run:
starting, running, paused, or stopped and persistent. A create that names a
held name fails with `name_taken` (409); `details.sandboxId` names the holder
when your key can reach it. With `getOrCreate: true` the create answers the
holder instead, woken if paused and restarted if stopped and persistent, with
`reused: true`; the other fields apply only when it creates one. A sandbox that
stops for good gives its name up and keeps it in its own record.

**Running for longer than a lease.** `persistent: true`, at create or with
`:update`, renews the lease on the server while the account has credit, up to
`maxTotalCostMicros`, and keeps the disk after a stop, billed as reserved disk.
A stopped persistent sandbox is listed with the live ones. `:update` with
`{"persistent": false}` makes it an ordinary sandbox again: a running one stops
paying for its disk at once, and a stopped one has its disk deleted. It is
refused while the sandbox is paused; wake or stop it first. To end one for
good in any state, delete it. Without persistence, `:extend` moves the lease later, up to an hour ahead of now; the
SDKs' `keepAlive` calls it for you. A trial sandbox that is still working when
its lease is about to end (a command, terminal, SSH session or port forward
open, CPU in use or traffic moving in the last ten seconds) is extended by its
own `timeoutSeconds` each time, until the trial hours run out; then it pauses
as any lease's end does. A paid sandbox's lease ends on time: use `persistent`
or `keepAlive` to run longer.

**Its environment.** `env` at create sets variables that every command,
background process, terminal, SSH session and the image's start command in the
sandbox is started with, for its whole life: through pauses, wakes and
restarts. A command's own `env` is put over them. `:update` with `env` changes
them: a value sets a variable, `null` removes it, and the rest stay; commands
started after the change get it, and running ones keep what they started with.
At most {{sandbox-env-vars}} variables and {{sandbox-env-size}} of names and values; past that the answer is
`env_too_large` (400), and a name that is not a letter or underscore followed by
letters, digits and underscores is `invalid_env` (400). A command whose own `env`
and the sandbox's together pass what one command can carry is refused with
`env_too_large` (400) before it runs. Values are write-only: answers carry only `envNames`, and no
list, log or audit entry holds a value. They are stored encrypted, and the
request fingerprint an `Idempotency-Key` is checked against holds a keyed hash
of them, never the values. Copies made by `:fork` keep them, because they are
the same machine and its processes already hold them; a sandbox created from a
snapshot takes only its own `env`. An SSH session gets every variable whose
value has no double quote, backslash or line break. A deployment that cannot
store them answers `env_unavailable` (503) and creates nothing.

**Deleting a sandbox.** `DELETE /v1/sandboxes/{id}` works in any state. It
stops the sandbox if it runs or is paused, deletes its disk and its paused
memory, revokes its previews and TCP ports, drops its environment, gives up its
name at once, and removes it from every list. Compute billing ends as a stop's
does; a disk kept for `:restart` is billed until its host confirms the
deletion, usually seconds. Its snapshots are separate and stay until you delete
them, and its usage, charges and audit entries stay. A custom domain pointed at
it stays yours: point it at another sandbox or remove it. The answer is
`{id, status: "deleted", state, deletedAt}`; afterwards the sandbox reads
nowhere, and `GET` answers `not_found`. Deleting it again answers the same, with
or without the same key. A read-only key cannot delete. A sandbox a job or a
managed service runs in is ended by that job or service instead.

**Switching its image.** `POST /v1/sandboxes/{id}:switch-image` with
`{"image": "web:v2", "keep": "workspace"}` moves a sandbox to another image and
keeps its id and name, `/workspace` (its home: dotfiles, `pip install` and
`npm install -g`), volumes, environment, labels, previews and ports. Its
processes restart, and the new image's start command runs as at create.
Everything else on its old disk is lost (`sudo` and apt installs, `/etc`), so
`keep` must be `"workspace"`; without it the answer is
`switch_keeps_workspace_only` (400) and nothing changes. Snapshot it first to
keep everything. A running sandbox is paused first; a paused one, or a stopped
persistent one, is switched as it is; a stopped ordinary one kept no disk
(`switch_needs_disk`, 409). It is charged as a wake. The answer comes once the
sandbox runs the new image. If anything fails, the switch is undone and the
answer is `switch_undone` (409): the sandbox is paused or stopped on its old image
with its files and memory as they were. The image must be ready, on the
sandbox's server (`image_on_another_host`, 409), different from the one it runs
(`image_unchanged`, 409) and fit its disk (`disk_too_small`, 409); copying
`/workspace` may take up to {{switch-copy-time}}.

**Changing its size, when enabled.** This is disabled by default and omitted
from OpenAPI and MCP until enabled; until then it answers
`resize_unavailable` (503). `POST /v1/sandboxes/{id}:resize` with
`{"vcpu": 2, "memoryMiB": 4096, "restart": true}` (either size, or both) gives a
sandbox a new size by a restart. It keeps its id and name, its whole disk,
volumes, environment, labels, previews and ports; its programs stop and its
image's start command runs again. `restart` must be `true`; without it the
answer is `resize_needs_restart` (400) and nothing changes. Snapshot it first to
keep its memory too. A running sandbox is paused first, or stopped if it is
persistent; a sandbox that can do neither is refused before anything stops
(`resize_needs_disk`, 409), and one that does not get there is left as it is
(`resize_not_halted`, 409). The answer comes once it runs at the new size, on
the same server. Memory is charged on the new size from then, at the same
rates. Nothing changes when the server has no room (`no_capacity`, 409), the
size is above your quota (`quota_exceeded`) or the trial's 2 vCPU and 4 GiB
(`invalid_trial`, 400), it is the size it has (`size_unchanged`, 409), or a
snapshot or fork of it is being taken (`resize_during_snapshot`, 409; retry).
If the server cannot boot it at the new size, it stays paused or stopped with
its disk and the new size (`resize_not_started`, 409), and its next wake or
restart starts it at that size.

**On your tailnet.** A paid sandbox can join your own Tailscale network.
Store an auth key for jobs (`printf %s "$TS_AUTHKEY" | runtime secrets set TS_AUTHKEY --jobs`),
then `POST /v1/sandboxes/{id}/tailscale` with `{"authKeySecret": "TS_AUTHKEY"}`,
and optionally `hostname` and `tags`, or pass the same object as `tailscale` at
create. The answer gives its tailnet `addresses`, `dnsName` and `mode`; `GET`
reads them again and `DELETE` logs the machine out. The key is never answered,
logged or written to the sandbox's disk. [Networking](./networking#your-tailscale-network) has the rest.

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
fields are `cwd`, `env`, `stdin`, `timeoutMs` (default 60,000, or what the lease has left when that is less; at
most 24 hours)
and `stream`. A timeout is a result with `timedOut: true`, not an error. `env`
is put over the sandbox's own environment; its values are never echoed and are
stored only as hashes.

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
refused one answers `unauthorized` (401) or `forbidden` (403) and says why. Your
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
Empty and control frames also share a bounded pending queue. Flooding that
queue closes the socket even when data bytes remain below the credit limit.

## Files

| Method and path                                                 | What it does                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/sandboxes/{id}/files/content?path=`                    | The file's raw bytes, any size; `x-content-length` gives the length first (and `x-content-sha256` a small file's digest), so check it: a body that ends short failed     |
| `PUT /v1/sandboxes/{id}/files/content?path=`                    | Replace the file with the raw request body, up to 1 MiB (larger answers 413: use `/uploads`); makes parents; `mode=755` sets its permissions (644 by default)            |
| `GET /v1/sandboxes/{id}/files/list?path=`                       | Entries; `depth`, `glob`, `hidden`, `limit`                                                                                                                              |
| `GET /v1/sandboxes/{id}/files/stat?path=`                       | Type, size, mode and times, or `{"exists": false}`                                                                                                                       |
| `POST /v1/sandboxes/{id}/files:mkdir`                           | `{"path", "parents"}`                                                                                                                                                    |
| `POST /v1/sandboxes/{id}/files:remove`                          | `{"path", "recursive"}`                                                                                                                                                  |
| `POST /v1/sandboxes/{id}/files:rename`                          | `{"from", "to", "overwrite"}`                                                                                                                                            |
| `POST /v1/sandboxes/{id}/files:chmod`                           | `{"path", "mode": "755"}`                                                                                                                                                |
| `POST`, `GET /v1/sandboxes/{id}/files/watches`                  | Watch a directory: `{"path", "recursive", "events", "include", "exclude", "batchMs", "timeoutMs"}`; list the watches                                                     |
| `GET /v1/sandboxes/{id}/files/watches/{watchId}/events?cursor=` | Its events after a cursor (`waitMs` up to 8000), or `follow=true` for a stream                                                                                           |
| `DELETE /v1/sandboxes/{id}/files/watches/{watchId}`             | Stop a watch                                                                                                                                                             |
| `POST /v1/sandboxes/{id}/uploads`                               | Begin a large upload: `{"path", "size", "sha256", "mode"}`; `path` must be under `/workspace` (move it with exec after the commit)                                       |
| `PUT /v1/sandboxes/{id}/uploads/{uploadId}?offset=`             | One chunk of raw bytes; chunks may go in parallel                                                                                                                        |
| `POST /v1/sandboxes/{id}/uploads/{uploadId}:commit`             | Check the digest and move the file into place atomically                                                                                                                 |
| `POST /v1/sandboxes/{id}/uploads/{uploadId}:abort`              | Give up                                                                                                                                                                  |
| `GET /v1/sandboxes/{id}/files/archive?path=`                    | A folder as tar, streamed; `gzip=true`, `user=sandbox` or `root`, and repeated relative `exclude` paths. A failed folder stream ends as an archive no tar reader accepts |
| `PUT /v1/sandboxes/{id}/files/archive?path=`                    | Unpack a tar (gzipped or not) of up to 1 MiB from the raw body into the folder, making it; merges with what is there                                                     |
| `POST /v1/sandboxes/{id}/files/archive/uploads`                 | Begin a larger one: `{"path", "gzip", "user"}`; `gzip` and `user` are optional; answers `uploadId`                                                                       |
| `PUT …/files/archive/uploads/{uploadId}?offset=`                | The next part, up to 1 MiB, in order; a part sent twice is not written twice                                                                                             |
| `POST …/files/archive/uploads/{uploadId}:commit`                | Answers once tar has unpacked it all (`:abort` stops it; what was unpacked stays)                                                                                        |

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
default, at most a day, or `0` to run until stopped).

A watch started with `"webhook": true` also sends its changes to your
account's webhooks as `sandbox.files.changed` events (see
[webhooks](./observability#webhooks)), so nothing in the sandbox or on your side
has to read it. Runtime reads it without waking the sandbox, at most once every
{{file-hook-window}}, and an account has at most {{file-hook-limit}} such
watches. A sandbox session cannot start one.

A folder moves as one tar archive, packed or unpacked by `tar` inside the
sandbox as the sandbox user by default, so a folder download needs only the
key's `read_file` permission and an upload `write_file`. `user=root` explicitly
uses passwordless `sudo` inside that sandbox, with the same file permissions;
an image without it refuses with `root_unavailable` before sending file bytes.
Downloads accept repeated `exclude` parameters for plain relative paths, not
glob patterns. `..`, empty or absolute paths are refused. A multipart upload
sets `user` when it begins; direct uploads detect gzip from the archive header. The sandbox needs `sh`,
`tar` and `base64` (and `gzip` for a compressed archive), which every image
from Runtime's base has. At most four folders move in each direction in a
sandbox at once. Like every file call, a folder call wakes a paused sandbox.
The SDKs' `files.upload` and `files.download` and the CLI's `runtime sandbox cp`
use these routes. The SDKs also expose `files.archive` and `files.unarchive`
for callers that need the archive bytes themselves.

```bash no-run
curl -sS "https://api.withruntime.com/v1/sandboxes/${ID}/files/archive?path=/workspace/app&gzip=true" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" -o app.tar.gz
curl -sS -X PUT "https://api.withruntime.com/v1/sandboxes/${ID}/files/archive?path=/workspace/site" \
  -H "Authorization: Bearer ${RUNTIME_API_KEY}" --data-binary @site.tar.gz
```

## Sessions

A session is a short-lived token a browser uses to reach one sandbox without
your key. A key that can run commands in the sandbox makes, lists and revokes
them:

| Method and path                                       | What it does                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /v1/sandboxes/{id}/sessions`                    | `{"ttlSeconds", "origins", "name"}`; answers the session with its `token`, shown once, and `apiUrl` |
| `GET /v1/sandboxes/{id}/sessions`                     | Its sessions still active, and those that ended in the last day                                     |
| `POST /v1/sandboxes/{id}/sessions/{sessionId}:revoke` | End one now                                                                                         |

`ttlSeconds` is {{session-default-seconds}} unless given and
{{session-max-seconds}} at most. `origins` lists up to {{session-origins}}
exact origins, `https://host[:port]` or `http://localhost[:port]`.

Send the token as the bearer: `Authorization: Bearer rtsess_...`. It is served
the sandbox's routes under `:exec`, `/processes`, `/files`, `/uploads`,
`/interpreter`, `GET /v1/sandboxes/{id}` and `GET /v1/sandboxes/{id}/previews`,
for its own sandbox only; everything else answers `forbidden` (403), and an ended
session `unauthorized` (401). A preview token it is handed ends when it does.

The API answers CORS only for a session's own origins: a preflight from a page
some session of that sandbox lists, and the answers to that session's
requests, errors included. A session request from any other page is refused.
Requests with a key carry no CORS headers.

A replay of a create with the same `Idempotency-Key` answers the session with
`token: null`; revoke it and make another. The SDKs do that for you.

## Private preview tokens

`POST /v1/sandboxes/{id}/previews` accepts optional `ttlSeconds` and
`expiresAt` fields. `GET /v1/sandboxes/{id}/previews/{port}` accepts them as
query parameters; `runtime_sandbox_previews_create` accepts the same fields.
`expiresAt` is an ISO timestamp with a timezone, at least a minute and at most
a week ahead. Invalid deadlines answer `invalid_request` (400) before changing
the preview.

With `expiresAt` alone, the token ends by that deadline. With both fields, it
ends by the earlier of the requested lifetime and deadline. Existing relative
lifetimes keep their rounding; an absolute deadline rounds down to whole seconds
and is never exceeded. Read `tokenExpiresAt` from the response rather than
calculating it yourself. A preview token read through a sandbox session also
ends by that session's expiry. With less than a minute left, the session receives
no fresh token. Sessions still cannot create or rotate previews, or use MCP.

## Other products

| Method and path                                                                                                                                                                                                                        | Product                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /v1/sandboxes/{id}/interpreter:run`, `…/interpreter/contexts` (`language`: python, javascript, typescript, r, java, bash, go), `…/contexts/{context}:restart`, `:interrupt`, `DELETE`, `GET …/contexts/{context}/results/{file}` | Code interpreter                                                                               |
| `POST`, `GET /v1/sandboxes/{id}/mounts`, `…/mounts:unmount`                                                                                                                                                                            | Bucket mounts                                                                                  |
| `POST`, `GET`, `DELETE /v1/sandboxes/{id}/tailscale`                                                                                                                                                                                   | Your Tailscale network                                                                         |
| `POST`, `GET /v1/sandboxes/{id}/previews`, `…/previews/{port}`, `…/previews/{port}:rotate`                                                                                                                                             | Previews                                                                                       |
| `POST /v1/sandboxes/{id}/browser:start`, `GET /v1/sandboxes/{id}/browser`, `POST /v1/sandboxes/{id}/browser:stop`                                                                                                                      | A Chromium browser and its private CDP address ([JavaScript](./javascript#a-browser-over-cdp)) |
| `POST /v1/sandboxes/{id}/desktop:start`, `:stop`, `:act`, `GET …/desktop/screenshot`                                                                                                                                                   | Desktop                                                                                        |
| `POST`, `GET /v1/sandboxes/{id}/desktop/recordings`, `GET …/recordings/{recordingId}`, `…/video`, `:stop`, `DELETE`                                                                                                                    | Desktop recordings                                                                             |
| `GET /v1/mcp/catalog`; `POST`, `GET`, `DELETE /v1/sandboxes/{id}/mcp`                                                                                                                                                                  | MCP servers                                                                                    |
| `GET`, `PUT /v1/sandboxes/{id}/network`                                                                                                                                                                                                | Network rules                                                                                  |
| `GET /v1/egress-secrets`, `PUT`, `DELETE /v1/egress-secrets/{name}`                                                                                                                                                                    | Secrets                                                                                        |
| `GET`, `PUT`, `DELETE /v1/network/upstream-proxy`                                                                                                                                                                                      | Your own proxy                                                                                 |
| `GET`, `PUT /v1/network/private`                                                                                                                                                                                                       | Your sandboxes reach each other by name                                                        |
| `POST`, `GET /v1/feedback`                                                                                                                                                                                                             | Feedback                                                                                       |
| `POST /v1/support/messages`, `GET /v1/support/conversations/{id}`                                                                                                                                                                      | Support                                                                                        |
| `GET /v1/me`, `GET /v1/usage`, `GET /v1/usage/requests?range=24h`, `GET /v1/limits`, `GET /v1/audit`                                                                                                                                   | Account                                                                                        |
| `GET /v1/sso`                                                                                                                                                                                                                          | Single sign-on                                                                                 |
| `GET`, `POST /v1/identity/token?audience=` (from inside a sandbox, with its request token)                                                                                                                                             | Identity tokens                                                                                |
| `GET /v1/usage/compare?provider=e2b&days=30`, `GET /v1/switching`, `POST /v1/switching`                                                                                                                                                | Switching                                                                                      |
| `POST`, `GET /v1/images`, `GET /v1/images/{id}`, `…/logs?follow=true`, `:tag`, `:untag`, `:delete`, `GET /v1/images/resolve?ref=`                                                                                                      | Custom images                                                                                  |
| `POST /v1/images/context/missing`, `PUT /v1/images/context/{digest}`                                                                                                                                                                   | Image build contexts                                                                           |
| `GET`, `POST /v1/images/registries`, `POST /v1/images/registries:delete`                                                                                                                                                               | Private registries                                                                             |
| `POST`, `GET /v1/volumes`, `GET /v1/volumes/{id}`, `:delete`, `:backup`, `:backup-policy`; `GET /v1/volume-backups`, `…/{id}`, `:delete`                                                                                               | Volumes and backups                                                                            |
| `POST /v1/sandboxes/{id}:fork`, `POST /v1/sandboxes/{id}:snapshot`, `GET /v1/snapshots`, `…/{id}`, `:update` (name, labels), `:extend`, `:delete`                                                                                      | Forks and snapshots                                                                            |
| `GET /v1/sandboxes/{id}/metrics?range=1h`, `GET /v1/events`                                                                                                                                                                            | Metrics and events                                                                             |
| `POST`, `GET /v1/webhooks`, `GET /v1/webhooks/{id}`, `:update`, `:rotate-secret`, `:test`, `:delete`, `…/deliveries`, `POST /v1/webhook-deliveries/{id}:retry`                                                                         | Webhooks                                                                                       |
| `POST`, `GET /v1/otel-exports`, `GET /v1/otel-exports/{id}`, `:update`, `:flush`, `:delete`                                                                                                                                            | OpenTelemetry export                                                                           |

**Shared volumes, when enabled.** This feature is disabled by default and
omitted from OpenAPI and MCP until enabled. Enabled deployments accept
`shared: true` at volume creation. The mode is immutable; a restore from
`fromBackup` inherits the source volume's mode and refuses a contradictory
`shared` value. Disabled deployments omit the create field and refuse it
as an unknown field; restoring a shared backup is unavailable (503).

`POST /v1/volumes/{id}:attach` accepts `{sandboxId, path}`.
`POST /v1/volumes/{id}/attachments/{attachmentId}:detach` requests detach,
and `GET /v1/volumes/{id}/attachments/{attachmentId}` reads the saved receipt.
The three routes answer unavailable (503) when the feature is disabled.
A receipt contains `id`, `volumeId`, `sandboxId`, `path`, `mode`, `state`,
`generation`, `error`, `attachedAt` and `changedAt`. Its state is `attaching`,
`active`, `detaching` or `detached`; `mode` is `rw`. A waiter timeout or
cancellation does not cancel committed work. A busy detach keeps the mount
and records the error; free it before retrying with a new idempotency key.
See [shared volumes](./storage#shared-volumes-when-enabled).

**Volume growth, when enabled.** This feature is disabled by default and
omitted from OpenAPI and MCP until enabled. `POST /v1/volumes/{id}:resize`
accepts `{sizeMiB}` and grows a detached ordinary volume on its current server.
It refuses shrinking or shared volumes with `invalid_request` (400), live
attachments with `volume_attached` (409), and an active operation or a backup
still being copied off the server with `operation_pending` (409). A backup
asked for while the volume grows is refused with `volume_not_ready` (409).
When disabled it answers `unavailable` (503).

The volume remains `ready`; its nullable `resize` record contains `id`,
`operationId`, `sizeMiB`, `state`, `generation` and `error`. Follow the record's
`pending`, `running`, `completed` or `failed` state, rather than treating a
returned ready volume as completed growth. Attach and delete wait for an
active operation. Old confirmed size and billing continue until completion;
the storage rate is unchanged. See [volume growth](./storage#growing-a-volume-when-enabled).

Snapshots accept `mode: "memory"` (the default) or `mode: "disk"` in
`POST /v1/sandboxes/{id}:snapshot`. Memory snapshots keep files and running
processes. Disk snapshots keep only the root filesystem; a sandbox created
from one boots fresh with no saved processes. Both require a paused source
without attached volumes and keep the same source size, ownership, retention
and storage pricing. The returned snapshot includes its `mode`. Keep the
source paused until the snapshot's state is `ready` or `failed`; `Prefer: wait`
can return while capture is still in progress.

Where deferred compression has been qualified and enabled, a memory
snapshot may be `ready` with `compressionPending: true`, startable
on the same server from its captured raw state. `meteredBytes` is zero until
Runtime publishes the verified compressed allocation; temporary raw files
are not charged. While compression is pending, `backedUp` is false and
`durability.state` is `none`. Its off-server copy is queued after compression.
See [snapshot storage](./storage#snapshots-survive-their-server).

Wakes and copies stay on the source server by default. Cross-server transfer
is disabled until an operator-qualified deployment enables it; then compatible
same-region placement may be used when the source cannot fit the wake or
copy. Existing image, volume and private-placement constraints still apply.
See [qualified transfers](./storage#wake-or-fork-on-another-server-when-enabled).

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
`billableBytes`, `allowanceBytes` ({{outbound-allowance}}), and `chargedMicros` and
`writtenOffMicros` as strings. `writtenOffMicros` is traffic your balance or a
spending limit could not cover; it is never charged later
([pricing](./pricing#network-products)).

### Export settled usage

`GET /v1/usage/export?since=2026-09-01T00:00:00Z&until=2026-10-01T00:00:00Z`
reads settled usage for every product visible to the key. `since` is inclusive
and `until` exclusive, both UTC ISO timestamps ending in `Z`; the filter uses
when an interval settled, rather than when its resource was created. Pending
holds are excluded.

The answer is `{since, until, data, nextCursor, csv}`. Rows name the interval
and resource, kind, meter, funding, interval start/end, settlement time, billed
milliseconds, `chargedMicros`, quoted component rates and measurement evidence.
Money and quantities are exact decimal strings. `billedMilliseconds`,
measurements and evidence can be null when unavailable.

Follow `nextCursor` with the same range until it is null. Each page rechecks
the key's `usage` permission and resource visibility. These are live reads;
usage that settles after an earlier page can appear on a later page. The
server's `csv` includes a header on its first page only, so concatenate the
pages unchanged, in order. This range export covers more than the newest
hundred resources in `GET /v1/usage`.

`GET /v1/limits` says what this key may do and what its agent may still spend:

```json
{
  "access": "full",
  "daily": {
    "limitMicros": "25000000",
    "usedMicros": "3100000",
    "remainingMicros": "21900000",
    "window": "24h"
  },
  "trial": null
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
- `trial` is the account's free trial, the same figures as `GET /v1/usage`:
  `{totalMs, usedMs, reservedMs, availableMs}` in milliseconds, or null when
  the account has none, as here. `availableMs` is what a new trial sandbox can
  still use. A trial sandbox that has not ended holds its whole lease in
  `reservedMs`, and what it did not use comes back when it ends.

A limit is set, changed or removed only on the website, at
[API keys](https://withruntime.com/account/keys): by the member who made the key,
or by an owner or admin. No key can.

`GET /v1/audit` is the account's audit log, newest first: member and role
changes, keys, connections, limits, credit, network rules, secrets and
deletions, each with `actor`, `at`, `ip`, `requestId`, `via` and `sandbox`
(the sandbox the call came from, when code in it called
`http://runtime.internal`; otherwise null). Filter with
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
