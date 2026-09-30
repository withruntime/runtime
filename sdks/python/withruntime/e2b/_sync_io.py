"""The sync twin of _async_io: a background command's output is read when
``wait()`` asks for it, as E2B's sync handle does."""
from __future__ import annotations

from typing import Any, Callable, Iterator
from functools import wraps
import inspect
from .._request_scope import Limits, request_scope


def request(work, timeout=None):
    with request_scope(timeout):
        return work()



def opening_timeout(deadline, requested):
    import time
    remaining = None if deadline is None else deadline - time.monotonic()
    if remaining is not None and remaining <= 0:
        from ._core import TimeoutException
        raise TimeoutException('The command connection timed out before it opened')
    return remaining or 0

def request_limited(function):
    signature = inspect.signature(function)
    @wraps(function)
    def wrapped(*args, **kwargs):
        options = signature.bind(*args, **kwargs).arguments
        timeout = options.get("request_timeout")
        from ._core import translate, request_seconds
        try:
            return request(lambda: function(*args, **kwargs), request_seconds(args[0] if args else None, timeout))
        except Exception as error:
            raise translate(error, "file_http" if function.__name__ in ("write", "write_files") else "other") from error
    return wrapped


class _Pending:
    def __init__(self, follow: Callable[[], None]) -> None:
        self._follow = follow
        self.done = False

    def run(self) -> None:
        if not self.done:
            self.done = True
            self._follow()


def start(follow: Callable[[], None]) -> Any:
    return _Pending(follow)


def finish(task: Any) -> None:
    task.run()


def stop(task: Any) -> None:
    task.done = True



def disconnect(task):
    stop(task)


def command_events(handle):
    from ._core import translate
    import time
    if handle._disconnected or handle._exit is not None:
        return
    if not hasattr(handle, "_events"):
        remaining = None if handle._deadline is None else handle._deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            from ._core import TimeoutException
            raise TimeoutException("The command connection timed out; the process may still be running.")
        source = handle._process.output_bytes if handle._pty else handle._process.output
        handle._events = source(cursor=handle._cursor, timeout_seconds=remaining)
    try:
        for event in handle._events:
            if handle._disconnected: return
            kind = event["type"]
            if kind in ("stdout", "stderr"):
                data = event["data"]
                if handle._pty:
                    call(handle._on_pty, data)
                    yield None, None, data
                elif kind == "stdout":
                    handle._stdout += data
                    call(handle._on_stdout, data)
                    yield data, None, None
                else:
                    handle._stderr += data
                    call(handle._on_stderr, data)
                    yield None, data, None
            elif kind == "exit": handle._exit = event
            elif kind == "truncated": handle._truncated = True
    except Exception as error:
        handle._failure = translate(error, "sandbox")
        raise handle._failure from error
    finally:
        if handle._exit is not None or handle._failure is not None or handle._disconnected:
            close_stream(handle._events)

def begin(work: Callable[[], Any]) -> Any:
    """The sync twin runs ``work`` at once: its answer is ready on return."""
    return work()


class FileStreamReader:
    def __init__(self, response, captured):
        from .._sync_client import _promised_length
        self._response = response
        self._expected, self._got = _promised_length(response.headers), 0
        self._iterator = stream(response.chunks(), captured=captured)
        self._closed = False

    def __iter__(self): return self

    def __next__(self):
        from .._sync_client import _incomplete
        try:
            try:
                chunk = next(self._iterator)
            except StopIteration:
                if self._expected is not None and self._got != self._expected:
                    raise _incomplete(self._got, self._expected)
                raise
            self._got += len(chunk)
            if self._expected is not None and self._got > self._expected:
                raise _incomplete(self._got, self._expected)
            return chunk
        except BaseException as error:
            self.close()
            if isinstance(error, Exception) and not isinstance(error, (StopIteration, StopAsyncIteration)):
                from ._core import translate
                mapped = translate(error, "file_http")
                if mapped is not error:
                    raise mapped from error
            raise

    def close(self):
        if not self._closed:
            self._closed = True
            try:
                self._iterator.close()
            finally:
                self._response.close()

    def __enter__(self): return self
    def __exit__(self, *args): self.close()


def open_file(files, target, captured):
    with request_scope(captured=captured):
        response = files._open_read(target)
    return FileStreamReader(response, captured)


def close_stream(source):
    source.close()


def stream(source: Iterator[bytes], captured=None) -> Iterator[bytes]:
    from ._core import translate
    try:
        while True:
            try:
                with request_scope(captured=captured or Limits()):
                    chunk = next(source)
            except StopIteration:
                return
            yield chunk
    except Exception as error:
        raise translate(error, "file_http") from error
    finally:
        source.close()


def wrap(callback: Any) -> Any:
    return callback


def call(callback: Any, value: Any) -> None:
    if callback is not None:
        callback(value)


class WatchHandle:
    """E2B's synchronous, polling filesystem watcher."""
    def __init__(self, native: Any, filesystem: Any, path: str, include_entry: bool) -> None:
        self._native, self._filesystem = native, filesystem
        self._prefix, self._include_entry = path.rstrip("/") + "/", include_entry
        self._closed = False

    @request_limited
    def stop(self, request_timeout: Any = None) -> None:
        if not self._closed:
            from ._core import translate
            try:
                self._native.stop()
            except Exception as error:
                raise translate(error, "file") from error
            self._closed = True

    @request_limited
    def get_new_events(self, request_timeout: Any = None) -> list:
        from . import _core as core
        if self._closed:
            raise core.SandboxException("The watcher is already stopped")
        try:
            events = self._native.get_new_events()
        except Exception as error:
            raise core.translate(error, "file") from error
        if self._native.notices:
            raise core.SandboxException("Filesystem watch events were lost; rescan the watched directory.")
        result = []
        for event in events:
            path = event["path"]
            name = path[len(self._prefix):] if path.startswith(self._prefix) else path
            entry = None
            if self._include_entry:
                try:
                    entry = self._filesystem.get_info(path)
                except core.FileNotFoundException:
                    pass
            result.append(core.FilesystemEvent(name, core.FilesystemEventType(event["type"]), entry))
        return result


def watch_directory(filesystem: Any, path: str, user: Any = None, request_timeout: Any = None,
                    recursive: bool = False, include_entry: bool = False,
                    allow_network_mounts: bool = False) -> WatchHandle:
    from . import _core as core
    if allow_network_mounts:
        raise core.NotSupportedException("Watching network mounts", "Watch a directory on the sandbox's local disk.")
    def create():
        target = filesystem._path(path, user)
        native = filesystem._files.watch(target, recursive=recursive, timeout_ms=0)
        return target, native
    try:
        target, native = request(create, core.request_seconds(filesystem, request_timeout))
    except Exception as error:
        raise core.translate(error, "file") from error
    return WatchHandle(native, filesystem, target, include_entry)
