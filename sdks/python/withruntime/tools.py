"""Four tools bound to one Runtime sandbox, as plain Python functions.

Every agent framework that takes a typed, documented function as a tool takes
these: LangChain and LangGraph, CrewAI, LlamaIndex, Pydantic AI, Google ADK,
smolagents and the OpenAI Agents SDK's ``function_tool``::

    from withruntime import Sandbox
    from withruntime.tools import sandbox_tools

    with Sandbox.create() as sbx:
        tools = sandbox_tools(sbx)  # runtime_exec, runtime_read_file, runtime_write_file, runtime_list_files

The application creates the sandbox and binds the tools to it: the model
chooses commands and paths, never the sandbox, the account or the key. Pass an
``AsyncSandbox`` and the tools are coroutines, for frameworks that await them.
Relative paths are under ``/workspace``; output is capped so one noisy command
cannot flood the model's context.
"""
# No `from __future__ import annotations`: frameworks build their argument
# schemas from these functions' annotations, and CrewAI cannot resolve strings.
import inspect
import posixpath
from typing import Any, Callable, Optional

from ._errors import NotFoundError

WORKSPACE = "/workspace"
DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_MAX_OUTPUT_CHARS = 20_000

EXEC_DOC = """Run a shell command (bash) in the sandbox and return its exit code, stdout and stderr.

Args:
    command: The command line, run under `bash -c`, for example `pytest -q` or `pip install requests`.
    cwd: Directory to run in. Relative paths are under /workspace, the default.
    timeout_seconds: Seconds before the command is stopped and reported as timed out.
"""
READ_DOC = """Read a text file from the sandbox.

Args:
    path: The file's path. Relative paths are under /workspace.
"""
WRITE_DOC = """Create or replace a text file in the sandbox, making parent directories.

Args:
    path: The file's path. Relative paths are under /workspace.
    content: The file's full new content.
"""
LIST_DOC = """List a directory in the sandbox: each entry's path, type and size.

Args:
    path: The directory. Relative paths are under /workspace, the default.
    depth: How many levels below it to include; 1 lists only its children.
"""


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"[{len(text) - limit} earlier characters omitted]\n" + text[-limit:]


class SandboxTools:
    """The tools' behaviour, shared by the sync and async forms."""

    def __init__(self, sandbox: Any, *, root: str = WORKSPACE, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
                 max_output_chars: int = DEFAULT_MAX_OUTPUT_CHARS) -> None:
        self.sandbox = sandbox
        self.root = posixpath.normpath(root)
        self.timeout_seconds = timeout_seconds
        self.max_output_chars = max_output_chars
        self.is_async = inspect.iscoroutinefunction(sandbox.exec)

    def path(self, value: str) -> str:
        """An absolute, normalized path; relative ones are under the root."""
        return posixpath.normpath(posixpath.join(self.root, value or "."))

    def _result(self, result: Any) -> dict[str, Any]:
        return {
            "exit_code": result.exit_code,
            "stdout": _clip(result.stdout, self.max_output_chars),
            "stderr": _clip(result.stderr, self.max_output_chars),
            "timed_out": result.timed_out,
        }

    def _exec_args(self, cwd: Optional[str], timeout_seconds: Optional[int]) -> dict[str, Any]:
        return {"cwd": self.path(cwd or "."), "timeout_ms": int((timeout_seconds or self.timeout_seconds) * 1000)}

    @staticmethod
    def _in_files_api(path: str) -> bool:
        return path.startswith(WORKSPACE + "/")

    def functions(self) -> list[Callable[..., Any]]:
        """The four tools as named, documented functions."""
        return _async_functions(self) if self.is_async else _sync_functions(self)


def _named(function: Callable[..., Any], name: str, doc: str) -> Callable[..., Any]:
    function.__name__ = function.__qualname__ = name
    function.__doc__ = doc
    return function


