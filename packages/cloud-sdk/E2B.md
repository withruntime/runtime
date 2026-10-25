# Code written for E2B, on Runtime

Supported sandbox calls from [E2B](https://e2b.dev)'s SDK keep their call shapes
on Runtime Cloud after you change the import. This is part of Runtime's SDK
(`withruntime`). It uses the same client, so it gets that SDK's retries,
idempotency keys and errors. Importing `withruntime` alone does not load it.

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

The mapping was written against `e2b` 2.51.0. It was checked against `e2b`
2.56.0 and `@e2b/code-interpreter` 2.9.0 on 15 October 2026. Python was checked
against `e2b` 2.56.0 and `e2b-code-interpreter` 2.11.0 the same day. The exact
package releases and artifact hashes are kept in `compatibility-lock.json`.

## Keys

The package uses these keys, in this order:

1. An `apiKey` that you pass.
2. `RUNTIME_API_KEY`.
3. A Runtime key left in `E2B_API_KEY`.
4. The key that `npx withruntime login` saved on this machine.

An E2B key (`e2b_...`) is never sent anywhere. If one is passed as `apiKey`, or
left in `E2B_API_KEY`, and `RUNTIME_API_KEY` is not set, the call fails. It
throws `AuthenticationError` (Python: `AuthenticationException`) and says why. It
does not fall back to a saved login. That login may belong to another account.

If `RUNTIME_API_KEY` and `E2B_API_KEY` hold two different Runtime keys, a warning
says so once (`RUNTIME_E2B_TWO_KEYS`; Python: a `RuntimeWarning`). The two keys
may belong to two accounts. A template with no image of its name fails. The
error names the account the key belongs to, and where the key came from.

E2B's client works the same way. `new E2B({ apiKey }).Sandbox` (Python:
`E2B(api_key=...).Sandbox` and `.AsyncSandbox`) uses that key, unless a call
names its own. The code interpreter's `E2B` gives its own `Sandbox`. The
client's `Template`, `Volume` and `Secret` (Python: and their `Async` forms) are
refused, as the top-level ones are. The error names the alternative. See
"Gaps" below.

## What a sandbox gets

- **Machine:** E2B's default, 2 vCPU and 512 MiB. For a different size, pass
  `runtime: { create: { memoryMiB: 4096 } }` (Python:
  `runtime_create={"memory_mib": 4096}`).
- **Timeout:** Runtime's server keeps the timeout. A timer in your process does
  not. So the timeout still applies after the process that made the sandbox
  exits. A `timeoutMs` you give (Python `timeout`, in seconds) deletes the
  sandbox when it runs out, as E2B kills it. The limit can be up to 24 hours.
  `lifecycle: { onTimeout: "kill" }` does the same. With no timeout, E2B's
  default of 300 seconds applies. When that runs out, the sandbox **pauses**
  instead. Nobody asked for it to end, so nothing is lost. The next call wakes
  it. E2B deletes it at that point. `lifecycle: { onTimeout: "pause" }` pauses
  the sandbox at any timeout.
- **What a pause keeps, and what it costs:** memory, files and running
  processes. It keeps them for as long as the account has credit. It is billed
  as paused storage, by the GB per month, for what the sandbox alone holds
  (`pricing.md`, "Paused storage"). Sandboxes that have no timeout and are never
  killed pile up as paused storage. Call `kill()` when the work is done, or give
  a `timeoutMs`.
- **On a pilot account:** the server keeps every sandbox running until you end
  it. There is no idle pause, whatever `timeoutMs` says. The machine size is set
  by the pilot. `kill()` deletes the sandbox.
- **Kill:** `kill()` deletes the sandbox for good, as E2B's does. Its disk,
  memory and shared ports are removed. It no longer counts against the account's
  sandboxes.
- **Idle pause:** this is Runtime's default. E2B does not have it. After 60
  seconds with nothing happening in the sandbox (no request, running command,
  open connection, traffic or CPU use), the sandbox pauses. Its memory is kept.
  The next command or file call wakes it. To code written for E2B, the sandbox is
  still running. `isRunning()` returns `true`. `getInfo()` says `running`. And
  `list({ query: { state: ["running"] } })` includes it. To keep it running, as
  on E2B, pass `runtime: { create: { idlePauseSeconds: 0 } }` (Python:
  `runtime_create={"idle_pause_seconds": 0}`).
