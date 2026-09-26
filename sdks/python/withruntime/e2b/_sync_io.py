"""The sync twin of _async_io: a background command's output is read when
``wait()`` asks for it, as E2B's sync handle does."""
from __future__ import annotations

from typing import Any, Callable, Iterator


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


def begin(work: Callable[[], Any]) -> Any:
    """The sync twin runs ``work`` at once: its answer is ready on return."""
    return work()


def stream(data: bytes) -> Iterator[bytes]:
    yield data


def wrap(callback: Any) -> Any:
    return callback


def call(callback: Any, value: Any) -> None:
    if callback is not None:
        callback(value)
