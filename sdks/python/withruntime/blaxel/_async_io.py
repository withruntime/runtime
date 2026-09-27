"""Where the async adapter differs from the sync one in kind, not just in
``await``: work that runs beside the caller (log streams, watches) is a task,
handlers may be coroutines, and a port is fetched over asyncio."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, List

from .._http import AsyncHTTP, Origin, within


def start(work: Callable[[], Awaitable[Any]]) -> Any:
    """Runs ``work`` now, beside the caller."""
    return asyncio.ensure_future(work())


def stop(task: Any) -> None:
    task.cancel()


async def finish(task: Any, timeout: Any = None) -> None:
    """Waits for ``task``; a cancelled one is finished, a failed one raises."""
    try:
        await within(asyncio.shield(task), timeout) if timeout is not None else await task
    except asyncio.CancelledError:
        if not task.cancelled():
            raise


async def call(callback: Any, value: Any) -> None:
    """Calls a Blaxel handler, sync or async."""
    if callback is None:
        return
    outcome = callback(value)
    if asyncio.iscoroutine(outcome):
        await outcome


async def gather(*works: Callable[[], Awaitable[Any]]) -> List[Any]:
    """Runs independent calls at once."""
    return list(await asyncio.gather(*(work() for work in works)))


def now() -> float:
    return time.monotonic()


def http(origin: str) -> AsyncHTTP:
    return AsyncHTTP(Origin(origin))
