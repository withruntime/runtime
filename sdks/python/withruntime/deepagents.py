"""A Runtime sandbox as a LangChain Deep Agents backend.

``RuntimeSandbox`` implements Deep Agents' ``BaseSandbox``: the agent's
``execute``, ``ls``, ``read_file``, ``write_file``, ``edit_file``, ``glob`` and
``grep`` tools all run in one Runtime Cloud microVM::

    from deepagents import create_deep_agent
    from withruntime import Sandbox
    from withruntime.deepagents import RuntimeSandbox

    with Sandbox.create() as sbx:
        agent = create_deep_agent(model="openai:gpt-5.4", backend=RuntimeSandbox(sbx))

Install with ``pip install "withruntime[deepagents]"``.
"""
from __future__ import annotations

import posixpath
import uuid
from typing import Any, Optional

try:
    from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse
    from deepagents.backends.sandbox import BaseSandbox
except ImportError as error:  # pragma: no cover - depends on the optional extra
    raise ImportError('withruntime.deepagents needs Deep Agents: pip install "withruntime[deepagents]"') from error

from ._errors import NotFoundError, PermissionDeniedError
from ._errors import RuntimeError as RuntimeCloudError

_FILES_HOME = "/workspace"
_STAGING_DIR = "/workspace/.deepagents-staging"


class RuntimeSandbox(BaseSandbox):
    """Deep Agents' sandbox backend on a Runtime ``Sandbox`` the application created.

    ``timeout_seconds`` is the default for a command that names none. Output is
    returned whole by default: Deep Agents moves a long result out of the
    model's context itself, and ``read_file``, ``ls``, ``glob`` and ``grep``
    parse the output of the commands they run, so a cut would break them.
    ``max_output_chars`` keeps only the end of a longer output and flags it as
    truncated, for every command, those included.
    """

    def __init__(self, sandbox: Any, *, timeout_seconds: int = 1800,
                 max_output_chars: Optional[int] = None) -> None:
        self.sandbox = sandbox
        self.timeout_seconds = timeout_seconds
        self.max_output_chars = max_output_chars

    @property
    def id(self) -> str:
        return self.sandbox.id

    def execute(self, command: str, *, timeout: Optional[int] = None) -> ExecuteResponse:
        seconds = self.timeout_seconds if timeout is None or timeout <= 0 else timeout
        result = self.sandbox.exec(command, timeout_ms=int(seconds * 1000))
        output = result.stdout + result.stderr
        if result.timed_out:
            output += f"\n[Runtime: the command ran past {seconds} seconds and was stopped]"
        limit = self.max_output_chars
        truncated = result.stdout_truncated or result.stderr_truncated or (limit is not None and len(output) > limit)
        if limit is not None and len(output) > limit:
            output = output[-limit:]
        return ExecuteResponse(output=output, exit_code=result.exit_code, truncated=truncated)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [self._upload(path, content) for path, content in files]

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return [self._download(path) for path in paths]

    # The Files API takes a file of any size in /workspace, but its chunked upload, which a file
    # over 1 MiB needs, refuses other paths. Elsewhere a file moves through a staged copy in
    # /workspace, both ways, and the sandbox user's own permissions apply.

    def _upload(self, path: str, content: bytes) -> FileUploadResponse:
        if not path.startswith("/") or posixpath.normpath(path) != path:
            return FileUploadResponse(path=path, error="invalid_path")
        try:
            if path.startswith(_FILES_HOME + "/"):
                self.sandbox.files.write(path, content)
                return FileUploadResponse(path=path)
            staging = f"{_STAGING_DIR}/{uuid.uuid4().hex}"
            self.sandbox.files.write(staging, content)
            try:
                result = self.sandbox.exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" > "$2"',
                                            "sh", staging, path])
            finally:
                self._remove(staging)
            return FileUploadResponse(path=path, error=None if result.exit_code == 0 else _error(result.stderr))
        except PermissionDeniedError:
            return FileUploadResponse(path=path, error="permission_denied")
        except RuntimeCloudError as error:
            return FileUploadResponse(path=path, error=str(error))

    def _download(self, path: str) -> FileDownloadResponse:
        if not path.startswith("/") or posixpath.normpath(path) != path:
            return FileDownloadResponse(path=path, error="invalid_path")
        try:
            if path.startswith(_FILES_HOME + "/"):
                return FileDownloadResponse(path=path, content=self.sandbox.files.read(path))
            staging = f"{_STAGING_DIR}/{uuid.uuid4().hex}"
            try:
                result = self.sandbox.exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$2")" && cat -- "$1" > "$2"',
                                            "sh", path, staging])
                if result.exit_code != 0:
                    return FileDownloadResponse(path=path, error=_error(result.stderr))
                return FileDownloadResponse(path=path, content=self.sandbox.files.read(staging))
            finally:
                self._remove(staging)
        except NotFoundError:
            return FileDownloadResponse(path=path, error="file_not_found")
        except PermissionDeniedError:
            return FileDownloadResponse(path=path, error="permission_denied")
        except RuntimeCloudError as error:
            if "directory" in str(error).lower():
                return FileDownloadResponse(path=path, error="is_directory")
            return FileDownloadResponse(path=path, error=str(error))

    def _remove(self, path: str) -> None:
        try:
            self.sandbox.files.remove(path)
        except RuntimeCloudError:
            pass


def _error(stderr: str) -> str:
    if "No such file" in stderr:
        return "file_not_found"
    if "Permission denied" in stderr:
        return "permission_denied"
    if "Is a directory" in stderr:
        return "is_directory"
    return stderr.strip() or "failed"


__all__ = ["RuntimeSandbox"]
