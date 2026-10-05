"""GENERATED from vercel/_async_sandbox.py by scripts/generate_dropin_sync.py. Do not edit."""
from __future__ import annotations

import math
import subprocess
import sys
import time
from datetime import timedelta
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from .._sync_client import Runtime

from . import _core as core
from ._sync_io import later, operation
from ._core import (CompletedProcess, DirectoryEntry, NotSupportedError, ProcessStatus, SandboxApiError,
                    SandboxPathNotFoundError, SandboxResources, SandboxRoute, SandboxStatus, SandboxStreamError,
                    translate)

_clients: Dict[str, Any] = {}


def _validated_ports(ports: Optional[List[int]]) -> Optional[List[int]]:
    if ports is None:
        return None
    result = list(ports)
    if any(isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535
           for port in result):
        raise ValueError("ports must contain whole numbers from 1 to 65535.")
    return result


def _client(token: Optional[str] = None, client: Optional[Runtime] = None) -> Runtime:
    if client is not None:
        return client
    key = core.pick_key(token)
    found = _clients.get(key or "")
    if found is None:
        found = Runtime(api_key=key) if key else Runtime()
        _clients[key or ""] = found
    return found


def _guard(subject: str, work: Callable[[], Any]) -> Any:
    try:
        return work()
    except Exception as error:  # noqa: BLE001 - every Runtime error becomes Vercel's
        raise translate(error, subject) from error


class TextReader:
    """One stream of a process's output: ``read()``, ``readline()`` and
    iteration by line. It moves forward and cannot rewind."""

    def __init__(self, process: "Process", stream: str) -> None:
        self._process, self._stream = process, stream

    def read(self, size: int = -1) -> str:
        while True:
            text = self._process._pump.take(self._stream, size=size)
            if text is not None:
                return text
            self._process._pull()

    def readline(self) -> str:
        while True:
            text = self._process._pump.take(self._stream, line=True)
            if text is not None:
                return text
            self._process._pull()

    def __iter__(self) -> "TextReader":
        return self

    def __next__(self) -> str:
        line = self.readline()
        if not line:
            raise StopIteration
        return line

    def aclose(self) -> None:
        return None

    def close(self) -> None:
        return None


class Process:
    """A process started with create_process: its output as text readers,
    its end with wait(). Standard input is not supported, as in Vercel."""

    def __init__(self, runtime_process: Any, args: List[str], cwd: str, session_id: str) -> None:
        self._runtime_process = runtime_process
        self.id = runtime_process.id
        self.args = args
        self.name = args[0] if args else ""
        self.cwd = cwd
        self.session_id = session_id
        self.started_at = int(time.time())
        self.stdin = None
        self._iterator: Any = None
        self._pump = core.LinePump(None)
        self.stdout: Optional[TextReader] = TextReader(self, "stdout")
        self.stderr: Optional[TextReader] = TextReader(self, "stderr")

    def _pull(self) -> None:
        if self._pump.done:
            return
        if self._iterator is None:
            self._iterator = self._runtime_process.output().__iter__()
        try:
            event = self._iterator.__next__()
        except StopIteration:
            self._pump.done = True
            return
        except Exception as error:  # noqa: BLE001
            raise SandboxStreamError(str(error)) from error
        self._pump.feed(event)

    @property
    def returncode(self) -> Optional[int]:
        exit_event = self._pump.exit
        if exit_event is None:
            return None
        return core.exit_code(exit_event.get("exitCode"), bool(exit_event.get("timedOut")))

    @property
    def status(self) -> ProcessStatus:
        return ProcessStatus.RUNNING if self._pump.exit is None else ProcessStatus.EXITED

    def wait(self) -> int:
        while not self._pump.done:
            self._pull()
        code = self.returncode
        return -1 if code is None else code

    def communicate(self) -> Tuple[str, str]:
        self.wait()
        return self._pump.take("stdout") or "", self._pump.take("stderr") or ""

    def refresh(self) -> "Process":
        _guard("sandbox", lambda: self._runtime_process.refresh())
        return self

    def send_signal(self, sig: Any) -> None:
        name = core.signal_name(sig)
        _guard("sandbox", lambda: self._runtime_process.kill(name))

    def terminate(self) -> None:
        self.send_signal("SIGTERM")

    def kill(self) -> None:
        self.send_signal("SIGKILL")


