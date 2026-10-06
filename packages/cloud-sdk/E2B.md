# Code written for E2B, on Runtime

Supported sandbox calls from [E2B](https://e2b.dev)'s SDK keep their call
shapes on Runtime Cloud after changing the import. It is part of Runtime's SDK (`withruntime`), built on the same
client, so it gets that SDK's retries, idempotency keys and errors. Importing
`withruntime` alone does not load it.

```ts no-run
import { Sandbox } from "withruntime/e2b"; // was: from "e2b"
```

```ts no-run
import { Sandbox } from "withruntime/e2b/code-interpreter"; // was: from "@e2b/code-interpreter"
```

Python has the same, in `pip install withruntime`:

```python no-run
from withruntime.e2b import Sandbox  # was: from e2b import Sandbox
from withruntime.e2b.code_interpreter import Sandbox  # was: from e2b_code_interpreter import Sandbox
```

The mapping was written against `e2b` 2.51.0 and checked against `e2b` 2.52.1
and `@e2b/code-interpreter` 2.8.0 (Python: `e2b` 2.52.1, `e2b-code-interpreter`
2.10.1) on 5 October 2026. The exact package releases and artifact hashes are kept in
`compatibility-lock.json`.

## Keys

The package uses, in order: an `apiKey` you pass, `RUNTIME_API_KEY`, a Runtime
key left in `E2B_API_KEY`, and the key `npx withruntime login` saved on this
machine. An E2B key (`e2b_...`) is never sent anywhere. If one is passed as
`apiKey`, or left in `E2B_API_KEY`, and `RUNTIME_API_KEY` is not set, the call
fails with `AuthenticationError` (Python: `AuthenticationException`) saying
so, rather than fall back to a saved login that may be another account's.
When `RUNTIME_API_KEY` and `E2B_API_KEY` hold two different Runtime keys, which
may be two accounts, a warning says so once (`RUNTIME_E2B_TWO_KEYS`; Python: a
`RuntimeWarning`). A template with no image of its name fails naming the
account the key belongs to and where the key came from.

## What a sandbox gets

- **Machine:** E2B's default, 2 vCPU and 512 MiB. For another, pass
  `runtime: { create: { memoryMiB: 4096 } }` (Python:
  `runtime_create={"memory_mib": 4096}`).
- **Timeout:** kept by Runtime's server, never by a timer in your process,
  so it holds after the process that made the sandbox exits. A `timeoutMs`
  you give (Python `timeout`, seconds), up to 24 hours, deletes the sandbox
  when it runs out, as E2B kills it; so does `lifecycle: { onTimeout: "kill" }`.
  With no timeout, E2B's default of 300 seconds applies, and when it runs out
  the sandbox **pauses** instead: nobody asked for it to end, so nothing is
  lost, and the next call wakes it. E2B deletes it at that point.
  `lifecycle: { onTimeout: "pause" }` pauses at any timeout.
- **What a pause keeps, and costs:** memory, files and running processes, for
  as long as the account has credit, billed as paused storage by the GB a
  month for what the sandbox alone holds (`pricing.md`, "Paused storage").
  Sandboxes created with no timeout and never killed pile up as paused
  storage: call `kill()` when the work is done, or give a `timeoutMs`.
- **On a pilot account:** the server keeps every sandbox running until you
  end it, with no idle pause, whatever `timeoutMs` says, and machine size is
  the pilot's. `kill()` deletes it.
- **Kill:** `kill()` deletes the sandbox for good, as E2B's does: its disk,
  memory and shared ports go, and it no longer counts against the account's
  sandboxes.
- **Idle pause:** Runtime's default, which E2B does not have. After 60
  seconds with nothing happening in it (no request, running command, open
  connection, traffic or CPU use) the sandbox pauses with its memory kept, and
  the next command or file call wakes it. To code written for E2B it is still
  running: `isRunning()` is `true`, `getInfo()` says `running` and
  `list({ query: { state: ["running"] } })` includes it. Pass
  `runtime: { create: { idlePauseSeconds: 0 } }` (Python:
  `runtime_create={"idle_pause_seconds": 0}`) to keep it running, as on E2B.
- **Connections:** one client per key, holding up to 4,096 connections to
  the API at once, the most Runtime's edge gives an address that has used a
  valid key. E2B's SDK holds no call back, and neither does this one: a
  thousand commands at once from one process all run at once. Past an
  account's room the API answers with a retry, which the client waits out. If
  calls ever wait for a connection, a warning says so once
  (`RUNTIME_E2B_QUEUED`). Runtime's own SDK keeps 48; pass your own client
  with `runtime: { client: new Runtime({ maxConnections }) }` (Python:
  `client=Runtime(max_connections=...)`).
- **Funding:** left to Runtime, as `withruntime`'s own `create()` does. The
  free trial is used while the account has trial time, then prepaid credit.
  Pass `runtime: { create: { funding: "trial" } }` to use only the trial.
- **Anything else Runtime offers:** `runtime: { create: { ... } }` sends
  Runtime's create fields as they are, over the adapter's. `sandbox.runtime`
  is the Runtime sandbox underneath, with previews, network rules, desktop,
  processes and terminals.

## Mapping

| E2B                                                                                      | On Runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox.create()`, `Sandbox.create(template, opts)`                                     | `sandboxes.create`. `base` and `code-interpreter-v1` are Runtime's stock image. Any other name, with its `:tag`, is a Runtime image of that name, resolved by the create itself; E2B's `team/` prefix is dropped, since an account's images are its own. A UUID is an image or a snapshot. A name no image has throws `TemplateError` saying how to build it.                                                                                                                                                                                                                                           |
| `timeoutMs` (Python `timeout`, seconds)                                                  | `timeoutSeconds`, rounded up, kept by the server, with `onTimeout: "delete"`. Left out, 300 s with `onTimeout: "pause"`. Under 60 s becomes 60 s, with a warning. Up to 24 hours, as on E2B; over throws `InvalidArgumentError`.                                                                                                                                                                                                                                                                                                                                                                        |
| `metadata`                                                                               | labels (at most 32).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `envs`                                                                                   | Given to every command and code run through this object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `allowInternetAccess: false`                                                             | `network: { internet: false }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lifecycle.onTimeout`                                                                    | `onTimeout`: `kill` is `delete`, `pause` is `pause`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `commands.run(cmd, { cwd, envs, timeoutMs, onStdout, onStderr })`                        | A native process started by a streamed exec that reads it from the first byte, so Runtime holds a fast writer back rather than drop output: the result is whole, however long. The default command connection deadline is 60 s; `0` disables it. The process lives up to 24 hours, within the sandbox lease.                                                                                                                                                                                                                                                                                            |
| Non-zero exit                                                                            | Throws `CommandExitError` with `exitCode`, `stdout`, `stderr` and `error` (`exit status N`). A command killed by a signal has `exitCode` -1.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Command past its timeout                                                                 | Disconnects with `TimeoutError` (Python: `TimeoutException`) without killing the command; reconnect by pid to keep reading. A command whose sandbox is killed under it ends with `TimeoutError` too, saying the sandbox was killed or reached its end of life.                                                                                                                                                                                                                                                                                                                                          |
| `commands.run(cmd, { background: true })`                                                | `spawn`. Returns a `CommandHandle` with `pid`, `wait()`, `kill()` (SIGKILL), `sendStdin`, `closeStdin`, `disconnect`, `stdout`, `stderr`, `exitCode`. Runtime keeps the last 1 MiB a process printed; anything older that was not read in time is lost, which sets `truncated` and warns. A command with `stdin: true` starts the same way.                                                                                                                                                                                                                                                             |
| `user` (commands, PTY and files)                                                         | Runs as that Linux user through `sudo -u`; `root` needs nothing more. A user the sandbox lacks throws `InvalidArgumentError` saying how to add one; none is ever created. `user: "user"` is the sandbox's own user. Watching a directory as another user is refused.                                                                                                                                                                                                                                                                                                                                    |
| `commands.list`, `kill(pid)`, `sendStdin(pid)`, `closeStdin(pid)`, `connect(pid)`        | Runtime's processes. A pid is a number derived from Runtime's process id, not the Linux pid. `commands.list` shows each command as E2B starts it: `cmd` `/bin/bash`, `args` `["-l", "-c", "<your command>"]` (a PTY: `["-i", "-l"]`), the command cut at 256 characters, `envs` empty.                                                                                                                                                                                                                                                                                                                  |
| `pty.create`, `connect`, `sendInput`, `resize`, `kill` (Python snake_case)               | Native PTY processes with lossless byte callbacks. A reader timeout or disconnect detaches without killing the process; reconnect resumes reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `files.read(path, { format })`                                                           | `files.read`. `text`, `bytes`, `blob` and `stream` (Python: `text`, `bytes`, `stream`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `files.write(path, data)`, `write([...])`, `writeFiles`                                  | `files.write`. Parent directories are made, and a file that exists is replaced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `files.list(path, { depth })`                                                            | `files.list`, hidden files included. `owner` and `group` come from native metadata, with `""` for older guests that omit them. `depth` below one throws `InvalidArgumentError` "depth should be at least one".                                                                                                                                                                                                                                                                                                                                                                                          |
| `files.makeDir`, `exists`, `getInfo`, `rename`, `remove`                                 | `files.stat`, `mkdir`, `rename` (replacing a file that exists) and `remove` (recursive). A missing file throws `FileNotFoundError`. Entries read as envd gives them: `permissions` begins with the kind's letter (`-rw-r--r--`, `drwxr-xr-x`, `L` for a link), the sandbox user is `user`, and a link's `symlinkTarget` is absolute.                                                                                                                                                                                                                                                                    |
| Relative paths                                                                           | Resolved against the home directory, `/workspace` on Runtime, and given back under `/home/user`, as E2B gives them: `write("a.txt")` returns `/home/user/a.txt`. A path given in full comes back as given. `pwd` in a command prints `/workspace`.                                                                                                                                                                                                                                                                                                                                                      |
| `/home/user` (E2B's home)                                                                | The first time a path, `cwd` or command names it, it becomes a link to `/workspace`, unless something is already there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sandbox.kill()`, `Sandbox.kill(id)`                                                     | `delete`: gone for good. `false` when the sandbox was not found or was already deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sandbox.setTimeout(ms)`, `Sandbox.setTimeout(id, ms)`                                   | `extend`: the end moves to now + ms, up to 24 hours. An earlier end is refused: Runtime cannot bring a time limit forward. A sandbox with no time limit (a pilot's) has no end to move, and nothing changes.                                                                                                                                                                                                                                                                                                                                                                                            |
| `Sandbox.connect(id, { timeoutMs })`, `sandbox.connect()`                                | `get`. A paused sandbox is woken. A running one's end moves later, never earlier, up to 24 hours. An ended one throws `SandboxNotFoundError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sandbox.pause()`, `betaPause`, `Sandbox.pause(id)`                                      | `pause`, keeping memory and files. `false` when it was already paused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `getInfo`, `isRunning`                                                                   | `get`. `templateId` is the template the sandbox was created from, as you named it (kept in the label `e2b-template`, which `metadata` leaves out), or `base`. `envdVersion` is `runtime`. A sandbox Runtime paused for being idle is `running`. `endAt` is when it ends by itself; one that never will (no time limit, as a pilot's) reads 24 hours ahead, the furthest E2B allows.                                                                                                                                                                                                                     |
| `Sandbox.list({ query: { metadata, state }, limit })`                                    | `sandboxes.list` by labels and state, oldest first, with E2B's paginator (`hasNext`, `nextItems()`, `nextToken`). A `template` or `startedAfter` filter, `order: "desc"` and a saved `nextToken` are applied by the adapter, which reads every match once and pages through them.                                                                                                                                                                                                                                                                                                                       |
| `fork`, `createSnapshot`, `deleteSnapshot`                                               | Runtime's memory-preserving forks and snapshots; deleting a snapshot removes that saved capture. A fork's `count` is 1 to 20, as E2B checks it.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getHost(port)`                                                                          | `<port>-<id>.runtimehost.com` at once, as E2B answers it, and the port is shared as a public Runtime preview beside the caller (the sync Python sandbox shares it before returning). `await sandbox.getPublicHost(port)` returns once the share has landed. On the free trial a shared port is private and a host alone cannot reach it, so both throw `PublicPreviewNotAllowedError` (Python: `PublicPreviewNotAllowedException`, a kind of `NotSupportedError`) at once. Use `(await sandbox.runtime.previews.create(port)).urlWithToken`, or send its token as the `x-runtime-preview-token` header. |
| `runCode(code, { language, context, onStdout, onStderr, onResult, onError, timeoutMs })` | Runtime's interpreter: Python, JavaScript, TypeScript, R, Java and Bash, plus Go. The sandbox's `envs` reach code through a context made once for them. `onResult` streams each result and waits for asynchronous callbacks.                                                                                                                                                                                                                                                                                                                                                                            |
| `Execution`, `Result`, `Logs`, `ExecutionError`, `OutputMessage`                         | The same shapes. Results that are too large to send inline are fetched and inlined. `logs.stdout` has one entry per line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `createCodeContext`, `listCodeContexts`, `restartCodeContext`, `removeCodeContext`       | Runtime's interpreter contexts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getMetrics({ start, end })`, `Sandbox.getMetrics(id)`                                   | Runtime's measured CPU and memory, one entry per host reading. `diskUsed` is null: Runtime does not read disk use inside the sandbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Error classes and other exports                                                          | Every name `e2b` and the code interpreter export imports, errors with E2B's names and parents. Python also imports each from the module E2B defines it in, so `from e2b.exceptions import TimeoutException` becomes `from withruntime.e2b.exceptions import TimeoutException`, and `WriteEntry` comes from `withruntime.e2b.sandbox.filesystem.filesystem`. Each error also carries Runtime's `code`, `hint` and `requestId`, with the original error as `cause`.                                                                                                                                       |

## Gaps

Each of these throws `NotSupportedError` (Python: `NotSupportedException`)
before anything happens. The error's `feature` names the gap and its
`alternative` says what to use.

| E2B                                                           | Use instead                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| An E2B template name with no Runtime image of that name       | Build it: `npx withruntime image build --dockerfile e2b.Dockerfile --name <template>`. This throws `TemplateError`. |
| `Template`, `waitForPort` and the other ready checks          | `runtime.images.build(...)`                                                                                         |
| `setTimeout` to an earlier time                               | `kill()` when the work is done.                                                                                     |
| `keepMemory: false`                                           | Runtime's pause keeps memory.                                                                                       |
| `onResume: "reboot"`                                          | Stop the sandbox and create a new one.                                                                              |
| `fork({ timeoutMs })`                                         | Fork without it, then call `setTimeout` on each fork.                                                               |
| `network`, `updateNetwork`                                    | `runtime: { create: { network } }` and `sandbox.runtime.network.set(...)`.                                          |
| `mcp`, `getMcpUrl`, `getMcpToken`                             | Runtime's own MCP server, `npx withruntime mcp`.                                                                    |
| `iam`, `Secret`                                               | A Runtime secret (`npx withruntime secrets set NAME --host <host>`): the sandbox sees a placeholder.                |
| `volumeMounts`, `Volume`                                      | Runtime volumes: `runtime: { create: { volumes: [{ volumeId, path }] } }`.                                          |
| `git`                                                         | `commands.run("git ...")`. E2B has deprecated its git module too.                                                   |
| File `metadata`                                               | Keep it in a file beside the data.                                                                                  |
| `uploadUrl`, `downloadUrl`                                    | `files.write` and `files.read`.                                                                                     |
| `runCode(code, { envs })`                                     | A context made with them: `sandbox.runtime.interpreter.contexts.create({ env })`.                                   |
| `domain`, `apiUrl`, `sandboxUrl`, `headers`, `proxy`, `debug` | Remove them. `RUNTIME_API_URL` sets Runtime's origin, and `HTTPS_PROXY` sets a proxy.                               |

Directory watches use Runtime's native watch stream. JavaScript uses
`files.watchDir(path, onEvent, options)`. Python's synchronous `watch_dir(path)`
returns a handle with `get_new_events()` and `stop()`; asynchronous
`watch_dir(path, on_event, on_exit=...)` delivers callbacks. Stop is safe inside
a callback. Stream failures and lost events are reported, never treated as a
successful empty watch. A positive watch timeout bounds the client subscription and stops its owned watch;
zero leaves the subscription unlimited. The sandbox lease still applies. Both languages refuse watching network mounts.
As on envd, a path that is a file is refused with `InvalidArgumentError`
(Python: `InvalidArgumentException`). Runtime writes a file whole, by a rename
into place, which its watch sees as a create; a file's create is therefore
followed by a write event, which E2B code waiting for the write receives.

PTY `timeoutMs` (Python `timeout`, seconds) defaults to sixty seconds, including
the opening handshake; zero leaves the reader unlimited. Callbacks receive raw
bytes while the handle's `stdout` and `stderr` stay empty. PTYs made before
lossless output support cannot reconnect through this adapter; create a new one.
The sandbox lease still applies.

Some differences are not refusals, so code that depends on them should check:

- Runtime's stock image is Ubuntu 24.04 with Python 3.12, Node.js 24 and Bun.
  The current stock image includes NumPy, pandas and matplotlib; build an image
  for additional dependencies. Results never carry `chart`. A DataFrame arrives in
  `extra` under `application/vnd.runtime.table+json`, not in E2B's `data`.
- JavaScript file operations, command creation and reads, stdin/EOF, lookup, kill and reconnect honor `requestTimeoutMs` and `signal`.
  Python file `request_timeout` bounds the request, including streamed reads. `retries`, `logger`, `secure`, `validateApiKey` and
  `httpVersion` (Python `http_version`; `'1.1'` or `'2'`, as E2B checks it) are
  accepted without changing the native transport settings.
- Interpreter deadlines follow the pinned packages: JavaScript defaults to
  sixty seconds and Python to five minutes; zero disables the read deadline.
  A client timeout detaches the reader without interrupting the cell. The
  sandbox lease still applies.

## Tests

`bun run test` in `packages/cloud-sdk` runs the unit tests of both languages
against fakes of Runtime's SDKs, including every call in the mapping and
every refusal: `tests/e2b` here and `sdks/python/tests/test_e2b_*.py`.

The end-to-end tests run an unmodified E2B program against the real API with
its one import changed. They create six sandboxes on the key's account. Each
has 2 vCPU and 512 MiB, lasts at most five minutes and is deleted when its
case ends. They are not part of `bun run test`.

```bash no-run
RUNTIME_API_KEY=... bun packages/cloud-sdk/scripts/e2b-e2e.ts   # the judge panel's E2B eval, JavaScript
RUNTIME_API_KEY=... python3 sdks/python/scripts/e2b_e2e.py        # the same cases in Python
```

Either one run with `--dry` sets up and shows the one-line change without
creating anything.
