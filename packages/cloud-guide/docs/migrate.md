# Switch to Runtime from another sandbox provider

Move your sandbox code to Runtime in one pass, test it on the free trial, and see what you save each month.

Your model, prompts and application stay as they are; only the sandbox calls
change. For a project with no sandbox yet, start with [Get started](./start).

## Give your agent one instruction

> Switch this project's sandboxes to Runtime Cloud: read
> https://withruntime.com/docs/migrate.md and follow it. Replace our current
> provider's calls, test on the free trial, then tell me what I save each
> month. When it asks for my approval, show me the link and code.

The agent follows the steps below and ends with your monthly saving in dollars.
It never spends paid credit, and it never touches your old provider's account.

**Why teams switch:**

- **You pay for the CPU you use.** $0.025 per active vCPU-hour, measured, and
  $0.0075 per reserved GiB-hour of memory. No plan fee, and no one-minute
  minimum.
- **The calls map one to one.** Create, exec, files and stop have direct
  equivalents (table below). Code written for E2B, Daytona, Vercel Sandbox or
  Blaxel runs after changing one import.
- **Pause keeps memory.** A paused sandbox wakes where it left off, kept 1 to
  365 days on a paid account. A fork copies a running sandbox with its memory
  and processes.
- **More is built in.** A desktop, a code interpreter, custom images, volumes,
  and preview URLs that are private by default.
- **No API key to copy.** One browser approval connects the CLI, SDKs and MCP.
- **Test it free.** 100 sandbox hours, no card, up to eight running at once.

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
| SSH or an editor        | `runtime sandbox ssh`, and `<id>.runtime` in VS Code or JetBrains ([SSH and editors](./editors))                         |
| A port on your machine  | `runtime sandbox port-forward <id> 5432`, any TCP port, over the API                                                     |
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
npx withruntime sandbox run --trial -- echo hello
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
- Keep `funding: "trial"` (CLI: `--trial`) while you test. Omitted funding can
  use prepaid credit after the trial.
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
keeps memory and processes after 60 idle seconds, and the next call wakes the
sandbox. Pass `withruntime: { create: { funding: "trial" } }` (Python
`runtime_create={"funding": "trial"}`) while you test. A call Runtime handles
differently, such as sessions, drives or schedules, throws `NotSupportedError`
naming what to use instead.

