# Sandbox compatibility evidence

The compatibility modules are **partial, version-pinned sandbox adapters**. Their
exported methods translate to Runtime's native client. They do not replace every
service in a competitor's SDK. This document does not claim that all
applications switch over unchanged.

The four established modules are documented in `E2B.md`, `DAYTONA.md`, `VERCEL.md`
and `BLAXEL.md`. The six additional TypeScript modules below were checked against
published package declarations downloaded on 29 September 2026. Prime Intellect
publishes a Python sandbox SDK. Runtime does not invent a TypeScript drop-in
interface for it. Python coverage is in the Python SDK's compatibility documents.

The Cloudflare module implements the 0.x `@cloudflare/sandbox` API. Version 1.0.0
(published 30 September 2026) is a different package. It removes `getSandbox`,
the `Sandbox` class, `exec`, processes, sessions and preview proxying. It keeps
only `Files`, `S3Mount` and `DirectoryBackup`, for the caller's own Durable
Object. Version 1.0.1 (13 October 2026) has the same API. Its `dist/index.mjs`
is byte for byte the same as 1.0.0's. Its declarations export the same names
inline, not in one list. Its `zod` dependency moves from 4.5.4 to 4.6.5. README
example links change. The pin stays at 0.12.10. `compatibility-lock.json`
records 1.0.0 and 1.0.1 as reviewed and unsupported. `bun run compat:upstream`
flags any other release.

| Provider    | Published package inspected             | Runtime import            | Implemented sandbox surface                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runloop     | `@runloop/api-client` 2.0.0             | `withruntime/runloop`     | `Runloop`, basic `RunloopSDK` command handles, devbox create, get, list, suspend, resume and shutdown, disk snapshots. Synchronous and asynchronous commands. Resident named shells with variables, functions, aliases, options and working directory. Execution completion, output, stdin and signals. Text files.                                                                                                                    |
| CodeSandbox | `@codesandbox/sdk` 2.4.2                | `withruntime/codesandbox` | `CodeSandbox`, `VMTier`, create, fork, resume, shutdown, restart, hibernate, delete, list and get. Connected command and file clients. Output and status subscriptions, and same-client command restart. Configured tasks and setup steps. Public preview ports and readiness checks.                                                                                                                                                  |
| Fly Sprites | `@fly/sprites` 0.2.3                    | `withruntime/sprites`     | `SpritesClient`: create, lookup, list, delete and restart. `exec`, `execFile`, Node streams and event-based `spawn`. Attachable native processes. Binary, text and JSON files, directory traversal, append, chmod, chown, and `asRoot` through sudo. File watches. Preview access settings. Checkpoints as disk snapshots. Domain network policy. Session kill. Port watcher and port proxy. `APIError` with the vendor's limit codes. |
| Freestyle   | `freestyle` 0.2.20                      | `withruntime/freestyle`   | `Freestyle`: VM create, ref, get, list, start, pause, delete and update. Command execution, binary and text files and streams, and filesystem metadata. Native snapshots. Explicit deny-all or outbound-public firewall intent.                                                                                                                                                                                                        |
| Morph       | `morphcloud` 0.0.20                     | `withruntime/morph`       | `MorphCloudClient`: images list, snapshot create, get, list, delete and metadata, and cached `setup` chains. Instance start, boot, get, list, stop, pause, resume, branch and snapshot. Metadata, wake-on, TTL at start, streamed exec, HTTP services as previews, and file `sync`.                                                                                                                                                    |
| Modal       | `modal` 0.11.1                          | `withruntime/modal`       | `ModalClient`. App-name grouping. Registry images and Dockerfile layers. CPU sandbox create, get, list and name lookup. Idle timeout. Text and binary process streams and stdin. Commands as root. Command completion. Filesystem transfer. Metadata and watches. Tags. Encrypted public previews. Outbound domain and CIDR allowlists. Filesystem and memory snapshot capture.                                                        |
| Cloudflare  | `@cloudflare/sandbox` 0.12.10 (0.x API) | `withruntime/cloudflare`  | `getSandbox`, named Runtime sandboxes, explicit execution sessions, text exec and SSE output, background processes, logs, signals and waits, binary and text files, recursive listings, environment updates, signed Runtime previews, a conditional Worker Durable Object entry, a Worker preview proxy, and destruction.                                                                                                              |

