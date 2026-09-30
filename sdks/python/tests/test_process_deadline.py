"""Native subscription deadlines against real local HTTP, including partial lines."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time
import unittest
from unittest.mock import patch

from withruntime import _http

from withruntime._async_client import AsyncProcess, _Transport as AsyncTransport
from withruntime._sync_client import Process, _Transport as SyncTransport
from withruntime._errors import RuntimeError


# A deadline on a request that completes, and the later /slow answer on the same
# connection that the deadline's timer must not reach: /slow waits well past it,
# and the deadline leaves a loaded machine room to finish /ok.
FINISHED_DEADLINE, SLOW = 0.2, 0.5


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.paths.append(self.path)
        self.server.peers.append(self.client_address)
        if self.path in ("/ok", "/slow"):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            if self.path == "/slow":
                time.sleep(SLOW)
            self.wfile.write(b"{}")
            self.wfile.flush()
            return
        if "/headers/" in self.path or "/header-fragment/" in self.path:
            self.close_connection = True
            try:
                self.wfile.write(b"HTTP/1.1 200 OK\r\n")
                fragmented = "/header-fragment/" in self.path
                self.wfile.write(b"X-Slow: " if fragmented else b"")
                for index in range(100):
                    self.wfile.write(b"x" if fragmented else f"X-Slow-{index}: x\r\n".encode())
                    self.wfile.flush()
                    time.sleep(0.01)
                self.wfile.write(b"\r\nContent-Length: 0\r\n\r\n")
                self.wfile.flush()
            except OSError:
                pass
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for index in range(200):
                # A byte arriving within every socket timeout must not extend
                # the total deadline forever while the JSON line is incomplete.
                data = b" " if "/drip/" in self.path else (
                    json.dumps({"type": "stdout", "data": "x", "offset": index}) + "\n").encode()
                self.wfile.write(data)
                self.wfile.flush()
                time.sleep(0.01)
        except OSError:
            pass


class ProcessDeadlineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.paths = []
        cls.server.peers = []
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:%d" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_sync_deadline_bounds_silent_partial_and_continuous_output(self):
        for mode in ("drip", "events", "headers", "header-fragment"):
            with self.subTest(mode=mode):
                before = len(self.server.paths)
                transport = SyncTransport("fixture", self.url, 2, 0)
                started = time.monotonic()
                try:
                    with self.assertRaises(RuntimeError) as failure:
                        list(Process(transport, mode, {"id": "p"}).output(timeout_seconds=0.08))
                    self.assertEqual(failure.exception.code, "request_timeout")
                    self.assertLess(time.monotonic() - started, 0.8)
                    self.assertEqual(len(self.server.paths) - before, 1)
                finally:
                    transport.close()

    def test_async_deadline_bounds_silent_partial_and_continuous_output(self):
        async def run(mode):
            before = len(self.server.paths)
            transport = AsyncTransport("fixture", self.url, 2, 0)
            started = time.monotonic()
            try:
                with self.assertRaises(RuntimeError) as failure:
                    async for _ in AsyncProcess(transport, mode, {"id": "p"}).output(timeout_seconds=0.08):
                        pass
                self.assertEqual(failure.exception.code, "request_timeout")
                self.assertLess(time.monotonic() - started, 0.8)
                self.assertEqual(len(self.server.paths) - before, 1)
            finally:
                await transport.close()
        for mode in ("drip", "events", "headers", "header-fragment"):
            with self.subTest(mode=mode):
                asyncio.run(run(mode))

    def test_sync_header_timer_cannot_interrupt_reused_connection(self):
        transport = SyncTransport("fixture", self.url, 2, 0)
        try:
            response = transport.send("GET", "/ok", deadline=time.monotonic() + FINISHED_DEADLINE)
            self.assertEqual(response.read(), b"{}")
            peer = self.server.peers[-1]
            self.assertEqual(transport.send("GET", "/slow").read(), b"{}")
            self.assertEqual(self.server.peers[-1], peer)
            with self.assertRaises(RuntimeError):
                list(Process(transport, "headers", {"id": "p"}).output(timeout_seconds=0.08))
            broken_peer = self.server.peers[-1]
            self.assertEqual(transport.send("GET", "/ok").read(), b"{}")
            self.assertNotEqual(self.server.peers[-1], broken_peer)
        finally:
            transport.close()

    def test_async_header_timer_cannot_interrupt_reused_connection(self):
        async def run():
            transport = AsyncTransport("fixture", self.url, 2, 0)
            try:
                response = await transport.send("GET", "/ok", deadline=time.monotonic() + FINISHED_DEADLINE)
                self.assertEqual(await response.read(), b"{}")
                peer = self.server.peers[-1]
                self.assertEqual(await (await transport.send("GET", "/slow")).read(), b"{}")
                self.assertEqual(self.server.peers[-1], peer)
                with self.assertRaises(RuntimeError):
                    async for _ in AsyncProcess(transport, "headers", {"id": "p"}).output(timeout_seconds=0.08):
                        pass
                broken_peer = self.server.peers[-1]
                self.assertEqual(await (await transport.send("GET", "/ok")).read(), b"{}")
                self.assertNotEqual(self.server.peers[-1], broken_peer)
            finally:
                await transport.close()
        asyncio.run(run())

    def test_async_cancel_while_headers_arrive_is_preserved_and_socket_discarded(self):
        async def run():
            transport = AsyncTransport("fixture", self.url, 2, 0)
            async def consume():
                async for _ in AsyncProcess(transport, "headers", {"id": "cancel"}).output(timeout_seconds=1):
                    pass
            try:
                before = len(self.server.paths)
                task = asyncio.create_task(consume())
                for _ in range(100):
                    if len(self.server.paths) > before:
                        break
                    await asyncio.sleep(0.005)
                self.assertGreater(len(self.server.paths), before)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertFalse(transport._http._idle)
                self.assertFalse(transport._http._writers)
                self.assertEqual(await (await transport.send("GET", "/ok")).read(), b"{}")
            finally:
                await transport.close()
        asyncio.run(run())

    def test_cancel_at_completed_headers_handoff_discards_unowned_response(self):
        async def run():
            transport = AsyncTransport("fixture", self.url, 2, 0)
            original = _http.within
            async def cancel_handoff(awaitable, timeout):
                # Reproduce the 3.10 task handoff race deterministically: the
                # child produced a response, but caller cancellation wins.
                if getattr(getattr(awaitable, "cr_code", None), "co_name", None) == "start":
                    await awaitable
                    raise asyncio.CancelledError()
                return await original(awaitable, timeout)
            try:
                with patch.object(_http, "within", cancel_handoff):
                    with self.assertRaises(asyncio.CancelledError):
                        await transport.send("GET", "/ok", deadline=time.monotonic() + 1)
                self.assertFalse(transport._http._idle)
                self.assertFalse(transport._http._writers)
                self.assertEqual(await (await transport.send("GET", "/ok")).read(), b"{}")
            finally:
                await transport.close()
        asyncio.run(run())

    def test_sync_early_close_joins_retained_line_reader_before_pool_reuse(self):
        transport = SyncTransport("fixture", self.url, 2, 0)
        retained = []
        responses = []
        original = _http.SyncResponse.lines
        def retain(response, *args, **kwargs):
            reader = original(response, *args, **kwargs)
            retained.append(reader)
            responses.append(response)
            return reader
        try:
            with patch.object(_http.SyncResponse, "lines", retain):
                events = transport.events("GET", "/ok", deadline=time.monotonic() + FINISHED_DEADLINE)
                self.assertEqual(next(events), {})
                # 3.10 needs an explicit EOF read after readline consumed the
                # complete Content-Length; 3.14 recognizes it immediately.
                # Keep the line iterator alive while making pooling eligible.
                self.assertEqual(responses[0]._response.read(), b"")
                peer = self.server.peers[-1]
                events.close()
                self.assertIsNone(retained[0].gi_frame)
                self.assertEqual(transport.send("GET", "/slow").read(), b"{}")
                self.assertEqual(self.server.peers[-1], peer)
        finally:
            for reader in retained:
                reader.close()
            transport.close()

    def test_async_early_close_closes_retained_line_reader_before_pool_reuse(self):
        async def run():
            transport = AsyncTransport("fixture", self.url, 2, 0)
            retained = []
            original = _http.AsyncResponse.lines
            def retain(response, *args, **kwargs):
                reader = original(response, *args, **kwargs)
                retained.append(reader)
                return reader
            try:
                with patch.object(_http.AsyncResponse, "lines", retain):
                    events = transport.events("GET", "/ok", deadline=time.monotonic() + FINISHED_DEADLINE)
                    self.assertEqual(await events.__anext__(), {})
                    peer = self.server.peers[-1]
                    await events.aclose()
                    self.assertIsNone(retained[0].ag_frame)
                    self.assertEqual(await (await transport.send("GET", "/slow")).read(), b"{}")
                    self.assertEqual(self.server.peers[-1], peer)
            finally:
                for reader in retained:
                    await reader.aclose()
                await transport.close()
        asyncio.run(run())

    def test_sync_early_close_releases_detached_response_file_immediately(self):
        transport = SyncTransport("fixture", self.url, 2, 0)
        try:
            response = transport.send("GET", "/events/")
            self.assertIsNone(response._connection.sock)
            self.assertIsNotNone(response._response.fp)
            reader = response.lines(deadline=time.monotonic() + 1)
            self.assertEqual(json.loads(next(reader))["type"], "stdout")
            reader.close()
            self.assertIsNone(response._response.fp)
            self.assertEqual(response._socket.fileno(), -1)
            self.assertEqual(transport._http._idle.qsize(), 0)
            self.assertEqual(transport.send("GET", "/ok").read(), b"{}")
        finally:
            transport.close()
