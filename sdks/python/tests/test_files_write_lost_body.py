"""A file write whose answer loses its body is sent again under the same key.

The write's reply was read after the transport's retry, so a connection that
dropped between the answer's headers and its body surfaced as a raw error
while the write may already have happened (10 October 2026)."""
import asyncio
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime
from withruntime._async_client import AsyncFiles
from withruntime._sync_client import Files


class CutFirstAnswer:
    """Answers the first PUT with headers and a short body, then hangs up."""

    def __init__(self):
        self.keys = []
        world = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            # A header and its body, written apart, each go at once: with Nagle a
            # kept-alive answer waited 40 ms on the client's delayed ACK.
            disable_nagle_algorithm = True

            def log_message(self, *_):
                pass

            def do_PUT(self):
                self.rfile.read(int(self.headers.get("content-length", "0")))
                world.keys.append(self.headers.get("idempotency-key"))
                body = b'{"path":"/workspace/a","size":3}'
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                if len(world.keys) == 1:
                    self.wfile.write(body[:5])
                    self.wfile.flush()
                    self.close_connection = True
                    return
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class WriteLostBody(unittest.TestCase):
    def check(self, world):
        self.assertEqual(len(world.keys), 2)
        self.assertTrue(world.keys[0])
        self.assertEqual(world.keys[0], world.keys[1])

    def test_sync_write_retries_a_lost_body_under_its_key(self):
        world = CutFirstAnswer()
        try:
            with Runtime(api_key="rk_test", base_url=world.url) as rt:
                result = Files(rt._t, "sandbox").write("/workspace/a", b"abc")
            self.assertEqual(result, {"path": "/workspace/a", "size": 3})
            self.check(world)
        finally:
            world.close()

    def test_async_write_retries_a_lost_body_under_its_key(self):
        world = CutFirstAnswer()
        try:
            async def run():
                async with AsyncRuntime(api_key="rk_test", base_url=world.url) as rt:
                    return await AsyncFiles(rt._t, "sandbox").write("/workspace/a", b"abc")
            self.assertEqual(asyncio.run(run()), {"path": "/workspace/a", "size": 3})
            self.check(world)
        finally:
            world.close()


if __name__ == "__main__":
    unittest.main()
