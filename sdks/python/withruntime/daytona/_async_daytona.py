"""Daytona's AsyncDaytona and AsyncSandbox over Runtime's AsyncRuntime. The
sync Daytona is generated from this file by scripts/generate_dropin_sync.py;
edit this one."""
from __future__ import annotations

import base64
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Union

from .._async_client import AsyncRuntime

from . import _core as core
from ._async_io import call, catch_up, finish, start
from ._core import (CodeRunParams, CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, CreateSnapshotParams,
                    DaytonaCommandAlreadyCompletedError, DaytonaConfig, DaytonaConflictError, DaytonaError,
                    DaytonaFileNotFoundError, DaytonaNotFoundError, DaytonaProcessExecutionTimeoutError,
                    DaytonaSessionEndedError, ExecuteResponse, ExecutionArtifacts, ExecutionError, ExecutionResult,
                    FileDownloadRequest, FileDownloadResponse, FileInfo, FileUpload, GitCommitResponse, GitStatus,
                    InterpreterContext, ListBranchResponse, ListSandboxesQuery, Match, NotSupportedError,
                    OutputMessage, PaginatedSnapshots, PortPreviewUrl, ReplaceResult, SandboxState, SearchFilesResponse,
                    Session, SessionCommandLogsResponse, SessionExecuteRequest, SessionExecuteResponse, Snapshot,
                    Volume, translate)

_clients: Dict[str, Any] = {}


def _client(config: Optional[DaytonaConfig], client: Optional[AsyncRuntime]) -> AsyncRuntime:
    core.check_config(config)
    if client is not None:
        return client
    key = core.pick_key(config.api_key if config else None)
    found = _clients.get(key or "")
    if found is None:
        found = AsyncRuntime(api_key=key) if key else AsyncRuntime()
        _clients[key or ""] = found
    return found


async def _guard(subject: str, work: Callable[[], Any]) -> Any:
    try:
        return await work()
    except Exception as error:  # noqa: BLE001 - every Runtime error becomes Daytona's
        raise translate(error, subject) from error


class _Shell:
    """A session's bash and the commands sent to it."""

    def __init__(self, session_id: str, process: Any, cursor: int) -> None:
        self.id, self.process, self.cursor = session_id, process, cursor
        self.commands: List[core.SessionCommand] = []
        self.ended = False
        self.pending: Optional[core.SessionCommand] = None


