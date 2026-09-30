# Code written for E2B, on Runtime

Run code written for [E2B](https://e2b.dev)'s SDK on Runtime Cloud by changing
one import. It is part of Runtime's SDK (`withruntime`), built on the same
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

The mapping was written against `e2b` 2.51.0 and `@e2b/code-interpreter`
2.8.0 (Python: `e2b` 2.51.0, `e2b-code-interpreter` 2.10.0), checked
29 September 2026. The exact package releases and artifact hashes are kept in
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
- **Funding:** left to Runtime, as `withruntime`'s own `create()` does. The
  free trial is used while the account has trial time, then prepaid credit.
  Pass `runtime: { create: { funding: "trial" } }` to use only the trial.
- **Anything else Runtime offers:** `runtime: { create: { ... } }` sends
  Runtime's create fields as they are, over the adapter's. `sandbox.runtime`
  is the Runtime sandbox underneath, with previews, network rules, desktop,
  processes and terminals.

## Mapping

| E2B                                                                                      | On Runtime                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox.create()`, `Sandbox.create(template, opts)`                                     | `sandboxes.create`. `base` and `code-interpreter-v1` are Runtime's stock image. Any other name must be a ready Runtime image with that name. A UUID is an image or a snapshot.                                                                              |
| `timeoutMs` (Python `timeout`, seconds)                                                  | `timeoutSeconds`, rounded up. Under 60 s becomes 60 s, with a warning. Over an hour is refused.                                                                                                                                                             |
| `metadata`                                                                               | labels (at most 32).                                                                                                                                                                                                                                        |
| `envs`                                                                                   | Given to every command and code run through this object.                                                                                                                                                                                                    |
| `allowInternetAccess: false`                                                             | `network: { internet: false }`.                                                                                                                                                                                                                             |
| `lifecycle.onTimeout`                                                                    | `onLeaseEnd`: `kill` is `stop`, `pause` is `pause`.                                                                                                                                                                                                         |
| `commands.run(cmd, { cwd, envs, timeoutMs, onStdout, onStderr })`                        | A native process with streamed output; output lost before it was read sets `truncated` and warns. The default command connection deadline is 60 s; `0` disables it. The sandbox lease still bounds the process.                                             |
| Non-zero exit                                                                            | Throws `CommandExitError` with `exitCode`, `stdout`, `stderr` and `error` (`exit status N`). A command killed by a signal has `exitCode` -1.                                                                                                                |
| Command past its timeout                                                                 | Disconnects with `TimeoutError` (Python: `TimeoutException`) without killing the command; reconnect by pid to keep reading.                                                                                                                                 |
| `commands.run(cmd, { background: true })`                                                | `spawn`. Returns a `CommandHandle` with `pid`, `wait()`, `kill()` (SIGKILL), `sendStdin`, `closeStdin`, `disconnect`, `stdout`, `stderr`, `exitCode`.                                                                                                       |
| `commands.list`, `kill(pid)`, `sendStdin(pid)`, `closeStdin(pid)`, `connect(pid)`        | Runtime's processes. A pid is a number derived from Runtime's process id, not the Linux pid.                                                                                                                                                                |
| `files.read(path, { format })`                                                           | `files.read`. `text`, `bytes`, `blob` and `stream` (Python: `text`, `bytes`, `stream`).                                                                                                                                                                     |
| `files.write(path, data)`, `write([...])`, `writeFiles`                                  | `files.write`. Parent directories are made, and a file that exists is replaced.                                                                                                                                                                             |
| `files.list(path, { depth })`                                                            | `files.list`, hidden files included. `owner` and `group` come from native metadata, with `""` for older guests that omit them.                                                                                                                              |
| `files.makeDir`, `exists`, `getInfo`, `rename`, `remove`                                 | `files.stat`, `mkdir`, `rename` (replacing a file that exists) and `remove` (recursive). A missing file throws `FileNotFoundError`.                                                                                                                         |
| Relative paths                                                                           | Resolved against the home directory, `/workspace` on Runtime.                                                                                                                                                                                               |
| `/home/user` (E2B's home)                                                                | The first time a path, `cwd` or command names it, it becomes a link to `/workspace`, unless something is already there.                                                                                                                                     |
| `sandbox.kill()`, `Sandbox.kill(id)`                                                     | `stop`, without waiting. `false` when the sandbox was not found or had already ended.                                                                                                                                                                       |
| `sandbox.setTimeout(ms)`, `Sandbox.setTimeout(id, ms)`                                   | `extend`: the end moves to now + ms. Moving it earlier is refused.                                                                                                                                                                                          |
| `Sandbox.connect(id, { timeoutMs })`, `sandbox.connect()`                                | `get`. A paused sandbox is woken. A running one's end moves later, never earlier. An ended one throws `SandboxNotFoundError`.                                                                                                                               |
| `sandbox.pause()`, `betaPause`, `Sandbox.pause(id)`                                      | `pause`, keeping memory and files. `false` when it was already paused.                                                                                                                                                                                      |
| `getInfo`, `isRunning`                                                                   | `get`. `templateId` is `base` or the image or snapshot id. `envdVersion` is `runtime`.                                                                                                                                                                      |
| `Sandbox.list({ query: { metadata, state }, limit })`                                    | `sandboxes.list` by labels and state, oldest first, with E2B's paginator (`hasNext`, `nextItems()`).                                                                                                                                                        |
| `fork`, `createSnapshot`, `deleteSnapshot`                                               | Runtime's forks and snapshots. While Runtime has them switched off, they throw `NotSupportedError` with Runtime's own message.                                                                                                                              |
| `getHost(port)`                                                                          | `<port>-<id>.runtimehost.com` at once, as E2B answers it, and the port is shared as a public Runtime preview beside the caller (the sync Python sandbox shares it before returning). `await sandbox.getPublicHost(port)` returns once the share has landed. |
| `runCode(code, { language, context, onStdout, onStderr, onResult, onError, timeoutMs })` | Runtime's interpreter: Python, JavaScript, TypeScript, R, Java and Bash, plus Go. The sandbox's `envs` reach code through a context made once for them. `onResult` streams each result and waits for asynchronous callbacks.                                |
| `Execution`, `Result`, `Logs`, `ExecutionError`, `OutputMessage`                         | The same shapes. Results that are too large to send inline are fetched and inlined. `logs.stdout` has one entry per line.                                                                                                                                   |
| `createCodeContext`, `listCodeContexts`, `restartCodeContext`, `removeCodeContext`       | Runtime's interpreter contexts.                                                                                                                                                                                                                             |
| `getMetrics({ start, end })`, `Sandbox.getMetrics(id)`                                   | Runtime's measured CPU and memory, one entry per host reading (every minute by default). `diskUsed` is null: Runtime does not read disk use inside the sandbox.                                                                                             |
| Error classes                                                                            | E2B's names and parents. Each also carries Runtime's `code`, `hint` and `requestId`, with the original error as `cause`.                                                                                                                                    |

## Gaps

Each of these throws `NotSupportedError` (Python: `NotSupportedException`)
before anything happens. The error's `feature` names the gap and its
`alternative` says what to use.

| E2B                                                                                          | Use instead                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| An E2B template name with no Runtime image of that name                                      | Build it: `npx withruntime image build --dockerfile e2b.Dockerfile --name <template>`. This throws `TemplateError`. |
| `Template`, `waitForPort` and the other ready checks                                         | `runtime.images.build(...)`                                                                                         |
| `timeoutMs` over one hour                                                                    | Create with up to an hour, then call `setTimeout` before it ends, as often as needed.                               |
| `setTimeout` to an earlier time                                                              | `kill()` when the work is done.                                                                                     |
| `keepMemory: false`                                                                          | Runtime's pause keeps memory.                                                                                       |
| `onResume: "reboot"`                                                                         | Stop the sandbox and create a new one.                                                                              |
| `fork({ timeoutMs })`                                                                        | Fork without it, then call `setTimeout` on each fork.                                                               |
| `user: "root"` (commands and files)                                                          | Prefix the command with `sudo`, which needs no password.                                                            |
| `network`, `updateNetwork`                                                                   | `runtime: { create: { network } }` and `sandbox.runtime.network.set(...)`.                                          |
| `mcp`, `getMcpUrl`, `getMcpToken`                                                            | Runtime's own MCP server, `npx withruntime mcp`.                                                                    |
| `iam`, `Secret`                                                                              | A Runtime secret (`npx withruntime secrets set NAME --host <host>`): the sandbox sees a placeholder.                |
| `volumeMounts`, `Volume`                                                                     | Runtime volumes: `runtime: { create: { volumes: [{ volumeId, path }] } }`.                                          |
| `pty`                                                                                        | `sandbox.runtime.terminal(...)`.                                                                                    |
| `git`                                                                                        | `commands.run("git ...")`. E2B has deprecated its git module too.                                                   |
| File `metadata`                                                                              | Keep it in a file beside the data.                                                                                  |
| `uploadUrl`, `downloadUrl`                                                                   | `files.write` and `files.read`.                                                                                     |
| `Sandbox.list` by `template` or `startedAfter`, `order: "desc"`, or from a saved `nextToken` | Filter by metadata, and keep the paginator.                                                                         |
| `runCode(code, { envs })`                                                                    | A context made with them: `sandbox.runtime.interpreter.contexts.create({ env })`.                                   |
| `domain`, `apiUrl`, `sandboxUrl`, `headers`, `proxy`, `debug`                                | Remove them. `RUNTIME_API_URL` sets Runtime's origin, and `HTTPS_PROXY` sets a proxy.                               |

Directory watches use Runtime's native watch stream. JavaScript uses
`files.watchDir(path, onEvent, options)`. Python's synchronous `watch_dir(path)`
returns a handle with `get_new_events()` and `stop()`; asynchronous
`watch_dir(path, on_event, on_exit=...)` delivers callbacks. Stop is safe inside
a callback. Stream failures and lost events are reported, never treated as a
successful empty watch. A positive watch timeout bounds the client subscription and stops its owned watch;
zero leaves the subscription unlimited. The sandbox lease still applies. Both languages refuse watching network mounts.

Some differences are not refusals, so code that depends on them should check:

- Sandbox-level `envs` live in the object that created the sandbox.
  `Sandbox.connect(id)` from another process does not know them.
- Runtime's stock image is Ubuntu 24.04 with Python 3.12, Node.js 24 and Bun.
  The current stock image includes NumPy, pandas and matplotlib; build an image
  for additional dependencies. Results never carry `chart`. A DataFrame arrives in
  `extra` under `application/vnd.runtime.table+json`, not in E2B's `data`.
- JavaScript file operations and command creation honor `requestTimeoutMs`.
  Python file `request_timeout` bounds the request, including streamed reads. `retries`, `logger`, `secure` and `validateApiKey` are
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
