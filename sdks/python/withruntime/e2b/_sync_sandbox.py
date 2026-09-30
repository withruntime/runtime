"""GENERATED from _async_sandbox.py by scripts/generate_e2b_sync.py. Do not edit."""
from __future__ import annotations

import dataclasses as _dataclasses
import datetime as _dt
import time as _time
from functools import partial

from typing import Any, Callable, Dict, List, Optional, Union

from .._sync_client import Runtime
from .._request_scope import limits as request_limits, request_scope

from . import _core as core
from ._sync_io import begin, call, finish, start, stop, stream, wrap, watch_directory, request, request_limited, close_stream, open_file, disconnect, opening_timeout, command_events
from ._core import (CommandResult, EntryInfo, FileNotFoundException, FileType, InvalidArgumentException,
                    NotSupportedException, ProcessInfo, SandboxException, SandboxInfo, SandboxNotFoundException,
                    SandboxQuery, SnapshotInfo, WriteInfo, class_method_variant, translate)

_clients: Dict[str, Any] = {}


def _client(api_key: Optional[str], client: Optional[Runtime], **connection: Any) -> Runtime:
    core.check_connection(connection)
    if client is not None:
        return client
    key = core.pick_key(api_key)
    found = _clients.get(key or "")
    if found is None:
        found = Runtime(api_key=key) if key else Runtime()
        _clients[key or ""] = found
    return found


def _guard(subject: str, work: Callable[[], Any], request_timeout: Optional[float] = None) -> Any:
    try:
        return request(work, request_timeout)
    except Exception as error:  # noqa: BLE001 - every Runtime error becomes E2B's
        raise translate(error, subject) from error


class CommandHandle:
    """A command started with ``background=True``: E2B's handle over a Runtime process."""

    def __init__(self, process: Any, stdin: bool, timeout_ms: int, cursor: int = 0,
                 on_stdout: Optional[Callable[[str], Any]] = None,
                 on_stderr: Optional[Callable[[str], Any]] = None, deadline: Optional[float] = None,
                 on_pty: Optional[Callable[[bytes], Any]] = None, pty: bool = False) -> None:
        self._process = process
        self._stdin = stdin
        self._request_timeout = 60
        self._timeout_ms = timeout_ms
        self._deadline = deadline if deadline is not None else (_time.monotonic() + timeout_ms / 1000 if timeout_ms else None)
        self._cursor = cursor
        self._on_stdout, self._on_stderr = on_stdout, on_stderr
        self._on_pty, self._pty = on_pty, pty
        self._stdout = ""
        self._stderr = ""
        self._exit: Optional[Dict[str, Any]] = None
        self._truncated = False
        self._failure: Optional[BaseException] = None
        self._disconnected = False
        self._task = start(self._follow)

    def __iter__(self):
        return command_events(self)

    def _follow(self):
        for _ in self:
            pass

    @property
    def pid(self) -> int:
        return core.pid_of(self._process.id)

    @property
    def stdout(self) -> str:
        return self._stdout

    @property
    def stderr(self) -> str:
        return self._stderr

    @property
    def exit_code(self) -> Optional[int]:
        if self._exit is None:
            return None
        code = self._exit.get("exitCode")
        return -1 if code is None else code

    @property
    def error(self) -> Optional[str]:
        return None if self._exit is None else core.to_result(self._exit.get("exitCode"), "", "").error

    def wait(self, on_pty: Optional[Callable[[bytes], Any]] = None, on_stdout: Optional[Callable[[str], Any]] = None,
                   on_stderr: Optional[Callable[[str], Any]] = None) -> CommandResult:
        """Waits for the command to end. Raises CommandExitException on a
        non-zero exit, as E2B does."""
        if on_pty is not None:
            self._on_pty = on_pty
        if on_stdout is not None:
            self._on_stdout = on_stdout
        if on_stderr is not None:
            self._on_stderr = on_stderr
        finish(self._task)
        if self._failure is not None:
            raise self._failure
        if self._exit is None:
            raise SandboxException("Disconnected from the command before it ended; reconnect with "
                                   "commands.connect(pid)." if self._disconnected
                                   else "The command's output ended without an exit.")
        return core.settle(self._exit.get("exitCode"), self._stdout, self._stderr,
                           bool(self._exit.get("timedOut")), self._timeout_ms, self._truncated)

    def disconnect(self) -> None:
        """Stops receiving output; the command keeps running."""
        self._disconnected = True
        disconnect(self._task)
        if hasattr(self, '_events'):
            close_stream(self._events)

    @request_limited
    def kill(self) -> bool:
        """Kills the command with SIGKILL. False when it had already ended."""
        if self._exit is not None:
            return False
        _guard("sandbox", lambda: self._process.kill("SIGKILL"))
        return True

    @request_limited
    def send_stdin(self, data: Union[str, bytes], request_timeout: Optional[float] = None) -> None:
        if not self._stdin:
            raise SandboxException("Sending stdin is not supported for this command handle.")
        _guard("sandbox", lambda: self._process.write(data))

    @request_limited
    def close_stdin(self, request_timeout: Optional[float] = None) -> None:
        if not self._stdin:
            raise SandboxException("Closing stdin is not supported for this command handle.")
        _guard("sandbox", lambda: self._process.write(b"", eof=True))


