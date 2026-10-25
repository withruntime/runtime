# Code written for Vercel Sandbox, on Runtime

Run code written for [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)'s
SDK on Runtime Cloud by changing one import. This is part of Runtime's SDK
(`withruntime`). It uses the same client, so it gets that SDK's retries,
idempotency keys and errors. Importing `withruntime` alone does not load it.

```ts no-run
import { Sandbox } from "withruntime/vercel"; // was: from "@vercel/sandbox"
```

Python has the same, in `pip install withruntime`:

```python no-run
from withruntime.vercel import sandbox  # was: from vercel import sandbox
from withruntime.vercel.sandbox import sync as sandbox  # was: from vercel.sandbox import sync as sandbox
```

The JavaScript mapping was checked against `@vercel/sandbox` 3.8.0 on 15 October 2026. The Python mapping was checked against `vercel-sandbox` 0.9.1 on PyPI (the
`vercel.sandbox` module of `vercel` 0.12.0), also on 15 October 2026. Version
0.9.0 added `get_drive`. It raises `NotSupportedError`, as the other Drive calls do.

Python review, 15 October 2026: each pinned wheel and sdist matched its SHA-256 in
`compatibility-lock.json`. Each new one matched the PyPI digest. Each new wheel's
source matched its sdist. The files were compared one by one. Nothing was installed
or run. `vercel-sandbox` 0.9.1 changes only its version and its
`vercel-internal-core` floor (0.2.2). No sandbox source changes. `vercel` 0.12.0
moves `vercel.blob` into the separate `vercel-blob` package, which is a new
dependency. It removes its own Blob code. It raises its floors (`vercel-sandbox`
0.9.1). Blob is Vercel's storage product, which the drop-in has never offered.
`withruntime.vercel` exports `sandbox` and `api`. So nothing changes here. The
inventory's 684 Python items are unchanged.

## Keys

The package uses these keys, in this order:

1. A Runtime key (`rtcloud_...`) passed as `token`.
2. `RUNTIME_API_KEY`.
3. The key that `npx withruntime login` saved on this machine.

A Vercel token or an OIDC token is never sent anywhere. If one is passed as
`token` and `RUNTIME_API_KEY` is not set, the call throws `AuthenticationError`
(Python: `SandboxCredentialsError`). `teamId` and `projectId` have no meaning on
Runtime, so they are ignored.

## What a sandbox gets

- **Machine:** Vercel's default, 2 vCPUs with 2048 MiB each. `resources: { vcpus }`
  sets another count, with 2048 MiB per vCPU.
- **Timeout:** none, unless you pass one. The sandbox runs while it works, and
  pauses itself when it is idle. A `timeout` is kept as a Runtime time limit. It
  runs from 60 seconds up to an hour. A longer `timeout` (Python
  `execution_time_limit`) starts with an hour's lease. The sandbox object renews
  the lease toward the timeout while the sandbox lives. It never renews past the
  timeout. When the program ends, the sandbox pauses within an hour.
  `extendTimeout` moves the end later, as often as you need.
- **Persistence:** persistent by default, as in Vercel. `stop()` and the end of
  the timeout pause the sandbox. The sandbox keeps its files, and also its memory
  and processes. `Sandbox.get({ name })`, or the next command or file call, wakes
  it. A paused sandbox is kept under Runtime's retention: 30 days on credit, 7
  days on the trial, or `snapshotExpiration`. It is billed as paused storage. With
  `persistent: false`, `stop()` ends the sandbox. `delete()` always ends it.
- **Ports:** each port in `ports` is shared at a public HTTPS address (a Runtime
  preview) when the sandbox is created. So `domain(port)` answers at once. A
  browser first sees a one-time page that names Runtime, before the site.
- **Funding:** left to Runtime, as `withruntime`'s own `create()` does. The free
  trial is used while the account has trial time. After that, prepaid credit is
  used. To use only the trial, pass `withruntime: { create: { funding: "trial" } }`
  (Python: `runtime_create={"funding": "trial"}`).
- **Anything else Runtime offers:** `withruntime: { create: { ... } }` sends
  Runtime's create fields as they are. `sandbox.withruntime` is the Runtime sandbox
  underneath. The key is `withruntime`, because Vercel's `runtime` names a Node.js
  or Python version.

## Mapping

