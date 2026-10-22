# Python sandbox compatibility

The adapters preserve the supported call shapes below while using Runtime's
credentials, resource IDs, billing and limits. They do not connect to a competitor
or carry its resources across. Set `RUNTIME_API_KEY`, or run `runtime login`,
before changing imports. Provider keys and provider API origins are not forwarded
to Runtime. A supplied Runtime client is available through the adapter's explicit
`runtime=` extension (Modal uses `client=`).

This document describes the new Python adapters and expanded E2B contracts.
Existing E2B, Daytona, Vercel and Blaxel imports are also described in [the Python README](README.md). These are supported
API surfaces, not a claim that every upstream SDK method or platform behavior is
interchangeable. Remaining implementation work is tracked in the repository's
[worklist](../../WORKLIST.md).

## Imports and pinned sources

| Provider        | Upstream distribution examined                | Replacement imports                                                                                                                                             |
| --------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2B             | `e2b==2.56.0`, `e2b-code-interpreter==2.11.0` | `from withruntime.e2b import Sandbox, AsyncSandbox`; `from withruntime.e2b.code_interpreter import Sandbox, AsyncSandbox`                                       |
| Runloop         | `runloop-api-client==2.0.0`                   | `from withruntime.runloop import Runloop, AsyncRunloop`; `from withruntime.runloop.sdk import RunloopSDK, AsyncRunloopSDK`                                      |
| Prime Intellect | `prime-sandboxes==0.4.7`                      | `from withruntime.prime import SandboxClient, AsyncSandboxClient, APIClient, CreateSandboxRequest`                                                              |
| Fly Sprites     | `sprites-py==0.7.2`                           | `from withruntime.sprites import SpritesClient, AsyncSpritesClient, SpriteConfig`; filesystem, client, sprite, types, exec and exceptions submodules also exist |
| Modal CPU       | `modal==1.6.2`                                | `from withruntime import modal`; `from withruntime.modal import Sandbox, Image, Secret, App`                                                                    |
| Morph Cloud     | `morphcloud==0.1.115`                         | `from withruntime.morph import MorphCloudClient`; `from withruntime.morph.api import Instance, Snapshot, ApiError` and the other `morphcloud.api` names         |

CodeSandbox and Cloudflare's sandbox SDKs use TypeScript. Freestyle's current VM
SDK also uses TypeScript; its older Python `freestyle==0.0.17` package has a
different API. Those three providers do not have placeholder Python packages.
Use the [TypeScript compatibility interfaces](../../packages/cloud-sdk/COMPATIBILITY.md)
for those SDKs.

## Implemented and exercised surfaces

