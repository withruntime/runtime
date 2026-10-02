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
from ._sync_io import background, each_event, next_event, past_deadline, sleep
from .._request_scope import Limits
from ._core import (CommandResult, EntryInfo, FileNotFoundException, FileType, InvalidArgumentException,
                    NotSupportedException, ProcessInfo, PublicPreviewNotAllowedException, SandboxException,
                    SandboxInfo, SandboxNotFoundException,
                    SandboxQuery, SnapshotInfo, WriteInfo, class_method_variant, translate)

_clients: Dict[str, Any] = {}


def _refuse_fork_timeout(timeout: Optional[int]) -> None:
    if timeout is not None:
        raise NotSupportedException("A timeout for forks (fork timeout)",
                                    "Fork without it, then call set_timeout(seconds) on each fork.")


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
                 on_pty: Optional[Callable[[bytes], Any]] = None, pty: bool = False,
                 events: Any = None, process_id: Optional[str] = None,
                 resolve: Optional[Callable[[], Any]] = None, limits: Any = None) -> None:
        # ``events``: the rest of the stream the command was started with,
        # read from its first byte; the process itself is fetched (``resolve``)
        # only when something needs it.
        self._process = process
        self._process_id = process_id if process is None else process.id
        self._resolve = resolve
        if events is not None:
            self._events, self._limits = events, limits
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
        return core.pid_of(self._process_id)

    def _runtime_process(self) -> Any:
        if self._process is None:
            self._process = _guard("sandbox", self._resolve)
        return self._process

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
        process = self._runtime_process()
        _guard("sandbox", lambda: process.kill("SIGKILL"))
        return True

    @request_limited
    def send_stdin(self, data: Union[str, bytes], request_timeout: Optional[float] = None) -> None:
        if not self._stdin:
            raise SandboxException("Sending stdin is not supported for this command handle.")
        process = self._runtime_process()
        _guard("sandbox", lambda: process.write(data))

    @request_limited
    def close_stdin(self, request_timeout: Optional[float] = None) -> None:
        if not self._stdin:
            raise SandboxException("Closing stdin is not supported for this command handle.")
        process = self._runtime_process()
        _guard("sandbox", lambda: process.write(b"", eof=True))


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
        ``timeout`` (seconds, 0 for none); ``background=True`` returns a handle.
        ``user``: "user" (the default) is the sandbox's own user; any other
        user that exists, root included, runs it through ``sudo -u``."""
        timeout_ms = core.command_timeout_ms(timeout)
        name = _run_as(self._sandbox, user)
        command: Any = core.command_as(name, cmd, cwd is not None) if name else cmd
        if background or stdin:
            handle = self._start(command, envs, cwd, bool(stdin), timeout_ms, on_stdout, on_stderr,
                                       request_timeout, home=cmd)
            return handle if background else handle.wait()
        return (self._stream(command, cmd, envs, cwd, timeout_ms, on_stdout, on_stderr)).wait()

    def _stream(self, command: Any, text: str, envs: Optional[Dict[str, str]], cwd: Optional[str],
                      timeout_ms: int, on_stdout: Any, on_stderr: Any) -> CommandHandle:
        """A command waited on here is read from its first byte by the request
        that starts it, so Runtime holds a fast writer back rather than
        dropping what it printed before the first read: the result is whole."""
        deadline = _time.monotonic() + timeout_ms / 1000 if timeout_ms else None
        self._sandbox._ensure_home(f"{text}\n{cwd or ''}")
        runtime = self._sandbox.runtime
        # The stream is bounded by E2B's connection deadline, never by the
        # deadline of the call that opened it.
        limits = Limits(deadline)
        with request_scope(captured=limits):
            events = runtime.exec_stream(command, cwd=cwd, env=self._env(envs), timeout_ms=core.PROCESS_LIFETIME_MS)
            try:
                first = next_event(events)
            except Exception as error:  # noqa: BLE001 - every Runtime error becomes E2B's
                raise translate(error, "sandbox") from error
        if first.get("type") != "start":
            raise SandboxException("The command's output began without a start.")
        process_id = first["processId"]
        handle = CommandHandle(None, False, timeout_ms, on_stdout=on_stdout, on_stderr=on_stderr,
                                    deadline=deadline, events=events, process_id=process_id,
                                    resolve=lambda: runtime.process(process_id), limits=limits)
        handle._request_timeout = core.request_seconds(self, None)
        return handle

    def _start(self, cmd: Any, envs: Optional[Dict[str, str]], cwd: Optional[str], stdin: bool,
                     timeout_ms: int, on_stdout: Any, on_stderr: Any, request_timeout: Optional[float] = None,
                     home: Optional[str] = None) -> CommandHandle:
        deadline = _time.monotonic() + timeout_ms / 1000 if timeout_ms else None
        def spawn():
            self._sandbox._ensure_home(f"{home if home is not None else cmd}\n{cwd or ''}")
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
        dimensions = self._size(size)
        timeout_ms = core.command_timeout_ms(timeout)
        deadline = _time.monotonic() + timeout_ms / 1000 if timeout_ms else None
        env = self._env(envs) or {}
        for key, value in (("TERM", "xterm-256color"), ("LANG", "C.UTF-8"), ("LC_ALL", "C.UTF-8")):
            env.setdefault(key, value)
        def spawn():
            # Another user's terminal is a login shell of theirs, through sudo -u.
            name = _run_as(self._sandbox, user)
            self._sandbox._ensure_home(cwd)
            shell = core.shell_as(name, cwd is not None) if name else ["/bin/bash", "-i", "-l"]
            return self._sandbox.runtime.spawn(shell, cwd=cwd, env=env,
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

    def _as(self, user: Optional[str], name: str, *args: str, stdin: Optional[str] = None) -> Any:
        """One file call as another Linux user: a short script run with
        ``sudo -u``, since Runtime's file API acts as the sandbox's own user.
        Its output streams, so a read of any size comes back whole."""
        argv = core.user_script(user, core.USER_FILE_SCRIPTS[name], *args)
        result = _guard("sandbox", lambda: self._sandbox.runtime.exec(
            argv, stdin=stdin, on_stdout=core.whole_output))
        if result.stdout_truncated:
            raise SandboxException("Part of the answer was lost on the way; try again.")
        return result

    def _as_checked(self, user: str, path: str, name: str, *args: str, stdin: Optional[str] = None) -> Any:
        result = self._as(user, name, path, *args, stdin=stdin)
        if result.exit_code != 0:
            raise core.user_file_failure(user, path, result.exit_code, result.stderr)
        return result

    def read(self, path: str, format: str = "text", user: Optional[str] = None,  # noqa: A002
                   request_timeout: Optional[float] = None, gzip: bool = False,
                   stream_idle_timeout: Optional[float] = None) -> Any:
        """The file as text (default), ``bytearray`` (format="bytes") or chunks (format="stream")."""
        total = request_timeout if format == "stream" else core.request_seconds(self, request_timeout)
        captured = request_limits(total, idle_timeout=60 if stream_idle_timeout is None else stream_idle_timeout)
        with request_scope(captured=captured):
            target = _guard("file_http", lambda: self._path(path, user))
            name = _run_as(self._sandbox, user)
            if name:
                import base64
                result = self._as_checked(name, target, "read")
                data = base64.b64decode(result.stdout.strip())
                if format == "stream":
                    return iter([data])
            elif format == "stream":
                return _guard("file_http", lambda: open_file(self._files, target, captured))
            else:
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
        name = _run_as(self._sandbox, user)
        if name:
            import base64
            encoded = base64.b64encode(core.to_bytes(data)).decode()
            offset = 0
            while True:
                self._as_checked(name, target, "write" if offset == 0 else "append",
                                       stdin=encoded[offset:offset + core.WRITE_CHUNK])
                offset += core.WRITE_CHUNK
                if offset >= len(encoded):
                    break
        else:
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
        name = _run_as(self._sandbox, user)
        if name:
            result = self._as_checked(name, target, "list", str(depth or 1))
            entries = core.found_entries(result.stdout)
        else:
            entries = _guard("file", lambda: self._files.list(target, depth=depth or 1, hidden=True))
        return [core.entry_info(entry) for entry in entries]

    @request_limited
    def exists(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> bool:
        target = self._path(path, user)
        name = _run_as(self._sandbox, user)
        if name:
            return (self._as(name, "exists", target)).exit_code == 0
        return bool(_guard("file", lambda: self._files.exists(target)))

    @request_limited
    def get_info(self, path: str, user: Optional[str] = None,
                       request_timeout: Optional[float] = None) -> EntryInfo:
        target = self._path(path, user)
        name = _run_as(self._sandbox, user)
        if name:
            entries = core.found_entries((self._as_checked(name, target, "stat")).stdout)
            if not entries:
                raise FileNotFoundException(f"{target} does not exist.")
            return core.entry_info(entries[0])
        found = _guard("file", lambda: self._files.stat(target))
        if not found.get("exists"):
            raise FileNotFoundException(f"{target} does not exist.")
        return core.entry_info(found)

    @request_limited
    def remove(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> None:
        """Removes a file, or a directory with everything in it."""
        target = self._path(path, user)
        name = _run_as(self._sandbox, user)
        if name:
            self._as_checked(name, target, "remove")
            return
        _guard("file", lambda: self._files.remove(target, recursive=True))

    @request_limited
    def rename(self, old_path: str, new_path: str, user: Optional[str] = None,
                     request_timeout: Optional[float] = None) -> EntryInfo:
        """Moves a file or directory, replacing a file at the new path, as E2B does."""
        source = self._path(old_path, user)
        target = self._path(new_path, user)
        name = _run_as(self._sandbox, user)
        if name:
            self._as_checked(name, source, "rename", target)
        else:
            _guard("file", lambda: self._files.rename(source, target, overwrite=True))
        return self.get_info(target, user=user)

    @request_limited
    def make_dir(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> bool:
        """Makes a directory and its parents. False when it already existed."""
        target = self._path(path, user)
        name = _run_as(self._sandbox, user)
        if name:
            result = self._as(name, "make_dir", target)
            if result.exit_code == core.EXISTS:
                return False
            if result.exit_code != 0:
                raise core.user_file_failure(name, target, result.exit_code, result.stderr)
            return True
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
    """E2B's paginator: ``while p.has_next: items.extend(p.next_items())``.
    Runtime filters by state and metadata itself; a template, ``started_after``,
    newest-first order or a saved ``next_token`` are done here: every match is
    read once, then served a page at a time."""

    def __init__(self, client: Runtime, filters: Dict[str, Any]) -> None:
        self._client = client
        self._filters = filters
        self._page: Any = None
        self._all: Optional[List[SandboxInfo]] = None
        self._offset = filters["offset"]
        self._has_next = True

    @property
    def has_next(self) -> bool:
        return self._has_next

    @property
    def next_token(self) -> Optional[str]:
        """Where the next page starts; ``list(next_token=...)`` resumes there."""
        return f"runtime:{self._offset}" if self._has_next and self._offset > 0 else None

    def next_items(self) -> List[SandboxInfo]:
        if not self._has_next:
            raise SandboxException("No more items to fetch.")
        if self._filters["local"]:
            if self._all is None:
                self._all = _guard("other", self._every_match)
            items = self._all[self._offset:self._offset + self._filters["page_size"]]
            self._offset += len(items)
            self._has_next = self._offset < len(self._all)
            return items
        if self._page is None:
            page = _guard("other", lambda: self._client.sandboxes.list(**self._filters["server"]))
        else:
            page = _guard("other", lambda: self._page.next_page())
        self._page = page
        self._has_next = bool(page is not None and page.has_more)
        items = [] if page is None else [core.sandbox_info(sbx.info) for sbx in page.data]
        self._offset += len(items)
        return items

    def _every_match(self) -> List[SandboxInfo]:
        template = self._filters["template"]
        templates = None
        if template is not None:
            if template in core.STOCK_TEMPLATES:
                templates = {"base"}
            elif core.UUID.match(template):
                templates = {template}
            else:
                images = self._client.images.list(name=template, limit=100)
                templates = {image["id"] for image in images.data}
        infos: List[SandboxInfo] = []
        page = self._client.sandboxes.list(**self._filters["server"])
        while page is not None:
            infos.extend(core.sandbox_info(sbx.info) for sbx in page.data)
            page = page.next_page() if page.has_more else None
        return core.matching(infos, templates, self._filters)


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
        self._users: Dict[str, bool] = {}  # users this sandbox was found to have
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

    def _run_as(self, user: Optional[str]) -> Optional[str]:
        """The Linux user a call runs as, or None for the sandbox's own. A user
        the sandbox does not have is refused, never created; checked once."""
        name = core.other_user(user)
        if name is None or name == "root" or self._users.get(name):
            return name
        found = _guard("sandbox", lambda: self.runtime.exec(["id", "-u", "--", name]))
        if found.exit_code != 0:
            raise core.no_such_user(name)
        self._users[name] = True
        return name

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
        asked = _time.time() + (core.DEFAULT_TIMEOUT if timeout is None else timeout)
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
        _keep_until(created, asked)
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
        _stop_keeping(sandbox_id)
        try:
            runtime = _guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id))
        except SandboxNotFoundException:
            return False
        return _stop(runtime)

    @class_method_variant("_cls_kill")
    def kill(self, **_: Any) -> bool:
        """Stops the sandbox. False when it was not found or had already ended."""
        _stop_keeping(self.sandbox_id)
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
        """Sets the sandbox to end ``timeout`` seconds from now, up to 24 hours;
        past an hour the lease is moved on while this process runs. Runtime
        cannot end a lease early, so an end sooner than the lease's is refused."""
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
        _refuse_fork_timeout(timeout)
        core.check_fork_count(count)
        source = cls._cls_connect_sandbox(sandbox_id, **opts)
        return source.fork(timeout, count)

    @class_method_variant("_cls_fork_sandbox")
    def fork(self, timeout: Optional[int] = None, count: Optional[int] = None, **_: Any) -> List[Any]:
        """Copies of this sandbox, memory and all. While Runtime's forks are
        switched off this raises NotSupportedException in Runtime's own words."""
        # Refuse before resource effects, including the class-level reconnect.
        _refuse_fork_timeout(timeout)
        core.check_fork_count(count)
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
        # A trial sandbox's ports are private: a host alone would answer 404 or
        # 401 to everyone. Say so now, with the address that works.
        if self.runtime.info.get("funding") == "trial":
            raise PublicPreviewNotAllowedException(self.sandbox_id, port)
        if port not in self._shares:
            self._shares[port] = begin(lambda: self._share(port))
        return f"{port}-{self.sandbox_id.replace('-', '').lower()}.{core.PREVIEW_DOMAIN}"

    def get_public_host(self, port: int) -> str:
        """Shares ``port`` at a public HTTPS address (a Runtime preview) and
        returns its host once the share has landed. Anyone with the address
        can reach it; a browser sees a one-time page naming Runtime."""
        if self.runtime.info.get("funding") == "trial":
            raise PublicPreviewNotAllowedException(self.sandbox_id, port)
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
    asked = None if timeout is None else _time.time() + timeout
    if state == "paused":
        _guard("sandbox", lambda: runtime.wake(timeout_seconds=None if timeout is None else core.lease_seconds(timeout)))
    elif timeout is not None:
        core.check_timeout(timeout)
        later = core.seconds_later(runtime.info, min(timeout, core.KEEP_AHEAD))
        if later > 1:
            _guard("sandbox", lambda: runtime.extend(int(later) + 1))
    kept = _keepers.get(runtime.id)
    if asked is not None and asked > (kept["until"] if kept else 0):
        _keep_until(runtime, asked)