class AsyncProcess:
    """``sandbox.process``: Daytona's commands, code runs and sessions over
    Runtime's exec and processes."""

    def __init__(self, sandbox: "AsyncSandbox") -> None:
        self._sandbox = sandbox
        self._sessions: Dict[str, _Shell] = {}

    def _env(self, extra: Optional[Dict[str, str]] = None) -> Optional[Dict[str, str]]:
        merged = {**self._sandbox.env, **(extra or {})}
        return merged or None

    async def exec(self, command: str, cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None,
                   timeout: Optional[int] = None) -> ExecuteResponse:
        """Runs a shell command. A non-zero exit is a result, not an error.
        ``timeout`` is in seconds; past it DaytonaProcessExecutionTimeoutError."""
        await self._sandbox._ensure_home(f"{command}\n{cwd or ''}")
        runtime = await self._sandbox._live()
        timeout_ms = int(timeout * 1000) if timeout else core.LONGEST_MS
        result = await _guard("sandbox", lambda: runtime.exec(
            f"{{ {command}\n}} 2>&1", cwd=core.HOME if cwd is None else core.resolve_path(cwd), env=self._env(env),
            timeout_ms=timeout_ms, on_stdout=core.whole_output))
        if result.timed_out:
            raise DaytonaProcessExecutionTimeoutError(f"Command timed out after {timeout} s.", 408)
        output = result.stdout + result.stderr
        return ExecuteResponse(exit_code=-1 if result.exit_code is None else result.exit_code, result=output,
                               artifacts=ExecutionArtifacts(stdout=output))

    async def code_run(self, code: str, params: Optional[CodeRunParams] = None,
                       timeout: Optional[int] = None) -> ExecuteResponse:
        """Runs code in the sandbox's language as a fresh process. Charts are
        always empty on Runtime."""
        runtime = await self._sandbox._live()
        language = self._sandbox._language
        interpreter = (["python3", "-c", code] if language == "python" else
                       ["bun", "-e", code] if language == "typescript" else ["node", "-e", code])
        argv = ["sh", "-c", 'exec "$@" 2>&1', "sh", *interpreter, *((params.argv if params else None) or [])]
        timeout_ms = int(timeout * 1000) if timeout else core.LONGEST_MS
        result = await _guard("sandbox", lambda: runtime.exec(
            argv, cwd=core.HOME, env=self._env(params.env if params else None), timeout_ms=timeout_ms,
            on_stdout=core.whole_output))
        if result.timed_out:
            raise DaytonaProcessExecutionTimeoutError(f"Code run timed out after {timeout} s.", 408)
        return ExecuteResponse(exit_code=-1 if result.exit_code is None else result.exit_code, result=result.stdout,
                               artifacts=ExecutionArtifacts(stdout=result.stdout, charts=[]))

    # ---- sessions ----------------------------------------------------------------

    async def create_session(self, session_id: str) -> None:
        """Starts a bash that keeps its directory and variables from one
        command to the next, running one command at a time."""
        if session_id in self._sessions or await self._discover(session_id) is not None:
            raise DaytonaConflictError(f"Session {session_id} already exists.", 409)
        runtime = await self._sandbox._live()
        process = await _guard("sandbox", lambda: runtime.spawn(
            ["bash", "--noprofile", "--norc", "-s", f"{core.TAG}{session_id}"], cwd=core.HOME, env=self._env(),
            stdin="pipe", timeout_ms=core.LONGEST_MS))
        await _guard("process", lambda: process.write(core.PRELUDE))
        self._sessions[session_id] = _Shell(session_id, process, 0)

    async def _discover(self, session_id: str) -> Optional[_Shell]:
        """A session another client made on this sandbox, found by its tag."""
        runtime = await self._sandbox._live()
        for info in await _guard("sandbox", lambda: runtime.processes()):
            if info.get("state") == "running" and f"{core.TAG}{session_id}" in str(info.get("command", "")).split():
                process = await _guard("process", lambda: runtime.process(info["id"]))
                shell = _Shell(session_id, process, int(info.get("outputBytes") or 0))
                self._sessions[session_id] = shell
                return shell
        return None

    async def _shell(self, session_id: str) -> _Shell:
        shell = self._sessions.get(session_id) or await self._discover(session_id)
        if shell is None:
            raise DaytonaNotFoundError(f"Session {session_id} was not found.", 404)
        if shell.ended:
            raise DaytonaSessionEndedError(f"Session {session_id} has ended.", 410)
        return shell

    def _command(self, shell: _Shell, command_id: str) -> core.SessionCommand:
        for command in shell.commands:
            if command.id == command_id:
                return command
        raise DaytonaNotFoundError(f"Command {command_id} was not found in session {shell.id}.", 404)

    async def _follow(self, shell: _Shell, command: core.SessionCommand) -> None:
        reader = core.MarkerReader(command.id)
        try:
            async for event in shell.process.output(cursor=shell.cursor):
                if event["type"] == "exit":
                    shell.ended = True
                    for stream in ("stdout", "stderr"):
                        for handler, text in command.emit(stream, reader.flush(stream)):
                            await call(handler, text)
                    command.exit_code = -1 if event.get("exitCode") is None else event["exitCode"]
                    return
                if event["type"] not in ("stdout", "stderr"):
                    continue
                shell.cursor = event["offset"] + len(event["data"].encode())
                for handler, text in command.emit(event["type"], reader.feed(event["type"], event["data"])):
                    await call(handler, text)
                if reader.done:
                    command.exit_code = reader.exit_code
                    return
            shell.ended = True
        except Exception as error:  # noqa: BLE001
            raise translate(error, "process") from error
        finally:
            if shell.pending is command:
                shell.pending = None

    async def _settle(self, shell: _Shell) -> None:
        """Waits for the command running in the session, if any."""
        pending = shell.pending
        if pending is not None and pending.task is not None:
            await finish(pending.task)

    async def execute_session_command(self, session_id: str, req: SessionExecuteRequest,
                                      timeout: Optional[int] = None) -> SessionExecuteResponse:
        """Runs a command in the session. It waits and returns the output and
        exit code, or with ``run_async=True`` returns the cmd_id at once."""
        shell = await self._shell(session_id)
        await self._sandbox._ensure_home(req.command)
        await self._sandbox._live()
        await self._settle(shell)
        if shell.ended:
            raise DaytonaSessionEndedError(f"Session {session_id} has ended.", 410)
        command = core.SessionCommand(str(uuid.uuid4()), req.command)
        shell.commands.append(command)
        encoded = base64.b64encode(req.command.encode()).decode()
        await _guard("process", lambda: shell.process.write(f"__rt_run {encoded} {command.id}\n"))
        shell.pending = command
        command.task = start(lambda: self._follow(shell, command))
        if req.run_async or req.var_async:
            return SessionExecuteResponse(cmd_id=command.id)
        await finish(command.task)
        return SessionExecuteResponse(cmd_id=command.id, output=command.output, stdout=command.stdout,
                                      stderr=command.stderr, exit_code=command.exit_code)

    async def get_session(self, session_id: str) -> Session:
        shell = await self._shell(session_id)
        return Session(session_id=session_id, commands=[one.describe() for one in shell.commands])

    async def get_session_command(self, session_id: str, command_id: str) -> core.Command:
        command = self._command(await self._shell(session_id), command_id)
        await catch_up(command.task)
        return command.describe()

    async def get_session_command_logs(self, session_id: str, command_id: str) -> SessionCommandLogsResponse:
        """The command's output so far. (The sync client reads a running
        command's output to its end first.)"""
        command = self._command(await self._shell(session_id), command_id)
        await catch_up(command.task)
        return SessionCommandLogsResponse(output=command.output, stdout=command.stdout, stderr=command.stderr)

    async def _stream_logs(self, session_id: str, command_id: str, on_stdout: Any, on_stderr: Any) -> None:
        command = self._command(await self._shell(session_id), command_id)
        if command.stdout:
            await call(on_stdout, command.stdout)
        if command.stderr:
            await call(on_stderr, command.stderr)
        listener = (on_stdout, on_stderr)
        command.listeners.append(listener)
        try:
            if command.task is not None:
                await finish(command.task)
        finally:
            command.listeners.remove(listener)

    def get_session_command_logs_async(self, session_id: str, command_id: str, on_stdout: Any,
                                       on_stderr: Any) -> Any:
        """Awaitable: the command's output from its start, to the handlers, as
        it happens, until it ends."""
        from ._async_io import awaitable
        return awaitable(lambda: self._stream_logs(session_id, command_id, on_stdout, on_stderr))

    async def send_session_command_input(self, session_id: str, command_id: str, data: str) -> None:
        shell = await self._shell(session_id)
        command = self._command(shell, command_id)
        if command.exit_code is not None:
            raise DaytonaCommandAlreadyCompletedError(f"Command {command_id} has already completed.", 410)
        await _guard("process", lambda: shell.process.write(data))

    async def list_sessions(self) -> List[Session]:
        return [Session(session_id=shell.id, commands=[one.describe() for one in shell.commands])
                for shell in self._sessions.values() if not shell.ended]

    async def delete_session(self, session_id: str) -> None:
        shell = await self._shell(session_id)
        shell.ended = True
        self._sessions.pop(session_id, None)
        await _guard("process", lambda: shell.process.kill("SIGKILL"))

    _PTY = ("Daytona's PTY sessions", "Use sandbox.withruntime.terminal(cols=..., rows=...) for an interactive "
            "terminal, or a session for commands.")
    create_pty_session = staticmethod(core.unsupported(*_PTY))
    connect_pty_session = staticmethod(core.unsupported(*_PTY))
    list_pty_sessions = staticmethod(core.unsupported(*_PTY))
    get_pty_session_info = staticmethod(core.unsupported(*_PTY))
    kill_pty_session = staticmethod(core.unsupported(*_PTY))
    resize_pty_session = staticmethod(core.unsupported(*_PTY))
    _ENTRY = ("The image entrypoint session", "A Runtime image runs no entrypoint; start it with create_session.")
    get_entrypoint_session = staticmethod(core.unsupported(*_ENTRY))
    get_entrypoint_logs = staticmethod(core.unsupported(*_ENTRY))