class FileHandle:
    """A file opened with fs.open: read whole on first read, written whole
    on close."""

    def __init__(self, fs: "SandboxFilesystem", path: str, mode: str, permissions: Optional[int]) -> None:
        self._fs, self.name, self.mode, self._permissions = fs, path, mode, permissions
        self._binary = "b" in mode
        self._reading = "r" in mode
        self._data: Any = None
        self._written: List[Any] = []
        self.closed = False

    def readable(self) -> bool:
        return self._reading

    def writable(self) -> bool:
        return not self._reading

    def seekable(self) -> bool:
        return False

    def _load(self) -> None:
        if self._data is None:
            raw = self._fs.read_bytes(self.name)
            self._data = raw if self._binary else raw.decode()

    def read(self, size: int = -1) -> Any:
        self._load()
        taken = self._data if size < 0 else self._data[:size]
        self._data = self._data[len(taken):]
        return taken

    def readline(self) -> Any:
        self._load()
        newline = b"\n" if self._binary else "\n"
        at = self._data.find(newline)
        end = len(self._data) if at < 0 else at + 1
        taken, self._data = self._data[:end], self._data[end:]
        return taken

    def write(self, data: Any) -> int:
        self._written.append(data)
        return len(data)

    def writelines(self, lines: Sequence[Any]) -> None:
        self._written.extend(lines)

    def flush(self) -> None:
        return None

    def aclose(self) -> None:
        if self.closed:
            return
        self.closed = True
        if not self._reading:
            joined = b"".join(self._written) if self._binary else "".join(self._written).encode()
            self._fs.write_bytes(self.name, joined, mode=self._permissions)

    def close(self) -> None:
        self.aclose()

    def __enter__(self) -> Any:
        return self

    def __exit__(self, *_: Any) -> None:
        self.aclose()


class Batch:
    """Writes staged with write_text and write_bytes, uploaded together when
    the block ends without an error."""

    def __init__(self, fs: "SandboxFilesystem", cwd: Any) -> None:
        self._fs, self._cwd = fs, cwd
        self._staged: List[Tuple[str, bytes, Optional[int]]] = []

    def write_text(self, path: Any, text: str, encoding: str = "utf-8", mode: Optional[int] = None) -> None:
        self._staged.append((core.to_runtime_path(path, self._cwd), text.encode(encoding), mode))

    def write_bytes(self, path: Any, data: bytes, mode: Optional[int] = None) -> None:
        self._staged.append((core.to_runtime_path(path, self._cwd), bytes(data), mode))

    def __enter__(self) -> Any:
        return self

    def __exit__(self, error_type: Any, *_: Any) -> None:
        if error_type is None:
            for target, data, mode in self._staged:
                self._fs.write_bytes(target, data, mode=mode)


class SandboxFilesystem:
    """``box.fs``: files over Runtime's files API. Relative paths resolve
    from /vercel/sandbox, which is /workspace on Runtime."""

    def __init__(self, box: "Sandbox") -> None:
        self._box = box

    def _files(self) -> Any:
        return (self._box._live()).files

    def read_bytes(self, path: Any, *, cwd: Any = None) -> bytes:
        target = core.to_runtime_path(path, cwd)
        files = self._files()
        return bytes(_guard("file", lambda: files.read(target)))

    def read_text(self, path: Any, encoding: str = "utf-8", errors: str = "strict", *, cwd: Any = None) -> str:
        return (self.read_bytes(path, cwd=cwd)).decode(encoding, errors)

    def write_bytes(self, path: Any, data: bytes, mode: Optional[int] = None, *, cwd: Any = None) -> None:
        target = core.to_runtime_path(path, cwd)
        runtime = self._box._live()
        _guard("file", lambda: runtime.files.write(target, bytes(data)))
        if mode is not None:
            result = _guard("sandbox", lambda: runtime.exec(["chmod", format(mode, "o"), "--", target]))
            if result.exit_code != 0:
                raise core.SandboxFilesystemError(result.stderr.strip())

    def write_text(self, path: Any, text: str, encoding: str = "utf-8", errors: str = "strict",
                         mode: Optional[int] = None, *, cwd: Any = None) -> None:
        self.write_bytes(path, text.encode(encoding, errors), mode=mode, cwd=cwd)

    def mkdir(self, path: Any, recursive: bool = True, *, cwd: Any = None) -> None:
        target = core.to_runtime_path(path, cwd)
        files = self._files()
        _guard("file", lambda: files.mkdir(target, parents=recursive))

    def _stat(self, path: Any, cwd: Any) -> Dict[str, Any]:
        target = core.to_runtime_path(path, cwd)
        files = self._files()
        return _guard("file", lambda: files.stat(target))

    def exists(self, path: Any, *, cwd: Any = None) -> bool:
        return bool((self._stat(path, cwd)).get("exists"))

    def is_file(self, path: Any, *, cwd: Any = None) -> bool:
        return (self._stat(path, cwd)).get("type") == "file"

    def is_dir(self, path: Any, *, cwd: Any = None) -> bool:
        return (self._stat(path, cwd)).get("type") == "directory"

    def listdir(self, path: Any = ".", *, cwd: Any = None) -> List[DirectoryEntry]:
        target = core.to_runtime_path(path, cwd)
        files = self._files()
        entries = _guard("file", lambda: files.list(target, depth=1, hidden=True))
        return [DirectoryEntry(path=entry.get("name", ""), kind=entry.get("type", "other")) for entry in entries]

    def remove(self, path: Any, recursive: bool = False, missing_ok: bool = False, *, cwd: Any = None) -> None:
        target = core.to_runtime_path(path, cwd)
        files = self._files()
        removed = _guard("file", lambda: files.remove(target, recursive=recursive))
        if not removed and not missing_ok:
            raise SandboxPathNotFoundError(f"{target} does not exist.")

    def rename(self, source: Any, destination: Any, *, cwd: Any = None) -> None:
        origin, target = core.to_runtime_path(source, cwd), core.to_runtime_path(destination, cwd)
        files = self._files()
        _guard("file", lambda: files.rename(origin, target, overwrite=True))

    def batch(self, *, cwd: Any = None) -> Batch:
        return Batch(self, cwd)

    def open(self, path: Any, mode: str = "r", *, permissions: Optional[int] = None, cwd: Any = None,
             **_: Any) -> FileHandle:
        if mode not in ("r", "rb", "w", "wb"):
            raise ValueError(f"mode must be r, rb, w or wb, not {mode!r}")
        return FileHandle(self, core.to_runtime_path(path, cwd), mode, permissions)


