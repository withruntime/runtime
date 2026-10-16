"""Exceptions used by the Modal sandbox API, with modal 1.6.0's hierarchy."""


class Error(Exception):
    pass


class AlreadyExistsError(Error):
    pass


class AuthError(Error):
    pass


class InternalError(Error):
    pass


class InvalidError(Error):
    pass


class ConflictError(InvalidError):
    pass


class DataLossError(Error):
    pass


class NotFoundError(Error):
    pass


class PermissionDeniedError(Error):
    pass


class ResourceExhaustedError(Error):
    pass


class ServiceError(Error):
    pass


class UnimplementedError(Error):
    pass


class RemoteError(Error):
    pass


class TimeoutError(Error):  # noqa: A001 - modal.exception.TimeoutError
    pass


class SandboxTimeoutError(TimeoutError):
    pass


class SnapshotCreationError(Error):
    pass


class ExecTimeoutError(TimeoutError):
    pass


class SandboxTerminatedError(Error):
    pass


class ConnectionError(Error):  # noqa: A001 - modal.exception.ConnectionError
    pass


class VersionError(Error):
    pass


class ExecutionError(Error):
    pass


class RequestSizeError(Error):
    pass


class InternalFailure(Error):
    pass


class ClientClosed(Error):
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


class ImageBuildError(RemoteError):
    def __init__(self, message: str, image_id: str):
        super().__init__(message)
        self.image_id = image_id