class AsyncFileSystem:
    """``sandbox.fs``: Daytona's file calls over Runtime's files API.
    Relative paths resolve from the working directory, /workspace."""

    def __init__(self, sandbox: "AsyncSandbox") -> None:
        self._sandbox = sandbox

    async def _path(self, path: str) -> str:
        await self._sandbox._ensure_home(path)
        return core.resolve_path(path)

    async def _files(self) -> Any:
        return (await self._sandbox._live()).files

    async def _run(self, argv: List[str]) -> str:
        runtime = await self._sandbox._live()
        result = await _guard("sandbox", lambda: runtime.exec(argv))
        if result.exit_code != 0:
            message = result.stderr.strip() or f"{argv[0]} exited with {result.exit_code}"
            if "No such file or directory" in message:
                raise DaytonaFileNotFoundError(message, 404)
            raise DaytonaError(message, 400)
        return result.stdout

    async def create_folder(self, path: str, mode: str) -> None:
        await self._run(["mkdir", "-p", "-m", mode, "--", await self._path(path)])

    async def delete_file(self, path: str, recursive: bool = False) -> None:
        target = await self._path(path)
        files = await self._files()
        if not await _guard("file", lambda: files.remove(target, recursive=recursive)):
            raise DaytonaFileNotFoundError(f"{target} does not exist.", 404)

    async def download_file(self, remote_path: str, local_path: Optional[str] = None,
                            timeout: int = 30 * 60) -> Optional[bytes]:
        """The file's bytes, or with ``local_path``, the file written there."""
        from .._request_scope import request_scope
        if isinstance(local_path, (int, float)):
            timeout = local_path
            local_path = None
        with request_scope(timeout) as scope:
            target = await self._path(remote_path)
            files = await self._files()
            scope.remaining()
            if local_path is None:
                return bytes(await _guard("file", lambda: files.read(target)))
            # Streamed to disk, any size, checked against the file's length.
            await _guard("file", lambda: files.download(target, local_path))
        return None

    async def download_files(self, files: List[FileDownloadRequest], timeout: int = 30 * 60) -> List[FileDownloadResponse]:
        from .._request_scope import request_scope
        out = []
        with request_scope(timeout) as scope:
            for request in files:
                scope.remaining()
                try:
                    if request.destination:
                        await self.download_file(request.source, request.destination)
                        out.append(FileDownloadResponse(source=request.source, result=request.destination))
                    else:
                        out.append(FileDownloadResponse(source=request.source,
                                                        result=await self.download_file(request.source)))
                except DaytonaError as error:
                    # A batch deadline is a failed transfer, not a successful
                    # response containing one fabricated per-file error.
                    scope.remaining()
                    out.append(FileDownloadResponse(source=request.source, error=str(error)))
        return out

    async def find_files(self, path: str, pattern: str) -> List[Match]:
        target = await self._path(path)
        runtime = await self._sandbox._live()
        result = await _guard("sandbox", lambda: runtime.exec(
            ["grep", "-rnI", "--", pattern, target], on_stdout=core.whole_output))
        if result.exit_code not in (0, 1):
            raise DaytonaError(result.stderr.strip() or "grep failed", 400)
        return core.parse_matches(result.stdout)

    async def get_file_info(self, path: str) -> FileInfo:
        target = await self._path(path)
        files = await self._files()
        found = await _guard("file", lambda: files.stat(target))
        if not found.get("exists"):
            raise DaytonaFileNotFoundError(f"{target} does not exist.", 404)
        return core.file_info(found)

    async def list_files(self, path: str, depth: Optional[int] = None) -> List[FileInfo]:
        target = await self._path(path)
        files = await self._files()
        entries = await _guard("file", lambda: files.list(target, depth=depth or 1, hidden=True))
        return [core.file_info(entry) for entry in entries]

    async def move_files(self, source: str, destination: str) -> None:
        origin, target = await self._path(source), await self._path(destination)
        files = await self._files()
        await _guard("file", lambda: files.rename(origin, target, overwrite=True))

    async def replace_in_files(self, files: List[str], pattern: str, new_value: str) -> List[ReplaceResult]:
        api = await self._files()
        results = []
        for file in files:
            target = await self._path(file)
            try:
                text = bytes(await _guard("file", lambda: api.read(target))).decode()
                await _guard("file", lambda: api.write(target, text.replace(pattern, new_value)))
                results.append(ReplaceResult(file=file, success=True))
            except DaytonaError as error:
                results.append(ReplaceResult(file=file, success=False, error=str(error)))
        return results

    async def search_files(self, path: str, pattern: str) -> SearchFilesResponse:
        target = await self._path(path)
        files = await self._files()
        glob = pattern if "/" in pattern or pattern.startswith("**") else f"**/{pattern}"
        entries = await _guard("file", lambda: files.list(target, glob=glob, hidden=True))
        return SearchFilesResponse(files=[entry["path"] for entry in entries])

    async def set_file_permissions(self, path: str, mode: Optional[str] = None, owner: Optional[str] = None,
                                   group: Optional[str] = None) -> None:
        target = await self._path(path)
        if mode:
            await self._run(["chmod", mode, "--", target])
        if owner or group:
            await self._run(["sudo", "chown", f"{owner or ''}{':' + group if group else ''}", "--", target])

    async def upload_file(self, file: Union[bytes, str], remote_path: str, timeout: int = 30 * 60) -> None:
        """Writes bytes (or a local file, given its path) to the sandbox."""
        target = await self._path(remote_path)
        if isinstance(file, str):
            with open(file, "rb") as handle:
                data = handle.read()
        else:
            data = bytes(file)
        files = await self._files()
        await _guard("file", lambda: files.write(target, data))

    async def upload_files(self, files: List[FileUpload], timeout: int = 30 * 60) -> None:
        for upload in files:
            await self.upload_file(upload.source, upload.destination)


