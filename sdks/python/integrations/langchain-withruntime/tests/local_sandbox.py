"""A stand-in for a Runtime sandbox that runs on this machine, for offline tests.

It keeps the two surfaces ``RuntimeSandbox`` uses:

- ``exec``: a string runs under ``bash -c`` and a list runs without a shell, as
  the API does. A command past its timeout comes back with ``timed_out`` set
  and no exit code, as the API returns it.
- ``files``: read, write and remove under ``/workspace``, which the stand-in
  keeps in a temporary directory. The Files API is the only way in to
  ``/workspace`` here, so an argument of a list command that names a path
  under it is mapped to the same directory.

Commands run on the host, not in a microVM, so the tests prove the backend's
protocol and the shell and Python it sends, not the sandbox image.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from withruntime import CommandResult
from withruntime._errors import NotFoundError
from withruntime._errors import RuntimeError as RuntimeCloudError

WORKSPACE = "/workspace"


class LocalFiles:
    def __init__(self, root: Path) -> None:
        self.root = root

    def host(self, path: str) -> Path:
        if not path.startswith(WORKSPACE + "/"):
            msg = f"this stand-in serves {WORKSPACE} only: {path}"
            raise AssertionError(msg)
        return self.root / path[len(WORKSPACE) + 1 :]

    def read(self, path: str) -> bytes:
        target = self.host(path)
        if target.is_dir():
            msg = f"{path} is a directory"
            raise RuntimeCloudError(msg, code="is_directory", status=400)
        if not target.exists():
            msg = f"{path} does not exist"
            raise NotFoundError(msg, code="file_not_found", status=404)
        return target.read_bytes()

    def write(self, path: str, data: str | bytes, mode: int | None = None) -> dict[str, Any]:
        target = self.host(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = data.encode() if isinstance(data, str) else bytes(data)
        target.write_bytes(payload)
        if mode is not None:
            target.chmod(mode)
        return {"path": path, "size": len(payload)}

    def remove(self, path: str, recursive: bool = False) -> bool:  # noqa: FBT001, FBT002
        target = self.host(path)
        if target.is_dir() and recursive:
            shutil.rmtree(target)
            return True
        if not target.exists():
            msg = f"{path} does not exist"
            raise NotFoundError(msg, code="file_not_found", status=404)
        target.unlink()
        return True


class LocalSandbox:
    """What ``RuntimeSandbox`` needs of a ``withruntime.Sandbox``, on this machine."""

    def __init__(self, sandbox_id: str = "sbx-local") -> None:
        self.id = sandbox_id
        self._dir = tempfile.mkdtemp(prefix="runtime-local-sandbox-")
        self.files = LocalFiles(Path(self._dir) / "workspace")
        self.files.root.mkdir()
        self.commands: list[Any] = []

    def exec(self, command: str | list[str], *, timeout_ms: int | None = None, **_: Any) -> CommandResult:
        self.commands.append(command)
        if isinstance(command, str):
            argv = ["bash", "-c", command]
        else:
            argv = [str(self.files.host(a)) if a.startswith(WORKSPACE + "/") else a for a in command]
        try:
            done = subprocess.run(  # noqa: S603
                argv,
                capture_output=True,
                timeout=None if timeout_ms is None else timeout_ms / 1000,
                check=False,
            )
        except subprocess.TimeoutExpired as expired:
            return CommandResult(
                exit_code=None,
                stdout=(expired.stdout or b"").decode(errors="replace"),
                stderr=(expired.stderr or b"").decode(errors="replace"),
                timed_out=True,
            )
        return CommandResult(
            exit_code=done.returncode,
            stdout=done.stdout.decode(errors="replace"),
            stderr=done.stderr.decode(errors="replace"),
        )

    def close(self) -> None:
        shutil.rmtree(self._dir, ignore_errors=True)


def scratch_root() -> str:
    """A directory outside ``/workspace`` for tests, made fresh."""
    return tempfile.mkdtemp(prefix="runtime-sandbox-ops-") + os.sep