- **Connections:** one client per key holds up to 4,096 connections to the API
  at once. That is the most Runtime's edge gives an address that has used a
  valid key. E2B's SDK holds no calls back, and neither does this one. A thousand
  commands at once from one process all run at once. Past an account's limit,
  the API answers with a retry, which the client waits out. If calls wait for a
  connection, a warning says so once (`RUNTIME_E2B_QUEUED`). Runtime's own SDK
  keeps 48. To set your own limit, pass your own client with
  `runtime: { client: new Runtime({ maxConnections }) }` (Python:
  `client=Runtime(max_connections=...)`).
- **Funding:** left to Runtime, as `withruntime`'s own `create()` does. The free
  trial is used while the account has trial time. After that, prepaid credit is
  used. Pass `runtime: { create: { funding: "trial" } }` to use only the trial.
- **Anything else Runtime offers:** `runtime: { create: { ... } }` sends Runtime's
  create fields as they are, over the adapter's own. `sandbox.runtime` is the
  Runtime sandbox underneath. It has previews, network rules, desktop, processes
  and terminals.

## Mapping

| E2B                                                                                      | On Runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox.create()`, `Sandbox.create(template, opts)`                                     | `sandboxes.create`. `base` and `code-interpreter-v1` are Runtime's stock image. Any other name, with its `:tag`, is a Runtime image with that name. The create call resolves it. E2B's `team/` prefix is dropped, because an account's images belong to that account. A UUID is an image or a snapshot. A name that no image has throws `TemplateError`, which says how to build it.                                                                                                                                                                                                                            |
| `timeoutMs` (Python `timeout`, seconds)                                                  | `timeoutSeconds`, rounded up. The server keeps it, with `onTimeout: "delete"`. If left out, 300 s applies, with `onTimeout: "pause"`. Under 60 s becomes 60 s, with a warning. The limit can be up to 24 hours, as on E2B. A longer value throws `InvalidArgumentError`.                                                                                                                                                                                                                                                                                                                                        |
| `metadata`                                                                               | Labels (at most 32).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `envs`                                                                                   | Given to every command and code run through this object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `allowInternetAccess: false`                                                             | `network: { internet: false }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lifecycle.onTimeout`                                                                    | `onTimeout`: `kill` maps to `delete`, and `pause` maps to `pause`. `{ action: "pause", mode: "full" }` maps to `pause`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `commands.run(cmd, { cwd, envs, timeoutMs, onStdout, onStderr })`                        | A native process, started by a streamed exec. It reads the output from the first byte. Runtime holds back a fast writer, so output is not dropped. The result is complete, however long the command runs. The default command connection deadline is 60 s. `0` turns it off. The process lives up to 24 hours, within the sandbox lease.                                                                                                                                                                                                                                                                        |
| Non-zero exit                                                                            | Throws `CommandExitError` with `exitCode`, `stdout`, `stderr` and `error` (`exit status N`). A command stopped by a signal has `exitCode` -1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Command past its timeout                                                                 | Disconnects with `TimeoutError` (Python: `TimeoutException`). The command keeps running. Reconnect by pid to keep reading. If a JavaScript command's sandbox is killed while it runs, it throws `SandboxNotRunningError`. That is a `TimeoutError`, and it says the sandbox was killed or reached its end of life.                                                                                                                                                                                                                                                                                              |
| `commands.run(cmd, { background: true })`                                                | `spawn`. Returns a `CommandHandle` with `pid`, `wait()`, `kill()` (SIGKILL), `sendStdin`, `closeStdin`, `disconnect`, `stdout`, `stderr` and `exitCode`. Runtime keeps the last 1 MiB that a process printed. Older output that was not read in time is lost. That sets `truncated` and gives a warning. A command with `stdin: true` starts the same way.                                                                                                                                                                                                                                                      |
| `user` (commands, PTY and files)                                                         | Runs as that Linux user, through `sudo -u`. `root` needs nothing more. If the sandbox lacks the user, it throws `InvalidArgumentError`, which says how to add one. Runtime never creates a user. `user: "user"` is the sandbox's own user. Watching a directory as another user is refused.                                                                                                                                                                                                                                                                                                                     |
| `commands.list`, `kill(pid)`, `sendStdin(pid)`, `closeStdin(pid)`, `connect(pid)`        | Runtime's processes. A pid is a number derived from Runtime's process id. It is not the Linux pid. `commands.list` shows each command as E2B starts it: `cmd` is `/bin/bash`, and `args` is `["-l", "-c", "<your command>"]` (a PTY uses `["-i", "-l"]`). The command is cut at 256 characters. `envs` is empty.                                                                                                                                                                                                                                                                                                |
| `pty.create`, `connect`, `sendInput`, `resize`, `kill` (Python snake_case)               | Native PTY processes with lossless byte callbacks. If a reader times out or disconnects, it detaches without killing the process. Reconnect to resume reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `files.read(path, { format })`                                                           | `files.read`. Formats: `text`, `bytes`, `blob` and `stream` (Python: `text`, `bytes` and `stream`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `downloadUrl(path, opts)`, `uploadUrl(path, opts)`                                       | `files.downloadUrl` and `files.uploadUrl`. Each returns a signed link as a string. Anyone can open the link with no key. `useSignatureExpiration` is in seconds: 60 seconds to 7 days, with one hour by default. `user` is ignored. `uploadUrl()` needs a `path`, because a link names one file.                                                                                                                                                                                                                                                                                                                |
| `files.write(path, data)`, `write([...])`, `writeFiles`                                  | `files.write`. Parent directories are created. A file that exists is replaced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `files.list(path, { depth })`                                                            | `files.list`. Hidden files are included. `owner` and `group` come from native metadata. Older guests that omit them return `""`. A `depth` below one throws `InvalidArgumentError`: "depth should be at least one".                                                                                                                                                                                                                                                                                                                                                                                             |
| `files.makeDir`, `exists`, `getInfo`, `rename`, `remove`                                 | `files.stat`, `mkdir`, `rename` (replaces a file that exists) and `remove` (recursive). A missing file throws `FileNotFoundError`. Entries look the way envd returns them. `permissions` starts with the letter for the kind (`-rw-r--r--`, `drwxr-xr-x`, or `L` for a link). The sandbox user is `user`. A link's `symlinkTarget` is absolute.                                                                                                                                                                                                                                                                 |
| Relative paths                                                                           | Resolved against the home directory, which is `/workspace` on Runtime. Returned under `/home/user`, as E2B returns them. `write("a.txt")` returns `/home/user/a.txt`. A full path comes back as given. `pwd` in a command prints `/workspace`.                                                                                                                                                                                                                                                                                                                                                                  |
| `/home/user` (E2B's home)                                                                | The first time a path, `cwd` or command names it, it becomes a link to `/workspace`. This does not happen if something is already there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sandbox.kill()`, `Sandbox.kill(id)`                                                     | `delete`. The sandbox is gone for good. Returns `false` when the sandbox was not found or was already deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sandbox.setTimeout(ms)`, `Sandbox.setTimeout(id, ms)`                                   | The time limit becomes now plus ms. It can move sooner or later than before, up to 24 hours. This is an update's `timeoutSeconds`. Under a minute is treated as a minute. The end still does what the sandbox was created to do. A sandbox with no time limit gets one. A persistent sandbox (a pilot's) has no limit to set, so nothing changes.                                                                                                                                                                                                                                                               |
| `Sandbox.connect(id, { timeoutMs })`, `sandbox.connect()`                                | `get`. A paused sandbox is woken. A running sandbox's end moves later, never earlier, up to 24 hours. An ended sandbox throws `SandboxNotFoundError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sandbox.pause()`, `betaPause`, `Sandbox.pause(id)`                                      | `pause`. Memory and files are kept. Returns `false` when the sandbox was already paused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `getInfo`, `isRunning`                                                                   | `get`. `templateId` is the template the sandbox was created from, as you named it. It is kept in the label `e2b-template`, which `metadata` leaves out. Otherwise it is `base`. `envdVersion` is `runtime`. A sandbox that Runtime paused for being idle is `running`. `endAt` is when the sandbox ends by itself. A sandbox that never ends (no time limit, as on a pilot account) shows 24 hours ahead, the furthest E2B allows.                                                                                                                                                                              |
| `Sandbox.list({ query: { metadata, state }, limit })`                                    | `sandboxes.list`, filtered by labels and state. Oldest first. It uses E2B's paginator (`hasNext`, `nextItems()`, `nextToken`). The adapter applies a `template` or `startedAfter` filter, `order: "desc"`, and a saved `nextToken`. It reads every match once, then pages through them.                                                                                                                                                                                                                                                                                                                         |
| `fork`, `createSnapshot`, `deleteSnapshot`                                               | Runtime's forks and snapshots keep memory. `createSnapshot({ mode: "filesystem" })` makes a disk snapshot. A sandbox boots from it again. Deleting a snapshot removes that saved capture. A fork's `count` is 1 to 20, as E2B checks it.                                                                                                                                                                                                                                                                                                                                                                        |
| `getHost(port)`                                                                          | Returns `<port>-<id>.runtimehost.com` at once, as E2B does. The port is also shared as a public Runtime preview next to the caller. The sync Python sandbox shares it before it returns. `await sandbox.getPublicHost(port)` returns once the share is done. On the free trial, a shared port is private, and a host name alone cannot reach it. So both throw `PublicPreviewNotAllowedError` (Python: `PublicPreviewNotAllowedException`, a kind of `NotSupportedError`) at once. Use `(await sandbox.runtime.previews.create(port)).urlWithToken`, or send its token in the `x-runtime-preview-token` header. |
| `runCode(code, { language, context, onStdout, onStderr, onResult, onError, timeoutMs })` | Runtime's interpreter. It supports Python, JavaScript, TypeScript, R, Java and Bash, and Go. The sandbox's `envs` reach the code through a context that is made once for them. `onResult` streams each result. It waits for asynchronous callbacks.                                                                                                                                                                                                                                                                                                                                                             |
| `Execution`, `Result`, `Logs`, `ExecutionError`, `OutputMessage`                         | The same shapes. Results too large to send inline are fetched, then inlined. `logs.stdout` has one entry per line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `createCodeContext`, `listCodeContexts`, `restartCodeContext`, `removeCodeContext`       | Runtime's interpreter contexts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `getMetrics({ start, end })`, `Sandbox.getMetrics(id)`                                   | Runtime's measured CPU and memory, one entry per host reading. `diskUsed` is null. Runtime does not read disk use inside the sandbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Error classes and other exports                                                          | Every name that `e2b` and the code interpreter export is imported. Errors keep E2B's names and parent classes. Python also imports each name from the module where E2B defines it. So `from e2b.exceptions import TimeoutException` becomes `from withruntime.e2b.exceptions import TimeoutException`. `WriteEntry` comes from `withruntime.e2b.sandbox.filesystem.filesystem`. Each error also carries Runtime's `code`, `hint` and `requestId`. The original error is the `cause`.                                                                                                                            |

## Gaps

Each of these throws `NotSupportedError` (Python: `NotSupportedException`)
before anything happens. The error's `feature` names the gap. Its `alternative`
says what to use instead.

| E2B                                                           | Use instead                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| An E2B template name with no Runtime image of that name       | Build it: `npx withruntime images build --dockerfile e2b.Dockerfile --name <template>`. Without it, this throws `TemplateError`. |
| `Template`, `waitForPort` and the other ready checks          | `runtime.images.build(...)`                                                                                                      |
| A pause with `mode: "filesystem"` or `keepMemory: false`      | Runtime's pause keeps memory. For the files alone, use `createSnapshot({ mode: "filesystem" })`.                                 |
| `onResume: "reboot"`                                          | Stop the sandbox, and create a new one.                                                                                          |
| `fork({ timeoutMs })`                                         | Fork without it, then call `setTimeout` on each fork.                                                                            |
| `network`, `updateNetwork`                                    | `runtime: { create: { network } }` and `sandbox.runtime.network.set(...)`.                                                       |
| `mcp`, `getMcpUrl`, `getMcpToken`                             | Runtime's own MCP server: `npx withruntime mcp`.                                                                                 |
| `iam`, `Secret`                                               | A Runtime secret (`npx withruntime secrets set NAME --host <host>`). The sandbox sees a placeholder.                             |
| `volumeMounts`, `Volume`                                      | Runtime volumes: `runtime: { create: { volumes: [{ volumeId, path }] } }`.                                                       |
| `git`                                                         | `commands.run("git ...")`. E2B has deprecated its git module too.                                                                |
| File `metadata`                                               | Keep it in a file beside the data.                                                                                               |
| `runCode(code, { envs })`                                     | A context made with them: `sandbox.runtime.interpreter.contexts.create({ env })`.                                                |
| `new E2B(opts).Template`, `.Secret`, `.Volume`                | As for `Template`, `Secret` and `Volume` above. Each throws `NotSupportedError` and names the alternative.                       |
| `domain`, `apiUrl`, `sandboxUrl`, `headers`, `proxy`, `debug` | Remove them. `RUNTIME_API_URL` sets Runtime's origin. `HTTPS_PROXY` sets a proxy.                                                |

Directory watches use Runtime's native watch stream. In JavaScript, use
`files.watchDir(path, onEvent, options)`. In Python, the synchronous
`watch_dir(path)` returns a handle with `get_new_events()` and `stop()`. The
asynchronous `watch_dir(path, on_event, on_exit=...)` delivers callbacks. Calling
stop inside a callback is safe. Stream failures and lost events are reported.
They are never treated as a successful empty watch. A positive watch timeout
limits the client subscription, and stops the watch the subscription owns. Zero
means the subscription has no limit. The sandbox lease still applies. Both
languages refuse to watch network mounts. As on envd, a path that is a file is
refused with `InvalidArgumentError` (Python: `InvalidArgumentException`). Runtime
writes a file whole, by renaming it into place. Its watch sees that as a create.
So a file's create is followed by a write event. E2B code that waits for the
write receives it.

PTY `timeoutMs` (Python `timeout`, in seconds) defaults to 60 seconds. That
includes the opening handshake. Zero leaves the reader unlimited. Callbacks
receive raw bytes. The handle's `stdout` and `stderr` stay empty. PTYs made
before lossless output support cannot reconnect through this adapter. Create a
new one instead. The sandbox lease still applies.

Some differences are not refusals. Code that depends on them should check:

- Runtime's stock image is Ubuntu 24.04, with Python 3.12, Node.js 24 and Bun.
  The current stock image includes NumPy, pandas and matplotlib. Build an image
  for other dependencies. Results never carry `chart`. A DataFrame arrives in
  `extra`, under `application/vnd.runtime.table+json`. It does not arrive in
  E2B's `data`.
- JavaScript file operations, command creation and reads, stdin and EOF, lookup,
  kill and reconnect honor `requestTimeoutMs` and `signal`. Python's file
  `request_timeout` bounds the request, including streamed reads. `retries`,
  `logger`, `secure`, `validateApiKey` and `httpVersion` (Python `http_version`,
  which is `'1.1'` or `'2'`, as E2B checks it) are accepted. They do not change
  the native transport settings.
- Interpreter deadlines follow the pinned packages. JavaScript defaults to 60
  seconds, and Python to five minutes. Zero turns off the read deadline. A client
  timeout detaches the reader without stopping the cell. The sandbox lease still
  applies.

## Tests

`bun run test` in `packages/cloud-sdk` runs the unit tests for both languages.
They run against fakes of Runtime's SDKs. They cover every call in the mapping,
and every refusal. The tests are `tests/e2b` here, and
`sdks/python/tests/test_e2b_*.py`.

The end-to-end tests run an unmodified E2B program against the real API, with its
one import changed. They create six sandboxes on the key's account. Each one has
2 vCPU and 512 MiB. Each lasts at most five minutes, and is deleted when its case
ends. These tests are not part of `bun run test`.

```bash no-run
RUNTIME_API_KEY=... bun packages/cloud-sdk/scripts/e2b-e2e.ts   # the judge panel's E2B eval, JavaScript
RUNTIME_API_KEY=... python3 sdks/python/scripts/e2b_e2e.py        # the same cases in Python
```

Either one, run with `--dry`, sets up and shows the one-line change. It creates
nothing.

## JavaScript qualification, 6 October 2026

We reviewed the published npm tarballs for `e2b` 2.52.1 to 2.53.1, and
`@e2b/code-interpreter` 2.8.0 to 2.8.2. Both new versions were npm's latest when
checked. All four downloaded tarballs matched their registry SHA-512 integrity
values. The new values are in `compatibility-lock.json` and the oracle's
`bun.lock`. No package code was run during the source review.

Each package changed its manifest and six distribution files. These are CommonJS
and ES-module JavaScript, their source maps, and both declaration formats. The
source maps contain the TypeScript sources. No separate `src` directory ships.
CommonJS and ES-module source contents match. Ten E2B source files and three
interpreter source files changed. These are the changes, and how each one is
handled:

| Upstream change                                                                                                                                                                                                                                                                       | Drop-in disposition                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxNotRunningError` and `SandboxUnreachableError`, exported by E2B and re-exported by the interpreter. Both extend `TimeoutError` and accept `ErrorOptions.cause`.                                                                                                               | Mirrored. Both imports, names, parent classes, constructor signatures and causes match. Runtime's explicit `sandbox_stopped`, `sandbox_paused` and `sandbox_not_running` codes select the first. `sandbox_not_ready` and `host_unavailable` select the second.                                                                                                                                                       |
| HTTP 502 and RPC Unavailable tell a stopped sandbox apart from an unreachable one. Failed connections and unclear stream errors use a health probe. Browser network failures are recognized too. Process and watch startup no longer replace Unavailable with `SandboxNotFoundError`. | Mirrored through Runtime's explicit state codes. These cover the command, file, watch and interpreter guards. A command that loses its sandbox now throws `SandboxNotRunningError`. E2B's envd health probes, proxy message matching and RPC parsing are not copied, because Runtime uses its own API. A connection failure that cannot be classified does not establish sandbox state. It keeps its existing error. |
| Streaming RPCs keep a plain-text or JSON proxy 502 message. Recognized Connect error codes keep their meaning. HTTP error-body extraction is shared with the health probe.                                                                                                            | Not mirrored. E2B's proxy and Connect transport are not used. Runtime's structured code, message, hint, request ID and original cause stay available.                                                                                                                                                                                                                                                                |
| Removed `E2B_USER_AGENT_SOURCE`, `ConnectionConfig.requestSource`, user-agent source suffixes, automatic CI error logging and trace-ID diagnostics. Logger middleware now returns the request and the response.                                                                       | Not mirrored. Runtime never implemented those E2B transport diagnostics. `ConnectionConfig` and `ApiClient` stay unsupported.                                                                                                                                                                                                                                                                                        |
| Create, connect and fork share a response mapper and a private response type. The protected return annotations allow optional transport fields.                                                                                                                                       | Not mirrored. This refactors E2B's transport response, without changing public Sandbox behavior. Runtime builds its own sandbox objects.                                                                                                                                                                                                                                                                             |
| Interpreter errors include a non-empty, trimmed response body for generic HTTP failures. There is no CI-only switch or trace suffix. 404 and 502 keep their previous classes.                                                                                                         | Already preserved. Runtime translates its structured API errors, including the message, hint and request ID. E2B's private Jupyter HTTP formatter and status-line wording are not used.                                                                                                                                                                                                                              |
| Interpreter request URLs no longer add the traffic-source query. Private diagnostic helpers disappear from the declarations.                                                                                                                                                          | Not mirrored. Runtime does not send requests to E2B's Jupyter endpoints, and does not add that query.                                                                                                                                                                                                                                                                                                                |
| Interpreter streaming uses one UTF-8 decoder across chunks, and flushes it at EOF.                                                                                                                                                                                                    | Already matched by Runtime's `TextDecoderStream`. A `runCode` test sends every byte separately. That includes two-, three- and four-byte characters, and a final line with no newline. Callbacks and final results keep the text.                                                                                                                                                                                    |
| The interpreter dependency rises from `e2b ^2.48.0` to `^2.53.1`. Package versions and build metadata advance.                                                                                                                                                                        | The oracle pins both exact releases. No other public exports, caller options, defaults or method signatures changed.                                                                                                                                                                                                                                                                                                 |

