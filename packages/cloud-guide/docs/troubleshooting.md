# Diagnose a sandbox integration

Start with the failing step: connection, creation, readiness, execution, pause, wake or cleanup.

- Every error carries a `code`, a `hint` and a `requestId`. Follow the hint
  first.
- Keep the request id, the sandbox id, the time and the SDK version for a
  report. Never include API keys, connection secrets or private file contents.
- Confirm you are using the correct account and API origin.

Check https://withruntime.com/status first. It shows whether the API responds.
That check runs from outside our servers every two minutes. It also shows
whether a real sandbox starts, runs a command and stops. That test runs from
outside every ten minutes. The page also shows uptime since the record began,
and notes on incidents.

If it looks like Runtime's fault, report it with
`npx withruntime feedback "..." --request-id <id>`. If you are stuck, ask
`npx withruntime support "..."`. The support agent reads your account and can
reproduce the problem. See [feedback and support](./feedback-and-support).

## Browser login does not finish

**Open the exact link the CLI printed, check the code, and approve as an owner,
admin or developer of the account.**

- If the command was stopped while it waited, run it again. It shows the same
  link and code, and picks up the approval.
- Approval and delivery are separate. The browser waits for the CLI to receive
  and verify the credential before it shows success.
- Requests expire after 15 minutes. After expiry, start a new `npx withruntime login`.
- On a remote terminal, use `--no-browser` and open its link on your own device.
- If the CLI cannot reach Runtime, check its outbound HTTPS access. Do not paste
  credentials into the browser or into your agent's prompt.

Run `npx withruntime whoami` to check a saved connection. If it is refused, run
login again. `RUNTIME_API_KEY` overrides the saved connection. An invalid
environment key can fail even when browser login worked before. Remove an
unwanted override without printing its value.

If a previous credential update was interrupted, the CLI names its lock file.
Remove that file only after confirming no Runtime command is running, then
retry. The CLI never steals an active lock automatically.

## Behind a proxy, every call says `No answer from Runtime`

**From SDK version 0.4.0, the CLI and both SDKs use the proxy your environment
names, the way curl does:**

- `HTTPS_PROXY` carries every call to the HTTPS API and terminal WebSockets,
  through a `CONNECT` tunnel. A `user:password@` in its address is sent to the
  proxy. `HTTP_PROXY` is used only for `http://` addresses, never for HTTPS.
- `NO_PROXY` lists hosts to reach directly, split by commas or spaces. A name
  covers its subdomains, a leading dot is allowed, `host:port` limits it to one
  port, and `*` alone means every host.
- Each name works in upper or lower case. When both are set, lower case wins.
  A proxy address without a scheme is taken as `http://`.
- A proxy address that cannot be used fails immediately with `invalid_proxy`,
  naming the variable.

When the proxy cannot be reached, the error names it. For example:
`No answer from Runtime at https://api.withruntime.com through the proxy
http://proxy:3128 (HTTPS_PROXY).` If the proxy returned 407, the hint says to
put credentials in the variable as `http://user:password@host:port`. If only
`HTTP_PROXY` is set, the hint says to set `HTTPS_PROXY`, since the API is HTTPS.

