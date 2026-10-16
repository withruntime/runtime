# Sandbox compatibility evidence

The compatibility modules are **partial, version-pinned sandbox adapters**. Their
exported methods translate to Runtime's native client. They are not replacements
for every service in a competitor's SDK, and this document does not claim that
all applications switch unchanged.

The four established modules are documented in `E2B.md`, `DAYTONA.md`, `VERCEL.md`
and `BLAXEL.md`. The six additional TypeScript modules below were checked against
published package declarations downloaded on 29 September 2026. Prime Intellect
publishes a Python sandbox SDK; Runtime does not invent a TypeScript drop-in
interface for it. Python coverage is in the Python SDK's compatibility documents.

The Cloudflare module implements the 0.x `@cloudflare/sandbox` API. Version 1.0.0,
published 30 September 2026, is a different package: it removes `getSandbox`, the
`Sandbox` class, `exec`, processes, sessions and preview proxying, and keeps only
`Files`, `S3Mount` and `DirectoryBackup` for the caller's own Durable Object. The
pin stays 0.12.10; `compatibility-lock.json` records 1.0.0 as reviewed and
unsupported, and `bun run compat:upstream` flags any other release.

| Provider    | Published package inspected             | Runtime import            | Implemented sandbox surface                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runloop     | `@runloop/api-client` 2.0.0             | `withruntime/runloop`     | `Runloop`, basic `RunloopSDK` command handles, devbox create/get/list/suspend/resume/shutdown, disk snapshots; synchronous and asynchronous commands, resident named shells with variables, functions, aliases, options and working directory, execution completion/output/stdin/signals, text files                                                                                                                     |
| CodeSandbox | `@codesandbox/sdk` 2.4.2                | `withruntime/codesandbox` | `CodeSandbox`, `VMTier`, create/fork/resume/shutdown/restart/hibernate/delete/list/get; connected command and file clients; output/status subscriptions and same-client command restart; configured tasks and setup steps; public preview ports and readiness checks                                                                                                                                                     |
| Fly Sprites | `@fly/sprites` 0.2.3                    | `withruntime/sprites`     | `SpritesClient`, create/lookup/list/delete/restart; `exec`, `execFile`, Node streams and event-based `spawn`; attachable native processes; binary/text/JSON files, directory traversal, append, chmod, chown and `asRoot` through sudo, file watches; preview access settings; checkpoints as disk snapshots; domain network policy; session kill; port watcher and port proxy; `APIError` with the vendor's limit codes |
| Freestyle   | `freestyle` 0.2.17                      | `withruntime/freestyle`   | `Freestyle`, VM create/ref/get/list/start/pause/delete/update; command execution, binary/text files and streams, filesystem metadata; native snapshots; explicit deny-all or outbound-public firewall intent                                                                                                                                                                                                             |
| Modal       | `modal` 0.11.0                          | `withruntime/modal`       | `ModalClient`, app-name grouping, registry images and Dockerfile layers, CPU sandbox create/get/list/name lookup, text/binary process streams and stdin, command completion, filesystem transfer and metadata, tags, encrypted public previews, outbound allowlists, memory snapshot capture                                                                                                                             |
| Cloudflare  | `@cloudflare/sandbox` 0.12.10 (0.x API) | `withruntime/cloudflare`  | `getSandbox`, named Runtime sandboxes, explicit execution sessions, text exec and SSE output, background processes, logs/signals/waits, binary/text files, recursive listings, environment updates, signed Runtime previews, conditional Worker Durable Object entry, Worker preview proxy, destruction                                                                                                                  |

### Freestyle 0.2.17 review (11 October 2026)

The pin advances from 0.2.16; support remains partial. The exact npm tarballs
were compared without installing or executing them.

- New `FreestyleTransportError` (a `TypeError` with `errors` and `toJSON`) for a
  fetch that got no HTTP response. The adapter throws it, with the native
  `ConnectionError` as `cause`, where it used to throw `FreestyleApiError`.
- `exec` accepts `timeoutMs` up to 24 hours on guest agents with native
  resumable exec, else 5 minutes (`AGENT_UNSUPPORTED`). Runtime passes the
  value to its native exec unchanged; no adapter change.
- `ListObjects` joins the S3 operations of the TLS edge (refused here with the
  rest of `tls`). Identity-token clients now background execs; identity tokens
  are refused here. Docs-only changes elsewhere.

### Runloop 2.0.0 review (8 October 2026)

