"""Modal sandbox filesystem behavior over native file APIs."""
import os
from pathlib import Path
import tempfile
from ._fs_common import path, errors, entry
from .exception import SandboxFilesystemError, SandboxFilesystemNotFoundError
from .types import FileWatchEvent, FileWatchEventType


class Filesystem:
    def __init__(self, sandbox):
        self._sb = sandbox

    def read_bytes(self, remote_path):
        with errors():
            return self._sb.files.read(path(remote_path))

    def read_text(self, remote_path):
        return (self.read_bytes(remote_path)).decode("utf-8")

    def write_bytes(self, data, remote_path):
        path(remote_path)
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError("data must be bytes-like")
        with errors():
            self._sb.files.write(remote_path, bytes(data))

    def write_text(self, data, remote_path):
        if not isinstance(data, str):
            raise TypeError("data must be a string")
        self.write_bytes(data.encode("utf-8"), remote_path)

    def copy_from_local(self, local_path, remote_path):
        path(remote_path)
        # Opening a directory must raise IsADirectoryError, not copy a tree.
        with open(local_path, "rb") as source:
            data = source.read()
        self.write_bytes(data, remote_path)

    def copy_to_local(self, remote_path, local_path):
        path(remote_path)
        target = Path(local_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".modal-sandbox-fs-", dir=target.parent)
        os.close(fd)
        try:
            with errors():
                self._sb.files.download(remote_path, temporary)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def make_directory(self, remote_path, *, create_parents=True):
        with errors():
            self._sb.files.mkdir(path(remote_path), parents=create_parents)

    def remove(self, remote_path, *, recursive=False):
        with errors():
            removed = self._sb.files.remove(path(remote_path), recursive=recursive)
        if not removed:
            raise SandboxFilesystemNotFoundError(remote_path)

    def _metadata(self, value):
        if not value.get("exists", True):
            raise SandboxFilesystemNotFoundError(value.get("path", "File does not exist"))
        if "owner" not in value or "group" not in value:
            # Older guests omit ownership. GNU stat works without requiring
            # Python in a custom image and never interprets the filename.
            result = self._sb.exec(["stat", "-c", "%U\n%G", "--", value["path"]])
            if result.exit_code != 0 or result.stdout_truncated:
                raise SandboxFilesystemError(result.stderr or "Could not read file ownership")
            owner, group = result.stdout.rstrip("\n").split("\n", 1)
            value = {**value, "owner": owner, "group": group}
        if value["type"] == "symlink" and "symlinkTarget" not in value:
            result = self._sb.exec(["readlink", "-z", "--", value["path"]])
            if result.exit_code != 0 or not result.stdout.endswith("\x00"):
                raise SandboxFilesystemError(result.stderr or "Could not read symbolic link")
            value = {**value, "symlinkTarget": result.stdout[:-1]}
        return entry(value)

    def stat(self, remote_path):
        with errors():
            info = self._sb.files.stat(path(remote_path))
        return self._metadata({"path": remote_path, **info})

    def list_files(self, remote_path):
        with errors():
            entries = self._sb.files.list(path(remote_path), hidden=True)
        return [self._metadata(item) for item in entries]

    def watch(self, remote_path, *, filter=None, recursive=False, timeout=None):
        path(remote_path)
        if filter is not None and any(not isinstance(item, FileWatchEventType) for item in filter):
            raise ValueError("filter must contain FileWatchEventType values")
        if timeout is not None and timeout <= 0:
            return
        kinds = {"create": FileWatchEventType.Create, "write": FileWatchEventType.Modify,
                 "chmod": FileWatchEventType.Modify, "rename": FileWatchEventType.Modify,
                 "remove": FileWatchEventType.Remove, "access": FileWatchEventType.Access}
        events = [key for key, value in kinds.items() if filter is None or value in filter]
        with errors():
            handle = self._sb.files.watch(remote_path, recursive=recursive, events=events or ["create"],
                timeout_ms=int(timeout * 1000) if timeout is not None else 0)
            try:
                while True:
                    batch = handle.get_new_events(wait_ms=8000)
                    if handle.notices:
                        raise SandboxFilesystemError("Filesystem events were lost; rescan the watched path")
                    for event in batch:
                        kind = kinds.get(event.get("type"), FileWatchEventType.Unknown)
                        if filter is None or kind in filter:
                            paths = event.get("paths") or [p for p in (event.get("oldPath"), event.get("path")) if p]
                            yield FileWatchEvent(paths=paths, type=kind)
                    if handle.exit_reason is not None:
                        break
            finally:
                handle.stop()
