# Code written for Vercel Sandbox, on Runtime

Run code written for [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)'s
SDK on Runtime Cloud by changing one import. It is part of Runtime's SDK
(`withruntime`), built on the same client, so it gets that SDK's retries,
idempotency keys and errors. Importing `withruntime` alone does not load it.

```ts no-run
import { Sandbox } from "withruntime/vercel"; // was: from "@vercel/sandbox"
```

Python has the same, in `pip install withruntime`:

```python no-run
from withruntime.vercel import sandbox  # was: from vercel import sandbox
from withruntime.vercel.sandbox import sync as sandbox  # was: from vercel.sandbox import sync as sandbox
```

The JavaScript mapping was checked against `@vercel/sandbox` 3.8.0 on
15 October 2026. Python was checked against `vercel-sandbox` 0.9.1 on PyPI
(the `vercel.sandbox` module of `vercel` 0.12.0) on 15 October 2026.
0.9.0 added `get_drive`, which raises `NotSupportedError` like the other
Drive calls.

Python review, 15 October 2026: each pinned wheel and sdist matched its
SHA-256 in `compatibility-lock.json`, each new one the PyPI digest, and each
new wheel's source its sdist; they were compared file by file, nothing
installed or run. `vercel-sandbox` 0.9.1 changes only its version and its
`vercel-internal-core` floor (0.2.2); no sandbox source changes. `vercel`
0.12.0 moves `vercel.blob` into the separate `vercel-blob` package (a new
dependency), removing its own Blob code, and raises its floors
(`vercel-sandbox` 0.9.1). Blob is Vercel's storage product, which the
drop-in has never offered (`withruntime.vercel` exports `sandbox` and
`api`), so nothing changes; the inventory's 684 Python items are unchanged.

## Keys

The package uses, in order: a Runtime key (`rtcloud_...`) passed as `token`,
`RUNTIME_API_KEY`, and the key `npx withruntime login` saved on this machine.
A Vercel token or OIDC token is never sent anywhere: passed as `token` while
`RUNTIME_API_KEY` is not set, it throws `AuthenticationError` (Python:
`SandboxCredentialsError`). `teamId` and `projectId` mean nothing on Runtime and
are ignored.

## What a sandbox gets

- **Machine:** Vercel's default, 2 vCPUs with 2048 MiB each.
  `resources: { vcpus }` sets another, with 2048 MiB per vCPU.
- **Timeout:** none unless you pass one: the sandbox runs while it works and
  pauses itself when idle. A `timeout` is kept as a Runtime time limit, which
  runs 60 seconds to an hour. A longer `timeout` (Python `execution_time_limit`) starts with an
  hour's lease, and the sandbox object renews it toward the timeout while it
  lives, never past it; once the program ends, the sandbox pauses within an
  hour. `extendTimeout` moves the end later, as often as needed.
- **Persistence:** persistent by default, as in Vercel. `stop()` and the end of
  the timeout pause the sandbox, keeping its files and also its memory and
  processes. `Sandbox.get({ name })`, or the next command or file call, wakes
  it. A paused sandbox is kept for Runtime's retention (30 days on credit, 7 on
  the trial, or `snapshotExpiration`) and billed as paused storage. With
  `persistent: false`, `stop()` ends the sandbox. `delete()` always ends it.
- **Ports:** each port in `ports` is shared at a public HTTPS address (a Runtime
  preview) when the sandbox is created, so `domain(port)` answers at once. A
  browser sees a one-time page naming Runtime before the site.
- **Funding:** left to Runtime, as `withruntime`'s own `create()` does: the free
  trial while the account has trial time, then prepaid credit. Pass
  `withruntime: { create: { funding: "trial" } }` (Python:
  `runtime_create={"funding": "trial"}`) to use only the trial.
- **Anything else Runtime offers:** `withruntime: { create: { ... } }` sends
  Runtime's create fields as they are. `sandbox.withruntime` is the Runtime
  sandbox underneath. (The key is `withruntime` because Vercel's `runtime`
  names a Node.js or Python version.)

## Mapping

