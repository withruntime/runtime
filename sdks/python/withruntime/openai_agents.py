"""Runtime Cloud sandboxes for the OpenAI Agents SDK.

``RuntimeCloudSandboxClient`` is a sandbox client for ``SandboxAgent``: every
command, file edit and PTY session the agent runs happens in a Runtime Cloud
microVM with its own kernel, and the agent definition does not change::

    from agents import Runner
    from agents.run import RunConfig
    from agents.sandbox import SandboxAgent, SandboxRunConfig
    from withruntime.openai_agents import RuntimeCloudSandboxClient, RuntimeCloudSandboxClientOptions

    agent = SandboxAgent(name="Coder", instructions="Fix the failing test.")
    result = await Runner.run(agent, "Go.", run_config=RunConfig(sandbox=SandboxRunConfig(
        client=RuntimeCloudSandboxClient(),
        options=RuntimeCloudSandboxClientOptions(funding="trial"),
    )))

Install with ``pip install "withruntime[openai-agents]"``. The key comes from
RUNTIME_API_KEY or the machine's ``runtime login``, as for ``AsyncRuntime``.

What it supports: exec with a timeout, users (``sudo -u``, and ``useradd`` run
as root for manifest accounts), file reads and writes of any size, PTY sessions
with stdin for ``exec_command``/``write_stdin``, exposed ports as Runtime
previews, tar workspace persistence, and ``workspace_persistence="snapshot"``,
which keeps the whole machine (files, memory and running processes) as a
Runtime snapshot and resumes from it. Mount strategies that run inside the
sandbox (rclone and the like) work as they do on any Linux host.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import shlex
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Awaitable, Callable, Literal, Optional, TypeVar, cast
from urllib.parse import urlsplit

try:
    from agents.sandbox.files import FileEntry
    from agents.sandbox.errors import (
        ExecTimeoutError,
        ExecTransportError,
        ExposedPortUnavailableError,
        WorkspaceArchiveReadError,
        WorkspaceArchiveWriteError,
        WorkspaceReadNotFoundError,
        WorkspaceStartError,
        WorkspaceWriteTypeError,
    )
    from agents.sandbox.manifest import Manifest
    from agents.sandbox.session import SandboxSession, SandboxSessionState
    from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
    from agents.sandbox.session.dependencies import Dependencies
    from agents.sandbox.session.manager import Instrumentation
    from agents.sandbox.session.mount_lifecycle import with_ephemeral_mounts_removed
    from agents.sandbox.session.pty_output import collect_pty_output
    from agents.sandbox.session.pty_types import (
        PTY_PROCESSES_MAX,
        PtyExecUpdate,
        allocate_pty_process_id,
        clamp_pty_yield_time_ms,
        process_id_to_prune_from_meta,
        resolve_pty_write_yield_time_ms,
    )
    from agents.sandbox.session.runtime_helpers import RESOLVE_WORKSPACE_PATH_HELPER, RuntimeHelperScript
    from agents.sandbox.session.sandbox_client import BaseSandboxClient, BaseSandboxClientOptions
    from agents.sandbox.session.tar_workspace import shell_tar_exclude_args
    from agents.sandbox.snapshot import SnapshotBase, SnapshotSpec, resolve_snapshot
    from agents.sandbox.types import ExecResult, ExposedPortEndpoint, User
    from agents.sandbox.util.tar_utils import UnsafeTarMemberError, validate_tar_bytes
    from agents.sandbox.workspace_paths import posix_path_as_path, sandbox_path_str
    from pydantic import Field
except ImportError as error:  # pragma: no cover - depends on the optional extra
    raise ImportError(
        "withruntime.openai_agents needs the OpenAI Agents SDK 0.22.3 or newer: "
        'pip install "withruntime[openai-agents]"') from error

from ._api_defaults import OPENAI_AGENTS_EXEC_TIMEOUT_SECONDS
from ._async_client import AsyncProcess, AsyncRuntime, AsyncSandbox
from ._errors import NotFoundError
from ._errors import RuntimeError as RuntimeCloudError

logger = logging.getLogger("withruntime.openai_agents")

BACKEND_ID = "runtime_cloud"
DEFAULT_EXEC_TIMEOUT_S = float(OPENAI_AGENTS_EXEC_TIMEOUT_SECONDS)
"""A command with no timeout of its own may run this long. The API allows 24 hours."""
_MAX_EXEC_TIMEOUT_MS = 86_400_000
_FAST_TIMEOUT_MS = 60_000
_SNAPSHOT_MAGIC = b"RUNTIME_CLOUD_SNAPSHOT_V1\n"
# The Files API serves paths inside the sandbox user's home, /workspace. Anything
# that moves through it on the way elsewhere waits here, outside every archive.
_FILES_HOME = "/workspace"
_STAGING_DIR = "/workspace/.openai-agents-staging"
# SandboxSession.exec runs these as the calling user; creating an account needs root.
_ROOT_COMMANDS = frozenset({"useradd", "groupadd", "usermod", "userdel", "groupdel"})
_T = TypeVar("_T")

WorkspacePersistence = Literal["tar", "snapshot"]


class RuntimeCloudSandboxClientOptions(BaseSandboxClientOptions):
    """How to create the Runtime Cloud sandbox. Every field is optional.

    ``funding`` is ``"trial"`` or ``"paid"``; left out, the account's default
    applies. ``image`` or ``snapshot_id`` start from a custom image or a ready
    snapshot. ``extra`` passes any other create field in snake_case, as
    ``AsyncRuntime.sandboxes.create`` takes it (``network``, ``cpu``,
    ``on_lease_end``, ``volumes``...).
    """

    type: Literal["runtime_cloud"] = "runtime_cloud"
    funding: Optional[Literal["trial", "paid"]] = None
    region: Optional[str] = None
    image: Optional[str] = None
    snapshot_id: Optional[str] = None
    vcpu: Optional[int] = None
    memory_mib: Optional[int] = None
    disk_mib: Optional[int] = None
    timeout_seconds: Optional[int] = None
    name: Optional[str] = None
    labels: Optional[dict[str, str]] = None
    max_cost_micros: Optional[int] = None
    extra: Optional[dict[str, Any]] = None
    env: Optional[dict[str, str]] = None
    """Set for every command, under the manifest's own environment."""
    exposed_ports: tuple[int, ...] = ()
    preview_visibility: Literal["private", "public"] = "private"
    """Private previews carry their token in the endpoint's query."""
    pause_on_exit: bool = False
    """Pause instead of stopping at shutdown, so ``resume`` wakes the same machine."""
    workspace_persistence: WorkspacePersistence = "tar"
    snapshot_retention_days: Optional[int] = None
    exec_timeout_s: float = DEFAULT_EXEC_TIMEOUT_S


