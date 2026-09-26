"""GENERATED from daytona/_async_daytona.py by scripts/generate_dropin_sync.py. Do not edit."""
from __future__ import annotations

import base64
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Union

from .._sync_client import Runtime

from . import _core as core
from ._sync_io import call, catch_up, finish, start
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


def _client(config: Optional[DaytonaConfig], client: Optional[Runtime]) -> Runtime:
    core.check_config(config)
    if client is not None:
        return client
    key = core.pick_key(config.api_key if config else None)
    found = _clients.get(key or "")
    if found is None:
        found = Runtime(api_key=key) if key else Runtime()
        _clients[key or ""] = found
    return found


def _guard(subject: str, work: Callable[[], Any]) -> Any:
    try:
        return work()
    except Exception as error:  # noqa: BLE001 - every Runtime error becomes Daytona's
        raise translate(error, subject) from error


class _Shell:
    """A session's bash and the commands sent to it."""

    def __init__(self, session_id: str, process: Any, cursor: int) -> None:
        self.id, self.process, self.cursor = session_id, process, cursor
        self.commands: List[core.SessionCommand] = []
        self.ended = False
        self.pending: Optional[core.SessionCommand] = None


class Process:
    """``sandbox.process``: Daytona's commands, code runs and sessions over
    Runtime's exec and processes."""

    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox
        self._sessions: Dict[str, _Shell] = {}

    def _env(self, extra: Optional[Dict[str, str]] = None) -> Optional[Dict[str, str]]:
        merged = {**self._sandbox.env, **(extra or {})}
        return merged or None

    def exec(self, command: str, cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None,
                   timeout: Optional[int] = None) -> ExecuteResponse:
        """Runs a shell command. A non-zero exit is a result, not an error.
        ``timeout`` is in seconds; past it DaytonaProcessExecutionTimeoutError."""
        self._sandbox._ensure_home(f"{command}\n{cwd or ''}")
        runtime = self._sandbox._live()
        timeout_ms = int(timeout * 1000) if timeout else core.LONGEST_MS
        result = _guard("sandbox", lambda: runtime.exec(
            f"{{ {command}\n}} 2>&1", cwd=core.HOME if cwd is None else core.resolve_path(cwd), env=self._env(env),
            timeout_ms=timeout_ms, on_stdout=core.whole_output))
        if result.timed_out:
            raise DaytonaProcessExecutionTimeoutError(f"Command timed out after {timeout} s.", 408)
        output = result.stdout + result.stderr
        return ExecuteResponse(exit_code=-1 if result.exit_code is None else result.exit_code, result=output,
                               artifacts=ExecutionArtifacts(stdout=output))

    def code_run(self, code: str, params: Optional[CodeRunParams] = None,
                       timeout: Optional[int] = None) -> ExecuteResponse:
        """Runs code in the sandbox's language as a fresh process. Charts are
        always empty on Runtime."""
        runtime = self._sandbox._live()
        language = self._sandbox._language
        interpreter = (["python3", "-c", code] if language == "python" else
                       ["bun", "-e", code] if language == "typescript" else ["node", "-e", code])
        argv = ["sh", "-c", 'exec "$@" 2>&1', "sh", *interpreter, *((params.argv if params else None) or [])]
        timeout_ms = int(timeout * 1000) if timeout else core.LONGEST_MS
        result = _guard("sandbox", lambda: runtime.exec(
            argv, cwd=core.HOME, env=self._env(params.env if params else None), timeout_ms=timeout_ms,
            on_stdout=core.whole_output))
        if result.timed_out:
            raise DaytonaProcessExecutionTimeoutError(f"Code run timed out after {timeout} s.", 408)
        return ExecuteResponse(exit_code=-1 if result.exit_code is None else result.exit_code, result=result.stdout,
                               artifacts=ExecutionArtifacts(stdout=result.stdout, charts=[]))

    # ---- sessions ----------------------------------------------------------------

    def create_session(self, session_id: str) -> None:
        """Starts a bash that keeps its directory and variables from one
        command to the next, running one command at a time."""
        if session_id in self._sessions or self._discover(session_id) is not None:
            raise DaytonaConflictError(f"Session {session_id} already exists.", 409)
        runtime = self._sandbox._live()
        process = _guard("sandbox", lambda: runtime.spawn(
            ["bash", "--noprofile", "--norc", "-s", f"{core.TAG}{session_id}"], cwd=core.HOME, env=self._env(),
            stdin="pipe", timeout_ms=core.LONGEST_MS))
        _guard("process", lambda: process.write(core.PRELUDE))
        self._sessions[session_id] = _Shell(session_id, process, 0)

    def _discover(self, session_id: str) -> Optional[_Shell]:
        """A session another client made on this sandbox, found by its tag."""
        runtime = self._sandbox._live()
        for info in _guard("sandbox", lambda: runtime.processes()):
            if info.get("state") == "running" and f"{core.TAG}{session_id}" in str(info.get("command", "")).split():
                process = _guard("process", lambda: runtime.process(info["id"]))
                shell = _Shell(session_id, process, int(info.get("outputBytes") or 0))
                self._sessions[session_id] = shell
                return shell
        return None

    def _shell(self, session_id: str) -> _Shell:
        shell = self._sessions.get(session_id) or self._discover(session_id)
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

    def _follow(self, shell: _Shell, command: core.SessionCommand) -> None:
        reader = core.MarkerReader(command.id)
        try:
            for event in shell.process.output(cursor=shell.cursor):
                if event["type"] == "exit":
                    shell.ended = True
                    for stream in ("stdout", "stderr"):
                        for handler, text in command.emit(stream, reader.flush(stream)):
                            call(handler, text)
                    command.exit_code = -1 if event.get("exitCode") is None else event["exitCode"]
                    return
                if event["type"] not in ("stdout", "stderr"):
                    continue
                shell.cursor = event["offset"] + len(event["data"].encode())
                for handler, text in command.emit(event["type"], reader.feed(event["type"], event["data"])):
                    call(handler, text)
                if reader.done:
                    command.exit_code = reader.exit_code
                    return
            shell.ended = True
        except Exception as error:  # noqa: BLE001
            raise translate(error, "process") from error
        finally:
            if shell.pending is command:
                shell.pending = None

    def _settle(self, shell: _Shell) -> None:
        """Waits for the command running in the session, if any."""
        pending = shell.pending
        if pending is not None and pending.task is not None:
            finish(pending.task)

    def execute_session_command(self, session_id: str, req: SessionExecuteRequest,
                                      timeout: Optional[int] = None) -> SessionExecuteResponse:
        """Runs a command in the session. It waits and returns the output and
        exit code, or with ``run_async=True`` returns the cmd_id at once."""
        shell = self._shell(session_id)
        self._sandbox._ensure_home(req.command)
        self._sandbox._live()
        self._settle(shell)
        if shell.ended:
            raise DaytonaSessionEndedError(f"Session {session_id} has ended.", 410)
        command = core.SessionCommand(str(uuid.uuid4()), req.command)
        shell.commands.append(command)
        encoded = base64.b64encode(req.command.encode()).decode()
        _guard("process", lambda: shell.process.write(f"__rt_run {encoded} {command.id}\n"))
        shell.pending = command
        command.task = start(lambda: self._follow(shell, command))
        if req.run_async or req.var_async:
            return SessionExecuteResponse(cmd_id=command.id)
        finish(command.task)
        return SessionExecuteResponse(cmd_id=command.id, output=command.output, stdout=command.stdout,
                                      stderr=command.stderr, exit_code=command.exit_code)

    def get_session(self, session_id: str) -> Session:
        shell = self._shell(session_id)
        return Session(session_id=session_id, commands=[one.describe() for one in shell.commands])

    def get_session_command(self, session_id: str, command_id: str) -> core.Command:
        command = self._command(self._shell(session_id), command_id)
        catch_up(command.task)
        return command.describe()

    def get_session_command_logs(self, session_id: str, command_id: str) -> SessionCommandLogsResponse:
        """The command's output so far. (The sync client reads a running
        command's output to its end first.)"""
        command = self._command(self._shell(session_id), command_id)
        catch_up(command.task)
        return SessionCommandLogsResponse(output=command.output, stdout=command.stdout, stderr=command.stderr)

    def _stream_logs(self, session_id: str, command_id: str, on_stdout: Any, on_stderr: Any) -> None:
        command = self._command(self._shell(session_id), command_id)
        if command.stdout:
            call(on_stdout, command.stdout)
        if command.stderr:
            call(on_stderr, command.stderr)
        listener = (on_stdout, on_stderr)
        command.listeners.append(listener)
        try:
            if command.task is not None:
                finish(command.task)
        finally:
            command.listeners.remove(listener)

    def get_session_command_logs_async(self, session_id: str, command_id: str, on_stdout: Any,
                                       on_stderr: Any) -> Any:
        """Awaitable: the command's output from its start, to the handlers, as
        it happens, until it ends."""
        from ._sync_io import awaitable
        return awaitable(lambda: self._stream_logs(session_id, command_id, on_stdout, on_stderr))

    def send_session_command_input(self, session_id: str, command_id: str, data: str) -> None:
        shell = self._shell(session_id)
        command = self._command(shell, command_id)
        if command.exit_code is not None:
            raise DaytonaCommandAlreadyCompletedError(f"Command {command_id} has already completed.", 410)
        _guard("process", lambda: shell.process.write(data))

    def list_sessions(self) -> List[Session]:
        return [Session(session_id=shell.id, commands=[one.describe() for one in shell.commands])
                for shell in self._sessions.values() if not shell.ended]

    def delete_session(self, session_id: str) -> None:
        shell = self._shell(session_id)
        shell.ended = True
        self._sessions.pop(session_id, None)
        _guard("process", lambda: shell.process.kill("SIGKILL"))

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