| Provider           | Exercised sandbox behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Current contract boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runloop high level | Sync/async creation, reconnect, list, shutdown, disk-retaining suspend/restart and waits, files, foreground callbacks, background results/state/kill, and named Bash sessions retaining environment, cwd, functions, aliases and options; upstream `ExecutionResult` construction and properties; blocking disk snapshots, status/update/delete/list and disk clones                                                                                                                                                                                | Interactive stdin on named shells is refused. Suspend first requests paid disk retention; a trial refusal leaves the process running. Tunnel/SSH and asynchronous disk capture are not mapped. Not every request/response field or polling option is covered.                                                                                                                                                                                                                                                                            |
| Runloop REST style | Devbox create/retrieve/list/await, execute sync/async, file transfers, shutdown/suspend/resume/keepalive; execution retrieve/wait/kill and channel iterators; disk snapshot status/update/delete/list                                                                                                                                                                                                                                                                                                                                               | Runtime image and snapshot IDs are required. Upstream resource IDs do not identify Runtime resources. Non-sandbox vendor services are outside this interface.                                                                                                                                                                                                                                                                                                                                                                            |
| Prime Intellect    | Sync/async create/get/list/delete, status batches, bulk delete, foreground execution, binary files/read windows, background start/status/results/batches/wait (a job that cannot start fails its launch; one that died without an exit code is an APIError), filesystem checkpoints as disk-only snapshots (checkpoint, get, batches, wait, list, delete one or all, create from `checkpoint_id`), network rules, logs, concrete response models and mapped API errors; async `open_process` byte streams, stdin, signals, canceled waits and close | GPU, impersonation, advanced configs/secrets, SSH sessions on a public host, Prime's raw API routes, its image registry and LAN networks are refused with Runtime's alternative (LAN: `runtime.networks.private`, which cannot limit members, tags or ports). Nondefault stability probes and custom background worker limits are refused. A checkpoint pauses a running sandbox for its capture and stands alone (no parent, depth 1). Response models preserve tested fields/defaults/aliases, not every Pydantic validation/coercion. |
| Fly Sprites        | Sync/async create/get/list/destroy/delete, CPU/RAM/disk config, metadata and replacement labels, prefix/cursor pagination, command argv and the vendor's command options, buffered binary output, live byte sinks, TTY, attach to native byte-mode sessions, session list; filesystem/path operations including `copy_to` and `replace`; URL auth (public or sprite) as a port 8080 preview; checkpoints as disk snapshots; domain network policy; upgrade; the vendor's dataclasses and exceptions                                                 | Live sinks/TTY/attach require the native byte-output capability. Buffered commands use owned guest files and work without it. A checkpoint is a Runtime disk snapshot (files, not running processes). Refused by name: provider runtime selection, `private_access`, services, network presets (`include`) and an allow rule inside a denied wildcard, checkpoint history filters, in-place restore, control multiplexing, the vendor's HTTP client and Fly token exchange.                                                              |
| Modal CPU          | Sync/`.aio` create/from_id/from_name/list/tags, idle timeout, exec/wait/poll/terminate as root, binary/text process streams and stream types, line iteration, stdin, filesystem read/write/copy/stat/list/remove/mkdir/watch; registry image recipes, pip/apt lists, env/workdir, inline secrets, app metadata and `publish`; domain and CIDR allowlists and their replacement; disk-only filesystem snapshots returning reusable `Image` objects; memory snapshots                                                                                 | Binary processes require the native byte-output capability. Access/file-target/indefinite filesystem watch requires the expanded native watch capability. Snapshot TTL supports whole days from 1 to 365; other TTLs are refused. GPU, volumes made on first use, sidecars, connect tokens, remote named secrets and directory snapshots are refused, each naming the alternative. `App.lookup` is Runtime app metadata, not a Modal service lookup.                                                                                     |
| Morph Cloud        | Snapshot create/get/list/list_paginated/delete, metadata, retention, wait, and cached `setup`/`exec`/`upload`/`download`/`build` chains by Morph's own chain hash; instance start/boot/get/list/list_paginated/stop/cleanup, pause/resume, memory snapshots, `branch`, HTTP services as previews, streamed `exec`, metadata, wake-on, a later time-limit end, file upload/download, context managers; every `a`-prefixed twin                                                                                                                       | Refused, naming Runtime's way: SSH clients and keys, `as_container`, `reboot`, devboxes, volumes, the package index and `user` (API keys, secrets, SSH keys). `set_ttl` only moves a time limit later; a snapshot's TTL is whole days. Commands run as `runtime` with sudo, not root.                                                                                                                                                                                                                                                    |

E2B's expanded tests cover sync/async file and command request deadlines, file
stream ownership and idle timeouts, PTY byte output/resize/input, and interpreter
models and client deadlines. Sync PTY consumers use iteration or `wait(on_pty=...)`;
async PTY consumers pass `on_data` at creation. A command or interpreter timeout
closes that consumer's subscription without killing the remote work. Interpreter
execution defaults to 300 seconds; zero disables that execution deadline while
an explicit connection timeout remains effective. File streams default to a
60-second idle bound, with no overall transfer deadline unless explicitly set.
Install `withruntime[e2b]` for the official `httpx.ReadTimeout` file-transfer error
class; when httpx is absent, those errors use E2B `TimeoutException`.

Unknown options at supported entry points fail before allocation where their
meaning cannot be preserved. Methods outside these surfaces may be absent.
Disk snapshots require native disk-capture support and are checked before use.
Native full-memory snapshots are not presented as disk-only snapshots. Images
are built from the supplied registry base; unavailable image builds raise an
error rather than selecting a different image. `Image.debian_slim()` uses the
stated Python Debian registry image, not Modal's private prebuilt image.

