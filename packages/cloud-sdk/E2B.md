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

The mapping was written against `e2b` 2.51.0 and checked against `e2b` 2.52.0
and `@e2b/code-interpreter` 2.8.0 (Python: `e2b` 2.52.0, `e2b-code-interpreter`
2.10.1) on 2 October 2026. The exact package releases and artifact hashes are kept in
`compatibility-lock.json`.

## Keys

The package uses, in order: an `apiKey` you pass, `RUNTIME_API_KEY`, a Runtime
key left in `E2B_API_KEY`, and the key `npx withruntime login` saved on this
machine. An E2B key (`e2b_...`) is never sent anywhere. If one is passed as
`apiKey` and `RUNTIME_API_KEY` is not set, the call fails with
`AuthenticationError`.

## What a sandbox gets

- **Machine:** E2B's default, 2 vCPU and 512 MiB. For another, pass
  `runtime: { create: { memoryMiB: 4096 } }` (Python:
  `runtime_create={"memory_mib": 4096}`).
- **Timeout:** E2B's default of 300 seconds. When it ends, the sandbox is
  stopped, as E2B kills it. `lifecycle: { onTimeout: "pause" }` pauses it
  instead.
- **Idle pause:** Runtime's default, which E2B does not have. After 60
  seconds with nothing happening in it (no request, running command, open
  connection, traffic or CPU use) the sandbox pauses with its memory kept, and
  the next command or file call wakes it. While it is paused, `isRunning()`
  is `false` and `getInfo()` says `paused`, so code that reads either as
  "the sandbox is gone" should not. Pass
  `runtime: { create: { idlePauseSeconds: 0 } }` (Python:
  `runtime_create={"idle_pause_seconds": 0}`) to keep it running, as on E2B.
