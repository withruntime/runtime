"""The two places the async adapter differs from the sync one in kind, not
just in ``await``: a background command's output is followed by a task that
runs beside the caller, and a file stream is an async iterator."""
from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator, Awaitable, Callable


def start(follow: Callable[[], Awaitable[None]]) -> Any:
    """Follows a background command's output now, beside the caller."""
    return asyncio.ensure_future(follow())


async def finish(task: Any) -> None:
    try:
        await task
    except asyncio.CancelledError:
        if not task.cancelled():
            raise


def stop(task: Any) -> None:
    task.cancel()


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


async def stream(data: bytes) -> AsyncIterator[bytes]:
    yield data


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
