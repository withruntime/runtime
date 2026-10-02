"""Blaxel's SandboxInstance and its parts over Runtime's AsyncRuntime. The
sync SyncSandboxInstance is generated from this file by
scripts/generate_dropin_sync.py; edit this one."""
from __future__ import annotations

import json
import math
import re
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

from .._async_client import AsyncRuntime
from .._request_scope import request_scope

from . import _core as core
from ._async_io import call, finish, gather, http, now, preview_token_expiration, start, stop
from ._core import (AsyncStreamHandle, AsyncWatchHandle, ContentSearchResponse, CopyResponse, Directory, Execution,
                    ExecutionError, FindMatch, FindResponse, NotSupportedError, OutputMessage, Preview, PreviewMetadata,
                    PreviewSpec, PreviewToken, PreviewTokenMetadata, PreviewTokenSpec, ProcessResponse,
                    ProcessResponseStatus, ProcessResponseWithLog, ResponseError, Sandbox, SandboxAPIError,
                    SandboxForkResponse, SandboxSnapshot, SandboxSnapshotSource, SandboxSnapshotSpec,
                    Subdirectory, SuccessResponse, WatchEvent, translate)

_clients: Dict[str, Any] = {}
_client_override: List[Any] = []


def _client() -> AsyncRuntime:
    """The Runtime client every call uses: the one ``use_client`` set (tests,
    or code that wants its own), else one per key."""
    if _client_override:
        return _client_override[-1]
    key = core.pick_key()
    found = _clients.get(key or "")
    if found is None:
        found = AsyncRuntime(api_key=key) if key else AsyncRuntime()
        _clients[key or ""] = found
    return found


def use_client(client: Optional[AsyncRuntime]) -> None:
    """Makes every Blaxel call go through ``client`` (an AsyncRuntime; the
    sync API takes a Runtime); None goes back to RUNTIME_API_KEY or the saved
    login."""
    _client_override.clear()
    if client is not None:
        _client_override.append(client)


async def _guard(subject: str, work: Callable[[], Any]) -> Any:
    try:
        return await work()
    except Exception as error:  # noqa: BLE001 - every Runtime error becomes Blaxel's
        raise translate(error, subject) from error


def _not_found(name: str) -> SandboxAPIError:
    error = SandboxAPIError(f"Sandbox '{name}' not found", status_code=404, code="not_found")
    return error


async def _find(client: AsyncRuntime, name: str) -> Any:
    """A live Runtime sandbox by Blaxel name, or by Runtime id."""
    if core.UUID.match(name):
        found = await _guard("sandbox", lambda: client.sandboxes.get(name))
        if found.state == "stopped":
            raise _not_found(name)
        return found
    listing = await _guard("sandbox", lambda: client.sandboxes.list(name=name))
    live = [one for one in await listing.to_list() if one.state != "stopped"]
    if not live:
        raise _not_found(name)
    return live[-1]


class AsyncPaginatedList(list):
    """One page of a list: a list, with ``data``, ``has_more``,
    ``next_cursor``, ``next_page()`` and ``auto_paging_iter()``."""

    def __init__(self, data: Optional[List[Any]] = None, *, meta: Any = core.UNSET,
                 fetch_next: Any = None, page: Any = None, mapper: Any = None) -> None:
        super().__init__(data or [])
        self._page, self._mapper, self._fetch_next = page, mapper, fetch_next
        self.meta = core.PaginationMeta(has_more=page.has_more, next_cursor=page.next_cursor) \
            if meta is core.UNSET and page is not None else meta

    @property
    def data(self) -> List[Any]:
        return self

    @property
    def has_more(self) -> bool:
        return bool(self.meta is not core.UNSET and self.meta is not None and getattr(self.meta, "has_more", False))

    @property
    def next_cursor(self) -> Optional[str]:
        if not self.has_more:
            return None
        cursor = getattr(self.meta, "next_cursor", None)
        return None if cursor is core.UNSET or cursor == "" else cursor

    @property
    def is_empty(self) -> bool:
        return len(self) == 0

    async def next_page(self) -> "AsyncPaginatedList":
        cursor = self.next_cursor
        if not cursor:
            return AsyncPaginatedList([])
        if self._fetch_next is not None:
            return await self._fetch_next(cursor)
        if self._page is None:
            return AsyncPaginatedList([])
        if cursor != self._page.next_cursor:
            raise NotSupportedError("Changing a native list cursor",
                                    "Walk native pages with page.next_page(); custom pages may supply fetch_next.")
        page = await _guard("sandbox", lambda: self._page.next_page())
        if page is None:
            return AsyncPaginatedList([])
        return AsyncPaginatedList([self._mapper(one) for one in page.data], page=page, mapper=self._mapper)

    async def auto_paging_iter(self) -> Any:
        page: AsyncPaginatedList = self
        while True:
            for item in page:
                yield item
            if not page.has_more:
                break
            page = await page.next_page()
            if page.is_empty:
                break


async def _paged(fetch: Callable[[], Any], mapper: Callable[[Any], Any], cursor: Optional[str]) -> AsyncPaginatedList:
    if cursor:
        raise NotSupportedError("Starting a list from a saved cursor",
                                "Walk the pages with page.next_page() or page.auto_paging_iter().")
    page = await _guard("sandbox", fetch)
    return AsyncPaginatedList([mapper(one) for one in page.data], page=page, mapper=mapper)


class _Unsupported:
    """A part of Blaxel Runtime has no counterpart for: reading it works;
    calling anything on it raises NotSupportedError naming the alternative."""

    def __init__(self, feature: str, alternative: str) -> None:
        self._refuse = core.unsupported(feature, alternative)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return self._refuse


# ---- processes ----------------------------------------------------------------


class _Output:
    """One process's output read so far, split for Blaxel."""

    def __init__(self) -> None:
        self.cursor = 0
        self.stdout = self.stderr = self.logs = ""
        self.info: Dict[str, Any] = {}

    @property
    def done(self) -> bool:
        return self.info.get("state") not in (None, "running") and self.cursor >= int(self.info.get("outputBytes") or 0)