class Snapshot:
    """A saved filesystem over a Runtime disk snapshot. Restoring it starts
    fresh processes."""

    def __init__(self, info: Dict[str, Any], client: Runtime) -> None:
        self._info, self._client = info, client

    @property
    def id(self) -> str:
        return self._info["id"]

    @property
    def source_session_id(self) -> str:
        return self._info.get("sourceSandboxId", "")

    @property
    def region(self) -> str:
        return "iad1"

    @property
    def regions(self) -> Tuple[str, ...]:
        return (self.region,)

    @property
    def status(self) -> str:
        state = self._info.get("state", "ready")
        return "failed" if state == "failed" else "deleted" if state in ("deleting", "deleted") else "created"

    @property
    def size_bytes(self) -> int:
        return int(self._info.get("storedBytes") or 0)

    @property
    def created_at(self) -> int:
        return core_millis(self._info.get("createdAt"))

    @property
    def updated_at(self) -> int:
        return core_millis(self._info.get("updatedAt") or self._info.get("readyAt") or self._info.get("createdAt"))

    @property
    def expires_at(self) -> Optional[int]:
        value = self._info.get("expiresAt")
        return core_millis(value) if value else None

    @property
    def last_used_at(self) -> Optional[int]:
        value = self._info.get("lastUsedAt")
        return core_millis(value) if value else None

    @property
    def creation_method(self) -> Optional[str]:
        return self._info.get("creationMethod")

    @property
    def parent_id(self) -> Optional[str]:
        return self._info.get("parentId")

    def delete(self) -> "Snapshot":
        try:
            _guard("other", lambda: self._client.snapshots.delete(self.id))
            self._info = _guard("other", lambda: self._client.snapshots.get(self.id))
        except SandboxApiError as error:
            if error.status_code != 404:
                raise
            self._info = {**self._info, "state": "deleted"}
        return self


def core_millis(value: Any) -> int:
    """Vercel's integer epoch milliseconds, without float rounding of fractions."""
    if not isinstance(value, str) or not value:
        return 0
    from datetime import datetime, timezone
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    elapsed = moment - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return elapsed.days * 86_400_000 + elapsed.seconds * 1000 + elapsed.microseconds // 1000