### Modal's own examples, live (18 October 2026)

Every sandbox example in Modal's JavaScript SDK was copied verbatim into
`tests/fixtures/modal`. The examples are in `js/examples` at `js/v0.11.1`. There
are 26 files. `sandbox-gpu.ts` needs a GPU. The Functions examples call deployed
Functions. So those were not run. Only the import changed. The examples ran
against real Runtime sandboxes, using `scripts/compatibility-modal-examples-live.ts`.
That script is opt-in, with `--run`. Each sandbox is capped at two cents and five
minutes. Each sandbox is deleted when its example ends. These are the failures
and what changed:

- A layer's `secrets` (`image-building.ts`) stay refused. The error now names the
  alternative. A Runtime build keeps its build arguments in the image's build
  plan, history and cache key. So a secret is used at run time instead
  (`sandboxes.create(app, image, { secrets })` or `runtime.secrets.set`).
- `idleTimeoutMs` (`sandbox-tunnels.ts`) was refused. It is now Runtime's idle
  pause, which is 10 s at least, with memory kept. `timeoutMs` under a minute is
  kept by the client. Runtime's minute is the bound if the client goes away.
- Commands ran as the sandbox user, so `mkdir /app` failed
  (`sandbox-filesystem-snapshot.ts`). The entrypoint, `exec` and readiness probes
  now run as root, as in a Modal container.
- `poll()` threw after the sandbox ended (`sandbox-poll.ts`). It now returns the
  exit code it saw. For a process killed with its sandbox, it returns 137.
- `experimentalOptions` were refused as unknown. Now `enable_exit_snapshot`
  refuses, and the error names `snapshotFilesystem()` to call before
  `terminate()`.
- Allowlists were an intersection. Modal's domain and CIDR allowlists are a
  union. `*.x` also allows `x`.
- `client.functions`, `functionCalls`, `cls` and `queues` were undefined. Each
  call now refuses and names Runtime's alternative.
- A file watch in Alpine (no python3) failed, and its retry hid the reason. The
  server now runs the watcher on Runtime's own Python, in every image. A retried
  start replays the first one (`packages/cloud/src/watch/client.ts`).
- A snapshot of a running sandbox could fail. Another call woke the sandbox
  during the capture. That call was the entrypoint's open output stream. Now a
  call's wake waits for the capture (`cloud_wake_waits_for_capture` migration,
  `packages/cloud/src/api/guest-call.ts`).

The test `tests/compat/modal-examples.test.ts` fails on the old adapter.
`compat-inventory.json` records 226 present, 163 refused and 0 missing, out of 389.

### Fly Machines API (18 October 2026)

Fly publishes no TypeScript SDK for Machines. Its users call the REST API at
`api.machines.dev` with curl or an HTTP client, or they use fly-go. So
`withruntime/fly` answers the HTTP API itself. `machinesApi()` is a fetch
handler. `serveMachinesApi()` and `npx withruntime fly-api` serve it on a port.

Of the spec's 29 machine routes, 24 are answered. They are: list, create, get,
update, delete, start, stop, suspend, restart, wait, exec, signal, ps, events,
versions, metadata in all six forms, and lease get, acquire and release. The
other 5 refuse. They are the memory limit's get, set and reclaim (resize the
machine instead), and cordon and uncordon (no services). Apps, the org's
machines and the region list are answered too. Restart policies `always` and
`on-failure` (with `max_retries`) are kept by a supervisor loop around the main
process. `services`, `mounts`, `checks`, `processes`, GPUs, `files` from
secrets, and regions other than `iad` answer 400. The answer names the
alternative.

Evidence: `tests/compat/fly-contract.test.ts`. Also
`scripts/compatibility-fly-docs-live.ts --run`. It runs the 22 curl examples from
Fly's Machines API pages, verbatim (`tests/compat/fly-docs/machines-api-examples.sh`,
superfly/docs at 15f58f1f, read 18 October 2026). It also runs fly-go 0.11.6's
flaps client unchanged (`tests/compat/fly-go`) on the real API. And
`scripts/compatibility-fly-live.ts --run`.