- **Connections:** one client per key, holding at most 48 connections to the
  API at once, since one address may hold 64. Each command being run holds
  one while its output is read, and 8 are kept for other calls, so past 40
  commands at once from one process the rest wait their turn. Pass your own
  client with `runtime: { client: new Runtime({ maxConnections }) }` (Python:
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
| `Sandbox.create()`, `Sandbox.create(template, opts)`                                     | `sandboxes.create`. `base` and `code-interpreter-v1` are Runtime's stock image. Any other name must be a ready Runtime image with that name. A UUID is an image or a snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `timeoutMs` (Python `timeout`, seconds)                                                  | Left out, the sandbox has no time limit: it runs while it works and pauses itself when idle. Given, it is `timeoutSeconds`, rounded up. Under 60 s becomes 60 s, with a warning. Up to 24 hours, as on E2B: a Runtime time limit reaches at most an hour ahead, so while this process runs the adapter extends it every five minutes, never past the end asked for. If the process ends first, the sandbox ends at its last limit, at most an hour later. Over 24 hours throws `InvalidArgumentError`.                                                                                                  |
| `metadata`                                                                               | labels (at most 32).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `envs`                                                                                   | Given to every command and code run through this object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `allowInternetAccess: false`                                                             | `network: { internet: false }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lifecycle.onTimeout`                                                                    | `onLeaseEnd`: `kill` is `stop`, `pause` is `pause`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `commands.run(cmd, { cwd, envs, timeoutMs, onStdout, onStderr })`                        | A native process started by a streamed exec that reads it from the first byte, so Runtime holds a fast writer back rather than drop output: the result is whole, however long. The default command connection deadline is 60 s; `0` disables it. The process lives up to 24 hours, within the sandbox lease.                                                                                                                                                                                                                                                                                            |
| Non-zero exit                                                                            | Throws `CommandExitError` with `exitCode`, `stdout`, `stderr` and `error` (`exit status N`). A command killed by a signal has `exitCode` -1.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Command past its timeout                                                                 | Disconnects with `TimeoutError` (Python: `TimeoutException`) without killing the command; reconnect by pid to keep reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `commands.run(cmd, { background: true })`                                                | `spawn`. Returns a `CommandHandle` with `pid`, `wait()`, `kill()` (SIGKILL), `sendStdin`, `closeStdin`, `disconnect`, `stdout`, `stderr`, `exitCode`. Runtime keeps the last 1 MiB a process printed; anything older that was not read in time is lost, which sets `truncated` and warns. A command with `stdin: true` starts the same way.                                                                                                                                                                                                                                                             |
| `user` (commands, PTY and files)                                                         | Runs as that Linux user through `sudo -u`; `root` needs nothing more. A user the sandbox lacks throws `InvalidArgumentError` saying how to add one; none is ever created. `user: "user"` is the sandbox's own user. Watching a directory as another user is refused.                                                                                                                                                                                                                                                                                                                                    |
| `commands.list`, `kill(pid)`, `sendStdin(pid)`, `closeStdin(pid)`, `connect(pid)`        | Runtime's processes. A pid is a number derived from Runtime's process id, not the Linux pid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pty.create`, `connect`, `sendInput`, `resize`, `kill` (Python snake_case)               | Native PTY processes with lossless byte callbacks. A reader timeout or disconnect detaches without killing the process; reconnect resumes reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `files.read(path, { format })`                                                           | `files.read`. `text`, `bytes`, `blob` and `stream` (Python: `text`, `bytes`, `stream`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `files.write(path, data)`, `write([...])`, `writeFiles`                                  | `files.write`. Parent directories are made, and a file that exists is replaced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `files.list(path, { depth })`                                                            | `files.list`, hidden files included. `owner` and `group` come from native metadata, with `""` for older guests that omit them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `files.makeDir`, `exists`, `getInfo`, `rename`, `remove`                                 | `files.stat`, `mkdir`, `rename` (replacing a file that exists) and `remove` (recursive). A missing file throws `FileNotFoundError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Relative paths                                                                           | Resolved against the home directory, `/workspace` on Runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/home/user` (E2B's home)                                                                | The first time a path, `cwd` or command names it, it becomes a link to `/workspace`, unless something is already there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sandbox.kill()`, `Sandbox.kill(id)`                                                     | `stop`, without waiting. `false` when the sandbox was not found or had already ended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sandbox.setTimeout(ms)`, `Sandbox.setTimeout(id, ms)`                                   | `extend`: the end moves to now + ms, up to 24 hours (past an hour it is carried on as for `timeoutMs`). An earlier end is refused: Runtime cannot end a lease early. A sandbox with no time limit has no end to move, and nothing changes.                                                                                                                                                                                                                                                                                                                                                              |
| `Sandbox.connect(id, { timeoutMs })`, `sandbox.connect()`                                | `get`. A paused sandbox is woken. A running one's end moves later, never earlier, up to 24 hours. An ended one throws `SandboxNotFoundError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sandbox.pause()`, `betaPause`, `Sandbox.pause(id)`                                      | `pause`, keeping memory and files. `false` when it was already paused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `getInfo`, `isRunning`                                                                   | `get`. `templateId` is `base` or the image or snapshot id. `envdVersion` is `runtime`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Sandbox.list({ query: { metadata, state }, limit })`                                    | `sandboxes.list` by labels and state, oldest first, with E2B's paginator (`hasNext`, `nextItems()`, `nextToken`). A `template` or `startedAfter` filter, `order: "desc"` and a saved `nextToken` are applied by the adapter, which reads every match once and pages through them.                                                                                                                                                                                                                                                                                                                       |
| `fork`, `createSnapshot`, `deleteSnapshot`                                               | Runtime's memory-preserving forks and snapshots; deleting a snapshot removes that saved capture. A fork's `count` is 1 to 20, as E2B checks it.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getHost(port)`                                                                          | `<port>-<id>.runtimehost.com` at once, as E2B answers it, and the port is shared as a public Runtime preview beside the caller (the sync Python sandbox shares it before returning). `await sandbox.getPublicHost(port)` returns once the share has landed. On the free trial a shared port is private and a host alone cannot reach it, so both throw `PublicPreviewNotAllowedError` (Python: `PublicPreviewNotAllowedException`, a kind of `NotSupportedError`) at once. Use `(await sandbox.runtime.previews.create(port)).urlWithToken`, or send its token as the `x-runtime-preview-token` header. |
| `runCode(code, { language, context, onStdout, onStderr, onResult, onError, timeoutMs })` | Runtime's interpreter: Python, JavaScript, TypeScript, R, Java and Bash, plus Go. The sandbox's `envs` reach code through a context made once for them. `onResult` streams each result and waits for asynchronous callbacks.                                                                                                                                                                                                                                                                                                                                                                            |
| `Execution`, `Result`, `Logs`, `ExecutionError`, `OutputMessage`                         | The same shapes. Results that are too large to send inline are fetched and inlined. `logs.stdout` has one entry per line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `createCodeContext`, `listCodeContexts`, `restartCodeContext`, `removeCodeContext`       | Runtime's interpreter contexts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getMetrics({ start, end })`, `Sandbox.getMetrics(id)`                                   | Runtime's measured CPU and memory, one entry per host reading. `diskUsed` is null: Runtime does not read disk use inside the sandbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Error classes                                                                            | E2B's names and parents. Each also carries Runtime's `code`, `hint` and `requestId`, with the original error as `cause`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
has 2 vCPU and 512 MiB, lasts at most five minutes and is stopped when its
case ends. They are not part of `bun run test`.

```bash no-run
RUNTIME_API_KEY=... bun packages/cloud-sdk/scripts/e2b-e2e.ts   # the judge panel's E2B eval, JavaScript
RUNTIME_API_KEY=... python3 sdks/python/scripts/e2b_e2e.py        # the same cases in Python
```

Either one run with `--dry` sets up and shows the one-line change without
creating anything.
