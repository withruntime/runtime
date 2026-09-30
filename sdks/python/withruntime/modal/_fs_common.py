import stat
from contextlib import contextmanager
from .types import FileInfo, FileType
from .exception import (InvalidError, SandboxFilesystemError, SandboxFilesystemNotFoundError,
    SandboxFilesystemNotADirectoryError, SandboxFilesystemIsADirectoryError, SandboxFilesystemPermissionError,
    SandboxFilesystemDirectoryNotEmptyError, SandboxFilesystemPathAlreadyExistsError,
    SandboxFilesystemFileTooLargeError)
from .._errors import RuntimeError as SDKError


def path(value):
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value:
        raise InvalidError("remote_path must be an absolute path without NUL")
    return value


@contextmanager
def errors():
    try:
        yield
    except SDKError as error:
        kind = {"file_not_found": SandboxFilesystemNotFoundError, "not_a_directory": SandboxFilesystemNotADirectoryError,
            "is_a_directory": SandboxFilesystemIsADirectoryError, "permission_denied": SandboxFilesystemPermissionError,
            "directory_not_empty": SandboxFilesystemDirectoryNotEmptyError, "already_exists": SandboxFilesystemPathAlreadyExistsError,
            "file_exists": SandboxFilesystemPathAlreadyExistsError, "file_too_large": SandboxFilesystemFileTooLargeError}.get(error.code)
        raise (kind or SandboxFilesystemError)(str(error)) from error


def entry(data):
    if not data.get("exists", True):
        raise SandboxFilesystemNotFoundError(data.get("path", "File does not exist"))
    mode = data.get("mode", 0)
    if isinstance(mode, str):
        mode = int(mode, 8)
    kind = FileType(data["type"])
    type_mode = {FileType.FILE: stat.S_IFREG, FileType.DIRECTORY: stat.S_IFDIR, FileType.SYMLINK: stat.S_IFLNK}[kind]
    return FileInfo(name=data["name"], path=data["path"], type=kind, size=data["size"], mode=mode,
        permissions=stat.filemode(type_mode | mode), owner=data["owner"], group=data["group"],
        modified_time=data["mtimeMs"] / 1000, symlink_target=data.get("symlinkTarget"))
