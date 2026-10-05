"""The few primitives (imported lazily: asyncio alone costs 20 ms) that differ between the async client and its generated
sync twin. The generator swaps each async_* name for its sync_* partner."""
from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, Iterable, TypeVar

T = TypeVar("T")


async def async_sleep(seconds: float) -> None:
    import asyncio
    await asyncio.sleep(seconds)


def sync_sleep(seconds: float) -> None:
    time.sleep(seconds)


def async_interrupts() -> tuple[type[BaseException], ...]:
    """What stops a caller mid-call: Ctrl-C, or a cancelled task."""
    import asyncio
    return (KeyboardInterrupt, asyncio.CancelledError)


def sync_interrupts() -> tuple[type[BaseException], ...]:
    return (KeyboardInterrupt,)


def async_timeouts() -> tuple[type[BaseException], ...]:
    """What a missed deadline raises: before Python 3.11 asyncio's is its own class."""
    import asyncio
    return (TimeoutError, asyncio.TimeoutError)


def sync_timeouts() -> tuple[type[BaseException], ...]:
    return (TimeoutError,)


async def async_parallel(fn: Callable[[T], Awaitable[Any]], items: Iterable[T], limit: int) -> None:
    import asyncio
    gate = asyncio.Semaphore(limit)

    async def one(item: T) -> None:
        async with gate:
            await fn(item)
    await asyncio.gather(*(one(item) for item in items))


def sync_parallel(fn: Callable[[T], Any], items: Iterable[T], limit: int) -> None:
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=limit) as pool:
        for _ in pool.map(fn, list(items)):
            pass


async def async_open_ws(ws: Any) -> Any:
    return await ws.connect()


def sync_open_ws(ws: Any) -> Any:
    return ws


class AsyncSlots:
    """At most ``limit`` holders at once; the rest wait their turn. The
    semaphore is made on first use, inside the running event loop."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._gate: Any = None

    async def __aenter__(self) -> None:
        if self._gate is None:
            import asyncio
            self._gate = asyncio.Semaphore(self._limit)
        from ._request_scope import current
        from ._http import within
        remaining = current().remaining()
        if remaining is None:
            await self._gate.acquire()
            return
        acquired = False
        async def acquire():
            nonlocal acquired
            await self._gate.acquire()
            acquired = True
        try:
            await within(acquire(), remaining)
        except BaseException:
            # Python 3.10 can cancel while within() receives a completed task.
            if acquired:
                self._gate.release()
            raise

    async def __aexit__(self, *_: Any) -> None:
        self._gate.release()

    async def take(self) -> None:
        await self.__aenter__()

    async def give(self) -> None:
        await self.__aexit__()


class SyncSlots:
    def __init__(self, limit: int) -> None:
        import threading
        self._gate = threading.BoundedSemaphore(limit)

    def __enter__(self) -> None:
        from ._request_scope import current
        if not self._gate.acquire(timeout=current().remaining()):
            raise TimeoutError("The request deadline expired waiting for an SDK slot")

    def __exit__(self, *_: Any) -> None:
        self._gate.release()

    def take(self) -> None:
        self.__enter__()

    def give(self) -> None:
        self.__exit__()


async_slots = AsyncSlots
sync_slots = SyncSlots


def async_background(fn: Callable[[], Awaitable[Any]]) -> Callable[[], None]:
    """Runs ``fn()`` as a task on the running loop; the answer cancels it."""
    import asyncio
    task = asyncio.get_running_loop().create_task(fn())
    return lambda: None if task.done() else task.cancel() and None


def sync_background(fn: Callable[[], Any]) -> Callable[[], None]:
    """Runs ``fn()`` on a daemon thread, which ends at its next check once the
    loop inside it is told to stop."""
    import threading
    threading.Thread(target=fn, daemon=True, name="withruntime-background").start()
    return lambda: None