Persistent Sprites retain disk between commands and idle periods. Destroy waits
for stop before clearing persistence, including a paused Sprite, so a deleted
Sprite does not keep billable retained storage. Runloop and Prime environment
values live in a restricted guest file rather than public sandbox labels.
Compatibility labels and the environment file format are shared with TypeScript
for supported cross-language reconnects.

## Verification and maintenance

Run from the repository root:

```sh
PYTHONPATH=sdks/python python3 -m unittest discover -s sdks/python/tests -p 'test_compat_new_providers.py'
PYTHONPATH=sdks/python python3.10 -m unittest discover -s sdks/python/tests -p 'test_compat_python*.py'
bun packages/cloud-sdk/scripts/test-python.ts
bun run compat:upstream
```

The whole-package run uses the first `python3` on `PATH`. The package supports
Python 3.10 and later; put another version's `python3` first on `PATH` to run
the suite on it.

The focused suite exercises public consumer snippets, failures before allocation,
failed-create cleanup, credentials, reconnects, binary transfers, output above the
native short-response cap, async stdin ordering/EOF, named-shell state, image
recipes and destruction order. Binary Sprites capture is also executed against
real local subprocesses, with arbitrary bytes and input exceeding a MiB.

The additional local process suite runs real pipes, PTYs and files. The shell
suite runs the shared resident Bash broker on a temporary Unix socket and cleans
up its owned processes. It requires permission to bind that local socket. Modal
watch tests use the actual native watch handle with a controlled transport, so
cursor notices, timeouts and stop behavior run through the SDK implementation.

Official SDK differential tests use a separate environment. From the repository
root, choose a temporary directory and run:

```sh
python3.10 sdks/python/tests/prepare_compatibility.py /tmp/runtime-official-contracts
RUNTIME_COMPAT_OFFICIAL=1 PYTHONPATH=sdks/python /tmp/runtime-official-contracts/bin/python -m unittest discover -s sdks/python/tests -p 'test_compat_python_official.py'
```

The bootstrap installs only wheels, checks hashes, and pins every dependency in
`tests/compatibility-requirements.txt`. Reusing an environment reinstalls the pinned
artifacts. Both the bootstrap and the tests compare primary package versions and
wheel hashes with the central compatibility lock; the tests also check installed
versions. A lock-only update cannot silently test an older SDK. Tests import the
real official packages;
controlled HTTP, WebSocket and RPC transports supply fixtures and any attempted
outbound socket connection fails the test. Covered comparisons include Runloop
result properties/REST calls/snapshot metadata, E2B sync and async PTY contracts,
file reader ownership and interpreter models/defaults, Prime response models and live process handles,
Sprites command/error defaults and label updates, and Modal byte streams and
filesystem validation/errors and filesystem snapshot image/TTL shapes. This proves those SDK contracts, not competitor
service behavior. Without the opt-in flag this suite is skipped; with the flag,
a missing or wrong official version is a failure with bootstrap instructions.

The full Python harness starts the real local API router with a simulated guest.
It checks native request shapes and transfer routes. That guest does not execute
Bash and does not enable image builds or persistent-settings updates; those
limitations are asserted rather than reported as successful end-to-end behavior.

`test_compat_live.py` is separately opt-in. It requires an explicit Runtime key,
checks available trial time, creates one new trial sandbox, records and checks its
ID, runs the four providers' command/file consumers, and stops only that sandbox.
It does not prove image builds, provider-specific sandbox creation, paid
persistence, checkpoint semantics or every unsupported surface above. Coordinate
live runs with the repository owner; routine tests must never affect existing
customer resources.

The upstream checker, `bun run compat:upstream`, uses pinned versions and
artifact hashes in `packages/cloud-sdk/compatibility-lock.json` to check registry
drift. When a version changes, inspect the actual upstream source,
update consumer fixtures and behavior tests, and only then change the pin. A
registry match proves the baseline has not moved; it does not prove behavioral
parity or replace the consumer tests. The Runloop, Prime and E2B sync modules are
generated from their async modules by `scripts/generate_runloop_sync.py`,
`scripts/generate_prime_sync.py` and `scripts/generate_e2b_sync.py`; each takes
`--check`, and the suite fails when a generated module is stale. Modal's sync
filesystem is kept identical to its async source, less `async` and `await`, by
a test.

