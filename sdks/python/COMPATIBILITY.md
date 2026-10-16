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
| E2B             | `e2b==2.55.1`, `e2b-code-interpreter==2.10.5` | `from withruntime.e2b import Sandbox, AsyncSandbox`; `from withruntime.e2b.code_interpreter import Sandbox, AsyncSandbox`                                       |
| Runloop         | `runloop-api-client==2.0.0`                   | `from withruntime.runloop import Runloop, AsyncRunloop`; `from withruntime.runloop.sdk import RunloopSDK, AsyncRunloopSDK`                                      |
| Prime Intellect | `prime-sandboxes==0.4.0`                      | `from withruntime.prime import SandboxClient, AsyncSandboxClient, APIClient, CreateSandboxRequest`                                                              |
| Fly Sprites     | `sprites-py==0.7.2`                           | `from withruntime.sprites import SpritesClient, AsyncSpritesClient, SpriteConfig`; filesystem, client, sprite, types, exec and exceptions submodules also exist |
| Modal CPU       | `modal==1.6.0`                                | `from withruntime import modal`; `from withruntime.modal import Sandbox, Image, Secret, App`                                                                    |

CodeSandbox and Cloudflare's sandbox SDKs use TypeScript. Freestyle's current VM
SDK also uses TypeScript; its older Python `freestyle==0.0.17` package has a
different API. Those three providers do not have placeholder Python packages.
Use the [TypeScript compatibility interfaces](../../packages/cloud-sdk/COMPATIBILITY.md)
for those SDKs.

## Implemented and exercised surfaces

| Provider           | Exercised sandbox behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Current contract boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runloop high level | Sync/async creation, reconnect, list, shutdown, disk-retaining suspend/restart and waits, files, foreground callbacks, background results/state/kill, and named Bash sessions retaining environment, cwd, functions, aliases and options; upstream `ExecutionResult` construction and properties; blocking disk snapshots, status/update/delete/list and disk clones                                                                                                                                | Interactive stdin on named shells is refused. Suspend first requests paid disk retention; a trial refusal leaves the process running. Tunnel/SSH and asynchronous disk capture are not mapped. Not every request/response field or polling option is covered.                                                                                                                                                                                                               |
| Runloop REST style | Devbox create/retrieve/list/await, execute sync/async, file transfers, shutdown/suspend/resume/keepalive; execution retrieve/wait/kill and channel iterators; disk snapshot status/update/delete/list                                                                                                                                                                                                                                                                                               | Runtime image and snapshot IDs are required. Upstream resource IDs do not identify Runtime resources. Non-sandbox vendor services are outside this interface.                                                                                                                                                                                                                                                                                                               |
| Prime Intellect    | Sync/async create/get/list/delete, status batches, bulk delete, foreground execution, binary files/read windows, background start/status/results/batches/wait, concrete response models and mapped API errors; async `open_process` byte streams, stdin, signals, canceled waits and close                                                                                                                                                                                                          | GPU, impersonation, advanced network/secrets, SSH sessions and startup logs are not mapped. Nondefault stability/build-wait, transfer deadlines and custom background worker limits are refused. Response models preserve tested fields/defaults/aliases, not every Pydantic validation/coercion.                                                                                                                                                                           |
| Fly Sprites        | Sync/async create/get/list/destroy/delete, CPU/RAM/disk config, metadata and replacement labels, prefix/cursor pagination, command argv and the vendor's command options, buffered binary output, live byte sinks, TTY, attach to native byte-mode sessions, session list; filesystem/path operations including `copy_to` and `replace`; URL auth (public or sprite) as a port 8080 preview; checkpoints as disk snapshots; domain network policy; upgrade; the vendor's dataclasses and exceptions | Live sinks/TTY/attach require the native byte-output capability. Buffered commands use owned guest files and work without it. A checkpoint is a Runtime disk snapshot (files, not running processes). Refused by name: provider runtime selection, `private_access`, services, network presets (`include`) and an allow rule inside a denied wildcard, checkpoint history filters, in-place restore, control multiplexing, the vendor's HTTP client and Fly token exchange. |
| Modal CPU          | Sync/`.aio` create/from_id/from_name/list/tags, exec/wait/poll/terminate, binary/text process streams, line iteration, stdin, filesystem read/write/copy/stat/list/remove/mkdir/watch; registry image recipes, pip/apt lists, env/workdir, inline secrets and app metadata; disk-only filesystem snapshots returning reusable `Image` objects                                                                                                                                                       | Binary processes require the native byte-output capability. Access/file-target/indefinite filesystem watch requires the expanded native watch capability. Snapshot TTL supports whole days from 1 to 365; other TTLs are refused. Atomic name uniqueness, GPU, volumes, tunnels, remote named secrets and all image options are not mapped. `App.lookup` is Runtime app metadata, not a Modal service lookup.                                                               |

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
