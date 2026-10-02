"""Execution deadlines retain modal 1.6.0's -1/EOF contract."""
import asyncio
import importlib.metadata
import os
from types import SimpleNamespace
import unittest

from withruntime.modal import ContainerProcess
from withruntime.modal._async import AsyncContainerProcess


class SyncDeadline:
    def output(self):
        yield {'type': 'stdout', 'data': 'partial'}
        yield {'type': 'exit', 'exitCode': None, 'timedOut': True}


class AsyncDeadline:
    async def output(self):
        for event in SyncDeadline().output():
            yield event


class Deadlines(unittest.TestCase):
    def test_sync_wait_poll_and_output_keep_timeout_sentinel(self):
        process = ContainerProcess(SyncDeadline())
        self.assertEqual(process.wait(), -1)
        self.assertEqual(process.poll(), -1)
        self.assertEqual(process.stdout.read(), 'partial')
        self.assertEqual(process.stdout.read(), '')
        self.assertEqual(process.stderr.read(), '')

    def test_async_wait_poll_and_output_keep_timeout_sentinel(self):
        async def run():
            process = AsyncContainerProcess(AsyncDeadline())
            self.assertEqual(await process.wait.aio(), -1)
            self.assertEqual(await process.poll.aio(), -1)
            self.assertEqual(await process.stdout.read.aio(), 'partial')
            self.assertEqual(await process.stdout.read.aio(), '')
            self.assertEqual(await process.stderr.read.aio(), '')
        asyncio.run(run())

    @unittest.skipUnless(os.environ.get('RUNTIME_COMPAT_OFFICIAL') == '1', 'Pinned official SDK opt-in')
    def test_pinned_official_wait_poll_and_stream_timeout_match(self):
        self.assertEqual(importlib.metadata.version('modal'), '1.6.0')
        from modal.container_process import _ContainerProcess
        from modal.exception import ExecTimeoutError

        class Router:
            async def exec_wait(self, *args):
                raise ExecTimeoutError('controlled deadline')

            async def exec_poll(self, *args):
                raise ExecTimeoutError('controlled deadline')

            async def exec_stdio_read(self, task, process, channel, deadline, **kwargs):
                if channel == 1:
                    yield SimpleNamespace(data=b'partial')
                raise ExecTimeoutError('controlled deadline')

        async def run():
            official = _ContainerProcess('process', 'task', None, Router())
            runtime = AsyncContainerProcess(AsyncDeadline())
            async def consumer(process, adapter=False):
                if adapter:
                    return (await process.wait.aio(), await process.poll.aio(),
                            await process.stdout.read.aio(), await process.stderr.read.aio())
                return (await process.wait(), await process.poll(),
                        await process.stdout.read(), await process.stderr.read())
            self.assertEqual(await consumer(runtime, True), await consumer(official))
            self.assertEqual(await _ContainerProcess('process', 'task', None, Router()).poll(), -1)
        from modal.io_streams import synchronizer
        synchronizer.create_blocking(run)()
