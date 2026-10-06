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
| E2B             | `e2b==2.52.1`, `e2b-code-interpreter==2.10.1` | `from withruntime.e2b import Sandbox, AsyncSandbox`; `from withruntime.e2b.code_interpreter import Sandbox, AsyncSandbox`                                       |
| Runloop         | `runloop-api-client==1.32.0`                  | `from withruntime.runloop import Runloop, AsyncRunloop`; `from withruntime.runloop.sdk import RunloopSDK, AsyncRunloopSDK`                                      |
| Prime Intellect | `prime-sandboxes==0.4.0`                      | `from withruntime.prime import SandboxClient, AsyncSandboxClient, APIClient, CreateSandboxRequest`                                                              |
| Fly Sprites     | `sprites-py==0.7.1`                           | `from withruntime.sprites import SpritesClient, AsyncSpritesClient, SpriteConfig`; filesystem, client, sprite, types, exec and exceptions submodules also exist |
| Modal CPU       | `modal==1.6.0`                                | `from withruntime import modal`; `from withruntime.modal import Sandbox, Image, Secret, App`                                                                    |

CodeSandbox and Cloudflare's sandbox SDKs use TypeScript. Freestyle's current VM
SDK also uses TypeScript; its older Python `freestyle==0.0.17` package has a
different API. Those three providers do not have placeholder Python packages.
Use the [TypeScript compatibility interfaces](../../packages/cloud-sdk/COMPATIBILITY.md)
for those SDKs.

## Implemented and exercised surfaces

| Provider           | Exercised sandbox behavior                                                                                                                                                                                                                                                                                                                                           | Current contract boundary                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runloop high level | Sync/async creation, reconnect, list, shutdown, disk-retaining suspend/restart and waits, files, foreground callbacks, background results/state/kill, and named Bash sessions retaining environment, cwd, functions, aliases and options; upstream `ExecutionResult` construction and properties; blocking disk snapshots, status/update/delete/list and disk clones | Interactive stdin on named shells is refused. Suspend first requests paid disk retention; a trial refusal leaves the process running. Tunnel/SSH and asynchronous disk capture are not mapped. Not every request/response field or polling option is covered.                                                                                                                                                 |
| Runloop REST style | Devbox create/retrieve/list/await, execute sync/async, file transfers, shutdown/suspend/resume/keepalive; execution retrieve/wait/kill and channel iterators; disk snapshot status/update/delete/list                                                                                                                                                                | Runtime image and snapshot IDs are required. Upstream resource IDs do not identify Runtime resources. Non-sandbox vendor services are outside this interface.                                                                                                                                                                                                                                                 |
| Prime Intellect    | Sync/async create/get/list/delete, status batches, bulk delete, foreground execution, binary files/read windows, background start/status/results/batches/wait, concrete response models and mapped API errors; async `open_process` byte streams, stdin, signals, canceled waits and close                                                                           | GPU, impersonation, advanced network/secrets, SSH sessions and startup logs are not mapped. Nondefault stability/build-wait, transfer deadlines and custom background worker limits are refused. Response models preserve tested fields/defaults/aliases, not every Pydantic validation/coercion.                                                                                                             |
| Fly Sprites        | Sync/async create/get/list/destroy, CPU/RAM/disk config, metadata and replacement labels, prefix/cursor pagination, command argv, buffered binary output, live byte sinks, TTY, attach to native byte-mode sessions; filesystem/path operations                                                                                                                      | Live sinks/TTY/attach require the native byte-output capability. Buffered commands use owned guest files and work without it. Provider runtime selection, URL auth, services, network policy, control multiplexing and disk-only checkpoint creation/restore are not mapped.                                                                                                                                  |
| Modal CPU          | Sync/`.aio` create/from_id/from_name/list/tags, exec/wait/poll/terminate, binary/text process streams, line iteration, stdin, filesystem read/write/copy/stat/list/remove/mkdir/watch; registry image recipes, pip/apt lists, env/workdir, inline secrets and app metadata; disk-only filesystem snapshots returning reusable `Image` objects                        | Binary processes require the native byte-output capability. Access/file-target/indefinite filesystem watch requires the expanded native watch capability. Snapshot TTL supports whole days from 1 to 365; other TTLs are refused. Atomic name uniqueness, GPU, volumes, tunnels, remote named secrets and all image options are not mapped. `App.lookup` is Runtime app metadata, not a Modal service lookup. |

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