`tests/e2b/exports.test.ts` checks both import surfaces, constructor causes and
Runtime error translation. `tests/e2b/sandbox.test.ts` checks the error when a
running command loses its sandbox. `tests/e2b/code-interpreter.test.ts` runs the
real native transport beneath `runCode`, with in-memory HTTP replies. That
includes split UTF-8 and server failures, with no replay. These fixtures do not
establish live-host behavior, isolation, recovery, performance superiority, or
full E2B compatibility. The provider stays marked `partial`.

## e2b 2.55.0, 9 October 2026

We reviewed the published npm tarballs for `e2b` 2.53.1 to 2.55.0, and
`@e2b/code-interpreter` 2.8.2 to 2.8.3. We also reviewed the PyPI wheels and
sdists for `e2b` 2.53.1, 2.55.0 and 2.55.1, and `e2b-code-interpreter` 2.10.3,
2.10.4 and 2.10.5. Each was the latest on npm or PyPI when checked. Every pinned
file matched the hash already in `compatibility-lock.json`. Every new file matched
its registry's SHA-512 integrity or SHA-256 digest. Each wheel's Python source is
byte for byte its sdist's. Nothing was installed, imported or run. JavaScript
sources were read from the source maps, which carry the TypeScript. Nine `e2b`
source files changed, one was removed, and one interpreter file changed.