### Modal 0.11.1 review (16 October 2026)

The pin moves from 0.11.0 to 0.11.1. Support stays partial. Both npm tarballs
were fetched into an empty directory. They matched the lock (0.11.0) and the
registry (0.11.1). The files were compared one by one, without installing or
running them. Only `package.json`, `README.md` and the four `dist` files changed.
Most of the declaration diff is generated protobuf types. These are the public
changes, and what `withruntime/modal` does with each:

- `sandboxes.fromName` and `experimentalFromName` take `includeTerminated`. When
  no sandbox of that name runs, the most recent terminated one is returned. The
  adapter follows this. A running sandbox with that name still wins. Otherwise,
  it returns the stopped one with the latest end time. Before, the option was
  refused as unknown.
- `client.environments` (`EnvironmentService`, `EnvironmentObjectsService`,
  `Environment`, `EnvironmentAppsService`) looks up, creates, lists and deletes
  Modal Environments. These are refused before any request, as the `environment`
  options already are. A Runtime account's sandboxes share one namespace, grouped
  by app name and tags.
- `App.info()` returns an App's lifecycle, its Functions and its Servers. It is
  refused. The error names `client.sandboxes.list({ appId })`. A Runtime app is a
  label on its sandboxes. It has no lifecycle, Functions or Servers.
- `volumes.fromName` takes a VolumeFS `version` (1 or 2). It is refused when
  given. A Runtime volume has one format.
- Sidecars take `includeOidcIdentityToken` and `proxy`. Sidecars were already
  refused as a whole. `functions.fromId`, `Function_.stats()`,
  `Function_.metrics` (`FunctionMetricsManager`), and the deprecation of
  `FunctionTimeoutError` for `FunctionCall.get` timeouts are Functions. They are
  outside the CPU sandbox scope. `FunctionMetricsManager` joins the inventory's
  outside list.

Nothing else needed a change. An internal `keys` argument was removed from
`Secret`'s constructor. `execWait` and `Sandbox._wait` take an internal abort
signal. `smol-toml` moves from ^1.3.3 to ^1.9.0. The README links a sidecar
identity-token example.

`tests/compat/modal-0-11-1.test.ts` fails on the old adapter.
`compat-inventory.json` records 221 present, 168 refused and 0 missing, out of 389. `tests/compat/reference.bun.lock` records the new `smol-toml` range. It
already resolved 1.9.0, so the opt-in reference install is unchanged. It was not
run again here.

### Morph 0.0.20 (15 October 2026)

`morphcloud` 0.0.20 (npm, 6 October 2025, the latest) is the TypeScript SDK. All
73 inventory items are present or refused. None is missing. This is how they map:

- An instance is a sandbox. A snapshot is a Runtime snapshot. Metadata becomes
  labels. `compat.provider` and `morph.*` stay the adapter's own labels. `stop`
  deletes the sandbox, as Morph's `stop` deletes the instance. Snapshots stay.
- `snapshots.create` boots the image at its size, keeps its disk and deletes the
  sandbox. `morphvm-minimal` is Runtime's default image. Any other ID must be a
  Runtime image. A digest becomes the snapshot's name (`morph-` plus its
  SHA-256). So `setup` caches by Morph's chain hash.
- `branch(n)` is one fork, with the snapshot kept. Copies keep memory and running
  processes.
- `ttlSeconds` is the time limit, from 60 to 86400. `ttlAction` `stop` deletes
  the sandbox. `pause` pauses it. Runtime also pauses an idle sandbox after five
  minutes, and wakes it on the next request. Morph does not do that.
- `exposeHttpService` is a preview. It is public with no `auth_mode`. That needs
  a kept top-up. It is private with `api_key`. Send its token as
  `x-runtime-preview-token`.
- `exec` with a string, or with a one-item array, runs in a shell. A longer array
  runs as arguments. The default timeout is 24 hours. A timeout throws, as
  Morph's does.
