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


def later(delay: float, work: Callable[[], Awaitable[Any]]) -> Any:
    """Runs ``work`` beside the caller after ``delay`` seconds; ``cancel()``
    stops it. It never keeps the program from ending."""
    loop = asyncio.get_running_loop()
    return loop.call_later(delay, lambda: asyncio.ensure_future(work()))


def pty_options(args: tuple, kwargs: dict) -> tuple:
    """Daytona's async create_pty_session(id, on_data, cwd, envs, pty_size):
    (on_data, cwd, envs, pty_size)."""
    names = ("on_data", "cwd", "envs", "pty_size")
    given = dict(zip(names, args))
    given.update(kwargs)
    return tuple(given.get(name) for name in names)


class AsyncPtyHandle:
    """One connection to a PTY session, Daytona's AsyncPtyHandle over
    Runtime's terminal WebSocket: its output goes to ``on_data`` as it comes."""

    def __init__(self, terminal: Any, session_id: str, on_data: Any,
                 resize: Callable[[Any], Awaitable[Any]], kill: Callable[[], Awaitable[None]]) -> None:
        self._terminal, self._session_id = terminal, session_id
        self._resize, self._kill = resize, kill
        self._exit_code: Any = None
        self._error: Any = None
        self._connected = True
        self._disconnected = False
        self._task = asyncio.ensure_future(self._pump(on_data))

    async def _pump(self, on_data: Any) -> None:
        try:
            while True:
                data = await self._terminal.recv()
                if data is None:
                    break
                await call(on_data, data)
        except Exception as error:  # noqa: BLE001 - kept as the handle's error, as Daytona does
            if not self._disconnected:
                self._error = f"WebSocket error: {error}"
        self._connected = False
        self._exit_code = self._terminal.exit_code
        if self._exit_code is None and self._error is None:
            self._error = ("Disconnected; the PTY session keeps running. connect_pty_session() attaches again."
                           if self._disconnected else "The PTY session was ended by a signal.")

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

    async def wait_for_connection(self) -> None:
        """Returns at once: the handle is returned connected."""
        return None

    async def send_input(self, data: Any) -> None:
        from ._core import DaytonaConnectionError
        if not self._connected:
            raise DaytonaConnectionError("PTY is not connected")
        await self._terminal.write(data)

    async def wait(self) -> Any:
        """The session's end (or this connection's) with its exit code, or
        ``error`` saying why there is none."""
        from ._core import PtyResult
        await asyncio.shield(self._task)
        return PtyResult(exit_code=self._exit_code, error=self._error)

    async def resize(self, pty_size: Any) -> Any:
        return await self._resize(pty_size)

    async def kill(self) -> None:
        await self._kill()

    async def disconnect(self) -> None:
        """Closes this connection; the session keeps running."""
        if not self._connected:
            return
        self._disconnected = True
        await self._terminal.close()
        await asyncio.shield(self._task)