Both `@runloop/api-client` and Python `runloop-api-client` 2.0.0 retain the
covered sandbox API. Both pins advance; support remains partial. The exact npm
tarballs and every PyPI wheel/source archive for 1.32.0 and 2.0.0 were compared
without installing or executing them. Python wheel and source package contents
match. The upstream checker needs no new record type: this is a sandbox adapter
update, not a refusal of the major release or deferred source qualification.

- Both releases remove benchmark jobs/runs, scenarios, scorers, their types and
  pagination, shared `RunProfile`, benchmark/scenario key scopes, and the
  `scenario`/`scoring_validation` devbox initiators. Python also removes
  `InputContextPreview`. None was implemented by these sandbox adapters.
- JavaScript execution `sendStdIn` now requires a body; the options-only overload
  is removed. Both languages require exactly one nonempty text value or signal.
  The adapters validate before lookup and map text, EOF and INTERRUPT to native
  process input, EOF and SIGINT. Python's new synchronous/asynchronous
  `Execution.send_std_in` and `close_std_in` helpers are implemented with scoped
  request timeouts. JavaScript adds `RunloopSDK.devbox.create`/`fromId`,
  `cmd.exec`/`execAsync`, and execution handles with `sendStdIn`/`closeStdIn`,
  state, kill and result/output methods. The handle calls the same validated
  low-level input path and throws `RunloopError` on an unsuccessful reply.
  This is a basic command facade, not the full upstream high-level SDK:
  callback streaming and extra polling options refuse with native alternatives;
  file, shell, snapshot and list workflows still use the low-level adapter.
- New `SecretById`/`AsyncSecretById` handles and retrieve/update/delete-by-ID calls
  select exact secret rows. Name reads/updates instead select the greatest ID;
  deletion removes all selected same-name rows nonatomically. Runloop's duplicate
  secret rows and injected environment-secret semantics are not Runtime's
  host-scoped secret API. Access to the secret namespace refuses explicitly and
  names that native alternative.
- Objects add `upload_headers`; upload helpers preserve those headers, isolate
  API credentials, refuse redirects/retries and redact upload errors. Python's
  storage wrappers accept optional headers and clear them on completion. The
  adapter refuses Runloop storage objects and points to Runtime sandbox files.
- Axons add `deleted_at_ms` and retain readable deleted registry entries while
  refusing updates; gateway/MCP/network-policy names become reusable labels, and
  devbox gateway/MCP names bind the newest configuration. Those provider service
  namespaces refuse explicitly, naming Runtime events, secrets or sandbox egress
  settings as the alternative; these are not equivalent Runloop services.
- Tunnel documentation clarifies that omitted authentication means open/public.
  Runloop tunnels remain outside the covered surface; use Runtime signed
  previews. Python custom CPU annotations change from integer to float, allowing
  0.5 cores upstream; the adapters still refuse fractional CPU before allocation
  and direct callers to Runtime whole cores.

The focused tests use simulated native processes/transports and guest state.
They do not execute the downloaded SDKs or prove live Runloop behavior,
Linux isolation, durability, host recovery, or a competitor performance margin.

## Authentication and resources

Set `RUNTIME_API_KEY` or sign in with `runtime login`. An explicitly supplied
Runtime key begins with `rtcloud_`. Vendor credentials supplied to a replaced
constructor are discarded locally, never forwarded to Runtime. Every adapter
also accepts an injected native `Runtime` client for testing or configured
transports. The conditional Worker entry reads the `RUNTIME_API_KEY` Worker secret and optional
`RUNTIME_API_URL`; a Durable Object binding is not a Runtime credential.

CodeSandbox, Sprites and Freestyle request Runtime persistence to preserve their
resource-lifetime intent. Persistent sandboxes require paid credit. Runloop enables persistence only when the caller
explicitly suspends: native stop retains its disk and resume boots that disk afresh,
without restoring old processes. Paid admission must succeed before stopping. An
uncertain stop keeps persistence enabled so the caller can retry without discarding
data. Lifecycle calls serialize within one client; competing opposite intents from
different clients rely on native transition admission. Runtime
admission, credit, disk and CPU limits remain authoritative; an adapter does not
buy resources, override account limits or promise another provider's capacity.
Supported explicit regions use Runtime's region names. Unsupported provider
regions, GPU requests and fractional CPU shapes fail before allocation rather
than silently receiving different hardware.

Environment variables are stored in a sandbox-private file with mode 0600, not
in resource labels. Reconnecting clients read the file; snapshots preserve it
unless an explicit replacement environment is supplied. Python and TypeScript
share the file path and `compat.provider` resource label.