| Vercel Sandbox                                                        | On Runtime                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox.create({ name, timeout, resources, env, tags, ports })`      | `sandboxes.create`, with `name`, `timeoutSeconds`, `vcpu`, `memoryMiB` and labels. `env` is given to every command run through this object.                          |
| `image`, legacy `runtime`                                             | Vercel's managed images and runtimes map to Runtime's stock image. Any other name must be a ready Runtime image with that name.                                      |
| `source: { type: "git", url, depth, revision, username, password }`   | Cloned into the working directory after create. Credentials reach git through the environment.                                                                       |
| `source: { type: "tarball", url }`, `{ type: "snapshot" }`            | Downloaded and unpacked into the working directory. A Runtime snapshot has its own shape.                                                                            |
| `networkPolicy`, `updateNetworkPolicy`                                | Runtime network rules: `allow-all`, `deny-all`, or a list of domains and subnets to allow and deny.                                                                  |
| `Sandbox.get({ name })`, `getOrCreate`, `list({ tags })`              | The newest live sandbox with that name (or a Runtime ID), woken. Created if missing. `sandboxes.list` with Vercel's paginator.                                       |
| `list({ namePrefix, since, until, sortBy, sortOrder, cursor })`       | Applied here, over every sandbox the key can see. The cursor continues the same order. Python's `query_sandboxes` does the same.                                     |
| `createUser`, `asUser`, `createGroup`, `addUserToGroup`               | `useradd`, `groupadd` and `usermod`, run with `sudo`, as Vercel does. A user's commands run under `sudo -u` in its home directory. Its files are given to it.        |
| `Sandbox.fork({ sourceSandbox, name })`                               | A Runtime fork. It copies memory and processes too.                                                                                                                  |
| `runCommand(cmd, args)`, `runCommand({ cmd, args, cwd, env, sudo })`  | `exec` of the argument list, without a shell. `sudo` runs it under `sudo --preserve-env`. A non-zero exit is a result. Past `timeoutMs`, the command exits with 137. |
| `stdout`, `stderr` writers, `detached: true`, `logs()`, `wait()`      | Output streams to the writers. A detached command is a Runtime process. Its logs are followed from the start.                                                        |
| `getCommand(cmdId)`, `kill(signal)`                                   | Runtime processes, by ID. Signals by name or number.                                                                                                                 |
| `writeFiles`, `readFile`, `readFileToBuffer`, `downloadFile`, `mkDir` | Runtime's files API. `mode` is set with `chmod`. A missing file returns `null`, as in Vercel.                                                                        |
| `sandbox.fs`                                                          | `node:fs/promises` over the files API and coreutils, with Node's error codes.                                                                                        |
| Paths                                                                 | Relative paths resolve from `/vercel/sandbox`, which is `/workspace`. A command that names `/vercel/sandbox` finds a link to it.                                     |
| `domain(port)`, `update({ ports })`                                   | The public preview of that port. Ports are added or removed.                                                                                                         |
| `stop()`, `delete()`, `extendTimeout(ms)`                             | `pause` (for a persistent sandbox) or `stop`. Then `stop`. Then `extend`.                                                                                            |
| `update({ timeout, networkPolicy, snapshotExpiration })`              | A new timeout (earlier only while the lease has not reached it), network rules, and retention.                                                                       |
| `snapshot()`, `Snapshot.get`, `Snapshot.list`, `snapshot.delete()`    | A verified disk-only capture. Then the source stops. A restored snapshot starts fresh processes. `snapshots.get`, `list` and `delete`.                               |
| Error classes                                                         | `APIError`, with a `response` whose status is Runtime's, and `json` of `{ error: { code, message } }`. It also carries `code`, `hint` and `requestId`.               |
| Python: `create_sandbox`, `run_process`, `create_process`, `box.fs`   | The same mapping. Operations are awaited, or used as context managers. A context manager stops the sandbox, and by default destroys it. Readers iterate by line.     |

## Gaps

Each of these throws `NotSupportedError` before anything happens. The error's
`feature` names the gap. Its `alternative` says what to use.

| Vercel Sandbox                                             | Use instead                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| An `image` with no Runtime image of that name              | Build it: `npx withruntime images build --dockerfile Dockerfile --name <image>`.                       |
| Drives (`mounts`), `networkId`                             | Runtime volumes, through `withruntime: { create: { volumes } }`. Network rules.                        |
| A region outside the US, `failoverRegions`                 | Runtime runs in one US region.                                                                         |
| Network rules that transform or forward requests           | Allow the domain, and store the credential as a Runtime secret for it. The sandbox sees a placeholder. |
| A `timeout` earlier than the current lease's end           | Stop the sandbox when you are done with it.                                                            |
| Sessions (`currentSession`, `listSessions`)                | A Runtime sandbox is its own session.                                                                  |
| `openInteractive` (Python: `open_interactive`)             | `sandbox.withruntime.terminal(...)`, or `npx withruntime sandboxes shell <id>`.                        |
| `update` of tags, resources, persistence or region         | Create a new sandbox with them.                                                                        |
| Overrides on `Sandbox.fork`                                | Fork, then change what Runtime allows.                                                                 |
| `delete({ deleteOrphanSnapshots: true })`, `Snapshot.tree` | Delete snapshots one by one, with `Snapshot.list` to find them.                                        |
| `Drive`, `defineSandboxProxy`                              | Runtime volumes, or `sandbox.withruntime.previews`.                                                    |
| `keepLastSnapshots`                                        | Manage saved snapshots with `Snapshot.list` and `snapshot.delete`.                                     |

Explicit snapshots need the released native disk-capture capability. A server
that does not confirm disk-only capture is refused. If the capture succeeds but
the source cannot finish stopping, the error keeps `snapshotId` and
`sourceSandboxId`. That keeps the saved filesystem recoverable. JavaScript exposes
them in `error.json.error.details` for API errors, and directly on other errors.
Python exposes them in `error.data` for API errors, and directly on other errors.
`snapshot_source_stop_timeout` means the source is still stopping after its wait.
A failed stop request keeps its original error code. These contracts stay
partial. Controlled package comparisons do not prove hosted restoration.

Some differences are not refusals:

- A persistent sandbox keeps its memory and processes, as well as its files,
  across `stop()`. They carry on after a wake. Vercel starts them again.
- Commands run as the sandbox owner, `runtime`, with passwordless `sudo`. `pwd`
  prints `/workspace`.
- Runtime's stock image is Ubuntu 24.04, with Python 3.12, Node.js 24 and Bun.
  Vercel's `universal` image has Python 3.14.
- A git source is cloned into the working directory itself.

## JavaScript qualification, 15 October 2026

We reviewed the exact published npm tarballs for `@vercel/sandbox` 3.6.1, 3.7.0
and 3.8.0. 3.7.0 is the only stable release between them. 3.6.1 matched its
SHA-512 in `compatibility-lock.json`. 3.7.0 and 3.8.0 matched
`npm view @vercel/sandbox@<version> dist.integrity`. For 3.8.0, the value starts
`sha512-2ib+Dl8W...`. No downloaded package code was installed or run, except
inside the oracle's frozen install.

The source maps name six changed TypeScript files, and one new one
(`utils/pipe-stdin.ts`). CommonJS and ES-module builds match. `index.d.ts` exports
nothing new. These are the changes, and how each one is handled:

| Upstream change                                                                                                                                                                                                                                                                                                                                                                                                                                         | Drop-in disposition                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.7.0: `runCommand({ stdin: true, detached: true })` keeps the command's stdin open. `stdin: true` without `detached` throws `TypeError` before anything runs. When `stdin` is unset or false, stdin is empty, as before.                                                                                                                                                                                                                               | Followed. The process is spawned with Runtime's piped stdin (`stdinMode: "pipe"`). The same `TypeError` message is thrown before any request. Without `stdin`, nothing changes.                                                                                                                                                                                                                |
| 3.7.0: `Command.writeStdin(data, { abortSignal })` and `closeStdin({ abortSignal })`. Writes are queued in call order and chunked. They are resent with byte offsets, so a retry never duplicates bytes. After a write that may be partial, later writes are refused. `closeStdin` still works.                                                                                                                                                         | Followed on Runtime's process input (`:write` with `offset` and `eof`). It already resends by offset, so no byte is written twice. Writes are queued in call order. A failed write refuses later ones, with upstream's message. The exception is when the API rejected a single request with a 4xx, which applied none of it. A `Command` from `getCommand` reads its offset from the process. |
| 3.7.0: `CommandFinished.writeStdin` and `closeStdin` always throw, because the command has exited.                                                                                                                                                                                                                                                                                                                                                      | Followed, with the same messages.                                                                                                                                                                                                                                                                                                                                                              |
| 3.7.0: `stdin` may be a `Readable`, attached or detached. It is written with backpressure, and stdin closes when the stream ends. The stream is never ended or destroyed. Attached: a piping failure kills the command and rejects `runCommand`. Detached: `wait()` rejects, and `stdinPipe` clears. If the command exits, or stops accepting input (404, `command_stdin_unavailable`), piping stops quietly. `Command.stdinPipe` is the internal pipe. | Followed. An attached command with a stream starts as a process. It waits on its output, and streams to the `stdout` and `stderr` writers as before. Reading pauses past 512 KiB while it waits. Runtime's "input closed" answer (409 `stdin_closed`), or a 404, stops piping quietly, as upstream's does. `stdinPipe` is exposed the same way.                                                |
| 3.7.0: `SandboxUser.runCommand` passes `stdin`. 3.8.0 also passes `onStart`.                                                                                                                                                                                                                                                                                                                                                                            | Followed. Both reach the sandbox's `runCommand` through the user's `sudo -u` wrapper.                                                                                                                                                                                                                                                                                                          |
| 3.8.0: `runCommand({ onStart })`, only when not detached. The type forbids it with `detached: true`, and upstream ignores it there. It is called with the running `Command` as soon as the command starts, and awaited before `runCommand` resolves.                                                                                                                                                                                                    | Followed, with the same type. The command starts as a Runtime process, so its `Command` (ID, `kill`, `logs`) exists before it exits. Output and truncation are reported as for any attached command.                                                                                                                                                                                           |
| `APIClient.writeCommandStdin`, and its stdin retry policy (429 with `Retry-After`, resends on 502, 503 and 504, offset probes). Also the `CommandStdinResponse` validator.                                                                                                                                                                                                                                                                              | Internal. `APIClient` is not exported. Runtime's transport and offsets cover resends.                                                                                                                                                                                                                                                                                                          |
| `@vercel/oidc` 3.2.0 to 4.0.0, which now depends on `@vercel/cli-config` and `@vercel/cli-exec`.                                                                                                                                                                                                                                                                                                                                                        | The drop-in never uses Vercel OIDC. A Vercel or OIDC token still throws `AuthenticationError`. Only the oracle's lock changes.                                                                                                                                                                                                                                                                 |
| Declarations reorder existing status union members. The README documents stdin. The package and internal version advance.                                                                                                                                                                                                                                                                                                                               | No adapter change.                                                                                                                                                                                                                                                                                                                                                                             |

`tests/vercel-3-8.test.ts` (12 cases) runs the real Runtime transport over
controlled HTTP. It covers piped spawn, write order and offsets, the `TypeError`,
empty stdin by default, refusals for finished commands, partial-write refusal and
4xx recovery. It also covers an attached and a detached `Readable` (end, failure
with kill, and quiet stop on `stdin_closed`), `onStart` ordering, and
`SandboxUser` pass-through. Eleven of the cases fail before the adapter change.
The twelfth, empty stdin by default, guards existing behavior. They do not prove
live-host behavior. The provider stays `partial`. `compat-inventory.json` now
counts `writeStdin`, `closeStdin`, `stdinPipe`, and the `stdin` and `onStart`
options as present. It counts `CommandFinished`'s stdin calls as refused, as
upstream's are.

## JavaScript qualification, 8 October 2026

We reviewed the exact published npm tarballs for `@vercel/sandbox` 3.5.1 to 3.6.1.
Both tarballs matched their registry SHA-512 integrities. The 3.6.1 value in
`compatibility-lock.json` came from `npm view @vercel/sandbox@3.6.1 dist.integrity`.
No downloaded package code was installed or run.

The distribution diff changes 31 files. That includes five TypeScript source files
in the source maps: `drive.ts`, `version.ts`, `api-client.ts`, `base-client.ts` and
`validators.ts`. CommonJS and ES-module source-map contents match. These are the
changes, and how each one is handled:

| Upstream change                                                                                                                                                                                              | Drop-in disposition                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Drive.get({ name, signal?, token?, teamId?, projectId?, fetch? })` retrieves an existing drive without creating one. Internally it sends GET to the encoded drive-name path, with `projectId` in the query. | Already refused by the `Drive` export, before credentials or requests are used. The error is `NotSupportedError`, and it names `runtime.volumes` and `withruntime: { create: { volumes } }`.                                                                                                                                |
| `drive.fork({ name, signal? })` creates a drive that inherits data, maximum size and region. Its POST uses the source drive name, a `projectId` query, and a `{ name }` body.                                | All Drive construction and retrieval stay refused. So no unsupported Drive instance can reach this call. Use Runtime volumes. No Vercel Drive fork is claimed.                                                                                                                                                              |
| `drive.parentDriveId` and `drive.rootDriveId`, optional strings, expose ancestry. Drive response validation now keeps those fields, including in list, get, create, fork and update responses.               | The same Drive refusal applies. No ancestry or Vercel drive metadata is made up.                                                                                                                                                                                                                                            |
| Streaming `runCommand` turns off retry of the command POST. After it receives the command ID, a cut, an early EOF, or an incomplete final JSON record recovers the logs. It then waits for the same command. | Mapped through native Runtime process IDs and byte cursors. No command restarts after its ID arrives. Initial Runtime transport retries use the same idempotency key. Attached commands now throw `StreamError` with `output_truncated` when recovery reports missing bytes, as detached commands already did.              |
| `Command.logs()` reconnects interrupted log bodies up to twice, waiting 200 ms and then 400 ms. It skips stdout and stderr characters that were already delivered, counting each stream separately.          | Mapped through Runtime's byte cursor across both streams. Runtime follows stream slices and connection cuts. Repeated empty streams stop after four reads. Continuous failures have a five-minute recovery budget. These are Runtime's own recovery limits, not Vercel's retry timing.                                      |
| `getCommand`, including waiting for completion, retries failures while it reads the response body, up to twice. Parsing can use the body that was already read.                                              | Native Runtime JSON reads already retry through the whole body, with the client's `maxRetries` (four by default). Completion comes from the native process output's exit event, not from Vercel's command-wait endpoint.                                                                                                    |
| Stream parsing now keeps UTF-8 across chunks. It classifies connection cuts and incomplete final JSON. It closes readers. It passes cancellation or application errors through, without recovery.            | Runtime already uses a persistent `TextDecoderStream`. It closes its readers, and resumes at the byte cursor after a cut or a partial record. Permanent structured API errors and cancellation are not replayed. Runtime also retries parse failures as stream cuts. It does not expose Vercel's private `ConnectionError`. |
| Sandbox and snapshot declarations reorder existing status union members. The package and internal version advance.                                                                                           | No status values, package exports, dependencies or other caller signatures change. No adapter change is needed.                                                                                                                                                                                                             |

