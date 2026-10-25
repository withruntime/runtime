# Code written for Daytona, on Runtime

Supported sandbox calls from [Daytona](https://www.daytona.io)'s SDK keep their
call shapes on Runtime Cloud after you change the import. This is part of
Runtime's SDK (`withruntime`). It uses the same client, so it gets that SDK's
retries, idempotency keys and errors. Importing `withruntime` alone does not
load it.

```ts no-run
import { Daytona } from "withruntime/daytona"; // was: from "@daytona/sdk" or "@daytonaio/sdk"
```

Python has the same, in `pip install withruntime`:

```python no-run
from withruntime.daytona import Daytona  # was: from daytona import Daytona
from withruntime.daytona import AsyncDaytona  # was: from daytona import AsyncDaytona
```

The mapping was written against `@daytona/sdk` 0.220.0 and `daytona` 0.220.0 on
PyPI. It was checked against `@daytona/sdk` and `daytona` 0.225.0 on 18 October
2026 (below, "0.225.0"). The exact releases and artifact hashes are kept in
`compatibility-lock.json`.

## Keys

The package uses these keys, in this order:

1. A Runtime key (`rtcloud_...`) passed as `apiKey`.
2. `RUNTIME_API_KEY`.
3. A Runtime key left in `DAYTONA_API_KEY`.
4. The key that `npx withruntime login` saved on this machine.

A Daytona key is never sent anywhere. If one is passed as `apiKey` and
`RUNTIME_API_KEY` is not set, the constructor throws `DaytonaAuthenticationError`.
`apiUrl` is ignored. The package talks only to Runtime.

## What a sandbox gets

- **Machine:** Daytona's default, 1 vCPU, 1 GiB of memory and a 3 GiB disk.
  `resources: { cpu, memory, disk }` (in GiB) sets another size.
- **Stopping:** `stop()` pauses the sandbox. It keeps the files, the memory and
  the running processes. `start()` resumes it, and the processes keep running. A
  stopped sandbox is kept under Runtime's retention. That is 30 days on credit, 7
  days on the trial, or `autoDeleteInterval` minutes, rounded up to whole days.
  `delete()` ends it. An `ephemeral` sandbox, or one with `autoDeleteInterval: 0`,
  ends on `stop()`.
- **Auto-stop:** `autoStopInterval` sets the idle time in minutes. The default is 15. `0` means never. This is the sandbox's idle pause. The sandbox pauses after
  that much time with nothing happening in it. The sandbox counts that time
  itself, so a long command is never paused because it made no calls. The sandbox
  has no time limit. Set `ttlMinutes` to give it one. Then Daytona's own rule
  applies: the sandbox pauses after `autoStopInterval` minutes without a call
  through the adapter. Each call moves the limit on. The sandbox ends at the
  deadline.
- **Funding:** left to Runtime, as `withruntime`'s own `create()` does. The free
  trial is used while the account has trial time. After that, prepaid credit is
  used. To use only the trial, pass `withruntime: { create: { funding: "trial" } }`
  to `new Daytona(...)` or to `create`. In Python, pass
  `runtime_create={"funding": "trial"}`.
- **Anything else Runtime offers:** `withruntime: { create: { ... } }` sends
  Runtime's create fields as they are. `sandbox.withruntime` is the Runtime
  sandbox underneath. It has previews, network rules, snapshots, the desktop and
  terminals.

## Mapping

| Daytona                                                                       | On Runtime                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daytona.create()`, `create({ snapshot })`                                    | `sandboxes.create`. Daytona's own snapshots (`daytona-*`) map to Runtime's stock image. Any other name is a ready Runtime image with that name, or else a Runtime snapshot with that name.                                                                                                      |
| `create({ image: "python:3.12" })`                                            | Built once as a Runtime image, from the registry reference. The image is named after that reference and reused. `onSnapshotCreateLogs` receives the build log.                                                                                                                                  |
| `create({ image: Image.debianSlim(...).pipInstall(...)... })`                 | The Dockerfile that Daytona's `Image` stands for, with its local files, built as a Runtime image. The image is named after its content and reused.                                                                                                                                              |
| `resources`, `envVars`, `labels`, `name`, `volumes`                           | `vcpu`, `memoryMiB` and `diskMiB`. Environment is given to every command. Labels, name, and Runtime volumes by ID or by name.                                                                                                                                                                   |
| `setLabels` (Python `set_labels`)                                             | Replaces the customer labels. It keeps the language and Runtime compatibility labels. Reconnects keep the language.                                                                                                                                                                             |
| `networkBlockAll`, `networkAllowList`, `domainAllowList`, `outboundProxyUrl`  | Runtime network rules (`internet: false`, or an `allow` list). The proxy is set as `HTTP_PROXY` and `HTTPS_PROXY` for commands.                                                                                                                                                                 |
| `public: true`, `setPublic` (Python `set_public`)                             | `getPreviewLink(port)` shares the port publicly. Without `public`, the port is shared privately, with a token. `setPublic` changes every port that is already shared, to public or private, at the same address.                                                                                |
| `language`                                                                    | The language used by `codeRun`. It is kept in Daytona's `code-toolbox-language` label, so a sandbox found later keeps it.                                                                                                                                                                       |
| `daytona.get(idOrName)`, `daytona.list(query)`                                | `sandboxes.get`, or the newest live sandbox with that name. `sandboxes.list` filters by labels and states. Daytona's other filters (`id` and `name` prefixes, CPU, memory, disk, dates) apply, and `sort` and `order` are set here. Awaiting `list()` gives the older `{ items, total }` shape. |
| `process.executeCommand(cmd, cwd, env, timeout)`                              | `exec` under bash, with stderr joined to stdout, as Daytona's `result`. The output streams, so the full output comes back. A non-zero exit code is a result, not an error. Past `timeout` (in seconds), it throws `DaytonaProcessExecutionTimeoutError`.                                        |
| `process.codeRun(code, { argv, env })`                                        | Runs `python3 -c`, `node -e` or `bun -e`, based on the sandbox's language. `artifacts.charts` is always empty.                                                                                                                                                                                  |
| `createSession`, `executeSessionCommand`, `getSessionCommandLogs`             | One bash per session, kept running. The directory, variables and functions carry over from one command to the next. `runAsync` returns immediately. Logs stream to callbacks.                                                                                                                   |
| `sendSessionCommandInput`, `getSession`, `getSessionCommand`, `deleteSession` | Sends input to the session's shell, which the running command reads. Lists the commands sent through this object. Kills the shell.                                                                                                                                                              |
| `fs.uploadFile(s)`, `downloadFile(s)`, `listFiles`, `getFileDetails`          | Runtime's files API. Relative paths resolve from `/workspace`. `owner` and `group` are always `""`.                                                                                                                                                                                             |
| `fs.createFolder`, `deleteFile`, `moveFiles`, `setFilePermissions`            | `mkdir -m`, `files.remove`, `files.rename`, `chmod` and `sudo chown`.                                                                                                                                                                                                                           |
| `fs.findFiles`, `searchFiles`, `replaceInFiles`                               | `grep -rn`, a files glob, and a read and write of each file.                                                                                                                                                                                                                                    |
| `git.clone`, `status`, `add`, `commit`, `push`, `pull`, branches              | The sandbox's git. Credentials reach git through the environment, never on the command line.                                                                                                                                                                                                    |
| `codeInterpreter.runCode`, contexts                                           | Runtime's Python interpreter. The sandbox's `envVars` reach the code through a context that is made once for them.                                                                                                                                                                              |
| `start`, `stop`, `pause`, `archive`, `delete`, `fork`, `createSnapshot`       | `wake`, then `pause` (or `stop` when ephemeral), then `pause`, `pause`, `stop`, Runtime's fork with memory, and a Runtime snapshot with that name.                                                                                                                                              |
| `getPreviewLink(port)`                                                        | A Runtime preview. Send its token as `x-runtime-preview-token`. Daytona's header is `x-daytona-preview-token`.                                                                                                                                                                                  |
| `getUserHomeDir`, `getWorkDir`, `user`                                        | `/workspace`, and `daytona`. So `/home/daytona` works, and it is linked to `/workspace` the first time something names it.                                                                                                                                                                      |
| `create({ user })` (Python `os_user`)                                         | The user must exist in the image, as on Daytona. Commands, sessions and terminals run as that user through `sudo`. Files written through `fs` are given to that user. The user joins the owner's group, so both can share `/workspace`.                                                         |
| `process.createPty`, `connectPty`, `listPtySessions`, `resizePtySession`      | A shell started with a terminal. It keeps running after the connection closes. `disconnect()` leaves it running. `connectPty` attaches again, with the output printed so far. `killPtySession` ends it.                                                                                         |
| `computerUse.mouse`, `keyboard`, `screenshot`, `display`, `recording`         | Runtime's desktop. `start()` installs it the first time, which takes a minute or two. Key names are Daytona's or xdotool's. `mouse.down` and `up` hold and release a button. `scroll` goes up, down, left or right.                                                                             |
| `daytona.snapshot.create`, `get`, `list`, `delete`                            | Runtime images, built, found, listed and deleted by name.                                                                                                                                                                                                                                       |
| `daytona.volume.get`, `list`, `delete`                                        | Runtime volumes, by name.                                                                                                                                                                                                                                                                       |
| Error classes                                                                 | Daytona's names and parent classes, chosen by HTTP status. Each error also carries Runtime's `code`, `hint` and `requestId`. The original error is the `cause`.                                                                                                                                 |

## Gaps

Each of these throws `NotSupportedError` before anything happens. The error's
`feature` names the gap. Its `alternative` says what to use.

| Daytona                                                               | Use instead                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A snapshot name with no Runtime image or snapshot                     | `daytona.snapshot.create({ name, image })` here, or `npx withruntime images build`. Without one of these, this throws `DaytonaNotFoundError`.                                                   |
| GPUs, `spot`, `linkedSandbox`, `secrets`, `otelEndpointOverride`      | Runtime runs Linux on CPUs. For `secrets`, use a Runtime secret (`npx withruntime secrets set NAME --host <host>`). The sandbox sees a placeholder. For telemetry, use `runtime.otel.create()`. |
| A `target` other than `us` (on the client or on a create), `jwtToken` | Runtime runs in one US region, and signs in with keys.                                                                                                                                          |
| The entrypoint session, language servers                              | Sessions with `runAsync`.                                                                                                                                                                       |
| Screenshots of a region, with the cursor, scaled, or as WebP          | The whole screen, as PNG or JPEG. Crop and scale it yourself.                                                                                                                                   |
| `computerUse.accessibility`, the desktop's processes one by one       | Screenshots with the mouse and keyboard. Use `computerUse.getStatus()`, `stop()` and `start()`.                                                                                                 |
| `keyboard.down` and `up`, `modifiers` on a click, drag or scroll      | `keyboard.press(key, modifiers)`, or `keyboard.hotkey("ctrl+shift+t")`. The keys are pressed together at once.                                                                                  |
| `clicks` above 2                                                      | One click, or two with `double`. To select a line, click once and press shift+End.                                                                                                              |
| `resize`, `recover`                                                   | Set labels and resources at create time. Or create a new sandbox.                                                                                                                               |
| Signed preview URLs, signed upload and download URLs, SSH access      | `getPreviewLink`, `fs.uploadFile` and `downloadFile`, or `npx withruntime sandboxes ssh <id>`.                                                                                                  |
| `getMetrics`                                                          | `sandbox.withruntime.metrics()`, which gives CPU and memory over time.                                                                                                                          |
| `Image.pipInstallFromPyproject`, snapshot `resources` or `entrypoint` | `pipInstallFromRequirements`. Resources at create time. A session after create.                                                                                                                 |
| `volume.create(name)`                                                 | Runtime volumes have a size: `runtime.volumes.create({ name, sizeMiB })`.                                                                                                                       |
| `secret`, `warmPool`                                                  | A Runtime secret for credentials. Runtime starts from warm templates already.                                                                                                                   |
| `runCode(code, { envs })`                                             | `envVars` at create time, or `os.environ` in the code.                                                                                                                                          |
| Listing by `isPublic`, `snapshots` or `autoDestroyAt`                 | Filter by a label that you set at create time.                                                                                                                                                  |

File download timeouts are in seconds. This includes buffer and local-path
overloads, and batches. A batch shares one deadline. It stops starting later
files once the deadline passes. JavaScript's `downloadFileStream(path, { timeout, signal })`
also limits and cancels the stream. An incomplete local download is never
published as the completed file.

Some differences are not refusals:

- A session runs one command at a time. A command sent while another one runs
  waits for it, as it would if typed into a shell. Sessions made by another
  client are found by name. But only their output from then on is known.
- `autoArchiveInterval` is recorded only. Runtime has no archive tier.
- Runtime's stock image is Ubuntu 24.04, with Python 3.12, Node.js 24 and Bun.

## 0.225.0, 18 October 2026

We reviewed the published npm tarballs for `@daytona/sdk`, `@daytona/api-client`,
`@daytona/toolbox-api-client` and `@daytona/analytics-api-client`, from 0.224.1 to
0.225.0. We also reviewed the PyPI wheel and sdist for `daytona`, from 0.224.1 to
0.225.0. Each was its registry's latest when checked. Every pinned file matched
the hash already in `compatibility-lock.json`. Every new file matched its
registry's SHA-512 integrity or SHA-256 digest. The wheel's Python source is byte
for byte its sdist's. Nothing was installed, imported or run. No declaration of
`@daytona/sdk` changed, and no Python source of `daytona` changed. Only versions
and the exact pins on the three API clients changed. The one API change is in
`@daytona/api-client` (and its PyPI twins): `GpuType` gains `B200`.

| Upstream change | Drop-in disposition                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GpuType.B200`  | Exported, with every other `GpuType`. A create that names any GPU type is refused (`NotSupportedError`, "Runtime runs sandboxes on CPUs") before anything is made. |

Two gaps near it were closed in this review. `@daytona/sdk` re-exports
`GpuType`, `SnapshotState`, `SandboxListSortField`, `SandboxListSortDirection`,
`SandboxClass`, `ListSecretsPaginatedSortEnum` and `ListSecretsPaginatedOrderEnum`.
`daytona` exports `GpuType`, `SandboxClass`, `SandboxListSortField` and
`SandboxListSortDirection`. The drop-ins exported none of them, so code that
imported one failed. They are exported now, with upstream's values, and the sort
enums drive `list`. Python refused `Resources(gpu=...)`, but it made a CPU sandbox
for `Resources(gpu_type=...)` alone. Daytona sends that as a GPU request. Python
now refuses it, as TypeScript does.

`tests/daytona/daytona-0-225-0.test.ts` and
`sdks/python/tests/test_daytona_0_225_0.py` fail without this change. The oracle
was not run against the new release, because it runs Daytona's code. The
provider stays marked `partial`.

## 0.224.1, 15 October 2026

We reviewed the published npm tarballs for `@daytona/sdk`, `@daytona/api-client`,
`@daytona/toolbox-api-client` and `@daytona/analytics-api-client`, from 0.223.1 to
0.224.1. We also reviewed the PyPI wheel and sdist for `daytona`, from 0.223.1 to
0.224.1. 0.224.0, published between them, was also fetched. On npm, 0.224.1 adds
only the stream decoder change and the dependency floors below. On PyPI, it is the
same source with a new version. Each was its registry's latest when checked. Every
pinned file matched the hash already in `compatibility-lock.json`. Every new file
matched its registry's SHA-512 integrity or SHA-256 digest. The wheel's Python
source is byte for byte its sdist's. Nothing was installed, imported or run. The
three API clients changed only their version. `@daytona/sdk` changed `Daytona`
(create parameters and the client's `target` docs), `Snapshot` (docs), and its
output stream decoder, in ESM and CommonJS alike. `daytona` changed the same
things, in sync and async, plus the async PTY handle.

| Upstream change                                                                                                                                                                      | Drop-in disposition                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `daytona.create({ target })` (Python `target` on `CreateSandboxFromSnapshotParams` and `CreateSandboxFromImageParams`) picks the region for that create, over the client's `target`. | Followed, in both languages. `"us"` or none creates the sandbox in Runtime's one region. Any other value is refused with the same `NotSupportedError` as a client `target`, before anything is built or made. Before, TypeScript dropped it without a word, and Python raised `TypeError`. |
| The client's `target` (and `DAYTONA_TARGET`), and a snapshot's `regionId` (Python `region_id`), are documented as the default region, overridden per call.                           | Documentation only. The client's `target` is checked as before. TypeScript already refused a snapshot `regionId`. Python accepted `region_id` and dropped it. Python now refuses it the same way. `""` still means the default.                                                            |
| The output stream decoder finds a stdout or stderr marker that ends exactly at the end of a message. It used to hold that marker back. It now buffers in linear time.                | Not applicable. The drop-in takes output from Runtime's exec, which keeps stdout and stderr apart. It never parses Daytona's markers.                                                                                                                                                      |
| Python `AsyncPtyHandle.wait()` shields its reader. So cancelling a caller's wait (for example, with `asyncio.wait_for`) leaves the PTY connected.                                    | Already so. The drop-in's `wait()` awaits `asyncio.shield` of its reader task.                                                                                                                                                                                                             |
| `@daytona/sdk` requires `ws` exactly 8.22.0 (it was ^8.22.0), `@aws-sdk/client-s3` and `lib-storage` ^3.1146.0, and `shell-quote` ^1.12.0.                                           | The oracle's `bun.lock` moves with them. `ws` stays at 8.22.0.                                                                                                                                                                                                                             |

`tests/daytona/daytona-0-224-1.test.ts` and
`sdks/python/tests/test_daytona_0_224_1.py` check a create's `target` both ways.
They check that it overrides the client's `target`. In Python, they also check
that a snapshot's `region_id` is refused. They fail without this change. The
oracle was not run against the new release, because it runs Daytona's code. The
provider stays marked `partial`.

## 0.223.1, 9 October 2026

We reviewed the published npm tarballs for `@daytona/sdk`, `@daytona/api-client`,
`@daytona/toolbox-api-client` and `@daytona/analytics-api-client`, from 0.223.0 to
0.223.1. We also reviewed the PyPI wheel and sdist for `daytona`, from 0.223.0 to
0.223.1. Each was its registry's latest when checked. Every pinned file matched
the hash already in `compatibility-lock.json`. Every new file matched its
registry's SHA-512 integrity or SHA-256 digest. Each wheel's Python source is byte
for byte its sdist's. Nothing was installed, imported or run. The three API
clients changed only their version. `@daytona/sdk` changed `Sandbox` and `Process`,
in ESM and CommonJS alike. `daytona` changed the same two modules, in sync and async.

| Upstream change                                                                                                                                                                                                      | Drop-in disposition                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.setPublic(isPublic)` (Python `set_public(public, request_timeout=None)`) makes the sandbox's preview URLs public or private, and sets `sandbox.public`.                                                     | Followed, in both languages. Every port that is already shared, and whose visibility differs, is shared again with the new visibility, at the same address. Later `getPreviewLink` calls use it. Without credit, Runtime refuses a public share (`public_preview_not_allowed`), and `public` does not change. |
| `executeCommand` (Python `exec`) documents that commands run under zsh, bash or sh (zsh in Daytona's images). It also explains how to start a server in the background, and that `nproc` may report the host's CPUs. | Documentation only. The drop-in keeps running commands under bash, which is what Daytona's quoting advice is written for. A sandbox's `nproc` reports its own vCPUs.                                                                                                                                          |
| `getPreviewLink` and `getSignedPreviewUrl` (Python `create_signed_preview_url`) document the token header, the API key as a bearer token, and a longer expiry.                                                       | Documentation only. A Runtime private preview takes its token as `x-runtime-preview-token`. Signed preview URLs stay refused, as above.                                                                                                                                                                       |
| `@daytona/sdk` requires `shell-quote` ^1.11.0. It was ^1.8.2.                                                                                                                                                        | The oracle's `bun.lock` already resolved 1.11.0.                                                                                                                                                                                                                                                              |

`tests/daytona/daytona-0-223-1.test.ts` and
`sdks/python/tests/test_daytona_0_223_1.py` check `setPublic` both ways. They
check that a public port is not shared again, and the refusal without credit.
They fail without this change. The oracle was not run against the new release,
because it runs Daytona's code. The provider stays marked `partial`.

## Tests

`bun run test` in `packages/cloud-sdk` runs the unit tests for both languages,
against fakes of Runtime's SDKs. The tests are `tests/daytona` here and
`sdks/python/tests/test_daytona.py`.

The end-to-end tests run Daytona's quickstart and guides, unmodified except for
the import, against the real API. They refuse to start unless the free trial has
an hour left. They create one sandbox per language, and end it. They are not part
of `bun run test`.

```bash no-run
bun packages/cloud-sdk/scripts/dropin-e2e.ts          # JavaScript, with the Vercel eval
python3 sdks/python/scripts/dropin_e2e.py             # Python, with the Vercel sample
```
