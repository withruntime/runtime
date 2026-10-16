"""Sprites exception names and attributes (sprites-py 0.7.2).

The filesystem errors are also Python's own (FileNotFoundError and the rest),
as TimeoutError is in sprites-py: `except FileNotFoundError` still catches them.
"""

import builtins


class SpriteError(Exception):
    pass


class NetworkError(SpriteError):
    pass


class AuthenticationError(SpriteError):
    """Runtime refused the key (401)."""


class NotFoundError(SpriteError):
    """The sprite or checkpoint does not exist."""


class ExecError(SpriteError):
    def __init__(self, message, exit_code, stdout=b"", stderr=b""):
        super().__init__(message)
        self._exit_code, self.stdout, self.stderr = exit_code, stdout, stderr

    def exit_code(self):
        return self._exit_code


ExitError = ExecError


class TimeoutError(SpriteError, builtins.TimeoutError):
    """Also Python's own TimeoutError, as in sprites-py 0.7.2."""


class FilesystemError(SpriteError):
    def __init__(self, message, operation, path, code=None):
        super().__init__(message)
        self.operation, self.path, self.code = operation, path, code

    def __str__(self):
        if self.code:
            return f"{self.operation} {self.path}: {self.args[0]} ({self.code})"
        return f"{self.operation} {self.path}: {self.args[0]}"


class FileNotFoundError_(FilesystemError, builtins.FileNotFoundError):
    def __init__(self, operation, path):
        super().__init__("file not found", operation, path, "ENOENT")


class IsADirectoryError_(FilesystemError, builtins.IsADirectoryError):
    def __init__(self, operation, path):
        super().__init__("is a directory", operation, path, "EISDIR")


class NotADirectoryError_(FilesystemError, builtins.NotADirectoryError):
    def __init__(self, operation, path):
        super().__init__("not a directory", operation, path, "ENOTDIR")


class PermissionError_(FilesystemError, builtins.PermissionError):
    def __init__(self, operation, path):
        super().__init__("permission denied", operation, path, "EACCES")


class FileExistsError_(FilesystemError, builtins.FileExistsError):
    def __init__(self, operation, path):
        super().__init__("file exists", operation, path, "EEXIST")


class DirectoryNotEmptyError(FilesystemError, builtins.OSError):
    def __init__(self, operation, path):
        super().__init__("directory not empty", operation, path, "ENOTEMPTY")
