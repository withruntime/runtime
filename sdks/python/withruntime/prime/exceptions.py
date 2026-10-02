"""Prime exception hierarchy, shared by both execution modes."""


class APIError(Exception):
    pass


class UnauthorizedError(APIError):
    pass


class SandboxFileNotFoundError(APIError):
    pass


class SandboxFileTooLargeError(APIError):
    pass


class BatchStatusUnsupportedError(APIError):
    pass


class SandboxNotRunningError(RuntimeError):
    def __init__(self, sandbox_id, status=None, error_type=None, command=None, message=None):
        self.sandbox_id, self.status, self.error_type, self.command = sandbox_id, status, error_type, command
        super().__init__(message or (f"Sandbox {sandbox_id} failed ({error_type})" if error_type else
                         f"Sandbox {sandbox_id} is not running (status={status})" if status else
                         f"Sandbox {sandbox_id} is not running"))


class CommandTimeoutError(RuntimeError):
    def __init__(self, sandbox_id, command, timeout):
        self.sandbox_id, self.command, self.timeout = sandbox_id, command, timeout
        super().__init__(f"Command '{command}' timed out after {timeout}s in sandbox {sandbox_id}")


class UploadTimeoutError(RuntimeError):
    def __init__(self, sandbox_id, file_path, timeout):
        super().__init__(f"Upload to '{file_path}' timed out after {timeout}s in sandbox {sandbox_id}")


class DownloadTimeoutError(RuntimeError):
    def __init__(self, sandbox_id, file_path, timeout):
        super().__init__(f"Download from '{file_path}' timed out after {timeout}s in sandbox {sandbox_id}")


class SandboxOOMError(SandboxNotRunningError):
    pass


class SandboxTimeoutError(SandboxNotRunningError):
    pass


class SandboxImagePullError(SandboxNotRunningError):
    pass


class PaymentRequiredError(APIError):
    pass


class APITimeoutError(APIError):
    pass


def translate(method):
    """Preserve Prime exception classes while retaining the native cause."""
    import functools
    import inspect
    from .._errors import RuntimeError as NativeError
    def mapped(error, args, kwargs):
        if error.code in ("sandbox_not_running", "sandbox_stopped", "not_running"):
            sandbox_id = inspect.signature(method).bind_partial(*args, **kwargs).arguments.get("sandbox_id", "")
            return SandboxNotRunningError(sandbox_id, message=str(error))
        kind = (UnauthorizedError if error.status == 401 else PaymentRequiredError if error.status == 402 else
                SandboxFileNotFoundError if error.code == "file_not_found" else
                SandboxFileTooLargeError if error.status == 413 else
                APITimeoutError if error.code in ("timeout", "request_timeout") else APIError)
        value = kind(str(error))
        value.code, value.status = error.code, error.status
        return value
    if inspect.iscoroutinefunction(method):
        @functools.wraps(method)
        async def asynchronous(*args, **kwargs):
            try:
                return await method(*args, **kwargs)
            except NativeError as error:
                raise mapped(error, args, kwargs) from error
        return asynchronous
    @functools.wraps(method)
    def synchronous(*args, **kwargs):
        try:
            return method(*args, **kwargs)
        except NativeError as error:
            raise mapped(error, args, kwargs) from error
    return synchronous
