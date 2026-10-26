# Switch to Runtime from another sandbox provider

Move your sandbox code to Runtime in one pass, test it on the free usage, and see what you save each month.

Your model, prompts and application stay as they are; only the sandbox calls
change. For a project with no sandbox yet, start with [Get started](./start).

## Give your agent one instruction

> Move this project to Runtime Cloud: read https://withruntime.com/llms.txt and
> follow it.

The agent follows the steps below and keeps going until your real job runs on
Runtime. It ends with your monthly saving in dollars, and what is left for you
to do before going live. It tests without credit. It asks before going on once
the free usage is used. It never touches your old provider's account.

**Why teams switch:**

- **You pay for the CPU you use.** {{cpu-rate}} per active vCPU-hour, measured, and
  {{memory-rate}} per reserved GiB-hour of memory. No plan fee, and no one-minute
  minimum.
- **The calls map one to one.** Create, exec, files and stop have direct
  equivalents (table below). Code written for E2B, Daytona, Vercel Sandbox or
  Blaxel, Morph and others runs after changing one import.
- **Pause keeps memory.** A paused sandbox wakes where it left off, kept while a
  paid account has credit. A fork copies a running sandbox with its memory
  and processes.
- **More is built in.** A desktop, a code interpreter, custom images, volumes,
  and preview URLs that are private by default.
- **No API key to copy.** One browser approval connects the CLI, SDKs and MCP.
- **Test it free.** {{included-machine}}, no card, up to {{trial-sandboxes}} running at the same time.
  A sandbox without credit reaches ports 80 and 443 and shares previews privately, with
  a token; other outbound ports and public previews need paid credit.

The [comparison pages](./e2b-alternative) work through the cost of the same job
on each provider.

## 1. Find the old provider's calls

Read the project before changing it:

- dependency manifests and lockfiles;
- provider imports and sandbox configuration;
- creation calls, command execution, file access, background processes and
  cleanup;
- the names of environment variables, never their values;
- the framework and its version.

A framework's tool integration is not its sandbox backend. Adding an MCP tool
does not redirect a framework's local shell or filesystem operations.

## 2. Check what the project needs

**Most projects map straight across.** Check whether the application needs
Docker, root access, WebSockets, browser sessions, custom images, GPU support,
snapshots or region guarantees. On Runtime:

| The project needs       | Runtime                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Root                    | Passwordless `sudo` inside the sandbox                                                                                   |
| Docker                  | Docker Engine and Compose with `sudo enable-docker` ([environment](./sandbox-environment#docker))                        |
| SSH or an editor        | `runtime sandboxes ssh`, and `<id>.runtime` in VS Code or JetBrains ([SSH and editors](./editors))                       |
| A port on your machine  | `runtime sandboxes port-forward <id> 5432`, any TCP port, over the API                                                   |
| WebSockets              | Supported, including through a preview                                                                                   |
| A browser               | Playwright's Chromium installs in two commands, or use the [desktop](./products)                                         |
| Custom images           | Build from a package list, any public or private image, or a Dockerfile                                                  |
| Snapshots and forks     | Keep files, memory and running processes                                                                                 |
| A public URL            | A preview: an HTTPS address for one port                                                                                 |
| Other ports outbound    | Paid accounts reach every port, raw sockets included ([environment](./sandbox-environment#the-network))                  |
| API keys in the sandbox | Secrets: a placeholder in the sandbox, the value added by the proxy ([security](./security#secrets-sandboxes-never-see)) |

Do not represent a missing feature as supported. If the project needs something
Runtime does not offer, tell the owner which call before you remove it, and
send it as feedback. We build next from these reports:

```bash no-run
npx withruntime feedback --kind migration_blocker --competitor E2B \
  "Our evaluation jobs need X"
```

## 3. Connect and prove it

```bash no-run
npx withruntime login --no-browser
npx withruntime sandboxes run -- echo hello
```

The first command prints a link and a code: show them to the owner and wait for
their approval of **Connect agent**. The second must print `hello` and exit 0.
[Get started](./start) has the details.

## 4. Replace the calls

**Replace every call and leave no fallback.** Work on a branch, so git keeps the
old code. Then:

- Map create, readiness, exec, read and write, and stop to Runtime (table
  below).
- Remove the old provider's SDK, its client setup and its settings from the
  code.
- Test within the free usage. Once it is used up, sandboxes run on the
  account's credit by themselves. Check what is left with
  `npx withruntime usage`, and ask the owner before going on.
- Use one sandbox per isolated task or tenant, not a shared global sandbox.
- Choose an idempotency key before a write that accepts one, and reuse it with
  identical input after a lost response; a new key can run the work twice. The
  SDKs keep the same key for retries within a call. Across calls or restarts,
  choose and keep your own.
- Pass argument arrays rather than shell commands built from untrusted strings.

**From Daytona or Vercel Sandbox:** change the import to `withruntime/daytona`
or `withruntime/vercel` (Python `withruntime.daytona`, `withruntime.vercel`).
Their `stop()` keeps the disk to start again, as it does there, so it pauses the
sandbox; `delete()` ends it. See [JavaScript](./javascript) and
[Python](./python).

**From Blaxel:** change `from "@blaxel/core"` to `from "withruntime/blaxel"`
(Python `from blaxel.core import SandboxInstance` to
`from withruntime.blaxel import SandboxInstance`). Standby becomes a pause that
keeps memory and processes after {{idle-pause}} idle, and the next call wakes the
sandbox. Sessions carry over as
Runtime's [sandbox sessions](./javascript#a-sandbox-from-a-browser). A call
Runtime handles differently, such as drives or schedules, throws
`NotSupportedError` naming what to use instead.

- A Blaxel workspace key sees every sandbox; a Runtime key sees the ones it
  made unless an owner or admin makes it account-wide
  (the API keys page, or `runtime keys create --account-wide`). Give services
  that share sandboxes account-wide keys
  ([keys in a team](./teams#keys-in-a-team)).
- Without credit, a sandbox is at most 2 vCPU and 4096 MB; `memory: 8192` needs paid
  credit.
- An image other than Blaxel's own templates must be a ready Runtime image of
  the same name: `npx withruntime images build --dockerfile Dockerfile --name <name>`.
- Blaxel's preview token header (`X-Blaxel-Preview-Token`) and parameter
  (`?bl_preview_token=`) are accepted.

**From Morph:** change `from "morphcloud"` to `from "withruntime/morph"`
(Python: `morphcloud` to `withruntime.morph` in the imports, so
`from withruntime.morph import MorphCloudClient`).
`MorphCloudClient`'s snapshots, instances, `setup`, `branch`, `pause`,
`resume`, `exec` and `exposeHttpService` work as they are; metadata become
labels. `stop` deletes the sandbox, as on Morph. Give `ttlSeconds` at
`instances.start` (60 to 86400): Runtime cannot add a time limit later. An
HTTP service with `auth_mode: "api_key"` is a private preview: send its token
(`instance.native.previews.get(port)`) as `x-runtime-preview-token`. Morph's
SSH calls refuse; use `npx withruntime sandboxes ssh <id>`. In Python,
`set_ttl` moves a time limit later but never adds or shortens one, and a
snapshot's `ttl_seconds` is whole days. Commands run as the user `runtime`
(with `sudo`), not root, so write to `/workspace` or `/tmp`.

**From Modal Sandboxes:** change `from "modal"` to `from "withruntime/modal"`
(Python `import modal` to `from withruntime import modal`), SDK 0.25.0 and
later (Python 0.23.0). Modal's own sandbox examples run unchanged where they
use none of what is refused below, and no Modal
token is needed or sent. Commands run as root, as in a Modal container. A
`timeout` ends the sandbox, and an `idle_timeout` pauses it with its memory
kept until the next call wakes it. A Function with a `schedule` deploys as a
[job](./jobs#modal) (SDK 0.36.0, Python 0.34.0). GPUs, other Modal Functions, named secrets,
volumes made on first use, sidecars, connect tokens and directory snapshots
throw `CompatibilityError` before anything is created, naming what to use
instead ([Modal](./modal-sandbox-alternative#what-the-drop-in-refuses)).

**From E2B:** change `from "e2b"` to `from "withruntime/e2b"` (Python
`from withruntime.e2b import ...`, SDK 0.4.0 and later). Errors stay E2B's:
`commands.run` throws `CommandExitError` (Python `CommandExitException`) on a
non-zero exit and `TimeoutError` (Python `TimeoutException`) past its timeout,
so keep your `try`/`catch`. A call Runtime handles differently throws
`NotSupportedError` naming what to use instead. Without credit a shared port is private, so `getHost(port)` throws `PublicPreviewNotAllowedError` (Python
`PublicPreviewNotAllowedException`) instead of returning a host nobody can
reach: while you test, open
`(await sandbox.runtime.previews.create(port)).urlWithToken` instead, or send
its token in the `x-runtime-preview-token` header.

An E2B template becomes a Runtime image of the same name, built once from the
same Dockerfile:

1. Build it: `npx withruntime images build --dockerfile e2b.Dockerfile --name <template>`.
   Its `WORKDIR` is where commands start, as on E2B. A start or ready command
   from `e2b.toml` is not carried over; start it with
   `commands.run(cmd, { background: true })` after the create.
2. Keep the create as it is: `Sandbox.create("<template>")`, with or without
   E2B's `team/` prefix and a `:tag`, starts from that image, and `getInfo()`
   reports the template by the name you gave.

A `timeoutMs` (Python `timeout`) is kept by Runtime's server, up to 24 hours,
and `kill()` deletes the sandbox, as on E2B. With no timeout, E2B's 300 seconds
ends in a pause rather than a delete, so call `kill()` when the work is done.

**From Cloudflare's Sandbox SDK (0.x):** change `from "@cloudflare/sandbox"`
to `from "withruntime/cloudflare"` in both the `getSandbox` import and the
`export { Sandbox }` line, delete the `containers` block from the Wrangler
config (keep the `Sandbox` Durable Object binding and its migration), and store
a key with `npx wrangler secret put RUNTIME_API_KEY` (SDK 0.18.0 and later).
The Worker's `getSandbox(env.Sandbox, name)` then reaches a Runtime sandbox
kept for that name. Backups, tunnels, terminals and outbound interception
refuse by name and say what to use instead; a sandbox holds at most 4 code
contexts ([Cloudflare](./cloudflare-sandbox-alternative#change-the-import)).

**From Fly Machines:** code that calls Fly's Machines API (`api.machines.dev`)
runs on Runtime after one address change. Run `npx withruntime fly-api`, which
serves the Machines API on `http://127.0.0.1:4280` as your Runtime login, and
point the client there: `FLY_API_HOSTNAME` in Fly's own examples,
`FLY_FLAPS_BASE_URL` for Fly's Go client (fly-go), or the base URL of your HTTP
client. On 18 October 2026 we ran the 22 curl examples on Fly's
[Machines API pages](https://fly.io/docs/machines/api/machines-resource/)
unchanged this way, and fly-go 0.11.6's flaps client unchanged. A Node service
can answer the same calls itself with `machinesApi()` from `withruntime/fly`, a
fetch handler. Your Fly token is never sent anywhere; to run as another Runtime
key, send it (`rtcloud_...`) as the bearer token. Served on anything but
`127.0.0.1`, every request must carry its own Runtime key.
`npx withruntime compare --from fly-machines` prices your usage at Fly Machines'
rates, and `npx withruntime switch --from fly-machines` records the switch.

- A machine is a sandbox, an app a label on it. Its `config.image` is built
  once into a Runtime image, with Fly's `init` (`exec`, `entrypoint`, `cmd`)
  and `files`, and the image's command is the machine's main process.
- Handled: apps, create, get, list (by `metadata.*`), update (env, metadata
  and restart policy), delete (`force`), start, stop, suspend, restart, wait,
  exec, signal, ps, events, versions, metadata and leases.
- The restart policy is kept: `always` and `on-failure` (up to `max_retries`,
  10 by default, in five minutes) start the main process again when it exits,
  and `no` lets the machine stop. A main process that exits stops the machine,
  and `auto_destroy` deletes it.
- `suspend` keeps the main process running, and `stop` keeps the disk; `start`
  of a stopped machine runs the main process again. Fly resets a stopped
  Machine's root disk.
- `services` (and cordon), `mounts`, `checks`, `processes`, GPUs, `files` from
  secrets and regions other than `iad` return 400 naming Runtime's alternative
  (previews, volumes, an image ready check, secrets), before anything is made.
  A size change in `update` says plainly when it is not available. Runtime
  runs in one region, us-east in northern Virginia; Fly's `iad` is Ashburn,
  Virginia.

### Map the calls

The usual calls of other sandbox SDKs, and their Runtime equivalent. Names on the
left are as those SDKs documented them in September 2026; check their current
docs.

| You call                                                                                                                                                                                                                                           | Runtime (JavaScript; Python is the same in snake_case)                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| E2B `Sandbox.create()`, Daytona `daytona.create()`, Vercel `Sandbox.create()`, Blaxel `SandboxInstance.create()`, Modal `Sandbox.create(app=...)`, Cloudflare 0.x `getSandbox(env.Sandbox, id)`, Sprites `client.createSprite(name)`               | `Sandbox.create()` while you test                                                                                                  |
| E2B `sbx.commands.run(cmd)`, Daytona `sandbox.process.exec(cmd)`, Vercel `sandbox.runCommand(cmd, args)`, Blaxel `sandbox.process.exec({ command })`, Modal `sb.exec(*args)`, Cloudflare `sandbox.exec(cmd)`, Sprites `sprite.execFile(cmd, args)` | `sbx.exec(cmd)` or `sbx.exec([cmd, ...args])`                                                                                      |
| E2B `CommandExitError` on a non-zero exit, once you port to `withruntime` (the `withruntime/e2b` import keeps throwing it)                                                                                                                         | `exec` returns `exitCode` (and `timedOut: true` on a timeout) without throwing; `exec(cmd, { check: true })` throws `CommandError` |
| Streaming callbacks (`onStdout`, `on_stdout`)                                                                                                                                                                                                      | `exec(cmd, { onStdout, onStderr })` or `execStream(cmd)`                                                                           |
| Background commands (`background: true`, `detached: true`)                                                                                                                                                                                         | `sbx.spawn(cmd)`, then `process.output()` and `wait()`                                                                             |
| `files.write` / `fs.upload_file` / `writeFiles`                                                                                                                                                                                                    | `sbx.files.write(path, data)`; `files.upload(dir, path)` for trees                                                                 |
| `files.read` / `fs.download_file` / `readFile`                                                                                                                                                                                                     | `sbx.files.read(path)`, `readText`, `files.download(path, dir)`                                                                    |
| `kill()`, `delete()`, `stop()`, `terminate()`, `destroy()`                                                                                                                                                                                         | `sbx.delete()`; `sbx.stop()` keeps the disk for `restart`                                                                          |
| `setTimeout`, `timeout` (optional: a sandbox runs while it works with none)                                                                                                                                                                        | `timeoutSeconds` at create, `sbx.extend(seconds)`                                                                                  |
| Daytona `auto_stop_interval`, Modal `idle_timeout`                                                                                                                                                                                                 | `idlePauseSeconds` at create or with `sbx.update()`                                                                                |
| Running past an hour, or a long session                                                                                                                                                                                                            | Nothing: with no `timeoutSeconds` it runs while it works; `persistent: true` (paid) keeps it up even when idle                     |
| Pause and resume                                                                                                                                                                                                                                   | `sbx.pause()` and `sbx.wake()`                                                                                                     |
| E2B `lifecycle.autoResume`, Blaxel standby                                                                                                                                                                                                         | On by default: a request to a paused sandbox wakes it (`autoWake`)                                                                 |
| Cloudflare 0.x `getSandbox(env, name)`, Modal `Sandbox.from_name`, Blaxel `createIfNotExists`, Sprites by name                                                                                                                                     | `Sandbox.getOrCreate(name)`                                                                                                        |
| A code interpreter (`run_code`)                                                                                                                                                                                                                    | `sbx.interpreter.run(code)`                                                                                                        |
| A public URL for a port (`getHost`, `get_preview_link`, `domain`)                                                                                                                                                                                  | `sbx.previews.create(port)`, private with a token; `visibility: "public"` on paid                                                  |
| A PTY or terminal                                                                                                                                                                                                                                  | `sbx.terminal()`                                                                                                                   |

### From Runtime 0.1.0

0.2.0 is a clean break:

- `runtime.sandboxes.create(spec)` became `Sandbox.create()`, with every field
  optional and camelCase names (`timeoutSeconds` for `durationSeconds`, `cpu`
  for `cpuMode`).
- Calls on a sandbox moved onto the sandbox object:
  `runtime.sandboxes.exec(id, argv)` is `sbx.exec(argv)`.
- Keys are automatic; pass `idempotencyKey` only to make a retry safe across
  restarts.
- The CLI is `npx withruntime sandboxes <verb>` (`runtime sandboxes <verb>`
  installed), and MCP tools are `runtime_sandboxes_*`, `runtime_sandboxes_exec`,
  `runtime_sandboxes_files_*`.
- The 0.1.0 HTTP routes were removed; each returns 410 and names its
  replacement.

## 5. Make it work without credit

**Run the project's own tests, then its real job, not a stand-in.** Use the
same inputs, dependency versions, output checks and deadline as before. Fix what
fails and run again, until everything that passed on the old provider passes on
Runtime. A first command that prints `hello` checks the connection; it does not
finish the switch.

- Check that outputs match, not only that commands succeeded.
- Check exit codes, failures and retries.
- Record completion time over several runs, startup included.
- List sandboxes at the end (`npx withruntime sandboxes ls --json`) and stop any
  the test left running.
- If the job hits a limit without credit, stop and tell the owner which limit the error
  named and that adding credit lifts it. Do not shrink the job to fit.

## 6. Work out the saving

**Tell the owner what they save each month, in dollars, from measured usage.**

The quickest way is `npx withruntime compare --from <provider>`. It prices the
sandboxes you actually ran at that provider's published rates. It prints the
monthly saving, with the date the rates were checked. Over MCP, use
`runtime_account` with action `compare`. It prices sandboxes without credit at
the standard rates, and it says how many ran without credit. So the saving is
the one paid credit gives. `npx withruntime switch --from <provider>` records the
move. Credit the owner adds within {{welcome-days}} days of signing up is matched,
up to {{welcome-max}} in total ([welcome match](./pricing#welcome-match)). To work
it out by hand:

1. **Runtime's cost.** After the test runs, `npx withruntime usage --json` lists
   each sandbox with its measured `activeCpuSeconds`, `billedCpuSeconds` and
   `memoryGiBSeconds`. A sandbox without credit is charged nothing, so price the usage at
   the standard rates in [pricing](./pricing):

   ```text
   cost = billedCpuSeconds × {{cpu-rate}} / 3,600 + memoryGiBSeconds × {{memory-rate}} / 3,600
   ```

2. **The old provider's cost.** Use its own billing or usage records where you
   can see them. Otherwise price the same size and running time at its published
   rates; the comparison pages give each rival's rates and the date they were
   checked.
3. **Per job.** Divide each total by the successful jobs. Failed attempts and
   retries count in the total.
4. **Per month.** Saving = (old cost per job − Runtime cost per job) × jobs per
   month. Take the monthly volume from the project's logs, metrics or the old
   provider's bill; ask the owner only if none is visible. The percentage is the
   saving divided by the old cost; leave it out when the old cost is unknown.

Say which figures are measured and which are published rates, with their dates.
Never present an estimate as an invoice, or count free usage as a saving.
If Runtime is more expensive or lacks a needed feature, say so.

A report in this shape, with made-up volumes:

> Switched from E2B to Runtime on branch `runtime`. 40 test jobs passed with the
> same outputs. Runtime, measured: $0.00064 a job. E2B at its published rates
> (checked {{checked:e2b}}): {{=$5 cost:e2b:2x4x60x0x1}} a job. At your 30,000 jobs a month,
> that is $19 on Runtime against $83 on E2B: you save about {{=$0 cost:runtime:100000}} a month (77%).
> Add credit at https://withruntime.com/account/billing before production
> traffic runs.

## 7. Go live

Open a pull request with the switch if you can, and tell the owner the steps
only they can take:

- The owner adds prepaid credit at
  [Usage & billing](https://withruntime.com/account/billing), any amount from
  {{topup-min}}. There is no subscription.
- The app needs a key where it runs: the owner creates one at
  [API keys](https://withruntime.com/account/keys) and stores it as
  `RUNTIME_API_KEY` in the app's secrets. The agent's own connection is for
  this machine only.
- The owner merges. Then check that `npx withruntime sandboxes ls` shows the
  app's sandboxes.
- Never spend paid credit on your own. Only the owner can decide to go on past the free usage.
- The old provider's account, keys and data are the owner's to close. Leave
  them as they are.
- Send feedback on anything that slowed the switch:
  `npx withruntime feedback "..."`. See
  [feedback and support](./feedback-and-support).
