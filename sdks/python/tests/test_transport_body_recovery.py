"""Real loopback HTTP faults after headers must preserve retry safety."""
import asyncio
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

from withruntime import AsyncRuntime, ConnectionError, Runtime, RuntimeError
from withruntime._request_scope import request_scope
from withruntime._http import SyncResponse


class World:
    def __init__(self, fault, failures=1):
        self.fault, self.failures, self.keys = fault, failures, []
        world = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("content-length", "0")))
                world.keys.append(self.headers.get("idempotency-key"))
                failed = len(world.keys) <= world.failures
                body = b'{"ok":true}'
                if world.fault == "stale" and self.command == "POST":
                    self.close_connection = True
                    return
                self.send_response(503 if failed and world.fault == "error" else 200)
                if world.fault != "stale":
                    self.send_header("connection", "close")
                if failed and world.fault == "late":
                    self.send_header("runtime-late-answer", "true")
                if world.fault in ("chunk", "delimiter"):
                    self.send_header("transfer-encoding", "chunked")
                else:
                    self.send_header("content-length", str(len(body)))
                self.end_headers()
                if failed and world.fault == "stall":
                    # The response owns this socket until the caller cancels it.
                    world.unstall.wait(2)
                    return
                if world.fault == "chunk":
                    self.wfile.write(b"%x\r\n" % len(body) + body + b"\r\n" + (b"" if failed else b"0\r\n\r\n"))
                elif world.fault == "delimiter":
                    self.wfile.write(b"%x\r\n" % len(body) + body + (b"XX" if failed else b"\r\n") + b"0\r\n\r\n")
                else:
                    self.wfile.write(body[:4] if failed and world.fault != "stale" else body)

            do_GET = do_POST

        self.unstall = threading.Event()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.unstall.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class BodyRecovery(unittest.TestCase):
    def test_partial_sync_response_is_discarded_before_pool_reuse(self):
        for streaming in (False, True):
            pool, connection, answer = Mock(), Mock(), Mock()
            answer.status, answer.length, answer.will_close = 200, 4, False
            answer.getheaders.return_value = []
            answer.isclosed.return_value = True
            answer.read.return_value = b'{"ok'
            answer.read1.side_effect = [b'{"ok', b'']
            response = SyncResponse(pool, connection, answer)
            with self.assertRaises(ConnectionResetError):
                if streaming:
                    list(response.chunks())
                else:
                    response.read()
            pool.release.assert_not_called()
            connection.close.assert_called_once()

    def call(self, world, asynchronous, operation="json", max_retries=1):
        if asynchronous:
            async def run():
                async with AsyncRuntime(api_key="rk_test", base_url=world.url, max_retries=max_retries) as rt:
                    if operation == "file_bytes":
                        return await rt._t.file_bytes("/v1/file", {})
                    return await getattr(rt._t, operation)("POST", "/v1/example", body={})
            return asyncio.run(run())
        with Runtime(api_key="rk_test", base_url=world.url, max_retries=max_retries) as rt:
            if operation == "file_bytes":
                return rt._t.file_bytes("/v1/file", {})
            return getattr(rt._t, operation)("POST", "/v1/example", body={})

    def test_short_success_error_and_late_bodies_retry_with_one_key(self):
        for asynchronous in (False, True):
            for fault in ("length", "error", "late", "chunk"):
                with self.subTest(asynchronous=asynchronous, fault=fault):
                    world = World(fault)
                    try:
                        self.assertEqual(self.call(world, asynchronous), {"ok": True})
                        self.assertEqual(len(world.keys), 2)
                        self.assertTrue(world.keys[0])
                        self.assertEqual(world.keys[0], world.keys[1])
                    finally:
                        world.close()

    def test_async_malformed_chunk_delimiter_is_not_accepted(self):
        world = World("delimiter")
        try:
            self.assertEqual(self.call(world, True), {"ok": True})
            self.assertEqual(len(world.keys), 2)
            self.assertEqual(world.keys[0], world.keys[1])
        finally:
            world.close()

    def test_retry_exhaustion_keeps_the_key_and_typed_error(self):
        for asynchronous in (False, True):
            world = World("length", failures=10)
            try:
                with self.assertRaises(ConnectionError) as caught:
                    self.call(world, asynchronous)
                self.assertEqual(len(world.keys), 2)
                self.assertEqual(caught.exception.idempotency_key, world.keys[0])
                self.assertEqual(world.keys[0], world.keys[1])
            finally:
                world.close()

    def test_whole_bytes_and_file_reads_retry_body_loss(self):
        for asynchronous in (False, True):
            for operation in ("bytes", "file_bytes"):
                world = World("length")
                try:
                    self.assertEqual(self.call(world, asynchronous, operation), b'{"ok":true}')
                    self.assertEqual(len(world.keys), 2)
                finally:
                    world.close()

    def test_scoped_body_timeout_stays_typed_without_retry(self):
        for asynchronous in (False, True):
            world = World("stall")
            try:
                with request_scope(0.1), self.assertRaises(RuntimeError) as caught:
                    self.call(world, asynchronous)
                self.assertEqual(caught.exception.code, "request_timeout")
                self.assertEqual(len(world.keys), 1)
            finally:
                world.close()

    def test_scope_expiring_during_retry_wait_keeps_typed_error_and_key(self):
        for asynchronous in (False, True):
            world = World("length", failures=10)
            try:
                with request_scope(0.05), self.assertRaises(RuntimeError) as caught:
                    self.call(world, asynchronous)
                self.assertEqual(caught.exception.code, "request_timeout")
                self.assertEqual(caught.exception.idempotency_key, world.keys[0])
                self.assertEqual(len(world.keys), 1)
            finally:
                world.close()

    def test_retry_disabled_also_prevents_a_reused_socket_replay(self):
        for asynchronous in (False, True):
            world = World("stale")
            try:
                if asynchronous:
                    async def run():
                        async with AsyncRuntime(api_key="rk_test", base_url=world.url) as rt:
                            await rt._t.json("GET", "/v1/me")
                            self.assertEqual(len(rt._t._http._idle), 1)
                            with self.assertRaises(ConnectionError):
                                await rt.support.message("hello")
                    asyncio.run(run())
                else:
                    with Runtime(api_key="rk_test", base_url=world.url) as rt:
                        rt._t.json("GET", "/v1/me")
                        self.assertEqual(rt._t._http._idle.qsize(), 1)
                        with self.assertRaises(ConnectionError):
                            rt.support.message("hello")
                self.assertEqual(len(world.keys), 2, "GET followed by one support POST")
            finally:
                world.close()

    def test_async_cancel_during_body_read_propagates_without_retry(self):
        world = World("stall")
        try:
            async def run():
                async with AsyncRuntime(api_key="rk_test", base_url=world.url) as rt:
                    task = asyncio.create_task(rt._t.json("POST", "/v1/example", body={}))
                    while not world.keys:
                        await asyncio.sleep(0.001)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    self.assertEqual(len(world.keys), 1)
                    self.assertFalse(rt._t._http._writers)
            asyncio.run(run())
        finally:
            world.close()

    def test_stream_body_loss_never_replays_after_yielding(self):
        for asynchronous in (False, True):
            world = World("length")
            try:
                if asynchronous:
                    async def run():
                        async with AsyncRuntime(api_key="rk_test", base_url=world.url) as rt:
                            chunks = rt._t.file_chunks("/v1/file", {})
                            self.assertEqual(await chunks.__anext__(), b'{"ok')
                            with self.assertRaises(OSError):
                                await chunks.__anext__()
                    asyncio.run(run())
                else:
                    with Runtime(api_key="rk_test", base_url=world.url) as rt:
                        chunks = rt._t.file_chunks("/v1/file", {})
                        self.assertEqual(next(chunks), b'{"ok')
                        with self.assertRaises(OSError):
                            next(chunks)
                self.assertEqual(len(world.keys), 1)
            finally:
                world.close()


if __name__ == "__main__":
    unittest.main()
