# Code written for Daytona, on Runtime

Supported sandbox calls from [Daytona](https://www.daytona.io)'s SDK keep
their call shapes on Runtime Cloud after changing the import. It is part of Runtime's SDK (`withruntime`), built on
the same client, so it gets that SDK's retries, idempotency keys and errors.
Importing `withruntime` alone does not load it.

```ts no-run
import { Daytona } from "withruntime/daytona"; // was: from "@daytona/sdk" or "@daytonaio/sdk"
```

Python has the same, in `pip install withruntime`:

```python no-run
from withruntime.daytona import Daytona  # was: from daytona import Daytona
from withruntime.daytona import AsyncDaytona  # was: from daytona import AsyncDaytona
```

The mapping was written against `@daytona/sdk` 0.220.0 and `daytona` 0.220.0
on PyPI, and checked against `@daytona/sdk` and `daytona` 0.225.0 on
18 October 2026 (below, "0.225.0"). The exact releases and artifact hashes
are kept in `compatibility-lock.json`.

## Keys

The package uses, in order: a Runtime key (`rtcloud_...`) passed as `apiKey`,
`RUNTIME_API_KEY`, a Runtime key left in `DAYTONA_API_KEY`, and the key
`npx withruntime login` saved on this machine. A Daytona key is never sent
anywhere. If one is passed as `apiKey` and `RUNTIME_API_KEY` is not set, the
constructor throws `DaytonaAuthenticationError`. `apiUrl` is ignored: the
package talks only to Runtime.

## What a sandbox gets

- **Machine:** Daytona's default, 1 vCPU, 1 GiB memory and 3 GiB disk.
  `resources: { cpu, memory, disk }` (GiB) sets another.
- **Stopping:** `stop()` pauses the sandbox, keeping its files and its memory,
  and `start()` carries on with processes still running. A stopped sandbox is
  kept for Runtime's retention: 30 days on credit, 7 on the trial, or
  `autoDeleteInterval` minutes rounded up to whole days. `delete()` ends it.
  An `ephemeral` sandbox (or `autoDeleteInterval: 0`) ends on `stop()`.
- **Auto-stop:** `autoStopInterval` minutes (default 15; `0` never) is the
  sandbox's idle pause: it pauses after that long with nothing happening in
  it, counted by the sandbox itself, so a long command is never paused for
  want of calls. It has no time limit. `ttlMinutes` gives it one, and with
  it Daytona's own rule: the sandbox pauses after `autoStopInterval` minutes
  without a call through the adapter, each call moving the limit on, and ends
  at the deadline.
- **Funding:** left to Runtime, as `withruntime`'s own `create()` does: the free
  trial while the account has trial time, then prepaid credit. Pass
  `withruntime: { create: { funding: "trial" } }` to `new Daytona(...)` or to
  `create` (Python: `runtime_create={"funding": "trial"}`) to use only the
  trial.
- **Anything else Runtime offers:** `withruntime: { create: { ... } }` sends
  Runtime's create fields as they are. `sandbox.withruntime` is the Runtime
  sandbox underneath, with previews, network rules, snapshots, the desktop and
  terminals.

## Mapping

| Daytona                                                                       | On Runtime                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daytona.create()`, `create({ snapshot })`                                    | `sandboxes.create`. Daytona's own snapshots (`daytona-*`) are Runtime's stock image. Any other name is a ready Runtime image of that name, then a Runtime snapshot of that name.                                                                                           |
| `create({ image: "python:3.12" })`                                            | Built once as a Runtime image from the registry reference (named after it), then reused. `onSnapshotCreateLogs` receives the build log.                                                                                                                                    |
| `create({ image: Image.debianSlim(...).pipInstall(...)... })`                 | The Dockerfile Daytona's `Image` stands for, with its local files, built as a Runtime image named after its content and reused.                                                                                                                                            |
| `resources`, `envVars`, `labels`, `name`, `volumes`                           | `vcpu`, `memoryMiB`, `diskMiB`; environment given to every command; labels; name; Runtime volumes by id or by name.                                                                                                                                                        |
| `setLabels` (Python `set_labels`)                                             | Replaces customer labels while preserving the language and Runtime compatibility labels; reconnects retain the language.                                                                                                                                                   |
| `networkBlockAll`, `networkAllowList`, `domainAllowList`, `outboundProxyUrl`  | Runtime network rules (`internet: false`, or an `allow` list); the proxy as `HTTP_PROXY` and `HTTPS_PROXY` for commands.                                                                                                                                                   |
| `public: true`, `setPublic` (Python `set_public`)                             | `getPreviewLink(port)` shares the port publicly; without it, privately with a token. `setPublic` turns every port already shared public or private at once, at the same address.                                                                                           |
| `language`                                                                    | The language of `codeRun`, kept in Daytona's `code-toolbox-language` label so a sandbox found later keeps it.                                                                                                                                                              |
| `daytona.get(idOrName)`, `daytona.list(query)`                                | `sandboxes.get`, or the newest live sandbox with that name; `sandboxes.list` by labels and states, then Daytona's other filters (`id` and `name` prefixes, CPU, memory, disk, dates), `sort` and `order` here. Awaiting `list()` gives the older `{ items, total }` shape. |
| `process.executeCommand(cmd, cwd, env, timeout)`                              | `exec` under bash with stderr joined to stdout, as Daytona's `result`, streamed so the whole output comes back. A non-zero exit is a result. Past `timeout` (seconds): `DaytonaProcessExecutionTimeoutError`.                                                              |
| `process.codeRun(code, { argv, env })`                                        | `python3 -c`, `node -e` or `bun -e` by the sandbox's language. `artifacts.charts` is always empty.                                                                                                                                                                         |
| `createSession`, `executeSessionCommand`, `getSessionCommandLogs`             | One bash per session, kept running: directory, variables and functions carry from one command to the next. `runAsync` returns at once; logs stream to callbacks.                                                                                                           |
| `sendSessionCommandInput`, `getSession`, `getSessionCommand`, `deleteSession` | Input to the session's shell, which the running command reads; the commands sent through this object; killing the shell.                                                                                                                                                   |
| `fs.uploadFile(s)`, `downloadFile(s)`, `listFiles`, `getFileDetails`          | Runtime's files API. Relative paths resolve from `/workspace`. `owner` and `group` are always `""`.                                                                                                                                                                        |
| `fs.createFolder`, `deleteFile`, `moveFiles`, `setFilePermissions`            | `mkdir -m`, `files.remove`, `files.rename`, `chmod` and `sudo chown`.                                                                                                                                                                                                      |
| `fs.findFiles`, `searchFiles`, `replaceInFiles`                               | `grep -rn`, a files glob, and a read and write of each file.                                                                                                                                                                                                               |
| `git.clone`, `status`, `add`, `commit`, `push`, `pull`, branches              | The sandbox's git. Credentials reach git through the environment, never the command line.                                                                                                                                                                                  |
| `codeInterpreter.runCode`, contexts                                           | Runtime's Python interpreter. The sandbox's `envVars` reach code through a context made once for them.                                                                                                                                                                     |
| `start`, `stop`, `pause`, `archive`, `delete`, `fork`, `createSnapshot`       | `wake`, `pause` (or `stop` when ephemeral), `pause`, `pause`, `stop`, Runtime's fork with memory, a Runtime snapshot with that name.                                                                                                                                       |
| `getPreviewLink(port)`                                                        | A Runtime preview. Send its token as `x-runtime-preview-token`; Daytona's header is `x-daytona-preview-token`.                                                                                                                                                             |
| `getUserHomeDir`, `getWorkDir`, `user`                                        | `/workspace`, and `daytona`, so `/home/daytona` (linked to `/workspace` the first time something names it) works.                                                                                                                                                          |
| `create({ user })` (Python `os_user`)                                         | The user must exist in the image, as on Daytona. Commands, sessions and terminals run as it through `sudo`; files written through `fs` are given to it. It joins the owner's group, so both can share `/workspace`.                                                        |
| `process.createPty`, `connectPty`, `listPtySessions`, `resizePtySession`      | A shell started with a terminal, which outlives the connection: `disconnect()` leaves it running, `connectPty` attaches again with what it printed so far, `killPtySession` ends it.                                                                                       |
| `computerUse.mouse`, `keyboard`, `screenshot`, `display`, `recording`         | Runtime's desktop. `start()` installs it the first time, which takes a minute or two. Key names are Daytona's or xdotool's. `mouse.down` and `up` hold and release a button; `scroll` goes up, down, left or right.                                                        |
| `daytona.snapshot.create`, `get`, `list`, `delete`                            | Runtime images built, found, listed and deleted by name.                                                                                                                                                                                                                   |
| `daytona.volume.get`, `list`, `delete`                                        | Runtime volumes by name.                                                                                                                                                                                                                                                   |
| Error classes                                                                 | Daytona's names and parents, by HTTP status. Each also carries Runtime's `code`, `hint` and `requestId`, with the original error as `cause`.                                                                                                                               |

## Gaps

Each of these throws `NotSupportedError` before anything happens. Its
`feature` names the gap and its `alternative` says what to use.

| Daytona                                                               | Use instead                                                                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A snapshot name with no Runtime image or snapshot                     | `daytona.snapshot.create({ name, image })` here, or `npx withruntime images build`. This throws `DaytonaNotFoundError`.                                                                 |
| GPUs, `spot`, `linkedSandbox`, `secrets`, `otelEndpointOverride`      | Runtime runs Linux on CPUs. For `secrets`, a Runtime secret (`npx withruntime secrets set NAME --host <host>`): the sandbox sees a placeholder. For telemetry, `runtime.otel.create()`. |
| A `target` other than `us` (the client's or a create's), `jwtToken`   | Runtime runs in one US region and signs in with keys.                                                                                                                                   |
| The entrypoint session, language servers                              | Sessions with `runAsync`.                                                                                                                                                               |
| Screenshots of a region, with the cursor, scaled, or as WebP          | The whole screen as PNG or JPEG; crop and scale it yourself.                                                                                                                            |
| `computerUse.accessibility`, the desktop's processes one by one       | Screenshots with the mouse and keyboard; `computerUse.getStatus()`, `stop()` and `start()`.                                                                                             |
| `keyboard.down` and `up`, `modifiers` on a click, drag or scroll      | `keyboard.press(key, modifiers)` or `keyboard.hotkey("ctrl+shift+t")`: the keys pressed together at once.                                                                               |
| `clicks` above 2                                                      | One click, or two with `double`; to select a line, click once and press shift+End.                                                                                                      |
| `resize`, `recover`                                                   | Set labels and resources at create; create a new sandbox.                                                                                                                               |
| Signed preview URLs, signed upload and download URLs, SSH access      | `getPreviewLink`, `fs.uploadFile` and `downloadFile`, `npx withruntime sandboxes ssh <id>`.                                                                                             |
| `getMetrics`                                                          | `sandbox.withruntime.metrics()`: its CPU and memory over time.                                                                                                                          |
| `Image.pipInstallFromPyproject`, snapshot `resources` or `entrypoint` | `pipInstallFromRequirements`; resources at create; a session after create.                                                                                                              |
| `volume.create(name)`                                                 | Runtime volumes have a size: `runtime.volumes.create({ name, sizeMiB })`.                                                                                                               |
| `secret`, `warmPool`                                                  | A Runtime secret for credentials; Runtime starts from warm templates already.                                                                                                           |
| `runCode(code, { envs })`                                             | `envVars` at create, or `os.environ` in the code.                                                                                                                                       |
| Listing by `isPublic`, `snapshots` or `autoDestroyAt`                 | Filter by a label you set at create.                                                                                                                                                    |

File download timeouts are seconds, including buffer and local-path overloads
and batches. A batch shares one deadline and stops starting later files once
it expires. JavaScript `downloadFileStream(path, { timeout, signal })` also
bounds and cancels the stream. An incomplete local download is never published
as the completed file.

Some differences are not refusals:

- A session runs one command at a time. A command sent while another runs
  waits for it, as it would typed into a shell. Sessions made by another
  client are found by name, but only their output from then on is known.
- `autoArchiveInterval` is recorded only: Runtime has no archive tier.
- Runtime's stock image is Ubuntu 24.04 with Python 3.12, Node.js 24 and Bun.

## 0.225.0, 18 October 2026

Reviewed the published npm tarballs for `@daytona/sdk`, `@daytona/api-client`,
`@daytona/toolbox-api-client` and `@daytona/analytics-api-client` 0.224.1 →
0.225.0, and the PyPI wheel and sdist for `daytona` 0.224.1 → 0.225.0, each its
registry's latest when checked. Every pinned file matched the hash already in
`compatibility-lock.json`, every new file its registry's SHA-512 integrity or
SHA-256 digest, and the wheel's Python source is byte for byte its sdist's.
Nothing was installed, imported or run. No declaration of `@daytona/sdk` and no
Python source of `daytona` changed: only versions and the exact pins on the
three API clients. The one API change is in `@daytona/api-client` (and its
PyPI twins): `GpuType` gains `B200`.

| Upstream change | Drop-in disposition                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GpuType.B200`  | Exported, with every other `GpuType`. A create naming any GPU type is refused (`NotSupportedError`, "Runtime runs sandboxes on CPUs") before anything is made. |

Two gaps near it are closed with the review. `@daytona/sdk` re-exports
`GpuType`, `SnapshotState`, `SandboxListSortField`, `SandboxListSortDirection`,
`SandboxClass`, `ListSecretsPaginatedSortEnum` and
`ListSecretsPaginatedOrderEnum`, and `daytona` exports `GpuType`,
`SandboxClass`, `SandboxListSortField` and `SandboxListSortDirection`; the
drop-ins exported none of them, so code importing one failed. They are exported
now with upstream's values, and the sort enums drive `list`. Python refused
`Resources(gpu=...)` but made a CPU sandbox for `Resources(gpu_type=...)`
alone, which Daytona sends as a GPU request; it is refused now, as in
TypeScript. `tests/daytona/daytona-0-225-0.test.ts` and
`sdks/python/tests/test_daytona_0_225_0.py` fail without this change. The
oracle was not run against the new release, since it executes Daytona's code;
the provider remains marked `partial`.

## 0.224.1, 15 October 2026

Reviewed the published npm tarballs for `@daytona/sdk`, `@daytona/api-client`,
`@daytona/toolbox-api-client` and `@daytona/analytics-api-client` 0.223.1 →
0.224.1, and the PyPI wheel and sdist for `daytona` 0.223.1 → 0.224.1 (0.224.0,
published between them, was also fetched: on npm, 0.224.1 adds only the stream
decoder change and the dependency floors below; on PyPI it is the same source
with a new version). Each was its registry's latest when checked. Every pinned
file matched the hash already in `compatibility-lock.json`, and every new file
matched its registry's SHA-512 integrity or SHA-256 digest; the wheel's Python
source is byte for byte its sdist's. Nothing was installed, imported or run.
The three API clients changed only their version. `@daytona/sdk` changed
`Daytona` (create params and the client's `target` docs), `Snapshot` (docs),
and its output stream decoder, ESM and CommonJS alike; `daytona` changed the
same, sync and async, plus the async PTY handle.

| Upstream change                                                                                                                                                                      | Drop-in disposition                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daytona.create({ target })` (Python `target` on `CreateSandboxFromSnapshotParams` and `CreateSandboxFromImageParams`) picks the region for that create, over the client's `target`. | Followed, in both languages. `"us"` or none creates the sandbox in Runtime's one region; any other is refused with the same `NotSupportedError` as a client `target`, before anything is built or made. Before, TypeScript dropped it without a word and Python raised `TypeError`. |
| The client's `target` (and `DAYTONA_TARGET`) and a snapshot's `regionId` (Python `region_id`) are documented as the default region, overridden per call.                             | Documentation only; the client's `target` is checked as before. TypeScript already refused a snapshot `regionId`; Python accepted `region_id` and dropped it, and now refuses it the same way (`""` still means the default).                                                       |
| The output stream decoder finds an stdout or stderr marker that ends exactly at the end of a message, which it held back before, and buffers in linear time.                         | Not applicable: the drop-in takes output from Runtime's exec, which keeps stdout and stderr apart, and never parses Daytona's markers.                                                                                                                                              |
| Python `AsyncPtyHandle.wait()` shields its reader, so cancelling a caller's wait (for example `asyncio.wait_for`) leaves the PTY connected.                                          | Already so: the drop-in's `wait()` awaits `asyncio.shield` of its reader task.                                                                                                                                                                                                      |
| `@daytona/sdk` requires `ws` exactly 8.22.0 (was ^8.22.0), `@aws-sdk/client-s3` and `lib-storage` ^3.1146.0 and `shell-quote` ^1.12.0.                                               | The oracle's `bun.lock` moves with them (ws stays 8.22.0).                                                                                                                                                                                                                          |

`tests/daytona/daytona-0-224-1.test.ts` and
`sdks/python/tests/test_daytona_0_224_1.py` check a create's `target` both
ways, that it overrides the client's, and (Python) that a snapshot's
`region_id` is refused; they fail without this change. The oracle was not run
against the new release, since it executes Daytona's code; the provider
remains marked `partial`.

## 0.223.1, 9 October 2026

Reviewed the published npm tarballs for `@daytona/sdk`, `@daytona/api-client`,
`@daytona/toolbox-api-client` and `@daytona/analytics-api-client` 0.223.0 →
0.223.1, and the PyPI wheel and sdist for `daytona` 0.223.0 → 0.223.1. Each was
its registry's latest when checked. Every pinned file matched the hash already
in `compatibility-lock.json`, and every new file matched its registry's SHA-512
integrity or SHA-256 digest; each wheel's Python source is byte for byte its
sdist's. Nothing was installed, imported or run. The three API clients changed
only their version. `@daytona/sdk` changed `Sandbox` and `Process` (ESM and
CommonJS alike), and `daytona` the same two modules, sync and async.

| Upstream change                                                                                                                                                                                     | Drop-in disposition                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.setPublic(isPublic)` (Python `set_public(public, request_timeout=None)`) makes the sandbox's preview URLs public or private, and sets `sandbox.public`.                                    | Followed, in both languages. Every port already shared whose visibility differs is shared again with the new one, at the same address, and later `getPreviewLink` calls use it. Without credit Runtime refuses a public share (`public_preview_not_allowed`) and `public` is unchanged. |
| `executeCommand` (Python `exec`) documents that commands run under zsh, bash or sh (zsh in Daytona's images), how to start a server in the background, and that `nproc` may report the host's CPUs. | Documentation only. The drop-in keeps running commands under bash, which is what Daytona's quoting advice is for; a sandbox's `nproc` reports its own vCPUs.                                                                                                                            |
| `getPreviewLink` and `getSignedPreviewUrl` (Python `create_signed_preview_url`) document the token header, the API key as a bearer token, and a longer expiry.                                      | Documentation only. A Runtime private preview takes its token as `x-runtime-preview-token`; signed preview URLs stay refused, as above.                                                                                                                                                 |
| `@daytona/sdk` requires `shell-quote` ^1.11.0, was ^1.8.2.                                                                                                                                          | The oracle's `bun.lock` already resolved 1.11.0.                                                                                                                                                                                                                                        |

`tests/daytona/daytona-0-223-1.test.ts` and
`sdks/python/tests/test_daytona_0_223_1.py` check `setPublic` both ways, that
a public port is not shared again, and the refusal without credit; they fail
without this change. The oracle was not run against the new release, since it
executes Daytona's code; the provider remains marked `partial`.

## Tests

`bun run test` in `packages/cloud-sdk` runs the unit tests of both languages
against fakes of Runtime's SDKs: `tests/daytona` here and
`sdks/python/tests/test_daytona.py`.

The end-to-end tests run Daytona's quickstart and guides, unmodified but for
the import, against the real API. They refuse to start unless the free trial
has an hour left, create one sandbox per language and end it. They are not part
of `bun run test`.

```bash no-run
bun packages/cloud-sdk/scripts/dropin-e2e.ts          # JavaScript, with the Vercel eval
python3 sdks/python/scripts/dropin_e2e.py             # Python, with the Vercel sample
```