def core_date(value: Any) -> float:
    if not isinstance(value, str) or not value:
        return 0.0
    from datetime import datetime
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class Sandbox:
    """A sandbox handle with Vercel's methods. ``box.withruntime`` is the
    Runtime sandbox underneath, for anything Vercel has no name for."""

    def __init__(self, runtime: Any, client: Runtime, env: Optional[Mapping[str, str]] = None,
                 persistent: Optional[bool] = None, time_limit: Optional[float] = None) -> None:
        self.withruntime = runtime
        # The execution time limit asked for, which may pass Runtime's
        # hour-long lease: the lease is renewed toward it while this lives.
        self._limit = time_limit
        self._session_start = (time.time() if time_limit is not None else
                               core.epoch(runtime.info.get("expiresAt"))
                               - float(runtime.info.get("timeoutSeconds") or 0))
        self._timer: Any = None
        self._keeping = False
        self._kept_until_end = False
        self._client = client
        self._env = dict(env or {})
        self._persistent = persistent if persistent is not None else runtime.info.get("onLeaseEnd") != "stop"
        self._routes: Dict[int, str] = {}
        self._linked = False
        self._destroyed = False
        self._exit_mode = "stop"
        self.fs = SandboxFilesystem(self)

    @property
    def name(self) -> str:
        return self.withruntime.info.get("name") or self.withruntime.id

    @property
    def current_session_id(self) -> str:
        return self.withruntime.id

    @property
    def status(self) -> SandboxStatus:
        return core.status_of(self.withruntime.state)

    @property
    def persistent(self) -> bool:
        return self._persistent

    @property
    def image(self) -> Optional[str]:
        return self.withruntime.info.get("image")

    @property
    def cwd(self) -> str:
        return core.HOME

    @property
    def region(self) -> str:
        return "iad1"

    @property
    def memory(self) -> int:
        return int(self.withruntime.info.get("memoryMiB", 0))

    @property
    def vcpus(self) -> int:
        return int(self.withruntime.info.get("vcpu", 0))

    @property
    def execution_time_limit(self) -> timedelta:
        if self._limit is not None:
            return timedelta(seconds=self._limit)
        return timedelta(seconds=int(self.withruntime.info.get("timeoutSeconds") or 0))

    def _until(self) -> float:
        return self._session_start + self.execution_time_limit.total_seconds()

    def _keep(self, force: bool = False) -> None:
        """Renews the lease toward the execution time limit when less than
        ten minutes (or half the limit) is left, or now with ``force``; then
        looks again in a minute while the limit runs past the lease."""
        runtime = self.withruntime
        # No time limit: it renews itself on the server (0300).
        if self._kept_until_end or runtime.state != "running" or core.no_limit(runtime.info):
            return
        margin = math.inf if force else min(600.0, self.execution_time_limit.total_seconds() / 2)
        extra = core.extension_seconds(core.end_of(runtime.info), self._until(), time.time(), margin)
        if extra >= 1:
            try:
                runtime.extend(extra)
            except Exception as error:  # noqa: BLE001
                # The lease may have ended since it was read; the next call says
                # what state the sandbox is in.
                if getattr(error, "status", None) != 409:
                    raise translate(error, "sandbox") from error
                try:
                    runtime.refresh()
                except Exception:  # noqa: BLE001
                    pass
        self._schedule()

    def _schedule(self) -> None:
        if self._kept_until_end or self._timer is not None or core.no_limit(self.withruntime.info):
            return
        expires = core.end_of(self.withruntime.info)
        if not math.isfinite(expires) or self._until() <= expires:
            return
        try:
            self._timer = later(60, self._tick)
        except RuntimeError:  # no running event loop: the next call renews instead
            self._timer = None

    def _tick(self) -> None:
        self._timer = None
        try:
            self._keep()
        except Exception:  # noqa: BLE001 - the next call through the adapter reports it
            pass

    def _end_keeping(self) -> None:
        """Stops renewing: after stop() of a sandbox that ends, or destroy()."""
        self._kept_until_end = True
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    @property
    def tags(self) -> Dict[str, str]:
        return dict(self.withruntime.info.get("labels") or {})

    @property
    def routes(self) -> Tuple[SandboxRoute, ...]:
        return tuple(core.route(port, url) for port, url in self._routes.items())

    @property
    def raw(self) -> Dict[str, Any]:
        return dict(self.withruntime.info)

    def _live(self) -> Any:
        """Wakes a stopped persistent (paused) sandbox, as Vercel resumes one
        on the next process or file call."""
        if self._destroyed:
            raise core.SandboxInvalidHandleError(f"Sandbox {self.name} was destroyed.")
        if self.withruntime.state in ("paused", "pausing"):
            _guard("sandbox", lambda: self.withruntime.wake())
            if self._limit is not None:
                self._session_start = time.time()
        self._keep()
        return self.withruntime

    def _resuming(self, work: Callable[[Any], Any]) -> Any:
        """Runs ``work``; when the lease paused the sandbox meanwhile, wakes
        it and runs ``work`` once more."""
        runtime = self._live()
        try:
            return work(runtime)
        except Exception as error:  # noqa: BLE001
            if getattr(error, "code", None) != "sandbox_paused":
                raise translate(error, "sandbox") from error
            _guard("sandbox", lambda: runtime.refresh())
            _guard("sandbox", lambda: runtime.wake())
            return _guard("sandbox", lambda: work(runtime))

    def _link_home(self, text: str) -> None:
        if self._linked or core.HOME not in text:
            return
        self._linked = True
        try:
            self.withruntime.exec(core.HOME_LINK)
        except Exception:  # noqa: BLE001 - the command that named the path reports what is wrong
            pass

    def _share(self, port: int) -> None:
        preview = _guard("sandbox", lambda: self.withruntime.previews.create(port, visibility="public"))
        self._routes[port] = preview["url"].rstrip("/")

    def _setup(self, source: Any, ports: Optional[List[int]], expiration: Any) -> None:
        for port in ports or []:
            self._share(port)
        if expiration is not None and self._persistent:
            _guard("sandbox", lambda: self.withruntime.set_retention(core.retention_days(expiration)))
        if isinstance(source, core.GitSource):
            auth = source.username is not None
            argv = ["git", *(["-c", core.GIT_HELPER] if auth else []), "clone",
                    *(["--depth", str(source.depth)] if source.depth else []), "--", source.url, core.RUNTIME_HOME]
            env = {"GIT_USER": source.username or "", "GIT_PASS": source.password or ""} if auth else None
            self._setup_step(argv, env)
            if source.revision:
                self._setup_step(["git", "-C", core.RUNTIME_HOME, "checkout", source.revision], env)
        elif isinstance(source, core.TarballSource):
            self._setup_step(["sh", "-c", 'curl -fsSL "$1" | tar -xz -C /workspace', "sh", source.url])

    def _setup_step(self, argv: List[str], env: Optional[Dict[str, str]] = None) -> None:
        result = _guard("sandbox", lambda: self.withruntime.exec(argv, env=env, timeout_ms=600_000))
        if result.exit_code != 0:
            raise SandboxApiError(f"Setting up the sandbox's source failed ({' '.join(argv[:3])}): "
                                  f"{result.stderr.strip()}", status_code=400, code="source_failed")

    # ---- processes ------------------------------------------------------------------

    def run_process(self, command: str, args: Optional[Sequence[str]] = None, *, cwd: Any = None,
                          env: Optional[Mapping[str, str]] = None, sudo: bool = False, kill_after: Any = None,
                          check: bool = False, stdout: Any = None, stderr: Any = None,
                          capture_output: bool = False) -> CompletedProcess:
        """Runs a process and waits for it. Output streams to this process's
        stdout and stderr unless captured, sent elsewhere, or dropped."""
        argv = core.argv_of(command, args, sudo)
        merged = {**self._env, **(env or {})}
        runtime = self._live()
        self._link_home(f"{' '.join(argv)}\n{cwd or ''}\n" + "\n".join(merged.values()))
        target_cwd = core.RUNTIME_HOME if cwd is None else core.to_runtime_path(cwd)
        limit = core.seconds(kill_after)
        captured = {"stdout": "", "stderr": ""}

        def sink(stream: str, target: Any) -> Callable[[str], None]:
            def write(text: str) -> None:
                if stream == "stderr" and target == subprocess.STDOUT:
                    captured["stdout"] += text
                    return
                if capture_output or target == subprocess.PIPE:
                    captured[stream] += text
                elif target == subprocess.DEVNULL:
                    return
                elif target is None:
                    (sys.stdout if stream == "stdout" else sys.stderr).write(text)
                else:
                    target.write(text)
            return write
        result = self._resuming(lambda box: box.exec(
            argv, cwd=target_cwd, env=merged or None,
            timeout_ms=int(limit * 1000) if limit else core.LONGEST_MS,
            on_stdout=sink("stdout", stdout), on_stderr=sink("stderr", stderr)))
        keep = capture_output or stdout == subprocess.PIPE or stderr == subprocess.PIPE
        completed = CompletedProcess(
            args=argv, returncode=core.exit_code(result.exit_code, result.timed_out),
            stdout=captured["stdout"] if keep or stderr == subprocess.STDOUT else None,
            stderr=captured["stderr"] if keep else None, id=getattr(result, "process_id", None) or "",
            name=command, cwd=core.HOME if cwd is None else str(cwd), session_id=self.withruntime.id,
            started_at=int(time.time()))
        if check:
            completed.check_returncode()
        return completed

    def create_process(self, command: str, args: Optional[Sequence[str]] = None, *, cwd: Any = None,
                             env: Optional[Mapping[str, str]] = None, sudo: bool = False, kill_after: Any = None,
                             stdout: Any = subprocess.PIPE, stderr: Any = subprocess.PIPE) -> Process:
        """Starts a process and returns at once; read its output from
        ``process.stdout`` and ``process.stderr``."""
        argv = core.argv_of(command, args, sudo)
        merged = {**self._env, **(env or {})}
        self._live()
        self._link_home(f"{' '.join(argv)}\n{cwd or ''}")
        limit = core.seconds(kill_after)
        started = self._resuming(lambda box: box.spawn(
            argv, cwd=core.RUNTIME_HOME if cwd is None else core.to_runtime_path(cwd), env=merged or None,
            timeout_ms=int(limit * 1000) if limit else core.LONGEST_MS))
        process = Process(started, argv, core.HOME if cwd is None else str(cwd), self.withruntime.id)
        if stdout == subprocess.DEVNULL:
            process.stdout = None
        if stderr in (subprocess.DEVNULL, subprocess.STDOUT):
            process.stderr = None
        return process

    def get_process(self, process_id: str, wait: bool = False) -> Process:
        runtime = self._live()
        found = _guard("sandbox", lambda: runtime.process(process_id))
        process = Process(found, [str(found.info.get("command", ""))], str(found.info.get("cwd", "")),
                               self.withruntime.id)
        if wait:
            process.wait()
        return process

    def query_processes(self) -> List[Process]:
        runtime = self._live()
        out = []
        for info in _guard("sandbox", lambda: runtime.processes()):
            found = _guard("sandbox", lambda: runtime.process(info["id"]))
            out.append(Process(found, [str(info.get("command", ""))], str(info.get("cwd", "")),
                                    self.withruntime.id))
        return out

    # ---- lifecycle ----------------------------------------------------------------------

    def refresh(self) -> "Sandbox":
        _guard("sandbox", lambda: self.withruntime.refresh())
        return self

    def stop(self) -> "Sandbox":
        """Ends the session. A persistent sandbox is paused, keeping its files
        and memory, and wakes on the next process or file call; any other ends."""
        _guard("sandbox", lambda: self.withruntime.refresh())
        state = self.withruntime.state
        if state not in ("stopped", "stopping", "paused"):
            if self._persistent:
                _guard("sandbox", lambda: self.withruntime.pause())
            else:
                self._end_keeping()
                _guard("sandbox", lambda: self.withruntime.stop())
        return self

    def destroy(self) -> None:
        """Ends the sandbox for good."""
        self._end_keeping()
        _guard("sandbox", lambda: self.withruntime.refresh())
        if self.withruntime.state != "stopped":
            _guard("sandbox", lambda: self.withruntime.stop(wait=False))
        self._destroyed = True

    def _finish(self, mode: str) -> None:
        if self._destroyed:
            return
        if mode == "destroy":
            self.destroy()
        else:
            self.stop()

    def __enter__(self) -> Any:
        return self

    def __exit__(self, *_: Any) -> None:
        self._finish(self._exit_mode)

    def session(self) -> Any:
        """The sandbox itself, woken: a Runtime sandbox is its own session.
        Leaving the block stops it."""
        def acquire() -> Any:
            self._live()
            return self
        return operation(acquire, "stop")

    def extend_execution_time_limit(self, duration: Any) -> "Sandbox":
        """Moves the end ``duration`` later. Past an hour from now, the lease
        follows while this object lives. A sandbox with no time limit has no
        end to move, and nothing changes."""
        total = core.seconds(duration) or 0
        if total < 1:
            raise ValueError("duration must be at least one second.")
        if core.no_limit(self.withruntime.info):
            return self
        self._limit = self.execution_time_limit.total_seconds() + math.ceil(total)
        self._live()
        self._keep(force=True)
        return self

    def update_network_policy(self, policy: Any) -> Any:
        rules = core.network_rules(policy)
        self._resuming(lambda box: box.network.set(**rules))
        return policy

    def update(self, *, ports: Optional[List[int]] = None, execution_time_limit: Any = None,
                     network_policy: Any = None, snapshot_expiration: Any = None, **other: Any) -> "Sandbox":
        """Changes what Runtime can change on a sandbox: ports, the time limit
        (later only; a sandbox with no time limit keeps none), network policy
        and snapshot expiration."""
        given = [name for name, value in other.items() if value is not None]
        if given:
            raise NotSupportedError(f"Changing {given[0]} on an existing sandbox",
                                    "Create a new sandbox with it (Runtime cannot change a sandbox's machine, "
                                    "persistence, tags or region after creation).")
        # Validate every option before applying the first requested change.
        ports = _validated_ports(ports)
        rules = core.network_rules(network_policy) if network_policy is not None else None
        retention = core.retention_days(snapshot_expiration) if snapshot_expiration is not None else None
        if execution_time_limit is not None and not core.no_limit(self.withruntime.info):
            wanted = core.time_limit(execution_time_limit)
            if self._session_start + wanted < core.end_of(self.withruntime.info) - 1:
                raise NotSupportedError("A time limit that ends earlier than the current lease",
                                        "Runtime leases only move later. Call stop() when the work is done.")
            self._limit = wanted
            self._live()
            self._keep(force=True)
        if rules is not None:
            self._resuming(lambda box: box.network.set(**rules))
        if retention is not None:
            _guard("sandbox", lambda: self.withruntime.set_retention(retention))
        if ports is not None:
            for port in [one for one in self._routes if one not in ports]:
                _guard("sandbox", lambda: self.withruntime.previews.delete(port))
                del self._routes[port]
            for port in ports:
                if port not in self._routes:
                    self._share(port)
        return self

    def snapshot(self, *, expiration: Any = None) -> Snapshot:
        """Keeps the filesystem as a disk-only snapshot, then stops the source.
        Restoring it starts fresh processes, as Vercel does."""
        days = None if expiration is None else core.retention_days(expiration)
        taken = self._resuming(lambda box: box.snapshot(retention_days=days, mode="disk"))
        try:
            _guard("sandbox", lambda: self.withruntime.stop())
            if self.withruntime.state != "stopped":
                _guard("sandbox", lambda: self.withruntime.wait_for("stopped"))
        except BaseException as error:  # Cancellation keeps its original type and saved IDs.
            recovery = {"snapshotId": taken["id"], "sourceSandboxId": self.withruntime.id}
            if isinstance(error, SandboxApiError):
                error.data = {**error.data, **recovery}
            else:
                error.snapshotId = taken["id"]
                error.sourceSandboxId = self.withruntime.id
            raise
        if self.withruntime.state != "stopped":
            raise SandboxApiError(
                f"Snapshot {taken['id']} was saved, but sandbox {self.name} did not finish stopping.",
                status_code=409, code="snapshot_source_stop_timeout",
                data={"snapshotId": taken["id"], "sourceSandboxId": self.withruntime.id})
        return Snapshot(taken, self._client)

    list_sessions = staticmethod(core.unsupported("Listing a sandbox's sessions",
                                                  "A Runtime sandbox has one session: itself."))
    list_snapshots = staticmethod(core.unsupported("Listing a sandbox's snapshots from the sandbox",
                                                   "Use query_snapshots(name=...)."))


