"""Runtime's errors as sprites-py 0.7.2 raises them: a refused key is
AuthenticationError, a missing sprite NotFoundError, and a file call's failure
the filesystem error sprites-py names for it."""
import functools
import inspect
from .exceptions import (AuthenticationError, DirectoryNotEmptyError, ExecError, FileExistsError_,
                         FileNotFoundError_, FilesystemError, IsADirectoryError_, NotADirectoryError_,
                         NotFoundError, PermissionError_)

# Runtime's file error codes (packages/cloud/src/guest-access.ts).
FILE_CODES = {
    "file_not_found": FileNotFoundError_,
    "path_not_found": FileNotFoundError_,
    "is_a_directory": IsADirectoryError_,
    "not_a_directory": NotADirectoryError_,
    "permission_denied": PermissionError_,
    "directory_not_empty": DirectoryNotEmptyError,
    "already_exists": FileExistsError_,
}

# What coreutils print, for the file operations that run one (rmdir, chmod, cp).
FILE_TEXT = (
    ("no such file", FileNotFoundError_),
    ("not a directory", NotADirectoryError_),
    ("is a directory", IsADirectoryError_),
    ("omitting directory", IsADirectoryError_),
    ("permission denied", PermissionError_),
    ("operation not permitted", PermissionError_),
    ("directory not empty", DirectoryNotEmptyError),
    ("file exists", FileExistsError_),
)


def api_error(error, operation):
    """The sprites-py error for a Runtime error; any other error unchanged."""
    from .._errors import AuthenticationError as NativeAuthentication, NotFoundError as NativeNotFound
    if isinstance(error, NativeAuthentication):
        return AuthenticationError(f"Authentication failed for {operation}")
    if isinstance(error, NativeNotFound):
        return NotFoundError(f"Resource not found for {operation}")
    return error


def file_error(error, operation, path):
    if getattr(error, "code", None) in FILE_CODES and not isinstance(error, FilesystemError):
        from .._errors import RuntimeError as NativeError
        if isinstance(error, NativeError):
            return FILE_CODES[error.code](operation, path)
    if isinstance(error, ExecError):
        text = (error.stderr or b"").decode("utf-8", "replace")
        for words, kind in FILE_TEXT:
            if words in text.lower():
                return kind(operation, path)
        return FilesystemError(text.strip() or str(error), operation, path)
    return api_error(error, operation)


def _wrap(fn, translate):
    def mapped(error, args):
        result = translate(error, args)
        return None if result is error else result

    if inspect.isasyncgenfunction(fn):
        @functools.wraps(fn)
        async def agen(*args, **kwargs):
            try:
                async for item in fn(*args, **kwargs):
                    yield item
            except Exception as error:
                other = mapped(error, args)
                if other is None:
                    raise
                raise other from error
        return agen
    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def coroutine(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except Exception as error:
                other = mapped(error, args)
                if other is None:
                    raise
                raise other from error
        return coroutine
    if inspect.isgeneratorfunction(fn):
        @functools.wraps(fn)
        def gen(*args, **kwargs):
            try:
                yield from fn(*args, **kwargs)
            except Exception as error:
                other = mapped(error, args)
                if other is None:
                    raise
                raise other from error
        return gen

    @functools.wraps(fn)
    def call(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as error:
            other = mapped(error, args)
            if other is None:
                raise
            raise other from error
    return call


def api(operation):
    """Decorates a call to Runtime with sprites-py's errors."""
    return lambda fn: _wrap(fn, lambda error, args: api_error(error, operation))


def filesystem(operation):
    """Decorates a SpritePath method with sprites-py's filesystem errors."""
    return lambda fn: _wrap(fn, lambda error, args: file_error(error, operation, args[0]._path))