class Commands:
    """``sandbox.commands``: E2B's command module over Runtime's exec and processes."""

    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    def _env(self, envs: Optional[Dict[str, str]]) -> Optional[Dict[str, str]]:
        """A command's own envs; the sandbox's are Runtime's, added under them."""
        return dict(envs) if envs else None

    def run(self, cmd: str, background: Optional[bool] = None, envs: Optional[Dict[str, str]] = None,
                  user: Optional[str] = None, cwd: Optional[str] = None,
                  on_stdout: Optional[Callable[[str], Any]] = None, on_stderr: Optional[Callable[[str], Any]] = None,
                  stdin: Optional[bool] = None, timeout: Optional[float] = 60,
                  request_timeout: Optional[float] = None) -> Any:
        """Runs a command. In the foreground it returns the result and raises
        CommandExitException on a non-zero exit and TimeoutException past
        ``timeout`` (seconds, 0 for none); ``background=True`` returns a handle."""
        core.refuse_user(user)
        timeout_ms = core.command_timeout_ms(timeout)
        handle = self._start(cmd, envs, cwd, bool(stdin), timeout_ms, on_stdout, on_stderr, request_timeout)
        return handle if background else handle.wait()

    def _start(self, cmd: str, envs: Optional[Dict[str, str]], cwd: Optional[str], stdin: bool,
                     timeout_ms: int, on_stdout: Any, on_stderr: Any, request_timeout: Optional[float] = None) -> CommandHandle:
        deadline = _time.monotonic() + timeout_ms / 1000 if timeout_ms else None
        def spawn():
            self._sandbox._ensure_home(f"{cmd}\n{cwd or ''}")
            return self._sandbox.runtime.spawn(cmd, cwd=cwd, env=self._env(envs), stdin="pipe" if stdin else None)
        process = _guard("sandbox", spawn, opening_timeout(deadline, core.request_seconds(self, request_timeout)))
        handle = CommandHandle(process, stdin, timeout_ms, on_stdout=on_stdout, on_stderr=on_stderr, deadline=deadline)
        handle._request_timeout = core.request_seconds(self, None)
        return handle

    @request_limited
    def list(self, request_timeout: Optional[float] = None) -> List[ProcessInfo]:
        processes = _guard("sandbox", lambda: self._sandbox.runtime.processes())
        return [core.describe_process(info) for info in processes if info.get("state") == "running"]

    def _find(self, pid: int) -> Optional[Dict[str, Any]]:
        for info in _guard("sandbox", lambda: self._sandbox.runtime.processes()):
            if core.pid_of(info["id"]) == pid and info.get("state") == "running":
                return info
        return None

    def _process(self, pid: int) -> Any:
        info = self._find(pid)
        if info is None:
            raise SandboxException(f"No running command with pid {pid}.")
        return _guard("sandbox", lambda: self._sandbox.runtime.process(info["id"]))

    @request_limited
    def kill(self, pid: int, request_timeout: Optional[float] = None) -> bool:
        """Kills a command with SIGKILL, as E2B does. False when there is none."""
        info = self._find(pid)
        if info is None:
            return False
        process = _guard("sandbox", lambda: self._sandbox.runtime.process(info["id"]))
        _guard("sandbox", lambda: process.kill("SIGKILL"))
        return True

    @request_limited
    def send_stdin(self, pid: int, data: Union[str, bytes], request_timeout: Optional[float] = None) -> None:
        process = self._process(pid)
        if not process.info.get("stdinOpen"):
            raise InvalidArgumentException(f"The command with pid {pid} was not started with stdin=True.")
        _guard("sandbox", lambda: process.write(data))

    @request_limited
    def close_stdin(self, pid: int, request_timeout: Optional[float] = None) -> None:
        process = self._process(pid)
        _guard("sandbox", lambda: process.write(b"", eof=True))

    def connect(self, pid: int, timeout: Optional[float] = 60, request_timeout: Optional[float] = None,
                      on_stdout: Optional[Callable[[str], Any]] = None,
                      on_stderr: Optional[Callable[[str], Any]] = None) -> CommandHandle:
        """Attaches to a running command; output from now on reaches the handle."""
        timeout_ms = core.command_timeout_ms(timeout)
        deadline = _time.monotonic() + timeout_ms / 1000 if timeout_ms else None
        process = _guard("sandbox", lambda: self._process(pid), opening_timeout(deadline, core.request_seconds(self, request_timeout)))
        handle = CommandHandle(process, bool(process.info.get("stdinOpen")), timeout_ms,
                                    cursor=int(process.info.get("outputBytes") or 0), on_stdout=on_stdout,
                                    on_stderr=on_stderr, deadline=deadline)
        handle._request_timeout = core.request_seconds(self, None)
        return handle


