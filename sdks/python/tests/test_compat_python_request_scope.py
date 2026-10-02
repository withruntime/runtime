import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
from types import SimpleNamespace
import unittest

from withruntime._errors import RuntimeError
from withruntime._request_scope import current, request_scope
from withruntime._sync_client import _Transport, Files
from withruntime._async_client import _Transport as AsyncTransport, AsyncFiles
from withruntime.e2b._sync_sandbox import Filesystem
from withruntime.e2b._async_sandbox import AsyncFilesystem
from withruntime.e2b import TimeoutException
try:
    from httpx import ReadTimeout as FileTimeout
except ImportError:
    FileTimeout = TimeoutException


class Scope(unittest.TestCase):
    def test_nested_limits_never_extend_outer_and_reset_after_failure(self):
        original = current()
        with request_scope(.5):
            outer = current()
            with self.assertRaisesRegex(ValueError, "fixture"):
                with request_scope(10):
                    self.assertEqual(current().deadline, outer.deadline)
                    raise ValueError("fixture")
            self.assertIs(current(), outer)
            with request_scope(0):
                self.assertEqual(current().deadline, outer.deadline)
        self.assertIs(current(), original)
        for invalid in (-1, float("nan"), float("inf"), True):
            with self.assertRaises(ValueError):
                with request_scope(invalid): pass

    def test_async_tasks_do_not_change_siblings_or_leak_context(self):
        async def run():
            before = current()
            entered = asyncio.Event()
            async def scoped():
                with request_scope(.2):
                    entered.set()
                    await asyncio.sleep(.02)
                    self.assertIsNot(current(), before)
            task = asyncio.create_task(scoped())
            await entered.wait()
            self.assertIs(current(), before)
            await task
            self.assertIs(current(), before)
        asyncio.run(run())


class HTTPDeadline(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.peer_closed = threading.Event()
        owner = self
        class Peer(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                owner.calls.append(self.path)
                if "/retry" in self.path:
                    self.send_response(429)
                    self.send_header("Retry-After", "10")
                    data = b'{"error":{"code":"rate_limit","message":"later"}}'
                else:
                    self.send_response(200)
                    data = b"abcdefghij"
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    if "/retry" in self.path:
                        self.wfile.write(data)
                        return
                    for value in data:
                        self.wfile.write(bytes([value]))
                        self.wfile.flush()
                        time.sleep(.025)
                except (BrokenPipeError, ConnectionResetError):
                    owner.peer_closed.set()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01))
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def test_sync_body_deadline_and_retry_delay_are_bounded(self):
        transport = _Transport("local", self.origin, 5, 3)
        sandbox = SimpleNamespace(runtime=SimpleNamespace(files=Files(transport, "owned")), _ensure_home=lambda _: None)
        try:
            started = time.monotonic()
            with self.assertRaises(FileTimeout):
                Filesystem(sandbox).read("/large", request_timeout=.06)
            self.assertLess(time.monotonic() - started, .3)
            self.assertTrue(self.peer_closed.wait(.3))
            started = time.monotonic()
            # The native transport names an expired deadline as its own typed
            # error, during a retry wait as during a read.
            with self.assertRaises(RuntimeError) as caught:
                with request_scope(.03):
                    transport.json("GET", "/retry")
            self.assertEqual(caught.exception.code, "request_timeout")
            self.assertLess(time.monotonic() - started, .2)
            self.assertEqual(sum("retry" in path for path in self.calls), 1)
            self.assertIsNone(current().deadline)
        finally:
            transport.close()

    def test_async_body_deadline_and_cancellation_close_owned_response(self):
        async def run():
            transport = AsyncTransport("local", self.origin, 5, 3)
            async def home(_): pass
            sandbox = SimpleNamespace(runtime=SimpleNamespace(files=AsyncFiles(transport, "owned")), _ensure_home=home)
            try:
                with self.assertRaises(FileTimeout):
                    await AsyncFilesystem(sandbox).read("/large", request_timeout=.06)
                task = asyncio.create_task(AsyncFilesystem(sandbox).read("/cancel", request_timeout=0))
                await asyncio.sleep(.015)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(len(transport._http._writers), 0)
                self.assertIsNone(current().deadline)
            finally:
                await transport.close()
        asyncio.run(run())

    def test_stream_total_timeout_and_unlimited_idle_are_distinct(self):
        transport = _Transport("local", self.origin, .01, 0)
        sandbox = SimpleNamespace(runtime=SimpleNamespace(files=Files(transport, "owned")), _ensure_home=lambda _: None)
        try:
            files = Filesystem(sandbox)
            self.assertEqual(b"".join(files.read("/large", format="stream", stream_idle_timeout=0)), b"abcdefghij")
            with self.assertRaises(FileTimeout):
                b"".join(files.read("/large", format="stream", request_timeout=.04, stream_idle_timeout=0))
        finally:
            transport.close()


class QueueDeadline(unittest.TestCase):
    def test_sync_waiting_for_capacity_obeys_request_deadline(self):
        from withruntime._clock import SyncSlots
        slots = SyncSlots(1)
        with slots:
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                with request_scope(.015):
                    with slots: self.fail('occupied slot acquired')
            self.assertLess(time.monotonic() - started, .15)
        with request_scope(.05):
            with slots: pass

    def test_async_timeout_and_handoff_cancellation_do_not_leak_capacity(self):
        from withruntime._clock import AsyncSlots
        async def run():
            slots = AsyncSlots(1)
            async with slots:
                with self.assertRaises((TimeoutError, asyncio.TimeoutError)):
                    with request_scope(.01):
                        async with slots: self.fail('occupied slot acquired')
            # Cancel exactly where the inner acquire completes, before the
            # enclosing wait receives its result (Python 3.10 handoff race).
            parent = asyncio.current_task()
            class Gate:
                def __init__(self): self.held = False
                async def acquire(self):
                    self.held = True
                    parent.cancel()
                def release(self): self.held = False
            gate = Gate()
            slots._gate = gate
            with self.assertRaises(asyncio.CancelledError):
                with request_scope(.1):
                    async with slots: await asyncio.sleep(0)
            self.assertFalse(gate.held)
        asyncio.run(run())
