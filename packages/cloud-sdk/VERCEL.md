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

The mapping was written against `@vercel/sandbox` 3.5.0 and `vercel-sandbox`
0.7.0 on PyPI (the `vercel.sandbox` module of `vercel` 0.11.4), checked
23 September 2026.

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
- **Timeout:** Vercel's default of 5 minutes. Runtime's leases run 60 seconds to
  an hour; `extendTimeout` moves the end later, as often as needed.
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
| `Sandbox.fork({ sourceSandbox, name })`                               | A Runtime fork, which copies memory and processes too.                                                                                      |
| `runCommand(cmd, args)`, `runCommand({ cmd, args, cwd, env, sudo })`  | `exec` of the argv without a shell. `sudo` runs it under `sudo --preserve-env`. A non-zero exit is a result. Past `timeoutMs` it exits 137. |
| `stdout`, `stderr` writers, `detached: true`, `logs()`, `wait()`      | Output streams to the writers; a detached command is a Runtime process, its logs followed from the start.                                   |
| `getCommand(cmdId)`, `kill(signal)`                                   | Runtime processes by id; signals by name or number.                                                                                         |
| `writeFiles`, `readFile`, `readFileToBuffer`, `downloadFile`, `mkDir` | Runtime's files API. `mode` is set with `chmod`. A missing file is `null`, as in Vercel.                                                    |
| `sandbox.fs`                                                          | `node:fs/promises` over the files API and coreutils, with Node's error codes.                                                               |
| Paths                                                                 | Relative paths resolve from `/vercel/sandbox`, which is `/workspace`. A command that names `/vercel/sandbox` finds a link to it.            |
| `domain(port)`, `update({ ports })`                                   | The public preview of that port; ports added or removed.                                                                                    |
| `stop()`, `delete()`, `extendTimeout(ms)`                             | `pause` (persistent) or `stop`; `stop`; `extend`.                                                                                           |
| `update({ timeout, networkPolicy, snapshotExpiration })`              | `extend` (later only), network rules, retention.                                                                                            |
| `snapshot()`, `Snapshot.get`, `Snapshot.list`, `snapshot.delete()`    | A Runtime snapshot (files, memory and processes), then the sandbox stops, as in Vercel; `snapshots.get`, `list`, `delete`.                  |
| Error classes                                                         | `APIError` with a `response` whose status is Runtime's and `json` of `{ error: { code, message } }`; also `code`, `hint` and `requestId`.   |
| Python: `create_sandbox`, `run_process`, `create_process`, `box.fs`   | The same mapping; operations await or work as context managers, which stop and by default destroy the sandbox; readers iterate by line.     |

## Gaps

Each of these throws `NotSupportedError` before anything happens. Its
`feature` names the gap and its `alternative` says what to use.

| Vercel Sandbox                                             | Use instead                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| An `image` with no Runtime image of that name              | Build it: `npx withruntime image build --dockerfile Dockerfile --name <image>`.                             |
| `timeout` over one hour                                    | Create with up to an hour, then `extendTimeout` before it ends.                                             |
| Drives (`mounts`), `networkId`                             | Runtime volumes through `withruntime: { create: { volumes } }`; network rules.                              |
| A region outside the US, `failoverRegions`                 | Runtime runs in one US region.                                                                              |
| Network rules that transform or forward requests           | Allow the domain and pass credentials as `env`.                                                             |
| `openInteractive`                                          | `sandbox.withruntime.terminal(...)` or `npx withruntime sandbox shell <id>`.                                |
| Extra users and groups (`createUser`, `asUser`)            | `sudo useradd` and `sudo -u` through `runCommand`.                                                          |
| Sessions (`currentSession`, `listSessions`)                | A Runtime sandbox is its own session.                                                                       |
| `update` of tags, resources, persistence or region         | Create a new sandbox with them.                                                                             |
| Overrides on `Sandbox.fork`                                | Fork, then change what Runtime can change.                                                                  |
| `delete({ deleteOrphanSnapshots: true })`, `Snapshot.tree` | Delete snapshots one by one; `Snapshot.list`.                                                               |
| `Drive`, `SandboxUser`, `defineSandboxProxy`               | Runtime volumes; `sudo`; `sandbox.withruntime.previews`.                                                    |
| Listing by time, prefix or cursor (JavaScript)             | List them all and filter the result yourself. (Python applies a name prefix and newest-first order itself.) |

Some differences are not refusals:

- A persistent sandbox keeps its memory and processes as well as its files
  across `stop()`: they carry on after a wake, where Vercel starts them again.
- Commands run as the sandbox owner, `runtime`, with passwordless `sudo`.
  `pwd` prints `/workspace`.
- Runtime's stock image is Ubuntu 24.04 with Python 3.12, Node.js 24 and Bun;
  Vercel's `universal` has Python 3.14.
- `keepLastSnapshots` is accepted: a paused Runtime sandbox keeps exactly its
  latest state.
- A git source is cloned into the working directory itself.

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