class AsyncGit:
    """``sandbox.git``: Daytona's git calls, run with the git in the sandbox."""

    def __init__(self, sandbox: "AsyncSandbox") -> None:
        self._sandbox = sandbox

    async def _git(self, args: List[str], username: Optional[str] = None, password: Optional[str] = None) -> str:
        runtime = await self._sandbox._live()
        auth = username is not None or password is not None
        env = {"GIT_TERMINAL_PROMPT": "0", **({"GIT_USER": username or "git", "GIT_PASS": password or ""}
                                              if auth else {})}
        argv = ["git", *(["-c", core.GIT_HELPER] if auth else []), *args]
        result = await _guard("sandbox", lambda: runtime.exec(argv, env=env, timeout_ms=600_000))
        if result.exit_code != 0:
            raise core.git_failure(result.stderr, f"git {args[0]} failed")
        return result.stdout

    async def _repo(self, path: str) -> str:
        await self._sandbox._ensure_home(path)
        return core.resolve_path(path)

    async def clone(self, url: str, path: str, branch: Optional[str] = None, commit_id: Optional[str] = None,
                    username: Optional[str] = None, password: Optional[str] = None) -> None:
        target = await self._repo(path)
        await self._git(["clone", *(["--branch", branch] if branch else []), "--", url, target], username, password)
        if commit_id:
            await self._git(["-C", target, "checkout", commit_id])

    async def add(self, path: str, files: List[str]) -> None:
        await self._git(["-C", await self._repo(path), "add", "--", *files])

    async def branches(self, path: str) -> ListBranchResponse:
        out = await self._git(["-C", await self._repo(path), "branch", "--format=%(refname:short)"])
        return ListBranchResponse(branches=[line for line in out.split("\n") if line])

    async def create_branch(self, path: str, name: str) -> None:
        await self._git(["-C", await self._repo(path), "switch", "-c", name])

    async def checkout_branch(self, path: str, branch: str) -> None:
        await self._git(["-C", await self._repo(path), "checkout", branch])

    async def delete_branch(self, path: str, name: str) -> None:
        await self._git(["-C", await self._repo(path), "branch", "-D", name])

    async def commit(self, path: str, message: str, author: str, email: str,
                     allow_empty: bool = False) -> GitCommitResponse:
        repo = await self._repo(path)
        await self._git(["-C", repo, "-c", f"user.name={author}", "-c", f"user.email={email}", "commit", "-m",
                         message, *(["--allow-empty"] if allow_empty else [])])
        return GitCommitResponse(sha=(await self._git(["-C", repo, "rev-parse", "HEAD"])).strip())

    async def push(self, path: str, username: Optional[str] = None, password: Optional[str] = None) -> None:
        await self._git(["-C", await self._repo(path), "push"], username, password)

    async def pull(self, path: str, username: Optional[str] = None, password: Optional[str] = None) -> None:
        await self._git(["-C", await self._repo(path), "pull"], username, password)

    async def status(self, path: str) -> GitStatus:
        return core.git_status(await self._git(["-C", await self._repo(path), "status", "--porcelain=v1", "--branch"]))


class AsyncCodeInterpreter:
    """``sandbox.code_interpreter``: Daytona's stateful Python over Runtime's
    interpreter. The sandbox's env_vars reach code through a context made
    once for them."""

    def __init__(self, sandbox: "AsyncSandbox") -> None:
        self._sandbox = sandbox
        self._env_context: Optional[str] = None

    async def _default_context(self) -> str:
        env = self._sandbox.env
        if not env:
            return "python"
        if self._env_context is None:
            runtime = await self._sandbox._live()
            made = await _guard("sandbox", lambda: runtime.interpreter.contexts.create(
                language="python", cwd=core.HOME, env=dict(env)))
            self._env_context = made["id"]
        return self._env_context

    async def run_code(self, code: str, context: Optional[InterpreterContext] = None, on_stdout: Any = None,
                       on_stderr: Any = None, on_error: Any = None, envs: Optional[Dict[str, str]] = None,
                       timeout: Optional[int] = None) -> ExecutionResult:
        if envs:
            raise NotSupportedError("Per-run environment variables (run_code envs)",
                                    "Pass env_vars when creating the sandbox, or set os.environ in the code.")
        runtime = await self._sandbox._live()
        context_id = context.id if context else await self._default_context()
        execution = await _guard("sandbox", lambda: runtime.interpreter.run(
            code, language="python", context=context_id, timeout_ms=int(timeout * 1000) if timeout else None,
            on_stdout=(lambda text: on_stdout(OutputMessage(output=text))) if on_stdout else None,
            on_stderr=(lambda text: on_stderr(OutputMessage(output=text))) if on_stderr else None,
            on_error=(lambda err: on_error(ExecutionError(**err))) if on_error else None))
        error = execution.get("error")
        return ExecutionResult(stdout=execution.get("stdout", ""), stderr=execution.get("stderr", ""),
                               error=ExecutionError(**error) if error else None)

    async def create_context(self, cwd: Optional[str] = None) -> InterpreterContext:
        runtime = await self._sandbox._live()
        env = self._sandbox.env
        made = await _guard("sandbox", lambda: runtime.interpreter.contexts.create(
            language="python", cwd=cwd or core.HOME, env=dict(env) if env else None))
        return InterpreterContext(id=made["id"], cwd=made.get("cwd", cwd or core.HOME))

    async def list_contexts(self) -> List[InterpreterContext]:
        runtime = await self._sandbox._live()
        return [InterpreterContext(id=one["id"], cwd=one.get("cwd", core.HOME))
                for one in await _guard("sandbox", lambda: runtime.interpreter.contexts.list())]

    async def delete_context(self, context: InterpreterContext) -> None:
        runtime = await self._sandbox._live()
        await _guard("sandbox", lambda: runtime.interpreter.contexts.remove(context.id))


