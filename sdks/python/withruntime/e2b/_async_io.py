"""The two places the async adapter differs from the sync one in kind, not
just in ``await``: a background command's output is followed by a task that
runs beside the caller, and a file stream is an async iterator."""
from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Awaitable, Callable
from functools import wraps
import inspect
from .._request_scope import Limits, current, request_scope
from .._clock import async_background as background, async_sleep as sleep  # noqa: F401 - the lease keeper's
from .._http import within


def start(follow: Callable[[], Awaitable[None]]) -> Any:
    """Follows a background command's output now, beside the caller."""
    # A start/attach request's budget must not leak into the output task.
    with request_scope(captured=Limits()):
        return asyncio.ensure_future(follow())


async def request(work, timeout=None):
    with request_scope(timeout) as scope:
        remaining = scope.remaining()
        return await work() if remaining is None else await within(work(), remaining)



def opening_timeout(deadline, requested):
    import time
    remaining = None if deadline is None else deadline - time.monotonic()
    if remaining is not None and remaining <= 0:
        from ._core import TimeoutException
        raise TimeoutException('The command connection timed out before it opened')
    budget = requested or None
    if remaining is not None:
        budget = remaining if budget is None else min(remaining, budget)
    return budget or 0

def request_limited(function):
    signature = inspect.signature(function)
    @wraps(function)
    async def wrapped(*args, **kwargs):
        options = signature.bind(*args, **kwargs).arguments
        timeout = options.get("request_timeout")
        from ._core import translate, request_seconds
        try:
            return await request(lambda: function(*args, **kwargs), request_seconds(args[0] if args else None, timeout))
        except Exception as error:
            raise translate(error, "file_http" if function.__name__ in ("write", "write_files") else "other") from error
    return wrapped


async def finish(task: Any) -> None:
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        if not task.cancelled():
            # The caller cancelled its wait. Close the output subscription,
            # preserve its cancellation, and leave the remote process alive.
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            raise


def stop(task: Any) -> None:
    task.cancel()



async def disconnect(task):
    task.cancel()
    if task is not asyncio.current_task():
        await finish(task)

def begin(work: Callable[[], Awaitable[Any]]) -> Any:
    """Starts ``work`` now, beside the caller, for whoever awaits it later. A
    failure is kept for that caller and also said as a warning, so it is
    never lost if nobody asks."""
    task = asyncio.ensure_future(work())

    def said(done: Any) -> None:
        if not done.cancelled() and done.exception() is not None:
            import warnings
            warnings.warn(f"Runtime: {done.exception()}", RuntimeWarning, stacklevel=1)
    task.add_done_callback(said)
    return task


class AsyncFileStreamReader:
    def __init__(self, response, captured):
        from .._async_client import _promised_length
        self._response = response
        self._expected, self._got = _promised_length(response.headers), 0
        self._iterator = stream(response.chunks(), captured=captured)
        self._closed = False

    def __aiter__(self): return self

    async def __anext__(self):
        from .._async_client import _incomplete
        try:
            try:
                chunk = await self._iterator.__anext__()
            except StopAsyncIteration:
                if self._expected is not None and self._got != self._expected:
                    raise _incomplete(self._got, self._expected)
                raise
            self._got += len(chunk)
            if self._expected is not None and self._got > self._expected:
                raise _incomplete(self._got, self._expected)
            return chunk
        except BaseException as error:
            await self.aclose()
            if isinstance(error, Exception) and not isinstance(error, (StopIteration, StopAsyncIteration)):
                from ._core import translate
                mapped = translate(error, "file_http")
                if mapped is not error:
                    raise mapped from error
            raise

    async def aclose(self):
        if not self._closed:
            self._closed = True
            try:
                await self._iterator.aclose()
            finally:
                await self._response.close()

    async def __aenter__(self): return self
    async def __aexit__(self, *args): await self.aclose()


async def open_file(files, target, captured):
    response = None
    async def start():
        nonlocal response
        response = await files._open_read(target)
        return response
    try:
        with request_scope(captured=captured):
            timeout = current().timeout(None)
            response = await start() if timeout is None else await within(start(), timeout)
    except BaseException:
        if response is not None:
            await response.close()
        raise
    return AsyncFileStreamReader(response, captured)


async def close_stream(source):
    await source.aclose()


async def stream(source: AsyncIterator[bytes], captured=None) -> AsyncIterator[bytes]:
    from ._core import translate
    try:
        while True:
            try:
                with request_scope(captured=captured or Limits()):
                    timeout = current().timeout(None)
                    chunk = await source.__anext__() if timeout is None else await within(source.__anext__(), timeout)
            except StopAsyncIteration:
                return
            yield chunk
    except Exception as error:
        raise translate(error, "file_http") from error
    finally:
        await source.aclose()


_pending: set = set()


def wrap(callback: Any) -> Any:
    """An E2B handler, sync or async, as the plain function Runtime's SDK calls."""
    if callback is None:
        return None

    def handle(value: Any) -> None:
        outcome = callback(value)
        if asyncio.iscoroutine(outcome):
            task = asyncio.ensure_future(outcome)
            _pending.add(task)
            task.add_done_callback(_pending.discard)
    return handle


async def call(callback: Any, value: Any) -> None:
    """Calls an E2B output handler, sync or async."""
    if callback is None:
        return
    outcome = callback(value)
    if asyncio.iscoroutine(outcome):
        await outcome