class Pty(Commands):
    """E2B terminal sessions over native PTY processes and lossless byte output."""

    def create(self, size: core.PtySize,
                     user: Optional[str] = None, cwd: Optional[str] = None,
                     envs: Optional[Dict[str, str]] = None, timeout: Optional[float] = 60,
                     request_timeout: Optional[float] = None) -> CommandHandle:
        core.refuse_user(user)
        dimensions = self._size(size)
        timeout_ms = core.command_timeout_ms(timeout)
        deadline = _time.monotonic() + timeout_ms / 1000 if timeout_ms else None
        env = self._env(envs) or {}
        for key, value in (("TERM", "xterm-256color"), ("LANG", "C.UTF-8"), ("LC_ALL", "C.UTF-8")):
            env.setdefault(key, value)
        def spawn():
            self._sandbox._ensure_home(cwd)
            return self._sandbox.runtime.spawn(["/bin/bash", "-i", "-l"], cwd=cwd, env=env,
                                                     stdin="pipe", pty=dimensions, output_encoding="base64")
        process = _guard("sandbox", spawn, opening_timeout(deadline, core.request_seconds(self, request_timeout)))
        handle = CommandHandle(process, False, timeout_ms, deadline=deadline, on_pty=None, pty=True)
        handle._request_timeout = core.request_seconds(self, None)
        return handle

    def connect(self, pid: int, timeout: Optional[float] = 60,
                      request_timeout: Optional[float] = None) -> CommandHandle:
        timeout_ms = core.command_timeout_ms(timeout)
        deadline = _time.monotonic() + timeout_ms / 1000 if timeout_ms else None
        process = _guard("sandbox", lambda: self._process(pid), opening_timeout(deadline, core.request_seconds(self, request_timeout)))
        if process.info.get("outputEncoding") != "base64":
            raise NotSupportedException("Connecting to a legacy text-output PTY", "Create the PTY through sandbox.pty.create first.")
        handle = CommandHandle(process, False, timeout_ms, cursor=int(process.info.get("outputBytes") or 0),
                                    deadline=deadline, on_pty=None, pty=True)
        handle._request_timeout = core.request_seconds(self, None)
        return handle

    @request_limited
    def resize(self, pid: int, size: core.PtySize, request_timeout: Optional[float] = None) -> None:
        dimensions = self._size(size)
        process = self._process(pid)
        _guard("sandbox", lambda: process.resize(**dimensions))

    @staticmethod
    def _size(size: core.PtySize) -> dict:
        for value in (size.cols, size.rows):
            if type(value) is not int or value <= 0:
                raise InvalidArgumentException("PTY rows and columns must be positive integers")
        return {"cols": size.cols, "rows": size.rows}