class AsyncSandbox:
    """A sandbox with Daytona's fields and methods. ``sandbox.withruntime`` is
    the Runtime sandbox underneath, for anything Daytona has no name for."""

    def __init__(self, runtime: Any, client: AsyncRuntime, env: Optional[Dict[str, str]] = None,
                 language: Optional[str] = None, public: bool = False, lifecycle: Optional[core.Lifecycle] = None,
                 snapshot: Optional[str] = None) -> None:
        self.withruntime = runtime
        self._client = client
        self.env: Dict[str, str] = dict(env or {})
        self._language = language or (runtime.info.get("labels") or {}).get(core.LANGUAGE_LABEL, "python")
        self.public = public
        self.snapshot = snapshot
        timeout = int(runtime.info.get("timeoutSeconds") or 900)
        self._lifecycle = lifecycle or core.Lifecycle(
            window_seconds=timeout, ephemeral=runtime.info.get("onLeaseEnd") == "stop",
            auto_stop_interval=round(timeout / 60), auto_archive_interval=0, auto_delete_interval=-1)
        self._home_linked = False
        self._paused_by_pause = False
        self.process = AsyncProcess(self)
        self.fs = AsyncFileSystem(self)
        self.git = AsyncGit(self)
        self.code_interpreter = AsyncCodeInterpreter(self)

    @property
    def id(self) -> str:
        return self.withruntime.id

    @property
    def name(self) -> str:
        return self.withruntime.info.get("name") or self.withruntime.id

    @property
    def user(self) -> str:
        """Daytona's user name, so /home/<user> leads to the working directory."""
        return "daytona"

    @property
    def labels(self) -> Dict[str, str]:
        return dict(self.withruntime.info.get("labels") or {})

    @property
    def target(self) -> str:
        return "us"

    @property
    def cpu(self) -> int:
        return int(self.withruntime.info.get("vcpu", 0))

    @property
    def gpu(self) -> int:
        return 0

    @property
    def memory(self) -> float:
        """GiB."""
        return int(self.withruntime.info.get("memoryMiB", 0)) / 1024

    @property
    def disk(self) -> float:
        """GiB."""
        return int(self.withruntime.info.get("diskMiB", 0)) / 1024

    @property
    def state(self) -> SandboxState:
        return core.state_of(self.withruntime.state, self._paused_by_pause)

    @property
    def auto_stop_interval(self) -> int:
        return self._lifecycle.auto_stop_interval

    @property
    def auto_archive_interval(self) -> int:
        return self._lifecycle.auto_archive_interval

    @property
    def auto_delete_interval(self) -> int:
        return self._lifecycle.auto_delete_interval

    @property
    def created_at(self) -> str:
        return self.withruntime.info.get("createdAt", "")

    async def _live(self, force: bool = False) -> Any:
        """The sandbox, its lease moved on when less than half the autoStop
        window is left: a call through this object counts as activity."""
        runtime = self.withruntime
        if runtime.state != "running":
            return runtime
        left = core._date_seconds(runtime.info.get("expiresAt")) - time.time()
        window = self._lifecycle.window_seconds
        if not force and left > window / 2:
            return runtime
        seconds = int(window - left) + 1
        if self._lifecycle.deadline is not None:
            seconds = min(seconds, int(self._lifecycle.deadline - time.time() - left))
        if seconds < 1:
            return runtime
        try:
            await runtime.extend(seconds)
        except Exception as error:  # noqa: BLE001
            if getattr(error, "status", None) != 409:
                raise translate(error, "sandbox") from error
            try:
                await runtime.refresh()
            except Exception:  # noqa: BLE001
                pass
        return runtime

    async def _ensure_home(self, text: Optional[str]) -> None:
        if self._home_linked or not text or core.DAYTONA_HOME not in text:
            return
        self._home_linked = True
        runtime = await self._live()
        try:
            await runtime.exec(core.HOME_LINK)
        except Exception:  # noqa: BLE001 - the command that named the path reports what is wrong
            pass

    # ---- lifecycle -------------------------------------------------------------

    async def start(self, timeout: Optional[float] = 60) -> None:
        """Wakes a stopped (paused) sandbox, with its files and memory."""
        await _guard("sandbox", lambda: self.withruntime.refresh())
        state = self.withruntime.state
        if state in ("stopped", "stopping"):
            raise DaytonaError(f"Sandbox {self.id} was deleted and cannot start.", 410)
        if state in ("paused", "pausing"):
            await _guard("sandbox", lambda: self.withruntime.wake(timeout_seconds=self._lifecycle.window_seconds))
        self._paused_by_pause = False

    async def stop(self, timeout: Optional[float] = 60, force: bool = False) -> None:
        """Pauses the sandbox, keeping files and memory; start() carries on.
        An ephemeral sandbox ends instead."""
        await _guard("sandbox", lambda: self.withruntime.refresh())
        state = self.withruntime.state
        if state in ("stopped", "stopping"):
            return
        if self._lifecycle.ephemeral:
            await _guard("sandbox", lambda: self.withruntime.stop())
            return
        if state != "paused":
            await _guard("sandbox", lambda: self.withruntime.pause())
        self._paused_by_pause = False

    async def pause(self, timeout: float = 60) -> None:
        await _guard("sandbox", lambda: self.withruntime.refresh())
        if self.withruntime.state == "running":
            await _guard("sandbox", lambda: self.withruntime.pause())
        self._paused_by_pause = True

    async def archive(self) -> None:
        """Runtime has no archive tier: the sandbox stays paused for its retention."""
        await self.stop()

    async def delete(self, timeout: float = 60) -> None:
        """Ends the sandbox for good."""
        await _guard("sandbox", lambda: self.withruntime.refresh())
        if self.withruntime.state != "stopped":
            await _guard("sandbox", lambda: self.withruntime.stop(wait=False))

    async def wait_for_sandbox_start(self, timeout: float = 60) -> None:
        await _guard("sandbox", lambda: self.withruntime.wait_for("running", int(timeout or 60)))

    async def wait_for_sandbox_stop(self, timeout: float = 60) -> None:
        await _guard("sandbox", lambda: self.withruntime.wait_for("paused", int(timeout or 60)))

    async def refresh_data(self) -> None:
        await _guard("sandbox", lambda: self.withruntime.refresh())

    async def refresh_activity(self) -> None:
        await self._live(force=True)

    async def set_autostop_interval(self, interval: int) -> None:
        self._lifecycle.auto_stop_interval = interval
        self._lifecycle.window_seconds = core.window_seconds(interval)
        await self._live()

    async def set_auto_pause_interval(self, interval: int) -> None:
        await self.set_autostop_interval(interval)

    async def set_auto_archive_interval(self, interval: int) -> None:
        """Runtime has no archive tier; recorded only."""
        self._lifecycle.auto_archive_interval = interval

    async def set_auto_delete_interval(self, interval: int) -> None:
        self._lifecycle.auto_delete_interval = interval
        self._lifecycle.ephemeral = interval == 0
        if interval > 0:
            await _guard("sandbox", lambda: self.withruntime.set_retention(core.retention_days(interval)))

    async def update_env(self, env: Dict[str, str], unset: Optional[List[str]] = None) -> None:
        self.env.update(env)
        for name in unset or []:
            self.env.pop(name, None)

    async def update_network_settings(self, network_block_all: Optional[bool] = None,
                                      network_allow_list: Optional[str] = None,
                                      domain_allow_list: Optional[str] = None) -> None:
        rules = core.network_rules(network_block_all, network_allow_list, domain_allow_list) or {"internet": True}
        runtime = await self._live()
        await _guard("sandbox", lambda: runtime.network.set(**rules))

    async def get_preview_link(self, port: int) -> PortPreviewUrl:
        """Public when created with public=True, else private with a token."""
        runtime = await self._live()
        preview = await _guard("sandbox", lambda: runtime.previews.create(
            port, visibility="public" if self.public else "private"))
        return PortPreviewUrl(url=preview["url"].rstrip("/"), token=preview.get("token") or "", sandbox_id=self.id,
                              port=port)

    async def get_user_home_dir(self) -> str:
        return core.HOME

    async def get_user_root_dir(self) -> str:
        return core.HOME

    async def get_work_dir(self) -> str:
        return core.HOME

    async def fork(self, name: Optional[str] = None, timeout: Optional[float] = 60) -> "AsyncSandbox":
        """A copy with this sandbox's files, memory and running processes."""
        copy = await _guard("sandbox", lambda: self.withruntime.fork(name=name))
        return type(self)(copy, self._client, self.env, self._language, self.public,
                          core.Lifecycle(**vars(self._lifecycle)))

    async def create_snapshot(self, name: str, timeout: Optional[float] = 60) -> None:
        """Keeps this sandbox as a Runtime snapshot named ``name``;
        create(CreateSandboxFromSnapshotParams(snapshot=name)) starts from it."""
        await _guard("sandbox", lambda: self.withruntime.snapshot(name=name))

    async def __aenter__(self) -> Any:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.delete()

    @property
    def computer_use(self) -> Any:
        raise NotSupportedError("Daytona's computer use",
                                "Use Runtime's desktop through sandbox.withruntime.desktop.")

    async def set_labels(self, labels: Dict[str, str], request_timeout: Optional[float] = None) -> Dict[str, str]:
        from .._request_scope import request_scope
        internal = {key: value for key, value in self.labels.items()
                    if key == core.LANGUAGE_LABEL or key.startswith("compat.")}
        timeout = max(1, request_timeout) if request_timeout is not None and request_timeout > 0 else request_timeout
        with request_scope(timeout):
            await _guard("sandbox", lambda: self.withruntime.update(labels={**labels, **internal}))
        return self.labels
    recover = staticmethod(core.unsupported("Recovering a failed sandbox", "Create a new sandbox."))
    resize = staticmethod(core.unsupported("Resizing a sandbox", "Create a new one with the resources you need."))
    get_metrics = staticmethod(core.unsupported("Sandbox metrics", "Use `sandbox.withruntime.metrics(range=\"1h\")` for its CPU and memory over time."))
    get_metrics_latest = get_metrics
    set_ttl = staticmethod(core.unsupported("Changing the time to live after create",
                                            "Pass ttl_minutes when creating the sandbox."))
    create_lsp_server = staticmethod(core.unsupported(
        "Daytona's language servers", "Start one in a session with process.execute_session_command(..., run_async)."))
    update_secrets = staticmethod(core.unsupported("Daytona secrets", "Use a Runtime secret: `npx withruntime secrets set NAME --host api.example.com`. The sandbox sees a placeholder, and the egress proxy adds the value on HTTPS to that host."))
    create_signed_preview_url = staticmethod(core.unsupported(
        "Signed preview URLs", "Use get_preview_link(port) and send its token as x-runtime-preview-token, or "
        "create the sandbox with public=True."))
    expire_signed_preview_url = create_signed_preview_url
    rotate_signing_key = staticmethod(core.unsupported(
        "Rotating the preview signing key", "Use sandbox.withruntime.previews.rotate(port)."))
    upload_url = staticmethod(core.unsupported("Signed upload URLs", "Use sandbox.fs.upload_file(data, path)."))
    download_url = staticmethod(core.unsupported("Signed download URLs", "Use sandbox.fs.download_file(path)."))
    create_ssh_access = staticmethod(core.unsupported("SSH access", "Use `npx withruntime sandbox ssh <id>` (also VS Code and JetBrains)."))
    revoke_ssh_access = create_ssh_access
    validate_ssh_access = create_ssh_access


