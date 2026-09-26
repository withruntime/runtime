"""Real peer EOF proves stream/pool cleanup; a Python object disappearing does not."""
import asyncio
import unittest

from withruntime._async_client import _Transport


class AsyncStreamCleanupTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.eof = asyncio.Event()
        self.accepted = asyncio.Event()
        self.writers = []
        self.peer_eofs = []
        self.responses = []
        self.handlers = set()
        self.body = b'{"event":1}\n{"event":2}\n'
        self.partial = False
        self.errors = []

        async def answer(reader, writer):
            task = asyncio.current_task()
            self.handlers.add(task)
            self.writers.append(writer)
            peer_eof = asyncio.Event()
            self.peer_eofs.append(peer_eof)
            try:
                await reader.readuntil(b'\r\n\r\n')
                body = self.responses.pop(0) if self.responses else self.body
                length = len(body) + (100 if self.partial else 0)
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: '
                             + str(length).encode() + b'\r\n\r\n' + body)
                await writer.drain()
                self.accepted.set()
                await reader.read()
                self.eof.set()
                peer_eof.set()
            except BaseException as error:
                self.errors.append(error)
            finally:
                writer.close()
                await writer.wait_closed()
                self.handlers.discard(task)

        self.server = await asyncio.start_server(answer, '127.0.0.1', 0)
        self.transport = _Transport('fixture', f'http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}', 5, 0)

    async def asyncTearDown(self):
        # Observe EOF before this fallback fixture cleanup, including on the
        # unfixed implementation. Never count fixture shutdown as SDK cleanup.
        await self.transport.close()
        await asyncio.sleep(0)
        await self.transport.close()
        for writer in self.writers:
            writer.close()
            await writer.wait_closed()
        self.server.close()
        await self.server.wait_closed()
        if self.handlers:
            await asyncio.gather(*self.handlers)
        self.assertEqual(self.errors, [])

    async def assert_peer_closed(self):
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in self.peer_eofs)), 0.5)
        self.assertEqual(len(self.transport._http._idle), 0)

    async def test_cancel_in_the_turn_a_read_completes_is_not_swallowed(self):
        """Python 3.11's asyncio.wait_for returned the read's data and dropped the cancel
        (CPython gh-86296); the stream then read on until its timeout, which is how
        test_cancelled_pending_read_closes_peer failed there. Both paths of within()."""
        import unittest.mock
        from withruntime._http import within

        async def race():
            ready = asyncio.get_running_loop().create_future()

            async def read():
                return await ready
            task = asyncio.create_task(within(read(), 5))
            await asyncio.sleep(0)
            ready.set_result(b'data')
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        async def results():
            self.assertEqual(await within(asyncio.sleep(0, b'ok'), 5), b'ok')
            with self.assertRaises(asyncio.TimeoutError):
                await within(asyncio.sleep(5), 0.01)

        await race()
        await results()
        # Python 3.10 has no asyncio.timeout: the fallback waits on a task instead.
        with unittest.mock.patch.dict(asyncio.__dict__):
            asyncio.__dict__.pop('timeout', None)
            await race()
            await results()

    async def test_buffered_stream_close_then_transport_close_does_not_repool_later(self):
        stream = self.transport.events('GET', '/events')
        self.assertEqual(await anext(stream), {'event': 1})
        await stream.aclose()
        await self.transport.close()
        await self.assert_peer_closed()
        await asyncio.sleep(0)
        self.assertEqual(len(self.transport._http._idle), 0)

    async def test_partial_stream_close_immediately_closes_peer_without_pool_close(self):
        self.partial = True
        stream = self.transport.events('GET', '/events')
        self.assertEqual(await anext(stream), {'event': 1})
        await stream.aclose()
        await self.assert_peer_closed()

    async def test_json_decode_error_closes_partial_response(self):
        self.body, self.partial = b'not-json\n', True
        stream = self.transport.events('GET', '/events')
        with self.assertRaises(ValueError):
            await anext(stream)
        await self.assert_peer_closed()

    async def test_cancelled_pending_read_closes_peer(self):
        self.body, self.partial = b'{"unfinished":', True
        stream = self.transport.events('GET', '/events')
        pending = asyncio.create_task(anext(stream))
        await self.accepted.wait()
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        await stream.aclose()
        await self.assert_peer_closed()

    async def test_completed_response_released_after_pool_close_is_not_kept(self):
        response = await self.transport.send('GET', '/events')
        self.assertEqual(await response._read_some(), self.body)
        await self.transport.close()
        await response.close()
        await self.assert_peer_closed()

    async def test_transport_close_closes_a_response_held_by_a_caller(self):
        self.partial = True
        response = await self.transport.send('GET', '/events')
        await self.transport.close()
        try:
            await self.assert_peer_closed()
        finally:
            await response.close()

    async def test_send_after_pool_close_never_opens_a_socket(self):
        await self.transport.close()
        with self.assertRaisesRegex(RuntimeError, "HTTP pool is closed"):
            await self.transport.send('GET', '/events')
        self.assertEqual(self.writers, [])


    async def test_public_exec_stream_closes_partial_inner_stream_without_client_close(self):
        from withruntime._async_client import AsyncSandbox
        self.body = b'{"type":"stdout","offset":0,"data":"hello"}\n'
        self.partial = True
        retained = []
        events = self.transport.events

        def retain_stream(*args, **kwargs):
            # Keep the inner iterator alive so this tests explicit ownership,
            # not CPython's later async-generator finalizer scheduling.
            stream = events(*args, **kwargs)
            retained.append(stream)
            return stream

        self.transport.events = retain_stream
        stream = AsyncSandbox(self.transport, {"id": "fixture"}).exec_stream(["echo", "hello"])
        try:
            self.assertEqual((await anext(stream))["data"], "hello")
            await stream.aclose()
            await self.assert_peer_closed()
        finally:
            await stream.aclose()
            for inner in retained:
                await inner.aclose()


    async def test_public_process_output_and_exec_continuation_close_inner_streams(self):
        from withruntime._async_client import AsyncProcess, AsyncSandbox
        self.partial = True
        self.body = b'{"type":"stdout","offset":0,"data":"hello"}\n'
        retained = []
        events = self.transport.events
        def retain_stream(*args, **kwargs):
            inner = events(*args, **kwargs)
            retained.append(inner)
            return inner
        self.transport.events = retain_stream
        for continuing in [False, True]:
            if continuing:
                self.responses = [b'{"type":"continue","processId":"process","cursor":0}\n', self.body]
                stream = AsyncSandbox(self.transport, {"id":"fixture"}).exec_stream(["echo", "hello"])
            else:
                stream = AsyncProcess(self.transport, "fixture", {"id":"process"}).output()
            try:
                self.assertEqual((await anext(stream))["data"], "hello")
                await stream.aclose()
                await self.assert_peer_closed()
            finally:
                await stream.aclose()
                for inner in retained:
                    await inner.aclose()
        self.assertEqual(len(self.writers), 3)


