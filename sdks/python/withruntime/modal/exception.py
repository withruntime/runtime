"""Exceptions used by the Modal sandbox API."""

class Error(Exception):
    pass

class InvalidError(Error):
    pass

class NotFoundError(Error):
    pass

class AlreadyExistsError(Error):
    pass

class ConflictError(Error):
    pass

class SandboxTerminatedError(Error):
    pass

class SandboxTimeoutError(Error):
    pass

class SandboxFilesystemError(Error):
    pass

class SandboxFilesystemNotFoundError(SandboxFilesystemError):
    pass

class SandboxFilesystemDirectoryNotEmptyError(SandboxFilesystemError):
    pass

class SandboxFilesystemIsADirectoryError(SandboxFilesystemError):
    pass

class SandboxFilesystemNotADirectoryError(SandboxFilesystemError):
    pass

class SandboxFilesystemPermissionError(SandboxFilesystemError):
    pass

class SandboxFilesystemFileTooLargeError(SandboxFilesystemError):
    pass

class SandboxFilesystemPathAlreadyExistsError(SandboxFilesystemError):
    pass

class TimeoutError(Error):
    pass

class ExecutionError(Error):
    pass
