# Code written for Blaxel, on Runtime

Run code written for [Blaxel](https://docs.blaxel.ai/Sandboxes/Overview)'s
TypeScript sandbox SDK on Runtime Cloud by changing one import. It is part of
Runtime's SDK (`withruntime`), built on the same client, so it gets that SDK's
retries, idempotency keys and errors. Importing `withruntime` alone does not
load it.

```ts no-run
import { SandboxInstance } from "withruntime/blaxel"; // was: from "@blaxel/core"
```

The mapping was written against `@blaxel/core` 0.3.23 and Blaxel's sandbox API
source, checked 27 September 2026. Every name `@blaxel/core` exports can be
imported: code that only mentions an agent, model or MCP helper still loads.

## Keys

The package uses, in order: a Runtime key given to `initialize({ apikey })`,
`RUNTIME_API_KEY`, a Runtime key (`rtcloud_...`) left in `BL_API_KEY`, and the
key `npx withruntime login` saved on this machine. A Blaxel key is never sent
anywhere: in `BL_API_KEY` it is ignored, and passed to `initialize` while
`RUNTIME_API_KEY` is not set it throws `CredentialsError`. `BL_WORKSPACE` means
nothing on Runtime. With no Runtime key at all, the first call throws
`CredentialsError` saying what to set.

**A key sees only the sandboxes it created.** A sandbox made with another of
the account's keys answers 404, though its name stays taken
([teams](https://withruntime.com/docs/teams)). Services that share sandboxes by
name, or through `getByExternalId`, use the same Runtime key.

## What a sandbox gets

- **Machine:** Blaxel's default of 4096 MB. vCPUs follow Blaxel's rule of one
  per 2048 MB (at least one, at most 16): 2 for the default, 4 for 8192 MB. A
  trial sandbox has at most 4096 MB (2 vCPUs); `memory: 8192` or more needs
  prepaid credit, and on the trial is refused with a 400 (`invalid_trial`)
  saying so.
- **Image:** Blaxel's `base-image`, `py-app`, `ts-app`, `node`,
  `docker-in-sandbox` and `jupyter-server` are Runtime's stock image (Ubuntu
  24.04 with Node.js 24, Python 3.12, Bun, git and a compiler; Docker after
  `sudo enable-docker`). Any other image `ns/name:tag` is the ready Runtime
  image named `ns-name` (every `/` becomes `-`, as Runtime names hold none) at
  tag `tag` (`latest` when none is given). Build it once with
  `npx withruntime image build --dockerfile Dockerfile --name ns-name -t ns-name:tag`,
  and the code keeps `image: "ns/name:tag"` as it is.
- **Standby and lifetime:** a Blaxel sandbox goes to standby when unused and
  resumes on the next call. On Runtime it pauses after 60 seconds without a
  call (Runtime's shortest idle pause; Blaxel's is about 15 seconds), keeping
  its memory, files and processes, and wakes by itself on the next command,
  file call or preview visit. Its lease is Runtime's longest, an hour, and the
  adapter renews it in the background while the sandbox is in use; when a lease
  does run out the sandbox pauses rather than ends.
- **How long it is kept:** Blaxel keeps a sandbox until it is deleted or its
  TTL ends. A paused Runtime sandbox is kept 365 days when no TTL, expiry or
  lifecycle is given. With one, it is never deleted before Blaxel would delete
  it, and may be kept longer:
  - a `ttl`, `expires`, `ttl-max-age` or `date` within the hour is a lease that
    ends the sandbox at that time, or later if the sandbox paused and woke;
  - any other deadline, and any `ttl-idle`, keeps a paused sandbox that many
    days, rounded up, counted from each pause; with several, the shortest wins;
  - at most 365 days.

  On the free trial a paused sandbox is kept the trial's seven days, whatever
  the TTL; on credit, as above.

- **Envs:** `envs` are written once at create to a file on the sandbox
  (`/etc/runtime-blaxel/env`, readable by the sandbox user, changed only with
  sudo), and every process the adapter starts reads it, from any client, so
  `SandboxInstance.get(name)` in another program sees them too. A process's own
  `env` wins over the sandbox's. Values never appear in a command line.
- **Region:** `us-pdx-1`, `us-was-1` and `auto` are accepted (Runtime runs in
  one US region, east); any other, from `region` or `BL_REGION`, is refused.
- **Paths:** Blaxel's images work in `/blaxel`; Runtime's in `/workspace`.
  Relative paths, `~` and paths under `/blaxel` resolve against `/workspace`, in
  file calls and as a process's `workingDir`, and a command that names
  `/blaxel` finds a link to `/workspace`. Other absolute paths are themselves.
- **Funding:** left to Runtime, as `withruntime`'s own create: the free trial
  while the account has trial time, then prepaid credit. Pass
  `withruntime: { create: { funding: "trial" } }` to use only the trial.
- **Anything else Runtime offers:** `withruntime: { create: { ... } }` sends
  Runtime's create fields as they are; `sandbox.withruntime` is the Runtime
  sandbox underneath. Static calls take `{ withruntime: { client } }` as a last
  argument to use a given Runtime client.

## Mapping

| Blaxel                                                                                | On Runtime                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxInstance.create({ name, image, memory, labels, ports, envs, ... })`           | `sandboxes.create`. A name another live sandbox holds is a 409, as in Blaxel; one held by a sandbox still being deleted is waited for.                                                                                                                    |
| `createIfNotExists`                                                                   | `create` with `getOrCreate`: Runtime settles two callers racing for one name, and both get the one sandbox. An existing sandbox is answered as it is.                                                                                                     |
| `get(name)`, `getByExternalId`, `list({ limit, externalId, showTerminated })`         | The live sandbox with that name, or with the `externalId` label; Blaxel's paginated list (`data`, `nextPage`, `for await`, `autoPagingToArray`).                                                                                                          |
| `delete` (static and on the sandbox)                                                  | `stop`: the sandbox ends at once. Using that object afterwards is a 404.                                                                                                                                                                                  |
| `metadata`, `spec`, `status`, `state`, `lastUsedAt`, `expiresIn`                      | From the Runtime sandbox and its `blaxel/` labels (image, memory, ports, region, TTL, expiry, lifecycle, archived), which any client reads; `state` is `STANDBY` while paused.                                                                            |
| `updateMetadata`, `updateTtl`, `updateLifecycle`, `updateNetwork`                     | Labels (the display name and `externalId` are labels); the paused retention, as at create; network rules.                                                                                                                                                 |
| `archive`, `unarchive`                                                                | `pause`, `wake`. Runtime keeps memory and processes too, and the next call wakes it.                                                                                                                                                                      |
| `network: { allowedDomains, forbiddenDomains, proxy }`                                | Runtime network rules: `allow` and `deny`.                                                                                                                                                                                                                |
| `volumes: [{ name, mountPath }]`                                                      | The Runtime volume with that name, mounted read-write.                                                                                                                                                                                                    |
| `fetch(port, path, init)`                                                             | The request goes to a private Runtime preview of the port (made on first use, then reused) with its token.                                                                                                                                                |
| `process.exec` without `waitForCompletion`                                            | One Runtime process, answered running. Its Blaxel name is kept in its command line, so `get("name")` finds it from any client.                                                                                                                            |
| `process.exec({ waitForCompletion: true })`                                           | One streamed call, answered with `status`, `exitCode`, `stdout`, `stderr` and `logs`. Past `timeout` the wait ends with a 422 and the process runs on.                                                                                                    |
| `onLog`, `onStdout`, `onStderr`, `streamLogs`                                         | The process's output as it comes; `streamLogs` gives whole lines, as Blaxel's does.                                                                                                                                                                       |
| `process.get`, `wait`, `list`, `logs`, `stop`, `kill`, `writeStdin`, `closeStdin`     | Runtime processes by id or name. `wait` follows the output instead of polling. `stop` is SIGTERM, `kill` SIGKILL.                                                                                                                                         |
| `keepAlive`, `timeout`                                                                | The sandbox does not pause for idleness while the process may run (its `timeout`, 600 s by default, 0 for as long as a lease allows); once no `keepAlive` process runs, it gets its idle pause back.                                                      |
| `restartOnFailure`, `maxRestarts`, `waitForPorts`, `workingDir`, `env`, `stdin`       | A restart loop in the same process, with Blaxel's note in the output (`restartCount` counts the notes); a wait in the sandbox for the ports; as in Blaxel.                                                                                                |
| `fs.read`, `write`, `readBinary`, `writeBinary`, `writeTree`, `mkdir`, `rm`, `cp`     | Runtime's files API, or one command. A path only root may read or write (outside `/workspace`, or made by a root process) goes through sudo, as Blaxel's root-owned API could.                                                                            |
| `fs.ls`, `find`, `grep`, `search`                                                     | One command each, with Blaxel's defaults, limits and excluded directories. `ls` reports owners.                                                                                                                                                           |
| `fs.watch(path, callback, { withContent, ignore })`, `fs.download`                    | A Runtime watch (`path/**` for subdirectories); a download to the local disk.                                                                                                                                                                             |
| `previews.create`, `createIfNotExists`, `get`, `list`, `delete`                       | Runtime previews of `spec.port`, public or private. The Blaxel name is kept in a label, so any client finds it by name.                                                                                                                                   |
| `preview.tokens.create(expiresAt)`                                                    | A token for that long: at least a minute, at most a week. It is read from Blaxel's `X-Blaxel-Preview-Token` header or `?bl_preview_token=` as from Runtime's `x-runtime-preview-token` and `?runtime_preview_token=`, and never passed on to your server. |
| `snapshots.create`, `list`, `get`, `delete`; `Snapshot.create`, `get`, `list`, `fork` | Runtime snapshots, kept 365 days: files, memory and running processes.                                                                                                                                                                                    |
| `fork(name)`, `fork(name, { snapshotId, envs })`                                      | A Runtime fork of the running sandbox, or a new sandbox from the snapshot (by id, or by name among this sandbox's); `envs` are added over the source's.                                                                                                   |
| `CodeInterpreter.create`, `runCode`, `createCodeContext`                              | Runtime's interpreter, with the same result classes. The sandbox's envs reach every context.                                                                                                                                                              |
| `ResponseError`, `SandboxGatewayError`, `isGatewayError`, `isGatewayTimeout`          | Runtime's errors by Blaxel's names: `status` and `code` are the HTTP status; `runtimeCode`, `hint` and `requestId` are Runtime's.                                                                                                                         |

## Gaps

Each of these throws `NotSupportedError` before anything happens. Its `feature`
names the gap and its `alternative` says what to use.

| Blaxel                                                                                                                   | Use instead                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| An `image` with no ready Runtime image of the name it maps to (Blaxel's other templates too)                             | Build it: `npx withruntime image build --dockerfile Dockerfile --name ns-name -t ns-name:tag`; the error gives the exact command. |
| A region outside the US                                                                                                  | Runtime runs in one US region.                                                                                                    |
| `extraArgs` other than `iptables`; network `egress`, `firewall`, `subnet`, and a `proxy` with more than its domain lists | Remove them; `allowedDomains` and `forbiddenDomains` (on the network or its proxy); Runtime secrets.                              |
| Read-only and ephemeral volumes; a volume with no Runtime volume of that name                                            | Mount read-write; write scratch files under `/workspace`; `runtime.volumes.create`.                                               |
| `snapshots.restore`, `restore`                                                                                           | Fork from the snapshot into a new sandbox.                                                                                        |
| Forking into an application                                                                                              | Fork into a sandbox and share its port.                                                                                           |
| A preview's `prefixUrl`, `customDomain`, `requestHeaders`, `responseHeaders`, `ttl`                                      | Runtime's fixed preview address; set headers (CORS) in your server; delete the preview.                                           |
| `preview.tokens.list()`; a token for over a week                                                                         | Keep the tokens you create; create a new one when it runs out.                                                                    |
| `runCode` with `envs` for one run; a language Runtime's interpreter lacks                                                | Sandbox envs at create, or set them in the code; `process.exec`.                                                                  |
| Listing by `cursor`, `q`, `anchor`, a status other than `DEPLOYED`, or newest first                                      | List and filter the result yourself; `nextPage()` walks the pages.                                                                |
| `sandbox.sessions`, `schedules`, `codegen`, `system`, `drives`; `fromSession`                                            | Previews and tokens; your own scheduler; `fs.write`; nothing to upgrade; Runtime volumes.                                         |
| Agents, models, tools, MCP transports, jobs, applications, images, volumes, drives                                       | Your own agent with Runtime sandboxes, `withruntime/tools`, `npx withruntime mcp`, `runtime.images`, `runtime.volumes`.           |
| Blaxel's generated API functions (`createSandbox`, `postProcess`, ...)                                                   | `SandboxInstance` here, or `import { Runtime } from "withruntime"`.                                                               |

Some differences are not refusals:

- **A public preview needs a paid sandbox;** on the trial, share a port
  privately and use a token.
- **Commands run as root,** as on Blaxel: every process the adapter starts
  (`exec`, `keepAlive`, restart loops) hands over to passwordless `sudo`,
  keeping the envs, the sandbox user's `PATH` and `HOME` (`/workspace`, which
  stands for Blaxel's `/blaxel`). `id -u` prints 0 and `pwd` prints
  `/workspace`. Stopping or killing a process ends it and everything it
  started. The file calls act as the sandbox user and fall back to `sudo`
  where only root may go, so files a root process made stay readable,
  writable and removable through `fs`; a file the adapter rewrites that way
  becomes the sandbox user's. `ls`, `find`, `grep`, `search` and `writeTree`
  run as the sandbox user, so they skip what only root may read. The code
  interpreter's contexts run as the sandbox user (Blaxel's Jupyter server runs
  as root).
- **A paused sandbox keeps its memory and processes** across `archive`, where
  Blaxel's archive keeps only files and starts the processes again.
- **Standby starts after 60 seconds idle** rather than about 15, and a running
  process does not count as use unless it was started with `keepAlive`. A
  `keepAlive` process raises the sandbox's idle pause to its `timeout` (off for
  `timeout: 0`) and keeps the old one in the `blaxel/idlePauseSeconds` label.
  The old idle pause comes back once no `keepAlive` process runs, when a client
  sees one end (a waited exec, `wait` or `get`), stops or kills one, or calls
  `SandboxInstance.get`. With no such call, the sandbox pauses when it has been
  idle for that `timeout`. A `keepAlive` process past Runtime's hour-long lease
  is paused with the sandbox when the lease ends with no call to renew it, and
  carries on at the next call.
- **A name is not refused while its process runs:** a second process may take a
  running process's name, and `get(name)` answers the newest.
- **`process.list()` leaves each process's output empty** (Blaxel includes a
  tail of it); `get(name)` or `logs(name)` reads it. A process ended by a signal
  reports exit code -1 and `stopped` (SIGTERM) or `killed` (SIGKILL, or its
  time limit), from any client.
- **Runtime records a command's first 256 characters.** A process started with
  a longer command keeps its name; from another client its `command` is the
  start of what was run.
- **`fs.search`** scores matches by its own rule (characters in order, runs and
  word starts first), not Blaxel's fzf scores. `grep`'s `contextLines` is
  accepted and, as in Blaxel's API, not used.
- **`ls`, `find`, `grep`, `search` and `writeTree` run a short Python script,**
  so on an image without `python3` they throw `NotSupportedError`; `ls` then
  lists through the files API, without owners.
- **`spec.runtime.envs`, `network` and `volumes`** are known only to the client
  that created the sandbox; the envs themselves reach every process from any
  client. Port names are not kept: `ports` come back as numbers.
- A preview token shorter than a minute lasts a minute. Deleting one token
  revokes every token of that preview.

## The process line

A process's command line, which both this package and the Python one write
(`processLine` in `src/blaxel/context.ts`), so either finds and follows the
other's processes. One line, parts joined by `; `, quotes single with `'`
written `'\''`:

```text
: rt-blaxel '<name>'; [: rt-blaxel-keep; ]export HOST="${HOST:-0.0.0.0}"; [ -r /etc/runtime-blaxel/env ] && . /etc/runtime-blaxel/env; unset RUNTIME_BLAXEL_KEEP; [{ [ -e /blaxel ] || sudo ln -s /workspace /blaxel; } 2>/dev/null; ]__rt_cmd='<command>'; export __rt_cmd; exec sudo -E env "PATH=$PATH" "HOME=$HOME" bash -c '<run>'
```

`: rt-blaxel-keep;` is there for a `keepAlive` process; the link part when the
command or its env names `/blaxel`. `<run>` is `eval "$__rt_cmd"`, or with
`restartOnFailure` the restart loop:
`__rt_n=0; while :; do ( eval "$__rt_cmd" ); __rt_c=$?; [ $__rt_c -eq 0 ] && exit 0; [ $__rt_n -ge <max> ] && exit $__rt_c; __rt_n=$((__rt_n+1)); printf '\n[Process failed with exit code %d. Attempting restart %d/%s...]\n' $__rt_c $__rt_n '<max or unlimited>'; done`
(the `-ge` test left out when `maxRestarts` is negative). A process's own
`env` is sent with `RUNTIME_BLAXEL_KEEP=":NAME1:NAME2:"`, so the env file
leaves those names alone.

## Tests

`bun run test` in `packages/cloud-sdk` runs the unit tests against a fake of
Runtime's SDK: `tests/blaxel`, including a check that every name
`@blaxel/core` 0.3.23 exports is exported here.

The end-to-end test runs Blaxel's guides, unmodified but for the import,
against the real API: `tests/fixtures/blaxel-quickstart.mjs` (create, processes,
log streaming and files) and `tests/fixtures/blaxel-previews.mjs` (envs, ports,
previews, snapshots and forks). It then times a new sandbox's first command
through the adapter and through `withruntime`. It refuses to start unless the
free trial has an hour left, and ends every sandbox it creates. It is not part
of `bun run test`.

```bash no-run
bun packages/cloud-sdk/scripts/dropin-e2e.ts --only blaxel
```
