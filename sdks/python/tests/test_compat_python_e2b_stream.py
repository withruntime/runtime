"""Consume an actual HTTP file before the peer is allowed to finish sending."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from types import SimpleNamespace
import unittest

from withruntime._sync_client import _Transport, Files
from withruntime._async_client import _Transport as AsyncTransport, AsyncFiles
from withruntime.e2b._sync_sandbox import Filesystem
from withruntime.e2b._async_sandbox import AsyncFilesystem
from withruntime.e2b import FileNotFoundException
from withruntime._errors import NotFoundError


class StreamingFile(unittest.TestCase):
    def setUp(self):
        self.release = threading.Event()
        self.sent_tail = threading.Event()
        self.closed = []
        owner = self
        class Peer(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "131072")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.wfile.write(b"a" * 65536)
                    self.wfile.flush()
                    if owner.release.wait(2):
                        self.wfile.write(b"z" * 65536)
                        self.wfile.flush()
                        owner.sent_tail.set()
                except (BrokenPipeError, ConnectionResetError):
                    pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01))
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def test_sync_first_chunk_precedes_eof_and_early_close_closes_response(self):
        owner = self
        class Transport(_Transport):
            def send(self, *args, **kwargs):
                response = super().send(*args, **kwargs)
                close = response.close
                def closed():
                    owner.closed.append(True)
                    close()
                response.close = closed
                return response
        transport = Transport("local-test", self.origin, 1, 0)
        try:
            sandbox = SimpleNamespace(runtime=SimpleNamespace(files=Files(transport, "owned")), _ensure_home=lambda _: None)
            stream = Filesystem(sandbox).read("/large", format="stream")
            first = next(stream)
            self.assertTrue(first and first == b"a" * len(first))
            self.assertFalse(self.sent_tail.is_set())
            stream.close()
            self.assertTrue(self.closed, "Early close must release the HTTP response immediately")
        finally:
            transport.close()

    def test_async_first_chunk_precedes_eof_and_early_close_closes_response(self):
        async def run():
            owner = self
            class Transport(AsyncTransport):
                async def send(self, *args, **kwargs):
                    response = await super().send(*args, **kwargs)
                    close = response.close
                    async def closed():
                        owner.closed.append(True)
                        await close()
                    response.close = closed
                    return response
            transport = Transport("local-test", self.origin, 1, 0)
            try:
                async def home(_): pass
                sandbox = SimpleNamespace(runtime=SimpleNamespace(files=AsyncFiles(transport, "owned")), _ensure_home=home)
                stream = await AsyncFilesystem(sandbox).read("/large", format="stream")
                first = await stream.__anext__()
                self.assertTrue(first and first == b"a" * len(first))
                self.assertFalse(self.sent_tail.is_set())
                await stream.aclose()
                self.assertTrue(self.closed, "Early close must release the HTTP response immediately")
            finally:
                await transport.close()
        asyncio.run(run())


class StreamingErrors(unittest.TestCase):
    def test_sync_and_async_iteration_translate_errors_and_close(self):
        closed = []
        def source():
            try:
                yield b"first"
                raise NotFoundError("missing", code="file_not_found", status=404)
            finally:
                closed.append("sync")
        from withruntime.e2b._sync_io import stream
        output = stream(source())
        self.assertEqual(next(output), b"first")
        with self.assertRaises(FileNotFoundException):
            next(output)
        async def run():
            async def source():
                try:
                    yield b"first"
                    raise NotFoundError("missing", code="file_not_found", status=404)
                finally:
                    closed.append("async")
            from withruntime.e2b._async_io import stream
            output = stream(source())
            self.assertEqual(await output.__anext__(), b"first")
            with self.assertRaises(FileNotFoundException):
                await output.__anext__()
        asyncio.run(run())
        self.assertEqual(closed, ["sync", "async"])