class FileSystem:
    """``sandbox.fs``: Daytona's file calls over Runtime's files API.
    Relative paths resolve from the working directory, /workspace."""

    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    def _path(self, path: str) -> str:
        self._sandbox._ensure_home(path)
        return core.resolve_path(path)

    def _files(self) -> Any:
        return (self._sandbox._live()).files

    def _run(self, argv: List[str]) -> str:
        runtime = self._sandbox._live()
        result = _guard("sandbox", lambda: runtime.exec(argv))
        if result.exit_code != 0:
            message = result.stderr.strip() or f"{argv[0]} exited with {result.exit_code}"
            if "No such file or directory" in message:
                raise DaytonaFileNotFoundError(message, 404)
            raise DaytonaError(message, 400)
        return result.stdout

    def create_folder(self, path: str, mode: str) -> None:
        self._run(["mkdir", "-p", "-m", mode, "--", self._path(path)])

    def delete_file(self, path: str, recursive: bool = False) -> None:
        target = self._path(path)
        files = self._files()
        if not _guard("file", lambda: files.remove(target, recursive=recursive)):
            raise DaytonaFileNotFoundError(f"{target} does not exist.", 404)

    def download_file(self, remote_path: str, local_path: Optional[str] = None,
                            timeout: int = 30 * 60) -> Optional[bytes]:
        """The file's bytes, or with ``local_path``, the file written there."""
        if isinstance(local_path, (int, float)):
            local_path = None
        target = self._path(remote_path)
        files = self._files()
        if local_path is None:
            return bytes(_guard("file", lambda: files.read(target)))
        # Streamed to disk, any size, checked against the file's length.
        _guard("file", lambda: files.download(target, local_path))
        return None

    def download_files(self, files: List[FileDownloadRequest], timeout: int = 30 * 60) -> List[FileDownloadResponse]:
        out = []
        for request in files:
            try:
                if request.destination:
                    self.download_file(request.source, request.destination)
                    out.append(FileDownloadResponse(source=request.source, result=request.destination))
                else:
                    out.append(FileDownloadResponse(source=request.source,
                                                    result=self.download_file(request.source)))
            except DaytonaError as error:
                out.append(FileDownloadResponse(source=request.source, error=str(error)))
        return out

    def find_files(self, path: str, pattern: str) -> List[Match]:
        target = self._path(path)
        runtime = self._sandbox._live()
        result = _guard("sandbox", lambda: runtime.exec(
            ["grep", "-rnI", "--", pattern, target], on_stdout=core.whole_output))
        if result.exit_code not in (0, 1):
            raise DaytonaError(result.stderr.strip() or "grep failed", 400)
        return core.parse_matches(result.stdout)

    def get_file_info(self, path: str) -> FileInfo:
        target = self._path(path)
        files = self._files()
        found = _guard("file", lambda: files.stat(target))
        if not found.get("exists"):
            raise DaytonaFileNotFoundError(f"{target} does not exist.", 404)
        return core.file_info(found)

    def list_files(self, path: str, depth: Optional[int] = None) -> List[FileInfo]:
        target = self._path(path)
        files = self._files()
        entries = _guard("file", lambda: files.list(target, depth=depth or 1, hidden=True))
        return [core.file_info(entry) for entry in entries]

    def move_files(self, source: str, destination: str) -> None:
        origin, target = self._path(source), self._path(destination)
        files = self._files()
        _guard("file", lambda: files.rename(origin, target, overwrite=True))

    def replace_in_files(self, files: List[str], pattern: str, new_value: str) -> List[ReplaceResult]:
        api = self._files()
        results = []
        for file in files:
            target = self._path(file)
            try:
                text = bytes(_guard("file", lambda: api.read(target))).decode()
                _guard("file", lambda: api.write(target, text.replace(pattern, new_value)))
                results.append(ReplaceResult(file=file, success=True))
            except DaytonaError as error:
                results.append(ReplaceResult(file=file, success=False, error=str(error)))
        return results

    def search_files(self, path: str, pattern: str) -> SearchFilesResponse:
        target = self._path(path)
        files = self._files()
        glob = pattern if "/" in pattern or pattern.startswith("**") else f"**/{pattern}"
        entries = _guard("file", lambda: files.list(target, glob=glob, hidden=True))
        return SearchFilesResponse(files=[entry["path"] for entry in entries])

    def set_file_permissions(self, path: str, mode: Optional[str] = None, owner: Optional[str] = None,
                                   group: Optional[str] = None) -> None:
        target = self._path(path)
        if mode:
            self._run(["chmod", mode, "--", target])
        if owner or group:
            self._run(["sudo", "chown", f"{owner or ''}{':' + group if group else ''}", "--", target])

    def upload_file(self, file: Union[bytes, str], remote_path: str, timeout: int = 30 * 60) -> None:
        """Writes bytes (or a local file, given its path) to the sandbox."""
        target = self._path(remote_path)
        if isinstance(file, str):
            with open(file, "rb") as handle:
                data = handle.read()
        else:
            data = bytes(file)
        files = self._files()
        _guard("file", lambda: files.write(target, data))

    def upload_files(self, files: List[FileUpload], timeout: int = 30 * 60) -> None:
        for upload in files:
            self.upload_file(upload.source, upload.destination)