class SyncStreamCleanupTest(unittest.TestCase):
    def setUp(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from withruntime._sync_client import _Transport as SyncTransport
        self.eof = threading.Event()
        eof = self.eof
        body = b'{"event":1}\n{"event":2}\n'

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
                if self.rfile.read(1) == b'':
                    eof.set()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.transport = SyncTransport('fixture', f'http://127.0.0.1:{self.server.server_port}', 5, 0)

    def tearDown(self):
        self.transport.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_generator_close_closes_unread_response_without_pool_close(self):
        stream = self.transport.events('GET', '/events')
        self.assertEqual(next(stream), {'event': 1})
        stream.close()
        self.assertTrue(self.eof.wait(0.5), 'SDK did not close the peer before fixture cleanup')

    def test_late_response_close_cannot_refill_closed_sync_pool(self):
        response = self.transport.send('GET', '/events')
        response._response.read()
        self.transport.close()
        response.close()
        self.assertTrue(self.eof.wait(0.5), 'closed pool retained a late response')
        self.assertEqual(self.transport._http._idle.qsize(), 0)


class NoWaitForTest(unittest.TestCase):
    def test_no_module_uses_asyncio_wait_for(self):
        # asyncio.wait_for loses a cancel before Python 3.12 (gh-86296); the
        # client waits through _http.within instead, everywhere.
        import re
        from pathlib import Path
        package = Path(__file__).resolve().parent.parent / "withruntime"
        found = [f"{path.relative_to(package)}:{number}"
                 for path in sorted(package.rglob("*.py"))
                 for number, line in enumerate(path.read_text().splitlines(), 1)
                 if re.search(r"\basyncio\.wait_for\(", line)]
        self.assertEqual(found, [])

