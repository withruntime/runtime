"""Where the async adapter differs from the sync one in kind, not just in
``await``: a background command's output is followed by a task beside the
caller, and output handlers may be coroutines."""
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable


def start(follow: Callable[[], Awaitable[None]]) -> Any:
    """Follows a background command's output now, beside the caller."""
    return asyncio.ensure_future(follow())


async def finish(task: Any) -> None:
    await task


async def call(callback: Any, value: Any) -> None:
    """Calls a handler, sync or async."""
    if callback is None:
        return
    outcome = callback(value)
    if asyncio.iscoroutine(outcome):
        await outcome


async def catch_up(task: Any) -> None:
    """Nothing to do: the task follows the output by itself."""
    return None


def awaitable(work: Callable[[], Awaitable[Any]]) -> Any:
    return work()