## Evidence that can be repeated locally

Run `bun test tests/compat` from the SDK package and run `bun run check-types`.
The test run compiles unchanged typed consumer bodies from
`tests/compat/consumers/workflows.ts.txt` against all ten TypeScript adapters,
including E2B's interpreter. Run
`bun tests/compat/check-consumers.ts <verified-cache>` to compile the
same bodies against the pinned upstream declarations; the script checks each
package name and version against the lock before compiling. Both targets passed
on 29 September 2026. Only import resolution changes between the two runs.

The published-package behavior checks are also reproducible. Prepare the integrity-verified
cache with the SDK's compatibility preparation command. Run
`bun tests/compat/prepare-runtime.ts <verified-cache> <reference-directory>`;
it copies published packages without modifying the cache, removes build-only development
dependencies from copied manifests, and installs runtime dependencies with scripts disabled
and the checked-in frozen `tests/compat/reference.bun.lock`. Then run
`bun tests/compat/compare-upstream.ts <verified-cache> <reference-directory>` and
`bun tests/compat/worker-local.ts <reference-directory>/node_modules/miniflare <reference-directory>`.

| Published implementation executed      | Shared behavior compared                                                 | Instrument boundary                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Sprites filesystem                     | Binary/text/JSON files, dotfiles, directory entries, missing-file errors | Controlled HTTP versus native API router and simulated guest                                                                    |
| Freestyle filesystem                   | Blob/string writes, progress, byte ranges, streamed slices               | Controlled HTTP versus native API router and simulated guest                                                                    |
| Runloop client                         | Create, text files, command results, shutdown                            | Controlled HTTP versus native API router and simulated guest                                                                    |
| CodeSandbox client                     | Creation defaults, tags, metadata, hibernate/delete                      | Controlled HTTP; native metadata/lifecycle modeled because fixture has no orchestration database                                |
| Modal client and Sandbox               | Tag replacement/clearing and terminate                                   | Published injected control-plane client; native metadata/lifecycle modeled                                                      |
| Cloudflare getSandbox/session wrappers | ID validation, sessions, file calls, exec, process waits                 | Both run in pinned local workerd against Runtime's Durable Object and simulated guest; the official Container daemon is not run |

All six comparisons passed locally on 29 September 2026. They establish the stated
client behavior with controlled responses, not equivalence of hosted vendor services.

The new adapter contract tests drive Runtime's actual API router, request
validation and response schemas with a simulated guest. They exercise:

- Command failures and asynchronous execution output.
- Reconnection with retained environment and unchanged dotfile paths.
- Binary file transfers larger than the native single-request limit.
- Large append staging and cleanup.
- Refusal of unsupported resource options before allocation.
- Failed initialization cleanup, including a second failure during cleanup.
- Preserving a snapshot's environment when no override was given.
- Never forwarding vendor credentials to Runtime.
- Stopping paused persistent sandboxes before releasing their disk, including a
  pause racing a client's cached state, without waking them.
- Named-shell environment and working-directory persistence in real local Bash,
  nonzero exits, variable-name collisions, and explicit per-call overrides. The resident
  broker also exercises function/alias/option persistence, return/exit/exec, concurrent
  calls, cancellation, overridden printf and an invalid command PATH.
- Cloudflare session callbacks/files/process waits and Modal process streams,
  stdin, files and entrypoint completion. These two tests replace create/image
  orchestration because the simulated-guest fixture has no database/image builder.

The optional `tests/compat/live.ts` runner requires `--run`, an explicit Runtime
key, and at least one remaining trial hour. It allocates at most six resources,
forces trial funding and short leases, records every created ID, and attempts
cleanup for all IDs even after a failure. It does not build images, create
snapshots or expose public previews. Its explicit persistence override makes it
an execution/file smoke test, not evidence of paid persistent lifetime behavior.

Local tests do not prove cross-host durability, Linux isolation, vendor runtime
image equivalence, public Worker hosting, or performance against a competitor.
The measured results of live acceptance belong in its run report.

## Exact boundaries of this version

These boundaries describe present behavior, rather than a second worklist.
Remaining implementation work is tracked only in the repository `WORKLIST.md`.

