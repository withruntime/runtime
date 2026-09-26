"""E2B's AsyncSandbox over Runtime's AsyncRuntime. The sync Sandbox is
generated from this file by scripts/generate_sync.py; edit this one."""
from __future__ import annotations

import dataclasses as _dataclasses
import datetime as _dt

from typing import Any, Callable, Dict, List, Optional, Union

from .._async_client import AsyncRuntime

from . import _core as core
from ._async_io import begin, call, finish, start, stop, stream, wrap
from ._core import (CommandResult, EntryInfo, FileNotFoundException, FileType, InvalidArgumentException,
                    NotSupportedException, ProcessInfo, SandboxException, SandboxInfo, SandboxNotFoundException,
                    SandboxQuery, SnapshotInfo, WriteInfo, class_method_variant, translate)

_clients: Dict[str, Any] = {}


def _client(api_key: Optional[str], client: Optional[AsyncRuntime], **connection: Any) -> AsyncRuntime:
    core.check_connection(connection)
    if client is not None:
        return client
    key = core.pick_key(api_key)
    found = _clients.get(key or "")
    if found is None:
        found = AsyncRuntime(api_key=key) if key else AsyncRuntime()
        _clients[key or ""] = found
    return found


async def _guard(subject: str, work: Callable[[], Any]) -> Any:
    try:
        return await work()
    except Exception as error:  # noqa: BLE001 - every Runtime error becomes E2B's
        raise translate(error, subject) from error


class AsyncCommandHandle:
    """A command started with ``background=True``: E2B's handle over a Runtime process."""

    def __init__(self, process: Any, stdin: bool, timeout_ms: int, cursor: int = 0,
                 on_stdout: Optional[Callable[[str], Any]] = None,
                 on_stderr: Optional[Callable[[str], Any]] = None) -> None:
        self._process = process
        self._stdin = stdin
        self._timeout_ms = timeout_ms
        self._cursor = cursor
        self._on_stdout, self._on_stderr = on_stdout, on_stderr
        self._stdout = ""
        self._stderr = ""
        self._exit: Optional[Dict[str, Any]] = None
        self._truncated = False
        self._failure: Optional[BaseException] = None
        self._disconnected = False
        self._task = start(self._follow)

    async def _follow(self) -> None:
        try:
            async for event in self._process.output(cursor=self._cursor):
                if self._disconnected:
                    return
                if event["type"] == "stdout":
                    self._stdout += event["data"]
                    await call(self._on_stdout, event["data"])
                elif event["type"] == "stderr":
                    self._stderr += event["data"]
                    await call(self._on_stderr, event["data"])
                elif event["type"] == "truncated":
                    self._truncated = True
                elif event["type"] == "exit":
                    self._exit = event
        except Exception as error:  # noqa: BLE001
            self._failure = translate(error, "sandbox")

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

    async def wait(self, on_stdout: Optional[Callable[[str], Any]] = None,
                   on_stderr: Optional[Callable[[str], Any]] = None) -> CommandResult:
        """Waits for the command to end. Raises CommandExitException on a
        non-zero exit, as E2B does."""
        if on_stdout is not None:
            self._on_stdout = on_stdout
        if on_stderr is not None:
            self._on_stderr = on_stderr
        await finish(self._task)
        if self._failure is not None:
            raise self._failure
        if self._exit is None:
            raise SandboxException("Disconnected from the command before it ended; reconnect with "
                                   "commands.connect(pid)." if self._disconnected
                                   else "The command's output ended without an exit.")
        return core.settle(self._exit.get("exitCode"), self._stdout, self._stderr,
                           bool(self._exit.get("timedOut")), self._timeout_ms, self._truncated)

    async def disconnect(self) -> None:
        """Stops receiving output; the command keeps running."""
        self._disconnected = True
        stop(self._task)

    async def kill(self) -> bool:
        """Kills the command with SIGKILL. False when it had already ended."""
        if self._exit is not None:
            return False
        await _guard("sandbox", lambda: self._process.kill("SIGKILL"))
        return True

    async def send_stdin(self, data: Union[str, bytes], request_timeout: Optional[float] = None) -> None:
        if not self._stdin:
            raise InvalidArgumentException("The command was not started with stdin=True, so its input is closed.")
        await _guard("sandbox", lambda: self._process.write(data))

    async def close_stdin(self, request_timeout: Optional[float] = None) -> None:
        if not self._stdin:
            raise InvalidArgumentException("The command was not started with stdin=True.")
        await _guard("sandbox", lambda: self._process.write(b"", eof=True))