class Git:
    """``sandbox.git``: Daytona's git calls, run with the git in the sandbox."""

    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox

    def _git(self, args: List[str], username: Optional[str] = None, password: Optional[str] = None) -> str:
        runtime = self._sandbox._live()
        auth = username is not None or password is not None
        env = {"GIT_TERMINAL_PROMPT": "0", **({"GIT_USER": username or "git", "GIT_PASS": password or ""}
                                              if auth else {})}
        argv = ["git", *(["-c", core.GIT_HELPER] if auth else []), *args]
        result = _guard("sandbox", lambda: runtime.exec(argv, env=env, timeout_ms=600_000))
        if result.exit_code != 0:
            raise core.git_failure(result.stderr, f"git {args[0]} failed")
        return result.stdout

    def _repo(self, path: str) -> str:
        self._sandbox._ensure_home(path)
        return core.resolve_path(path)

    def clone(self, url: str, path: str, branch: Optional[str] = None, commit_id: Optional[str] = None,
                    username: Optional[str] = None, password: Optional[str] = None) -> None:
        target = self._repo(path)
        self._git(["clone", *(["--branch", branch] if branch else []), "--", url, target], username, password)
        if commit_id:
            self._git(["-C", target, "checkout", commit_id])

    def add(self, path: str, files: List[str]) -> None:
        self._git(["-C", self._repo(path), "add", "--", *files])

    def branches(self, path: str) -> ListBranchResponse:
        out = self._git(["-C", self._repo(path), "branch", "--format=%(refname:short)"])
        return ListBranchResponse(branches=[line for line in out.split("\n") if line])

    def create_branch(self, path: str, name: str) -> None:
        self._git(["-C", self._repo(path), "switch", "-c", name])

    def checkout_branch(self, path: str, branch: str) -> None:
        self._git(["-C", self._repo(path), "checkout", branch])

    def delete_branch(self, path: str, name: str) -> None:
        self._git(["-C", self._repo(path), "branch", "-D", name])

    def commit(self, path: str, message: str, author: str, email: str,
                     allow_empty: bool = False) -> GitCommitResponse:
        repo = self._repo(path)
        self._git(["-C", repo, "-c", f"user.name={author}", "-c", f"user.email={email}", "commit", "-m",
                         message, *(["--allow-empty"] if allow_empty else [])])
        return GitCommitResponse(sha=(self._git(["-C", repo, "rev-parse", "HEAD"])).strip())

    def push(self, path: str, username: Optional[str] = None, password: Optional[str] = None) -> None:
        self._git(["-C", self._repo(path), "push"], username, password)

    def pull(self, path: str, username: Optional[str] = None, password: Optional[str] = None) -> None:
        self._git(["-C", self._repo(path), "pull"], username, password)

    def status(self, path: str) -> GitStatus:
        return core.git_status(self._git(["-C", self._repo(path), "status", "--porcelain=v1", "--branch"]))


