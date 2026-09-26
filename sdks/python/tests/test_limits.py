"""runtime.limits.get() against a stub API, sync and async. The route is
tested in packages/cloud (limits-api.test.ts)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

LIMITS = {
    "access": "full",
    "daily": {"limitMicros": "25000000", "usedMicros": "3100000", "remainingMicros": "21900000", "window": "24h"},
}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        Stub.seen.append((self.command, self.path))
        data = json.dumps(LIMITS).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class LimitsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen = []

    def test_sync_get(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            self.assertEqual(runtime.limits.get()["daily"]["remainingMicros"], "21900000")
        self.assertEqual(Stub.seen, [("GET", "/v1/limits")])

    def test_async_get(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.limits.get()

        self.assertEqual(asyncio.run(go())["access"], "full")


if __name__ == "__main__":
    unittest.main()