def _find(client: Runtime, name: str) -> Any:
    if core.UUID.match(name):
        return _guard("sandbox", lambda: client.sandboxes.get(name))
    listing = _guard("other", lambda: client.sandboxes.list(name=name))
    live = [one for one in listing.to_list() if one.state != "stopped"]
    if not live:
        raise SandboxApiError(f"Sandbox {name} was not found.", status_code=404, code="not_found",
                              data={"error": {"code": "not_found", "message": f"Sandbox {name} was not found."}})
    return live[-1]


def _create(client: Runtime, *, name: Optional[str], image: Optional[str], source: Any,
                  ports: Optional[List[int]], execution_time_limit: Any, resources: Optional[SandboxResources],
                  persistent: Optional[bool], network_policy: Any, env: Optional[Mapping[str, str]],
                  tags: Optional[Mapping[str, str]], snapshot_expiration: Any,
                  runtime_create: Optional[Dict[str, Any]]) -> Sandbox:
    keep = True if persistent is None else persistent
    fields: Dict[str, Any] = {}
    if isinstance(source, core.SnapshotSource):
        fields["snapshot"] = source.snapshot_id
    else:
        vcpus = (resources.vcpus if resources and resources.vcpus else core.DEFAULT_VCPUS)
        fields.update(vcpu=vcpus, memory_mib=(resources.memory if resources and resources.memory
                                              else vcpus * core.MEMORY_MIB_PER_VCPU))
        if image is not None and not core.STOCK_IMAGE.match(image):
            if core.UUID.match(image):
                fields["image"] = image
            else:
                listing = _guard("other", lambda: client.images.list(name=image, state="ready", limit=1))
                if not listing.data:
                    raise NotSupportedError(
                        f"The image {image}, which is not a Runtime image",
                        f"Build it as a Runtime image with that name: `npx withruntime image build --dockerfile "
                        f"Dockerfile --name {image}`.")
                fields["image"] = listing.data[0]["id"]
    # No execution_time_limit, no time limit: it runs while it works (0300).
    if execution_time_limit is not None:
        fields["timeout_seconds"] = core.lease_seconds(execution_time_limit)
    fields["on_lease_end"] = "pause" if keep else "stop"
    if name:
        fields["name"] = name
    if tags:
        fields["labels"] = dict(tags)
    if network_policy is not None:
        fields["network"] = core.network_rules(network_policy)
    fields.update(runtime_create or {})
    runtime = _guard("sandbox", lambda: client.sandboxes.create(**fields))
    box = Sandbox(runtime, client, env, keep,
                       None if execution_time_limit is None else core.time_limit(execution_time_limit))
    box._schedule()
    try:
        box._setup(source, ports, snapshot_expiration)
    except BaseException as original:
        box._end_keeping()
        try:
            runtime.stop(wait=False)
        except BaseException as cleanup:
            raise original from cleanup
        raise
    return box


