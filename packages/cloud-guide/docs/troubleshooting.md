# Diagnose a sandbox integration

Start with the failing step: connection, creation, readiness, execution, pause, wake or cleanup.

- Every error carries a `code`, a `hint` and a `requestId`. Follow the hint
  first.
- Keep the request id, the sandbox id, the time and the SDK version for a
  report. Never include API keys, connection secrets or private file contents.
- Confirm you are using the correct account and API origin.

Check https://withruntime.com/status first. It shows whether the API is
answering, checked from outside our servers every two minutes, and whether a
real sandbox starts, runs a command and stops, tried from outside every ten
minutes. It also shows uptime since the record began and notes on incidents.

If it looks like Runtime's fault, report it with
`npx withruntime feedback "..." --request-id <id>`. If you are stuck, ask
`npx withruntime support "..."`: the support agent reads your account and can
reproduce the problem. See [feedback and support](./feedback-and-support).

## Browser login does not finish

**Open the exact link the CLI printed, check the code, and approve as an owner,
admin or developer of the account.**

- If the command was stopped while it waited, run it again: it shows the same
  link and code, and picks up the approval.
- Approval and delivery are separate: the browser waits for the CLI to receive
  and verify the credential before showing success.
- Requests expire after 15 minutes. Start a new `npx withruntime login` after
  expiry.
- On a remote terminal, use `--no-browser` and open its link on your own device.
- If the CLI cannot reach Runtime, check its outbound HTTPS access. Do not paste
  credentials into the browser or into your agent's prompt.

Run `npx withruntime whoami` to check a saved connection. If it is refused, run
login again. `RUNTIME_API_KEY` overrides the saved connection: an invalid
environment key can fail even when browser login previously worked. Remove an
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
- Each name works in upper or lower case; when both are set, lower case wins.
  A proxy address without a scheme is taken as `http://`.
- A proxy address that cannot be used fails at once with `invalid_proxy`,
  naming the variable.

When the proxy cannot be reached, the error names it, for example:
`No answer from Runtime at https://api.withruntime.com through the proxy
http://proxy:3128 (HTTPS_PROXY).` If the proxy answered 407, the hint says to
put credentials in the variable as `http://user:password@host:port`. If only
`HTTP_PROXY` is set, the hint says to set `HTTPS_PROXY`, since the API is HTTPS.

