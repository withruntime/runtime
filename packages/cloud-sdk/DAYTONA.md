# Code written for Daytona, on Runtime

Run code written for [Daytona](https://www.daytona.io)'s SDK on Runtime Cloud
by changing one import. It is part of Runtime's SDK (`withruntime`), built on
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

The mapping was written against `@daytona/sdk` 0.216.1 and `daytona` 0.216.1
on PyPI, checked 23 September 2026.

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
- **Auto-stop:** Runtime runs a sandbox on a lease of up to an hour. The lease
  is `autoStopInterval` minutes (default 15; `0` is an hour), and every call
  through the adapter moves it on once less than half is left, so a sandbox
  pauses after that long without calls, as Daytona's does. `ttlMinutes` caps
  the renewals and ends the sandbox at the deadline.
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

| Daytona                                                                       | On Runtime                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daytona.create()`, `create({ snapshot })`                                    | `sandboxes.create`. Daytona's own snapshots (`daytona-*`) are Runtime's stock image. Any other name is a ready Runtime image of that name, then a Runtime snapshot of that name.                              |
| `create({ image: "python:3.12" })`                                            | Built once as a Runtime image from the registry reference (named after it), then reused. `onSnapshotCreateLogs` receives the build log.                                                                       |
| `create({ image: Image.debianSlim(...).pipInstall(...)... })`                 | The Dockerfile Daytona's `Image` stands for, with its local files, built as a Runtime image named after its content and reused.                                                                               |
| `resources`, `envVars`, `labels`, `name`, `volumes`                           | `vcpu`, `memoryMiB`, `diskMiB`; environment given to every command; labels; name; Runtime volumes by id or by name.                                                                                           |
| `networkBlockAll`, `networkAllowList`, `domainAllowList`, `outboundProxyUrl`  | Runtime network rules (`internet: false`, or an `allow` list); the proxy as `HTTP_PROXY` and `HTTPS_PROXY` for commands.                                                                                      |
| `public: true`                                                                | `getPreviewLink(port)` shares the port publicly; without it, privately with a token.                                                                                                                          |
| `language`                                                                    | The language of `codeRun`, kept in Daytona's `code-toolbox-language` label so a sandbox found later keeps it.                                                                                                 |
| `daytona.get(idOrName)`, `daytona.list({ labels, states, name })`             | `sandboxes.get`, or the newest live sandbox with that name; `sandboxes.list`. Awaiting `list()` gives the older `{ items, total }` shape.                                                                     |
| `process.executeCommand(cmd, cwd, env, timeout)`                              | `exec` under bash with stderr joined to stdout, as Daytona's `result`, streamed so the whole output comes back. A non-zero exit is a result. Past `timeout` (seconds): `DaytonaProcessExecutionTimeoutError`. |
| `process.codeRun(code, { argv, env })`                                        | `python3 -c`, `node -e` or `bun -e` by the sandbox's language. `artifacts.charts` is always empty.                                                                                                            |
| `createSession`, `executeSessionCommand`, `getSessionCommandLogs`             | One bash per session, kept running: directory, variables and functions carry from one command to the next. `runAsync` returns at once; logs stream to callbacks.                                              |
| `sendSessionCommandInput`, `getSession`, `getSessionCommand`, `deleteSession` | Input to the session's shell, which the running command reads; the commands sent through this object; killing the shell.                                                                                      |
| `fs.uploadFile(s)`, `downloadFile(s)`, `listFiles`, `getFileDetails`          | Runtime's files API. Relative paths resolve from `/workspace`. `owner` and `group` are always `""`.                                                                                                           |
| `fs.createFolder`, `deleteFile`, `moveFiles`, `setFilePermissions`            | `mkdir -m`, `files.remove`, `files.rename`, `chmod` and `sudo chown`.                                                                                                                                         |
| `fs.findFiles`, `searchFiles`, `replaceInFiles`                               | `grep -rn`, a files glob, and a read and write of each file.                                                                                                                                                  |
| `git.clone`, `status`, `add`, `commit`, `push`, `pull`, branches              | The sandbox's git. Credentials reach git through the environment, never the command line.                                                                                                                     |
| `codeInterpreter.runCode`, contexts                                           | Runtime's Python interpreter. The sandbox's `envVars` reach code through a context made once for them.                                                                                                        |
| `start`, `stop`, `pause`, `archive`, `delete`, `fork`, `createSnapshot`       | `wake`, `pause` (or `stop` when ephemeral), `pause`, `pause`, `stop`, Runtime's fork with memory, a Runtime snapshot with that name.                                                                          |
| `getPreviewLink(port)`                                                        | A Runtime preview. Send its token as `x-runtime-preview-token`; Daytona's header is `x-daytona-preview-token`.                                                                                                |
| `getUserHomeDir`, `getWorkDir`, `user`                                        | `/workspace`, and `daytona`, so `/home/daytona` (linked to `/workspace` the first time something names it) works.                                                                                             |
| `daytona.snapshot.create`, `get`, `list`, `delete`                            | Runtime images built, found, listed and deleted by name.                                                                                                                                                      |
| `daytona.volume.get`, `list`, `delete`                                        | Runtime volumes by name.                                                                                                                                                                                      |
| Error classes                                                                 | Daytona's names and parents, by HTTP status. Each also carries Runtime's `code`, `hint` and `requestId`, with the original error as `cause`.                                                                  |

## Gaps

Each of these throws `NotSupportedError` before anything happens. Its
`feature` names the gap and its `alternative` says what to use.

| Daytona                                                               | Use instead                                                                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A snapshot name with no Runtime image or snapshot                     | `daytona.snapshot.create({ name, image })` here, or `npx withruntime image build`. This throws `DaytonaNotFoundError`.                                                                  |
| GPUs, `spot`, `linkedSandbox`, `secrets`, `otelEndpointOverride`      | Runtime runs Linux on CPUs. For `secrets`, a Runtime secret (`npx withruntime secrets set NAME --host <host>`): the sandbox sees a placeholder. For telemetry, `runtime.otel.create()`. |
| A `target` other than `us`, `jwtToken`                                | Runtime runs in one US region and signs in with keys.                                                                                                                                   |
| `user` other than `daytona`                                           | Commands run as the sandbox owner with passwordless `sudo`.                                                                                                                             |
| PTY sessions, the entrypoint session, language servers                | `sandbox.withruntime.terminal(...)`, and sessions with `runAsync`.                                                                                                                      |
| `computerUse`                                                         | Runtime's desktop, `sandbox.withruntime.desktop`.                                                                                                                                       |
| `setLabels`, `resize`, `recover`                                      | Set labels and resources at create; create a new sandbox.                                                                                                                               |
| Signed preview URLs, signed upload and download URLs, SSH access      | `getPreviewLink`, `fs.uploadFile` and `downloadFile`, `npx withruntime sandbox ssh <id>`.                                                                                               |
| `getMetrics`                                                          | `sandbox.withruntime.metrics()`: its CPU and memory over time.                                                                                                                          |
| `Image.pipInstallFromPyproject`, snapshot `resources` or `entrypoint` | `pipInstallFromRequirements`; resources at create; a session after create.                                                                                                              |
| `volume.create(name)`                                                 | Runtime volumes have a size: `runtime.volumes.create({ name, sizeMiB })`.                                                                                                               |
| `secret`, `warmPool`                                                  | A Runtime secret for credentials; Runtime starts from warm templates already.                                                                                                           |
| `runCode(code, { envs })`                                             | `envVars` at create, or `os.environ` in the code.                                                                                                                                       |
| Listing by anything but name, labels and states                       | Filter the result yourself.                                                                                                                                                             |

Some differences are not refusals:

- Sandbox `envVars` live in the object that created the sandbox;
  `daytona.get(id)` from another process does not know them.
- A session runs one command at a time. A command sent while another runs
  waits for it, as it would typed into a shell. Sessions made by another
  client are found by name, but only their output from then on is known.
- `autoArchiveInterval` is recorded only: Runtime has no archive tier.
- Runtime's stock image is Ubuntu 24.04 with Python 3.12, Node.js 24 and Bun.

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