def create_sandbox(*, name: Optional[str] = None, image: Optional[str] = None, source: Any = None,
                   ports: Optional[List[int]] = None, execution_time_limit: Any = None,
                   resources: Optional[SandboxResources] = None, persistent: Optional[bool] = None,
                   network_policy: Any = None, network_id: Optional[str] = None,
                   env: Optional[Mapping[str, str]] = None, tags: Optional[Mapping[str, str]] = None,
                   mounts: Any = None, snapshot_expiration: Any = None, snapshot_retention: Any = None,
                   region: Optional[str] = None, failover_regions: Any = None, destroy: bool = True,
                   project_id: Optional[str] = None, token: Optional[str] = None,
                   client: Optional[Runtime] = None, runtime_create: Optional[Dict[str, Any]] = None,
                   **_private: Any) -> Any:
    """Creates a sandbox with Vercel's defaults (2 vCPUs with 2048 MiB each,
    5 minutes, persistent). Await it, or use it as a context manager that
    stops (and by default destroys) it. Funding is left to Runtime: the free
    trial while the account has trial time, then prepaid credit.
    ``runtime_create`` passes Runtime fields (snake_case)."""
    core.refuse_create(mounts, network_id, region, failover_regions)
    if snapshot_retention is not None:
        raise NotSupportedError("Automatic snapshot count and eviction policy (snapshot_retention)",
                                "Manage snapshots explicitly; Runtime does not implement this policy.")
    ports = _validated_ports(ports)
    if snapshot_expiration is not None:
        core.retention_days(snapshot_expiration)
    if execution_time_limit is not None:
        core.time_limit(execution_time_limit)
    if network_policy is not None:
        core.network_rules(network_policy)
    runtime_client = _client(token, client)
    return operation(lambda: _create(
        runtime_client, name=name, image=image, source=source, ports=ports, execution_time_limit=execution_time_limit,
        resources=resources, persistent=persistent, network_policy=network_policy, env=env, tags=tags,
        snapshot_expiration=snapshot_expiration, runtime_create=runtime_create), "destroy" if destroy else "stop")