The native byte-output, file metadata, expanded watcher, disk-capture and interpreter
detach changes must be released
before the corresponding adapters can use them against hosted Runtime. Local
contract results do not assert that an existing host has those capabilities.

## Prime Intellect, 19 October 2026

prime-sandboxes 0.4.6 → 0.4.7: the wheel and sdist matched the lock (0.4.6)
and PyPI (0.4.7); the wheel's source is byte for byte its sdist's; nothing was
installed or run. Requirements are unchanged. `CreateSandboxRequest` gains
`arch`, `"amd64"` or `"arm64"` (None is amd64; a checkpoint restore omits it).
Runtime runs amd64 only: the drop-in takes the field, refuses `"arm64"` before
any sandbox is made, naming amd64, answers a restore that sets `arch` with
Prime's `APIError`, and creates an `"amd64"` request exactly as one without
it; before, the field was a `TypeError`. `create_lan_network` takes `rules`
and stays refused, naming `runtime.networks.private`. Image builds gain
`linux/arm64` in Prime's image registry, which is refused whole; the rest is
LAN join internals. `tests/test_prime_0_4_7.py` fails without the change.

## Prime Intellect, 18 October 2026

prime-sandboxes 0.4.5 → 0.4.6: the wheel and sdist matched the lock (0.4.5)
and PyPI (0.4.6); the wheel's source is byte for byte its sdist's; nothing was
installed or run. Requirements are unchanged. `CreateSandboxRequest` gains
`lan_network_id` and `lan_tags` (tags need a network, a `ValueError`), and
`create` then joins the sandbox to that LAN network once it runs, in
`wait_for_creation` or `bulk_wait_for_creation`. The drop-in takes both fields
and refuses a create with a network before any sandbox is made, with the LAN
refusal naming `runtime.networks.private`; before, the unknown field was a
`TypeError`. The rest is an HTTP/2 pool for Prime's own command transport, not
part of the drop-in. `tests/test_prime_0_4_6.py` fails without the change.

## Modal's own examples, live, 18 October 2026

Modal's documented sandbox code (the code blocks of modal.com/docs/guide
`sandboxes`, `sandbox-spawn`, `sandbox-networking`, `sandbox-files` and
`sandbox-snapshots`, and modal-examples `13_sandboxes` at 65241421) is copied
verbatim into `tests/fixtures/modal`, with only the import changed, and run
against real Runtime sandboxes by
`packages/cloud-sdk/scripts/compatibility-modal-examples-live.ts`. Examples
that run as deployed Modal Functions, need a GPU or an LLM key, or copy the
reader's own config files are listed there and not run. What failed, and
what changed:

- `modal.enable_output()`, `modal.stream_type`, `modal.container_process`
  and `modal.io_streams` were missing; they exist, and `enable_output` prints
  image build logs. `exec(stdout=StreamType.STDOUT/DEVNULL)` prints or drops.
- `modal.Dict`, `Queue`, `Function`, `Server` and the rest were plain
  `AttributeError`s; each raises `CompatibilityError` naming the alternative
  (and still reads as absent to `hasattr`). `sandbox._experimental_sidecars`
  refuses the same way.
- Commands ran as the sandbox user (writes to `/`, Docker); the entrypoint,
  `exec` and readiness probes now run as root.
- `timeout` under 60 s was refused; the client ends the sandbox on time,
  with Runtime's minute as the bound. `idle_timeout` was refused; it is
  Runtime's idle pause.
- A taken name raised Runtime's `ConflictError`; it is `AlreadyExistsError`.
- `list_files` read a field listings never send (`mtimeMs`); it reads
  `modifiedAt`.
- `outbound_cidr_allowlist` and `cidr_allowlist` were refused; they are
  allow rules, a union with the domain allowlist, and
  `_experimental_set_outbound_network_policy` replaces them.
- `_experimental_enable_snapshot` was refused; `_experimental_snapshot()` and
  `Sandbox._experimental_from_snapshot()` take and restore a memory snapshot
  with its running entrypoint.
- `Image.publish(name)` was refused; it builds the recipe under that Runtime
  image name (`name:tag`, `latest` by default), which `Image.from_name` finds.