On earlier versions, every call fails with `connection_error` ("No answer from
Runtime at https://api.withruntime.com") while `curl` through the same proxy
works, because the client connects directly:

- **CLI and JavaScript SDK on Node 22.21 or later, or Node 24.** Also set
  `NODE_USE_ENV_PROXY=1`, and Node's own `fetch` reads those variables. Node's
  documentation marks this setting as still in active development.
- **Under Bun**, the proxy variables already work.
- **The Python SDK** connects directly, and no setting changes that. Upgrade.

```bash no-run
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://proxy.example.com:3128 npx withruntime whoami
```

## The CLI stops with `OpenSSL configuration error`

**Node could not read an OpenSSL configuration file, so it stopped before the
CLI started.** It happens with a Node build that uses the system's OpenSSL, such
as Homebrew's or a Linux distribution's, inside a sandbox that blocks reading
outside the project, such as a coding agent's. `OPENSSL_CONF` naming a file that
cannot be read does the same. The message names the file:

```text
node: OpenSSL configuration error:
...:BIO_new_file:Permission denied:...calling fopen(/opt/homebrew/etc/openssl@3/openssl.cnf, rb)
```

The CLI does not need that file. Give Node an empty one for the command, or let
the sandbox read the file the message names:

```bash no-run
OPENSSL_CONF=/dev/null npx withruntime whoami
```

Node from nodejs.org reads no such file, so it starts either way.

## Creation is refused

| Code                  | What it means                                                                               | What to do                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `trial_busy`          | Eight trial sandboxes are already running; `details` names them                             | Stop or pause one, or retry once one ends                                        |
| `trial_domain_limit`  | Your email domain's eight shared trial slots are all running                                | Stop or pause one, or use paid credit                                            |
| `trial_exhausted`     | The {{trial-hours}} hours are used                                                          | Use paid credit                                                                  |
| `invalid_trial`       | A trial sandbox is at most 2 vCPU, 4 GiB of memory and 10 GiB of disk                       | Omit the size fields for the default                                             |
| `invalid_request`     | `details.issues` names every wrong field                                                    | Fix the named fields; unknown fields are refused                                 |
| `invalid_region`      | `details.available` lists your regions                                                      | Use a region listed for your account, or omit it                                 |
| `no_capacity`, `busy` | No host has room right now                                                                  | Wait `Retry-After`, then retry with the same idempotency key and a growing delay |
| `image_not_found`     | `image` names nothing in your account; the message lists the name's tags                    | Name one it lists, or build a public image first                                 |
| `volume_not_ready`    | A volume it names, or one you back up, is still `creating` (a restore is too until checked) | Wait until the volume reads `ready`, then try again                              |

**`trial_busy` is temporary:** a slot frees when any trial sandbox stops or
pauses.

- Retry with the same idempotency key, a growing delay and a bounded deadline,
  or stop or pause one of the sandboxes `details` names.
- A fork asking for more copies than the trial runs at once never fits; ask for
  fewer.
- An SDK create waits for a slot by itself, for up to two minutes by default
  (`waitForCapacityMs` in JavaScript, `wait_for_capacity` in Python), and then
  returns the refusal. The error's `retryable` is `true`, for a loop of your
  own.
- Once the account holds prepaid credit, it runs more at once, with nothing
  to change.

Once the trial's hours are used, an account with prepaid credit runs on it with
nothing to change; one with neither is refused with `trial_exhausted`. See how
much trial time is left with
`npx withruntime usage`, or with `GET /v1/usage` or `GET /v1/limits`, whose
`trial.availableMs` is what a new trial sandbox can still use, in milliseconds.
See [the trial](./trial).

## A sandbox's `env`, delete or image switch is refused

| Code                          | What it means                                                                                                                                                          | What to do                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `invalid_env`                 | A name is not a letter or underscore followed by letters, digits and underscores, or a value holds a NUL; `details.name` says which                                    | Rename the variable, or drop the byte                                                        |
| `env_too_large`               | More than {{sandbox-env-vars}} variables or {{sandbox-env-size}} in the sandbox, or a command's own `env` and the sandbox's together are more than one command carries | Keep large settings in a file in `/workspace`, or pass fewer in the command                  |
| `env_unavailable`             | This deployment cannot store an environment; nothing was created or changed                                                                                            | Pass `env` to each `exec` instead                                                            |
| `env_unreadable`              | Its stored environment could not be opened, a fault on our side, so nothing ran                                                                                        | Set it again with `:update`, or contact support with the request id                          |
| `sandbox_in_use`              | The sandbox runs a managed service                                                                                                                                     | Delete the service, which ends its sandbox                                                   |
| `switch_keeps_workspace_only` | `keep` named something other than `"workspace"`: a switch of image keeps only `/workspace`; nothing changed                                                            | Leave `keep` out, or snapshot the sandbox first to keep everything                           |
| `switch_undone`               | The switch did not finish and was undone: the sandbox is on its old image with its files as they were                                                                  | Retry; a `/workspace` that takes longer than {{switch-copy-time}} to copy cannot be switched |
| `switch_needs_disk`           | A stopped sandbox that was not persistent kept no disk, so there is nothing to move                                                                                    | Create a new sandbox from the image                                                          |
| `image_on_another_host`       | The image is stored on another server than the sandbox                                                                                                                 | Create a new sandbox from the image, or build it again                                       |
| `delete_unavailable`          | Deleting cannot run here yet, a fault on our side that we are told of                                                                                                  | Stop it instead, and delete it later                                                         |

## Creation returns `starting`

**The SDKs and `npx withruntime sandbox create` wait for `running` for you.**
Over raw HTTP, send `Prefer: wait=60`, or read the sandbox with
`?waitFor=running`.

Wait for running before issuing commands. A command on a sandbox that is still
starting waits up to 30 seconds, then answers `sandbox_not_ready`. If the
sandbox stops before it is ready, its `stopReason` says why; report that failure
with its sandbox id and request id. Do not start a new sandbox repeatedly
without checking the first request's outcome.

## A sandbox stopped on its own

**Read its `stopReason`.** A sandbox paused at the end of its time limit, or by
`:pause`, has lost nothing and has no `stopReason`: wake it. A paused sandbox
that reads `pause_failed` lost its memory and kept its files.

| `stopReason`         | What it means                                                                                                                                                                                                                                              | What to do                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `idle`               | Read on a paused sandbox, not a stopped one: nothing happened in it for `idlePauseSeconds`, so it paused itself. Nothing is lost                                                                                                                           | A request wakes it while `autoWake` is on; `idlePauseSeconds: 0` keeps it running                                                                |
| `requested`          | A key, an agent or a person stopped it                                                                                                                                                                                                                     | Nothing                                                                                                                                          |
| `time_limit`         | The time limit it was created with (`timeoutSeconds`) ran out, and it was made to stop then rather than pause: `onTimeout: "stop"`. Its disk is kept for `:restart`. Before 4 October 2026 this read `lease_expired`                                       | Leave out `timeoutSeconds` so the next one runs while it works, or extend a running one before its end (`keepAlive` in the SDKs does it for you) |
| `paused_expired`     | It stayed paused past its `pausedExpiresAt` (a trial's seven days, days you set, or seven days after credit ran out), so its memory and disk were deleted                                                                                                  | Wake it before then, top up, set `:retention` to `null`, or take a snapshot                                                                      |
| `insufficient_funds` | The credit ran out, or the account is blocked by a payment that is disputed or [under review](./pricing#when-a-payment-is-under-review)                                                                                                                    | Add credit at Usage & billing. When a dispute or review is the cause, a create answers `account_blocked` and says what clears it                 |
| `lifetime_cap`       | The sandbox reached its own `maxTotalCostMicros`                                                                                                                                                                                                           | Start a new sandbox if the work needs more                                                                                                       |
| `spending_limit`     | An owner-set spending limit, usually this agent's daily one                                                                                                                                                                                                | See what is left with `GET /v1/limits` or `runtime limits`                                                                                       |
| `authority_revoked`  | The key or agent that made it was revoked or removed                                                                                                                                                                                                       | Connect the agent again or make a new key, then create a new sandbox                                                                             |
| `startup_failed`     | It stopped before it was ready to run commands                                                                                                                                                                                                             | If it starts from your image, check the image's start and ready commands; otherwise report the sandbox id                                        |
| `service_unready`    | A service on our side that it needs was unavailable, so it could not keep running                                                                                                                                                                          | Create a new one, and report the sandbox id if it happens again                                                                                  |
| `pause_failed`       | Read on a paused sandbox: the pause could not keep its memory, so the programs that were running are gone, and its files are kept                                                                                                                          | Wake it: it starts fresh from its disk and reads `memoryRestored: false`. Report the sandbox id                                                  |
| `host_stopped`       | Its machine ended it without a stop being asked for. While it was starting or waking that is our fault; once it was running it can also be a shutdown or crash inside the sandbox                                                                          | Check whether your program shut the machine down; otherwise create a new one and report the sandbox id                                           |
| `host_lost`          | The machine it ran on stopped answering and was taken out of service                                                                                                                                                                                       | Create a new one and report the sandbox id                                                                                                       |
| `operator_stopped`   | Runtime stopped it: an operator, a suspension of the account, or the [abuse checks](./security#network-access) on traffic only abuse makes, which also cut its network. Your inbox (`GET /v1/notices`) holds an `abuse-halted` notice saying what was seen | Write to support with the sandbox id if you think it was a mistake                                                                               |

Only a person can raise a spending limit, on the account's keys page: the member
who made the key, or an owner or admin. Do not
create replacements in a loop; the limit counts the last 24 hours.

## The request timed out

**A missing response is not proof that a command failed to run.** Use the same
idempotency key and identical input. The server answers the first result again
instead of running it twice. The SDKs do this for you. If a command's outcome is
still unknown, inspect its files and `processes` before repeating a side effect.

## The service returns 401, 403, 409, 429 or 5xx

| Response           | What to check                                                       | Safe next step                                                             |
| ------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 401                | Missing, expired or revoked key; wrong API origin                   | Check `npx withruntime whoami` or the secret-manager configuration         |
| 403                | Owner approval, key scope, account suspension or resource ownership | Confirm the account and permitted action; do not work around a refusal     |
| 409                | The resource's state: paused, stopped, not ready, or the trial busy | Resolve that state, then retry                                             |
| 422                | The idempotency key was used before with a different body           | Same key, same body; or a new key for genuinely new work                   |
| 429                | Request rate or concurrent work exceeded the server's bound         | Respect `Retry-After`, add a growing delay, and reduce concurrent requests |
| 5xx or no response | The write may already have reached the server                       | Retry identical input with the same idempotency key and inspect state      |

A 5xx whose message says the fault is ours was reported to us when it happened,
with its `requestId`. [API errors and retries](./api) describes the full
contract.

**`time_limit_too_short` (409) means the command could outlast the sandbox's
time.** A command is refused, and nothing runs, when the timeout you set is
longer than the time left before the sandbox's time limit, or before the end of
its funding once credit, trial hours or a spending limit ran out; a paused
sandbox is refused before it is woken, so the wake costs nothing. For a time
limit, raise it first (`runtime sandbox extend <id> 600`, `sbx.extend(600)`);
for funding, add credit or raise the limit (`runtime limits`); or give the
command a shorter timeout. `details.secondsLeft` says how long is left. A
sandbox with no time limit and credit to run accepts a command of up to 24
hours. A command with no timeout of yours is not refused: it runs until the
sandbox's end, unless that is within about three seconds.

## The command succeeded over HTTP but the task failed

**Check the command's exit code, standard error and truncation flags.** HTTP
success means the operation was handled, not that the program returned zero.

- A result holds at most 64 KiB of each stream for a command up to 60 seconds.
  `stdoutTruncated` or `stderrTruncated` is `true` when the rest was dropped:
  stream the output, or write it to a file and read that.
- Use `check: true` (`check=True` in Python) to raise on a non-zero exit.
- A timeout is a result with `timedOut: true`. Raise `timeoutMs`, or run long
  jobs in the background and follow their output.

## A file operation fails

File errors name the path and the reason: `file_not_found`, `is_a_directory`,
`not_a_directory`, `permission_denied`. Paths are absolute; `/workspace` is home.
Outside your own files, use `sudo` in a command.

## Dependencies cannot reach a server

**Check the sandbox's network rules and the destination port.**

- `npx withruntime sandbox network <id>` shows the rules.
- A trial sandbox reaches ports 80 and 443 only; a paid sandbox of an account
  with a kept top-up reaches every port. `openPorts` in the rules says
  which. See [the sandbox environment](./sandbox-environment#the-network).
- Name lookups or `pip install` time out in a sandbox from your own image on
  a Debian or Ubuntu base, such as `python:3.12-slim`, built before 30
  September 2026: the image kept its own `/etc/resolv.conf`. Build it again;
  every image built since uses Runtime's resolver ([images](./images)).
- Do not disable security protections to make a migration appear successful.

## The bill differs from an estimate

**Compare like with like.** Compare total CPU-seconds, provisioned memory, the
quoted CPU floor and actual running duration. Include startup, dependency
installation, retries and cleanup. A running sandbox's charges settle as it
runs, so wait for it to stop before comparing the total.

- Usage & billing groups daily and monthly settled service charges in UTC, and
  its estimate for the rest of the month is the pace so far, not a charge.
- A payment adds credit; it is not service usage.
- Paused storage is a separate meter, so stopping compute does not prove all
  retained-storage charges have ended.

## A paused sandbox will not wake

**Check `pausedExpiresAt`, available credit and the error code.** Wake needs
room on the original host for CPU, memory, the full disk allowance and its next
snapshot. A full host can refuse restoration while preserving the saved state.

- Do not delete it as a retry step.
- Missing memory images are an error, not an instruction to claim a fresh boot
  restored the previous process.
- Keep important outputs outside a sandbox before relying on long retention.

See [storage and retention terms](./pricing) and [isolation](./security).

## Stop returned, but the sandbox is still stopping

**Stop is asynchronous.** The SDKs wait for `stopped`; over HTTP, send
`Prefer: wait=60` or read the sandbox with `?waitFor=stopped`. Compute ends
after confirmed VM shutdown. Do not report cleanup complete just because the
request was accepted.

## MCP is connected but execution is still local

**MCP tools and a framework's built-in shell are different paths.** Configure
the framework's execution backend or replace its tool registration explicitly.
Run a probe that prints the sandbox id and verifies a remote file round trip
before calling the switch complete.