class AsyncCommands:
    """``sandbox.commands``: E2B's command module over Runtime's exec and processes."""

    def __init__(self, sandbox: "AsyncSandbox") -> None:
        self._sandbox = sandbox

    def _env(self, envs: Optional[Dict[str, str]]) -> Optional[Dict[str, str]]:
        merged = {**self._sandbox._envs, **(envs or {})}
        return merged or None

    async def run(self, cmd: str, background: Optional[bool] = None, envs: Optional[Dict[str, str]] = None,
                  user: Optional[str] = None, cwd: Optional[str] = None,
                  on_stdout: Optional[Callable[[str], Any]] = None, on_stderr: Optional[Callable[[str], Any]] = None,
                  stdin: Optional[bool] = None, timeout: Optional[float] = 60,
                  request_timeout: Optional[float] = None) -> Any:
        """Runs a command. In the foreground it returns the result and raises
        CommandExitException on a non-zero exit and TimeoutException past
        ``timeout`` (seconds, 0 for none); ``background=True`` returns a handle."""
        core.refuse_user(user)
        await self._sandbox._ensure_home(f"{cmd}\n{cwd or ''}")
        timeout_ms = core.command_timeout_ms(timeout)
        if background or stdin:
            handle = await self._start(cmd, envs, cwd, bool(stdin), timeout_ms, on_stdout, on_stderr)
            return handle if background else await handle.wait()
        result = await _guard("sandbox", lambda: self._sandbox.runtime.exec(
            cmd, cwd=cwd, env=self._env(envs), timeout_ms=timeout_ms,
            on_stdout=wrap(on_stdout) or core.whole_output, on_stderr=wrap(on_stderr)))
        return core.settle(result.exit_code, result.stdout, result.stderr, result.timed_out, timeout_ms,
                           result.stdout_truncated or result.stderr_truncated)

    async def _start(self, cmd: str, envs: Optional[Dict[str, str]], cwd: Optional[str], stdin: bool,
                     timeout_ms: int, on_stdout: Any, on_stderr: Any) -> AsyncCommandHandle:
        process = await _guard("sandbox", lambda: self._sandbox.runtime.spawn(
            cmd, cwd=cwd, env=self._env(envs), stdin="pipe" if stdin else None, timeout_ms=timeout_ms))
        return AsyncCommandHandle(process, stdin, timeout_ms, on_stdout=on_stdout, on_stderr=on_stderr)

    async def list(self, request_timeout: Optional[float] = None) -> List[ProcessInfo]:
        processes = await _guard("sandbox", lambda: self._sandbox.runtime.processes())
        return [core.describe_process(info) for info in processes if info.get("state") == "running"]

    async def _find(self, pid: int) -> Optional[Dict[str, Any]]:
        for info in await _guard("sandbox", lambda: self._sandbox.runtime.processes()):
            if core.pid_of(info["id"]) == pid and info.get("state") == "running":
                return info
        return None

    async def _process(self, pid: int) -> Any:
        info = await self._find(pid)
        if info is None:
            raise SandboxException(f"No running command with pid {pid}.")
        return await _guard("sandbox", lambda: self._sandbox.runtime.process(info["id"]))

    async def kill(self, pid: int, request_timeout: Optional[float] = None) -> bool:
        """Kills a command with SIGKILL, as E2B does. False when there is none."""
        info = await self._find(pid)
        if info is None:
            return False
        process = await _guard("sandbox", lambda: self._sandbox.runtime.process(info["id"]))
        await _guard("sandbox", lambda: process.kill("SIGKILL"))
        return True

    async def send_stdin(self, pid: int, data: Union[str, bytes], request_timeout: Optional[float] = None) -> None:
        process = await self._process(pid)
        if not process.info.get("stdinOpen"):
            raise InvalidArgumentException(f"The command with pid {pid} was not started with stdin=True.")
        await _guard("sandbox", lambda: process.write(data))

    async def close_stdin(self, pid: int, request_timeout: Optional[float] = None) -> None:
        process = await self._process(pid)
        await _guard("sandbox", lambda: process.write(b"", eof=True))

    async def connect(self, pid: int, timeout: Optional[float] = 60, request_timeout: Optional[float] = None,
                      on_stdout: Optional[Callable[[str], Any]] = None,
                      on_stderr: Optional[Callable[[str], Any]] = None) -> AsyncCommandHandle:
        """Attaches to a running command; output from now on reaches the handle."""
        process = await self._process(pid)
        return AsyncCommandHandle(process, bool(process.info.get("stdinOpen")), core.command_timeout_ms(timeout),
                                  cursor=int(process.info.get("outputBytes") or 0), on_stdout=on_stdout,
                                  on_stderr=on_stderr)