- These are refused, and the error names the alternative: `ssh`, `sshKey` and
  `sshKeyRotate` (use `runtime sandboxes ssh`); `reboot`; `setTTL` after start;
  `sync` with delete, dry run or .gitignore; and the raw `GET`, `POST` and
  `DELETE` verbs.
- `bun scripts/compatibility-morph-live.ts --run` runs the quickstart, the setup
  cache, the HTTP service, pause and resume, and the branch and snapshot calls
  against the real API.
- Morph's richer Python SDK (`morphcloud` 0.1.115, PyPI) has its own adapter,
  `withruntime.morph`. It is inventoried as `morph-python`. See
  [the Python document](../../sdks/python/COMPATIBILITY.md).

### Cloudflare 0.12.10 Worker examples, live (18 October 2026)

`tests/compat/cloudflare-examples/` holds Cloudflare's own Workers. They are
copied verbatim, with their source URL and the date they were read. They include
the `minimal` and `alpine` examples at the `@cloudflare/sandbox@0.12.10` tag, and
the get-started Worker. They also include the runnable 0.x snippets from the
docs. Those cover exec, streaming, files, background processes, the code
interpreter, preview URLs, sessions and `gitCheckout`. The only change in each
one is the package name. In `wrangler.jsonc`, the `containers` block is removed.
`fixtures.ts` lists what each example must answer. It also lists the examples
that were skipped, and why. The skipped ones use Workers AI, Artifacts, model
keys, backups, tunnels, terminals, placeholder repositories, or a call that
0.12.10 does not have.

- `RUNTIME_API_KEY=... bun scripts/compatibility-cloudflare-live.ts --run` builds
  the package. It runs each example under `wrangler dev` (workerd), with the key
  as a Worker secret. It sends the requests the docs describe, and checks the
  answers. A local relay caps the run at 12 sandboxes. Each sandbox gets a
  10-minute limit and a cost cap. The relay labels them with the run. It deletes
  them after each Worker, and again at the end.
- 18 October 2026: 58 of 58 checks passed. 9 sandboxes were created. All were
  deleted.
- The run found these problems. The Worker's Durable Object lacked most of the
  module's calls. `gitCheckout`, `runCode`, `streamProcessLogs` and the session
  calls failed with "RPC receiver does not implement". `waitForPort` was missing.
  Local preview URLs were not Cloudflare's
  `http://<port>-<id>-<token>.localhost`. `readFile` had no `mimeType`. And 14 of
  upstream's value exports and about 70 of its types were missing.
  `tests/compat/cloudflare-worker-surface.test.ts` checks each one.
- These differences stay. A sandbox holds at most 4 code contexts. A fifth
  `createCodeContext` call says how to free one. A process's `pid` is not
  reported. `processId` and `autoCleanup` refuse. Errors across a Durable Object
  call keep their message but not `code`, as on Cloudflare.

### Freestyle 0.2.18, 0.2.19 and 0.2.20 review (15 October 2026)

The pin moves from 0.2.17 to 0.2.20. Support stays partial. The four npm tarballs
were fetched into an empty directory. They matched the lock (0.2.17) and the
registry (the rest). They were compared file by file, without installing or
running them.

- 0.2.18, PTY connections. `open` and `attach` take `reconnect` (`true` or
  `timeoutMs`, `initialDelayMs`, `maxDelayMs`), `connectTimeoutMs`,
  `onStateChange`, `onReplayStart` and `onReplayEnd`. They check the timers with a
  `RangeError`. `PtySession` gets `ready`, `state` and `reconnect()`. While
  disconnected, `write` and `signal` throw `PTY is not connected`. `resize` is
  remembered, and applied again after a reattachment. `detach` cancels recovery,
  and reports `Detached` once. Before, the adapter refused each new option with
  `CompatibilityError`. Now a dropped connection reattaches to the same Runtime
  process, with Freestyle's backoff. First, it checks that the process still
  exists. A 4xx other than 409 or 429 ends the session. Nothing typed is
  replayed. A Runtime terminal replays the session's output from its start on
  each connection. It does not mark where the replay ends, as Freestyle's older
  guest agents do. So the replay callbacks never fire, and a replay begins at the
  `connected` state. Runtime terminals send no keepalive, so a silent connection
  is not timed out. The browser's online and visibility events retry a closed
  session. A first connection waits `connectTimeoutMs` only when it is given.
  Before, there was no wait limit.