class RuntimeCloudSandboxSessionState(SandboxSessionState):
    """Serializable state of a Runtime Cloud session."""

    type: Literal["runtime_cloud"] = "runtime_cloud"
    sandbox_id: str = ""
    create_fields: dict[str, Any] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    preview_visibility: Literal["private", "public"] = "private"
    pause_on_exit: bool = False
    workspace_persistence: WorkspacePersistence = "tar"
    snapshot_retention_days: Optional[int] = None
    exec_timeout_s: float = DEFAULT_EXEC_TIMEOUT_S


def _create_fields(options: RuntimeCloudSandboxClientOptions) -> dict[str, Any]:
    """The keyword arguments for ``runtime.sandboxes.create``."""
    fields: dict[str, Any] = dict(options.extra or {})
    for name in ("funding", "region", "image", "vcpu", "memory_mib", "disk_mib", "timeout_seconds", "name",
                 "labels", "max_cost_micros"):
        value = getattr(options, name)
        if value is not None:
            fields[name] = value
    if options.snapshot_id is not None:
        # The API's create field is `snapshot`.
        fields["snapshot"] = options.snapshot_id
    return fields


def _encode_snapshot_ref(snapshot_id: str) -> bytes:
    return _SNAPSHOT_MAGIC + json.dumps({"snapshot_id": snapshot_id}, separators=(",", ":")).encode()


