"""Closing a Runloop channel stream closes its native output connection immediately."""
import asyncio
import unittest
from types import SimpleNamespace

from withruntime.runloop._async import AsyncExecutionsAPI
from withruntime.runloop._sync import ExecutionsAPI

EVENTS = [{"type": "stderr", "data": "err", "offset": 0},
          {"type": "stdout", "data": "out", "offset": 3}]


class Source:
    def __init__(self, *, error=None, cleanup=None):
        self.events, self.error, self.cleanup = iter(EVENTS), error, cleanup
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return next(self.events)
        except StopIteration:
            if self.error is not None:
                raise self.error
            raise

    def close(self):
        self.closed = True
        if self.cleanup is not None:
            raise self.cleanup


class AsyncSource(Source):
    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return self.__next__()
        except StopIteration:
            raise StopAsyncIteration

    async def aclose(self):
        self.close()


def sync_api(source):
    offsets = []
    def output(*, cursor):
        offsets.append(cursor)
        return source
    process = SimpleNamespace(output=output)
    sandbox = SimpleNamespace(process=lambda execution_id: process)
    runtime = SimpleNamespace(sandboxes=SimpleNamespace(get=lambda devbox_id: sandbox))
    return ExecutionsAPI(runtime), offsets


def async_api(source):
    offsets = []
    def output(*, cursor):
        offsets.append(cursor)
        return source
    process = SimpleNamespace(output=output)
    async def get_process(execution_id):
        return process
    sandbox = SimpleNamespace(process=get_process)
    async def get_sandbox(devbox_id):
        return sandbox
    runtime = SimpleNamespace(sandboxes=SimpleNamespace(get=get_sandbox))
    return AsyncExecutionsAPI(runtime), offsets


class SyncCleanup(unittest.TestCase):
    def test_close_partial_stream_closes_native_iterator(self):
        source = Source()
        api, offsets = sync_api(source)
        stream = api.stream_stdout_updates("execution", devbox_id="box", offset=3)
        self.assertEqual(next(stream).output, "out")
        stream.close()
        self.assertTrue(source.closed)
        self.assertEqual(offsets, [3])

    def test_exhaustion_preserves_stderr_and_closes_source(self):
        source = Source()
        api, _ = sync_api(source)
        self.assertEqual([part.output for part in api.stream_stderr_updates("execution", devbox_id="box")], ["err"])
        self.assertTrue(source.closed)

    def test_source_failure_closes_iterator_and_keeps_original(self):
        original = ValueError("stream failed")
        source = Source(error=original)
        api, _ = sync_api(source)
        with self.assertRaises(ValueError) as caught:
            list(api.stream_stdout_updates("execution", devbox_id="box"))
        self.assertIs(caught.exception, original)
        self.assertTrue(source.closed)

    def test_cleanup_failure_preserves_original_stream_error(self):
        original, cleanup = ValueError("stream failed"), OSError("close failed")
        source = Source(error=original, cleanup=cleanup)
        api, _ = sync_api(source)
        with self.assertRaises(ValueError) as caught:
            list(api.stream_stdout_updates("execution", devbox_id="box"))
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, cleanup)
        self.assertTrue(source.closed)


class AsyncCleanup(unittest.IsolatedAsyncioTestCase):
    async def test_close_partial_stream_closes_native_iterator(self):
        source = AsyncSource()
        api, offsets = async_api(source)
        stream = await api.stream_stdout_updates("execution", devbox_id="box", offset=3)
        self.assertEqual((await stream.__anext__()).output, "out")
        await stream.aclose()
        self.assertTrue(source.closed)
        self.assertEqual(offsets, [3])

    async def test_exhaustion_preserves_stderr_and_closes_source(self):
        source = AsyncSource()
        api, _ = async_api(source)
        stream = await api.stream_stderr_updates("execution", devbox_id="box")
        self.assertEqual([part.output async for part in stream], ["err"])
        self.assertTrue(source.closed)

    async def test_source_failure_closes_iterator_and_keeps_original(self):
        original = ValueError("stream failed")
        source = AsyncSource(error=original)
        api, _ = async_api(source)
        stream = await api.stream_stdout_updates("execution", devbox_id="box")
        with self.assertRaises(ValueError) as caught:
            [part async for part in stream]
        self.assertIs(caught.exception, original)
        self.assertTrue(source.closed)

    async def test_cleanup_failure_preserves_original_stream_error(self):
        original, cleanup = ValueError("stream failed"), OSError("close failed")
        source = AsyncSource(error=original, cleanup=cleanup)
        api, _ = async_api(source)
        stream = await api.stream_stdout_updates("execution", devbox_id="box")
        with self.assertRaises(ValueError) as caught:
            [part async for part in stream]
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, cleanup)
        self.assertTrue(source.closed)

    async def test_cancelled_read_closes_native_connection(self):
        entered, gate = asyncio.Event(), asyncio.Event()
        class WaitingSource(AsyncSource):
            async def __anext__(self):
                entered.set()
                await gate.wait()
        source = WaitingSource()
        api, _ = async_api(source)
        stream = await api.stream_stdout_updates("execution", devbox_id="box")
        pending = asyncio.create_task(stream.__anext__())
        await asyncio.wait_for(entered.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(source.closed)


if __name__ == "__main__":
    unittest.main()
