"""Prime public process streams release their native iterator deterministically."""
import asyncio
import unittest

from withruntime.prime.process import AsyncSandboxProcess
from withruntime.prime.exceptions import APIError


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_exit_closes_native_generator_before_public_stream_finishes(self):
        closed = asyncio.Event()
        class Native:
            info = {'pid': 1}
            def __init__(self):
                self.events = self.read()
            def output_bytes(self):
                return self.events
            async def read(self):
                try:
                    yield {'type': 'stdout', 'data': b'hello'}
                    yield {'type': 'exit', 'exitCode': 7}
                    await asyncio.Event().wait()
                finally:
                    closed.set()
        process = AsyncSandboxProcess(Native())
        self.assertEqual([chunk async for chunk in process.stdout], [b'hello'])
        self.assertTrue(closed.is_set())
        self.assertEqual(await process.wait(), 7)
        await process.aclose()

    async def test_canceled_wait_preserves_output_and_releases_iterator_after_exit(self):
        release, closed = asyncio.Event(), asyncio.Event()
        signals = []
        class Native:
            info = {'pid': 1}
            async def output_bytes(self):
                try:
                    yield {'type': 'stdout', 'data': b'first'}
                    await release.wait()
                    yield {'type': 'stdout', 'data': b'second'}
                    yield {'type': 'exit', 'exitCode': 0}
                    await asyncio.Event().wait()
                finally:
                    closed.set()
            async def kill(self, signal):
                signals.append(signal)
        process = AsyncSandboxProcess(Native())
        waiter = asyncio.create_task(process.wait())
        self.assertEqual(await process.stdout.__anext__(), b'first')
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertFalse(closed.is_set())
        self.assertEqual(signals, [])
        release.set()
        self.assertEqual([chunk async for chunk in process.stdout], [b'second'])
        self.assertTrue(closed.is_set())
        self.assertEqual(await process.wait(), 0)
        await process.aclose()

    async def test_cleanup_failure_keeps_original_stream_failure(self):
        original = APIError('broken stream')
        closed = []
        class Events:
            def __aiter__(self):
                return self
            async def __anext__(self):
                raise original
            async def aclose(self):
                closed.append(True)
                raise RuntimeError('cleanup failure')
        class Native:
            info = {'pid': 1}
            def output_bytes(self):
                return Events()
        process = AsyncSandboxProcess(Native())
        with self.assertRaises(APIError) as caught:
            async for _ in process.stdout:
                pass
        self.assertIs(caught.exception, original)
        self.assertEqual(closed, [True])
        with self.assertRaises(APIError) as caught:
            await process.wait()
        self.assertIs(caught.exception, original)
        await process.aclose()

    async def test_close_cancels_blocked_iterator_and_preserves_close_error(self):
        started, closed = asyncio.Event(), asyncio.Event()
        class Native:
            info = {'pid': 1}
            async def output_bytes(self):
                try:
                    started.set()
                    await asyncio.Event().wait()
                    yield {'type': 'exit', 'exitCode': 0}
                finally:
                    closed.set()
            async def kill(self, signal):
                raise RuntimeError('control unavailable')
        process = AsyncSandboxProcess(Native())
        await started.wait()
        await process.aclose()
        self.assertTrue(closed.is_set())
        with self.assertRaisesRegex(APIError, 'Process closed before its exit status was observed'):
            await process.wait()
        await process.aclose()