class Filesystem:
    """``sandbox.files``: E2B's filesystem module over Runtime's files API.
    Relative paths resolve against the home directory (Runtime's is /workspace)."""

    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    @property
    def _files(self) -> Any:
        return self._sandbox.runtime.files

    def _path(self, path: str, user: Optional[str], metadata: Optional[Dict[str, str]] = None) -> str:
        core.refuse_file_user(user, metadata)
        self._sandbox._ensure_home(path)
        return core.absolute(path)

    def read(self, path: str, format: str = "text", user: Optional[str] = None,  # noqa: A002
                   request_timeout: Optional[float] = None, gzip: bool = False,
                   stream_idle_timeout: Optional[float] = None) -> Any:
        """The file as text (default), ``bytearray`` (format="bytes") or chunks (format="stream")."""
        total = request_timeout if format == "stream" else core.request_seconds(self, request_timeout)
        captured = request_limits(total, idle_timeout=60 if stream_idle_timeout is None else stream_idle_timeout)
        with request_scope(captured=captured):
            target = _guard("file_http", lambda: self._path(path, user))
            if format == "stream":
                return _guard("file_http", lambda: open_file(self._files, target, captured))
            data = _guard("file_http", lambda: self._files.read(target))
        if format == "bytes":
            return bytearray(data)
        if format == "text":
            return bytes(data).decode(errors="replace")
        return None

    @request_limited
    def write(self, path: str, data: Any, user: Optional[str] = None, request_timeout: Optional[float] = None,
                    gzip: bool = False, use_octet_stream: Optional[bool] = None,
                    metadata: Optional[Dict[str, str]] = None) -> WriteInfo:
        """Writes a file, making its directories, and replaces one that exists."""
        target = self._path(path, user, metadata)
        _guard("file_http", lambda: self._files.write(target, core.to_bytes(data)))
        return WriteInfo(name=target.rstrip("/").rsplit("/", 1)[-1], type=FileType.FILE, path=target)

    @request_limited
    def write_files(self, files: List[Dict[str, Any]], user: Optional[str] = None,
                          request_timeout: Optional[float] = None, gzip: bool = False,
                          use_octet_stream: Optional[bool] = None,
                          metadata: Optional[Dict[str, str]] = None) -> List[WriteInfo]:
        written = []
        for entry in files:
            written.append(self.write(entry["path"], entry["data"], user=user, metadata=metadata))
        return written

    @request_limited
    def list(self, path: str, depth: Optional[int] = 1, user: Optional[str] = None,
                   request_timeout: Optional[float] = None) -> List[EntryInfo]:
        """A directory's entries, hidden ones included; ``depth`` goes deeper."""
        target = self._path(path, user)
        entries = _guard("file", lambda: self._files.list(target, depth=depth or 1, hidden=True))
        return [core.entry_info(entry) for entry in entries]

    @request_limited
    def exists(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> bool:
        target = self._path(path, user)
        return bool(_guard("file", lambda: self._files.exists(target)))

    @request_limited
    def get_info(self, path: str, user: Optional[str] = None,
                       request_timeout: Optional[float] = None) -> EntryInfo:
        target = self._path(path, user)
        found = _guard("file", lambda: self._files.stat(target))
        if not found.get("exists"):
            raise FileNotFoundException(f"{target} does not exist.")
        return core.entry_info(found)

    @request_limited
    def remove(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> None:
        """Removes a file, or a directory with everything in it."""
        target = self._path(path, user)
        _guard("file", lambda: self._files.remove(target, recursive=True))

    @request_limited
    def rename(self, old_path: str, new_path: str, user: Optional[str] = None,
                     request_timeout: Optional[float] = None) -> EntryInfo:
        """Moves a file or directory, replacing a file at the new path, as E2B does."""
        source = self._path(old_path, user)
        target = self._path(new_path, user)
        _guard("file", lambda: self._files.rename(source, target, overwrite=True))
        return self.get_info(target)

    @request_limited
    def make_dir(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> bool:
        """Makes a directory and its parents. False when it already existed."""
        target = self._path(path, user)
        if _guard("file", lambda: self._files.exists(target)):
            return False
        _guard("file", lambda: self._files.mkdir(target, parents=True))
        return True

    @property
    def watch_dir(self) -> Any:
        # E2B's async interface takes callbacks; its sync twin polls events.
        # The language-specific helper keeps those signatures distinct.
        return partial(watch_directory, self)



class SandboxPaginator:
    """E2B's paginator: ``while p.has_next: items.extend(p.next_items())``."""

    def __init__(self, client: Runtime, filters: Dict[str, Any]) -> None:
        self._client = client
        self._filters = filters
        self._page: Any = None
        self._has_next = True

    @property
    def has_next(self) -> bool:
        return self._has_next

    @property
    def next_token(self) -> Optional[str]:
        return None if self._page is None else self._page.next_cursor

    def next_items(self) -> List[SandboxInfo]:
        if not self._has_next:
            raise SandboxException("No more items to fetch.")
        if self._page is None:
            page = _guard("other", lambda: self._client.sandboxes.list(**self._filters))
        else:
            page = _guard("other", lambda: self._page.next_page())
        self._page = page
        self._has_next = bool(page is not None and page.has_more)
        return [] if page is None else [core.sandbox_info(sbx.info) for sbx in page.data]


class Sandbox:
    """E2B's Sandbox, on Runtime. ``sandbox.runtime`` is the Runtime sandbox
    underneath, for anything E2B has no name for."""

    default_template = "base"

    def __init__(self, runtime: Any, client: Runtime) -> None:
        """Use ``Sandbox.create()`` or ``Sandbox.connect(id)``."""
        self.runtime = runtime
        self._client = client
        self._home_linked = False
        self._request_timeout = 60
        self._shares: Dict[int, Any] = {}  # port -> the one public share asked for it
        self.files = Filesystem(self)
        self.commands = Commands(self)

    @property
    def sandbox_id(self) -> str:
        return self.runtime.id

    def _ensure_home(self, text: Optional[str]) -> None:
        """E2B's home is /home/user and Runtime's is /workspace. The first time
        something names /home/user it is made a link to /workspace (unless
        something is already there), so paths written for E2B work."""
        if self._home_linked or not text or "/home/user" not in text:
            return
        self._home_linked = True
        result = _guard("sandbox", lambda: self.runtime.exec(core.HOME_LINK))
        if result.exit_code != 0:
            import warnings
            warnings.warn(f"Could not link /home/user to /workspace: {result.stderr.strip()}", stacklevel=3)

    # ---- create, connect, list ---------------------------------------------

    @classmethod
    def create(cls, template: Optional[str] = None, timeout: Optional[int] = None,
                     metadata: Optional[Dict[str, str]] = None, envs: Optional[Dict[str, str]] = None,
                     secure: Optional[bool] = None, allow_internet_access: Optional[bool] = None,
                     mcp: Any = None, network: Any = None, iam: Any = None, lifecycle: Optional[Dict[str, Any]] = None,
                     volume_mounts: Any = None, api_key: Optional[str] = None,
                     client: Optional[Runtime] = None, runtime_create: Optional[Dict[str, Any]] = None,
                     **connection: Any) -> Any:
        """Creates a sandbox from ``template`` (default "base", Runtime's stock
        image) with E2B's default machine, 2 vCPU and 512 MiB, and waits until
        it runs. ``timeout`` is in seconds (default 300). Funding is left to
        Runtime: the free trial while the account has trial time, then prepaid
        credit, exactly as withruntime's own create. ``runtime_create`` passes
        Runtime fields (snake_case) over the adapter's."""
        core.refuse_create({"mcp": mcp, "network": network, "iam": iam, "volume_mounts": volume_mounts})
        runtime_client = _client(api_key, client, **connection)
        with request_scope(connection.get("request_timeout") if connection.get("request_timeout") is not None else 60):
            fields: Dict[str, Any] = {
                "timeout_seconds": core.lease_seconds(core.DEFAULT_TIMEOUT if timeout is None else timeout),
                "on_lease_end": core.on_lease_end(lifecycle),
            }
            if lifecycle:
                # E2B resumes on traffic only when asked; Runtime's automatic wake is the same (0093).
                fields["auto_wake"] = bool(lifecycle.get("auto_resume"))
            if metadata:
                fields["labels"] = dict(metadata)
            if envs:
                # Runtime keeps them with the sandbox: every command, terminal and
                # interpreter in it gets them, from this client or any other.
                fields["env"] = dict(envs)
            if allow_internet_access is False:
                fields["network"] = {"internet": False}
            source = _guard("sandbox", lambda: cls._resolve(runtime_client, template or cls.default_template))
            if "snapshot" not in source:
                fields = {"vcpu": core.DEFAULT_VCPU, "memory_mib": core.DEFAULT_MEMORY_MIB, **fields}
            fields.update(source)
            fields.update(runtime_create or {})
            created = _guard("sandbox", lambda: runtime_client.sandboxes.create(**fields))
        result = cls(created, runtime_client)
        result._request_timeout = connection.get("request_timeout") if connection.get("request_timeout") is not None else 60
        return result

    @staticmethod
    def _resolve(client: Runtime, template: str) -> Dict[str, Any]:
        if template in core.STOCK_TEMPLATES:
            return {}
        if core.UUID.match(template):
            try:
                client.images.get(template)
                return {"image": template}
            except Exception as error:  # noqa: BLE001
                if getattr(error, "status", None) != 404:
                    raise translate(error) from error
            return {"snapshot": template}
        page = _guard("other", lambda: client.images.list(name=template, state="ready", limit=1))
        if page.data:
            return {"image": page.data[0]["id"]}
        raise core.template_missing(template)

    @classmethod
    def _cls_connect_sandbox(cls, sandbox_id: str, timeout: Optional[int] = None, *,
                                   on_resume: str = "restore", api_key: Optional[str] = None,
                                   client: Optional[Runtime] = None, **connection: Any) -> Any:
        runtime_client = _client(api_key, client, **connection)
        with request_scope(connection.get("request_timeout") if connection.get("request_timeout") is not None else 60):
            runtime = _guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id))
            _resume(runtime, timeout, on_resume)
        result = cls(runtime, runtime_client)
        result._request_timeout = connection.get("request_timeout") if connection.get("request_timeout") is not None else 60
        return result

    @class_method_variant("_cls_connect_sandbox")
    def connect(self, timeout: Optional[int] = None, *, on_resume: str = "restore", **_: Any) -> Any:
        """Wakes this sandbox if it is paused; ``Sandbox.connect(id)`` does the same by id.
        A ``timeout`` (seconds) moves a running sandbox's end later, never earlier."""
        _guard("sandbox", lambda: self.runtime.refresh())
        _resume(self.runtime, timeout, on_resume)
        return self

    @classmethod
    def list(cls, query: Optional[SandboxQuery] = None, limit: Optional[int] = None,
             next_token: Optional[str] = None, order: Optional[str] = None, api_key: Optional[str] = None,
             client: Optional[Runtime] = None, **connection: Any) -> SandboxPaginator:
        """Running and paused sandboxes, a page at a time."""
        return SandboxPaginator(_client(api_key, client, **connection),
                                     core.list_filter(query, limit, next_token, order))

    # ---- lifecycle ------------------------------------------------------------

    @classmethod
    def _cls_kill(cls, sandbox_id: str, api_key: Optional[str] = None, client: Optional[Runtime] = None,
                        **connection: Any) -> bool:
        runtime_client = _client(api_key, client, **connection)
        try:
            runtime = _guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id))
        except SandboxNotFoundException:
            return False
        return _stop(runtime)

    @class_method_variant("_cls_kill")
    def kill(self, **_: Any) -> bool:
        """Stops the sandbox. False when it was not found or had already ended."""
        try:
            return _stop(self.runtime)
        except SandboxNotFoundException:
            return False

    @classmethod
    def _cls_set_timeout(cls, sandbox_id: str, timeout: int, api_key: Optional[str] = None,
                               client: Optional[Runtime] = None, **connection: Any) -> None:
        runtime_client = _client(api_key, client, **connection)
        _extend_to(_guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id)), timeout)

    @class_method_variant("_cls_set_timeout")
    def set_timeout(self, timeout: int, **_: Any) -> None:
        """Sets the sandbox to end ``timeout`` seconds from now. Runtime leases
        only move later: a shorter timeout than the one it has is refused."""
        _guard("sandbox", lambda: self.runtime.refresh())
        _extend_to(self.runtime, timeout)

    @classmethod
    def _cls_get_info(cls, sandbox_id: str, api_key: Optional[str] = None,
                            client: Optional[Runtime] = None, **connection: Any) -> SandboxInfo:
        runtime_client = _client(api_key, client, **connection)
        return core.sandbox_info((_guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id))).info)

    @class_method_variant("_cls_get_info")
    def get_info(self, **_: Any) -> SandboxInfo:
        _guard("sandbox", lambda: self.runtime.refresh())
        return core.sandbox_info(self.runtime.info)

    @request_limited
    def is_running(self, request_timeout: Optional[float] = None) -> bool:
        try:
            _guard("sandbox", lambda: self.runtime.refresh())
        except SandboxNotFoundException:
            return False
        return self.runtime.state == "running"

    @classmethod
    def _cls_pause(cls, sandbox_id: str, keep_memory: Optional[bool] = None, api_key: Optional[str] = None,
                         client: Optional[Runtime] = None, **connection: Any) -> bool:
        runtime_client = _client(api_key, client, **connection)
        return _pause(_guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id)), keep_memory)

    @class_method_variant("_cls_pause")
    def pause(self, keep_memory: Optional[bool] = None, **_: Any) -> bool:
        """Pauses the sandbox, keeping memory and files. False when it was paused."""
        _guard("sandbox", lambda: self.runtime.refresh())
        return _pause(self.runtime, keep_memory)

    @class_method_variant("_cls_pause")
    def beta_pause(self, keep_memory: Optional[bool] = None, **_: Any) -> bool:
        return self.pause(keep_memory)

    def __enter__(self) -> Any:
        return self

    def __exit__(self, *_: Any) -> None:
        self.kill()

    # ---- forks and snapshots ------------------------------------------------

    @classmethod
    def _cls_fork_sandbox(cls, sandbox_id: str, timeout: Optional[int] = None, count: Optional[int] = None,
                                **opts: Any) -> List[Any]:
        source = cls._cls_connect_sandbox(sandbox_id, **opts)
        return source.fork(timeout, count)

    @class_method_variant("_cls_fork_sandbox")
    def fork(self, timeout: Optional[int] = None, count: Optional[int] = None, **_: Any) -> List[Any]:
        """Copies of this sandbox, memory and all. While Runtime's forks are
        switched off this raises NotSupportedException in Runtime's own words."""
        if timeout is not None:
            # A fork's lease is Runtime's to set; one shorter than asked could not
            # be honoured after the forks exist, so this is refused before any are made.
            raise NotSupportedException("A timeout for forks (fork timeout)",
                                        "Fork without it, then call set_timeout(seconds) on each fork.")
        copies = _guard("sandbox", lambda: self.runtime.fork(count or 1))
        # Copies keep the source's environment on Runtime's side.
        return [type(self)(copy, self._client) for copy in copies]

    @classmethod
    def _cls_create_snapshot(cls, sandbox_id: str, name: Optional[str] = None, **opts: Any) -> SnapshotInfo:
        source = cls._cls_connect_sandbox(sandbox_id, **opts)
        return source.create_snapshot(name)

    @class_method_variant("_cls_create_snapshot")
    def create_snapshot(self, name: Optional[str] = None, **_: Any) -> SnapshotInfo:
        """Keeps the whole machine as a Runtime snapshot; start from it with create(snapshot_id)."""
        snapshot = _guard("sandbox", lambda: self.runtime.snapshot(name=name))
        return SnapshotInfo(snapshot_id=snapshot["id"], names=[snapshot["name"]] if snapshot.get("name") else [])

    @classmethod
    def delete_snapshot(cls, snapshot_id: str, api_key: Optional[str] = None,
                              client: Optional[Runtime] = None, **connection: Any) -> bool:
        runtime_client = _client(api_key, client, **connection)
        try:
            _guard("other", lambda: runtime_client.snapshots.delete(snapshot_id))
        except SandboxException as error:
            if error.status_code == 404:
                return False
            raise
        return True

    # ---- ports --------------------------------------------------------------

    def get_host(self, port: int) -> str:
        """E2B's get_host, answered at once as E2B answers it:
        ``<port>-<id>.runtimehost.com``. A Runtime preview's address is made
        from the sandbox and the port alone; the port is shared publicly the
        first time it is asked for. The async sandbox shares it beside the
        caller, in about a tenth of a second (``get_public_host(port)``
        returns once it has landed); the sync one before returning."""
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise InvalidArgumentException(f"port must be a whole number from 1 to 65535, not {port!r}.")
        if port not in self._shares:
            self._shares[port] = begin(lambda: self._share(port))
        return f"{port}-{self.sandbox_id.replace('-', '').lower()}.{core.PREVIEW_DOMAIN}"

    def get_public_host(self, port: int) -> str:
        """Shares ``port`` at a public HTTPS address (a Runtime preview) and
        returns its host once the share has landed. Anyone with the address
        can reach it; a browser sees a one-time page naming Runtime."""
        if port not in self._shares:
            self._shares[port] = begin(lambda: self._share(port))
        try:
            return self._shares[port]
        except BaseException:
            self._shares.pop(port, None)  # a failed share is asked again next time
            raise

    def _share(self, port: int) -> str:
        preview = _guard("sandbox", lambda: self.runtime.previews.create(port, visibility="public"))
        return preview["url"].split("://", 1)[-1].split("/", 1)[0]

    # ---- what Runtime does differently -----------------------------------------

    @property
    def pty(self) -> Any:
        return Pty(self)

    @property
    def git(self) -> Any:
        raise NotSupportedException("E2B's git module", "Run git with sandbox.commands.run('git ...').")

    def get_metrics(self, start: Any = None, end: Any = None) -> list["SandboxMetrics"]:
        """E2B's metrics, from Runtime's measured readings (``sbx.metrics()``):
        CPU as a percent of the sandbox's vCPUs and resident memory, one entry
        per host reading (every minute by default) between ``start`` and
        ``end`` (datetimes; the last 15 minutes by default), kept 24 hours at
        that resolution. Disk use inside the sandbox is not measured:
        ``disk_used`` is None and ``disk_total`` is the disk's size."""
        now = _dt.datetime.now(_dt.timezone.utc)
        begin = start or now - _dt.timedelta(minutes=15)
        finish = end or now
        span = (now - begin).total_seconds()
        window = "15m" if span <= 900 else "1h" if span <= 3600 else "6h" if span <= 21600 else "24h"
        m = _guard("sandbox", lambda: self.runtime.metrics(range=window))
        step = _dt.timedelta(seconds=m["stepSeconds"])
        out: list[SandboxMetrics] = []
        for point in m["points"]:
            at = _dt.datetime.fromisoformat(point["at"].replace("Z", "+00:00"))
            if point["cpuPercent"] is None or at < begin - step or at > finish:
                continue
            out.append(SandboxMetrics(timestamp=at, cpu_used_pct=point["cpuPercent"], cpu_count=m["vcpu"],
                                      mem_used=point["memoryBytes"], mem_total=m["memoryLimitBytes"],
                                      disk_used=None, disk_total=m["diskLimitBytes"]))
        return out

    update_network = staticmethod(core.unsupported(
        "E2B's network rules (update_network)", "Use sandbox.runtime.network.set(internet=..., allow=[...])."))
    upload_url = staticmethod(core.unsupported("Signed upload URLs", "Use sandbox.files.write(path, data)."))
    download_url = staticmethod(core.unsupported("Signed download URLs", "Use sandbox.files.read(path, 'bytes')."))
    get_mcp_token = staticmethod(core.unsupported("E2B's MCP gateway", "Runtime's MCP server is `npx withruntime mcp`."))


