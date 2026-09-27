"""The sync twin of _async_io: work beside the caller runs on a daemon
thread, as Blaxel's sync SDK runs its log streams and watches."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, List, Optional

from .._http import Origin, SyncHTTP


class _Thread:
    def __init__(self, work: Callable[[], Any]) -> None:
        self.cancelled = threading.Event()
        self.error: Optional[BaseException] = None
        self._thread = threading.Thread(target=self._run, args=(work,), daemon=True, name="withruntime-blaxel")
        self._thread.start()

    def _run(self, work: Callable[[], Any]) -> None:
        try:
            work()
        except BaseException as error:  # noqa: BLE001 - kept for whoever waits
            if not self.cancelled.is_set():
                self.error = error

    def join(self, timeout: Optional[float]) -> None:
        self._thread.join(timeout)
        if self._thread.is_alive():
            raise TimeoutError("The stream did not end in time.")
        if self.error is not None:
            raise self.error


def start(work: Callable[[], Any]) -> Any:
    return _Thread(work)


def stop(task: Any) -> None:
    """Asks the thread to stop; it ends at its next read."""
    task.cancelled.set()


def finish(task: Any, timeout: Any = None) -> None:
    task.join(timeout)


def call(callback: Any, value: Any) -> None:
    if callback is not None:
        callback(value)


def gather(*works: Callable[[], Any]) -> List[Any]:
    return [work() for work in works]


def now() -> float:
    return time.monotonic()


def http(origin: str) -> SyncHTTP:
    return SyncHTTP(Origin(origin))