class CodeInterpreter:
    """``sandbox.code_interpreter``: Daytona's stateful Python over Runtime's
    interpreter. The sandbox's env_vars reach code through a context made
    once for them."""

    def __init__(self, sandbox: "Sandbox") -> None:
        self._sandbox = sandbox
        self._env_context: Optional[str] = None

    def _default_context(self) -> str:
        env = self._sandbox.env
        if not env:
            return "python"
        if self._env_context is None:
            runtime = self._sandbox._live()
            made = _guard("sandbox", lambda: runtime.interpreter.contexts.create(
                language="python", cwd=core.HOME, env=dict(env)))
            self._env_context = made["id"]
        return self._env_context

    def run_code(self, code: str, context: Optional[InterpreterContext] = None, on_stdout: Any = None,
                       on_stderr: Any = None, on_error: Any = None, envs: Optional[Dict[str, str]] = None,
                       timeout: Optional[int] = None) -> ExecutionResult:
        if envs:
            raise NotSupportedError("Per-run environment variables (run_code envs)",
                                    "Pass env_vars when creating the sandbox, or set os.environ in the code.")
        runtime = self._sandbox._live()
        context_id = context.id if context else self._default_context()
        execution = _guard("sandbox", lambda: runtime.interpreter.run(
            code, language="python", context=context_id, timeout_ms=int(timeout * 1000) if timeout else None,
            on_stdout=(lambda text: on_stdout(OutputMessage(output=text))) if on_stdout else None,
            on_stderr=(lambda text: on_stderr(OutputMessage(output=text))) if on_stderr else None,
            on_error=(lambda err: on_error(ExecutionError(**err))) if on_error else None))
        error = execution.get("error")
        return ExecutionResult(stdout=execution.get("stdout", ""), stderr=execution.get("stderr", ""),
                               error=ExecutionError(**error) if error else None)

    def create_context(self, cwd: Optional[str] = None) -> InterpreterContext:
        runtime = self._sandbox._live()
        env = self._sandbox.env
        made = _guard("sandbox", lambda: runtime.interpreter.contexts.create(
            language="python", cwd=cwd or core.HOME, env=dict(env) if env else None))
        return InterpreterContext(id=made["id"], cwd=made.get("cwd", cwd or core.HOME))

    def list_contexts(self) -> List[InterpreterContext]:
        runtime = self._sandbox._live()
        return [InterpreterContext(id=one["id"], cwd=one.get("cwd", core.HOME))
                for one in _guard("sandbox", lambda: runtime.interpreter.contexts.list())]

    def delete_context(self, context: InterpreterContext) -> None:
        runtime = self._sandbox._live()
        _guard("sandbox", lambda: runtime.interpreter.contexts.remove(context.id))


