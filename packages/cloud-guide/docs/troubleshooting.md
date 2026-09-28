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

| Code                  | What it means                                                                     | What to do                                              |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `trial_busy`          | Eight trial sandboxes are already running; `details` names them                   | Stop or pause one, or retry once one ends               |
| `trial_domain_limit`  | Your email domain's eight shared trial slots are all running                      | Stop or pause one, or use paid credit                   |
| `trial_exhausted`     | The {{trial-hours}} hours are used, or `timeoutSeconds` is more than what is left | Shorten `timeoutSeconds`, or use paid credit            |
| `invalid_trial`       | A trial sandbox is at most 2 vCPU, 4 GiB of memory and 10 GiB of disk             | Omit the size fields for the default                    |
| `invalid_request`     | `details.issues` names every wrong field                                          | Fix the named fields; unknown fields are refused        |
| `invalid_region`      | `details.available` lists your regions                                            | Use a region listed for your account, or omit it        |
| `no_capacity`, `busy` | No host has room right now                                                        | Retry with the same idempotency key and a growing delay |

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
- To use credit instead, pass `funding: "paid"`.

A trial request never silently becomes a paid one. Paid credit does not make an
exhausted trial available. See [the trial](./trial).

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

**Read its `stopReason`.**

| `stopReason`         | What it means                                                                                                 | What to do                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `insufficient_funds` | The credit ran out, or the account is blocked by a disputed payment                                           | Add credit at Usage & billing. When a dispute is the cause, a create answers `account_blocked` and says what clears it |
| `lifetime_cap`       | The sandbox reached its own `maxTotalCostMicros`                                                              | Start a new sandbox if the work needs more                                                                             |
| `spending_limit`     | An owner-set spending limit, usually this agent's daily one                                                   | See what is left with `GET /v1/limits` or `runtime limits`                                                             |
| `pause_failed`       | A pause answered, but the host lost its memory before it was saved, so the sandbox stopped with its disk kept | Its files are there; start it again from its disk if it is persistent, or create a new one, and report the sandbox id  |

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

[API errors and retries](./api) describes the full contract.

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
  that has made a purchase reaches every port. `openPorts` in the rules says
  which. See [the sandbox environment](./sandbox-environment#the-network).
- Do not disable security protections to make a migration appear successful.

## The bill differs from an estimate

**Compare like with like.** Compare total CPU-seconds, provisioned memory, the
quoted CPU floor and actual running duration. Include startup, dependency
installation, retries and cleanup. Wait for settlement before equating reserved
credit with a final charge.

- Usage & billing groups daily and monthly settled service charges in UTC, and
  its estimate for the rest of the month is the pace so far, not a charge.
- A payment adds credit; it is not service usage.
- A reservation can lower available credit without being a final charge.
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
request was accepted. The host-side lease provides a bound, but is not proof
that your cleanup already completed.

## MCP is connected but execution is still local

**MCP tools and a framework's built-in shell are different paths.** Configure
the framework's execution backend or replace its tool registration explicitly.
Run a probe that prints the sandbox id and verifies a remote file round trip
before calling the switch complete.