`tests/vercel-3-6.test.ts` runs the real Runtime transport with controlled HTTP
responses. It covers attached and detached recovery, stdout and stderr ordering,
one-byte UTF-8 chunks, incomplete JSON, no command replay, bounded empty-stream
failure, permanent errors, Drive lookup refusal, and missing-output refusal.
Before the adapter change, both missing-output cases resolved successfully. They
should have thrown. These tests do not prove live-host recovery, isolation,
performance superiority or full Vercel compatibility. The provider stays `partial`.

`tests/compat/reference.bun.lock` has no Vercel entry. The consumer declaration
check in `tests/compat/check-consumers.ts` reads the main compatibility lock. It
requires the extracted upstream version to match that lock. Neither needs a
separate Vercel version edit. The separate oracle was not run for this source
review.

## Tests

`bun run test` in `packages/cloud-sdk` runs the unit tests for both languages,
against fakes of Runtime's SDKs. The tests are `tests/vercel` here and
`sdks/python/tests/test_vercel.py`.

The end-to-end tests run the judge panel's Vercel Sandbox eval, and Vercel's
Python examples. They are unmodified except for the import, and they run against
the real API. They refuse to start unless the free trial has an hour left. They
end every sandbox they create. They are not part of `bun run test`.

```bash no-run
bun packages/cloud-sdk/scripts/dropin-e2e.ts          # JavaScript, with the Daytona quickstart
python3 sdks/python/scripts/dropin_e2e.py             # Python, with the Daytona quickstart
```