| Provider    | Boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All six     | Default sandboxes use Runtime's environment. Explicit vendor image/template/snapshot IDs require migration to Runtime; arbitrary foreign IDs are not substituted with a stock image. Provider credential formats, wire protocols, error hierarchies and every optional transport hook are not interchangeable. Retained process output is bounded. Binary process mode requires the native byte-output capability (`outputEncoding`); an API or guest without it refuses before execution. This capability has only local release evidence here.                                                                                                                                                                                                                                                                                                                                                      |
| Runloop     | Blueprints name Runtime image IDs/names; snapshots name Runtime snapshots. No provider blueprint builds, mounts, secret gateways, MCP grants, lifecycle hooks or ARM placement. `X_SMALL`/fractional CPU shapes are refused. Named shells use a resident Bash process. Interactive stdin in named shells is explicitly refused. `snapshotDisk` takes a blocking disk-only native snapshot; `snapshotDiskAsync` is refused, a memory snapshot is refused as a disk snapshot, and snapshot metadata beyond Runtime's label bounds is refused. `diskSnapshots` lists, updates, polls and deletes them. Devbox and snapshot lists return cursor pages that can be awaited or iterated across pages; the generated `APIPromise` wrapper and its response helpers are not reproduced.                                                                                                                       |
| CodeSandbox | No browser editor/Pitcher protocol, browser-session tokens, interpreters, live VM resizing, fork tier changes, read-only or global editor sessions, or private host-token emulation. Configured tasks run under a guest supervisor and setup steps under a guest runner, both started by the adapter and surviving client disconnects; a task's port must be configured with `task.preview.port`, because automatic task-to-port discovery is refused. Private host-only preview requests fail explicitly; native signed preview URLs remain available. Public port discovery lists registered previews, not all listening sockets. Default workspace is prepared at `/project/sandbox`. Command restart preserves the originating client's captured argv, environment and working directory; a command discovered by another client refuses restart because its private spawn recipe is unavailable. |
| Sprites     | No control-mode WebSocket protocol, managed services, in-place checkpoint restore (start a new sandbox from the snapshot), checkpoint history filters, network presets (`include`), an allow rule inside a denied wildcard (Runtime's deny always wins), privilege or resource policies, `maxRunAfterDisconnect`, Fly token exchange or Sprite list streaming; each is refused by name. A checkpoint is a Runtime disk snapshot (files, not running processes); the Sprite pauses for the moment it takes. An allow rule makes an allowlist, as Sprites' DNS allowlist does. The port watcher polls `ss` once a second. Session handles use native process IDs, not tmux. The sprite URL maps port 8080. File bytes and process byte streams preserve binary data.                                                                                                                                    |
| Freestyle   | Provider catalog snapshot slugs are not Runtime snapshots and are refused. Firewall support is limited to an explicit empty rule set or the exact allow-public-outbound shape; arbitrary rule selectors, TLS policies and private networks are refused. No automatic-restart guarantee, retention scheduler, placement constraints, live resize, Linux-user switching, PTY namespace, public IPv6 or account-owned egress address emulation. Native snapshot retention is positive whole days.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Modal       | CPU sandboxes only; different resource reservation/limit values, fractional CPU, GPU and foreign placement are refused. Named Apps group Runtime sandboxes; they do not deploy Functions. Registry authentication uses Runtime's registry configuration. No Functions/Cls, volumes/bucket mounts, GPU image steps, readiness probes, sidecars, directory mounts, filesystem-only images from snapshots, or snapshot restoration API. Entry-point completion stops the sandbox while the originating client is alive; the native lease remains the bound if that client disappears. A different client can reconnect using the saved entrypoint process ID.                                                                                                                                                                                                                                            |
| Cloudflare  | The conditional Worker entry supplies a Durable Object bridge and custom-hostname preview proxy; infrastructure configuration must still remove the vendor Container declaration and provide Runtime secrets. Custom preview routing is implemented but has no live public-hostname acceptance evidence. No isolated PID namespaces, interpreter contexts, bucket mounts, backup format, terminal WebSocket protocol, watchers/change versions, custom process IDs or provider cleanup-record semantics. Foreground named sessions use resident Bash; background processes inherit exported state/cwd but do not yet inherit every local variable/function/option.                                                                                                                                                                                                                                    |

## Keeping compatibility current

`compatibility-lock.json` records the inspected versions and package integrity.
The repository's upstream check detects new releases and changed package contents.
A deprecated npm package or yanked Python release also requires review; a
registry failure cannot count as a pass. The daily workflow is source-controlled
but does not run until pushed to a repository with working GitHub Actions.
A changed pin is evidence to review, not permission to announce compatibility:
compare the published declarations, replay the relevant unchanged consumer,
exercise its failure paths, and update this coverage table with the same change.