def _stop(runtime: Any) -> bool:
    if core.simple_state(runtime.state) == "stopped":
        return False
    _guard("sandbox", lambda: runtime.stop(wait=False))
    return True


def _extend_to(runtime: Any, timeout: float) -> None:
    core.check_timeout(timeout)
    asked = _time.time() + timeout
    if core.seconds_later(runtime.info, timeout) < -1:
        raise NotSupportedException("Ending a sandbox sooner than its lease (a shorter set_timeout)",
                                    "Runtime cannot end a lease early. Call kill() when the work is done.")
    later = core.seconds_later(runtime.info, min(timeout, core.KEEP_AHEAD))
    if later > 1:
        _guard("sandbox", lambda: runtime.extend(int(later)))
    _keep_until(runtime, asked)


def _run_as(sandbox: Any, user: Optional[str]) -> Optional[str]:
    """The sandbox's own user asks nothing of the sandbox."""
    return None if core.other_user(user) is None else sandbox._run_as(user)


# Timeouts over an hour. Runtime's lease reaches at most an hour ahead of now,
# and E2B's timeout up to a day. While this process runs, the adapter moves
# the lease on every five minutes, as far as an hour ahead and never past the
# end asked for; one keeper per sandbox, whichever object asked. If the
# process ends first, the sandbox ends when its lease does, at most an hour
# later. The async keeper is a task on the running loop; the sync one a
# daemon thread.
_keepers: Dict[str, Dict[str, Any]] = {}
_warned_keeper = False