- A sandbox is visible only to the key that created it, so a web service and a
  worker that share sandboxes must use the same key
  ([keys in a team](./teams#keys-in-a-team)).
- The trial caps a sandbox at 2 vCPU and 4096 MB; `memory: 8192` needs paid
  credit.
- An image other than Blaxel's own templates must be a ready Runtime image of
  the same name: `npx withruntime image build --dockerfile Dockerfile --name <name>`.
- Blaxel's preview token header (`X-Blaxel-Preview-Token`) and parameter
  (`?bl_preview_token=`) are accepted.

**From E2B:** change `from "e2b"` to `from "withruntime/e2b"` (Python
`from withruntime.e2b import ...`, SDK 0.4.0 and later), and pass
`runtime: { create: { funding: "trial" } }` (Python
`runtime_create={"funding": "trial"}`) while you test. Errors stay E2B's:
`commands.run` throws `CommandExitError` (Python `CommandExitException`) on a
non-zero exit and `TimeoutError` (Python `TimeoutException`) past its timeout,
so keep your `try`/`catch`. A call Runtime handles differently throws
`NotSupportedError` naming what to use instead.

### Map the calls

The usual calls of other sandbox SDKs, and their Runtime equivalent. Names on the
left are as those SDKs documented them in September 2026; check their current
docs.

| You call                                                                                                                                                                                                                                           | Runtime (JavaScript; Python is the same in snake_case)                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| E2B `Sandbox.create()`, Daytona `daytona.create()`, Vercel `Sandbox.create()`, Blaxel `SandboxInstance.create()`, Modal `Sandbox.create(app=...)`, Cloudflare `getSandbox(env.Sandbox, id)`, Sprites `client.createSprite(name)`                   | `Sandbox.create({ funding: "trial" })` while you test                                                                              |
| E2B `sbx.commands.run(cmd)`, Daytona `sandbox.process.exec(cmd)`, Vercel `sandbox.runCommand(cmd, args)`, Blaxel `sandbox.process.exec({ command })`, Modal `sb.exec(*args)`, Cloudflare `sandbox.exec(cmd)`, Sprites `sprite.execFile(cmd, args)` | `sbx.exec(cmd)` or `sbx.exec([cmd, ...args])`                                                                                      |
| E2B `CommandExitError` on a non-zero exit, once you port to `withruntime` (the `withruntime/e2b` import keeps throwing it)                                                                                                                         | `exec` returns `exitCode` (and `timedOut: true` on a timeout) without throwing; `exec(cmd, { check: true })` throws `CommandError` |
| Streaming callbacks (`onStdout`, `on_stdout`)                                                                                                                                                                                                      | `exec(cmd, { onStdout, onStderr })` or `execStream(cmd)`                                                                           |
| Background commands (`background: true`, `detached: true`)                                                                                                                                                                                         | `sbx.spawn(cmd)`, then `process.output()` and `wait()`                                                                             |
| `files.write` / `fs.upload_file` / `writeFiles`                                                                                                                                                                                                    | `sbx.files.write(path, data)`; `files.upload(dir, path)` for trees                                                                 |
| `files.read` / `fs.download_file` / `readFile`                                                                                                                                                                                                     | `sbx.files.read(path)`, `readText`, `files.download(path, dir)`                                                                    |
| `kill()`, `delete()`, `stop()`, `terminate()`, `destroy()`                                                                                                                                                                                         | `sbx.stop()`, or `await using` / `with` to stop on exit                                                                            |
| `setTimeout`, `timeout`                                                                                                                                                                                                                            | `timeoutSeconds` at create, `sbx.extend(seconds)`                                                                                  |
| Daytona `auto_stop_interval`, Modal `idle_timeout`                                                                                                                                                                                                 | `idlePauseSeconds` at create or with `sbx.update()`                                                                                |
| Running past one lease                                                                                                                                                                                                                             | `persistent: true` (paid), or `keepAlive: true` from your process                                                                  |
| Pause and resume                                                                                                                                                                                                                                   | `sbx.pause()` and `sbx.wake()`                                                                                                     |
| E2B `lifecycle.autoResume`, Blaxel standby                                                                                                                                                                                                         | On by default: a request to a paused sandbox wakes it (`autoWake`)                                                                 |
| Cloudflare `getSandbox(env, name)`, Modal `Sandbox.from_name`, Blaxel `createIfNotExists`, Sprites by name                                                                                                                                         | `Sandbox.getOrCreate(name)`                                                                                                        |
| A code interpreter (`run_code`)                                                                                                                                                                                                                    | `sbx.interpreter.run(code)`                                                                                                        |
| A public URL for a port (`getHost`, `get_preview_link`, `domain`)                                                                                                                                                                                  | `sbx.previews.create(port)`                                                                                                        |
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
- The CLI is `npx withruntime sandbox <verb>` (`runtime sandbox <verb>`
  installed), and MCP tools are `runtime_sandbox_*`, `runtime_sandbox_exec`,
  `runtime_sandbox_files_*`.
- The 0.1.0 HTTP routes were removed; each answers 410 and names its
  replacement.

## 5. Test on the trial

**Run the project's own tests, then a representative job.** Use the same
inputs, dependency versions, output checks and deadline as before.

- Check that outputs match, not only that commands succeeded.
- Check exit codes, failures and retries.
- Record completion time over several runs, startup included.
- List sandboxes at the end (`npx withruntime sandbox ls --json`) and stop any
  the test left running.

## 6. Work out the saving

**Tell the owner what they save each month, in dollars, from measured usage.**

The quickest way: `npx withruntime compare --from <provider>` prices the
sandboxes you actually ran at that provider's published rates and prints the
monthly saving, with the date the rates were checked (`runtime_usage_compare`
over MCP). It prices trial sandboxes at the standard rates and says how many
ran on the trial, so the saving is the one paid credit gives. Before the owner's first top-up, `npx withruntime switch --from
<provider>` records the move, and that top-up is matched, up to $100
([switching credit](./pricing#switching-credit)). To work it out by hand:

1. **Runtime's cost.** After the test runs, `npx withruntime usage --json` lists
   each sandbox with its measured `activeCpuSeconds`, `billedCpuSeconds` and
   `memoryGiBSeconds`. A trial sandbox is charged nothing, so price the usage at
   the standard rates in [pricing](./pricing):

   ```text
   cost = billedCpuSeconds × $0.025 / 3,600 + memoryGiBSeconds × $0.0075 / 3,600
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
Never present an estimate as an invoice, or count free trial time as a saving.
If Runtime is more expensive or lacks a needed feature, say so.

A report in this shape, with made-up volumes:

> Switched from E2B to Runtime on branch `runtime`. 40 test jobs passed with the
> same outputs. Runtime, measured: $0.00064 a job. E2B at its published rates
> (checked 23 September 2026): $0.00276 a job. At your 30,000 jobs a month,
> that is $19 on Runtime against $83 on E2B: you save about $64 a month (77%).
> Add credit at https://withruntime.com/account/billing before production
> traffic runs.

## 7. Go live

- The owner adds prepaid credit at
  [Usage & billing](https://withruntime.com/account/billing), any amount from
  $10. There is no subscription.
- Change `funding: "trial"` to `"paid"`, or remove it, once the owner says so.
  Never spend paid credit on your own.
- The old provider's account, keys and data are the owner's to close. Leave
  them as they are.
- Send feedback on anything that slowed the switch:
  `npx withruntime feedback "..."`. See
  [feedback and support](./feedback-and-support).