def _resume(runtime: Any, timeout: Optional[int], on_resume: str) -> None:
    if on_resume == "reboot":
        raise NotSupportedException("Resuming by reboot (on_resume='reboot')",
                                    "Runtime's wake restores memory; stop the sandbox and create a new one.")
    state = core.simple_state(runtime.state)
    if state == "stopped":
        raise SandboxNotFoundException(f"Sandbox {runtime.id} has ended.")
    if state == "paused":
        _guard("sandbox", lambda: runtime.wake(timeout_seconds=None if timeout is None else core.lease_seconds(timeout)))
        return
    if timeout is not None:
        later = core.seconds_later(runtime.info, timeout)
        if later > 1:
            _guard("sandbox", lambda: runtime.extend(int(later) + 1))


def _stop(runtime: Any) -> bool:
    if core.simple_state(runtime.state) == "stopped":
        return False
    _guard("sandbox", lambda: runtime.stop(wait=False))
    return True


def _extend_to(runtime: Any, timeout: float) -> None:
    if timeout is None or timeout <= 0:
        raise InvalidArgumentException(f"timeout must be a positive number of seconds, not {timeout}.")
    later = core.seconds_later(runtime.info, timeout)
    if later < -1:
        raise NotSupportedException("Shortening a sandbox's timeout",
                                    "Runtime leases only move later. Call kill() when the work is done.")
    if later > 1:
        _guard("sandbox", lambda: runtime.extend(int(later) + 1))


def _pause(runtime: Any, keep_memory: Optional[bool]) -> bool:
    if keep_memory is False:
        raise NotSupportedException("A files-only pause (keep_memory=False)",
                                    "Runtime's pause keeps memory and files; leave keep_memory out.")
    state = core.simple_state(runtime.state)
    if state == "paused":
        return False
    if state == "stopped":
        raise SandboxNotFoundException(f"Sandbox {runtime.id} has ended.")
    _guard("sandbox", lambda: runtime.pause())
    return True


__all__ = ["Sandbox", "Commands", "CommandHandle", "Filesystem", "SandboxPaginator"]


@_dataclasses.dataclass
class SandboxMetrics:
    """One reading, in E2B's shape. ``disk_used`` is None: Runtime does not
    read disk use inside the sandbox."""
    timestamp: "_dt.datetime"
    cpu_used_pct: float
    cpu_count: int
    mem_used: int
    mem_total: int
    disk_used: Optional[int]
    disk_total: int