| Upstream change                                                                                                                                                                                                                                                                                                                               | Drop-in disposition                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pause`, `betaPause`, `createSnapshot` and `lifecycle.onTimeout` take `mode: "full" \| "filesystem"` (Python `mode=`, keyword-only). `keepMemory` (`keep_memory`) is deprecated. Both at once, an unknown mode, or a mode on `action: "kill"` throws `InvalidArgumentError`. `SnapshotMode` is exported.                                      | Followed, in both languages. `createSnapshot({ mode: "filesystem" })` takes a Runtime disk snapshot. `"full"` takes the whole machine. A pause with `"filesystem"` throws `NotSupportedError`, as `keepMemory: false` did, and the error names the disk snapshot. `"full"` pauses. The same `InvalidArgumentError`s apply, with E2B's messages. Until now a `mode` was ignored. A pause that asked to drop memory kept it. |
| `DockerfileSyntaxError` is exported. It comes from the new `@e2b/dockerfile-utils` (npm) and `e2b-dockerfile-utils` (PyPI) 0.1.0 packages. It is a plain `Error` (Python `ValueError`) with `line`. The template builder's Dockerfile and `.dockerignore` parsing moves into that package, replacing `dockerfile-ast` and `dockerfile-parse`. | Exported with E2B's parent, message and `line`. It is also exported from `e2b.template.dockerfile_parser`. Templates stay refused, and the error names `npx withruntime images build`. So nothing throws it.                                                                                                                                                                                                               |
| Template `copy` and `makeDir` keep `mode: 0` instead of dropping it.                                                                                                                                                                                                                                                                          | Not mirrored. Templates are refused.                                                                                                                                                                                                                                                                                                                                                                                       |
| A file entry for a symlink is `FileType.SYMLINK` when newer envd reports the target's type with an `isSymlink` flag.                                                                                                                                                                                                                          | Already matched. Runtime's listing marks the link itself as `symlink`.                                                                                                                                                                                                                                                                                                                                                     |
| Python's command stream decodes empty output chunks, instead of skipping them. It still yields only non-empty text. A JavaScript comment is removed.                                                                                                                                                                                          | No change in what a caller sees. Runtime's own stream is used.                                                                                                                                                                                                                                                                                                                                                             |
| The interpreter builds its Jupyter address with `getSandboxUrl` (Python `get_sandbox_url(port=)`, added in `e2b` 2.55.1), instead of a direct URL. Interpreter dependencies rise to `e2b ^2.55.0` (Python `>=2.55.1`).                                                                                                                        | Not mirrored. Runtime does not call E2B's Jupyter endpoints. The oracle and the Python contract requirements pin the exact releases. `@e2b/dockerfile-utils` and `e2b-dockerfile-utils` 0.1.0 replace the parsers.                                                                                                                                                                                                         |
| API documentation: `team_id` may be a `prj_` project ID. `secret_limit_reached` is a listed error code.                                                                                                                                                                                                                                       | Not used by the drop-in.                                                                                                                                                                                                                                                                                                                                                                                                   |

`tests/e2b/e2b-2-55.test.ts` and `sdks/python/tests/test_e2b_2_55.py` check the
modes, the refusals, their messages and the new exports. They fail without this
change. The official differential contracts were not run against the new
releases, because they run E2B's code. The provider stays marked `partial`.

## e2b 2.56.0, 15 October 2026

We reviewed the published npm tarballs for `e2b` 2.55.0 to 2.56.0, and
`@e2b/code-interpreter` 2.8.3 to 2.9.0. We also reviewed the PyPI wheels and
sdists for `e2b` 2.55.1 to 2.56.0, and `e2b-code-interpreter` 2.10.5 to 2.11.0.
Each was the latest on npm or PyPI when checked. Every pinned file matched the
hash already in `compatibility-lock.json`. Every new file matched its registry's
SHA-512 integrity or SHA-256 digest. Each wheel's Python source is byte for byte
its sdist's. Nothing was installed, imported or run for the review. JavaScript
sources were read from the source maps. The declarations (`index.d.ts`) of both
npm packages, and the `__init__.py` of both Python packages, are byte for byte
unchanged. So the public surface is the same. The recomputed
`compat-inventory.json` has the same items. Only the upstream paths moved.

| Upstream change                                                                                                                                                                                                                                                                                            | Drop-in disposition                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JavaScript: the process-wide in-flight request caps are removed. These are `src/api/inflight.ts` and the `E2B_API_INFLIGHT_REQUESTS`, `E2B_ENVD_INFLIGHT_REQUESTS` and `E2B_ENVD_RPC_INFLIGHT_REQUESTS` variables, which threw on a negative value. Requests are now bounded only by undici's connections. | No change. The drop-in never read these variables. Its own connection cap (`E2B_MAX_CONNECTIONS` in `src/e2b/client.ts`, 4096) is Runtime's, and it is unchanged.                                                                                                                    |
| JavaScript: `undici` 8.11.2 becomes the only undici. The `undici8` alias and the undici 7 fallback are gone. Below Node 22.19, the global `fetch` is used. `engines.node` is now `>=22.19.0`. `@e2b/dockerfile-utils` moves to `^0.1.1`, which changes only its own version and engines.                   | Not mirrored. The drop-in uses Runtime's transport, and keeps `node >=22.12`. The oracle lock moves to `e2b` 2.56.0, with `undici` 8.11.2 and `@e2b/dockerfile-utils` 0.1.1.                                                                                                         |
| Python: the per-origin `ConnectionBalancer` over several pyqwest pools is replaced by one pool with `max_connections_per_address` (pyqwest `>=0.12,<0.13`). `E2B_STREAMS_PER_CONNECTION` is no longer read. `E2B_MAX_CONNECTIONS` caps connections per resolved address.                                   | No change. `e2b.api` and its clients are E2B's HTTP internals, which the drop-in leaves out. Its connection limit is Runtime's own.                                                                                                                                                  |
| Python: `e2b` and `e2b-code-interpreter` require Python 3.11, because `sandbox/mcp.py` imports `NotRequired` from `typing`.                                                                                                                                                                                | Not followed. `withruntime` keeps Python 3.10, so code moved off E2B on 3.10 keeps working. The official contracts install the new wheels, so that step runs on Python 3.11. `prepare_compatibility.py` moves to Python 3.11 or newer on the PATH when it runs under 3.10, as in CI. |
| `@e2b/code-interpreter` 2.9.0 and `e2b-code-interpreter` 2.11.0 change only their versions, dependency floors (`e2b ^2.56.0`) and engines.                                                                                                                                                                 | Note only.                                                                                                                                                                                                                                                                           |

No behavior changed that the drop-ins mirror. So there is no new behavior test.
`tests/e2b/exports.test.ts` and `sdks/python/tests/test_e2b_exports.py` now name
the new releases. Their export lists are the same. The oracle
(`oracle/check.mjs`, 37 passed) ran against `e2b` 2.56.0 and
`@e2b/code-interpreter` 2.9.0. The Python official contracts (18 passed) ran
against the new wheels, in an isolated virtualenv on Python 3.11 and 3.12. The
provider stays marked `partial`.