def _sync_functions(tools: SandboxTools) -> list[Callable[..., Any]]:
    sandbox = tools.sandbox

    def runtime_exec(command: str, cwd: Optional[str] = None, timeout_seconds: Optional[int] = None) -> dict[str, Any]:
        return tools._result(sandbox.exec(command, **tools._exec_args(cwd, timeout_seconds)))

    def runtime_read_file(path: str) -> str:
        target = tools.path(path)
        if tools._in_files_api(target):
            try:
                return _clip(sandbox.files.read(target).decode("utf-8", "replace"), tools.max_output_chars)
            except NotFoundError:
                return f"No such file: {target}"
        result = sandbox.exec(["cat", "--", target])
        return _clip(result.stdout if result.exit_code == 0 else result.stderr, tools.max_output_chars)

    def runtime_write_file(path: str, content: str) -> str:
        target = tools.path(path)
        if tools._in_files_api(target):
            sandbox.files.write(target, content)
        else:
            result = sandbox.exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", target],
                                  stdin=content)
            if result.exit_code != 0:
                return f"Could not write {target}: {result.stderr.strip()}"
        return f"Wrote {len(content.encode())} bytes to {target}"

    def runtime_list_files(path: str = ".", depth: int = 1) -> list[dict[str, Any]]:
        return _listing(tools, sandbox.exec(_find(tools.path(path), depth)))

    return _all(runtime_exec, runtime_read_file, runtime_write_file, runtime_list_files)


def _async_functions(tools: SandboxTools) -> list[Callable[..., Any]]:
    sandbox = tools.sandbox

    async def runtime_exec(command: str, cwd: Optional[str] = None,
                           timeout_seconds: Optional[int] = None) -> dict[str, Any]:
        return tools._result(await sandbox.exec(command, **tools._exec_args(cwd, timeout_seconds)))

    async def runtime_read_file(path: str) -> str:
        target = tools.path(path)
        if tools._in_files_api(target):
            try:
                return _clip((await sandbox.files.read(target)).decode("utf-8", "replace"), tools.max_output_chars)
            except NotFoundError:
                return f"No such file: {target}"
        result = await sandbox.exec(["cat", "--", target])
        return _clip(result.stdout if result.exit_code == 0 else result.stderr, tools.max_output_chars)

    async def runtime_write_file(path: str, content: str) -> str:
        target = tools.path(path)
        if tools._in_files_api(target):
            await sandbox.files.write(target, content)
        else:
            result = await sandbox.exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", target],
                                        stdin=content)
            if result.exit_code != 0:
                return f"Could not write {target}: {result.stderr.strip()}"
        return f"Wrote {len(content.encode())} bytes to {target}"

    async def runtime_list_files(path: str = ".", depth: int = 1) -> list[dict[str, Any]]:
        return _listing(tools, await sandbox.exec(_find(tools.path(path), depth)))

    return _all(runtime_exec, runtime_read_file, runtime_write_file, runtime_list_files)


def _all(*functions: Callable[..., Any]) -> list[Callable[..., Any]]:
    docs = [EXEC_DOC, READ_DOC, WRITE_DOC, LIST_DOC]
    return [_named(function, function.__name__, doc) for function, doc in zip(functions, docs)]


def _find(path: str, depth: int) -> list[str]:
    depth = max(1, min(int(depth), 10))
    return ["sh", "-c", 'find "$1" -mindepth 1 -maxdepth "$2" -printf "%y\\t%s\\t%p\\n" | sort -k3 | head -n 1000',
            "sh", path, str(depth)]


def _listing(tools: SandboxTools, result: Any) -> list[dict[str, Any]]:
    if result.exit_code != 0 and not result.stdout:
        return [{"error": result.stderr.strip() or f"find exited with {result.exit_code}"}]
    kinds = {"f": "file", "d": "directory", "l": "symlink"}
    entries: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        kind, size, path = (line.split("\t", 2) + ["", ""])[:3]
        entries.append({"path": path, "type": kinds.get(kind, "other"), "size": int(size) if size.isdigit() else 0})
    return entries


def sandbox_tools(sandbox: Any, *, root: str = WORKSPACE, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
                  max_output_chars: int = DEFAULT_MAX_OUTPUT_CHARS) -> list[Callable[..., Any]]:
    """``runtime_exec``, ``runtime_read_file``, ``runtime_write_file`` and
    ``runtime_list_files``, bound to ``sandbox`` (a ``Sandbox`` or ``AsyncSandbox``)."""
    return SandboxTools(sandbox, root=root, timeout_seconds=timeout_seconds,
                        max_output_chars=max_output_chars).functions()


__all__ = ["SandboxTools", "sandbox_tools"]