| Vercel Sandbox                                                        | On Runtime                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox.create({ name, timeout, resources, env, tags, ports })`      | `sandboxes.create` with `name`, `timeoutSeconds`, `vcpu` and `memoryMiB`, labels; `env` is given to every command run through this object.  |
| `image`, legacy `runtime`                                             | Vercel's managed images and runtimes are Runtime's stock image. Any other name must be a ready Runtime image with that name.                |
| `source: { type: "git", url, depth, revision, username, password }`   | Cloned into the working directory after create; credentials reach git through the environment.                                              |
| `source: { type: "tarball", url }`, `{ type: "snapshot" }`            | Downloaded and unpacked into the working directory; a Runtime snapshot, with its own shape.                                                 |
| `networkPolicy`, `updateNetworkPolicy`                                | Runtime network rules: `allow-all`, `deny-all`, or a list of domains and subnets to allow and deny.                                         |
| `Sandbox.get({ name })`, `getOrCreate`, `list({ tags })`              | The newest live sandbox with that name (or a Runtime id), woken; create when missing; `sandboxes.list` with Vercel's paginator.             |
| `list({ namePrefix, since, until, sortBy, sortOrder, cursor })`       | Applied here over every sandbox the key sees; the cursor continues the same order. Python's `query_sandboxes` does the same.                |
| `createUser`, `asUser`, `createGroup`, `addUserToGroup`               | `useradd`, `groupadd` and `usermod` with `sudo`, as Vercel does; a user's commands run under `sudo -u` in its home, its files given to it.  |
| `Sandbox.fork({ sourceSandbox, name })`                               | A Runtime fork, which copies memory and processes too.                                                                                      |
| `runCommand(cmd, args)`, `runCommand({ cmd, args, cwd, env, sudo })`  | `exec` of the argv without a shell. `sudo` runs it under `sudo --preserve-env`. A non-zero exit is a result. Past `timeoutMs` it exits 137. |
| `stdout`, `stderr` writers, `detached: true`, `logs()`, `wait()`      | Output streams to the writers; a detached command is a Runtime process, its logs followed from the start.                                   |
| `getCommand(cmdId)`, `kill(signal)`                                   | Runtime processes by id; signals by name or number.                                                                                         |
| `writeFiles`, `readFile`, `readFileToBuffer`, `downloadFile`, `mkDir` | Runtime's files API. `mode` is set with `chmod`. A missing file is `null`, as in Vercel.                                                    |
| `sandbox.fs`                                                          | `node:fs/promises` over the files API and coreutils, with Node's error codes.                                                               |
| Paths                                                                 | Relative paths resolve from `/vercel/sandbox`, which is `/workspace`. A command that names `/vercel/sandbox` finds a link to it.            |
| `domain(port)`, `update({ ports })`                                   | The public preview of that port; ports added or removed.                                                                                    |
| `stop()`, `delete()`, `extendTimeout(ms)`                             | `pause` (persistent) or `stop`; `stop`; `extend`.                                                                                           |
| `update({ timeout, networkPolicy, snapshotExpiration })`              | A new timeout (earlier only while the lease has not reached it), network rules, retention.                                                  |
| `snapshot()`, `Snapshot.get`, `Snapshot.list`, `snapshot.delete()`    | A verified disk-only capture, then the source stops; restored snapshots start fresh processes; `snapshots.get`, `list`, `delete`.           |
| Error classes                                                         | `APIError` with a `response` whose status is Runtime's and `json` of `{ error: { code, message } }`; also `code`, `hint` and `requestId`.   |
| Python: `create_sandbox`, `run_process`, `create_process`, `box.fs`   | The same mapping; operations await or work as context managers, which stop and by default destroy the sandbox; readers iterate by line.     |

## Gaps

Each of these throws `NotSupportedError` before anything happens. Its
`feature` names the gap and its `alternative` says what to use.

| Vercel Sandbox                                             | Use instead                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| An `image` with no Runtime image of that name              | Build it: `npx withruntime images build --dockerfile Dockerfile --name <image>`.                      |
| Drives (`mounts`), `networkId`                             | Runtime volumes through `withruntime: { create: { volumes } }`; network rules.                        |
| A region outside the US, `failoverRegions`                 | Runtime runs in one US region.                                                                        |
| Network rules that transform or forward requests           | Allow the domain and store the credential as a Runtime secret for it: the sandbox sees a placeholder. |
| A `timeout` earlier than the current lease's end           | Stop the sandbox when you are done with it.                                                           |
| Sessions (`currentSession`, `listSessions`)                | A Runtime sandbox is its own session.                                                                 |
| `openInteractive` (Python: `open_interactive`)             | `sandbox.withruntime.terminal(...)` or `npx withruntime sandboxes shell <id>`.                        |
| `update` of tags, resources, persistence or region         | Create a new sandbox with them.                                                                       |
| Overrides on `Sandbox.fork`                                | Fork, then change what Runtime can change.                                                            |
| `delete({ deleteOrphanSnapshots: true })`, `Snapshot.tree` | Delete snapshots one by one; `Snapshot.list`.                                                         |
| `Drive`, `defineSandboxProxy`                              | Runtime volumes; `sandbox.withruntime.previews`.                                                      |
| `keepLastSnapshots`                                        | Manage saved snapshots with `Snapshot.list` and `snapshot.delete`.                                    |

Explicit snapshots require the released native disk-capture capability; a server
that does not confirm disk-only capture is refused. If capture succeeds but the
source cannot finish stopping, the error retains `snapshotId` and
`sourceSandboxId` so the saved filesystem remains recoverable. JavaScript exposes
them in `error.json.error.details` for API errors and directly on other errors;
Python exposes them in `error.data` for API errors and directly on other errors.
`snapshot_source_stop_timeout` means the source is still stopping after its wait;
a failed stop request keeps its original error code. These contracts remain
partial; controlled package comparisons do not prove hosted restoration.

Some differences are not refusals:

- A persistent sandbox keeps its memory and processes as well as its files
  across `stop()`: they carry on after a wake, where Vercel starts them again.
- Commands run as the sandbox owner, `runtime`, with passwordless `sudo`.
  `pwd` prints `/workspace`.
- Runtime's stock image is Ubuntu 24.04 with Python 3.12, Node.js 24 and Bun;
  Vercel's `universal` has Python 3.14.
- A git source is cloned into the working directory itself.

## JavaScript qualification, 15 October 2026

Reviewed the exact published npm tarballs for `@vercel/sandbox` 3.6.1 → 3.7.0
→ 3.8.0 (3.7.0 is the only stable release between them). 3.6.1 matched its
SHA-512 in `compatibility-lock.json`; 3.7.0 and 3.8.0 matched
`npm view @vercel/sandbox@<version> dist.integrity` (3.8.0:
`sha512-2ib+Dl8W...`). No downloaded package code was installed or executed
outside the oracle's frozen install.

The source maps name six changed TypeScript files and one new one
(`utils/pipe-stdin.ts`); CommonJS and ES-module builds match. `index.d.ts`
exports nothing new. The changes and their dispositions:

| Upstream change                                                                                                                                                                                                                                                                                                                                                                                                                                    | Drop-in disposition                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.7.0: `runCommand({ stdin: true, detached: true })` keeps the command's stdin open; `stdin: true` without `detached` throws `TypeError` before anything runs. Unset or false, stdin is empty, as before.                                                                                                                                                                                                                                          | Followed. The process is spawned with Runtime's piped stdin (`stdinMode: "pipe"`); the same `TypeError` message is thrown before any request. Without `stdin`, nothing changes.                                                                                                                                                                                                   |
| 3.7.0: `Command.writeStdin(data, { abortSignal })` and `closeStdin({ abortSignal })`. Writes are queued in call order, chunked, resent with byte offsets so retries never duplicate; after a write that may be partial, later writes are refused (`closeStdin` still works).                                                                                                                                                                       | Followed on Runtime's process input (`:write` with `offset` and `eof`), which already resends by offset, so no byte is written twice. Writes are queued in call order. A failed write refuses later ones with upstream's message, unless the API rejected a single request with a 4xx, which applied none of it. A `Command` from `getCommand` reads its offset from the process. |
| 3.7.0: `CommandFinished.writeStdin`/`closeStdin` always throw: the command has exited.                                                                                                                                                                                                                                                                                                                                                             | Followed with the same messages.                                                                                                                                                                                                                                                                                                                                                  |
| 3.7.0: `stdin` may be a `Readable`, attached or detached. It is written with backpressure and stdin closes when it ends; the stream is never ended or destroyed. Attached: a piping failure kills the command and rejects `runCommand`. Detached: `wait()` rejects (and `stdinPipe` clears). The command exiting or no longer accepting input (404, `command_stdin_unavailable`) stops piping quietly. `Command.stdinPipe` is the (internal) pipe. | Followed. An attached command with a stream starts as a process and waits on its output, streaming to `stdout`/`stderr` writers as before. Reading pauses past 512 KiB waiting. Runtime's "input closed" answer (409 `stdin_closed`) or a 404 stops piping quietly, as upstream's does. `stdinPipe` is exposed the same way.                                                      |
| 3.7.0: `SandboxUser.runCommand` passes `stdin`; 3.8.0 also passes `onStart`.                                                                                                                                                                                                                                                                                                                                                                       | Followed: both reach the sandbox's `runCommand` through the user's `sudo -u` wrapper.                                                                                                                                                                                                                                                                                             |
| 3.8.0: `runCommand({ onStart })`, only when not detached (the type forbids it with `detached: true`; upstream ignores it there): called with the running `Command` as soon as it starts and awaited before `runCommand` resolves.                                                                                                                                                                                                                  | Followed with the same type. The command starts as a Runtime process so its `Command` (id, `kill`, `logs`) exists before it exits; output and truncation are reported as for any attached command.                                                                                                                                                                                |
| `APIClient.writeCommandStdin` and its stdin retry policy (429 `Retry-After`, 502/503/504 resends, offset probes); `CommandStdinResponse` validator.                                                                                                                                                                                                                                                                                                | Internal; `APIClient` is not exported. Runtime's transport and offsets cover resends.                                                                                                                                                                                                                                                                                             |
| `@vercel/oidc` 3.2.0 → 4.0.0 (now depending on `@vercel/cli-config` and `@vercel/cli-exec`).                                                                                                                                                                                                                                                                                                                                                       | The drop-in never uses Vercel OIDC: a Vercel or OIDC token still throws `AuthenticationError`. Only the oracle's lock changes.                                                                                                                                                                                                                                                    |
| Declarations reorder existing status union members; README documents stdin; the package and internal version advance.                                                                                                                                                                                                                                                                                                                              | No adapter change.                                                                                                                                                                                                                                                                                                                                                                |

`tests/vercel-3-8.test.ts` (12 cases) runs the real Runtime transport over
controlled HTTP: piped spawn, write order and offsets, the `TypeError`,
empty stdin by default, finished-command refusals, partial-write refusal and
4xx recovery, an attached and a detached `Readable` (end, failure with kill,
quiet stop on `stdin_closed`), `onStart` ordering and `SandboxUser`
pass-through. Eleven fail before the adapter change (the twelfth, empty stdin
by default, guards existing behaviour). They do not prove live-host
behaviour; the provider remains `partial`. `compat-inventory.json` now counts
`writeStdin`, `closeStdin`, `stdinPipe` and the `stdin`/`onStart` options
present (and `CommandFinished`'s stdin calls refused, as upstream's are).

## JavaScript qualification, 8 October 2026

Reviewed the exact published npm tarballs for `@vercel/sandbox` 3.5.1 → 3.6.1.
Both tarballs matched their registry SHA-512 integrities; the 3.6.1 value in
`compatibility-lock.json` came from `npm view @vercel/sandbox@3.6.1 dist.integrity`.
No downloaded package code was installed or executed.

The distribution diff changes 31 files, representing five TypeScript source
files in the source maps: `drive.ts`, `version.ts`, `api-client.ts`,
`base-client.ts` and `validators.ts`. CommonJS and ES-module source-map
contents match. The changes and their dispositions:

| Upstream change                                                                                                                                                                                             | Drop-in disposition                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Drive.get({ name, signal?, token?, teamId?, projectId?, fetch? })` retrieves an existing drive without creating one. Internally it sends GET to the encoded drive-name path with `projectId` in the query. | Already refused by the `Drive` export before credentials or requests, with `NotSupportedError` naming `runtime.volumes` and `withruntime: { create: { volumes } }`.                                                                                                                                                   |
| `drive.fork({ name, signal? })` creates a drive inheriting data, maximum size and region. Its POST uses the source drive name, `projectId` query and `{ name }` body.                                       | All Drive construction and retrieval remain refused, so no unsupported Drive instance can reach this call. Use Runtime volumes; no Vercel Drive fork is claimed.                                                                                                                                                      |
| `drive.parentDriveId` and `drive.rootDriveId`, optional strings, expose ancestry. Drive response validation now retains those fields, including list/get/create/fork/update responses.                      | The same Drive refusal applies. No ancestry or Vercel drive metadata is fabricated.                                                                                                                                                                                                                                   |
| Streaming `runCommand` disables retry of the command POST. After receiving its command id, a cut, early EOF or incomplete final JSON record recovers logs and then waits for the same command.              | Mapped through native Runtime process ids and byte cursors: no command is restarted after its id arrives. Initial Runtime transport retries use the same idempotency key. Attached commands now throw `StreamError` with `output_truncated` when recovery reports missing bytes, as detached commands already do.     |
| `Command.logs()` reconnects interrupted log bodies up to twice, waiting 200 ms then 400 ms, skipping previously delivered stdout/stderr characters separately.                                              | Mapped through Runtime's byte cursor across both streams. Runtime follows stream slices and connection cuts; repeated empty streams stop after four reads, and continuous failures have a five-minute recovery budget. These are Runtime's recovery limits, not Vercel's retry timing.                                |
| `getCommand`, including waiting for completion, retries failures while reading the response body, up to twice. Parsing can consume the already-read body.                                                   | Native Runtime JSON reads already retry through the complete body, with the client's `maxRetries` (four by default). Completion comes from the native process output's exit event rather than Vercel's command-wait endpoint.                                                                                         |
| Stream parsing now preserves UTF-8 across chunks, classifies connection cuts and incomplete final JSON, closes readers and propagates cancellation or application errors without recovery.                  | Runtime already uses a persistent `TextDecoderStream`, closes its readers and resumes at the byte cursor after a cut or partial record. Permanent structured API errors and cancellation are not replayed. Runtime also retries parse failures as stream cuts; it does not expose Vercel's private `ConnectionError`. |
| Sandbox/snapshot declarations reorder existing status union members; the package and internal version advance.                                                                                              | No status values, package exports, dependencies or other caller signatures change. No adapter change needed.                                                                                                                                                                                                          |