`tests/test_modal_examples.py` fails on the old drop-in.
`compat-inventory.json` records 288 present, 197 refused and 0 missing of 485.

## Modal Python, 16 October 2026

The supported pin moves from `modal` 1.6.0 to 1.6.2, and the
`latestReview` that held 1.6.1 for qualification is gone: the drop-in follows
both. The 1.6.0, 1.6.1 and 1.6.2 sdists and wheels were fetched into an empty
directory, every file matched its lock hash or PyPI SHA-256, and each wheel's
`modal`, `modal_proto` and `modal_version` matched its sdist; they were
compared file by file (public stubs class by class), nothing installed or run.

- 1.6.1 (reviewed 3 October): sandbox v2 calls carry a per-sandbox token,
  server sessions retry their start, the CLI gains endpoint commands, sidecars
  take `include_oidc_identity_token` and `proxy`, and `protobuf` <8 and
  `synchronicity` ~=0.12.6 are allowed. Nothing the drop-in serves changes:
  it speaks no Modal wire protocol and offers no sidecars.
- 1.6.2, `Sandbox.from_name(..., include_terminated=True)` returns the most
  recent terminated sandbox of that name when none runs. Followed, sync and
  `.aio`: a running one still wins, otherwise the stopped one with the latest
  end time.
- 1.6.2, `modal.sandbox` becomes a package: `modal.sandbox` exports
  `Sandbox` and `Probe`, and `modal.sandbox.sandbox` holds `Sandbox`,
  `SandboxFilesystem` and `SandboxSnapshot`; `modal.sandbox_fs` and
  `modal.snapshot` are gone. `withruntime.modal.sandbox` and
  `withruntime.modal.sandbox.sandbox` now exist with those names (no
  sidecars); the old module names stay for code written for 1.6.0.
- 1.6.2, secrets on a sandbox or an exec are sent as ordered sources,
  applied in the order given with `env` last, instead of secret ids beside one
  merged dictionary. The drop-in already applies `Secret.from_dict`,
  `from_local_environ` and `from_dotenv` in order with `env` last, and refuses
  named secrets.
- Not followed, outside the CPU sandbox scope or with nothing to follow:
  Python 3.15 support (the image recipes take any 3.x), Function and Server
  `metrics` and `autoscaler`, `Workspace.service_users`, environment name
  checks, metrics types in `modal.types`, Volume and Mount upload telemetry,
  agent detection for Codex, Qwen Code and Muse, and CLI changes.

`tests/test_modal_1_6_2.py` fails on the old drop-in (3 tests).
`tests/compatibility-requirements.txt` pins the 1.6.2 wheel and
`synchronicity` 0.12.6, and the official contracts import 1.6.2's module paths
(`modal.sandbox._sandbox`, `modal.sandbox._filesystem`); those contracts were
not rerun against the new wheel. `compat-inventory.json` records 277 present,
208 refused and 0 missing of 485.

## Morph Cloud Python, 15 October 2026

`morphcloud` 0.1.115 (PyPI, 1 September 2026) is Morph's main SDK, richer
than its TypeScript one (`withruntime/morph`). Its wheel and sdist match their
PyPI SHA-256 in the compatibility lock. The inventory counts `morphcloud.api`,
the module Morph's own examples import from (`morph-python`): of 458 items,
294 are present and 164 refused, none missing. It maps as the TypeScript
adapter does, with the same labels and digest names, so each language finds
the other's snapshots:

- An instance is a sandbox, a snapshot a Runtime snapshot, metadata labels.
  `stop` deletes the sandbox, as Morph's stop deletes the instance.
- `snapshots.create` boots the image at its size and keeps its disk;
  `instances.boot` starts such a disk snapshot at any size, and resizes a copy
  of a running machine. A snapshot's `ttl_seconds` is whole days (1 to 365).
- `setup`, `exec`, `upload`, `download` and `build` cache by Morph's own chain
  hash, so a shell step's digest is the one Morph computes, and `build`
  reuses `setup`'s snapshots.
- `ttl_seconds` at start is the time limit (60 to 86400); `set_ttl` moves its
  end later through `extend`, and refuses to add, remove or shorten one.