class AsyncSandboxProcess:
    """``sandbox.process``: Blaxel's processes over Runtime's. A name finds
    its process from any client, while Runtime still holds its record (the
    running ones and the last 16 that ended)."""

    def __init__(self, sandbox: "AsyncSandboxInstance") -> None:
        self._sandbox = sandbox
        self._names: Dict[str, str] = {}
        self._handles: Dict[str, Any] = {}
        self._requests: Dict[str, core.ProcessRequest] = {}
        self._last_info: Dict[str, Dict[str, Any]] = {}

    def _path(self, pid: str, suffix: str = "") -> str:
        return f"/v1/sandboxes/{self._sandbox.withruntime.id}/processes/{pid}{suffix}"

    async def _read(self, pid: str, output: _Output, wait_ms: int = 0) -> List[Dict[str, Any]]:
        """The output after ``output.cursor``, waiting up to ``wait_ms`` for
        some, and the process's record."""
        client = self._sandbox._client
        reply = await _guard("process", lambda: client.request(
            "GET", self._path(pid, "/output"), query={"cursor": output.cursor, "waitMs": wait_ms or None}))
        output.info = reply.get("process") or output.info
        chunks = list(reply.get("chunks") or [])
        for chunk in chunks:
            setattr(output, chunk["stream"], getattr(output, chunk["stream"]) + chunk["text"])
            output.logs += chunk["text"]
        output.cursor = max(output.cursor, int(reply.get("nextCursor") or output.cursor))
        return chunks

    async def _follow(self, pid: str, callbacks: Dict[str, Any], deadline: Optional[float] = None,
                      closed: Callable[[], bool] = lambda: False) -> _Output:
        """Reads the output as it comes, to the callbacks line by line, until
        the process ends, ``deadline`` passes or ``closed()``."""
        output, lines = _Output(), core.Lines()
        while not closed():
            left = None if deadline is None else deadline - now()
            if left is not None and left <= 0:
                break
            chunks = await self._read(pid, output, int(min(8.0, left if left is not None else 8.0) * 1000))
            for chunk in chunks:
                await self._emit(callbacks, chunk["stream"], lines.feed(chunk["stream"], chunk["text"]))
            if output.done:
                for stream in ("stdout", "stderr"):
                    await self._emit(callbacks, stream, lines.flush(stream))
                await self._ended(output.info)
                break
            await self._sandbox._renew()
        return output

    async def _emit(self, callbacks: Dict[str, Any], stream: str, lines: List[str]) -> None:
        for line in lines:
            await call(callbacks.get(f"on_{stream}"), line)
            await call(callbacks.get("on_log"), line)

    async def _ended(self, info: Dict[str, Any]) -> None:
        """A process has ended: when it was a keep_alive one, the sandbox may
        get its idle pause back."""
        if getattr(core.parse_record(str(info.get("command", ""))), "keep_alive", False):
            await self._sandbox._give_back_idle()

    async def _resolve(self, identifier: str) -> str:
        """A Runtime process id from a Blaxel name or pid: this client's own
        first, then Runtime's records (the newest process with the name)."""
        runtime = await self._sandbox._live()
        if identifier in self._names:
            return self._names[identifier]
        if identifier in self._requests:
            return identifier
        records = await _guard("process", lambda: runtime.processes())
        named = [one for one in records
                 if getattr(core.parse_record(str(one.get("command", ""))), "name", None) == identifier]
        if named:
            return max(named, key=lambda one: str(one.get("startedAt") or ""))["id"]
        if any(one["id"] == identifier for one in records):
            return identifier
        raise ResponseError(f"Process {identifier} not found", 404, "process_not_found")

    async def _response(self, pid: str, output: Optional[_Output] = None) -> ProcessResponse:
        """Blaxel's ProcessResponse, with the whole output Runtime keeps."""
        output = output or _Output()
        if not output.info or not output.done:
            while True:
                chunks = await self._read(pid, output)
                if not chunks or output.cursor >= int(output.info.get("outputBytes") or 0):
                    break
        self._last_info[pid] = output.info
        return self._shape(pid, output)

    def _shape(self, pid: str, output: _Output) -> ProcessResponse:
        info = output.info
        parsed = core.parse_record(str(info.get("command", ""))) or core.Record(pid, str(info.get("command", "")))
        request = self._requests.get(pid)
        exit_code = info.get("exitCode")
        return ProcessResponse(
            command=request.command if request is not None else parsed.command,
            completed_at=core.http_date(info.get("endedAt")),
            exit_code=0 if exit_code is None else (-1 if exit_code < 0 else exit_code), logs=output.logs,
            name=parsed.name, pid=pid, started_at=core.http_date(info.get("startedAt")),
            status=core.process_status(str(info.get("state", "")), exit_code), stderr=output.stderr,
            stdout=output.stdout, working_dir=core.working_dir_of(str(info.get("cwd", ""))),
            keep_alive=request.keep_alive if request else None, max_restarts=request.max_restarts if request else None,
            restart_count=core.restarts_in(output.logs), restart_on_failure=request.restart_on_failure if request
            else None, stdin=bool(info.get("stdinOpen")) or (bool(request.stdin) if request else None))

    async def exec(self, process: Any) -> Any:
        """Starts a process. With ``wait_for_completion`` it answers once the
        process ends; past ``timeout`` seconds it raises ResponseError 422 and
        leaves the process running, as Blaxel's API does. With log callbacks
        the output reaches them line by line."""
        request, callbacks = core.request_of(process)
        name = request.name or core.random_name()
        if request.keep_alive:
            limit = core.KEEP_ALIVE_SECONDS if request.timeout is None else int(request.timeout)
            timeout_ms = core.MAX_PROCESS_MS if limit <= 0 else min(core.MAX_PROCESS_MS, limit * 1000)
        else:
            timeout_ms = core.MAX_PROCESS_MS
        env = {str(k): str(v) for k, v in (request.env or {}).items()}
        core.check_env_names(env)
        if env:
            env[core.KEEP] = ":" + ":".join(env) + ":"
        cwd = core.RUNTIME_HOME if not request.working_dir else core.to_runtime_path(request.working_dir)
        line = core.process_line(request.command, name, (0 if request.max_restarts is None else
                                                         int(request.max_restarts)) if request.restart_on_failure
                                 else None, bool(core.LINK_HOME.search(f"{request.command} {' '.join(env.values())}")),
                                 bool(request.keep_alive))
        started = await self._sandbox._resuming(lambda box: box.spawn(
            line, cwd=cwd, env=env or None, stdin="pipe" if request.stdin else None, timeout_ms=timeout_ms))
        if request.keep_alive:
            await self._sandbox._keep_awake(timeout_ms // 1000)
        pid = started.id
        self._names[name] = pid
        self._requests[pid] = request
        self._handles[pid] = started
        limit = int(request.timeout) if request.timeout and request.timeout > 0 else None
        if request.wait_for_ports:
            await self._wait_for_ports(list(request.wait_for_ports), limit or core.PORT_WAIT_SECONDS)
        if request.wait_for_completion:
            output = await self._follow(pid, callbacks, None if limit is None else now() + limit)
            if not output.done:
                raise ResponseError(f"process timed out after {limit} seconds", 422, "process_timeout")
            response = self._shape(pid, output)
            return ProcessResponseWithLog(response, lambda: None) if callbacks else response
        output = _Output()
        output.info = dict(started.info)
        response = self._shape(pid, output)
        if not callbacks:
            return response
        handle = self._stream(pid, callbacks)
        return ProcessResponseWithLog(response, handle.close)

    async def _wait_for_ports(self, ports: List[int], seconds: int) -> None:
        """Checks inside the sandbox, in one request, until every port listens."""
        runtime = await self._sandbox._live()
        result = await _guard("process", lambda: runtime.exec(core.port_wait_script(ports, seconds),
                                                               on_stdout=_whole, timeout_ms=(seconds + 5) * 1000))
        if result.exit_code != 0:
            raise ResponseError(f"process timed out waiting for ports after {seconds} seconds", 422,
                                "ports_not_open")

    def _stream(self, pid: str, callbacks: Dict[str, Any]) -> AsyncStreamHandle:
        state = {"closed": False}

        async def follow() -> None:
            await self._follow(pid, callbacks, closed=lambda: state["closed"])
        task = start(follow)

        def close() -> None:
            state["closed"] = True
            stop(task)

        async def wait(timeout: Any = None) -> None:
            await finish(task, timeout)
        return AsyncStreamHandle(close, wait)

    def stream_logs(self, process_name: str, options: Optional[Dict[str, Any]] = None) -> AsyncStreamHandle:
        """The process's output from its start, line by line, to ``on_log``,
        ``on_stdout`` and ``on_stderr``, until it ends or ``close()``."""
        callbacks = {k: v for k, v in (options or {}).items() if k in ("on_log", "on_stdout", "on_stderr") and v}
        state = {"closed": False}

        async def follow() -> None:
            pid = await self._resolve(process_name)
            await self._follow(pid, callbacks, closed=lambda: state["closed"])
        task = start(follow)

        def close() -> None:
            state["closed"] = True
            stop(task)

        async def wait(timeout: Any = None) -> None:
            await finish(task, timeout)
        return AsyncStreamHandle(close, wait)

    async def get(self, identifier: str, *, retry: bool = True) -> ProcessResponse:
        pid = await self._resolve(identifier)
        response = await self._response(pid)
        if response.status != ProcessResponseStatus.RUNNING:
            await self._ended(self._last_info.get(pid, {}))
        return response

    async def wait(self, identifier: str, max_wait: int = 60000, interval: int = 1000) -> ProcessResponse:
        """Waits for the process to end, at most ``max_wait`` ms (-1: no
        limit); raises TimeoutError, leaving it running, when it does not."""
        if (not isinstance(max_wait, (int, float)) or isinstance(max_wait, bool) or not math.isfinite(max_wait)
                or max_wait < 0 and max_wait != -1 or not isinstance(interval, (int, float))
                or isinstance(interval, bool) or not math.isfinite(interval) or interval <= 0):
            raise ValueError("max_wait must be -1 or finite and non-negative; interval must be finite and positive")
        if max_wait == 0:
            raise TimeoutError(f"Process did not finish in time ({identifier}); it may still be running")
        deadline = None if max_wait == -1 else now() + max_wait / 1000
        with request_scope(None if max_wait == -1 else max_wait / 1000):
            pid = await self._resolve(identifier)
            output = await self._follow(pid, {}, deadline)
            if not output.done:
                raise TimeoutError(f"Process did not finish in time ({identifier}); it may still be running")
            return self._shape(pid, output)

    async def list(self) -> List[ProcessResponse]:
        runtime = await self._sandbox._live()
        records = await _guard("process", lambda: runtime.processes())
        out = []
        # Only Blaxel's processes: not the adapter's own helper commands.
        for record in [one for one in records
                       if one["id"] in self._requests or core.parse_record(str(one.get("command", "")))]:
            output = _Output()
            output.info = record
            out.append(self._shape(record["id"], output))
        return out

    async def _signal(self, identifier: str, signal: str) -> str:
        pid = await self._resolve(identifier)
        client = self._sandbox._client
        await _guard("process", lambda: client.request("POST", self._path(pid, ":signal"), body={"signal": signal}))
        output = _Output()
        await self._read(pid, output, 2000)  # the process's end, seconds at most after its signal
        output.cursor = int(output.info.get("outputBytes") or 0)
        if output.done:
            await self._ended(output.info)
        return pid

    async def stop(self, identifier: str) -> SuccessResponse:
        """SIGTERM to the process and its children."""
        await self._signal(identifier, "SIGTERM")
        return SuccessResponse(message="Process stop requested")

    async def kill(self, identifier: str) -> SuccessResponse:
        """SIGKILL to the process and its children."""
        await self._signal(identifier, "SIGKILL")
        return SuccessResponse(message="Process kill requested")

    async def _handle(self, identifier: str) -> Any:
        pid = await self._resolve(identifier)
        if pid not in self._handles:
            runtime = await self._sandbox._live()
            self._handles[pid] = await _guard("process", lambda: runtime.process(pid))
        return self._handles[pid]

    async def write_stdin(self, identifier: str, data: Union[str, bytes]) -> SuccessResponse:
        """Sends bytes to a process started with ``stdin: True``, as given.
        Offsets make a retried write land once."""
        handle = await self._handle(identifier)
        await _guard("process", lambda: handle.write(data))
        return SuccessResponse(message="Data written to stdin")

    async def close_stdin(self, identifier: str) -> SuccessResponse:
        handle = await self._handle(identifier)
        await _guard("process", lambda: handle.write(b"", eof=True))
        return SuccessResponse(message="Stdin closed")

    async def logs(self, identifier: str, log_type: str = "all") -> str:
        response = await self._response(await self._resolve(identifier))
        if log_type == "all":
            return response.logs
        if log_type in ("stdout", "stderr"):
            return getattr(response, log_type)
        raise Exception("Unsupported log type")


# ---- files ----------------------------------------------------------------------


class AsyncSandboxFileSystem:
    """``sandbox.fs``: Blaxel's file calls over Runtime's files API. /blaxel,
    Blaxel's working directory, is /workspace, and relative paths start there.
    Calls act as the sandbox user and, where only root may (Blaxel's run as
    root, and so do its processes here), through sudo."""

    def __init__(self, sandbox: "AsyncSandboxInstance", process: AsyncSandboxProcess) -> None:
        self._sandbox = sandbox
        self.process = process

    async def _files(self) -> Any:
        return (await self._sandbox._live()).files

    async def _run(self, argv: List[str], cwd: Optional[str] = None, timeout_ms: int = 600_000) -> Any:
        """A helper command's result with its whole output: streamed, so no
        64 KiB cut, in one request."""
        runtime = await self._sandbox._live()
        return await _guard("file", lambda: runtime.exec(argv, cwd=cwd, on_stdout=_whole, timeout_ms=timeout_ms))

    async def _sudo(self, script: str, args: List[str], failure: str) -> None:
        runtime = await self._sandbox._live()
        result = await _guard("file", lambda: runtime.exec(["sudo", "sh", "-c", script, "sh", *args]))
        if result.exit_code != 0:
            raise ResponseError(f"{failure}: {result.stderr.strip() or f'exit {result.exit_code}'}", 422,
                                "permission_denied")

    async def _write_bytes(self, target: str, data: bytes) -> None:
        """Writes bytes anywhere, as Blaxel's root sandbox API can: outside
        /workspace, a path the sandbox user may not write, one whose directory
        is missing, or a file over 1 MiB goes through /workspace and is moved
        into place with sudo, so the file is then the sandbox user's."""
        in_workspace = target == core.RUNTIME_HOME or target.startswith(core.RUNTIME_HOME + "/")
        files = await self._files()
        if in_workspace or len(data) <= core.SMALL:
            try:
                await files.write(target, data)
                return
            except Exception as error:  # noqa: BLE001
                # The files API acts as the sandbox user: it cannot write where
                # only root may (a directory a root process made, even in
                # /workspace), nor, outside /workspace, make a missing parent.
                code = getattr(error, "code", None)
                if code != "permission_denied" and (in_workspace or code != "file_not_found"):
                    raise translate(error, "file") from error
        staging = f"{core.RUNTIME_HOME}/.runtime-blaxel-{uuid.uuid4()}"
        try:
            await _guard("file", lambda: files.write(staging, data))
            await self._sudo('mkdir -p "$(dirname "$2")" && mv -f "$1" "$2"', [staging, target],
                             f"error writing file {target}")
        except BaseException:
            await self._unstage(staging)
            raise

    async def _stage(self, target: str) -> str:
        """A copy of a file only root may read, owned by the sandbox user."""
        staging = f"/tmp/.runtime-blaxel-{uuid.uuid4()}"
        await self._sudo('install -m 0600 -o "$SUDO_UID" -g "$SUDO_GID" -- "$1" "$2"', [target, staging],
                         f"error reading file {target}")
        return staging

    async def _unstage(self, staging: str) -> None:
        try:
            await (await self._files()).remove(staging)
        except Exception:  # noqa: BLE001 - /tmp is cleared with the sandbox anyway
            pass

    async def _read_bytes(self, target: str) -> bytes:
        """A file's bytes; one only root may read (a root process made it
        private) is copied with sudo, read, and the copy removed."""
        files = await self._files()
        try:
            return bytes(await files.read(target))
        except Exception as error:  # noqa: BLE001
            if getattr(error, "code", None) != "permission_denied":
                raise translate(error, "file") from error
        staging = await self._stage(target)
        try:
            return bytes(await _guard("file", lambda: files.read(staging)))
        finally:
            await self._unstage(staging)

    async def mkdir(self, path: str, permissions: str = "0755") -> SuccessResponse:
        target = core.to_runtime_path(path)
        if not re.fullmatch(r"[0-7]{3,4}", permissions):
            raise ResponseError(f"invalid permissions format '{permissions}'", 422, "invalid_request")
        files = await self._files()
        try:
            await files.mkdir(target, parents=True)
            if int(permissions, 8) != 0o755:
                result = await self._run(["chmod", permissions, "--", target])
                if result.exit_code != 0:
                    raise ResponseError(result.stderr.strip(), 403, "permission_denied")
        except Exception as error:  # noqa: BLE001
            if getattr(error, "code", None) != "permission_denied":
                raise translate(error, "file") from error
            await self._sudo('mkdir -p -m "$1" -- "$2" && chown "$SUDO_UID:$SUDO_GID" -- "$2"',
                             [permissions, target], "error creating directory")
        return SuccessResponse(message="Directory created successfully", path=path)

    async def write(self, path: str, content: str) -> SuccessResponse:
        await self._write_bytes(core.to_runtime_path(path), content.encode("utf-8"))
        return SuccessResponse(message="File created successfully", path=path)

    async def write_binary(self, path: str, content: Union[bytes, bytearray, str]) -> SuccessResponse:
        """Bytes, or the path of a local file to copy."""
        data = Path(content).read_bytes() if isinstance(content, str) else bytes(content)
        await self._write_bytes(core.to_runtime_path(path), data)
        return SuccessResponse(message="File created successfully", path=path)

    async def write_tree(self, files: List[Any], destination_path: Optional[str] = None) -> Directory:
        """Writes each file under ``destination_path`` (the working directory
        when left out) and answers that directory."""
        base = destination_path or core.HOME
        for one in files:
            item = core.SandboxFilesystemFile.from_dict(one) if isinstance(one, dict) else one
            await self._write_bytes(core.to_runtime_path(item.path, core.to_runtime_path(base)),
                                    item.content.encode("utf-8"))
        return await self.ls(base)

    async def read(self, path: str) -> str:
        data = await self.read_binary(path)
        return data.decode("utf-8")

    async def read_binary(self, path: str) -> bytes:
        return await self._read_bytes(core.to_runtime_path(path))

    async def download(self, src: str, destination_path: str, mode: int = 0o644) -> None:
        """Streams the file to ``destination_path``, any size, checked
        against its length."""
        target = core.to_runtime_path(src)
        files = await self._files()
        try:
            await files.download(target, destination_path)
        except Exception as error:  # noqa: BLE001
            if getattr(error, "code", None) != "permission_denied":
                raise translate(error, "file") from error
            staging = await self._stage(target)
            try:
                await _guard("file", lambda: files.download(staging, destination_path))
            finally:
                await self._unstage(staging)
        os.chmod(destination_path, mode)

    async def rm(self, path: str, recursive: bool = False) -> SuccessResponse:
        """Removes a file, or a directory (its contents too with ``recursive``),
        as the sandbox user and, where only root may, with sudo."""
        runtime = await self._sandbox._live()
        result = await _guard("file", lambda: runtime.exec(
            ["bash", "-c", core.RM, "rm", core.to_runtime_path(path), "1" if recursive else "0"]))
        if result.exit_code == 2:
            raise ResponseError("file or directory not found", 404, "file_not_found")
        if result.exit_code == 4:
            raise ResponseError("error deleting directory: directory not empty", 422, "directory_not_empty")
        if result.exit_code != 0:
            raise ResponseError(f"error deleting {path}: {result.stderr.strip()}", 422, "delete_failed")
        return SuccessResponse(message=f"{result.stdout.strip()} deleted successfully", path=path)

    async def ls(self, path: str) -> Directory:
        target = core.to_runtime_path(path)
        files = await self._files()
        found = await _guard("file", lambda: files.stat(target))
        if found.get("type") != "directory":
            raise ResponseError("Directory not found", 404, "not_a_directory")
        entries = await _guard("file", lambda: files.list(target, depth=1, hidden=True))
        out = Directory(name=Path(path).name or "/", path=path)
        for entry in entries:
            shown = core.as_asked(str(entry.get("path") or f"{target.rstrip('/')}/{entry.get('name')}"), path, target)
            if entry.get("type") == "directory":
                out.subdirectories.append(Subdirectory(name=str(entry.get("name", "")), path=shown))
            else:
                out.files.append(core.file_of(entry, shown))
        return out

    async def find(self, path: str, type: Optional[str] = None, patterns: Optional[List[str]] = None,  # noqa: A002
                   max_results: Optional[int] = None, exclude_dirs: Optional[List[str]] = None,
                   exclude_hidden: Optional[bool] = None) -> FindResponse:
        """Files and directories under ``path``, relative to it."""
        target = core.to_runtime_path(path)
        prune = [*(exclude_dirs or []), *([".*"] if exclude_hidden else [])]
        argv = ["find", target, "-mindepth", "1"]
        if prune:
            argv += ["(", "-type", "d", "("]
            for index, name in enumerate(prune):
                argv += (["-o"] if index else []) + ["-name", name]
            argv += [")", "-prune", ")", "-o"]
        if type in ("file", "directory"):
            argv += ["-type", "f" if type == "file" else "d"]
        if exclude_hidden:
            argv += ["-not", "-name", ".*"]
        if patterns:
            argv += ["("]
            for index, pattern in enumerate(patterns):
                argv += (["-o"] if index else []) + ["-name", pattern]
            argv += [")"]
        argv += ["-printf", "%y %P\\n"]
        result = await self._run(argv)
        if result.exit_code != 0 and not result.stdout:
            raise ResponseError(result.stderr.strip() or f"{path} not found", 404, "file_not_found")
        matches = [FindMatch(path=line[2:], type_="directory" if line[0] == "d" else "file")
                   for line in result.stdout.splitlines() if len(line) > 2]
        if max_results is not None:
            matches = matches[:max_results]
        return FindResponse(matches=matches, total=len(matches))

    async def grep(self, query: str, path: str = "/", case_sensitive: Optional[bool] = None,
                   context_lines: Optional[int] = None, max_results: Optional[int] = None,
                   file_pattern: Optional[str] = None, exclude_dirs: Optional[List[str]] = None) -> ContentSearchResponse:
        """Lines matching ``query`` (a regular expression, case-insensitive
        unless asked) in the files under ``path``, at most ``max_results``
        (100); paths relative to ``path``."""
        target = core.to_runtime_path(path)
        limit = 100 if max_results is None else max_results
        argv = ["grep", "-rnIEs", *([] if case_sensitive else ["-i"])]
        argv += [f"--include={file_pattern}"] if file_pattern else []
        argv += [f"--exclude-dir={name}" for name in exclude_dirs or []]
        argv += ["--", query, "."]
        result = await self._run(argv, target)
        if result.exit_code not in (0, 1) and not result.stdout:
            raise ResponseError(result.stderr.strip() or "grep failed", 400, "search_failed")
        matches = core.grep_matches(result.stdout.replace("\n./", "\n").removeprefix("./"), query,
                                    bool(case_sensitive))[:limit]
        if context_lines:
            await self._context(target, matches, int(context_lines))
        return ContentSearchResponse(matches=matches, query=query, total=len(matches))

    async def _context(self, target: str, matches: List[Any], lines: int) -> None:
        api = await self._files()
        texts: Dict[str, List[str]] = {}
        for match in matches:
            if match.path not in texts:
                data = await _guard("file", lambda: api.read(f"{target.rstrip('/')}/{match.path}"))
                texts[match.path] = bytes(data).decode("utf-8", "replace").split("\n")
            every = texts[match.path]
            match.context = "\n".join(every[max(0, match.line - 1 - lines):match.line + lines])

    async def cp(self, source: str, destination: str, max_wait: int = 180000) -> CopyResponse:
        result = await self._run(["sh", "-c", 'cp -r -- "$1" "$2" 2>/dev/null || sudo cp -r -- "$1" "$2"', "cp",
                                  core.to_runtime_path(source), core.to_runtime_path(destination)],
                                 timeout_ms=max(1000, int(max_wait)))
        if result.timed_out or result.exit_code != 0:
            raise Exception(f"Could not copy {source} to {destination} cause: {result.stderr.strip()}")
        return CopyResponse(message="Files copied", source=source, destination=destination)

    def watch(self, path: str, callback: Callable[[WatchEvent], Any],
              options: Optional[Dict[str, Any]] = None) -> AsyncWatchHandle:
        """Calls ``callback`` with each change under ``path`` (with "/**",
        its subdirectories too) until ``close()``. ``with_content`` reads each
        created or written file; ``ignore`` skips paths; ``on_error`` hears
        failures."""
        options = options or {}
        recursive = path.endswith("/**")
        asked = path[:-3] or "/" if recursive else path
        target = core.to_runtime_path(asked)
        state: Dict[str, Any] = {"closed": False, "watch": None}
        ignore = [core.to_runtime_path(one) for one in options.get("ignore") or []]

        async def follow() -> None:
            runtime = await self._sandbox._live()
            state["watch"] = watch = await _guard("file", lambda: runtime.files.watch(target, recursive=recursive))
            while not state["closed"]:
                try:
                    events = await _guard("file", lambda: watch.get_new_events(wait_ms=8000))
                except Exception as error:  # noqa: BLE001 - to on_error, as Blaxel does
                    if options.get("on_error"):
                        options["on_error"](error)
                    return
                for event in events:
                    full = str(event.get("path", ""))
                    if state["closed"] or any(full == one or full.startswith(one + "/") for one in ignore):
                        continue
                    shown = core.as_asked(full, asked, target)
                    folder, _, name = shown.rpartition("/")
                    change = WatchEvent(op=core.watch_op(str(event.get("type", ""))), path=folder or "/", name=name)
                    if options.get("with_content") and change.op in ("CREATE", "WRITE"):
                        try:
                            change.content = (await self._read_bytes(full)).decode("utf-8", "replace")
                        except Exception:  # noqa: BLE001 - as Blaxel: no content when it cannot be read
                            change.content = None
                    await call(callback, change)
                if watch.exit_reason not in (None, "paused"):
                    return
        task = start(follow)

        def close() -> None:
            state["closed"] = True
            stop(task)
        return AsyncWatchHandle(close)

    def format_path(self, path: str) -> str:
        return path


def _whole(_text: str) -> None:
    """Given to exec as an output callback so it streams and returns the whole
    output: an exec with no callback returns at most 64 KiB of each stream."""


# ---- previews -----------------------------------------------------------------------


class AsyncSandboxPreviewToken:
    """A token for a private preview: ``value``, and ``expires_at``. Send it
    as the ``x-runtime-preview-token`` header, or as ``runtime_preview_token``
    in the address (Blaxel's X-Blaxel-Preview-Token and bl_preview_token are
    not read)."""

    def __init__(self, preview_token: PreviewToken) -> None:
        self.preview_token = preview_token

    @property
    def value(self) -> str:
        return (self.preview_token.spec.token if self.preview_token.spec else "") or ""

    @property
    def expires_at(self) -> Any:
        return preview_token_expiration(self.preview_token)


class AsyncSandboxPreviewTokens:
    def __init__(self, preview: "AsyncSandboxPreview") -> None:
        self._preview = preview

    @property
    def preview_name(self) -> str:
        return self._preview.name

    @property
    def resource_name(self) -> str:
        return self._preview._sandbox.metadata.name

    async def create(self, expires_at: datetime) -> AsyncSandboxPreviewToken:
        """A token capped by an aware deadline, one minute to seven days away."""
        if not isinstance(expires_at, datetime) or expires_at.utcoffset() is None:
            raise ValueError("A preview token needs a valid expiration date with a timezone.")
        target = expires_at.astimezone(timezone.utc)
        seconds = target.timestamp() - time.time()
        if not math.isfinite(seconds) or seconds < 60 or seconds > 7 * 86_400:
            raise ValueError("expires_at must be one minute to seven days from now.")
        deadline = target.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        runtime = await self._preview._sandbox._live()
        got = await _guard("sandbox", lambda: runtime.previews.get(self._preview.spec.port, expires_at=deadline))
        if not got.get("token"):
            raise SandboxAPIError(f"Preview {self.preview_name} returned no private token.", 400, "public_preview")
        returned = got.get("tokenExpiresAt")
        try:
            actual = datetime.fromisoformat(returned.replace("Z", "+00:00"))
            valid = actual.utcoffset() is not None and actual <= target
        except (AttributeError, TypeError, ValueError, OverflowError):
            valid = False
        if not valid:
            raise SandboxAPIError("The preview returned an invalid or extended token expiration.",
                                  502, "invalid_preview_token")
        return AsyncSandboxPreviewToken(PreviewToken(
            metadata=PreviewTokenMetadata(name=f"token-{uuid.uuid4().hex[:8]}", preview_name=self.preview_name,
                                          resource_name=self.resource_name, resource_type="sandbox"),
            spec=PreviewTokenSpec(token=got["token"], expires_at=returned, expired=False)))

    list = staticmethod(core.unsupported(
        "Listing a preview's tokens", "Runtime keeps no list of tokens: keep the ones you create."))
    delete = staticmethod(core.unsupported(
        "Deleting one preview token", "Refuse every token issued so far with "
        "sandbox.withruntime.previews.rotate(port), then create new ones."))


class AsyncSandboxPreview:
    """A preview: ``spec.url``, ``spec.public``, ``spec.port`` and ``tokens``."""

    def __init__(self, preview: Preview, sandbox: "AsyncSandboxInstance") -> None:
        self.preview = preview
        self._sandbox = sandbox
        self.tokens = AsyncSandboxPreviewTokens(self)

    @property
    def name(self) -> str:
        return self.preview.metadata.name if self.preview.metadata else ""

    @property
    def metadata(self) -> Any:
        return self.preview.metadata

    @property
    def spec(self) -> Any:
        return self.preview.spec


_PREVIEW_REFUSED = {
    "response_headers": "Send these headers from the server in the sandbox.",
    "request_headers": "Read the request as it arrives in the sandbox; Runtime adds no headers.",
    "custom_domain": "Serve a custom domain with Runtime domains (runtime.domains) pointing at the sandbox.",
    "prefix_url": "Serve the app at the preview's root.",
    "ttl": "Delete the preview with sandbox.previews.delete(name) when it is done.",
    "expires": "Delete the preview with sandbox.previews.delete(name) when it is done.",
}


class AsyncSandboxPreviews:
    """``sandbox.previews``: a Runtime preview for each port. A private one
    needs a token; a public one (paid sandboxes) needs nothing. Names are kept
    in the sandbox's labels, so any client finds them."""

    def __init__(self, sandbox: "AsyncSandboxInstance") -> None:
        self._sandbox = sandbox

    @property
    def sandbox_name(self) -> str:
        return self._sandbox.metadata.name

    def _names(self) -> Dict[int, str]:
        labels = self._sandbox.withruntime.info.get("labels") or {}
        prefix = core.LABEL + "preview."
        return {int(value): key[len(prefix):] for key, value in labels.items()
                if key.startswith(prefix) and str(value).isdigit()}

    def _model(self, reply: Dict[str, Any], name: str) -> AsyncSandboxPreview:
        return AsyncSandboxPreview(Preview(
            metadata=PreviewMetadata(name=name, resource_name=self.sandbox_name, resource_type="sandbox"),
            spec=PreviewSpec(port=int(reply.get("port") or 0), public=reply.get("visibility") == "public",
                             url=str(reply.get("url", "")).rstrip("/")),
            status="DEPLOYED"), self._sandbox)

    async def list(self) -> List[AsyncSandboxPreview]:
        runtime = await self._sandbox._live()
        names = self._names()
        return [self._model(one, names.get(int(one["port"]), f"port-{one['port']}"))
                for one in await _guard("sandbox", lambda: runtime.previews.list())]

    async def create(self, preview: Any) -> AsyncSandboxPreview:
        """Shares ``spec.port``: private unless ``spec.public``."""
        model = Preview.from_dict(preview) if isinstance(preview, dict) else preview
        spec = model.spec or PreviewSpec()
        for field_name, alternative in _PREVIEW_REFUSED.items():
            if getattr(spec, field_name):
                raise NotSupportedError(f"Preview {field_name}", alternative)
        if not spec.port:
            raise ValueError("A preview needs spec.port.")
        name = (model.metadata.name if model.metadata else "") or f"port-{spec.port}"
        runtime = await self._sandbox._live()
        reply = await _guard("sandbox", lambda: runtime.previews.create(
            int(spec.port), visibility="public" if spec.public else "private"))
        if self._names().get(int(spec.port)) != name:
            await self._sandbox._label({f"preview.{name}": str(int(spec.port))})
        return self._model(reply, name)

    async def create_if_not_exists(self, preview: Any) -> AsyncSandboxPreview:
        model = Preview.from_dict(preview) if isinstance(preview, dict) else preview
        name = (model.metadata.name if model.metadata else "") or f"port-{(model.spec or PreviewSpec()).port}"
        try:
            return await self.get(name)
        except SandboxAPIError as error:
            if error.status_code != 404:
                raise
        return await self.create(model)

    async def _port(self, preview_name: str) -> int:
        for port, name in self._names().items():
            if name == preview_name:
                return port
        if preview_name.startswith("port-") and preview_name[5:].isdigit():
            return int(preview_name[5:])
        raise SandboxAPIError(f"Preview {preview_name} not found", 404, "not_found")

    async def get(self, preview_name: str) -> AsyncSandboxPreview:
        port = await self._port(preview_name)
        runtime = await self._sandbox._live()
        return self._model(await _guard("sandbox", lambda: runtime.previews.get(port)), preview_name)

    async def delete(self, preview_name: str) -> Preview:
        port = await self._port(preview_name)
        runtime = await self._sandbox._live()
        found = await self.get(preview_name)
        await _guard("sandbox", lambda: runtime.previews.delete(port))
        await self._sandbox._label({f"preview.{preview_name}": None})
        found.preview.status = "DELETED"
        return found.preview


# ---- snapshots -----------------------------------------------------------------------


def _snapshot_model(info: Dict[str, Any], sandbox_name: Optional[str] = None) -> SandboxSnapshot:
    state = str(info.get("state", "ready"))
    return SandboxSnapshot(
        created_at=str(info.get("createdAt", "")), id=str(info["id"]), name=str(info.get("name") or info["id"]),
        status={"ready": "ready", "failed": "failed"}.get(state, "pending"), workspace="",
        sandbox_name=sandbox_name, source=SandboxSnapshotSource(name=sandbox_name or str(info.get("sourceSandboxId",
                                                                                                  "")), kind="sandbox"),
        spec=SandboxSnapshotSpec(memory=info.get("memoryMiB"), region=core.REGION))


class _Deleting:
    """Blaxel's ``Class.delete(name)`` and ``instance.delete()`` in one."""

    def __init__(self, by_name: Callable[[str], Any], on_instance: Callable[[Any], Any]) -> None:
        self._by_name, self._on_instance = by_name, on_instance

    def __get__(self, instance: Any, owner: Any) -> Any:
        if instance is None:
            return self._by_name
        return lambda: self._on_instance(instance)


class AsyncSnapshot:
    """A workspace snapshot: a Runtime snapshot of a sandbox's files,
    memory and running processes."""

    def __init__(self, snapshot: SandboxSnapshot) -> None:
        self.snapshot = snapshot

    @property
    def name(self) -> str:
        return self.snapshot.name

    @property
    def id(self) -> str:
        return self.snapshot.id

    @property
    def status(self) -> str:
        return self.snapshot.status

    @property
    def workspace(self) -> str:
        return self.snapshot.workspace

    @property
    def created_at(self) -> str:
        return self.snapshot.created_at

    @property
    def source(self) -> Any:
        return self.snapshot.source

    @property
    def spec(self) -> Any:
        return self.snapshot.spec

    @classmethod
    async def create(cls, config: Any) -> "AsyncSnapshot":
        """``{"source": {"name": sandbox}, "name": ...}``."""
        request = core.SandboxSnapshotRequest.from_dict(config) if isinstance(config, dict) else config
        source = request.source.name if request and request.source else ""
        if not source:
            raise ValueError("Snapshot source requires a name")
        box = await AsyncSandboxInstance.get(source)
        return await box.snapshots.create(request.name)

    @classmethod
    async def get(cls, snapshot_id: str) -> "AsyncSnapshot":
        client = _client()
        return cls(_snapshot_model(await _guard("snapshot", lambda: client.snapshots.get(snapshot_id))))

    @classmethod
    async def list(cls, limit: int = 50, cursor: Optional[str] = None) -> AsyncPaginatedList:
        client = _client()
        return await _paged(lambda: client.snapshots.list(limit=limit), lambda info: cls(_snapshot_model(info)),
                            cursor)

    async def fork(self, target_name: str, target_type: str = "sandbox", port: Optional[int] = None,
                   traffic: Optional[int] = None, custom_domain: Optional[str] = None, prefix: Optional[str] = None,
                   envs: Optional[List[Any]] = None) -> SandboxForkResponse:
        """A new sandbox, running as the snapshot was."""
        core.check_fork(target_type, port, traffic, custom_domain, prefix)
        runtime = await _name_free(_client(), lambda: _client().sandboxes.create(
            snapshot=self.id, name=target_name, **core.STANDBY), "snapshot")
        await AsyncSandboxInstance._inherit(runtime, core.envs_of(envs), core.KEEP_DAYS, None)
        return SandboxForkResponse(name=target_name, snapshot_id=self.id, type_="sandbox")


async def _delete_snapshot(snapshot_id: str) -> None:
    client = _client()
    await _guard("snapshot", lambda: client.snapshots.delete(snapshot_id))


AsyncSnapshot.delete = _Deleting(_delete_snapshot, lambda snapshot: _delete_snapshot(snapshot.id))  # type: ignore[attr-defined]


class AsyncSandboxSnapshots:
    """``sandbox.snapshots``: Runtime snapshots of this sandbox. A running
    sandbox pauses for the moment a snapshot takes, then carries on."""

    def __init__(self, sandbox: "AsyncSandboxInstance") -> None:
        self._sandbox = sandbox

    async def create(self, name: Optional[str] = None) -> AsyncSnapshot:
        runtime = await self._sandbox._live()
        info = await _guard("sandbox", lambda: runtime.snapshot(name=name))
        return AsyncSnapshot(_snapshot_model(info, self._sandbox.metadata.name))

    async def list(self) -> List[AsyncSnapshot]:
        client, runtime = self._sandbox._client, self._sandbox.withruntime
        page = await _guard("sandbox", lambda: client.snapshots.list(sandbox_id=runtime.id))
        return [AsyncSnapshot(_snapshot_model(info, self._sandbox.metadata.name)) for info in await page.to_list()]

    async def get(self, snapshot_name: str) -> AsyncSnapshot:
        for snapshot in await self.list():
            if snapshot.name == snapshot_name or snapshot.id == snapshot_name:
                return snapshot
        raise ValueError(f"Snapshot {snapshot_name} not found on sandbox {self._sandbox.metadata.name}")

    async def delete(self, snapshot_name: str) -> None:
        found = await self.get(snapshot_name)
        client = self._sandbox._client
        await _guard("sandbox", lambda: client.snapshots.delete(found.id))

    restore = staticmethod(core.unsupported(*core.RESTORE))


# ---- the sandbox ---------------------------------------------------------------------


class _Calling:
    """Blaxel's ``SandboxInstance.op("name")`` and ``instance.op()`` for
    archive and unarchive."""

    def __init__(self, verb: str) -> None:
        self._verb = verb

    def __get__(self, instance: Any, owner: Any) -> Any:
        verb = self._verb
        if instance is None:
            async def by_name(sandbox_name: str, *, wait: bool = True, max_wait: int = 0, interval: int = 0) -> Any:
                box = await owner.get(sandbox_name)
                return await getattr(box, f"_{verb}")(wait)
            return by_name

        async def on_instance(*, wait: bool = True, max_wait: int = 0, interval: int = 0) -> Any:
            return await getattr(instance, f"_{verb}")(wait)
        return on_instance


class AsyncSandboxSessions:
    """Blaxel's ``sandbox.sessions`` over Runtime's sandbox sessions: a token a
    frontend holds to run commands, use files and reach previews of this one
    sandbox directly."""

    # The session create_if_expired made last, per sandbox, in this process: a
    # token is shown only when its session is made.
    _made: Dict[str, core.SessionWithToken] = {}

    def __init__(self, sandbox: "AsyncSandboxInstance") -> None:
        self._sandbox = sandbox

    async def _runtime(self) -> Any:
        return await self._sandbox._live()

    def _api_url(self, runtime: Any) -> str:
        return runtime._t.base_url

    async def create(self, options: Any = None) -> core.SessionWithToken:
        """A new session, for a day unless ``expires_at`` says sooner."""
        seconds, origins = core.session_options(options)
        runtime = await self._runtime()
        made = await _guard("sandbox", lambda: runtime.sessions.create(ttl_seconds=seconds, origins=origins))
        return core.session_with_token(made, made.get("apiUrl") or self._api_url(runtime))

    async def create_if_expired(self, options: Any = None, delta_seconds: int = 3600) -> core.SessionWithToken:
        """The session made last in this process, if it lasts ``delta_seconds``
        more; else a new one, and the old one ends."""
        runtime = await self._runtime()
        kept = AsyncSandboxSessions._made.get(runtime.id)
        if kept is not None:
            live = any(one.name == kept.name for one in await self.list())
            left = (kept.expires_at - datetime.now(timezone.utc)).total_seconds()
            if live and left >= delta_seconds:
                return kept
            if live:
                try:
                    await self.delete(kept.name)
                except Exception:  # noqa: BLE001 - it expires by itself
                    pass
        fresh = await self.create(options)
        AsyncSandboxSessions._made[runtime.id] = fresh
        return fresh

    async def list(self) -> List[core.SessionWithToken]:
        """Active sessions, newest first, each with an empty token: a token is
        shown only when its session is made."""
        runtime = await self._runtime()
        found = await _guard("sandbox", lambda: runtime.sessions.list())
        return [core.session_with_token(one, self._api_url(runtime)) for one in found if one.get("state") == "active"]

    async def get(self, name: str) -> Dict[str, Any]:
        runtime = await self._runtime()
        wanted = core.session_id(name)
        for one in await _guard("sandbox", lambda: runtime.sessions.list()):
            if one.get("id") == wanted:
                found = core.session_with_token(one, self._api_url(runtime))
                return {"url": found.url, "token": found.token, "expires_at": found.expires_at}
        raise SandboxAPIError(f"Session '{name}' not found", 404, "not_found")

    async def delete(self, name: str) -> core.SessionWithToken:
        """Ends the session at once."""
        runtime = await self._runtime()
        ended = await _guard("sandbox", lambda: runtime.sessions.revoke(core.session_id(name)))
        return core.session_with_token(ended, self._api_url(runtime))


class AsyncSandboxInstance:
    """A Blaxel sandbox on Runtime. ``sandbox.withruntime`` is the Runtime
    sandbox underneath, for anything Blaxel has no name for.

    Standby is Runtime's pause: a sandbox pauses after a minute with no call
    (Blaxel: about 15 seconds), keeps its memory and processes, and wakes by
    itself on the next command, file call or preview visit."""

    def __init__(self, sandbox: Any = None, force_url: Optional[str] = None, headers: Optional[Dict[str, str]] = None,
                 params: Optional[Dict[str, str]] = None, *, _runtime: Any = None, _envs: Any = None) -> None:
        if force_url is not None:
            raise NotSupportedError("force_url", "Remove it: the adapter reaches the sandbox through Runtime's API.")
        self.withruntime = _runtime
        self._client = _client()
        self._env_cache: Optional[Dict[str, str]] = _envs
        self._deleted = False
        self.sandbox: Sandbox = sandbox if isinstance(sandbox, Sandbox) else (
            core.sandbox_model(_runtime.info) if _runtime is not None else Sandbox.from_dict(sandbox or {}))
        self.process = AsyncSandboxProcess(self)
        self.fs = AsyncSandboxFileSystem(self, self.process)
        self.previews = AsyncSandboxPreviews(self)
        self.snapshots = AsyncSandboxSnapshots(self)
        self.network = _Network(self)
        self.sessions = AsyncSandboxSessions(self)
        self.codegen = _Unsupported("Blaxel codegen (fast apply and reranking)",
                                    "Edit files with sandbox.fs.read and sandbox.fs.write, or run your own model.")
        self.system = _Unsupported("Blaxel's sandbox-api system calls",
                                   "Runtime updates the in-sandbox agent itself; nothing to upgrade.")
        self.drives = _Unsupported(*core.VOLUMES)
        self.schedules = _Unsupported("Sandbox schedules",
                                      "A Runtime job runs a command on a cron schedule or at a time in a fresh "
                                      "sandbox each run: Runtime().jobs.create(name, cron=..., command=[...]). "
                                      "To run inside this sandbox, call sandbox.process.exec from your own "
                                      "scheduler; a paused sandbox wakes on it.")

    # ---- Blaxel's fields ------------------------------------------------------

    @property
    def metadata(self) -> Any:
        return self.sandbox.metadata

    @property
    def status(self) -> Any:
        return self.sandbox.status

    @property
    def state(self) -> Any:
        return self.sandbox.state

    @property
    def spec(self) -> Any:
        return self.sandbox.spec

    @property
    def events(self) -> Any:
        return self.sandbox.events

    @property
    def errors(self) -> List[Any]:
        return list(self.sandbox.errors or [])

    @property
    def last_used_at(self) -> Any:
        return self.sandbox.last_used_at

    @property
    def expires_in(self) -> Any:
        return self.sandbox.expires_in

    @property
    def config(self) -> core.SandboxConfiguration:
        return core.SandboxConfiguration(self.sandbox)

    def _refresh_model(self) -> None:
        self.sandbox = core.sandbox_model(self.withruntime.info, self._env_cache, self._deleted)

    # ---- plumbing --------------------------------------------------------------

    async def _live(self) -> Any:
        if self._deleted:
            raise SandboxAPIError(f"Sandbox '{self.metadata.name}' was deleted", 404, "not_found")
        if self.withruntime is None:
            self.withruntime = await _find(self._client, self.metadata.name)
        return self.withruntime

    async def _resuming(self, work: Callable[[Any], Any]) -> Any:
        """Runs ``work``; when the sandbox was paused under it and does not
        wake by itself, wakes it and runs ``work`` once more. The call was
        refused, not run, so it runs once."""
        runtime = await self._live()
        try:
            return await work(runtime)
        except Exception as error:  # noqa: BLE001
            if getattr(error, "code", None) != "sandbox_paused":
                raise translate(error, "process") from error
            await _guard("sandbox", lambda: runtime.wake())
            return await _guard("process", lambda: work(runtime))

    async def _envs(self) -> Dict[str, str]:
        """The sandbox's envs, which every process sources itself; read once,
        for the code interpreter's contexts."""
        if self._env_cache is None:
            runtime = await self._live()
            try:
                self._env_cache = core.parse_env_file(bytes(await runtime.files.read(core.ENV_FILE)).decode())
            except Exception as error:  # noqa: BLE001
                if getattr(error, "code", None) != "file_not_found":
                    raise translate(error, "process") from error
                self._env_cache = {}
        return self._env_cache

    async def _label(self, changes: Dict[str, Optional[str]]) -> None:
        """Sets (or with None removes) the adapter's own labels."""
        runtime = await self._live()
        labels = dict(runtime.info.get("labels") or {})
        for key, value in changes.items():
            if value is None:
                labels.pop(core.LABEL + key, None)
            else:
                labels[core.LABEL + key] = value
        await _guard("sandbox", lambda: runtime.update(labels=labels))
        self._refresh_model()

    async def _keep_awake(self, seconds: int) -> None:
        """Keeps the sandbox out of standby while a keep_alive process runs:
        its idle pause becomes the process's time limit (off for one without),
        and its lease covers that time, up to Runtime's hour."""
        runtime = await self._live()
        forever = seconds * 1000 >= core.MAX_PROCESS_MS
        idle = 0 if forever else max(core.IDLE_PAUSE_SECONDS, seconds)
        current = runtime.info.get("idlePauseSeconds")
        if current != 0 and (idle == 0 or current is None or idle > current):
            labels = dict(runtime.info.get("labels") or {})
            labels.setdefault(core.LABEL + core.IDLE_LABEL, str(current or 0))
            await _guard("sandbox", lambda: runtime.update(idle_pause_seconds=idle, labels=labels))
        await self._renew(core.LEASE_SECONDS if forever else min(core.LEASE_SECONDS, seconds))

    async def _give_back_idle(self) -> None:
        """Gives the sandbox the idle pause a keep_alive process raised it from,
        once no keep_alive process runs, so no idle time is paid for after. A
        failure here never fails the caller's call: the label stays, and the
        next client call that looks gives the pause back."""
        runtime = self.withruntime
        labels = dict(runtime.info.get("labels") or {})
        saved = labels.pop(core.LABEL + core.IDLE_LABEL, None)
        if saved is None:
            return
        try:
            records = await runtime.processes()
            if any(one.get("state") == "running" and getattr(core.parse_record(str(one.get("command", ""))),
                                                             "keep_alive", False) for one in records):
                return
            await runtime.update(idle_pause_seconds=int(saved), labels=labels)
        except Exception:  # noqa: BLE001 - the caller's answer stands; the next look retries
            return

    async def _renew(self, want: Optional[int] = None) -> None:
        """Moves a pausing lease on: to ``want`` seconds ahead, or, with none,
        to an hour ahead once less than ten minutes are left, so a sandbox in
        use is not paused under its work. A refusal means the lease had moved
        on already (a wake renews it); the sandbox is read again."""
        runtime = self.withruntime
        if runtime is None or runtime.state != "running" or runtime.info.get("onLeaseEnd") != "pause":
            return
        left = core.epoch(runtime.info.get("expiresAt")) - time.time()
        if want is None and left >= core.RENEW_BELOW_SECONDS:
            return
        need = int((want or core.LEASE_SECONDS) - left)
        if need < 1:
            return
        try:
            await runtime.extend(need)
        except Exception as error:  # noqa: BLE001
            if getattr(error, "status", None) not in (400, 409):
                raise translate(error, "sandbox") from error
            await _guard("sandbox", lambda: runtime.refresh())

    # ---- lifecycle ----------------------------------------------------------------

    async def fetch(self, port: int, path: str = "/", method: str = "GET", **kwargs: Any) -> core.FetchResponse:
        """A request to ``port`` in the sandbox, through a private preview.
        Takes httpx's ``headers``, ``params``, ``content``, ``json`` and
        ``data``; answers status_code, headers, content, text and json()."""
        runtime = await self._live()
        try:
            preview = await runtime.previews.get(port)
        except Exception as error:  # noqa: BLE001
            if getattr(error, "status", None) != 404:
                raise translate(error, "sandbox") from error
            preview = await _guard("sandbox", lambda: runtime.previews.create(port, visibility="private"))
        target, headers, body = core.fetch_request(preview, path, kwargs)
        pool = http(preview["url"])
        try:
            reply = await pool.send(method.upper(), target, headers, body, float(kwargs.get("timeout") or 60))
            content = await reply.read()
        finally:
            await pool.close()
        return core.FetchResponse(reply.status, reply.headers, content)

    async def wait(self, max_wait: int = 60000, interval: int = 1000) -> "AsyncSandboxInstance":
        """Nothing to wait for: create answers once the sandbox runs."""
        return self

    async def _archive(self, wait: bool) -> "AsyncSandboxInstance":
        """Pauses the sandbox, keeping its files and (unlike Blaxel's archive)
        its memory and processes; its status reads ARCHIVED until unarchive()."""
        runtime = await self._live()
        await self._label({"archived": "1"})
        if runtime.state == "running":
            await _guard("sandbox", lambda: runtime.pause(wait=wait))
        self._refresh_model()
        return self

    async def _unarchive(self, wait: bool) -> "AsyncSandboxInstance":
        runtime = await self._live()
        await self._label({"archived": None})
        if runtime.state in ("paused", "pausing"):
            await _guard("sandbox", lambda: runtime.wake(wait=wait))
        self._refresh_model()
        return self

    archive = _Calling("archive")
    unarchive = _Calling("unarchive")

    async def fork(self, target_name: str, *, target_type: str = "sandbox", port: Optional[int] = None,
                   traffic: Optional[int] = None, custom_domain: Optional[str] = None, prefix: Optional[str] = None,
                   snapshot_id: Optional[str] = None, envs: Optional[List[Any]] = None,
                   lifecycle: Optional[Union[core.SandboxLifecycle, Dict[str, Any]]] = None) -> SandboxForkResponse:
        """A new sandbox named ``target_name`` with this one's files, memory and
        running processes (or those of ``snapshot_id``), and its envs, with
        ``envs`` on top."""
        if lifecycle is not None:
            raise NotSupportedError("A lifecycle override on a fork",
                                    "Omit lifecycle to use the existing Runtime fork behavior.")
        core.check_fork(target_type, port, traffic, custom_domain, prefix)
        runtime = await self._live()
        labels = dict(runtime.info.get("labels") or {})
        if snapshot_id:
            copy = await _name_free(self._client, lambda: self._client.sandboxes.create(
                snapshot=snapshot_id, name=target_name, labels=labels, **core.STANDBY))
        else:
            copy = await _name_free(self._client, lambda: runtime.fork(name=target_name, labels=labels))
        plan = core.plan(core.own(labels, "ttl"), core.own(labels, "expires"),
                         json.loads(core.own(labels, "lifecycle") or "null"))
        await AsyncSandboxInstance._inherit(copy, core.envs_of(envs), plan.retention_days, runtime.info)
        return SandboxForkResponse(name=target_name, snapshot_id=snapshot_id, type_="sandbox")

    async def snapshot(self, name: Optional[str] = None) -> SandboxSnapshot:
        """Deprecated in Blaxel: sandbox.snapshots.create(name)."""
        return (await self.snapshots.create(name)).snapshot

    async def list_snapshots(self) -> List[SandboxSnapshot]:
        return [one.snapshot for one in await self.snapshots.list()]

    async def delete_snapshot(self, snapshot_id: str) -> None:
        await self.snapshots.delete(snapshot_id)

    restore = staticmethod(core.unsupported(*core.RESTORE))

    async def _delete(self) -> Sandbox:
        """Ends the sandbox for good."""
        runtime = await self._live()
        await _guard("sandbox", lambda: runtime.stop(wait=False))
        self._deleted = True
        self._refresh_model()
        return self.sandbox

    # ---- the class calls ---------------------------------------------------------------

    @classmethod
    async def create(cls, sandbox: Any = None, safe: bool = False, create_if_not_exist: bool = False, *,
                     runtime_create: Optional[Dict[str, Any]] = None) -> "AsyncSandboxInstance":
        """Creates a sandbox with Blaxel's defaults (blaxel/base-image, 4096 MB,
        kept until deleted), ready when this answers. Funding is left to
        Runtime: the free trial while the account has trial time, then prepaid
        credit. ``runtime_create`` passes Runtime's own create fields
        (snake_case), for example ``{"funding": "trial"}``."""
        config = core.config_of(sandbox)
        core.check_create(config)
        client = _client()
        image = config.image or core.DEFAULT_IMAGE
        envs = core.envs_of(config.envs)
        core.check_env_names(envs)
        memory = int(config.memory or core.DEFAULT_MEMORY)
        plan = core.plan(config.ttl, config.expires, config.lifecycle)
        fields: Dict[str, Any] = {"vcpu": core.vcpus(memory), "memory_mib": memory,
                                  "timeout_seconds": plan.timeout_seconds, "on_lease_end": plan.on_lease_end,
                                  "idle_pause_seconds": core.IDLE_PAUSE_SECONDS, "auto_wake": True,
                                  "labels": core.labels_for(config, image)}
        if not core.STOCK_IMAGE.match(image):
            fields["image"] = await _image(client, image)
        if config.name:
            fields["name"] = config.name
        elif create_if_not_exist:
            raise ValueError("Sandbox name is required")
        network = core.network_rules(config.network)
        if network is not None:
            fields["network"] = network
        mounts = await _volumes(client, core.volumes_of(config.volumes))
        if mounts:
            fields["volumes"] = mounts
        if create_if_not_exist:
            fields["get_or_create"] = True
        fields.update(runtime_create or {})
        runtime = await _name_free(client, lambda: client.sandboxes.create(**fields))
        if runtime.info.get("reused"):
            return cls(_runtime=runtime)
        return await cls._adopt(runtime, envs, retention_days=plan.retention_days)

    @classmethod
    async def _adopt(cls, runtime: Any, envs: Dict[str, str], retention_days: int) -> "AsyncSandboxInstance":
        """Readies a new Runtime sandbox for Blaxel's calls: its envs, and how
        long it is kept. A failure stops it and raises."""
        works: List[Callable[[], Any]] = []
        if envs:
            works.append(lambda: _write_envs(runtime, envs, append=False))
        if retention_days != core.RUNTIME_KEEP_DAYS:
            works.append(lambda: _retain(runtime, retention_days))
        await _settle(runtime, works)
        return cls(_runtime=runtime, _envs=dict(envs))

    @classmethod
    async def _inherit(cls, runtime: Any, extra: Dict[str, str], retention_days: int,
                       source: Optional[Dict[str, Any]]) -> "AsyncSandboxInstance":
        """Readies a fork or a sandbox started from a snapshot: its disk
        already holds the source's envs, which ``extra`` adds to; it keeps
        standby as the source had it, and the source's retention."""
        works: List[Callable[[], Any]] = []
        if extra:
            works.append(lambda: _write_envs(runtime, extra, append=True))
        wanted = source or core.STANDBY_SETTINGS
        if runtime.info.get("idlePauseSeconds") != wanted.get("idlePauseSeconds") or \
                runtime.info.get("autoWake") != wanted.get("autoWake"):
            works.append(lambda: runtime.update(idle_pause_seconds=wanted.get("idlePauseSeconds"),
                                                auto_wake=wanted.get("autoWake")))
        if retention_days != core.RUNTIME_KEEP_DAYS:
            works.append(lambda: _retain(runtime, retention_days))
        await _settle(runtime, works)
        return cls(_runtime=runtime)

    @classmethod
    async def create_if_not_exists(cls, sandbox: Any, *,
                                   runtime_create: Optional[Dict[str, Any]] = None) -> "AsyncSandboxInstance":
        """The sandbox with this name, as it is (woken if in standby), or a new
        one. Two calls at once get the same sandbox."""
        return await cls.create(sandbox, create_if_not_exist=True, runtime_create=runtime_create)

    @classmethod
    async def get(cls, sandbox_name: str) -> "AsyncSandboxInstance":
        """A sandbox by name (or Runtime id), without waking it. One whose
        keep_alive processes have all ended gets its idle pause back."""
        box = cls(_runtime=await _find(_client(), sandbox_name))
        await box._give_back_idle()
        return box

    @classmethod
    async def get_by_external_id(cls, external_id: str) -> "AsyncSandboxInstance":
        client = _client()
        listing = await _guard("sandbox", lambda: client.sandboxes.list(labels={core.LABEL + "externalId": external_id}))
        found = await listing.to_list()
        if not found:
            raise SandboxAPIError(f"No sandbox has the external id '{external_id}'", 404, "not_found")
        return cls(_runtime=found[-1])

    @classmethod
    async def list(cls, limit: int = 50, cursor: Optional[str] = None,
                   external_id: Optional[str] = None) -> AsyncPaginatedList:
        """Sandboxes that can still run (running or in standby), oldest first."""
        client = _client()
        labels = {core.LABEL + "externalId": external_id} if external_id else None
        return await _paged(lambda: client.sandboxes.list(limit=min(max(1, limit), 100), labels=labels),
                            lambda runtime: cls(_runtime=runtime), cursor)

    @classmethod
    async def update_metadata(cls, sandbox_name: str, metadata: Any) -> "AsyncSandboxInstance":
        box = await cls.get(sandbox_name)
        labels = dict(box.withruntime.info.get("labels") or {})
        labels.update({str(k): str(v) for k, v in (metadata.labels or {}).items()})
        if metadata.display_name is not None:
            labels[core.LABEL + "displayName"] = metadata.display_name
        await _guard("sandbox", lambda: box.withruntime.update(labels=labels))
        box._refresh_model()
        return box

    @classmethod
    async def update_ttl(cls, sandbox_name: str, ttl: Optional[str]) -> "AsyncSandboxInstance":
        """How long a sandbox in standby is kept, from now on. A sandbox made
        with a lease that ends it keeps that lease."""
        box = await cls.get(sandbox_name)
        labels = box.withruntime.info.get("labels") or {}
        await box._keep(ttl or None, core.own(labels, "expires"), core.own(labels, "lifecycle"), {"ttl": ttl or None})
        return box

    @classmethod
    async def update_lifecycle(cls, sandbox_name: str, lifecycle: Any) -> "AsyncSandboxInstance":
        box = await cls.get(sandbox_name)
        labels = box.withruntime.info.get("labels") or {}
        text = None if lifecycle is None else json.dumps(
            lifecycle if isinstance(lifecycle, dict) else lifecycle.to_dict(), separators=(",", ":"))
        await box._keep(core.own(labels, "ttl"), core.own(labels, "expires"), text, {"lifecycle": text})
        return box

    async def _keep(self, ttl: Any, expires: Any, lifecycle_text: Optional[str],
                    changes: Dict[str, Optional[str]]) -> None:
        plan = core.plan(ttl, expires, json.loads(lifecycle_text) if lifecycle_text else None)
        runtime = await self._live()
        await _guard("sandbox", lambda: _retain(runtime, plan.retention_days))
        await self._label(changes)

    @classmethod
    async def update_network(cls, sandbox_name: str, network: Any) -> "AsyncSandboxInstance":
        rules = core.network_rules(network.network) or {"internet": True}
        box = await cls.get(sandbox_name)
        await _guard("sandbox", lambda: box.withruntime.network.set(**rules))
        return box

    @classmethod
    async def from_session(cls, session: Any) -> "AsyncSandboxInstance":
        """A sandbox reached with a session instead of a key: what a frontend
        does with the session its backend made. Commands, processes, files and
        previews work; anything that manages the sandbox is refused by Runtime."""
        api_url, sandbox_id, token = core.session_target(session)
        runtime = await _guard("sandbox", lambda: AsyncRuntime(api_key=token, base_url=api_url)
                               .sandboxes.get(sandbox_id))
        return cls(_runtime=runtime)


async def _write_envs(runtime: Any, envs: Dict[str, str], append: bool) -> None:
    """The sandbox's env file, written (or added to) with sudo; the values
    travel on standard input, never in a command line."""
    result = await runtime.exec(core.env_file_command(append), stdin=core.env_file_lines(envs))
    if result.exit_code != 0:
        raise SandboxAPIError(f"Writing the sandbox's envs failed: {result.stderr.strip()}", 500, "setup_failed")


async def _retain(runtime: Any, days: int) -> None:
    """Keeps the sandbox ``days`` once paused. A trial sandbox's seven days
    cannot change, so it is not asked; a sandbox Runtime refuses the change
    for keeps Runtime's own retention."""
    if runtime.info.get("funding") == "trial":
        return
    try:
        await runtime.set_retention(days)
    except Exception as error:  # noqa: BLE001
        if getattr(error, "code", None) != "retention_unavailable":
            raise


async def _settle(runtime: Any, works: List[Callable[[], Any]]) -> None:
    """Runs the setup calls at once; when one fails, stops the sandbox, so a
    half-ready one is never left running, and raises."""
    try:
        await _guard("sandbox", lambda: gather(*works))
    except BaseException:
        try:
            await runtime.stop(wait=False)
        except Exception:  # noqa: BLE001 - the setup failure is what the caller hears
            pass
        raise


async def _name_free(client: AsyncRuntime, work: Callable[[], Any], subject: str = "sandbox") -> Any:
    """Runs a create or fork that names a sandbox. When the name is still held
    by one that is stopping (deleted a moment ago), waits up to 30 seconds for
    it to stop and runs it once more. This is Runtime-specific; Blaxel
    delegates conflict reconciliation to its server."""
    try:
        return await work()
    except Exception as error:  # noqa: BLE001
        details = getattr(error, "details", None) or {}
        if getattr(error, "code", None) != "name_taken" or details.get("state") != "stopping" or not isinstance(
                details.get("sandboxId"), str):
            raise translate(error, subject) from error
        holder = await _guard(subject, lambda: client.sandboxes.get(details["sandboxId"]))
        await _guard(subject, lambda: holder.wait_for("stopped", 30))
        return await _guard(subject, work)


async def _volumes(client: AsyncRuntime, volumes: List[Any]) -> List[Dict[str, str]]:
    """Blaxel volumes, by name, as Runtime volume mounts."""
    out = []
    for volume in volumes:
        listing = await _guard("sandbox", lambda: client.volumes.list(name=volume.name))
        if not listing.data:
            raise NotSupportedError(f"The volume {volume.name}, which is not a Runtime volume",
                                    f'Create it first: runtime.volumes.create(10240, name="{volume.name}"), or '
                                    f"`npx withruntime volume create --name {volume.name}`.")
        out.append({"volume_id": listing.data[0]["id"], "path": core.to_runtime_path(volume.mount_path)})
    return out


async def _image(client: AsyncRuntime, image: str) -> str:
    """The Runtime image for a Blaxel image that is not a stock one: a ready
    Runtime image named as ``core.image_ref`` maps it (``ns/name:tag`` is
    ``ns-name:tag``), or that id."""
    if core.UUID.match(image):
        return image
    name, tag = core.image_ref(image)
    try:
        found = await client.images.resolve(f"{name}:{tag}")
    except Exception as error:  # noqa: BLE001
        if getattr(error, "status", None) not in (400, 404):
            raise translate(error, "sandbox") from error
        found = None
    if not found or found.get("state") not in (None, "ready"):
        raise NotSupportedError(f"The image {image}, which is not a Runtime image", core.image_alternative(image))
    return found["id"]


async def _delete_by_name(sandbox_name: str) -> Sandbox:
    """Ends the sandbox for good."""
    box = await AsyncSandboxInstance.get(sandbox_name)
    return await box._delete()


AsyncSandboxInstance.delete = _Deleting(_delete_by_name, lambda box: box._delete())  # type: ignore[attr-defined]


class _Network:
    """``sandbox.network``: Blaxel's fetch."""

    def __init__(self, sandbox: AsyncSandboxInstance) -> None:
        self._sandbox = sandbox

    async def fetch(self, port: int, path: str = "/", method: str = "GET", **kwargs: Any) -> core.FetchResponse:
        return await self._sandbox.fetch(port, path, method, **kwargs)


class AsyncCodeInterpreter(AsyncSandboxInstance):
    """Blaxel's CodeInterpreter over Runtime's interpreter, which every
    Runtime sandbox has: run_code and create_code_context."""

    DEFAULT_IMAGE = "blaxel/jupyter-server"
    DEFAULT_PORTS = [{"name": "jupyter", "target": 8888, "protocol": "HTTP"}]
    DEFAULT_LIFECYCLE = {"expirationPolicies": [{"type": "ttl-idle", "value": "30m", "action": "delete"}]}
    OutputMessage = OutputMessage
    Result = core.Result
    ExecutionError = ExecutionError
    Logs = core.Logs
    Execution = Execution
    Context = core.Context

    @classmethod
    async def create(cls, sandbox: Any = None, safe: bool = True, create_if_not_exist: bool = False, *,
                     runtime_create: Optional[Dict[str, Any]] = None) -> "AsyncCodeInterpreter":
        payload: Dict[str, Any] = {"image": cls.DEFAULT_IMAGE, "lifecycle": cls.DEFAULT_LIFECYCLE}
        config = core.config_of(sandbox)
        for key in ("name", "envs", "memory", "region", "labels"):
            if getattr(config, key, None):
                payload[key] = getattr(config, key)
        return await super().create(payload, create_if_not_exist=create_if_not_exist,  # type: ignore[return-value]
                                    runtime_create=runtime_create)

    async def run_code(self, code: str, language: Optional[str] = None, context: Any = None,
                       on_stdout: Any = None, on_stderr: Any = None, on_result: Any = None, on_error: Any = None,
                       envs: Optional[Dict[str, str]] = None, timeout: Optional[float] = None,
                       request_timeout: Optional[float] = None) -> Execution:
        """Runs a cell; variables persist between runs of a context. The
        sandbox's envs reach the code; per-run ``envs`` are refused."""
        if language and context:
            raise ValueError("You can provide context or language, but not both at the same time.")
        if envs:
            raise NotSupportedError("Per-run environment variables (run_code envs)",
                                    "Create a context with them: set os.environ in the code, or pass envs when "
                                    "creating the sandbox.")
        runtime = await self._live()
        context_id = context.id if context is not None else await self._default_context(language)
        execution = Execution()

        def out(text: str, is_stderr: bool) -> Any:
            (execution.logs.stderr if is_stderr else execution.logs.stdout).append(text)
            handler = on_stderr if is_stderr else on_stdout
            return handler(OutputMessage(text, time.time(), is_stderr)) if handler else None
        timeout_ms = None if timeout == 0 else int((timeout or 60) * 1000)
        reply = await _guard("process", lambda: runtime.interpreter.run(
            code, context=context_id, timeout_ms=timeout_ms, on_stdout=lambda text: out(text, False),
            on_stderr=lambda text: out(text, True),
            on_result=(lambda bundle: on_result(core.result_of(bundle))) if on_result else None,
            on_error=(lambda error: on_error(ExecutionError(error.get("name", ""), error.get("value"),
                                                            error.get("traceback")))) if on_error else None))
        if not execution.logs.stdout and reply.get("stdout"):
            execution.logs.stdout.append(reply["stdout"])
        if not execution.logs.stderr and reply.get("stderr"):
            execution.logs.stderr.append(reply["stderr"])
        execution.results = [core.result_of(bundle) for bundle in reply.get("results") or []]
        error = reply.get("error")
        if error:
            execution.error = ExecutionError(error.get("name", ""), error.get("value"), error.get("traceback"))
        execution.execution_count = reply.get("executionCount")
        return execution

    async def _default_context(self, language: Optional[str]) -> str:
        """The language's own context, or one made once with the sandbox's
        envs, which Runtime's default context does not carry."""
        language = language or "python"
        envs = await self._envs()
        if not envs:
            return language
        cache = self.__dict__.setdefault("_contexts", {})
        if language not in cache:
            made = await _guard("process", lambda: self.withruntime.interpreter.contexts.create(
                language=language, cwd=core.RUNTIME_HOME, env=dict(envs)))
            cache[language] = made["id"]
        return cache[language]

    async def create_code_context(self, cwd: Optional[str] = None, language: Optional[str] = None,
                                  request_timeout: Optional[float] = None) -> core.Context:
        runtime = await self._live()
        envs = await self._envs()
        made = await _guard("process", lambda: runtime.interpreter.contexts.create(
            language=language or "python", cwd=core.to_runtime_path(cwd) if cwd else core.RUNTIME_HOME,
            env=dict(envs) if envs else None))
        return core.Context.from_json(made)


__all__ = ["AsyncSandboxInstance", "AsyncCodeInterpreter", "AsyncSandboxProcess", "AsyncSandboxFileSystem",
           "AsyncSandboxPreviews", "AsyncSandboxPreview", "AsyncSandboxPreviewTokens", "AsyncSandboxPreviewToken",
           "AsyncSandboxSnapshots", "AsyncSnapshot", "AsyncPaginatedList", "use_client"]
