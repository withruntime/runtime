"""The sync twin of _async_io: a background command's output is read when
something asks for it (its logs, or the next command in its session)."""
from __future__ import annotations

from typing import Any, Callable


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


def call(callback: Any, value: Any) -> None:
    if callback is not None:
        callback(value)


def catch_up(task: Any) -> None:
    """Reads the command's output now: nothing else will."""
    if task is not None:
        task.run()


def awaitable(work: Callable[[], Any]) -> Any:
    """Runs ``work`` when awaited, for Daytona's sync methods that are
    coroutines even in its sync client."""
    async def run() -> Any:
        return work()
    return run()


def operation(make: Callable[[], Any], mode: str) -> Any:
    """The sync API returns the sandbox itself; used as a context manager, it
    stops (or destroys) the sandbox on exit."""
    box = make()
    box._exit_mode = mode
    return box
