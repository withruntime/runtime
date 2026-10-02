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


def later(delay: float, work: Callable[[], Any]) -> Any:
    """Runs ``work`` on a daemon thread after ``delay`` seconds; ``cancel()``
    stops it. It never keeps the program from ending."""
    import threading
    timer = threading.Timer(delay, work)
    timer.daemon = True
    timer.start()
    return timer


def pty_options(args: tuple, kwargs: dict) -> tuple:
    """Daytona's sync create_pty_session(id, cwd, envs, pty_size): the output
    is read by iterating the handle or with wait(on_data)."""
    names = ("cwd", "envs", "pty_size")
    given = dict(zip(names, args))
    given.update(kwargs)
    return (given.get("on_data"),) + tuple(given.get(name) for name in names)


class PtyHandle:
    """One connection to a PTY session, Daytona's PtyHandle over Runtime's
    terminal WebSocket: iterate it for output, or wait(on_data)."""

    def __init__(self, terminal: Any, session_id: str, on_data: Any,
                 resize: Callable[[Any], Any], kill: Callable[[], None]) -> None:
        self._terminal, self._session_id = terminal, session_id
        self._resize, self._kill = resize, kill
        self._exit_code: Any = None
        self._error: Any = None
        self._connected = True
        self._disconnected = False
        self._on_data = on_data

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def exit_code(self) -> Any:
        return self._exit_code

    @property
    def error(self) -> Any:
        return self._error

    def is_connected(self) -> bool:
        return self._connected

    def wait_for_connection(self, timeout: float = 10.0) -> None:
        """Returns at once: the handle is returned connected."""
        return None

    def send_input(self, data: Any) -> None:
        from ._core import DaytonaConnectionError
        if not self._connected:
            raise DaytonaConnectionError("PTY is not connected")
        self._terminal.write(data)

    def __iter__(self) -> Any:
        try:
            while self._connected:
                data = self._terminal.recv()
                if data is None:
                    break
                yield data
        except Exception as error:  # noqa: BLE001 - kept as the handle's error, as Daytona does
            if not self._disconnected:
                self._error = f"WebSocket error: {error}"
        self._finish()

    def _finish(self) -> None:
        self._connected = False
        self._exit_code = self._terminal.exit_code
        if self._exit_code is None and self._error is None:
            self._error = ("Disconnected; the PTY session keeps running. connect_pty_session() attaches again."
                           if self._disconnected else "The PTY session was ended by a signal.")

    def wait(self, on_data: Any = None, timeout: Any = None) -> Any:
        """Reads until the session ends (or ``timeout`` seconds pass), giving
        each chunk to ``on_data``; its exit code, or ``error`` saying why
        there is none."""
        import time
        from ._core import PtyResult
        handler = on_data or self._on_data
        started = time.time()
        for data in self:
            if handler is not None:
                handler(data)
            if timeout and time.time() - started > timeout:
                break
        return PtyResult(exit_code=self._exit_code, error=self._error)

    def resize(self, pty_size: Any) -> Any:
        return self._resize(pty_size)

    def kill(self) -> None:
        self._kill()

    def disconnect(self) -> None:
        """Closes this connection; the session keeps running."""
        if not self._connected:
            return
        self._disconnected = True
        self._terminal.close()
        self._finish()