class AsyncWatchHandle:
    """E2B's asynchronous callback watcher. The terminal callback runs once."""
    def __init__(self, native: Any, filesystem: Any, path: str, on_event: Any,
                 on_exit: Any, include_entry: bool, timeout: Any = None) -> None:
        self._native, self._filesystem = native, filesystem
        self._prefix = path.rstrip("/") + "/"
        self._on_event, self._on_exit = on_event, on_exit
        self._include_entry, self._closed = include_entry, False
        self._notified = False
        self._native_stopped = False
        self._timeout = timeout or None
        self._reader = None
        self._wait = asyncio.create_task(self._follow())

    async def _notify(self, error: Any) -> None:
        if self._notified:
            return
        self._notified = True
        try:
            await call(self._on_exit, error)
        except Exception:
            pass

    async def _stop_native(self) -> None:
        if not self._native_stopped:
            self._native_stopped = True
            await self._native.stop()

    async def _read(self) -> None:
        from . import _core as core
        self._reader = asyncio.current_task()
        events = self._native.events()
        try:
            async for event in events:
                if self._native.notices:
                    raise core.SandboxException("Filesystem watch events were lost; rescan the watched directory.")
                path = event["path"]
                name = path[len(self._prefix):] if path.startswith(self._prefix) else path
                entry = None
                if self._include_entry:
                    try:
                        entry = await self._filesystem.get_info(path)
                    except core.FileNotFoundException:
                        pass
                await call(self._on_event, core.FilesystemEvent(name, core.FilesystemEventType(event["type"]), entry))
                if self._closed:
                    break
            if self._native.notices:
                raise core.SandboxException("Filesystem watch events were lost; rescan the watched directory.")
        finally:
            await events.aclose()

    async def _follow(self) -> None:
        from . import _core as core
        from .._http import within
        error = None
        try:
            if self._timeout is None:
                await self._read()
            else:
                await within(self._read(), self._timeout)
        except asyncio.TimeoutError:
            error = core.TimeoutException("The filesystem watch connection timed out")
        except asyncio.CancelledError:
            pass
        except Exception as caught:
            error = core.translate(caught, "file")
        finally:
            await self._notify(error)
            try:
                await self._stop_native()
            except Exception:
                pass

    async def stop(self) -> None:
        if self._closed:
            return
        self._closed = True
        if asyncio.current_task() in (self._wait, self._reader):
            # A callback can stop its own watch. Awaiting this task from
            # itself deadlocks; _follow notices _closed after the callback.
            await self._stop_native()
            return
        self._wait.cancel()
        try:
            await self._wait
        except asyncio.CancelledError:
            # A task cancelled before its first turn never enters finally.
            await self._notify(None)
            await self._stop_native()


async def watch_directory(filesystem: Any, path: str, on_event: Any, on_exit: Any = None,
                          user: Any = None, request_timeout: Any = None, timeout: Any = 60,
                          recursive: bool = False, include_entry: bool = False,
                          allow_network_mounts: bool = False) -> AsyncWatchHandle:
    import math
    from . import _core as core
    if allow_network_mounts:
        raise core.NotSupportedException("Watching network mounts", "Watch a directory on the sandbox's local disk.")
    if timeout is not None and (not math.isfinite(timeout) or timeout < 0):
        raise core.InvalidArgumentException("timeout must be a nonnegative finite number")
    async def create():
        from ._core import NotSupportedException, other_user
        if other_user(user):
            raise NotSupportedException(f'Watching a directory as the user "{user}"',
                                        "Watch it as the sandbox's own user (leave user out); Runtime's watch "
                                        "reports changes made by anyone.")
        target = await filesystem._path(path, user)
        native = await filesystem._files.watch(target, recursive=recursive, timeout_ms=0)
        return target, native
    try:
        target, native = await request(create, core.request_seconds(filesystem, request_timeout))
    except Exception as error:
        raise core.translate(error, "file") from error
    return AsyncWatchHandle(native, filesystem, target, on_event, on_exit, include_entry, timeout)


async def next_event(events: Any) -> Any:
    """The first event of a command's stream: its start."""
    return await events.__anext__()


async def each_event(events: Any, limits: Any) -> Any:
    """A started command's events, each read under its connection deadline:
    the stream resumes itself in new requests, which the deadline must reach."""
    import time
    from .._request_scope import request_scope
    while True:
        with request_scope(captured=limits):
            try:
                event = await events.__anext__()
            except StopAsyncIteration:
                return
            except Exception as error:  # noqa: BLE001 - past the deadline, any failure is the deadline's
                if limits.deadline is not None and time.monotonic() >= limits.deadline:
                    from ._core import TimeoutException
                    raise TimeoutException("The command connection timed out; the process may still be running. "
                                           "Reconnect with commands.connect(pid).") from error
                raise
        yield event


def past_deadline(handle: Any) -> None:
    """A stream the command was started with goes on in slices the first
    request's deadline does not reach; the handle's deadline still holds."""
    import time
    if handle._deadline is not None and time.monotonic() > handle._deadline:
        from ._core import TimeoutException
        raise TimeoutException("The command connection timed out; the process may still be running. "
                               "Reconnect with commands.connect(pid).")