def _decode_snapshot_ref(raw: bytes) -> Optional[str]:
    if not raw.startswith(_SNAPSHOT_MAGIC):
        return None
    try:
        value = json.loads(raw[len(_SNAPSHOT_MAGIC):].decode()).get("snapshot_id")
    except (ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None


def _timeout_ms(seconds: Optional[float], default: float) -> int:
    value = default if seconds is None else seconds
    return max(1, min(_MAX_EXEC_TIMEOUT_MS, int(value * 1000)))


def _files_api_reaches(path: str) -> bool:
    return path == _FILES_HOME or path.startswith(_FILES_HOME + "/")


def _with_env_through_sudo(argv: list[str], env: dict[str, str]) -> list[str]:
    """``sudo -u NAME -- cmd`` drops the environment; carry it with env(1)."""
    if env and len(argv) >= 4 and argv[0] == "sudo" and argv[1] == "-u" and argv[3] == "--":
        return [*argv[:4], "env", *(f"{key}={value}" for key, value in env.items()), *argv[4:]]
    return argv


@dataclass
class _PtyEntry:
    process: AsyncProcess
    tty: bool
    chunks: deque[bytes] = field(default_factory=deque)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    notify: asyncio.Event = field(default_factory=asyncio.Event)
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    last_used: float = field(default_factory=time.monotonic)
    exit_code: Optional[int] = None
    pump: Optional[asyncio.Task[None]] = None


class RuntimeCloudSandboxSession(BaseSandboxSession):
    """A ``BaseSandboxSession`` on one Runtime Cloud sandbox."""

    state: RuntimeCloudSandboxSessionState

    def __init__(self, *, state: RuntimeCloudSandboxSessionState, runtime: AsyncRuntime,
                 sandbox: Optional[AsyncSandbox] = None) -> None:
        self.state = state
        self._runtime = runtime
        self._sandbox = sandbox
        self._paused = False
        self._root_ready = state.workspace_root_ready
        self._root_prefix: Optional[list[str]] = None
        self._loaded_snapshot_id: Optional[str] = None
        # Set when resume already started this machine from the persisted snapshot,
        # so the restore that start() runs next must neither clear nor replace it.
        self._restored_from_snapshot = False
        self._pty_lock = asyncio.Lock()
        self._pty: dict[int, _PtyEntry] = {}
        self._pty_ids: set[int] = set()

    @classmethod
    def from_state(cls, state: RuntimeCloudSandboxSessionState, *, runtime: AsyncRuntime,
                   sandbox: Optional[AsyncSandbox] = None) -> "RuntimeCloudSandboxSession":
        return cls(state=state, runtime=runtime, sandbox=sandbox)

    @property
    def sandbox_id(self) -> str:
        return self.state.sandbox_id

    # The machine.

    async def _ensure_sandbox(self) -> AsyncSandbox:
        sandbox = self._sandbox
        if sandbox is not None and self._paused:
            await sandbox.wake()
            self._paused = False
        if sandbox is None:
            sandbox = await self._runtime.sandboxes.create(**self.state.create_fields)
            self._sandbox = sandbox
            self._paused = False
            self._root_prefix = None
            self._loaded_snapshot_id = self.state.create_fields.get("snapshot")
            self.state.sandbox_id = sandbox.id
        return sandbox

    async def _call(self, operation: Callable[[AsyncSandbox], Awaitable[_T]]) -> _T:
        """Runs ``operation``, waking the sandbox once if it paused itself when idle."""
        sandbox = await self._ensure_sandbox()
        try:
            return await operation(sandbox)
        except RuntimeCloudError as error:
            if error.code != "sandbox_paused":
                raise
            await sandbox.wake()
            return await operation(sandbox)

    async def _ensure_backend_started(self) -> None:
        await self._ensure_sandbox()

    async def _env(self) -> dict[str, str]:
        resolved = await self.state.manifest.environment.resolve()
        return {**self.state.env, **{key: value for key, value in resolved.items() if value is not None}}

    async def _as_root(self) -> list[str]:
        """The prefix that runs a command as root: none when already root, else ``sudo -n``."""
        if self._root_prefix is None:
            probe = await self._call(lambda sbx: sbx.exec(
                ["sh", "-c", 'if [ "$(id -u)" = 0 ]; then echo root; '
                 "elif sudo -n true 2>/dev/null; then echo sudo; else echo none; fi"],
                cwd="/", timeout_ms=_FAST_TIMEOUT_MS))
            self._root_prefix = ["sudo", "-n"] if probe.stdout.strip() == "sudo" else []
        return self._root_prefix

    async def _prepare_backend_workspace(self) -> None:
        root = self.state.manifest.root
        # The sandbox user may not be able to write the root (/app): make it as root, hand it over.
        script = ('mkdir -p -- "$1" 2>/dev/null || '
                  '{ sudo -n mkdir -p -- "$1" && sudo -n chown "$(id -u):$(id -g)" -- "$1"; }')
        try:
            result = await self._call(lambda sbx: sbx.exec(["sh", "-c", script, "sh", root], cwd="/",
                                                           timeout_ms=_FAST_TIMEOUT_MS))
        except RuntimeCloudError as error:
            raise WorkspaceStartError(path=posix_path_as_path(PurePosixPath(root)), cause=error,
                                      retryable=error.retryable) from error
        if result.exit_code != 0:
            raise WorkspaceStartError(path=posix_path_as_path(PurePosixPath(root)), context={
                "backend": BACKEND_ID, "exit_code": result.exit_code, "stderr": result.stderr})
        self._root_ready = True

    async def _validate_path_access(self, path: Path | str, *, for_write: bool = False) -> Path:
        return await self._validate_remote_path_access(path, for_write=for_write)

    def _runtime_helpers(self) -> tuple[RuntimeHelperScript, ...]:
        return (RESOLVE_WORKSPACE_PATH_HELPER,)

    def _current_runtime_helper_cache_key(self) -> object | None:
        return self.state.sandbox_id

    async def running(self) -> bool:
        sandbox = self._sandbox
        if sandbox is None or self._paused:
            return False
        try:
            await sandbox.refresh()
        except RuntimeCloudError:
            return False
        return sandbox.state == "running"

    async def _shutdown_backend(self) -> None:
        sandbox = self._sandbox
        if sandbox is None or self._paused:
            return
        if self.state.pause_on_exit:
            try:
                await sandbox.pause()
                self._paused = True
                return
            except RuntimeCloudError as error:
                logger.warning("Could not pause Runtime sandbox %s; stopping it instead: %s", sandbox.id, error)
        try:
            await sandbox.stop()
        except NotFoundError:
            pass
        except RuntimeCloudError as error:
            logger.warning("Could not stop Runtime sandbox %s: %s", sandbox.id, error)
            raise
        self._sandbox = None

    # Commands.

    async def _exec_internal(self, *command: str | Path, timeout: float | None = None) -> ExecResult:
        argv = [str(part) for part in command]
        if not argv:
            return ExecResult(stdout=b"", stderr=b"", exit_code=0)
        env = await self._env()
        if argv[0] in _ROOT_COMMANDS:
            argv = [*(await self._as_root()), *argv]
        argv = _with_env_through_sudo(argv, env)
        cwd = self.state.manifest.root if self._root_ready else "/"
        timeout_ms = _timeout_ms(timeout, self.state.exec_timeout_s)
        try:
            result = await self._call(lambda sbx: sbx.exec(argv, cwd=cwd, env=env or None, timeout_ms=timeout_ms))
        except RuntimeCloudError as error:
            raise ExecTransportError(command=argv, cause=error, retryable=error.retryable, context={
                "backend": BACKEND_ID, "sandbox_id": self.state.sandbox_id, "code": error.code}) from error
        if result.timed_out:
            raise ExecTimeoutError(command=argv, timeout_s=timeout, context={
                "backend": BACKEND_ID, "sandbox_id": self.state.sandbox_id,
                "stdout": result.stdout[-4096:], "stderr": result.stderr[-4096:]})
        return ExecResult(stdout=result.stdout.encode(), stderr=result.stderr.encode(),
                          exit_code=result.exit_code if result.exit_code is not None else -1)

    def supports_pty(self) -> bool:
        return True

    async def pty_exec_start(self, *command: str | Path, timeout: float | None = None,
                             shell: bool | list[str] = True, user: str | User | None = None, tty: bool = False,
                             yield_time_s: float | None = None,
                             max_output_tokens: int | None = None) -> PtyExecUpdate:
        env = await self._env()
        argv = _with_env_through_sudo(self._prepare_exec_command(*command, shell=shell, user=user), env)
        cwd = self.state.manifest.root if self._root_ready else "/"
        try:
            process = await self._call(lambda sbx: sbx.spawn(
                argv, cwd=cwd, env=env or None, pty={"cols": 80, "rows": 24} if tty else None,
                timeout_ms=_timeout_ms(timeout, self.state.exec_timeout_s)))
        except RuntimeCloudError as error:
            raise ExecTransportError(command=argv, cause=error, retryable=error.retryable, context={
                "backend": BACKEND_ID, "sandbox_id": self.state.sandbox_id, "code": error.code}) from error
        entry = _PtyEntry(process=process, tty=tty)
        entry.pump = asyncio.create_task(self._pump(entry))
        async with self._pty_lock:
            process_id = allocate_pty_process_id(self._pty_ids)
            self._pty_ids.add(process_id)
            pruned = self._prune_pty()
            self._pty[process_id] = entry
        if pruned is not None:
            await self._terminate(pruned)
        yield_ms = clamp_pty_yield_time_ms(10_000 if yield_time_s is None else int(yield_time_s * 1000))
        return await self._collect(process_id, entry, yield_ms, max_output_tokens)

    async def pty_write_stdin(self, *, session_id: int, chars: str, yield_time_s: float | None = None,
                              max_output_tokens: int | None = None) -> PtyExecUpdate:
        async with self._pty_lock:
            entry = self._resolve_pty_session_entry(pty_processes=self._pty, session_id=session_id)
        if chars:
            if not entry.tty:
                raise RuntimeError("stdin is not available for this process; start it with tty=True")
            await entry.process.write(chars)
        yield_ms = resolve_pty_write_yield_time_ms(
            yield_time_ms=250 if yield_time_s is None else int(yield_time_s * 1000), input_empty=chars == "")
        entry.last_used = time.monotonic()
        return await self._collect(session_id, entry, yield_ms, max_output_tokens)

    async def pty_terminate_all(self) -> None:
        async with self._pty_lock:
            entries = list(self._pty.values())
            self._pty.clear()
            self._pty_ids.clear()
        for entry in entries:
            await self._terminate(entry)

    async def _pump(self, entry: _PtyEntry) -> None:
        """Moves the process's output into ``entry`` until it exits. A dropped
        stream resumes from the last byte read, a few times."""
        cursor, failures = 0, 0
        try:
            while True:
                try:
                    async for event in entry.process.output(cursor=cursor):
                        failures = 0
                        if event["type"] in ("stdout", "stderr"):
                            data = event["data"].encode()
                            cursor = int(event.get("offset", cursor)) + len(data)
                            async with entry.lock:
                                entry.chunks.append(data)
                            entry.notify.set()
                        elif event["type"] == "exit":
                            code = event.get("exitCode")
                            entry.exit_code = int(code) if code is not None else -1
                    if entry.exit_code is None:
                        info = await entry.process.refresh()
                        if info.get("state") not in ("running", "starting"):
                            code = info.get("exitCode")
                            entry.exit_code = int(code) if code is not None else -1
                    if entry.exit_code is not None:
                        return
                except RuntimeCloudError as error:
                    failures += 1
                    if failures > 4 or not error.retryable:
                        async with entry.lock:
                            entry.chunks.append(f"\n[Runtime: the output stream failed: {error.message}]\n".encode())
                        entry.exit_code = -1
                        return
                    await asyncio.sleep(0.2 * failures)
        finally:
            async with entry.lock:
                pass
            entry.closed.set()
            entry.notify.set()

    async def _collect(self, process_id: int, entry: _PtyEntry, yield_ms: int,
                       max_output_tokens: Optional[int]) -> PtyExecUpdate:
        output, original_token_count, closed = await collect_pty_output(
            output_chunks=entry.chunks, output_lock=entry.lock, output_notify=entry.notify,
            is_done=entry.closed.is_set, yield_time_ms=yield_ms, max_output_tokens=max_output_tokens)
        exit_code = entry.exit_code if closed else None
        live: Optional[int] = process_id
        if exit_code is not None:
            async with self._pty_lock:
                self._pty.pop(process_id, None)
                self._pty_ids.discard(process_id)
            live = None
        return PtyExecUpdate(process_id=live, output=output, exit_code=exit_code,
                             original_token_count=original_token_count)

    def _prune_pty(self) -> Optional[_PtyEntry]:
        if len(self._pty) < PTY_PROCESSES_MAX:
            return None
        victim = process_id_to_prune_from_meta(
            [(pid, entry.last_used, entry.closed.is_set()) for pid, entry in self._pty.items()])
        if victim is None:
            return None
        self._pty_ids.discard(victim)
        return self._pty.pop(victim, None)

    async def _terminate(self, entry: _PtyEntry) -> None:
        if entry.exit_code is None:
            try:
                await entry.process.kill("SIGKILL")
            except RuntimeCloudError:
                pass
        if entry.pump is not None and not entry.pump.done():
            entry.pump.cancel()
            await asyncio.gather(entry.pump, return_exceptions=True)

    # Files.

    async def read(self, path: Path, *, user: str | User | None = None) -> io.IOBase:
        if user is not None:
            workspace_path = await self._check_read_with_exec(path, user=user)
        else:
            workspace_path = await self._validate_path_access(path)
        target = sandbox_path_str(workspace_path)
        if user is not None or not _files_api_reaches(target):
            return io.BytesIO(await self._read_via_exec(workspace_path, user))
        try:
            data = await self._call(lambda sbx: sbx.files.read(target))
        except NotFoundError as error:
            raise WorkspaceReadNotFoundError(path=workspace_path, cause=error) from error
        except RuntimeCloudError as error:
            raise WorkspaceArchiveReadError(path=workspace_path, cause=error, retryable=error.retryable) from error
        return io.BytesIO(data)

    async def write(self, path: Path, data: io.IOBase, *, user: str | User | None = None) -> None:
        payload = data.read()
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        if not isinstance(payload, (bytes, bytearray)):
            raise WorkspaceWriteTypeError(path=Path(str(path)), actual_type=type(payload).__name__)
        if user is not None:
            workspace_path = await self._check_write_with_exec(path, user=user)
        else:
            workspace_path = await self._validate_path_access(path, for_write=True)
        target = sandbox_path_str(workspace_path)
        if user is not None or not _files_api_reaches(target):
            await self._write_via_exec(workspace_path, bytes(payload), user)
            return
        try:
            await self._call(lambda sbx: sbx.files.write(target, bytes(payload)))
        except RuntimeCloudError as error:
            raise WorkspaceArchiveWriteError(path=workspace_path, cause=error, retryable=error.retryable) from error

    async def ls(self, path: Path | str, *, user: str | User | None = None) -> list[FileEntry]:
        entries = await super().ls(path, user=user)
        return [entry for entry in entries if entry.path != _STAGING_DIR]

    def _staging(self) -> str:
        return f"{_STAGING_DIR}/{self.state.session_id.hex}-{uuid.uuid4().hex}"

    async def _read_via_exec(self, path: Path, user: str | User | None) -> bytes:
        """The Files API reads as the sandbox user, inside /workspace. Another
        user's file, or one elsewhere, is copied into /workspace first."""
        name = user.name if isinstance(user, User) else (user or "")
        staging = self._staging()
        run_as = 'sudo -n -u "$1" -- ' if name else ""
        script = f'mkdir -p -- "$(dirname -- "$3")" && {run_as}cat -- "$2" > "$3"'
        try:
            result = await self._call(lambda sbx: sbx.exec(["sh", "-c", script, "sh", name, sandbox_path_str(path),
                                                            staging], cwd="/", timeout_ms=_FAST_TIMEOUT_MS))
            if result.exit_code != 0:
                context = {"backend": BACKEND_ID, "user": name or None, "exit_code": result.exit_code,
                           "stderr": result.stderr[-4096:]}
                if "No such file or directory" in result.stderr:
                    raise WorkspaceReadNotFoundError(path=path, context=context)
                raise WorkspaceArchiveReadError(path=path, context=context)
            return await self._call(lambda sbx: sbx.files.read(staging))
        except RuntimeCloudError as error:
            raise WorkspaceArchiveReadError(path=path, cause=error, retryable=error.retryable) from error
        finally:
            await self._remove_quietly(staging)

    async def _write_via_exec(self, path: Path, payload: bytes, user: str | User | None) -> None:
        name = user.name if isinstance(user, User) else (user or "")
        staging = self._staging()
        run_as = 'sudo -n -u "$1" -- ' if name else ""
        # The sandbox user reads the staged copy; the target user only writes.
        inner = '\'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"\''
        script = f'cat -- "$3" | {run_as}sh -c {inner} sh "$2"'
        try:
            await self._call(lambda sbx: sbx.files.write(staging, payload))
            result = await self._call(lambda sbx: sbx.exec(["sh", "-c", script, "sh", name, sandbox_path_str(path),
                                                            staging], cwd="/", timeout_ms=_FAST_TIMEOUT_MS))
            if result.exit_code != 0:
                raise WorkspaceArchiveWriteError(path=path, context={
                    "backend": BACKEND_ID, "user": name or None, "exit_code": result.exit_code,
                    "stderr": result.stderr[-4096:]})
        except RuntimeCloudError as error:
            raise WorkspaceArchiveWriteError(path=path, cause=error, retryable=error.retryable) from error
        finally:
            await self._remove_quietly(staging)

    async def _remove_quietly(self, path: str) -> None:
        try:
            await self._call(lambda sbx: sbx.files.remove(path))
        except RuntimeCloudError:
            pass

    # Exposed ports.

    async def _resolve_exposed_port(self, port: int) -> ExposedPortEndpoint:
        try:
            preview = await self._call(lambda sbx: cast(Any, sbx).previews.create(port, visibility=self.state.preview_visibility))
        except RuntimeCloudError as error:
            raise ExposedPortUnavailableError(
                port=port, exposed_ports=self.state.exposed_ports, reason="backend_unavailable",
                context={"backend": BACKEND_ID, "sandbox_id": self.state.sandbox_id, "code": error.code},
                cause=error, retryable=error.retryable) from error
        url = urlsplit(str(preview.get("url", "")))
        if not url.hostname:
            raise ExposedPortUnavailableError(port=port, exposed_ports=self.state.exposed_ports,
                                              reason="backend_unavailable",
                                              context={"backend": BACKEND_ID, "url": preview.get("url")})
        tls = url.scheme == "https"
        token = preview.get("token")
        return ExposedPortEndpoint(host=url.hostname, port=url.port or (443 if tls else 80), tls=tls,
                                   query=f"runtime_preview_token={token}" if token else "")

    # Workspace persistence.

    async def persist_workspace(self) -> io.IOBase:
        root = self._workspace_root_path()
        return await with_ephemeral_mounts_removed(
            self, self._persist, error_path=root, error_cls=WorkspaceArchiveReadError,
            operation_error_context_key="snapshot_error_before_remount_corruption")

    def _snapshot_can_capture_everything(self) -> bool:
        """A snapshot has no excludes, so a workspace with skip paths other than
        mounts (which are detached first) is kept as a tar instead."""
        root = self._workspace_root_path()
        mounts: set[Path] = set()
        for _entry, mount_path in self.state.manifest.ephemeral_mount_targets():
            try:
                mounts.add(mount_path.relative_to(root))
            except ValueError:
                continue
        return not (self._persist_workspace_skip_relpaths() - mounts)

    async def _persist(self) -> io.IOBase:
        root = self._workspace_root_path()
        if self.state.workspace_persistence == "snapshot" and self._snapshot_can_capture_everything():
            try:
                sandbox = await self._ensure_sandbox()
                snapshot = await sandbox.snapshot(retention_days=self.state.snapshot_retention_days)
            except RuntimeCloudError as error:
                raise WorkspaceArchiveReadError(path=root, context={"reason": "native_snapshot_failed"},
                                                cause=error, retryable=error.retryable) from error
            self._loaded_snapshot_id = snapshot["id"]
            return io.BytesIO(_encode_snapshot_ref(snapshot["id"]))
        staging = self._staging()
        skip = set(self._persist_workspace_skip_relpaths())
        try:
            skip.add(Path(_STAGING_DIR).relative_to(root))
        except ValueError:
            pass
        excludes = " ".join(shell_tar_exclude_args(skip))
        prefix = " ".join(await self._as_root())
        # The redirect belongs to the sandbox user, so the archive is theirs to read and delete.
        command = (f"mkdir -p -- {_STAGING_DIR} && {prefix} tar {excludes} "
                   f"-C {shlex.quote(root.as_posix())} -cf - . > {shlex.quote(staging)}")
        try:
            result = await self._call(lambda sbx: sbx.exec(["sh", "-c", command], cwd="/",
                                                           timeout_ms=_timeout_ms(None, self.state.exec_timeout_s)))
            if result.exit_code != 0:
                raise WorkspaceArchiveReadError(path=root, context={
                    "backend": BACKEND_ID, "reason": "tar_failed", "exit_code": result.exit_code,
                    "stderr": result.stderr[-4096:]})
            return io.BytesIO(await self._call(lambda sbx: sbx.files.read(staging)))
        except RuntimeCloudError as error:
            raise WorkspaceArchiveReadError(path=root, cause=error, retryable=error.retryable) from error
        finally:
            await self._remove_quietly(staging)

    async def hydrate_workspace(self, data: io.IOBase) -> None:
        raw = data.read()
        if isinstance(raw, str):
            raw = raw.encode("utf-8")
        root = self._workspace_root_path()
        if not isinstance(raw, (bytes, bytearray)):
            raise WorkspaceWriteTypeError(path=root, actual_type=type(raw).__name__)
        payload = bytes(raw)
        await with_ephemeral_mounts_removed(
            self, lambda: self._hydrate(payload), error_path=root, error_cls=WorkspaceArchiveWriteError,
            operation_error_context_key="hydrate_error_before_remount_corruption")

    async def _hydrate(self, raw: bytes) -> None:
        root = self._workspace_root_path()
        snapshot_id = _decode_snapshot_ref(raw)
        if snapshot_id is not None:
            if self._restored_from_snapshot and snapshot_id == self._loaded_snapshot_id:
                self._restored_from_snapshot = False
                return
            try:
                await self._replace_from_snapshot(snapshot_id)
            except RuntimeCloudError as error:
                raise WorkspaceArchiveWriteError(path=root, context={
                    "reason": "native_snapshot_restore_failed", "snapshot_id": snapshot_id},
                    cause=error, retryable=error.retryable) from error
            return
        try:
            validate_tar_bytes(raw, allow_external_symlink_targets=False)
        except UnsafeTarMemberError as error:
            raise WorkspaceArchiveWriteError(path=root, context={
                "reason": "unsafe_or_invalid_tar", "member": error.member, "detail": str(error)},
                cause=error) from error
        staging = self._staging()
        prefix = " ".join(await self._as_root())
        command = (f"mkdir -p -- {shlex.quote(root.as_posix())} && "
                   f"{prefix} tar -C {shlex.quote(root.as_posix())} -xf {shlex.quote(staging)}")
        try:
            await self._call(lambda sbx: sbx.files.write(staging, raw))
            result = await self._call(lambda sbx: sbx.exec(["sh", "-c", command], cwd="/",
                                                           timeout_ms=_timeout_ms(None, self.state.exec_timeout_s)))
            if result.exit_code != 0:
                raise WorkspaceArchiveWriteError(path=root, context={
                    "backend": BACKEND_ID, "reason": "untar_failed", "exit_code": result.exit_code,
                    "stderr": result.stderr[-4096:]})
            self._root_ready = True
        except RuntimeCloudError as error:
            raise WorkspaceArchiveWriteError(path=root, cause=error, retryable=error.retryable) from error
        finally:
            await self._remove_quietly(staging)

    async def _clear_workspace_root_on_resume(self) -> None:
        if self._restored_from_snapshot:
            return
        await super()._clear_workspace_root_on_resume()

    async def _replace_from_snapshot(self, snapshot_id: str) -> None:
        """Swaps this session's machine for a copy of the snapshot: files, memory and processes."""
        old = self._sandbox
        fields = {key: value for key, value in self.state.create_fields.items()
                  if key not in ("image", "snapshot", "vcpu", "memory_mib", "disk_mib")}
        replacement = await self._runtime.sandboxes.create(**fields, snapshot=snapshot_id)
        self._sandbox, self._paused, self._root_prefix = replacement, False, None
        self._loaded_snapshot_id = snapshot_id
        self.state.sandbox_id = replacement.id
        self._root_ready = True
        if old is not None and old.id != replacement.id:
            try:
                await old.stop(wait=False)
            except RuntimeCloudError as error:
                logger.warning("Could not stop the replaced Runtime sandbox %s: %s", old.id, error)


class RuntimeCloudSandboxClient(BaseSandboxClient[RuntimeCloudSandboxClientOptions]):
    """Creates and resumes Runtime Cloud sandbox sessions.

    Pass ``runtime=AsyncRuntime(...)`` to share a client, or ``api_key`` and
    ``base_url``; by default it reads RUNTIME_API_KEY or the saved login.
    """

    backend_id = BACKEND_ID
    supports_default_options = True

    def __init__(self, *, runtime: Optional[AsyncRuntime] = None, api_key: Optional[str] = None,
                 base_url: Optional[str] = None, instrumentation: Optional[Instrumentation] = None,
                 dependencies: Optional[Dependencies] = None) -> None:
        self._owns_runtime = runtime is None
        self.runtime = runtime if runtime is not None else AsyncRuntime(api_key=api_key, base_url=base_url)
        self._instrumentation = instrumentation if instrumentation is not None else Instrumentation()
        self._dependencies = dependencies

    async def create(self, *, snapshot: SnapshotSpec | SnapshotBase | None = None, manifest: Manifest | None = None,
                     options: Optional[RuntimeCloudSandboxClientOptions] = None) -> SandboxSession:
        options = options if options is not None else RuntimeCloudSandboxClientOptions()
        manifest = manifest if manifest is not None else Manifest()
        self._validate_manifest_for_create(manifest)
        session_id = uuid.uuid4()
        state = RuntimeCloudSandboxSessionState(
            session_id=session_id,
            manifest=manifest,
            snapshot=resolve_snapshot(snapshot, str(session_id)),
            create_fields=_create_fields(options),
            env=dict(options.env or {}),
            exposed_ports=options.exposed_ports,
            preview_visibility=options.preview_visibility,
            pause_on_exit=options.pause_on_exit,
            workspace_persistence=options.workspace_persistence,
            snapshot_retention_days=options.snapshot_retention_days,
            exec_timeout_s=options.exec_timeout_s,
        )
        inner = RuntimeCloudSandboxSession.from_state(state, runtime=self.runtime)
        await inner._ensure_sandbox()
        return self._wrap_session(inner, instrumentation=self._instrumentation)

    async def delete(self, session: SandboxSession) -> SandboxSession:
        inner = session._inner
        if not isinstance(inner, RuntimeCloudSandboxSession):
            raise TypeError("RuntimeCloudSandboxClient.delete expects a RuntimeCloudSandboxSession")
        await inner.shutdown()
        return session

    async def resume(self, state: SandboxSessionState) -> SandboxSession:
        """Reattaches to the same sandbox when it still runs (waking it when
        paused); otherwise starts a new one, from the persisted snapshot when
        the session keeps its workspace as one."""
        if not isinstance(state, RuntimeCloudSandboxSessionState):
            raise TypeError("RuntimeCloudSandboxClient.resume expects a RuntimeCloudSandboxSessionState")
        state.assert_path_grants_rebound()
        sandbox: Optional[AsyncSandbox] = None
        if state.sandbox_id:
            try:
                sandbox = await self.runtime.sandboxes.get(state.sandbox_id)
                if sandbox.state in ("paused", "pausing"):
                    await sandbox.wake()
                elif sandbox.state not in ("running", "stopped", "stopping", "failed"):
                    await sandbox.wait_for("running", 60)
                if sandbox.state != "running":
                    sandbox = None
            except RuntimeCloudError:
                sandbox = None
        reconnected = sandbox is not None
        inner = RuntimeCloudSandboxSession.from_state(state, runtime=self.runtime, sandbox=sandbox)
        if not reconnected:
            state.workspace_root_ready = False
            inner._root_ready = False
            snapshot_id = await _persisted_snapshot_id(state) if state.workspace_persistence == "snapshot" else None
            if snapshot_id is not None:
                try:
                    await inner._replace_from_snapshot(snapshot_id)
                    inner._restored_from_snapshot = True
                except RuntimeCloudError as error:
                    logger.warning("Could not start from snapshot %s; starting fresh: %s", snapshot_id, error)
            await inner._ensure_sandbox()
        inner._set_start_state_preserved(reconnected, system=reconnected)
        return self._wrap_session(inner, instrumentation=self._instrumentation)

    def deserialize_session_state(self, payload: dict[str, object]) -> SandboxSessionState:
        return self._deserialize_session_state_payload(payload, RuntimeCloudSandboxSessionState)

    async def aclose(self) -> None:
        """Closes the HTTP connections of a client this object made itself."""
        if self._owns_runtime:
            await self.runtime.close()


async def _persisted_snapshot_id(state: RuntimeCloudSandboxSessionState) -> Optional[str]:
    try:
        if not await state.snapshot.restorable():
            return None
        stream = await state.snapshot.restore()
        try:
            raw = stream.read()
        finally:
            stream.close()
    except Exception:  # noqa: BLE001 - a snapshot store that cannot answer means "start fresh"
        return None
    if isinstance(raw, str):
        raw = raw.encode()
    return _decode_snapshot_ref(bytes(raw)) if isinstance(raw, (bytes, bytearray)) else None


__all__ = [
    "BACKEND_ID",
    "DEFAULT_EXEC_TIMEOUT_S",
    "RuntimeCloudSandboxClient",
    "RuntimeCloudSandboxClientOptions",
    "RuntimeCloudSandboxSession",
    "RuntimeCloudSandboxSessionState",
]
