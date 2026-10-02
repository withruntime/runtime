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


class _Operation:
    """Vercel's single-use operation: await it for the sandbox, or use it as
    an async context manager that stops (or destroys) the sandbox on exit."""

    def __init__(self, make: Callable[[], Awaitable[Any]], mode: str) -> None:
        self._make, self._mode = make, mode
        self._box: Any = None

    def __await__(self) -> Any:
        return self._make().__await__()

    async def __aenter__(self) -> Any:
        self._box = await self._make()
        self._box._exit_mode = self._mode
        return self._box

    async def __aexit__(self, *_: Any) -> None:
        await self._box._finish(self._mode)


def operation(make: Callable[[], Awaitable[Any]], mode: str) -> Any:
    return _Operation(make, mode)


def later(delay: float, work: Callable[[], Awaitable[Any]]) -> Any:
    """Runs ``work`` beside the caller after ``delay`` seconds; ``cancel()``
    stops it. It never keeps the program from ending."""
    loop = asyncio.get_running_loop()
    return loop.call_later(delay, lambda: asyncio.ensure_future(work()))