On earlier versions, every call fails with `connection_error` ("No answer from
Runtime at https://api.withruntime.com") while `curl` through the same proxy
works, because the client connects directly:

- **CLI and JavaScript SDK on Node 22.21 or later, or Node 24.** Also set
  `NODE_USE_ENV_PROXY=1`. Then Node's own `fetch` reads those variables. Node's
  documentation marks this setting as still in active development.
- **Under Bun**, the proxy variables already work.
- **The Python SDK** connects directly, and no setting changes that. Upgrade.

```bash no-run
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://proxy.example.com:3128 npx withruntime whoami
```

## The CLI stops with `OpenSSL configuration error`

**Node could not read an OpenSSL configuration file, so it stopped before the
CLI started.** This happens with a Node build that uses the system's OpenSSL,
such as Homebrew's or a Linux distribution's. It also happens inside a sandbox
that blocks reading outside the project, such as a coding agent's.
`OPENSSL_CONF` naming a file that cannot be read does the same. The message
names the file:

```text
node: OpenSSL configuration error:
...:BIO_new_file:Permission denied:...calling fopen(/opt/homebrew/etc/openssl@3/openssl.cnf, rb)
```

The CLI does not need that file. Give Node an empty one for the command, or let
the sandbox read the file that the message names:

```bash no-run
OPENSSL_CONF=/dev/null npx withruntime whoami
```

Node from nodejs.org reads no such file, so it starts either way.

## Creation is refused

| Code                      | What it means                                                                               | What to do                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `no_credit_running_limit` | Four sandboxes without credit are already running; `details` names them                     | Stop or pause one, or retry once one ends                                                                                          |
| `no_credit_domain_limit`  | Your email domain's eight shared slots without credit are all running                       | Stop or pause one, or add credit                                                                                                   |
| `included_usage_used_up`  | This month's free usage, or a product's share of it, is used                                | Add credit, or wait for the 1st (UTC)                                                                                              |
| `no_credit_size_limit`    | A sandbox without credit is at most 2 vCPU, 4 GiB of memory and 10 GiB of disk              | Omit the size fields for the default                                                                                               |
| `invalid_request`         | `details.issues` names every wrong field                                                    | Fix the named fields; unknown fields are refused                                                                                   |
| `invalid_region`          | `details.available` lists your regions                                                      | Use a region listed for your account, or omit it                                                                                   |
| `no_capacity`, `busy`     | No host has room right now (503)                                                            | Wait `Retry-After`, then retry with the same idempotency key and a growing delay; for a planned burst, [book room](./reservations) |
| `image_not_found`         | `image` names nothing in your account; the message lists the name's tags                    | Name one it lists, or build a public image first                                                                                   |
| `volume_not_ready`        | A volume it names, or one you back up, is still `creating` (a restore is too until checked) | Wait until the volume reads `ready`, then try again                                                                                |

**`no_credit_running_limit` is temporary.** It returns 429 with `Retry-After: 5`.
A slot frees when any sandbox without credit stops or pauses.

- Retry with the same idempotency key, a growing delay and a bounded deadline,
  or stop or pause one of the sandboxes `details` names.
- A fork asking for more running copies than an account without credit allows
  never fits. Ask for fewer.
- An SDK create waits for a slot by itself, for up to two minutes by default
  (`waitForCapacityMs` in JavaScript, `wait_for_capacity` in Python, Ruby), and
  then returns the refusal. A wake and a restart wait the same way for room on
  their own server. A fork never waits. The error's `retryable` is `true`, for a
  loop of your own.
- Once the account holds prepaid credit, it runs more sandboxes immediately,
  with nothing to change.

Once the free usage is used up, an account with prepaid credit keeps running on
that credit, with nothing to change. An account with neither is refused with
`included_usage_used_up` until the 1st (UTC). See how much is left with
`npx withruntime usage`, or with `GET /v1/usage` or `GET /v1/limits`.
`trial.availableMs` is what a new sandbox without credit can still use, in
milliseconds. `allowances` shows what each pool has left this month. See
[free usage](./included-usage).

## A sandbox's `env`, stop, delete or image switch is refused

| Code                          | What it means                                                                                                                                                          | What to do                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `invalid_env`                 | A name is not a letter or underscore followed by letters, digits and underscores, or a value holds a NUL; `details.name` says which                                    | Rename the variable, or drop the byte                                                                                        |
| `env_too_large`               | More than {{sandbox-env-vars}} variables or {{sandbox-env-size}} in the sandbox, or a command's own `env` and the sandbox's together are more than one command carries | Keep large settings in a file in `/workspace`, or pass fewer in the command                                                  |
| `env_unavailable`             | This deployment cannot store an environment; nothing was created or changed                                                                                            | Pass `env` to each `exec` instead                                                                                            |
| `resize_unavailable`          | Changing a running sandbox's size is not switched on here; nothing was changed                                                                                         | Create a new sandbox at the size you need                                                                                    |
| `env_unreadable`              | Its stored environment could not be opened, a fault on our side, so nothing ran                                                                                        | Set it again with `:update`, or contact support with the request id                                                          |
| `sandbox_in_use`              | The sandbox runs a managed service                                                                                                                                     | Delete the service, which ends its sandbox                                                                                   |
| `snapshot_in_progress`        | A stop or delete came while a snapshot of the sandbox is still being taken, and would have lost it; nothing changed                                                    | Wait until the snapshot is `ready` (seconds; `GET /v1/snapshots/{id}`), then stop or delete it; or delete the snapshot first |
| `switch_keeps_workspace_only` | `keep` named something other than `"workspace"`: a switch of image keeps only `/workspace`; nothing changed                                                            | Leave `keep` out, or snapshot the sandbox first to keep everything                                                           |
| `switch_undone`               | The switch did not finish and was undone: the sandbox is on its old image with its files as they were                                                                  | Retry; a `/workspace` that takes longer than {{switch-copy-time}} to copy cannot be switched                                 |
| `switch_needs_disk`           | A stopped sandbox that was not persistent kept no disk, so there is nothing to move                                                                                    | Create a new sandbox from the image                                                                                          |
| `image_on_another_host`       | The image is stored on another server than the sandbox                                                                                                                 | Create a new sandbox from the image, or build it again                                                                       |
| `delete_unavailable`          | Deleting cannot run here yet, a fault on our side that we are told of                                                                                                  | Stop it instead, and delete it later                                                                                         |

## Creation returns `starting`

**The SDKs and `npx withruntime sandboxes create` wait for `running` for you.**
Over raw HTTP, send `Prefer: wait=60`, or read the sandbox with
`?waitFor=running`.

Wait for running before you issue commands. A command on a sandbox that is still
starting waits up to 30 seconds, then returns `sandbox_not_ready`. If the
sandbox stops before it is ready, its `stopReason` says why. Report that failure
with its sandbox id and request id. Do not start a new sandbox repeatedly
without checking the first request's outcome.

## A sandbox stopped on its own

**Read its `stopReason`.** A sandbox paused at the end of its time limit, or by
`:pause`, has lost nothing and has no `stopReason`: wake it. A paused sandbox
that reads `pause_failed` lost its memory and kept its files.

| `stopReason`         | What it means                                                                                                                                                                                                                                                                                                                                          | What to do                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `idle`               | Read on a paused sandbox, not a stopped one: nothing happened in it for `idlePauseSeconds`, so it paused itself. Nothing is lost                                                                                                                                                                                                                       | A request wakes it while `autoWake` is on; `idlePauseSeconds: 0` keeps it running                                                                |
| `requested`          | A key, an agent or a person stopped it                                                                                                                                                                                                                                                                                                                 | Nothing                                                                                                                                          |
| `time_limit`         | The time limit it was created with (`timeoutSeconds`) ran out, and it was made to stop then rather than pause: `onTimeout: "stop"`. Its disk is kept for `:restart`. Before 4 October 2026 this read `lease_expired`                                                                                                                                   | Leave out `timeoutSeconds` so the next one runs while it works, or extend a running one before its end (`keepAlive` in the SDKs does it for you) |
| `paused_expired`     | It stayed paused past its `pausedExpiresAt` (seven days without credit, days you set, or seven days after credit ran out), so its memory and disk were deleted                                                                                                                                                                                         | Wake it before then, top up, set `:retention` to `null`, or take a snapshot                                                                      |
| `insufficient_funds` | The credit ran out, or the account is blocked by a payment that is disputed or [under review](./pricing#when-a-payment-is-under-review)                                                                                                                                                                                                                | Add credit at Usage & billing. When a dispute or review is the cause, a create returns `account_blocked` and says what clears it                 |
| `pilot_hours_used`   | The pilot it ran on has used its sandbox hours, so it paused or stopped with its files kept. Credit does not run a pilot's sandbox                                                                                                                                                                                                                     | To extend the pilot or ask for more hours, the account's owner writes to support (support@withruntime.com, or a reply to the pilot's email)      |
| `pilot_ended`        | The pilot it ran on, and the pilot's grace, are over. A pilot's sandbox runs only on its pilot, and is kept seven days, then deleted, with an email first                                                                                                                                                                                              | To extend the pilot, the account's owner writes to support before then. New sandboxes run on free usage or credit                                |
| `lifetime_cap`       | The sandbox reached its own `maxTotalCostMicros`                                                                                                                                                                                                                                                                                                       | Start a new sandbox if the work needs more                                                                                                       |
| `spending_limit`     | An owner-set spending limit, usually this agent's daily one                                                                                                                                                                                                                                                                                            | See what is left with `GET /v1/limits` or `runtime limits`                                                                                       |
| `authority_revoked`  | The key or agent that made it was revoked or removed                                                                                                                                                                                                                                                                                                   | Connect the agent again or make a new key, then create a new sandbox                                                                             |
| `startup_failed`     | It stopped before it was ready to run commands                                                                                                                                                                                                                                                                                                         | If it starts from your image, check the image's start and ready commands; otherwise report the sandbox id                                        |
| `account_busy_here`  | It can start only on the servers that hold its snapshot or image, and your own sandboxes there were short of CPU, so it did not start. Nothing ran in it                                                                                                                                                                                               | Start it again in a minute, or once some of your sandboxes there are done; keep sources on separate servers with `spreadFrom`                    |
| `service_unready`    | A service on our side that it needs was unavailable, so it could not keep running                                                                                                                                                                                                                                                                      | Create a new one, and report the sandbox id if it happens again                                                                                  |
| `pause_failed`       | Read on a paused sandbox: the pause could not keep its memory, so the programs that were running are gone, and its files are kept                                                                                                                                                                                                                      | Wake it: it starts fresh from its disk and reads `memoryRestored: false`. Report the sandbox id                                                  |
| `host_stopped`       | Its machine ended it without a stop being asked for. While it was starting or waking that is our fault; once it was running it can also be a shutdown or crash inside the sandbox                                                                                                                                                                      | Check whether your program shut the machine down; otherwise create a new one and report the sandbox id                                           |
| `host_lost`          | The machine it ran on stopped responding and was taken out of service                                                                                                                                                                                                                                                                                  | Create a new one and report the sandbox id                                                                                                       |
| `operator_stopped`   | Runtime stopped it: an operator, a suspension of the account, or the [abuse checks](./security#network-access) on traffic only abuse makes, which also cut its network. Your inbox (`GET /v1/notices`) holds an `abuse-halted` notice saying what was seen. Until it is lifted, a wake, restart, snapshot or fork of it returns `sandbox_halted` (403) | Write to support with the sandbox id if you think it was a mistake                                                                               |

Only a person can raise a spending limit, on the account's keys page: the member
who made the key, or an owner or admin. Do not
create replacements in a loop; the limit counts the last 24 hours.

## The request timed out

**A missing response is not proof that a command failed to run.** Use the same
idempotency key and identical input. The server returns the first result again
instead of running it twice. The SDKs do this for you. If a command's outcome is
still unknown, inspect its files and `processes` before repeating a side effect.

## The service returns 401, 403, 409, 429 or 5xx

| Response           | What to check                                                                                                | Safe next step                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 401                | Missing, expired or revoked key; wrong API origin                                                            | Check `npx withruntime whoami` or the secret-manager configuration         |
| 403                | Owner approval, key scope, account suspension or resource ownership                                          | Confirm the account and permitted action; do not work around a refusal     |
| 409                | The resource's state: paused (`sandbox_paused` with `autoWake` off says so), stopped, or a name already held | Resolve that state (`wake`, or `autoWake: true`), then retry               |
| 422                | Well formed but not possible as asked, such as an idempotency key used before with a different body          | Same key, same body; or a new key for genuinely new work                   |
| 429                | Your own limit: request rate, concurrent work, a quota or a daily cap                                        | Respect `Retry-After`, add a growing delay, and reduce concurrent requests |
| 5xx or no response | The write may already have reached the server                                                                | Retry identical input with the same idempotency key and inspect state      |

A 5xx whose message says the fault is ours was reported to us when it happened,
with its `requestId`. [API errors and retries](./api) describes the full
contract.

**`time_limit_too_short` (409) means the command could outlast the sandbox's
time.** A command is refused, and nothing runs, when the timeout you set is
longer than the time left before the sandbox's time limit, or before the end of
its funding once credit, free usage or a spending limit ran out. A paused
sandbox is refused before it is woken, so the wake costs nothing. For a time
limit, raise it first (`runtime sandboxes extend <id> 600`, `sbx.extend(600)`).
For funding, add credit or raise the limit (`runtime limits`). Or give the
command a shorter timeout. `details.secondsLeft` gives the time left. A
sandbox with no time limit and credit to run accepts a command of up to 24
hours. A command with no timeout of yours is not refused: it runs until the
sandbox's end, unless that is within about three seconds.

At create or resize, `time_limit_too_short` means the time limit is too short
to load the sandbox's memory back after a pause. The message names the least
`timeoutSeconds` for that size (190 for 65,536 MiB). Use it, leave the limit
out, or ask for less memory.

## The command succeeded over HTTP but the task failed

**Check the command's exit code, standard error and truncation flags.** HTTP
success means the operation was handled, not that the program returned zero.

- A result holds at most 64 KiB of each stream for a command up to 60 seconds.
  `stdoutTruncated` or `stderrTruncated` is `true` when the rest was dropped.
  Stream the output, or write it to a file and read that.
- Use `check: true` (`check=True` in Python) to raise on a non-zero exit.
- A timeout is a result with `timedOut: true`. Raise `timeoutMs`, or run long
  jobs in the background and follow their output.

## A file operation fails

File errors name the path and the reason: `file_not_found`, `is_a_directory`,
`not_a_directory`, `permission_denied`. Paths are absolute. `/workspace` is home.
Outside your own files, use `sudo` in a command.

## A command or a write answers `no_space`

The sandbox's disk is full. Commands still run on a full disk, so you can free
space with a command, such as `rm -rf /workspace/node_modules/.cache`, or
`du -sh /workspace/* | sort -h` to find what is large. A disk cannot be grown in
place. For more room, create a sandbox with a larger `diskMiB`.

## Dependencies cannot reach a server

**Check the sandbox's network rules and the destination port.**

- `npx withruntime sandboxes network <id>` shows the rules.
- A sandbox without credit reaches ports 80 and 443 only. A paid sandbox of an account
  with a kept top-up reaches every port. `openPorts` in the rules says
  which. See [the sandbox environment](./sandbox-environment#the-network).
- Name lookups or `pip install` time out in a sandbox from your own image on
  a Debian or Ubuntu base, such as `python:3.12-slim`, built before 30
  September 2026. The image kept its own `/etc/resolv.conf`. Build it again.
  Every image built since uses Runtime's resolver ([images](./images)).
- `API rate limit exceeded for <address>` from `api.github.com`: calls
  without a token share a limit with everyone on that address. Store a GitHub
  token as a secret ([shared addresses and per-address limits](./egress#shared-addresses-and-per-address-limits)).
- Do not disable security protections to make a migration appear successful.

## A secret's placeholder reaches the server unchanged

**Read the sandbox's `sandbox.secret_not_applied` event first.** Runtime sends
it when it sees a placeholder go out without being replaced. Its `reason` and
`message` say why ([events](./observability#events)):
`npx withruntime events --type sandbox.secret_not_applied`. With no event,
check these four things, in order. They decide whether a request carries a
[secret](./security#secrets-sandboxes-never-see).

1. The host. `npx withruntime secrets ls` shows each secret's hosts. The URL's
   host must be one of them by name: `*.example.com` covers
   `api.example.com` but not `example.com`, and an IP address never matches.
2. The request. Only HTTPS carries a secret, and only in its credential
   header, never in the URL or the body. With `rules`, the method and path
   must match a rule: `/ingest` does not match `/ingest/`, and a path that
   could be read two ways (an encoded slash, a semicolon or a backslash) gets
   no secret that has rules.
3. The route. Inside the sandbox, run
   `curl -sv https://<host>/ -o /dev/null 2>&1 | grep -i issuer`. For a secret's
   host, the issuer is Runtime's egress certificate. The server's own issuer
   means the request never reached the step that adds the secret. The client
   went around the sandbox's proxy (raw sockets and some HTTP libraries ignore
   `HTTPS_PROXY`), or the host is in its `NO_PROXY`. The sandbox's own
   `NO_PROXY` lists only loopback and private addresses, so a secret's host is
   there only if your code added it. If the server could not add the secret
   at that moment, a `withheld` event says so. That is Runtime's fault, not
   your code's.
4. Pinned certificates. A client with its own certificate list needs
   `/usr/local/share/ca-certificates/runtime-egress.crt` added to it.

If all four hold and the placeholder still arrives,
write to support with the sandbox's id, the time of the request
and the output of step 3.

## The bill differs from an estimate

**Compare like with like.** Compare total CPU-seconds, provisioned memory, the
quoted CPU floor and actual running duration. Include startup, dependency
installation, retries and cleanup. A running sandbox's charges settle as it
runs, so wait for it to stop before comparing the total.

- Usage & billing groups daily and monthly settled service charges in UTC. Its
  estimate for the rest of the month is the pace so far, not a charge.
- A payment adds credit. It is not service usage.
- Paused storage is a separate meter, so stopping compute does not prove all
  retained-storage charges have ended.

## A paused sandbox will not wake

**Check `pausedExpiresAt`, available credit and the error code.** Wake needs
room on the original host for CPU, memory, the full disk allowance and its next
snapshot. A full host can refuse restoration while preserving the saved state.
When the host is short only because of work Runtime runs at the lowest
priority there (such as Runtime's own CI), the wake pauses that work and waits
up to 20 seconds for the room before it returns `no_capacity`. A request
that would wake a sandbox while a snapshot of it is being taken waits for the
snapshot to finish, then wakes it. Past the request's own deadline, it returns
`snapshot_capturing` (409). A retry once the snapshot is over wakes it.

- Do not delete it as a retry step.
- Missing memory images are an error, not an instruction to claim a fresh boot
  restored the previous process.
- Keep important outputs outside a sandbox before relying on long retention.

See [storage and retention terms](./pricing) and [isolation](./security).

## A sandbox stays `resuming`, or its operation never finishes

**A wake that is still `resuming` after a minute is stuck on our side.** A
paused sandbox normally runs its next command {{wake}} after the wake. One that
boots from the disk, because the memory could not be kept
(`memoryRestored: false`), does so within seconds. While a sandbox is `resuming`, a command on it waits up to 30 seconds
and then returns `sandbox_not_ready`.

**An operation we cannot finish gives up within about a minute.** The
sandbox then stays in the state it was moving from (`starting`, `resuming`,
`pausing` or `stopping`), with its files kept and nothing charged. Its response
carries `operationFailed`: the action (`start`, `wake`, `pause`, `stop`
or `delete`) and when it failed. Every command and wake on it returns
`operation_failed` (500) immediately instead of waiting. Our operators are
alerted. Retrying the same call does not help. A stop or a delete does.
A wake or pause that gave up because its machine held the sandbox for our
operators is retried every five minutes. Once the machine has let it
go, the sandbox is `paused` again (with `stopReason: "pause_failed"` and
`memoryRestored: false` on its next wake if its memory could not be kept),
and its next command wakes it.

| What you see                                   | What it means                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host_unknown` (5xx)                           | The sandbox's machine failed to carry out the request. The fault is ours, and it was reported when it happened                                                                                          |
| `fence_conflict` in an operation's result      | The machine would not take the wake as asked, so the sandbox was put back to paused with its files                                                                                                      |
| `pause_failed` with `memoryRestored: false`    | The programs that were running are gone; the files are kept, and the next wake starts fresh from the disk                                                                                               |
| `resuming` or `pending` for more than a minute | An operation on the sandbox cannot finish, and calls on it wait behind it                                                                                                                               |
| `operation_failed` (500), or `operationFailed` | The operation gave up. Stop the sandbox to keep its disk and restart it later, or delete it                                                                                                             |
| `wake_refused` (503)                           | A wake or restart was refused immediately by a fault of ours, before anything ran or was charged. The sandbox stays as it was with its files kept, and we were alerted. Retry the wake in a few minutes |

- Your other sandboxes are not affected: a stuck operation holds one sandbox.
- Do not delete the stuck sandbox as a retry step, and do not retry commands
  on it in a loop. Its files are kept while it is stuck.
- After `operation_failed`, stop it (`runtime sandboxes stop <id>`) to keep
  its disk, then restart it, or delete it if you do not need its files. A
  sandbox whose stop or delete gave up can only be deleted. Write to support
  to keep its disk.
- After `wake_refused`, retry the same wake or restart in a few minutes. It
  is safe to repeat, and nothing was queued. Its paused storage is not billed
  from the first refused wake until it can wake. Write to support if it
  still fails after an hour.
- Continue in a new sandbox from the same image if the work cannot wait.
- Write to support with the sandbox id and the time it got stuck. An operator
  clears it and tells you whether its files can be brought back.

## Stop returned, but the sandbox is still stopping

**Stop is asynchronous.** The SDKs wait for `stopped`. Over HTTP, send
`Prefer: wait=60`, or read the sandbox with `?waitFor=stopped`. Compute ends
after confirmed VM shutdown. Do not report cleanup complete just because the
request was accepted.

## MCP is connected but execution is still local

**MCP tools and a framework's built-in shell are different paths.** Configure
the framework's execution backend, or replace its tool registration explicitly.
Run a probe that prints the sandbox id and verifies a remote file round trip
before you call the switch complete.
