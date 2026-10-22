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

The mapping was written against `e2b` 2.51.0 and checked against `e2b` 2.56.0
and `@e2b/code-interpreter` 2.9.0 on 15 October 2026. Python was checked
against `e2b` 2.56.0 and `e2b-code-interpreter` 2.11.0 the same day. The exact
package releases and artifact hashes are kept in `compatibility-lock.json`.

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
| `lifecycle.onTimeout`                                                                    | `onTimeout`: `kill` is `delete`, `pause` is `pause`; `{ action: "pause", mode: "full" }` is `pause`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `commands.run(cmd, { cwd, envs, timeoutMs, onStdout, onStderr })`                        | A native process started by a streamed exec that reads it from the first byte, so Runtime holds a fast writer back rather than drop output: the result is whole, however long. The default command connection deadline is 60 s; `0` disables it. The process lives up to 24 hours, within the sandbox lease.                                                                                                                                                                                                                                                                                            |
| Non-zero exit                                                                            | Throws `CommandExitError` with `exitCode`, `stdout`, `stderr` and `error` (`exit status N`). A command killed by a signal has `exitCode` -1.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Command past its timeout                                                                 | Disconnects with `TimeoutError` (Python: `TimeoutException`) without killing the command; reconnect by pid to keep reading. A JavaScript command whose sandbox is killed under it throws `SandboxNotRunningError`, a `TimeoutError`, saying the sandbox was killed or reached its end of life.                                                                                                                                                                                                                                                                                                          |
| `commands.run(cmd, { background: true })`                                                | `spawn`. Returns a `CommandHandle` with `pid`, `wait()`, `kill()` (SIGKILL), `sendStdin`, `closeStdin`, `disconnect`, `stdout`, `stderr`, `exitCode`. Runtime keeps the last 1 MiB a process printed; anything older that was not read in time is lost, which sets `truncated` and warns. A command with `stdin: true` starts the same way.                                                                                                                                                                                                                                                             |
| `user` (commands, PTY and files)                                                         | Runs as that Linux user through `sudo -u`; `root` needs nothing more. A user the sandbox lacks throws `InvalidArgumentError` saying how to add one; none is ever created. `user: "user"` is the sandbox's own user. Watching a directory as another user is refused.                                                                                                                                                                                                                                                                                                                                    |
| `commands.list`, `kill(pid)`, `sendStdin(pid)`, `closeStdin(pid)`, `connect(pid)`        | Runtime's processes. A pid is a number derived from Runtime's process id, not the Linux pid. `commands.list` shows each command as E2B starts it: `cmd` `/bin/bash`, `args` `["-l", "-c", "<your command>"]` (a PTY: `["-i", "-l"]`), the command cut at 256 characters, `envs` empty.                                                                                                                                                                                                                                                                                                                  |
| `pty.create`, `connect`, `sendInput`, `resize`, `kill` (Python snake_case)               | Native PTY processes with lossless byte callbacks. A reader timeout or disconnect detaches without killing the process; reconnect resumes reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `files.read(path, { format })`                                                           | `files.read`. `text`, `bytes`, `blob` and `stream` (Python: `text`, `bytes`, `stream`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `downloadUrl(path, opts)`, `uploadUrl(path, opts)`                                       | `files.downloadUrl` and `files.uploadUrl`: a signed link anyone can open with no key, as a string. `useSignatureExpiration` is seconds (60 to 7 days, one hour by default); `user` is ignored. `uploadUrl()` needs a `path`, as a link names one file.                                                                                                                                                                                                                                                                                                                                                  |
| `files.write(path, data)`, `write([...])`, `writeFiles`                                  | `files.write`. Parent directories are made, and a file that exists is replaced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `files.list(path, { depth })`                                                            | `files.list`, hidden files included. `owner` and `group` come from native metadata, with `""` for older guests that omit them. `depth` below one throws `InvalidArgumentError` "depth should be at least one".                                                                                                                                                                                                                                                                                                                                                                                          |
| `files.makeDir`, `exists`, `getInfo`, `rename`, `remove`                                 | `files.stat`, `mkdir`, `rename` (replacing a file that exists) and `remove` (recursive). A missing file throws `FileNotFoundError`. Entries read as envd gives them: `permissions` begins with the kind's letter (`-rw-r--r--`, `drwxr-xr-x`, `L` for a link), the sandbox user is `user`, and a link's `symlinkTarget` is absolute.                                                                                                                                                                                                                                                                    |
| Relative paths                                                                           | Resolved against the home directory, `/workspace` on Runtime, and given back under `/home/user`, as E2B gives them: `write("a.txt")` returns `/home/user/a.txt`. A path given in full comes back as given. `pwd` in a command prints `/workspace`.                                                                                                                                                                                                                                                                                                                                                      |
| `/home/user` (E2B's home)                                                                | The first time a path, `cwd` or command names it, it becomes a link to `/workspace`, unless something is already there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sandbox.kill()`, `Sandbox.kill(id)`                                                     | `delete`: gone for good. `false` when the sandbox was not found or was already deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sandbox.setTimeout(ms)`, `Sandbox.setTimeout(id, ms)`                                   | The sandbox's time limit becomes now + ms, sooner or later than before, up to 24 hours (an update's `timeoutSeconds`; under a minute is a minute), and its end still does what it was created to. A sandbox with no time limit gets one; a persistent one (a pilot's) has none to set, and nothing changes.                                                                                                                                                                                                                                                                                             |
| `Sandbox.connect(id, { timeoutMs })`, `sandbox.connect()`                                | `get`. A paused sandbox is woken. A running one's end moves later, never earlier, up to 24 hours. An ended one throws `SandboxNotFoundError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sandbox.pause()`, `betaPause`, `Sandbox.pause(id)`                                      | `pause`, keeping memory and files. `false` when it was already paused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `getInfo`, `isRunning`                                                                   | `get`. `templateId` is the template the sandbox was created from, as you named it (kept in the label `e2b-template`, which `metadata` leaves out), or `base`. `envdVersion` is `runtime`. A sandbox Runtime paused for being idle is `running`. `endAt` is when it ends by itself; one that never will (no time limit, as a pilot's) reads 24 hours ahead, the furthest E2B allows.                                                                                                                                                                                                                     |
| `Sandbox.list({ query: { metadata, state }, limit })`                                    | `sandboxes.list` by labels and state, oldest first, with E2B's paginator (`hasNext`, `nextItems()`, `nextToken`). A `template` or `startedAfter` filter, `order: "desc"` and a saved `nextToken` are applied by the adapter, which reads every match once and pages through them.                                                                                                                                                                                                                                                                                                                       |
| `fork`, `createSnapshot`, `deleteSnapshot`                                               | Runtime's memory-preserving forks and snapshots; `createSnapshot({ mode: "filesystem" })` is a disk snapshot, from which a sandbox boots afresh. Deleting a snapshot removes that saved capture. A fork's `count` is 1 to 20, as E2B checks it.                                                                                                                                                                                                                                                                                                                                                         |
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

| E2B                                                           | Use instead                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| An E2B template name with no Runtime image of that name       | Build it: `npx withruntime images build --dockerfile e2b.Dockerfile --name <template>`. This throws `TemplateError`. |
| `Template`, `waitForPort` and the other ready checks          | `runtime.images.build(...)`                                                                                          |
| A pause with `mode: "filesystem"` or `keepMemory: false`      | Runtime's pause keeps memory. For the files alone, `createSnapshot({ mode: "filesystem" })`.                         |
| `onResume: "reboot"`                                          | Stop the sandbox and create a new one.                                                                               |
| `fork({ timeoutMs })`                                         | Fork without it, then call `setTimeout` on each fork.                                                                |
| `network`, `updateNetwork`                                    | `runtime: { create: { network } }` and `sandbox.runtime.network.set(...)`.                                           |
| `mcp`, `getMcpUrl`, `getMcpToken`                             | Runtime's own MCP server, `npx withruntime mcp`.                                                                     |
| `iam`, `Secret`                                               | A Runtime secret (`npx withruntime secrets set NAME --host <host>`): the sandbox sees a placeholder.                 |
| `volumeMounts`, `Volume`                                      | Runtime volumes: `runtime: { create: { volumes: [{ volumeId, path }] } }`.                                           |
| `git`                                                         | `commands.run("git ...")`. E2B has deprecated its git module too.                                                    |
| File `metadata`                                               | Keep it in a file beside the data.                                                                                   |
| `runCode(code, { envs })`                                     | A context made with them: `sandbox.runtime.interpreter.contexts.create({ env })`.                                    |
| `domain`, `apiUrl`, `sandboxUrl`, `headers`, `proxy`, `debug` | Remove them. `RUNTIME_API_URL` sets Runtime's origin, and `HTTPS_PROXY` sets a proxy.                                |

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

## JavaScript qualification, 6 October 2026

Reviewed the published npm tarballs for `e2b` 2.52.1 → 2.53.1 and
`@e2b/code-interpreter` 2.8.0 → 2.8.2. Both new versions were npm's latest
when checked. All four downloaded tarballs matched their registry SHA-512
integrities; the new values are in `compatibility-lock.json` and the oracle's
`bun.lock`. No package code was executed during source review.

Each package changed its manifest and six distribution files: CommonJS and
ES-module JavaScript, their source maps, and both declaration formats. The
source maps contain the TypeScript sources (no separate `src` directory ships);
CommonJS and ES-module source contents match. Ten E2B source files and three
interpreter source files changed. The changes and their dispositions:

| Upstream change                                                                                                                                                                                                                                                                         | Drop-in disposition                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxNotRunningError` and `SandboxUnreachableError`, exported by E2B and re-exported by the interpreter; both extend `TimeoutError` and accept `ErrorOptions.cause`.                                                                                                                 | Mirrored: both imports, names, parents, constructor signatures and causes match. Runtime's explicit `sandbox_stopped`, `sandbox_paused` and `sandbox_not_running` codes select the first; `sandbox_not_ready` and `host_unavailable` select the second.                                                                                                                                  |
| HTTP 502 and RPC Unavailable distinguish a stopped sandbox from an unreachable one. Failed connection and ambiguous stream errors use a health probe; browser network failures are recognized too. Process and watch startup no longer replace Unavailable with `SandboxNotFoundError`. | Mirrored through Runtime's explicit state codes, including command, file, watch and interpreter guards. A command losing its sandbox now throws `SandboxNotRunningError`. E2B's envd health probes, proxy message matching and RPC parsing are not copied: Runtime uses its own API. An unclassified connection failure does not establish sandbox state and retains its existing error. |
| Streaming RPCs preserve a plain-text or JSON proxy 502 message; recognized Connect error codes retain their meaning. HTTP error-body extraction is shared with the health probe.                                                                                                        | Not mirrored: E2B's proxy and Connect transport are not used. Runtime's structured code, message, hint, request id and original cause remain available.                                                                                                                                                                                                                                  |
| Removed `E2B_USER_AGENT_SOURCE`, `ConnectionConfig.requestSource`, user-agent source suffixes, automatic CI error logging and trace-id diagnostics. Logger middleware now returns the request and response.                                                                             | Not mirrored: Runtime never implemented those E2B transport diagnostics; `ConnectionConfig` and `ApiClient` remain unsupported.                                                                                                                                                                                                                                                          |
| Create, connect and fork share a response mapper and a private response type; the protected return annotations allow optional transport fields.                                                                                                                                         | Not mirrored: this refactors E2B's transport response without changing public Sandbox behavior; Runtime builds its own sandbox objects.                                                                                                                                                                                                                                                  |
| Interpreter errors include a nonempty trimmed response body for generic HTTP failures, without a CI-only switch or trace suffix; 404 and 502 retain their previous classes.                                                                                                             | Already preserves server explanations: Runtime translates its structured API errors, including the message, hint and request id. E2B's private Jupyter HTTP formatter and status-line wording are not used.                                                                                                                                                                              |
| Interpreter request URLs no longer append the traffic-source query; private diagnostic helpers disappear from declarations.                                                                                                                                                             | Not mirrored: Runtime does not send requests to E2B's Jupyter endpoints or append that query.                                                                                                                                                                                                                                                                                            |
| Interpreter streaming uses one UTF-8 decoder across chunks and flushes it at EOF.                                                                                                                                                                                                       | Already matched by Runtime's `TextDecoderStream`. A `runCode` test sends every byte separately, including two-, three- and four-byte characters and a final line without a newline; callbacks and final results retain the text.                                                                                                                                                         |
| Interpreter dependency rises from `e2b ^2.48.0` to `^2.53.1`; package versions and build metadata advance.                                                                                                                                                                              | Oracle pins both exact releases. No other public exports, caller options, defaults or method signatures changed.                                                                                                                                                                                                                                                                         |

`tests/e2b/exports.test.ts` checks both import surfaces, constructor causes and
Runtime error translation. `tests/e2b/sandbox.test.ts` checks the error when a
running command loses its sandbox. `tests/e2b/code-interpreter.test.ts` exercises
the real native transport beneath `runCode` with in-memory HTTP replies, including
split UTF-8 and server failures without replay. These fixtures do not establish
live-host behavior, isolation, recovery, performance superiority or full E2B
compatibility; the provider remains marked `partial`.

## e2b 2.55.0, 9 October 2026

Reviewed the published npm tarballs for `e2b` 2.53.1 → 2.55.0 and
`@e2b/code-interpreter` 2.8.2 → 2.8.3, and the PyPI wheels and sdists for
`e2b` 2.53.1 → 2.55.0 → 2.55.1 and `e2b-code-interpreter` 2.10.3 → 2.10.4 →
2.10.5. Each was npm's or PyPI's latest when checked. Every pinned file matched
the hash already in `compatibility-lock.json`, and every new file matched its
registry's SHA-512 integrity or SHA-256 digest; each wheel's Python source is
byte for byte its sdist's. Nothing was installed, imported or run. JavaScript
sources were read from the source maps, which carry the TypeScript. Nine `e2b`
source files changed, one was removed, and one interpreter file changed.

| Upstream change                                                                                                                                                                                                                                                                                          | Drop-in disposition                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pause`, `betaPause`, `createSnapshot` and `lifecycle.onTimeout` take `mode: "full" \| "filesystem"` (Python `mode=`, keyword-only); `keepMemory` (`keep_memory`) is deprecated. Both at once, an unknown mode, or a mode on `action: "kill"` throws `InvalidArgumentError`. `SnapshotMode` is exported. | Followed, in both languages. `createSnapshot({ mode: "filesystem" })` takes a Runtime disk snapshot and `"full"` the whole machine. A pause with `"filesystem"` throws `NotSupportedError`, as `keepMemory: false` did, naming the disk snapshot. `"full"` pauses. The same `InvalidArgumentError`s, with E2B's messages. Until now a `mode` was ignored: a pause asked to drop memory kept it. |
| `DockerfileSyntaxError` is exported (from the new `@e2b/dockerfile-utils` / `e2b-dockerfile-utils` 0.1.0): a plain `Error` (Python `ValueError`) with `line`. The template builder's Dockerfile and `.dockerignore` parsing moves into that package, replacing `dockerfile-ast` / `dockerfile-parse`.    | Exported with E2B's parent, message and `line`, also from `e2b.template.dockerfile_parser`. Templates stay refused, naming `npx withruntime images build`, so nothing throws it.                                                                                                                                                                                                                |
| Template `copy` and `makeDir` keep `mode: 0` instead of dropping it.                                                                                                                                                                                                                                     | Not mirrored: templates are refused.                                                                                                                                                                                                                                                                                                                                                            |
| A file entry for a symlink is `FileType.SYMLINK` when newer envd reports the target's type with an `isSymlink` flag.                                                                                                                                                                                     | Already matched: Runtime's listing marks the link itself `symlink`.                                                                                                                                                                                                                                                                                                                             |
| Python's command stream decodes empty output chunks instead of skipping them, still yielding only nonempty text. A JavaScript comment is removed.                                                                                                                                                        | No change in what a caller sees; Runtime's own stream is used.                                                                                                                                                                                                                                                                                                                                  |
| The interpreter builds its Jupyter address with `getSandboxUrl` (Python `get_sandbox_url(port=)`, added in `e2b` 2.55.1) instead of a direct URL. Interpreter dependencies rise to `e2b ^2.55.0` (Python `>=2.55.1`).                                                                                    | Not mirrored: Runtime does not call E2B's Jupyter endpoints. The oracle and the Python contract requirements pin the exact releases, with `@e2b/dockerfile-utils` and `e2b-dockerfile-utils` 0.1.0 in place of the parsers.                                                                                                                                                                     |
| API documentation: `team_id` may be a `prj_` project id; `secret_limit_reached` is a listed error code.                                                                                                                                                                                                  | Not used by the drop-in.                                                                                                                                                                                                                                                                                                                                                                        |

`tests/e2b/e2b-2-55.test.ts` and `sdks/python/tests/test_e2b_2_55.py` check the
modes, the refusals, their messages and the new exports; they fail without
this change. The official differential contracts were not run against the new
releases, since they execute E2B's code; the provider remains marked `partial`.

## e2b 2.56.0, 15 October 2026

Reviewed the published npm tarballs for `e2b` 2.55.0 → 2.56.0 and
`@e2b/code-interpreter` 2.8.3 → 2.9.0, and the PyPI wheels and sdists for
`e2b` 2.55.1 → 2.56.0 and `e2b-code-interpreter` 2.10.5 → 2.11.0. Each was
npm's or PyPI's latest when checked. Every pinned file matched the hash already
in `compatibility-lock.json`, and every new file matched its registry's SHA-512
integrity or SHA-256 digest; each wheel's Python source is byte for byte its
sdist's. Nothing was installed, imported or run for the review. JavaScript
sources were read from the source maps. The declarations (`index.d.ts`) of
both npm packages and the `__init__.py` of both Python packages are byte for
byte unchanged, so the public surface is the same: the recomputed
`compat-inventory.json` has the same items, only the upstream paths move.

| Upstream change                                                                                                                                                                                                                                                                            | Drop-in disposition                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript: the process-wide in-flight request caps are removed (`src/api/inflight.ts` and the `E2B_API_INFLIGHT_REQUESTS`, `E2B_ENVD_INFLIGHT_REQUESTS`, `E2B_ENVD_RPC_INFLIGHT_REQUESTS` variables, which threw on a negative value). Requests are bounded by undici's connections only. | No change: the drop-in never read these variables. Its own connection cap (`E2B_MAX_CONNECTIONS` in `src/e2b/client.ts`, 4096) is Runtime's and unchanged.                                                                                                                          |
| JavaScript: `undici` 8.11.2 becomes the only undici (the `undici8` alias and the undici 7 fallback are gone); below Node 22.19 the global `fetch` is used. `engines.node` is now `>=22.19.0`, `@e2b/dockerfile-utils` `^0.1.1` (0.1.1 changes only its own version and engines).           | Not mirrored: the drop-in uses Runtime's transport and keeps `node >=22.12`. The oracle lock moves to `e2b` 2.56.0 with `undici` 8.11.2 and `@e2b/dockerfile-utils` 0.1.1.                                                                                                          |
| Python: the per-origin `ConnectionBalancer` over several pyqwest pools is replaced by one pool with `max_connections_per_address` (pyqwest `>=0.12,<0.13`); `E2B_STREAMS_PER_CONNECTION` is no longer read, and `E2B_MAX_CONNECTIONS` caps connections per resolved address.               | No change: `e2b.api` and its clients are E2B's HTTP internals, which the drop-in leaves out; its connection limit is Runtime's own.                                                                                                                                                 |
| Python: `e2b` and `e2b-code-interpreter` require Python 3.11 (`sandbox/mcp.py` imports `NotRequired` from `typing`).                                                                                                                                                                       | Not followed: `withruntime` keeps Python 3.10, so code moved off E2B on 3.10 keeps working. The official contracts install the new wheels, so that step runs on Python 3.11 (`prepare_compatibility.py` moves to a Python 3.11 or newer on the PATH when run under 3.10, as in CI). |
| `@e2b/code-interpreter` 2.9.0 and `e2b-code-interpreter` 2.11.0 change only their versions, dependency floors (`e2b ^2.56.0`) and engines.                                                                                                                                                 | Note only.                                                                                                                                                                                                                                                                          |

No behaviour changed that the drop-ins mirror, so there is no new behaviour
test; `tests/e2b/exports.test.ts` and `sdks/python/tests/test_e2b_exports.py`
now name the new releases, whose export lists are the same. The oracle
(`oracle/check.mjs`, 37 passed) ran against `e2b` 2.56.0 and
`@e2b/code-interpreter` 2.9.0, and the Python official contracts (18 passed)
against the new wheels in an isolated virtualenv on Python 3.11 and 3.12. The
provider remains marked `partial`.