class Sandbox:
    """A sandbox with Daytona's fields and methods. ``sandbox.withruntime`` is
    the Runtime sandbox underneath, for anything Daytona has no name for."""

    def __init__(self, runtime: Any, client: Runtime, env: Optional[Dict[str, str]] = None,
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
        self.process = Process(self)
        self.fs = FileSystem(self)
        self.git = Git(self)
        self.code_interpreter = CodeInterpreter(self)

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

    def _live(self, force: bool = False) -> Any:
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
            runtime.extend(seconds)
        except Exception as error:  # noqa: BLE001
            if getattr(error, "status", None) != 409:
                raise translate(error, "sandbox") from error
            try:
                runtime.refresh()
            except Exception:  # noqa: BLE001
                pass
        return runtime

    def _ensure_home(self, text: Optional[str]) -> None:
        if self._home_linked or not text or core.DAYTONA_HOME not in text:
            return
        self._home_linked = True
        runtime = self._live()
        try:
            runtime.exec(core.HOME_LINK)
        except Exception:  # noqa: BLE001 - the command that named the path reports what is wrong
            pass

    # ---- lifecycle -------------------------------------------------------------

    def start(self, timeout: Optional[float] = 60) -> None:
        """Wakes a stopped (paused) sandbox, with its files and memory."""
        _guard("sandbox", lambda: self.withruntime.refresh())
        state = self.withruntime.state
        if state in ("stopped", "stopping"):
            raise DaytonaError(f"Sandbox {self.id} was deleted and cannot start.", 410)
        if state in ("paused", "pausing"):
            _guard("sandbox", lambda: self.withruntime.wake(timeout_seconds=self._lifecycle.window_seconds))
        self._paused_by_pause = False

    def stop(self, timeout: Optional[float] = 60, force: bool = False) -> None:
        """Pauses the sandbox, keeping files and memory; start() carries on.
        An ephemeral sandbox ends instead."""
        _guard("sandbox", lambda: self.withruntime.refresh())
        state = self.withruntime.state
        if state in ("stopped", "stopping"):
            return
        if self._lifecycle.ephemeral:
            _guard("sandbox", lambda: self.withruntime.stop())
            return
        if state != "paused":
            _guard("sandbox", lambda: self.withruntime.pause())
        self._paused_by_pause = False

    def pause(self, timeout: float = 60) -> None:
        _guard("sandbox", lambda: self.withruntime.refresh())
        if self.withruntime.state == "running":
            _guard("sandbox", lambda: self.withruntime.pause())
        self._paused_by_pause = True

    def archive(self) -> None:
        """Runtime has no archive tier: the sandbox stays paused for its retention."""
        self.stop()

    def delete(self, timeout: float = 60) -> None:
        """Ends the sandbox for good."""
        _guard("sandbox", lambda: self.withruntime.refresh())
        if self.withruntime.state != "stopped":
            _guard("sandbox", lambda: self.withruntime.stop(wait=False))

    def wait_for_sandbox_start(self, timeout: float = 60) -> None:
        _guard("sandbox", lambda: self.withruntime.wait_for("running", int(timeout or 60)))

    def wait_for_sandbox_stop(self, timeout: float = 60) -> None:
        _guard("sandbox", lambda: self.withruntime.wait_for("paused", int(timeout or 60)))

    def refresh_data(self) -> None:
        _guard("sandbox", lambda: self.withruntime.refresh())

    def refresh_activity(self) -> None:
        self._live(force=True)

    def set_autostop_interval(self, interval: int) -> None:
        self._lifecycle.auto_stop_interval = interval
        self._lifecycle.window_seconds = core.window_seconds(interval)
        self._live()

    def set_auto_pause_interval(self, interval: int) -> None:
        self.set_autostop_interval(interval)

    def set_auto_archive_interval(self, interval: int) -> None:
        """Runtime has no archive tier; recorded only."""
        self._lifecycle.auto_archive_interval = interval

    def set_auto_delete_interval(self, interval: int) -> None:
        self._lifecycle.auto_delete_interval = interval
        self._lifecycle.ephemeral = interval == 0
        if interval > 0:
            _guard("sandbox", lambda: self.withruntime.set_retention(core.retention_days(interval)))

    def update_env(self, env: Dict[str, str], unset: Optional[List[str]] = None) -> None:
        self.env.update(env)
        for name in unset or []:
            self.env.pop(name, None)

    def update_network_settings(self, network_block_all: Optional[bool] = None,
                                      network_allow_list: Optional[str] = None,
                                      domain_allow_list: Optional[str] = None) -> None:
        rules = core.network_rules(network_block_all, network_allow_list, domain_allow_list) or {"internet": True}
        runtime = self._live()
        _guard("sandbox", lambda: runtime.network.set(**rules))

    def get_preview_link(self, port: int) -> PortPreviewUrl:
        """Public when created with public=True, else private with a token."""
        runtime = self._live()
        preview = _guard("sandbox", lambda: runtime.previews.create(
            port, visibility="public" if self.public else "private"))
        return PortPreviewUrl(url=preview["url"].rstrip("/"), token=preview.get("token") or "", sandbox_id=self.id,
                              port=port)

    def get_user_home_dir(self) -> str:
        return core.HOME

    def get_user_root_dir(self) -> str:
        return core.HOME

    def get_work_dir(self) -> str:
        return core.HOME

    def fork(self, name: Optional[str] = None, timeout: Optional[float] = 60) -> "Sandbox":
        """A copy with this sandbox's files, memory and running processes."""
        copy = _guard("sandbox", lambda: self.withruntime.fork(name=name))
        return type(self)(copy, self._client, self.env, self._language, self.public,
                          core.Lifecycle(**vars(self._lifecycle)))

    def create_snapshot(self, name: str, timeout: Optional[float] = 60) -> None:
        """Keeps this sandbox as a Runtime snapshot named ``name``;
        create(CreateSandboxFromSnapshotParams(snapshot=name)) starts from it."""
        _guard("sandbox", lambda: self.withruntime.snapshot(name=name))

    def __enter__(self) -> Any:
        return self

    def __exit__(self, *_: Any) -> None:
        self.delete()

    @property
    def computer_use(self) -> Any:
        raise NotSupportedError("Daytona's computer use",
                                "Use Runtime's desktop through sandbox.withruntime.desktop.")

    set_labels = staticmethod(core.unsupported("Changing a sandbox's labels",
                                               "Runtime sets labels once, at create."))
    recover = staticmethod(core.unsupported("Recovering a failed sandbox", "Create a new sandbox."))
    resize = staticmethod(core.unsupported("Resizing a sandbox", "Create a new one with the resources you need."))
    get_metrics = staticmethod(core.unsupported("Sandbox metrics", "Use `npx withruntime usage`."))
    get_metrics_latest = get_metrics
    set_ttl = staticmethod(core.unsupported("Changing the time to live after create",
                                            "Pass ttl_minutes when creating the sandbox."))
    create_lsp_server = staticmethod(core.unsupported(
        "Daytona's language servers", "Start one in a session with process.execute_session_command(..., run_async)."))
    update_secrets = staticmethod(core.unsupported("Daytona secrets", "Pass credentials as env_vars."))
    create_signed_preview_url = staticmethod(core.unsupported(
        "Signed preview URLs", "Use get_preview_link(port) and send its token as x-runtime-preview-token, or "
        "create the sandbox with public=True."))
    expire_signed_preview_url = create_signed_preview_url
    rotate_signing_key = staticmethod(core.unsupported(
        "Rotating the preview signing key", "Use sandbox.withruntime.previews.rotate(port)."))
    upload_url = staticmethod(core.unsupported("Signed upload URLs", "Use sandbox.fs.upload_file(data, path)."))
    download_url = staticmethod(core.unsupported("Signed download URLs", "Use sandbox.fs.download_file(path)."))
    create_ssh_access = staticmethod(core.unsupported("SSH access", "Use `npx withruntime sandbox shell <id>`."))
    revoke_ssh_access = create_ssh_access
    validate_ssh_access = create_ssh_access


class SnapshotService:
    """``daytona.snapshot``: Daytona snapshots as Runtime images."""

    def __init__(self, client: Runtime) -> None:
        self._client = client

    def list(self, page: Optional[int] = None, limit: Optional[int] = None) -> PaginatedSnapshots:
        listing = _guard("other", lambda: self._client.images.list())
        items = [_snapshot(one) for one in listing.to_list() if one.get("state") != "deleted"]
        size, number = limit or 100, page or 1
        return PaginatedSnapshots(items=items[(number - 1) * size:number * size], total=len(items), page=number,
                                  total_pages=max(1, -(-len(items) // size)))

    def get(self, name: str) -> Snapshot:
        if core.UUID.match(name):
            return _snapshot(_guard("other", lambda: self._client.images.get(name)))
        listing = _guard("other", lambda: self._client.images.list(name=core.image_name(name), limit=1))
        if not listing.data:
            raise DaytonaNotFoundError(f"Snapshot {name} was not found.", 404)
        return _snapshot(listing.data[0])

    def create(self, params: CreateSnapshotParams, *, on_logs: Optional[Callable[[str], None]] = None,
                     timeout: Optional[float] = 0) -> Snapshot:
        if params.resources is not None:
            raise NotSupportedError("Resources on a snapshot", "Pass resources when creating each sandbox from it.")
        if params.entrypoint is not None:
            raise NotSupportedError("An entrypoint on a snapshot", "Start the program in a session after create.")
        return _snapshot(_image_for(self._client, params.image, on_logs, core.image_name(params.name)))

    def delete(self, snapshot: Union[Snapshot, str]) -> None:
        found = self.get(snapshot) if isinstance(snapshot, str) else snapshot
        _guard("other", lambda: self._client.images.delete(found.id))

    def activate(self, snapshot: Union[Snapshot, str]) -> Snapshot:
        """Runtime images do not go inactive: returns the snapshot as it is."""
        return self.get(snapshot if isinstance(snapshot, str) else snapshot.id)


class VolumeService:
    """``daytona.volume``: Daytona volumes as Runtime volumes."""

    def __init__(self, client: Runtime) -> None:
        self._client = client

    def list(self) -> List[Volume]:
        listing = _guard("other", lambda: self._client.volumes.list())
        return [_volume(one) for one in listing.to_list() if one.get("state") != "deleted"]

    def get(self, name: str, create: bool = False) -> Volume:
        listing = _guard("other", lambda: self._client.volumes.list(name=name, limit=1))
        if listing.data:
            return _volume(listing.data[0])
        if create:
            return self.create(name)
        raise DaytonaNotFoundError(f"Volume {name} was not found.", 404)

    def create(self, name: str) -> Volume:
        raise NotSupportedError(f"Creating the volume {name} without a size",
                                f'Runtime volumes have a fixed size: runtime.volumes.create(10240, name="{name}"), '
                                "then mount it by name.")

    def delete(self, volume: Volume) -> None:
        _guard("other", lambda: self._client.volumes.delete(volume.id))


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


def _image_for(client: Runtime, image: Any, on_logs: Optional[Callable[[str], None]],
                     name: Optional[str] = None) -> Dict[str, Any]:
    """Builds (or finds, when built before) the Runtime image for a registry
    reference or a Daytona Image."""
    built = None if isinstance(image, str) else image.build()
    wanted = name or (built["name"] if built else core.image_name(image))
    listing = _guard("other", lambda: client.images.list(name=wanted, state="ready", limit=1))
    if listing.data:
        return listing.data[0]
    fields: Dict[str, Any] = ({"dockerfile": built["dockerfile"], "files": built["files"]} if built
                              else {"image": image})
    on_log = (lambda line: on_logs(f"{line.get('text', '')}\n")) if on_logs else None
    return _guard("other", lambda: client.images.build(name=wanted, on_log=on_log, **fields))


class Daytona:
    """Daytona's client. Uses RUNTIME_API_KEY (or a Runtime key in api_key or
    DAYTONA_API_KEY, or the saved `npx withruntime login`)."""

    def __init__(self, config: Optional[DaytonaConfig] = None, *, client: Optional[Runtime] = None,
                 runtime_create: Optional[Dict[str, Any]] = None) -> None:
        self._client = _client(config, client)
        self._runtime_create = dict(runtime_create or {})
        self.snapshot = SnapshotService(self._client)
        self.volume = VolumeService(self._client)
        self.default_language = "python"

    def __enter__(self) -> Any:
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def close(self) -> None:
        return None

    def create(self, params: Union[CreateSandboxFromSnapshotParams, CreateSandboxFromImageParams, None] = None,
                     *, timeout: float = 60, on_snapshot_create_logs: Optional[Callable[[str], None]] = None,
                     runtime_create: Optional[Dict[str, Any]] = None) -> Sandbox:
        """Creates a sandbox with Daytona's defaults (1 vCPU, 1 GiB, 3 GiB
        disk, pausing after 15 minutes without calls). Funding is left to
        Runtime: the free trial while the account has trial time, then prepaid
        credit. ``runtime_create`` passes Runtime fields (snake_case)."""
        params = params or CreateSandboxFromSnapshotParams()
        core.refuse_create(params)
        lifecycle = core.lifecycle_of(params)
        resources = getattr(params, "resources", None) or core.Resources()
        source = self._source(params, on_snapshot_create_logs)
        volumes = self._volumes(params.volumes)
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
        runtime = _guard("sandbox", lambda: self._client.sandboxes.create(**fields))
        if lifecycle.auto_delete_interval > 0:
            try:
                _guard("sandbox", lambda: runtime.set_retention(core.retention_days(lifecycle.auto_delete_interval)))
            except Exception:
                runtime.stop(wait=False)
                raise
        env = dict(params.env_vars or {})
        if params.outbound_proxy_url:
            env.update(HTTP_PROXY=params.outbound_proxy_url, HTTPS_PROXY=params.outbound_proxy_url)
        return Sandbox(runtime, self._client, env, language, bool(params.public), lifecycle,
                            getattr(params, "snapshot", None))

    def _source(self, params: Any, on_logs: Optional[Callable[[str], None]]) -> Dict[str, Any]:
        image = getattr(params, "image", None)
        if image is not None:
            return {"image": (_image_for(self._client, image, on_logs))["id"]}
        name = getattr(params, "snapshot", None)
        if name is None or core.STOCK_SNAPSHOT.match(name):
            return {}
        if core.UUID.match(name):
            try:
                self._client.images.get(name)
                return {"image": name}
            except Exception as error:  # noqa: BLE001
                if getattr(error, "status", None) != 404:
                    raise translate(error) from error
            return {"snapshot": name}
        images = _guard("other", lambda: self._client.images.list(name=core.image_name(name), state="ready",
                                                                          limit=1))
        if images.data:
            return {"image": images.data[0]["id"]}
        snapshots = _guard("other", lambda: self._client.snapshots.list(name=name, state="ready", limit=1))
        if snapshots.data:
            return {"snapshot": snapshots.data[0]["id"]}
        raise DaytonaNotFoundError(
            f'No Runtime image or snapshot is named "{name}". Daytona snapshots do not move to Runtime; build the '
            f'same environment as a Runtime image with that name: daytona.snapshot.create(CreateSnapshotParams('
            f'name="{name}", image=...)), or `npx withruntime image build --dockerfile Dockerfile --name '
            f'{core.image_name(name)}`.', 404)

    def _volumes(self, mounts: Optional[List[Any]]) -> List[Dict[str, str]]:
        out = []
        for mount in mounts or []:
            if mount.subpath:
                raise NotSupportedError("Mounting part of a volume (subpath)", "Mount the whole volume.")
            volume_id = mount.volume_id
            if not core.UUID.match(volume_id):
                listing = _guard("other", lambda: self._client.volumes.list(name=volume_id, limit=1))
                if not listing.data:
                    raise DaytonaNotFoundError(f"Volume {volume_id} was not found.", 404)
                volume_id = listing.data[0]["id"]
            out.append({"volume_id": volume_id, "path": mount.mount_path})
        return out

    def get(self, sandbox_id_or_name: str) -> Sandbox:
        """A sandbox by id or name."""
        if core.UUID.match(sandbox_id_or_name):
            runtime = _guard("sandbox", lambda: self._client.sandboxes.get(sandbox_id_or_name))
        else:
            listing = _guard("other", lambda: self._client.sandboxes.list(name=sandbox_id_or_name))
            found = listing.to_list()
            if not found:
                raise DaytonaNotFoundError(f"Sandbox {sandbox_id_or_name} was not found.", 404)
            runtime = found[-1]
        return Sandbox(runtime, self._client)

    def list(self, query: Optional[ListSandboxesQuery] = None) -> Any:
        """Live and stopped (paused) sandboxes, oldest first."""
        query = query or ListSandboxesQuery()
        for name in ("id", "snapshots", "targets", "min_cpu", "max_cpu"):
            if getattr(query, name) is not None:
                raise NotSupportedError(f"Listing sandboxes by {name}",
                                        "Filter by name, labels or states, and narrow the result yourself.")
        states = None if query.states is None else [
            one for state in query.states for one in core.RUNTIME_STATES.get(str(getattr(state, "value", state)), [])]
        listing = _guard("other", lambda: self._client.sandboxes.list(
            state=states, labels=query.labels, name=query.name, limit=min(query.limit, 100) if query.limit else None))
        for runtime in listing.to_list():
            yield Sandbox(runtime, self._client)

    def start(self, sandbox: Sandbox, timeout: float = 60) -> None:
        sandbox.start(timeout)

    def stop(self, sandbox: Sandbox, timeout: float = 60) -> None:
        sandbox.stop(timeout)

    def delete(self, sandbox: Sandbox, timeout: float = 60, wait: bool = False) -> None:
        sandbox.delete(timeout)

    def remove(self, sandbox: Sandbox, timeout: float = 60) -> None:
        """Daytona's older name for delete."""
        sandbox.delete(timeout)


__all__ = ["Daytona", "Sandbox", "Process", "FileSystem", "Git", "CodeInterpreter",
           "SnapshotService", "VolumeService"]
