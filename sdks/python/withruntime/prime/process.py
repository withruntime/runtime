"""Prime's async live process API over Runtime's byte-preserving transport."""
import asyncio
from .exceptions import APIError
from .._http import within

_END = object()


class _Stream:
    def __init__(self):
        self._queue = asyncio.Queue()
        self._ended = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._ended:
            raise StopAsyncIteration
        item = await self._queue.get()
        if item is _END:
            self._ended = True
            raise StopAsyncIteration
        if isinstance(item, BaseException):
            self._ended = True
            raise item
        return item


class AsyncSandboxProcess:
    def __init__(self, process):
        self._process = process
        self.stdout, self.stderr = _Stream(), _Stream()
        self._closed, self._returncode = False, None
        self._close_lock = asyncio.Lock()
        self._signals_sent = set()
        self._exit = asyncio.get_running_loop().create_future()
        self._exit.add_done_callback(lambda future: future.exception() if not future.cancelled() else None)
        self._task = asyncio.create_task(self._pump())
        self._task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)

    @property
    def pid(self):
        value = self._process.info.get("pid")
        if not isinstance(value, int):
            raise APIError("Process metadata omitted the guest PID")
        return value

    @property
    def returncode(self):
        return self._returncode

    async def _pump(self):
        events = None
        try:
            events = self._process.output_bytes()
            async for event in events:
                if event["type"] in ("stdout", "stderr"):
                    getattr(self, event["type"])._queue.put_nowait(event["data"])
                elif event["type"] == "truncated":
                    raise APIError("Process output was truncated during reconnect")
                elif event["type"] == "exit":
                    self._returncode = event.get("exitCode")
                    if self._returncode is None:
                        raise APIError("Process exited without an exit code")
                    break
            if self._returncode is None:
                raise APIError("Process stream ended before exit status")
            self._exit.set_result(self._returncode)
            return self._returncode
        except BaseException as error:
            if isinstance(error, asyncio.CancelledError):
                error = APIError("Process closed before its exit status was observed")
            if not self._exit.done():
                self._exit.set_exception(error)
            self.stdout._queue.put_nowait(error)
            self.stderr._queue.put_nowait(error)
        finally:
            close = getattr(events, "aclose", None)
            if close is not None:
                try:
                    await close()
                except BaseException:
                    # Match Prime's cleanup: retain the original output/exit result.
                    pass
            self.stdout._queue.put_nowait(_END)
            self.stderr._queue.put_nowait(_END)

    async def write_stdin(self, data):
        if not isinstance(data, bytes):
            raise TypeError("data must be bytes")
        if not data:
            return
        if self._closed or self.returncode is not None:
            raise BrokenPipeError("process has exited")
        try:
            await self._process.write(data)
        except Exception as error:
            if getattr(error, "code", None) == "stdin_closed":
                raise BrokenPipeError("process has exited") from error
            raise

    async def wait(self):
        return await asyncio.shield(self._exit)

    async def terminate(self):
        if not self._closed and self.returncode is None:
            await self._process.kill("SIGTERM")
            self._signals_sent.add("terminate")

    async def kill(self):
        if not self._closed and self.returncode is None:
            await self._process.kill("SIGKILL")
            self._signals_sent.add("kill")

    async def _wait_for_exit(self):
        if self.returncode is not None or self._exit.done():
            return
        try:
            await within(asyncio.shield(self._exit), 5)
        except Exception:
            pass

    async def aclose(self):
        async with self._close_lock:
            if self._closed:
                return
            try:
                if self.returncode is None:
                    if "kill" in self._signals_sent:
                        await self._wait_for_exit()
                    else:
                        if "terminate" not in self._signals_sent:
                            try:
                                await self.terminate()
                            except Exception:
                                pass
                        if "terminate" in self._signals_sent:
                            await self._wait_for_exit()
                        if self.returncode is None:
                            try:
                                await self.kill()
                            except Exception:
                                pass
                            else:
                                await self._wait_for_exit()
            finally:
                if not self._task.done():
                    self._task.cancel()
                await asyncio.gather(self._task, return_exceptions=True)
                if not self._exit.done():
                    error = APIError("Process closed before its exit status was observed")
                    self._exit.set_exception(error)
                    for stream in (self.stdout, self.stderr):
                        stream._queue.put_nowait(error)
                        stream._queue.put_nowait(_END)
                self._closed = True

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()