def get_sandbox(*, name: str, project_id: Optional[str] = None, include_system_routes: bool = False,
                      token: Optional[str] = None, client: Optional[Runtime] = None) -> Sandbox:
    """A sandbox by name (or Runtime id), without waking it: the next process
    or file call does."""
    runtime_client = _client(token, client)
    return Sandbox(_find(runtime_client, name), runtime_client)


def resume_sandbox(*, name: str, project_id: Optional[str] = None, token: Optional[str] = None,
                   client: Optional[Runtime] = None) -> Any:
    """Wakes a stopped persistent sandbox now. As a context manager, stops it on exit."""
    def acquire() -> Any:
        box = get_sandbox(name=name, token=token, client=client)
        box._live()
        return box
    return operation(acquire, "stop")


def get_or_create_sandbox(*, name: str, resume: bool = True, token: Optional[str] = None,
                                client: Optional[Runtime] = None,
                                **create: Any) -> Tuple[Sandbox, bool]:
    """The named sandbox (woken unless resume=False) and False, or a new one and True."""
    try:
        box = get_sandbox(name=name, token=token, client=client)
    except SandboxApiError as error:
        if error.status_code != 404:
            raise
        create.pop("destroy", None)
        return create_sandbox(name=name, token=token, client=client, **create), True
    if resume:
        box._live()
    return box, False