class AsyncFilesystem:
    """``sandbox.files``: E2B's filesystem module over Runtime's files API.
    Relative paths resolve against the home directory (Runtime's is /workspace)."""

    def __init__(self, sandbox: "AsyncSandbox") -> None:
        self._sandbox = sandbox

    @property
    def _files(self) -> Any:
        return self._sandbox.runtime.files

    async def _path(self, path: str, user: Optional[str], metadata: Optional[Dict[str, str]] = None) -> str:
        core.refuse_file_user(user, metadata)
        await self._sandbox._ensure_home(path)
        return core.absolute(path)

    async def read(self, path: str, format: str = "text", user: Optional[str] = None,  # noqa: A002
                   request_timeout: Optional[float] = None, gzip: bool = False,
                   stream_idle_timeout: Optional[float] = None) -> Any:
        """The file as text (default), ``bytearray`` (format="bytes") or chunks (format="stream")."""
        target = await self._path(path, user)
        data = await _guard("file", lambda: self._files.read(target))
        if format == "bytes":
            return bytearray(data)
        if format == "stream":
            return stream(bytes(data))
        return bytes(data).decode()

    async def write(self, path: str, data: Any, user: Optional[str] = None, request_timeout: Optional[float] = None,
                    gzip: bool = False, use_octet_stream: Optional[bool] = None,
                    metadata: Optional[Dict[str, str]] = None) -> WriteInfo:
        """Writes a file, making its directories, and replaces one that exists."""
        target = await self._path(path, user, metadata)
        await _guard("file", lambda: self._files.write(target, core.to_bytes(data)))
        return WriteInfo(name=target.rstrip("/").rsplit("/", 1)[-1], type=FileType.FILE, path=target)

    async def write_files(self, files: List[Dict[str, Any]], user: Optional[str] = None,
                          request_timeout: Optional[float] = None, gzip: bool = False,
                          use_octet_stream: Optional[bool] = None,
                          metadata: Optional[Dict[str, str]] = None) -> List[WriteInfo]:
        written = []
        for entry in files:
            written.append(await self.write(entry["path"], entry["data"], user=user, metadata=metadata))
        return written

    async def list(self, path: str, depth: Optional[int] = 1, user: Optional[str] = None,
                   request_timeout: Optional[float] = None) -> List[EntryInfo]:
        """A directory's entries, hidden ones included; ``depth`` goes deeper."""
        target = await self._path(path, user)
        entries = await _guard("file", lambda: self._files.list(target, depth=depth or 1, hidden=True))
        return [core.entry_info(entry) for entry in entries]

    async def exists(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> bool:
        target = await self._path(path, user)
        return bool(await _guard("file", lambda: self._files.exists(target)))

    async def get_info(self, path: str, user: Optional[str] = None,
                       request_timeout: Optional[float] = None) -> EntryInfo:
        target = await self._path(path, user)
        found = await _guard("file", lambda: self._files.stat(target))
        if not found.get("exists"):
            raise FileNotFoundException(f"{target} does not exist.")
        return core.entry_info(found)

    async def remove(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> None:
        """Removes a file, or a directory with everything in it."""
        target = await self._path(path, user)
        await _guard("file", lambda: self._files.remove(target, recursive=True))

    async def rename(self, old_path: str, new_path: str, user: Optional[str] = None,
                     request_timeout: Optional[float] = None) -> EntryInfo:
        """Moves a file or directory, replacing a file at the new path, as E2B does."""
        source = await self._path(old_path, user)
        target = await self._path(new_path, user)
        await _guard("file", lambda: self._files.rename(source, target, overwrite=True))
        return await self.get_info(target)

    async def make_dir(self, path: str, user: Optional[str] = None, request_timeout: Optional[float] = None) -> bool:
        """Makes a directory and its parents. False when it already existed."""
        target = await self._path(path, user)
        if await _guard("file", lambda: self._files.exists(target)):
            return False
        await _guard("file", lambda: self._files.mkdir(target, parents=True))
        return True

    watch_dir = staticmethod(core.unsupported(
        "Watching a directory (files.watch_dir)",
        "Poll with files.list(path), or run your own watcher with commands.run(..., background=True)."))


class AsyncSandboxPaginator:
    """E2B's paginator: ``while p.has_next: items.extend(p.next_items())``."""

    def __init__(self, client: AsyncRuntime, filters: Dict[str, Any]) -> None:
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

    async def next_items(self) -> List[SandboxInfo]:
        if not self._has_next:
            raise SandboxException("No more items to fetch.")
        if self._page is None:
            page = await _guard("other", lambda: self._client.sandboxes.list(**self._filters))
        else:
            page = await _guard("other", lambda: self._page.next_page())
        self._page = page
        self._has_next = bool(page is not None and page.has_more)
        return [] if page is None else [core.sandbox_info(sbx.info) for sbx in page.data]


class AsyncSandbox:
    """E2B's AsyncSandbox, on Runtime. ``sandbox.runtime`` is the Runtime sandbox
    underneath, for anything E2B has no name for."""

    default_template = "base"

    def __init__(self, runtime: Any, client: AsyncRuntime, envs: Optional[Dict[str, str]] = None) -> None:
        """Use ``await AsyncSandbox.create()`` or ``await AsyncSandbox.connect(id)``."""
        self.runtime = runtime
        self._client = client
        self._envs: Dict[str, str] = dict(envs or {})
        self._home_linked = False
        self._shares: Dict[int, Any] = {}  # port -> the one public share asked for it
        self.files = AsyncFilesystem(self)
        self.commands = AsyncCommands(self)

    @property
    def sandbox_id(self) -> str:
        return self.runtime.id

    async def _ensure_home(self, text: Optional[str]) -> None:
        """E2B's home is /home/user and Runtime's is /workspace. The first time
        something names /home/user it is made a link to /workspace (unless
        something is already there), so paths written for E2B work."""
        if self._home_linked or not text or "/home/user" not in text:
            return
        self._home_linked = True
        result = await _guard("sandbox", lambda: self.runtime.exec(core.HOME_LINK))
        if result.exit_code != 0:
            import warnings
            warnings.warn(f"Could not link /home/user to /workspace: {result.stderr.strip()}", stacklevel=3)

    # ---- create, connect, list ---------------------------------------------

    @classmethod
    async def create(cls, template: Optional[str] = None, timeout: Optional[int] = None,
                     metadata: Optional[Dict[str, str]] = None, envs: Optional[Dict[str, str]] = None,
                     secure: Optional[bool] = None, allow_internet_access: Optional[bool] = None,
                     mcp: Any = None, network: Any = None, iam: Any = None, lifecycle: Optional[Dict[str, Any]] = None,
                     volume_mounts: Any = None, api_key: Optional[str] = None,
                     client: Optional[AsyncRuntime] = None, runtime_create: Optional[Dict[str, Any]] = None,
                     **connection: Any) -> Any:
        """Creates a sandbox from ``template`` (default "base", Runtime's stock
        image) with E2B's default machine, 2 vCPU and 512 MiB, and waits until
        it runs. ``timeout`` is in seconds (default 300). Funding is left to
        Runtime: the free trial while the account has trial time, then prepaid
        credit, exactly as withruntime's own create. ``runtime_create`` passes
        Runtime fields (snake_case) over the adapter's."""
        core.refuse_create({"mcp": mcp, "network": network, "iam": iam, "volume_mounts": volume_mounts})
        runtime_client = _client(api_key, client, **connection)
        fields: Dict[str, Any] = {
            "timeout_seconds": core.lease_seconds(core.DEFAULT_TIMEOUT if timeout is None else timeout),
            "on_lease_end": core.on_lease_end(lifecycle),
        }
        if lifecycle:
            # E2B resumes on traffic only when asked; Runtime's automatic wake is the same (0093).
            fields["auto_wake"] = bool(lifecycle.get("auto_resume"))
        if metadata:
            fields["labels"] = dict(metadata)
        if allow_internet_access is False:
            fields["network"] = {"internet": False}
        source = await cls._resolve(runtime_client, template or cls.default_template)
        if "snapshot" not in source:
            fields = {"vcpu": core.DEFAULT_VCPU, "memory_mib": core.DEFAULT_MEMORY_MIB, **fields}
        fields.update(source)
        fields.update(runtime_create or {})
        created = await _guard("sandbox", lambda: runtime_client.sandboxes.create(**fields))
        return cls(created, runtime_client, envs)

    @staticmethod
    async def _resolve(client: AsyncRuntime, template: str) -> Dict[str, Any]:
        if template in core.STOCK_TEMPLATES:
            return {}
        if core.UUID.match(template):
            try:
                await client.images.get(template)
                return {"image": template}
            except Exception as error:  # noqa: BLE001
                if getattr(error, "status", None) != 404:
                    raise translate(error) from error
            return {"snapshot": template}
        page = await _guard("other", lambda: client.images.list(name=template, state="ready", limit=1))
        if page.data:
            return {"image": page.data[0]["id"]}
        raise core.template_missing(template)

    @classmethod
    async def _cls_connect_sandbox(cls, sandbox_id: str, timeout: Optional[int] = None, *,
                                   on_resume: str = "restore", api_key: Optional[str] = None,
                                   client: Optional[AsyncRuntime] = None, **connection: Any) -> Any:
        runtime_client = _client(api_key, client, **connection)
        runtime = await _guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id))
        await _resume(runtime, timeout, on_resume)
        return cls(runtime, runtime_client)

    @class_method_variant("_cls_connect_sandbox")
    async def connect(self, timeout: Optional[int] = None, *, on_resume: str = "restore", **_: Any) -> Any:
        """Wakes this sandbox if it is paused; ``AsyncSandbox.connect(id)`` does the same by id.
        A ``timeout`` (seconds) moves a running sandbox's end later, never earlier."""
        await _guard("sandbox", lambda: self.runtime.refresh())
        await _resume(self.runtime, timeout, on_resume)
        return self

    @classmethod
    def list(cls, query: Optional[SandboxQuery] = None, limit: Optional[int] = None,
             next_token: Optional[str] = None, order: Optional[str] = None, api_key: Optional[str] = None,
             client: Optional[AsyncRuntime] = None, **connection: Any) -> AsyncSandboxPaginator:
        """Running and paused sandboxes, a page at a time."""
        return AsyncSandboxPaginator(_client(api_key, client, **connection),
                                     core.list_filter(query, limit, next_token, order))

    # ---- lifecycle ------------------------------------------------------------

    @classmethod
    async def _cls_kill(cls, sandbox_id: str, api_key: Optional[str] = None, client: Optional[AsyncRuntime] = None,
                        **connection: Any) -> bool:
        runtime_client = _client(api_key, client, **connection)
        try:
            runtime = await _guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id))
        except SandboxNotFoundException:
            return False
        return await _stop(runtime)

    @class_method_variant("_cls_kill")
    async def kill(self, **_: Any) -> bool:
        """Stops the sandbox. False when it was not found or had already ended."""
        try:
            return await _stop(self.runtime)
        except SandboxNotFoundException:
            return False

    @classmethod
    async def _cls_set_timeout(cls, sandbox_id: str, timeout: int, api_key: Optional[str] = None,
                               client: Optional[AsyncRuntime] = None, **connection: Any) -> None:
        runtime_client = _client(api_key, client, **connection)
        await _extend_to(await _guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id)), timeout)

    @class_method_variant("_cls_set_timeout")
    async def set_timeout(self, timeout: int, **_: Any) -> None:
        """Sets the sandbox to end ``timeout`` seconds from now. Runtime leases
        only move later: a shorter timeout than the one it has is refused."""
        await _guard("sandbox", lambda: self.runtime.refresh())
        await _extend_to(self.runtime, timeout)

    @classmethod
    async def _cls_get_info(cls, sandbox_id: str, api_key: Optional[str] = None,
                            client: Optional[AsyncRuntime] = None, **connection: Any) -> SandboxInfo:
        runtime_client = _client(api_key, client, **connection)
        return core.sandbox_info((await _guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id))).info)

    @class_method_variant("_cls_get_info")
    async def get_info(self, **_: Any) -> SandboxInfo:
        await _guard("sandbox", lambda: self.runtime.refresh())
        return core.sandbox_info(self.runtime.info)

    async def is_running(self, request_timeout: Optional[float] = None) -> bool:
        try:
            await _guard("sandbox", lambda: self.runtime.refresh())
        except SandboxNotFoundException:
            return False
        return self.runtime.state == "running"

    @classmethod
    async def _cls_pause(cls, sandbox_id: str, keep_memory: Optional[bool] = None, api_key: Optional[str] = None,
                         client: Optional[AsyncRuntime] = None, **connection: Any) -> bool:
        runtime_client = _client(api_key, client, **connection)
        return await _pause(await _guard("sandbox", lambda: runtime_client.sandboxes.get(sandbox_id)), keep_memory)

    @class_method_variant("_cls_pause")
    async def pause(self, keep_memory: Optional[bool] = None, **_: Any) -> bool:
        """Pauses the sandbox, keeping memory and files. False when it was paused."""
        await _guard("sandbox", lambda: self.runtime.refresh())
        return await _pause(self.runtime, keep_memory)

    @class_method_variant("_cls_pause")
    async def beta_pause(self, keep_memory: Optional[bool] = None, **_: Any) -> bool:
        return await self.pause(keep_memory)

    async def __aenter__(self) -> Any:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.kill()

    # ---- forks and snapshots ------------------------------------------------

    @classmethod
    async def _cls_fork_sandbox(cls, sandbox_id: str, timeout: Optional[int] = None, count: Optional[int] = None,
                                **opts: Any) -> List[Any]:
        source = await cls._cls_connect_sandbox(sandbox_id, **opts)
        return await source.fork(timeout, count)

    @class_method_variant("_cls_fork_sandbox")
    async def fork(self, timeout: Optional[int] = None, count: Optional[int] = None, **_: Any) -> List[Any]:
        """Copies of this sandbox, memory and all. While Runtime's forks are
        switched off this raises NotSupportedException in Runtime's own words."""
        if timeout is not None:
            # A fork's lease is Runtime's to set; one shorter than asked could not
            # be honoured after the forks exist, so this is refused before any are made.
            raise NotSupportedException("A timeout for forks (fork timeout)",
                                        "Fork without it, then call set_timeout(seconds) on each fork.")
        copies = await _guard("sandbox", lambda: self.runtime.fork(count or 1))
        return [type(self)(copy, self._client, self._envs) for copy in copies]

    @classmethod
    async def _cls_create_snapshot(cls, sandbox_id: str, name: Optional[str] = None, **opts: Any) -> SnapshotInfo:
        source = await cls._cls_connect_sandbox(sandbox_id, **opts)
        return await source.create_snapshot(name)

    @class_method_variant("_cls_create_snapshot")
    async def create_snapshot(self, name: Optional[str] = None, **_: Any) -> SnapshotInfo:
        """Keeps the whole machine as a Runtime snapshot; start from it with create(snapshot_id)."""
        snapshot = await _guard("sandbox", lambda: self.runtime.snapshot(name=name))
        return SnapshotInfo(snapshot_id=snapshot["id"], names=[snapshot["name"]] if snapshot.get("name") else [])

    @classmethod
    async def delete_snapshot(cls, snapshot_id: str, api_key: Optional[str] = None,
                              client: Optional[AsyncRuntime] = None, **connection: Any) -> bool:
        runtime_client = _client(api_key, client, **connection)
        try:
            await _guard("other", lambda: runtime_client.snapshots.delete(snapshot_id))
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
        caller, in about a tenth of a second (``await get_public_host(port)``
        returns once it has landed); the sync one before returning."""
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise InvalidArgumentException(f"port must be a whole number from 1 to 65535, not {port!r}.")
        if port not in self._shares:
            self._shares[port] = begin(lambda: self._share(port))
        return f"{port}-{self.sandbox_id.replace('-', '').lower()}.{core.PREVIEW_DOMAIN}"

    async def get_public_host(self, port: int) -> str:
        """Shares ``port`` at a public HTTPS address (a Runtime preview) and
        returns its host once the share has landed. Anyone with the address
        can reach it; a browser sees a one-time page naming Runtime."""
        if port not in self._shares:
            self._shares[port] = begin(lambda: self._share(port))
        try:
            return await self._shares[port]
        except BaseException:
            self._shares.pop(port, None)  # a failed share is asked again next time
            raise

    async def _share(self, port: int) -> str:
        preview = await _guard("sandbox", lambda: self.runtime.previews.create(port, visibility="public"))
        return preview["url"].split("://", 1)[-1].split("/", 1)[0]

    # ---- what Runtime does differently -----------------------------------------

    @property
    def pty(self) -> Any:
        raise NotSupportedException("E2B's pty module",
                                    "Use sandbox.runtime.terminal(cols=..., rows=...) for an interactive terminal.")

    @property
    def git(self) -> Any:
        raise NotSupportedException("E2B's git module", "Run git with sandbox.commands.run('git ...').")

    async def get_metrics(self, start: Any = None, end: Any = None) -> list["SandboxMetrics"]:
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
        m = await _guard("sandbox", lambda: self.runtime.metrics(range=window))
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


async def _resume(runtime: Any, timeout: Optional[int], on_resume: str) -> None:
    if on_resume == "reboot":
        raise NotSupportedException("Resuming by reboot (on_resume='reboot')",
                                    "Runtime's wake restores memory; stop the sandbox and create a new one.")
    state = core.simple_state(runtime.state)
    if state == "stopped":
        raise SandboxNotFoundException(f"Sandbox {runtime.id} has ended.")
    if state == "paused":
        await _guard("sandbox", lambda: runtime.wake(timeout_seconds=None if timeout is None else core.lease_seconds(timeout)))
        return
    if timeout is not None:
        later = core.seconds_later(runtime.info, timeout)
        if later > 1:
            await _guard("sandbox", lambda: runtime.extend(int(later) + 1))


async def _stop(runtime: Any) -> bool:
    if core.simple_state(runtime.state) == "stopped":
        return False
    await _guard("sandbox", lambda: runtime.stop(wait=False))
    return True


async def _extend_to(runtime: Any, timeout: float) -> None:
    if timeout is None or timeout <= 0:
        raise InvalidArgumentException(f"timeout must be a positive number of seconds, not {timeout}.")
    later = core.seconds_later(runtime.info, timeout)
    if later < -1:
        raise NotSupportedException("Shortening a sandbox's timeout",
                                    "Runtime leases only move later. Call kill() when the work is done.")
    if later > 1:
        await _guard("sandbox", lambda: runtime.extend(int(later) + 1))


async def _pause(runtime: Any, keep_memory: Optional[bool]) -> bool:
    if keep_memory is False:
        raise NotSupportedException("A files-only pause (keep_memory=False)",
                                    "Runtime's pause keeps memory and files; leave keep_memory out.")
    state = core.simple_state(runtime.state)
    if state == "paused":
        return False
    if state == "stopped":
        raise SandboxNotFoundException(f"Sandbox {runtime.id} has ended.")
    await _guard("sandbox", lambda: runtime.pause())
    return True


__all__ = ["AsyncSandbox", "AsyncCommands", "AsyncCommandHandle", "AsyncFilesystem", "AsyncSandboxPaginator"]


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