- `wake_on_ssh` and `wake_on_http` are Runtime's `auto_wake`, so they must
  agree.
- The `a`-prefixed twins run the same call on a worker thread, as Morph's own
  `asetup`, `aupload` and `abuild` do.
- Errors from Runtime are Morph's `ApiError` (`status_code`, `error_code`,
  `detail`), with the Runtime error as the cause.

`tests/test_compat_python_morph.py` runs every call against a fake client;
`scripts/morph_live.py --run` runs them against the real API.

## E2B Python, 15 October 2026

`e2b` 2.55.1 → 2.56.0 and `e2b-code-interpreter` 2.10.5 → 2.11.0 were read
from their sdists and wheels, each wheel's source matching its sdist and every
file its PyPI SHA-256. Neither package's `__init__.py` changed. `e2b` replaces
its internal connection balancer with pyqwest 0.12's own per-address limit
(`E2B_STREAMS_PER_CONNECTION` is gone) and, like the interpreter, now requires
Python 3.11; details in [E2B.md](../../packages/cloud-sdk/E2B.md), "e2b
2.56.0". The drop-in mirrors none of it and keeps Python 3.10.
`tests/compatibility-requirements.txt` pins the new wheels and `pyqwest`
0.12.0, so the official contracts run on Python 3.11 (`prepare_compatibility.py`
refuses older); they passed (18) there and on 3.12.

## Blaxel Python, 16 October 2026

`blaxel` 0.4.17 → 0.4.18 was read from its sdist and wheel, the wheel's source
matching its sdist and both files their PyPI SHA-256; nothing was installed or
run. Its one public addition, workspace secrets (`SecretInstance`,
`SyncSecretInstance`, `SecretAPIError`, `blaxel.core.secret`), imports and is
refused, naming `runtime.secrets.set(name, value=..., hosts=[...])`; see
[BLAXEL.md](../../packages/cloud-sdk/BLAXEL.md), "0.3.30 and 0.4.18".
`tests/test_blaxel_0_4_18.py` fails without the change.

## Blaxel Python, 15 October 2026

`blaxel` 0.4.13 → 0.4.17 (0.4.14 to 0.4.16 between) was read from its sdist
and wheel, the wheel's source matching its sdist and both files their PyPI
SHA-256; nothing was installed or run. The changes and what the drop-in does
with each are in [BLAXEL.md](../../packages/cloud-sdk/BLAXEL.md), "0.3.29 and
0.4.17": every API error is now a `BlaxelError` with `status`, `code`,
`request_id` and `retryable`, and `is_blaxel_error` checks one; previews take
the `{"port": ...}` shorthand (`SandboxPreviewCreateConfiguration`), and
`tokens.create_if_expired`, `preview.url` and `token.name` exist, sync and
async; `settings.integration` is kept, never sent. `tests/test_blaxel_0_4_17.py`
fails without the change. `blaxel` is not in `tests/compatibility-requirements.txt`;
the pin is in `compatibility-lock.json`.

## E2B Python, 9 October 2026

