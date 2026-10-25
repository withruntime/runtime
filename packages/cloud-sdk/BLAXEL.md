# Code written for Blaxel, on Runtime

Run code written for [Blaxel](https://docs.blaxel.ai/Sandboxes/Overview)'s
TypeScript sandbox SDK on Runtime Cloud by changing one import. This is part of
Runtime's SDK (`withruntime`). It is built on the same client, so it gets that
SDK's retries, idempotency keys and errors. Importing `withruntime` alone does
not load it.

```ts no-run
import { SandboxInstance } from "withruntime/blaxel"; // was: from "@blaxel/core"
```

The mapping was written against `@blaxel/core` 0.3.24 and Blaxel's sandbox API
source, checked 30 September 2026. It was checked again against `@blaxel/core`
0.3.30 and `blaxel` 0.4.18 on PyPI on 16 October 2026 (below, "0.3.30 and
0.4.18"). The exact releases and artifact hashes are kept in
`compatibility-lock.json`. You can import every name that `@blaxel/core`
exports. Code that only mentions an agent, model or MCP helper still loads.

## Keys

The package uses these keys, in this order: a Runtime key given to
`initialize({ apikey })`, `RUNTIME_API_KEY`, a Runtime key (`rtcloud_...`) left
in `BL_API_KEY`, and the key that `npx withruntime login` saved on this machine.
A Blaxel key is never sent anywhere. In `BL_API_KEY` it is ignored. If you pass
it to `initialize` while `RUNTIME_API_KEY` is not set, it throws
`CredentialsError`. `BL_WORKSPACE` has no effect on Runtime. With no Runtime key
at all, the first call throws `CredentialsError`. The error says what to set.

**A key sees only the sandboxes it created.** A sandbox made with another of the
account's keys returns 404, though its name stays taken
([teams](https://withruntime.com/docs/teams)). Services that share sandboxes by
name, or through `getByExternalId`, use the same Runtime key.

## What a sandbox gets

- **Machine:** Blaxel's default of 4096 MB. vCPUs follow Blaxel's rule of one
  per 2048 MB (at least one, at most 16): 2 for the default, 4 for 8192 MB. A
  trial sandbox has at most 4096 MB (2 vCPUs). `memory: 8192` or more needs
  prepaid credit. On the trial, the call is refused with a 400
  (`no_credit_size_limit`), and the response says so.
- **Image:** Blaxel's `base-image`, `py-app`, `ts-app`, `node`,
  `docker-in-sandbox` and `jupyter-server` are Runtime's stock image. The stock
  image is Ubuntu 24.04 with Node.js 24, Python 3.12, Bun, git and a compiler.
  Docker is available after `sudo enable-docker`. Any other image `ns/name:tag`
  is the ready Runtime image named `ns-name`. Every `/` becomes `-`, because a
  Runtime name has no `/`. The tag is `tag`, or `latest` when none is given.
  Build the image once with
  `npx withruntime images build --dockerfile Dockerfile --name ns-name -t ns-name:tag`.
  The code keeps `image: "ns/name:tag"` as it is.
- **Standby and lifetime:** A Blaxel sandbox goes to standby when it is unused.
  It resumes on the next call. On Runtime, the sandbox pauses after 60 seconds
  without a call. This is Runtime's shortest idle pause. Blaxel's is about 15
  seconds. A paused sandbox keeps its memory, files and processes. It wakes by
  itself on the next command, file call or preview visit. The sandbox has no
  time limit, so a sandbox in use is never paused on a clock.
- **How long it is kept:** Blaxel keeps a sandbox until it is deleted or its TTL
  ends. A paused Runtime sandbox is kept 365 days when no TTL, expiry or
  lifecycle is given. When one is given, the sandbox is never deleted before
  Blaxel would delete it. It may be kept longer:
  - a `ttl`, `expires`, `ttl-max-age` or `date` within the hour is a time limit.
    It ends the sandbox at that time. If the sandbox paused and woke, it ends
    later;
  - any other deadline, and any `ttl-idle`, keeps a paused sandbox for that many
    days, rounded up. The count starts from each pause. With several, the
    shortest wins;
  - at most 365 days.

  On the free trial, a paused sandbox is kept for the trial's seven days,
  whatever the TTL. On credit, the rules above apply.

- **Envs:** `envs` are written once at create to a file on the sandbox
  (`/etc/runtime-blaxel/env`, readable by the sandbox user, changed only with
  sudo). Every process the adapter starts reads that file, from any client. So
  `SandboxInstance.get(name)` in another program sees them too. A process's own
  `env` wins over the sandbox's. Values never appear in a command line.
- **Region:** `us-pdx-1`, `us-was-1` and `auto` are accepted. Runtime runs in one
  US region, east. Any other region, from `region` or `BL_REGION`, is refused.
- **Paths:** Blaxel's images work in `/blaxel`. Runtime's images work in
  `/workspace`. Relative paths, `~` and paths under `/blaxel` resolve against
  `/workspace`. This applies to file calls and to a process's `workingDir`. A
  command that names `/blaxel` finds a link to `/workspace`. Other absolute paths
  stay as they are.
- **Funding:** Runtime chooses, as `withruntime`'s own create does. The free
  trial is used while the account has trial time. After that, prepaid credit is
  used. To use only the trial, pass `withruntime: { create: { funding: "trial" } }`.
- **Anything else Runtime offers:** `withruntime: { create: { ... } }` sends
  Runtime's create fields as they are. `sandbox.withruntime` is the Runtime
  sandbox underneath. Static calls take `{ withruntime: { client } }` as a last
  argument to use a given Runtime client.

## Mapping

| Blaxel                                                                                                            | On Runtime                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxInstance.create({ name, image, memory, labels, ports, envs, ... })`                                       | `sandboxes.create`. A name that another live sandbox holds returns a 409, as in Blaxel. A name held by a sandbox that is still being deleted is waited for.                                                                                                                                                                                                                                                       |
| `createIfNotExists`                                                                                               | `create` with `getOrCreate`. When two callers race for one name, Runtime gives both the same sandbox. An existing sandbox is returned as it is.                                                                                                                                                                                                                                                                   |
| `get(name)`, `getByExternalId`, `list({ limit, externalId, showTerminated })`                                     | The live sandbox with that name, or with the `externalId` label. Blaxel's paginated list (`data`, `nextPage`, `for await`, `autoPagingToArray`).                                                                                                                                                                                                                                                                  |
| `delete` (static and on the sandbox)                                                                              | `stop`: the sandbox ends immediately. Using that object afterwards returns a 404.                                                                                                                                                                                                                                                                                                                                 |
| `metadata`, `spec`, `status`, `state`, `lastUsedAt`, `expiresIn`                                                  | From the Runtime sandbox and its `blaxel/` labels (image, memory, ports, region, TTL, expiry, lifecycle, archived), which any client reads. `state` is `STANDBY` while paused.                                                                                                                                                                                                                                    |
| `updateMetadata`, `updateTtl`, `updateLifecycle`, `updateNetwork`                                                 | Labels. The display name and `externalId` are labels. The paused retention is set as at create. Network rules.                                                                                                                                                                                                                                                                                                    |
| `archive`, `unarchive`                                                                                            | `pause`, `wake`. Runtime keeps memory and processes too. The next call wakes the sandbox.                                                                                                                                                                                                                                                                                                                         |
| `network: { allowedDomains, forbiddenDomains, proxy }`                                                            | Runtime network rules: `allow` and `deny`.                                                                                                                                                                                                                                                                                                                                                                        |
| `volumes: [{ name, mountPath }]`                                                                                  | The Runtime volume with that name, mounted read-write.                                                                                                                                                                                                                                                                                                                                                            |
| `fetch(port, path, init)`                                                                                         | The request goes to a private Runtime preview of the port. The preview is made on first use and then reused. The request carries its token.                                                                                                                                                                                                                                                                       |
| `process.exec` without `waitForCompletion`                                                                        | One Runtime process, returned as running. Its Blaxel name is kept in its command line, so `get("name")` finds it from any client.                                                                                                                                                                                                                                                                                 |
| `process.exec({ waitForCompletion: true })`                                                                       | One streamed call, returned with `status`, `exitCode`, `stdout`, `stderr` and `logs`. If the call runs past `timeout`, the wait ends with a 422, and the process keeps running.                                                                                                                                                                                                                                   |
| `onLog`, `onStdout`, `onStderr`, `streamLogs`                                                                     | The process's output as it comes. `streamLogs` gives whole lines, as Blaxel's does.                                                                                                                                                                                                                                                                                                                               |
| `process.get`, `wait`, `list`, `logs`, `stop`, `kill`, `writeStdin`, `closeStdin`                                 | Runtime processes, by id or name. `wait` follows output with one deadline that covers both the lookup and the output. Cancellation leaves the process running. `stop` sends SIGTERM. `kill` sends SIGKILL.                                                                                                                                                                                                        |
| `keepAlive`, `timeout`                                                                                            | The sandbox does not pause for idleness while the process may run. The process's `timeout` is 600 s by default. 0 means as long as a lease allows. Once no `keepAlive` process runs, the sandbox gets its idle pause back.                                                                                                                                                                                        |
| `restartOnFailure`, `maxRestarts`, `waitForPorts`, `workingDir`, `env`, `stdin`                                   | A restart loop in the same process. The output has Blaxel's note (`restartCount` counts the notes). The sandbox waits for the ports. Otherwise as in Blaxel.                                                                                                                                                                                                                                                      |
| `fs.read`, `write`, `readBinary`, `writeBinary`, `writeTree`, `mkdir`, `rm`, `cp`                                 | Runtime's files API, or one command. A path that only root may read or write goes through sudo. This covers paths outside `/workspace` and files made by a root process. Blaxel's root-owned API could do the same.                                                                                                                                                                                               |
| `fs.ls`, `find`, `grep`, `search`                                                                                 | One command each, with Blaxel's defaults, limits and excluded directories. `ls` reports owners.                                                                                                                                                                                                                                                                                                                   |
| `fs.watch(path, callback, { withContent, ignore })`, `fs.download`                                                | A Runtime watch (`path/**` for subdirectories). `fs.download` saves to the local disk.                                                                                                                                                                                                                                                                                                                            |
| `previews.create`, `createIfNotExists`, `get`, `list`, `delete`                                                   | Runtime previews of `spec.port`, public or private. The Blaxel name is kept in a label, so any client finds it by name. The shorthand `{ port, name?, public? }` makes a private `preview-<port>` unless it says otherwise. `createIfNotExists` returns an existing preview as it is.                                                                                                                             |
| `preview.tokens.createIfExpired(expiresAt?, minValidity?)`                                                        | The token this call made last in this process for the sandbox's port is reused while it lasts `minValidity` more and ends by `expiresAt`. Otherwise, a new token is made. Runtime keeps no list of tokens, so a new process makes a new one.                                                                                                                                                                      |
| `isBlaxelError`, `getBlaxelErrorCode`, `getBlaxelErrorStatus`, `getBlaxelErrorMessage`, `getBlaxelErrorRequestId` | Blaxel's readers for the errors here. A `ResponseError`'s code is its HTTP status, as its `code` is. Its request id is Runtime's.                                                                                                                                                                                                                                                                                 |
| `settings.integration`, `initialize({ integration })`, `BL_INTEGRATION`                                           | Kept and checked as Blaxel does (`<name>/<semver>`, warned once and `""` otherwise). Never sent, because Runtime does not attribute traffic by it.                                                                                                                                                                                                                                                                |
| `preview.tokens.create(expiresAt)`                                                                                | A token for that long: at least a minute, at most a week. It is read from Blaxel's `X-Blaxel-Preview-Token` header or `?bl_preview_token=`, as from Runtime's `x-runtime-preview-token` and `?runtime_preview_token=`. It is never passed on to your server.                                                                                                                                                      |
| `snapshots.create`, `list`, `get`, `delete`; `Snapshot.create`, `get`, `list`, `fork`                             | Runtime snapshots, kept 365 days: files, memory and running processes.                                                                                                                                                                                                                                                                                                                                            |
| `fork(name)`, `fork(name, { snapshotId, envs })`                                                                  | A Runtime fork of the running sandbox. Or a new sandbox from the snapshot, found by id or by name among this sandbox's snapshots. `envs` are added over the source's.                                                                                                                                                                                                                                             |
| `CodeInterpreter.create`, `runCode`, `createCodeContext`                                                          | Runtime's interpreter, with the same result classes. The sandbox's envs reach every context.                                                                                                                                                                                                                                                                                                                      |
| `sandbox.sessions.create`, `createIfExpired`, `list`, `get`, `delete`                                             | A Runtime sandbox session: a token for commands, files and previews of this one sandbox. It lasts a day unless `expiresAt` says sooner. A day is the maximum. `responseHeaders["Access-Control-Allow-Origin"]` names the pages that may use it. `*`, other response headers and `requestHeaders` are refused. `createIfExpired` reuses the session this process made last. A token is shown only when it is made. |
| `SandboxInstance.fromSession(session)`                                                                            | The sandbox, driven with the session's token alone. Anything that manages the sandbox is refused.                                                                                                                                                                                                                                                                                                                 |
| `ResponseError`, `SandboxGatewayError`, `isGatewayError`, `isGatewayTimeout`                                      | Runtime's errors under Blaxel's names. `status` and `code` are the HTTP status. `runtimeCode`, `hint` and `requestId` are Runtime's.                                                                                                                                                                                                                                                                              |

## Gaps

Each of these throws `NotSupportedError` before anything happens. The `feature`
names the gap. The `alternative` says what to use.

| Blaxel                                                                                                                   | Use instead                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| An `image` with no ready Runtime image of the name it maps to (Blaxel's other templates too)                             | Build it: `npx withruntime images build --dockerfile Dockerfile --name ns-name -t ns-name:tag`. The error gives the exact command.       |
| A region outside the US                                                                                                  | Runtime runs in one US region.                                                                                                           |
| `extraArgs` other than `iptables`; network `egress`, `firewall`, `subnet`, and a `proxy` with more than its domain lists | Remove them. Use `allowedDomains` and `forbiddenDomains` (on the network or its proxy), or Runtime secrets.                              |
| Read-only and ephemeral volumes; a volume with no Runtime volume of that name                                            | Mount read-write. Write scratch files under `/workspace`. Or use `runtime.volumes.create`.                                               |
| `snapshots.restore`, `restore`                                                                                           | Fork from the snapshot into a new sandbox.                                                                                               |
| Forking into an application                                                                                              | Fork into a sandbox and share its port.                                                                                                  |
| A preview's `prefixUrl`, `customDomain`, `requestHeaders`, `responseHeaders`, `ttl`                                      | Use Runtime's fixed preview address. Set headers (CORS) in your server. Delete the preview.                                              |
| `preview.tokens.list()`; a token for over a week                                                                         | Keep the tokens you create. Create a new one when it runs out.                                                                           |
| `runCode` with `envs` for one run; a language Runtime's interpreter lacks                                                | Set sandbox envs at create, or set them in the code. Or use `process.exec`.                                                              |
| Listing by `cursor`, `q`, `anchor`, a status other than `DEPLOYED`, or newest first                                      | List and filter the result yourself. `nextPage()` walks the pages.                                                                       |
| `schedules`, `codegen`, `system`, `drives`                                                                               | A Runtime job (`runtime.jobs.create`, a fresh sandbox each run), or your own scheduler. `fs.write`. Nothing to upgrade. Runtime volumes. |
| Agents, models, tools, MCP transports, jobs, applications, images, volumes, drives                                       | Your own agent with Runtime sandboxes, `withruntime/tools`, `npx withruntime mcp`, `runtime.images`, `runtime.volumes`.                  |
| Blaxel's generated API functions (`createSandbox`, `postProcess`, ...)                                                   | `SandboxInstance` here, or `import { Runtime } from "withruntime"`.                                                                      |

Some differences are not refusals:

- **A public preview needs a paid sandbox.** On the trial, share a port
  privately and use a token.
- **Commands run as root,** as on Blaxel. Every process the adapter starts
  (`exec`, `keepAlive`, restart loops) hands over to passwordless `sudo`. It
  keeps the envs, the sandbox user's `PATH` and `HOME` (`/workspace`, which
  stands for Blaxel's `/blaxel`). `id -u` prints 0, and `pwd` prints
  `/workspace`. Stopping or killing a process ends it and everything it started.
  The file calls act as the sandbox user. They fall back to `sudo` where only
  root may go. So files a root process made stay readable, writable and
  removable through `fs`. A file that the adapter rewrites that way becomes the
  sandbox user's. `ls`, `find`, `grep`, `search` and `writeTree` run as the
  sandbox user, so they skip what only root may read. The code interpreter's
  contexts run as the sandbox user. Blaxel's Jupyter server runs as root.
- **A paused sandbox keeps its memory and processes** across `archive`. Blaxel's
  archive keeps only files and starts the processes again.
- **Standby starts after 60 seconds idle,** not about 15. A running process does
  not count as use unless it was started with `keepAlive`. A `keepAlive` process
  raises the sandbox's idle pause to its `timeout` (off for `timeout: 0`). The
  old idle pause is kept in the `blaxel/idlePauseSeconds` label. The old idle
  pause comes back once no `keepAlive` process runs. That happens when a client
  sees one end (a waited exec, `wait` or `get`), stops or kills one, or calls
  `SandboxInstance.get`. With no such call, the sandbox pauses when it has been
  idle for that `timeout`. On a sandbox with a time limit, a `keepAlive` process
  past the limit is paused with the sandbox when the limit ends, if no call
  renews it. The process carries on at the next call.
- **A name is not refused while its process runs:** a second process may take a
  running process's name. `get(name)` returns the newest.
- **`process.list()` leaves each process's output empty** (Blaxel includes a
  tail of it). `get(name)` or `logs(name)` reads the output. A process ended by
  a signal reports exit code -1. It reports `stopped` (SIGTERM) or `killed`
  (SIGKILL, or its time limit), from any client.
- **Runtime records a command's first 256 characters.** A process started with a
  longer command keeps its name. From another client, its `command` is the start
  of what was run.
- **`fs.search`** scores matches by its own rule: characters in order, with runs
  and word starts first. It does not use Blaxel's fzf scores. `grep`'s
  `contextLines` is accepted. As in Blaxel's API, it is not used.
- **`ls`, `find`, `grep`, `search` and `writeTree` run a short Python script.**
  On an image without `python3`, they throw `NotSupportedError`. `ls` then lists
  through the files API, without owners.
- **`spec.runtime.envs`, `network` and `volumes`** are known only to the client
  that created the sandbox. The envs themselves reach every process from any
  client. Port names are not kept: `ports` come back as numbers.
- A preview token shorter than a minute lasts a minute. Deleting one token
  revokes every token of that preview.

## 0.3.30 and 0.4.18, 16 October 2026

Reviewed the published npm tarball of `@blaxel/core` 0.3.29 → 0.3.30 and the
PyPI wheel and sdist of `blaxel` 0.4.17 → 0.4.18. Each was its registry's latest
when checked. The pinned files matched `compatibility-lock.json`. The new files
matched their registry's SHA-512 integrity or SHA-256 digest. The wheel's source
is byte for byte its sdist's. They were compared file by file. Nothing was
installed or run outside the oracle. The npm package's dependencies did not
change.

| Upstream change                                                                                                                                                                                                                                                                                               | Drop-in disposition                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace secrets, which Blaxel's proxy puts into a sandbox's routing as `{{SECRET:name}}`: the generated API calls `listSecrets`, `upsertSecret`, `deleteSecret`, `deleteSecretByQuery`; Python `SecretInstance`, `SyncSecretInstance` (`set`, `list`, `delete`), `SecretAPIError` and `blaxel.core.secret`. | Importable. Refused with `NotSupportedError` that names Runtime secrets: `runtime.secrets.set(name, { value, hosts })`. A Runtime secret names the hosts it may reach. Blaxel's calls do not. The drop-in already refuses Blaxel's proxy routing. `SecretAPIError` is a `BlaxelError`, and it is never raised. Before, the imports failed. |
| `deleteDriveFolder` in the generated API.                                                                                                                                                                                                                                                                     | Importable and refused, as every drive call is.                                                                                                                                                                                                                                                                                            |
| The SDK sends an "Installed SDK" event to PostHog once per version (internal `common/posthog`, not exported).                                                                                                                                                                                                 | Nothing to follow. The drop-in sends nothing to Blaxel or its analytics.                                                                                                                                                                                                                                                                   |
| Custom domains' `validationMethod`, the `kernelExtensions` extra argument, and doc text (the 60 s floor of `ttl-idle`).                                                                                                                                                                                       | Nothing new to do. Custom domains are refused. An extra argument other than `iptables` is refused. The drop-in has no `ttl-idle` floor, so a paused sandbox is kept whole days.                                                                                                                                                            |

These tests fail without this change: `tests/blaxel/blaxel-0-3-30.test.ts` (2)
and `sdks/python/tests/test_blaxel_0_4_18.py` (2). The export list moves to
0.3.30's 275 names. In `compat-inventory.json`, blaxel had 611 present, 123
refused and 31 missing, of 765, before. It has 616, 123 and 31, of 770, now.
blaxel-python had 375, 11 and 652, of 1038, before. It has 388, 11 and 672, of
1071, now. The inventory counts the Python stand-ins as missing, as it did
`ImageInstance` before them.

## 0.3.29 and 0.4.17, 15 October 2026

Reviewed the published npm tarball of `@blaxel/core` 0.3.25 → 0.3.29 and the
PyPI wheel and sdist of `blaxel` 0.4.13 → 0.4.17. 0.3.26 to 0.3.28 and 0.4.14
to 0.4.16 came out between, all on 13 October. Each was its registry's latest
when checked. The pinned files matched the hashes already in
`compatibility-lock.json`. The new files matched their registry's SHA-512
integrity or SHA-256 digest. Each wheel's Python source is byte for byte its
sdist's. They were compared file by file. Nothing was installed or run outside
the oracle, which runs 0.3.29 and passes. The npm package's dependencies did not
change. Python's `withruntime.blaxel` follows the same changes under Python's
names: `BlaxelError`, `is_blaxel_error(err, code=None)`,
`SandboxPreviewCreateConfiguration`, `create_if_expired(expires_at=None,
min_validity=timedelta(hours=1))`, `settings.integration`.

| Upstream change                                                                                                                                                                                                                                                                                                                           | Drop-in disposition                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error helpers `isBlaxelError`, `getBlaxelErrorCode`, `getBlaxelErrorStatus`, `getBlaxelErrorMessage`, `getBlaxelErrorRequestId` and the error code and body types. Python: `BlaxelError` becomes the base of `ResponseError` and every `*APIError`, with `status`, `code`, `request_id`, `retryable` and the rest, and `is_blaxel_error`. | Followed. The helpers read the drop-in's errors with Blaxel's rules. A request id with no Blaxel header is Runtime's. In Python, every API error the drop-in raises is a `BlaxelError`. `status` is the HTTP status. `code` is Runtime's code. `request_id` is Runtime's. `retryable` is Runtime's own judgement. Blaxel's gateway fields are None. `VolumeAPIError` and `blaxel.core.errors` import. |
| `previews.create` and `createIfNotExists` take `{ port, name?, public? }` (Python: a dict or `SandboxPreviewCreateConfiguration`): a private `preview-<port>` by default, checked with `RangeError` (Python `ValueError`); an existing preview is answered as it is.                                                                      | Followed, with Blaxel's checks and messages, before anything is shared. Before, the shorthand failed (`spec.port is required`, or a TypeError in `createIfNotExists`).                                                                                                                                                                                                                                |
| `preview.tokens.createIfExpired(expiresAt?, minValidity?)` reuses the latest listed token that lasts `minValidity` (an hour) more and ends by `expiresAt` (a day), else makes one; a public preview is refused.                                                                                                                           | Followed. Runtime keeps no list of the tokens it signs, so the token reused is the one this call made last in this process for the sandbox's port. Arguments and the public refusal are Blaxel's, checked before any request. Revoking the preview's tokens (`tokens.delete`) forgets it.                                                                                                             |
| `SandboxPreview.url`, `SandboxPreviewToken.name`.                                                                                                                                                                                                                                                                                         | Followed.                                                                                                                                                                                                                                                                                                                                                                                             |
| `settings.integration`, `Config.integration` and `BL_INTEGRATION`: a `<name>/<semver>` token appended to Blaxel's User-Agent.                                                                                                                                                                                                             | Kept and checked as Blaxel does, and warned about once when invalid. Never sent: it only attributes traffic to Blaxel. Before, `settings.integration` threw `NotSupportedError`. Python's `settings.user_agent` and other settings still raise `NotSupportedError`.                                                                                                                                   |
| `fs.search` now sends its query (it was dropped).                                                                                                                                                                                                                                                                                         | Nothing to do: the drop-in's search always used it.                                                                                                                                                                                                                                                                                                                                                   |
| `ImageInstance` takes `buildMemory`, `buildVolume`, `buildRegion`; generated API clients gain `headFilesystemByPath`, service-account `role`, and doc text; Python's resource errors keep the response.                                                                                                                                   | Nothing to follow. `ImageInstance` and the generated API calls stay refused, with Runtime's alternative (`runtime.images`, `SandboxInstance`). Python's `ResponseError.from_api_response`, which wraps a generated-client response, now raises `NotSupportedError` and says so.                                                                                                                       |

These tests fail without this change: `tests/blaxel/blaxel-0-3-29.test.ts` (9)
and `sdks/python/tests/test_blaxel_0_4_17.py` (9). The export list moves to
0.3.29's 270 names. `compat-inventory.json` was regenerated from the verified
packages. blaxel had 596 present, 123 refused and 31 missing before (of 750). It
has 611, 123 and 31 now (of 765). blaxel-python had 252, 9 and 642 before (of
903, since 0.4.13 exported fewer names from `blaxel.core`). It has 375, 11 and
652 now (of 1038). The pinned official Python tests (`RUNTIME_COMPAT_OFFICIAL=1`)
were not run against 0.4.17.

## The process line

Both this package and the Python one write a process's command line
(`processLine` in `src/blaxel/context.ts`). So either one finds and follows the
other's processes. It is one line. Parts are joined by `; `. A single quote `'`
is written `'\''`:

```text
: rt-blaxel '<name>'; [: rt-blaxel-keep; ]export HOST="${HOST:-0.0.0.0}"; [ -r /etc/runtime-blaxel/env ] && . /etc/runtime-blaxel/env; unset RUNTIME_BLAXEL_KEEP; [{ [ -e /blaxel ] || sudo ln -s /workspace /blaxel; } 2>/dev/null; ]__rt_cmd='<command>'; export __rt_cmd; exec sudo -E env "PATH=$PATH" "HOME=$HOME" bash -c '<run>'
```

`: rt-blaxel-keep;` is there for a `keepAlive` process. The link part is there
when the command or its env names `/blaxel`. `<run>` is `eval "$__rt_cmd"`. With
`restartOnFailure`, it is the restart loop:
`__rt_n=0; while :; do ( eval "$__rt_cmd" ); __rt_c=$?; [ $__rt_c -eq 0 ] && exit 0; [ $__rt_n -ge <max> ] && exit $__rt_c; __rt_n=$((__rt_n+1)); printf '\n[Process failed with exit code %d. Attempting restart %d/%s...]\n' $__rt_c $__rt_n '<max or unlimited>'; done`
The `-ge` test is left out when `maxRestarts` is negative. A process's own `env`
is sent with `RUNTIME_BLAXEL_KEEP=":NAME1:NAME2:"`. So the env file leaves those
names alone.

## Tests

`bun run test` in `packages/cloud-sdk` runs the unit tests against a fake of
Runtime's SDK. The tests are in `tests/blaxel`. They include a check that every
name that `@blaxel/core` 0.3.30 exports is also exported here.

The end-to-end test runs Blaxel's guides against the real API. The only change
is the import. The guides are `tests/fixtures/blaxel-quickstart.mjs` (create,
processes, log streaming and files) and `tests/fixtures/blaxel-previews.mjs`
(envs, ports, previews, snapshots and forks). The test then times a new
sandbox's first command. It does this through the adapter and through
`withruntime`. The test does not start unless the free trial has an hour left.
It ends every sandbox it creates. It is not part of `bun run test`.

```bash no-run
bun packages/cloud-sdk/scripts/dropin-e2e.ts --only blaxel
```