def _keep_until(runtime: Any, until: float) -> None:
    if until - _time.time() <= core.MAX_LEASE:
        _stop_keeping(runtime.id)
        return
    keeper = _keepers.get(runtime.id)
    if keeper is not None:
        keeper["until"], keeper["runtime"] = until, runtime
        return
    keeper = {"until": until, "runtime": runtime}
    _keepers[runtime.id] = keeper
    keeper["cancel"] = background(lambda: _keep_loop(keeper))


def _stop_keeping(sandbox_id: str) -> None:
    keeper = _keepers.pop(sandbox_id, None)
    if keeper is not None and keeper.get("cancel"):
        keeper["cancel"]()


def _keep_loop(keeper: Dict[str, Any]) -> None:
    while _keepers.get(keeper["runtime"].id) is keeper:
        sleep(core.KEEP_EVERY)
        if _keepers.get(keeper["runtime"].id) is not keeper:
            return
        _renew(keeper)


def _renew(keeper: Dict[str, Any]) -> None:
    global _warned_keeper
    runtime = keeper["runtime"]
    if _keepers.get(runtime.id) is not keeper:
        return
    try:
        runtime.refresh()
        state = core.simple_state(runtime.state)
        if state == "stopped":
            _stop_keeping(runtime.id)
            return
        if state == "running":
            now = _time.time()
            later = int(core.seconds_later(runtime.info, min(keeper["until"], now + core.KEEP_AHEAD) - now))
            if later >= 1:
                runtime.extend(later)
            if core.seconds_later(runtime.info, keeper["until"] - _time.time()) <= 1:
                _stop_keeping(runtime.id)
    except Exception as error:  # noqa: BLE001 - tried again at the next turn
        if not _warned_keeper:
            _warned_keeper = True
            import warnings
            warnings.warn(f"Could not extend sandbox {runtime.id}'s lease toward its timeout: {error}. "
                          "Trying again in five minutes.", RuntimeWarning, stacklevel=1)


def renew_leases() -> None:
    """Test hook: renew every kept lease now, as the five-minute timer would."""
    for keeper in list(_keepers.values()):
        _renew(keeper)


def kept_leases() -> Dict[str, float]:
    """Test hook: the end (epoch seconds) each kept sandbox is kept until."""
    return {sandbox_id: keeper["until"] for sandbox_id, keeper in _keepers.items()}


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