`e2b` 2.53.1 → 2.55.1 and `e2b-code-interpreter` 2.10.3 → 2.10.5 (with
2.55.0 and 2.10.4 between) were read from their sdists and wheels, each
wheel's source matching its sdist and every file its PyPI SHA-256. The changes
and what the drop-in does with each are in
[E2B.md](../../packages/cloud-sdk/E2B.md), "e2b 2.55.0": `mode` on `pause`,
`create_snapshot` and `on_timeout` is followed (a files-only pause is refused,
a files-only snapshot is Runtime's disk snapshot), and `SnapshotMode` and
`DockerfileSyntaxError` are exported. `tests/test_e2b_2_55.py` fails without
the change. `tests/compatibility-requirements.txt` pins the new wheels, with
`e2b-dockerfile-utils` 0.1.0 in place of `dockerfile-parse`. The official
contracts were not rerun against the new wheels.

## E2B Python requalification, 6 October 2026

Reviewed `e2b` 2.52.1 → 2.53.1 and `e2b-code-interpreter` 2.10.1 →
2.10.3. All eight wheel/sdist SHA-256 hashes matched PyPI's release JSON;
the four old hashes also matched the compatibility lock. Full source diffs
covered 17 E2B Python files and three interpreter files. No source files were
added or removed. Each wheel's Python source matched its sdist byte for byte.
Package metadata changed versions; the interpreter's E2B dependency floor
rose from 2.52.0 to 2.53.0. Other dependency requirements did not change.

| Upstream change                                                | Drop-in disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxNotRunningException` and `SandboxUnreachableException` | Both import from the base package, exceptions module and interpreter. Both inherit `TimeoutException`, preserving existing catches.                                                                                                                                                                                                                                                                                                                                                                         |
| Stopped versus unreachable classification                      | Runtime's `sandbox_stopped`, `sandbox_paused` and `sandbox_not_running` become `SandboxNotRunningException`. `sandbox_not_ready` and `host_unavailable` become `SandboxUnreachableException`. Native messages, codes, hints, status and request IDs remain attached, with the original error as cause.                                                                                                                                                                                                      |
| Public unavailable-message helpers in `e2b.exceptions`         | The replacement constants, predicates and formatter follow upstream's exact classes/messages, including ambiguous messages and precedence when both markers occur.                                                                                                                                                                                                                                                                                                                                          |
| E2B HTTP/RPC health classification                             | Upstream probes failed connections, resets and ambiguous UNAVAILABLE responses; a confirmed stop differs from an unreachable probe. Runtime has no envd HTTP/RPC transport: its controller returns the state explicitly. Native structured errors use that evidence directly, with no extra request or replay of a possibly completed write. Generic client connection failures remain `SandboxException`; deadlines remain deadline errors. No claim is made to reproduce E2B's transport-probe algorithm. |
| Health probes bypass connection retries                        | Private E2B pool/factory changes add `retry_connect=False` for a five-second probe. Runtime uses its own transport and performs no added probe or retry in the adapter. Existing connection, request and execution deadlines are unchanged.                                                                                                                                                                                                                                                                 |
| File HTTP errors and health response parsing                   | E2B now classifies five connection-failure types; read timeouts remain definitive. Its message parser accepts only a string JSON `message`, otherwise response text. These are private envd response parsers, not imported by the adapter; native file failures pass through the same structured mapping above.                                                                                                                                                                                             |
| CI-only diagnostics removed                                    | E2B removes `E2B_USER_AGENT_SOURCE`, `request_source`, `source=` URLs, implicit `e2b.ci` logging and trace-ID suffixes. Runtime never used these vendor diagnostics; it keeps its own request IDs. `ConnectionConfig` remains an explicitly unsupported vendor transport object.                                                                                                                                                                                                                            |
| Interpreter error helpers                                      | `format_exception`, `extract_exception` and `aextract_exception` in the replacement models module follow 2.10.3: generic errors use HTTP status/reason and trimmed nonempty text; 404/502 retain upstream's special errors. No CI diagnostic argument or trace suffix. Native interpreter errors keep Runtime's structured diagnostics instead of inventing a Jupyter HTTP response.                                                                                                                        |
| Command start/connect handle construction                      | Upstream consolidates duplicate private code into `_create_handle`; call shapes, callbacks, cleanup and deadlines do not change. Runtime keeps its existing handles.                                                                                                                                                                                                                                                                                                                                        |
| Create/connect/fork response conversion                        | Upstream consolidates private response conversion into `to_sandbox_create_response`; values and public signatures do not change. Runtime keeps its own resource conversion.                                                                                                                                                                                                                                                                                                                                 |
| `with`, `async with`, `kill()`, timeout defaults               | Unchanged upstream. Exit calls and awaits kill, including when the body raises; errors are not suppressed. Runtime deletes the sandbox, retains failed-delete retryability, and returns false after a successful prior kill. Requests default to 60 seconds; commands to 60 seconds; interpreter execution to 300 seconds. Zero disables the corresponding deadline.                                                                                                                                        |

The new regression file is `tests/test_e2b_upstream.py`. It covers both error
classes and exports, structured state mapping, unchanged error categories,
sync/async stream failures, failed writes and interpreter calls without replay,
and failed-delete retries. With `RUNTIME_COMPAT_OFFICIAL=1`, it compares all
upstream exports, error parents and full messages, interpreter error helpers,
context exit behavior and timeout signatures with the installed real wheels.
Its socket guard rejects vendor connections. The existing five E2B contracts
in `tests/test_compat_python_official.py` additionally exercise PTYs, file
streams, interpreter models and public streamed execution.

Install the hash-pinned wheels with `tests/prepare_compatibility.py` in an
isolated venv, then run the E2B tests with that venv's `python3`:

```sh
RUNTIME_COMPAT_OFFICIAL=1 PYTHONPATH=sdks/python python3 -m unittest discover -s sdks/python/tests -p '*e2b*.py'
RUNTIME_COMPAT_OFFICIAL=1 PYTHONPATH=sdks/python python3 -m unittest discover -s sdks/python/tests -p test_compat_python_official.py -k e2b
```

Recorded results: 90 existing E2B tests passed before the changes; 105 passed
against the new wheels after them, with no skips. The five existing official
E2B contracts passed against the old wheels. Against the new wheels four pass;
the interpreter contract's fake still supplies `_jupyter_request_url`, removed
upstream. A temporary in-memory fixture correction to
`_jupyter_url="https://official.invalid"` makes all five pass against the new
wheels; the shared test file was not edited because it is outside this helper's
assigned files. The new tests make 140 exact class/message comparisons against
the new wheels (135 interpreter HTTP cases and five unavailable-message cases).
Removing the native error mapping, either message predicate, the unavailable
formatter or any interpreter extraction helper makes its regression tests fail.
The registry check reports both Python pins current; its two remaining E2B
findings are npm `e2b` 2.53.1 and `@e2b/code-interpreter` 2.8.2.

New test evidence (`tests/test_e2b_upstream.py`):

| Test                                                                       | What it proves                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `test_new_errors_import_from_both_packages_and_exceptions`                 | Both classes import consistently and inherit TimeoutException; fails without the new exports/classes.                      |
| `test_confirmed_stopped_and_unreachable_are_distinct_and_keep_evidence`    | Five native codes across four call categories retain class, status, cause and diagnostics; old mapping fails all 20 cases. |
| `test_unknown_failures_deadlines_and_feature_refusals_are_not_stopped`     | Seven existing error categories retain their meanings; a lost connection alone is not proof of a stopped sandbox.          |
| `test_sync_command_stream_failure_is_classified_without_restarting`        | A stream failure becomes the correct availability error with exactly one command start; fails with the old mapping.        |
| `test_async_command_stream_failure_is_classified_without_restarting`       | The same guarantee for asynchronous command consumers; fails with the old mapping.                                         |
| `test_sync_files_and_interpreter_keep_the_availability_error`              | Failed writes and interpreter calls preserve the availability class without replay; fails with the old mapping.            |
| `test_async_files_and_interpreter_keep_the_availability_error`             | The same guarantee for asynchronous writes and interpreter calls; fails with the old mapping.                              |
| `test_failed_delete_can_retry_and_successful_delete_is_not_repeated`       | A lost delete response permits retry, while a successful deletion prevents another instance delete.                        |
| `test_async_failed_delete_can_retry_and_success_is_not_repeated`           | The same deletion guarantee asynchronously.                                                                                |
| `test_all_official_exports_and_new_error_parents`                          | Every official export resolves and both new exception parents match the installed wheels.                                  |
| `test_unavailable_message_helpers_match_official`                          | Five class/message cases and both predicates match upstream; removing the formatter or breaking either predicate fails.    |
| `test_interpreter_http_errors_match_official_including_empty_and_non_json` | Nine statuses, five bodies and three helpers yield 135 matching class/message pairs; removing each helper fails.           |
| `test_sync_context_exit_kill_and_failure_propagation_match`                | Normal and exceptional bodies call kill; cleanup errors propagate, as upstream does.                                       |
| `test_async_context_exit_kill_and_failure_propagation_match`               | Async exit awaits kill with the same error propagation.                                                                    |
| `test_connection_and_execution_defaults_match_new_wheels`                  | Sync/async command and interpreter timeout signatures match; request defaults and zero-disable behavior match.             |

These are local SDK contracts, not a live pilot or rival latency measurement.
Python qualification does not qualify npm releases. The npm pins remain the
previously qualified releases; the registry check separately reports newer
npm releases that need their own qualification.