class AsyncSnapshotService:
    """``daytona.snapshot``: Daytona snapshots as Runtime images."""

    def __init__(self, client: AsyncRuntime) -> None:
        self._client = client

    async def list(self, page: Optional[int] = None, limit: Optional[int] = None) -> PaginatedSnapshots:
        listing = await _guard("other", lambda: self._client.images.list())
        items = [_snapshot(one) for one in await listing.to_list() if one.get("state") != "deleted"]
        size, number = limit or 100, page or 1
        return PaginatedSnapshots(items=items[(number - 1) * size:number * size], total=len(items), page=number,
                                  total_pages=max(1, -(-len(items) // size)))

    async def get(self, name: str) -> Snapshot:
        if core.UUID.match(name):
            return _snapshot(await _guard("other", lambda: self._client.images.get(name)))
        listing = await _guard("other", lambda: self._client.images.list(name=core.image_name(name), limit=1))
        if not listing.data:
            raise DaytonaNotFoundError(f"Snapshot {name} was not found.", 404)
        return _snapshot(listing.data[0])

    async def create(self, params: CreateSnapshotParams, *, on_logs: Optional[Callable[[str], None]] = None,
                     timeout: Optional[float] = 0) -> Snapshot:
        if params.resources is not None:
            raise NotSupportedError("Resources on a snapshot", "Pass resources when creating each sandbox from it.")
        if params.entrypoint is not None:
            raise NotSupportedError("An entrypoint on a snapshot", "Start the program in a session after create.")
        return _snapshot(await _image_for(self._client, params.image, on_logs, core.image_name(params.name)))

    async def delete(self, snapshot: Union[Snapshot, str]) -> None:
        found = await self.get(snapshot) if isinstance(snapshot, str) else snapshot
        await _guard("other", lambda: self._client.images.delete(found.id))

    async def activate(self, snapshot: Union[Snapshot, str]) -> Snapshot:
        """Runtime images do not go inactive: returns the snapshot as it is."""
        return await self.get(snapshot if isinstance(snapshot, str) else snapshot.id)


class AsyncVolumeService:
    """``daytona.volume``: Daytona volumes as Runtime volumes."""

    def __init__(self, client: AsyncRuntime) -> None:
        self._client = client

    async def list(self) -> List[Volume]:
        listing = await _guard("other", lambda: self._client.volumes.list())
        return [_volume(one) for one in await listing.to_list() if one.get("state") != "deleted"]

    async def get(self, name: str, create: bool = False) -> Volume:
        listing = await _guard("other", lambda: self._client.volumes.list(name=name, limit=1))
        if listing.data:
            return _volume(listing.data[0])
        if create:
            return await self.create(name)
        raise DaytonaNotFoundError(f"Volume {name} was not found.", 404)

    async def create(self, name: str) -> Volume:
        raise NotSupportedError(f"Creating the volume {name} without a size",
                                f'Runtime volumes have a fixed size: runtime.volumes.create(10240, name="{name}"), '
                                "then mount it by name.")

    async def delete(self, volume: Volume) -> None:
        await _guard("other", lambda: self._client.volumes.delete(volume.id))


def _snapshot(image: Dict[str, Any]) -> Snapshot:
    state = {"ready": "active", "failed": "error", "deleting": "removing", "deleted": "removing",
             "queued": "pending"}.get(image.get("state", ""), "building")
    size = image.get("sizeBytes")
    return Snapshot(id=image["id"], name=image.get("name") or image["id"], image_name=image.get("name") or image["id"],
                    state=state, size=None if size is None else size / 1_073_741_824, error_reason=image.get("error"),
                    created_at=image.get("createdAt", ""), updated_at=image.get("readyAt") or image.get("createdAt", ""))


def _volume(volume: Dict[str, Any]) -> Volume:
    return Volume(id=volume["id"], name=volume.get("name") or volume["id"], state=volume.get("state", ""),
                  created_at=volume.get("createdAt", ""), error_reason=volume.get("error"))


async def _image_for(client: AsyncRuntime, image: Any, on_logs: Optional[Callable[[str], None]],
                     name: Optional[str] = None) -> Dict[str, Any]:
    """Builds (or finds, when built before) the Runtime image for a registry
    reference or a Daytona Image."""
    built = None if isinstance(image, str) else image.build()
    wanted = name or (built["name"] if built else core.image_name(image))
    listing = await _guard("other", lambda: client.images.list(name=wanted, state="ready", limit=1))
    if listing.data:
        return listing.data[0]
    fields: Dict[str, Any] = ({"dockerfile": built["dockerfile"], "files": built["files"]} if built
                              else {"image": image})
    on_log = (lambda line: on_logs(f"{line.get('text', '')}\n")) if on_logs else None
    return await _guard("other", lambda: client.images.build(name=wanted, on_log=on_log, **fields))


class AsyncDaytona:
    """Daytona's client. Uses RUNTIME_API_KEY (or a Runtime key in api_key or
    DAYTONA_API_KEY, or the saved `npx withruntime login`)."""

    def __init__(self, config: Optional[DaytonaConfig] = None, *, client: Optional[AsyncRuntime] = None,
                 runtime_create: Optional[Dict[str, Any]] = None) -> None:
        self._client = _client(config, client)
        self._runtime_create = dict(runtime_create or {})
        self.snapshot = AsyncSnapshotService(self._client)
        self.volume = AsyncVolumeService(self._client)
        self.default_language = "python"

    async def __aenter__(self) -> Any:
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    async def close(self) -> None:
        return None

    async def create(self, params: Union[CreateSandboxFromSnapshotParams, CreateSandboxFromImageParams, None] = None,
                     *, timeout: float = 60, on_snapshot_create_logs: Optional[Callable[[str], None]] = None,
                     runtime_create: Optional[Dict[str, Any]] = None) -> AsyncSandbox:
        """Creates a sandbox with Daytona's defaults (1 vCPU, 1 GiB, 3 GiB
        disk, pausing after 15 minutes without calls). Funding is left to
        Runtime: the free trial while the account has trial time, then prepaid
        credit. ``runtime_create`` passes Runtime fields (snake_case)."""
        params = params or CreateSandboxFromSnapshotParams()
        core.refuse_create(params)
        lifecycle = core.lifecycle_of(params)
        resources = getattr(params, "resources", None) or core.Resources()
        source = await self._source(params, on_snapshot_create_logs)
        volumes = await self._volumes(params.volumes)
        fields: Dict[str, Any] = {}
        if "snapshot" not in source:
            fields.update(vcpu=resources.cpu or core.DEFAULT_CPU,
                          memory_mib=int((resources.memory or core.DEFAULT_MEMORY_GIB) * 1024),
                          disk_mib=int((resources.disk or core.DEFAULT_DISK_GIB) * 1024))
        timeout_seconds = lifecycle.window_seconds
        if lifecycle.deadline is not None:
            timeout_seconds = max(60, min(timeout_seconds, int(lifecycle.deadline - time.time())))
        fields.update(timeout_seconds=timeout_seconds,
                      on_lease_end="stop" if lifecycle.ephemeral or lifecycle.deadline else "pause")
        if params.name:
            fields["name"] = params.name
        language = str(getattr(params.language, "value", params.language) or self.default_language)
        labels = dict(params.labels or {})
        if language != "python":
            # Daytona keeps the language in this label, so a sandbox found later
            # runs code_run in the language it was made for.
            labels[core.LANGUAGE_LABEL] = language
        if labels:
            fields["labels"] = labels
        network = core.network_rules(params.network_block_all, params.network_allow_list, params.domain_allow_list)
        if network:
            fields["network"] = network
        if volumes:
            fields["volumes"] = volumes
        fields.update(source)
        fields.update(self._runtime_create)
        fields.update(runtime_create or {})
        runtime = await _guard("sandbox", lambda: self._client.sandboxes.create(**fields))
        if lifecycle.auto_delete_interval > 0:
            try:
                await _guard("sandbox", lambda: runtime.set_retention(core.retention_days(lifecycle.auto_delete_interval)))
            except BaseException as original:
                try:
                    await runtime.stop(wait=False)
                except BaseException as cleanup:
                    raise original from cleanup
                raise
        env = dict(params.env_vars or {})
        if params.outbound_proxy_url:
            env.update(HTTP_PROXY=params.outbound_proxy_url, HTTPS_PROXY=params.outbound_proxy_url)
        return AsyncSandbox(runtime, self._client, env, language, bool(params.public), lifecycle,
                            getattr(params, "snapshot", None))

    async def _source(self, params: Any, on_logs: Optional[Callable[[str], None]]) -> Dict[str, Any]:
        image = getattr(params, "image", None)
        if image is not None:
            return {"image": (await _image_for(self._client, image, on_logs))["id"]}
        name = getattr(params, "snapshot", None)
        if name is None or core.STOCK_SNAPSHOT.match(name):
            return {}
        if core.UUID.match(name):
            try:
                await self._client.images.get(name)
                return {"image": name}
            except Exception as error:  # noqa: BLE001
                if getattr(error, "status", None) != 404:
                    raise translate(error) from error
            return {"snapshot": name}
        images = await _guard("other", lambda: self._client.images.list(name=core.image_name(name), state="ready",
                                                                          limit=1))
        if images.data:
            return {"image": images.data[0]["id"]}
        snapshots = await _guard("other", lambda: self._client.snapshots.list(name=name, state="ready", limit=1))
        if snapshots.data:
            return {"snapshot": snapshots.data[0]["id"]}
        raise DaytonaNotFoundError(
            f'No Runtime image or snapshot is named "{name}". Daytona snapshots do not move to Runtime; build the '
            f'same environment as a Runtime image with that name: daytona.snapshot.create(CreateSnapshotParams('
            f'name="{name}", image=...)), or `npx withruntime image build --dockerfile Dockerfile --name '
            f'{core.image_name(name)}`.', 404)

    async def _volumes(self, mounts: Optional[List[Any]]) -> List[Dict[str, str]]:
        out = []
        for mount in mounts or []:
            if mount.subpath:
                raise NotSupportedError("Mounting part of a volume (subpath)", "Mount the whole volume.")
            volume_id = mount.volume_id
            if not core.UUID.match(volume_id):
                listing = await _guard("other", lambda: self._client.volumes.list(name=volume_id, limit=1))
                if not listing.data:
                    raise DaytonaNotFoundError(f"Volume {volume_id} was not found.", 404)
                volume_id = listing.data[0]["id"]
            out.append({"volume_id": volume_id, "path": mount.mount_path})
        return out

    async def get(self, sandbox_id_or_name: str) -> AsyncSandbox:
        """A sandbox by id or name."""
        if core.UUID.match(sandbox_id_or_name):
            runtime = await _guard("sandbox", lambda: self._client.sandboxes.get(sandbox_id_or_name))
        else:
            listing = await _guard("other", lambda: self._client.sandboxes.list(name=sandbox_id_or_name))
            found = await listing.to_list()
            if not found:
                raise DaytonaNotFoundError(f"Sandbox {sandbox_id_or_name} was not found.", 404)
            runtime = found[-1]
        return AsyncSandbox(runtime, self._client)

    async def list(self, query: Optional[ListSandboxesQuery] = None) -> Any:
        """Live and stopped (paused) sandboxes, oldest first."""
        query = query or ListSandboxesQuery()
        for name in ("id", "snapshots", "targets", "min_cpu", "max_cpu"):
            if getattr(query, name) is not None:
                raise NotSupportedError(f"Listing sandboxes by {name}",
                                        "Filter by name, labels or states, and narrow the result yourself.")
        states = None if query.states is None else [
            one for state in query.states for one in core.RUNTIME_STATES.get(str(getattr(state, "value", state)), [])]
        listing = await _guard("other", lambda: self._client.sandboxes.list(
            state=states, labels=query.labels, name=query.name, limit=min(query.limit, 100) if query.limit else None))
        for runtime in await listing.to_list():
            yield AsyncSandbox(runtime, self._client)

    async def start(self, sandbox: AsyncSandbox, timeout: float = 60) -> None:
        await sandbox.start(timeout)

    async def stop(self, sandbox: AsyncSandbox, timeout: float = 60) -> None:
        await sandbox.stop(timeout)

    async def delete(self, sandbox: AsyncSandbox, timeout: float = 60, wait: bool = False) -> None:
        await sandbox.delete(timeout)

    async def remove(self, sandbox: AsyncSandbox, timeout: float = 60) -> None:
        """Daytona's older name for delete."""
        await sandbox.delete(timeout)


__all__ = ["AsyncDaytona", "AsyncSandbox", "AsyncProcess", "AsyncFileSystem", "AsyncGit", "AsyncCodeInterpreter",
           "AsyncSnapshotService", "AsyncVolumeService"]