def fork_sandbox(*, source_sandbox: str, name: Optional[str] = None, destroy: bool = True,
                 token: Optional[str] = None, client: Optional[Runtime] = None, **overrides: Any) -> Any:
    """A copy of a named sandbox, memory and all (a Runtime fork)."""
    given = [key for key, value in overrides.items() if value is not None]
    if given:
        raise NotSupportedError(f"Overriding {given[0]} on a fork",
                                "Fork without it; the copy keeps the source's machine, lease and rules.")

    def make() -> Any:
        source = get_sandbox(name=source_sandbox, token=token, client=client)
        source._live()
        copy = _guard("sandbox", lambda: source.withruntime.fork(name=name))
        return Sandbox(copy, source._client, source._env, source._persistent)
    return operation(make, "destroy" if destroy else "stop")


def query_sandboxes(query: Any = None, *, page_size: Optional[int] = None, cursor: Optional[str] = None,
                          project_id: Optional[str] = None, token: Optional[str] = None,
                          client: Optional[Runtime] = None) -> Any:
    """Live and stopped (paused) sandboxes, sorted and filtered as the query
    says (by name, creation, status change or snapshot; newest first unless
    ``sort_order="asc"``) over the whole list. ``page_size`` is how many
    each request fetches; every match is yielded. ``cursor`` continues a
    query (this adapter's cursors read ``rt.<n>``)."""
    start = core.cursor_offset(cursor)
    key, newest_first = core.query_order(query)
    runtime_client = _client(token, client)
    tag = getattr(query, "tag", None)
    listing = _guard("other", lambda: runtime_client.sandboxes.list(
        labels={tag.key: tag.value} if tag else None, limit=min(page_size, 100) if page_size else None))
    found = listing.to_list()
    prefix = getattr(query, "name_prefix", None)
    if prefix:
        found = [one for one in found if str(one.info.get("name") or "").startswith(prefix)]
    found.sort(key=key, reverse=newest_first)
    for runtime in found[start:]:
        yield Sandbox(runtime, runtime_client)


def get_snapshot(*, snapshot_id: str, token: Optional[str] = None,
                       client: Optional[Runtime] = None) -> Snapshot:
    runtime_client = _client(token, client)
    return Snapshot(_guard("other", lambda: runtime_client.snapshots.get(snapshot_id)), runtime_client)


def query_snapshots(*, name: Optional[str] = None, page_size: Optional[int] = None,
                          cursor: Optional[str] = None, sort_order: Optional[str] = None,
                          project_id: Optional[str] = None, token: Optional[str] = None,
                          client: Optional[Runtime] = None) -> Any:
    """Snapshots, optionally only those of the named sandbox."""
    runtime_client = _client(token, client)
    sandbox_id = None
    if name is not None:
        listing = _guard("other", lambda: runtime_client.sandboxes.list(name=name, include_stopped=True))
        if not listing.data:
            return
        sandbox_id = listing.data[0].id
    listing = _guard("other", lambda: runtime_client.snapshots.list(sandbox_id=sandbox_id, limit=page_size))
    found = listing.to_list()
    if sort_order == "desc":
        found.reverse()
    for info in found:
        yield Snapshot(info, runtime_client)


_DRIVES = ("Vercel Drives", "Use a Runtime volume (runtime.volumes) and mount it with "
           "runtime_create={'volumes': [{'volume_id': ..., 'path': ...}]}.")
get_or_create_drive = core.unsupported(*_DRIVES)
delete_drive = core.unsupported(*_DRIVES)
query_drives = core.unsupported(*_DRIVES)
query_sessions = core.unsupported("Querying sessions", "A Runtime sandbox is its own session: query_sandboxes.")

__all__ = ["Sandbox", "Process", "TextReader", "SandboxFilesystem", "Snapshot",
           "FileHandle", "Batch", "create_sandbox", "get_sandbox", "resume_sandbox", "get_or_create_sandbox",
           "fork_sandbox", "query_sandboxes", "get_snapshot", "query_snapshots", "get_or_create_drive", "delete_drive",
           "query_drives", "query_sessions"]
