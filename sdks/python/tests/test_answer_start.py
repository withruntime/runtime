"""A call in flight when the leading controller dies waits on a silent
connection: nothing it sends reaches the new leader (the leader drill on vin-5,
4 October 2026). An attempt whose answer has not started within
ANSWER_START_SECONDS is sent again under the same key."""
import asyncio
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from withruntime import AsyncRuntime, Runtime


class SilentFirst:
    """Answers every call but the first, which it holds without a word."""

    def __init__(self):
        self.keys, self.release = [], threading.Event()
        world = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("content-length", "0")))
                world.keys.append(self.headers.get("idempotency-key"))
                if len(world.keys) == 1:
                    world.release.wait(10)
                    self.close_connection = True
                    return
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class AnswerStart(unittest.TestCase):
    def test_an_attempt_whose_answer_never_starts_is_sent_again_under_its_key(self):
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                world = SilentFirst()
                try:
                    started = time.monotonic()
                    with mock.patch("withruntime._http.ANSWER_START_SECONDS", 0.3, create=True):
                        if asynchronous:
                            async def run():
                                async with AsyncRuntime(api_key="rk_test", base_url=world.url) as rt:
                                    return await rt._t.json("POST", "/v1/feedback", body={})
                            answer = asyncio.run(run())
                        else:
                            with Runtime(api_key="rk_test", base_url=world.url) as rt:
                                answer = rt._t.json("POST", "/v1/feedback", body={})
                    self.assertEqual(answer, {"ok": True})
                    self.assertEqual(len(world.keys), 2)
                    self.assertTrue(world.keys[0])
                    self.assertEqual(world.keys[0], world.keys[1])
                    self.assertLess(time.monotonic() - started, 5)
                finally:
                    world.close()


if __name__ == "__main__":
    unittest.main()