`tests/vercel-3-6.test.ts` exercises the real Runtime transport with controlled
HTTP responses: attached and detached recovery, stdout/stderr ordering, one-byte
UTF-8 chunks, incomplete JSON, no command replay, bounded empty-stream failure,
permanent errors, Drive lookup refusal and missing-output refusal. Before the
adapter change, both missing-output cases resolved successfully instead of
throwing. These tests do not prove live-host recovery, isolation, performance
superiority or full Vercel compatibility; the provider remains `partial`.

`tests/compat/reference.bun.lock` has no Vercel entry. The consumer declaration
check in `tests/compat/check-consumers.ts` reads the main compatibility lock and
requires the extracted upstream version to match it; neither needs a separate
Vercel version edit. The separate oracle was not run for this source review.

## Tests

`bun run test` in `packages/cloud-sdk` runs the unit tests of both languages
against fakes of Runtime's SDKs: `tests/vercel` here and
`sdks/python/tests/test_vercel.py`.

The end-to-end tests run the judge panel's Vercel Sandbox eval and Vercel's
Python examples, unmodified but for the import, against the real API. They
refuse to start unless the free trial has an hour left, and end every sandbox
they create. They are not part of `bun run test`.

```bash no-run
bun packages/cloud-sdk/scripts/dropin-e2e.ts          # JavaScript, with the Daytona quickstart
python3 sdks/python/scripts/dropin_e2e.py             # Python, with the Daytona quickstart
```