- 0.2.18, new `connectXterm({ pty, terminal, slug, ... })`, and the
  `XtermTerminal` and `ConnectXtermOptions` types. It runs on the same sessions.
  Reconnect is on by default. The screen resets at each connection. The
  terminal's queries are muted until the replay is written.
- 0.2.18, browser PTYs now need an identity access token (a WebSocket
  subprotocol). Identity tokens are refused here. Runtime terminals authenticate
  with the Runtime key. `@xterm/xterm` is a new dev dependency only, so the
  reference install is unchanged.
- 0.2.18, `PtySessionInfo.slug` is now documented as kept after the shell exits,
  until the session is closed. (`open`'s get-or-create doc already said so.) This
  is not followed. Runtime keeps exited processes and cannot remove one. So a slug
  kept after exit could never be opened again. A slug is still released when its
  shell exits.
- 0.2.19 changes only its version. 0.2.20 adds `expiresAt` to identity access
  tokens. That is in the identities product, which this adapter does not provide.

### Freestyle 0.2.17 review (11 October 2026)

The pin moves from 0.2.16. Support stays partial. The exact npm tarballs were
compared, without installing or running them.

- A new `FreestyleTransportError` (a `TypeError` with `errors` and `toJSON`)
  covers a fetch that got no HTTP response. The adapter throws it, with the
  native `ConnectionError` as `cause`. Before, it threw `FreestyleApiError`.
- `exec` takes `timeoutMs` up to 24 hours on guest agents with native resumable
  exec. Otherwise the limit is 5 minutes (`AGENT_UNSUPPORTED`). Runtime passes
  the value to its native exec unchanged. The adapter does not change.
- `ListObjects` joins the S3 operations of the TLS edge. It is refused here, with
  the rest of `tls`. Identity-token clients now run execs in the background.
  Identity tokens are refused here. Other changes are docs-only.

### Runloop 2.0.0 review (8 October 2026)

Both `@runloop/api-client` and the Python `runloop-api-client` 2.0.0 keep the
covered sandbox API. Both pins move up. Support stays partial. The exact npm
tarballs, and every PyPI wheel and source archive for 1.32.0 and 2.0.0, were
compared. They were not installed or run. The Python wheel and source contents
match. The upstream checker needs no new record type. This is a sandbox adapter
update. It is not a refusal of the major release, and it is not a deferred
source check.

- Both releases remove benchmark jobs and runs, scenarios, scorers, their types
  and pagination. They also remove the shared `RunProfile`, the benchmark and
  scenario key scopes, and the `scenario` and `scoring_validation` devbox
  initiators. Python also removes `InputContextPreview`. None of these was
  implemented by these adapters.
- In JavaScript, execution `sendStdIn` now requires a body. The overload that
  takes only options is removed. In both languages, the call takes exactly one
  non-empty text value or signal. The adapters validate before lookup. They map
  text, EOF and INTERRUPT to native process input, EOF and SIGINT. Python's new
  synchronous and asynchronous `Execution.send_std_in` and `close_std_in` helpers
  are implemented, with scoped request timeouts. JavaScript adds
  `RunloopSDK.devbox.create` and `fromId`, `cmd.exec` and `execAsync`, and
  execution handles. The handles have `sendStdIn` and `closeStdIn`, plus state,
  kill, and result and output methods. The handle calls the same validated
  low-level input path. It throws `RunloopError` on an unsuccessful reply. This is
  a basic command facade, not the full upstream high-level SDK. Callback
  streaming and extra polling options are refused, and the error names the native
  alternative. File, shell, snapshot and list workflows still use the low-level
  adapter.
- New `SecretById` and `AsyncSecretById` handles. Retrieve, update and
  delete-by-ID calls select exact secret rows. Name reads and updates select the
  row with the greatest ID. Deleting by name removes all selected rows with that
  name, but not in one atomic step. Runloop's duplicate secret rows and its
  injected environment-secret behavior are not Runtime's host-scoped secret API.
  Access to the secret namespace is refused, and the error names the native
  alternative.
- Objects add `upload_headers`. Upload helpers keep those headers. They keep API
  credentials isolated, refuse redirects and retries, and redact upload errors.
  Python's storage wrappers accept optional headers, and clear them when the
  upload completes. The adapter refuses Runloop storage objects. It points to
  Runtime sandbox files instead.
- Axons add `deleted_at_ms`. They keep readable deleted registry entries, and
  refuse updates. Gateway, MCP and network-policy names become reusable labels.
  Devbox gateway and MCP names bind the newest configuration. These provider
  service namespaces refuse explicitly. The error names Runtime events, secrets
  or sandbox egress settings as the alternative. These are not equivalent
  Runloop services.
- Tunnel docs now say that omitting authentication means open, public access.
  Runloop tunnels stay outside the covered surface. Use Runtime signed previews.
  Python's custom CPU annotations change from integer to float, which allows 0.5
  cores upstream. The adapters still refuse fractional CPU before allocation. They
  direct callers to Runtime's whole cores.

The focused tests use simulated native processes, transports and guest state.
They do not run the downloaded SDKs. They do not prove live Runloop behavior,
Linux isolation, durability, host recovery, or a competitor performance margin.

## Authentication and resources

Set `RUNTIME_API_KEY`, or sign in with `runtime login`. An explicitly supplied
Runtime key begins with `rtcloud_`. Vendor credentials passed to a replaced
constructor are discarded on the client. They are never sent to Runtime. Every
adapter also accepts an injected native `Runtime` client, for tests or custom
transports. The conditional Worker entry reads the `RUNTIME_API_KEY` Worker
secret and the optional `RUNTIME_API_URL`. A Durable Object binding is not a
Runtime credential.

CodeSandbox, Sprites and Freestyle ask Runtime to keep their sandboxes
persistent. That keeps the lifetime the caller asked for. Persistent sandboxes
need paid credit. Runloop turns on persistence only when the caller explicitly
suspends. A native stop keeps its disk. A resume boots that disk again, without
restoring old processes. Paid admission must succeed before the stop. If the
result of a stop is uncertain, persistence stays on. The caller can then retry
without losing data. Lifecycle calls run one at a time within one client.
Opposite intents from different clients depend on native transition admission.

Runtime's admission, credit, disk and CPU limits stay in charge. An adapter does
not buy resources, override account limits, or promise another provider's
capacity. Supported explicit regions use Runtime's region names. Unsupported
provider regions, GPU requests and fractional CPU shapes fail before allocation.
They do not silently get different hardware.

Environment variables are stored in a sandbox-private file with mode 0600, not in
resource labels. Reconnecting clients read the file. Snapshots keep it, unless an
explicit replacement environment is given. Python and TypeScript share the file
path and the `compat.provider` resource label.

## Evidence that can be repeated locally

Run `bun test tests/compat` from the SDK package. Then run `bun run check-types`.
The type check (`tests/compat/consumers/tsconfig.json`) compiles unchanged typed
consumer bodies from `tests/compat/consumers/workflows.ts`. It checks them
against all ten TypeScript adapters, including E2B's interpreter. To compile the
same bodies against the pinned upstream declarations, run
`bun tests/compat/check-consumers.ts <verified-cache>`. The script checks each
package name and version against the lock before it compiles. Both targets
passed on 29 September 2026. Only import resolution changes between the two runs.

The published-package behavior checks can also be repeated. First, prepare the
integrity-checked cache with the SDK's compatibility preparation command. Then
run `bun tests/compat/prepare-runtime.ts <verified-cache> <reference-directory>`.
It copies published packages without changing the cache. It removes build-only
development dependencies from the copied manifests. It installs runtime
dependencies with scripts turned off, using the checked-in frozen
`tests/compat/reference.bun.lock`. Then run
`bun tests/compat/compare-upstream.ts <verified-cache> <reference-directory>`, and
`bun tests/compat/worker-local.ts <reference-directory>/node_modules/miniflare <reference-directory>`.

| Published implementation executed          | Shared behavior compared                                                      | Instrument boundary                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Sprites filesystem                         | Binary, text and JSON files, dotfiles, directory entries, missing-file errors | Controlled HTTP, against Runtime's native API router and a simulated guest                                                          |
| Freestyle filesystem                       | Blob and string writes, progress, byte ranges, streamed slices                | Controlled HTTP, against Runtime's native API router and a simulated guest                                                          |
| Runloop client                             | Create, text files, command results, shutdown                                 | Controlled HTTP, against Runtime's native API router and a simulated guest                                                          |
| CodeSandbox client                         | Creation defaults, tags, metadata, hibernate and delete                       | Controlled HTTP. Native metadata and lifecycle are modeled, because the fixture has no orchestration database.                      |
| Modal client and Sandbox                   | Tag replacement and clearing, and terminate                                   | Published injected control-plane client. Native metadata and lifecycle are modeled.                                                 |
| Cloudflare getSandbox and session wrappers | ID validation, sessions, file calls, exec, process waits                      | Both run in pinned local workerd, against Runtime's Durable Object and a simulated guest. The official Container daemon is not run. |

All six comparisons passed locally on 29 September 2026. They show the stated
client behavior, with controlled responses. They do not prove that hosted vendor
services are equivalent.

The new adapter contract tests drive Runtime's actual API router, request
validation and response schemas, with a simulated guest. They cover:

- Command failures, and output from asynchronous execution.
- Reconnection, with the environment kept and dotfile paths unchanged.
- Binary file transfers larger than the native single-request limit.
- Large append staging and cleanup.
- Refusal of unsupported resource options before allocation.
- Failed initialization cleanup, including a second failure during cleanup.
- Keeping a snapshot's environment when no override was given.
- Never sending vendor credentials to Runtime.
- Stopping paused persistent sandboxes before their disk is released. This
  includes a pause that races a client's cached state. It does not wake them.
- Named-shell environment and working-directory persistence in real local Bash,
  nonzero exits, variable-name collisions, and explicit per-call overrides. The
  resident broker also tests function, alias and option persistence, return, exit
  and exec, concurrent calls, cancellation, an overridden printf, and an invalid
  command PATH.
- Cloudflare session callbacks, files and process waits. Modal process streams,
  stdin, files and entrypoint completion. These two tests replace create and
  image orchestration, because the simulated-guest fixture has no database or
  image builder.

The optional `tests/compat/live.ts` runner needs `--run`, an explicit Runtime
key, and at least one trial hour left. It allocates at most six resources. It
forces trial funding and short leases. It records every ID it creates, and tries
to clean up all of them, even after a failure. It does not build images, create
snapshots or expose public previews. Its explicit persistence override makes it
an execution and file smoke test. It is not evidence of paid persistent lifetime
behavior.

Local tests do not prove cross-host durability, Linux isolation, vendor runtime
image equivalence, public Worker hosting, or performance against a competitor.
The measured results of live acceptance belong in its run report.

## Exact boundaries of this version

These boundaries describe the present behavior. They are not a second to-do list.
Remaining implementation work is tracked only in the repository's `WORKLIST.md`.

| Provider    | Boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All six     | Default sandboxes use Runtime's environment. Explicit vendor image, template or snapshot IDs must be migrated to Runtime. Arbitrary foreign IDs are not swapped for a stock image. Provider credential formats, wire protocols, error hierarchies and every optional transport hook are not interchangeable. Retained process output is bounded. Binary process mode needs the native byte-output capability (`outputEncoding`). An API or guest without it refuses before execution. This capability has only local release evidence here.                                                                                                                                                                                                                                                                                                                                                                                  |
| Runloop     | Blueprints name Runtime image IDs or names. Snapshots name Runtime snapshots. No provider blueprint builds, mounts, secret gateways, MCP grants, lifecycle hooks or ARM placement. `X_SMALL` and fractional CPU shapes are refused. Named shells use a resident Bash process. Interactive stdin in named shells is refused. `snapshotDisk` takes a blocking, disk-only native snapshot. `snapshotDiskAsync` is refused. A memory snapshot is refused as a disk snapshot. Snapshot metadata beyond Runtime's label limits is refused. `diskSnapshots` lists, updates, polls and deletes them. Devbox and snapshot lists return cursor pages. You can await them, or iterate across pages. The generated `APIPromise` wrapper and its response helpers are not copied.                                                                                                                                                         |
| CodeSandbox | No browser editor or Pitcher protocol, no browser-session tokens, no interpreters, no live VM resizing, no fork tier changes, no read-only or global editor sessions, and no private host-token emulation. Configured tasks run under a guest supervisor. Setup steps run under a guest runner. Both are started by the adapter, and both survive client disconnects. A task's port must be set with `task.preview.port`, because automatic task-to-port discovery is refused. Private host-only preview requests fail explicitly. Native signed preview URLs stay available. Public port discovery lists registered previews, not every listening socket. The default workspace is prepared at `/project/sandbox`. Command restart keeps the originating client's captured argv, environment and working directory. A command that another client found refuses restart, because its private spawn recipe is not available. |
| Sprites     | No control-mode WebSocket protocol, managed services, in-place checkpoint restore (start a new sandbox from the snapshot instead), checkpoint history filters, network presets (`include`), an allow rule inside a denied wildcard (Runtime's deny always wins), privilege or resource policies, `maxRunAfterDisconnect`, Fly token exchange, or Sprite list streaming. Each one is refused by name. A checkpoint is a Runtime disk snapshot. It holds files, not running processes. The Sprite pauses for the moment it takes. An allow rule makes an allowlist, as Sprites' DNS allowlist does. The port watcher polls `ss` once a second. Session handles use native process IDs, not tmux. The sprite URL maps port 8080. File bytes and process byte streams keep binary data.                                                                                                                                          |
| Freestyle   | Provider catalog snapshot slugs are not Runtime snapshots, and are refused. Firewall support is limited to an explicit empty rule set, or the exact allow-public-outbound shape. Arbitrary rule selectors, TLS policies and private networks are refused. No automatic-restart guarantee, retention scheduler, placement constraints, live resize, Linux-user switching, PTY namespace, public IPv6, or account-owned egress address emulation. Native snapshot retention is in whole days, and must be positive.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Modal       | CPU sandboxes only. Different resource reservation or limit values, fractional CPU, GPUs and foreign placement are refused. Named Apps group Runtime sandboxes. They do not deploy Functions. Registry authentication uses Runtime's registry configuration. Commands run as root. There are no Functions, Cls or queues. No named secrets, volumes made on first use, GPU image steps, sidecars, connect tokens, proxies, directory or exit snapshots, or snapshot restore API. Each one refuses and names the alternative. Entrypoint completion stops the sandbox while the originating client is alive. The native lease is the bound if that client disappears. A different client can reconnect with the saved entrypoint process ID.                                                                                                                                                                                  |
| Cloudflare  | The conditional Worker entry supplies a Durable Object bridge and a custom-hostname preview proxy. Infrastructure configuration must still remove the vendor Container declaration, and provide Runtime secrets. Cloudflare's examples run live under `wrangler dev` (above). Custom preview routing has no live public-hostname acceptance evidence. At most 4 interpreter contexts. No isolated PID namespaces, backup format, terminal WebSocket protocol, custom process IDs, or provider cleanup-record semantics. Foreground named sessions use resident Bash. Background processes inherit exported state and the working directory. They do not yet inherit every local variable, function or option.                                                                                                                                                                                                                |

## Keeping compatibility current

`compatibility-lock.json` records the inspected versions and package integrity.
The repository's upstream check finds new releases and changed package contents.
A deprecated npm package, or a yanked Python release, also needs review. A
registry failure never counts as a pass. The daily workflow is kept in source
control. It does not run until the code is pushed to a repository with working
GitHub Actions.

A changed pin is evidence to review. It does not let us announce compatibility.
Compare the published declarations. Replay the relevant consumer, unchanged.
Test its failure paths. Then update this coverage table in the same change.
