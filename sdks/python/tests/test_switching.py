"""runtime.switching against a stub API, sync and async. The routes are tested
in packages/cloud (switching-api.test.ts)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

SUMMARY = {"enabled": True, "maxMicros": "100000000", "eligible": True, "switch": None}
COMPARISON = {"provider": "e2b", "basis": "usage", "savingMicros": "2121111", "switching": SUMMARY}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def answer(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        Stub.seen.append((self.command, self.path, None))
        self.answer(COMPARISON if self.path.startswith("/v1/usage/compare") else SUMMARY)

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        Stub.seen.append((self.command, self.path, json.loads(self.rfile.read(length))))
        self.answer(SUMMARY)


class SwitchingTest(unittest.TestCase):
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

    def test_sync(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            self.assertEqual(runtime.switching.compare("e2b")["savingMicros"], "2121111")
            runtime.switching.compare("modal", days=7)
            self.assertTrue(runtime.switching.get()["eligible"])
            runtime.switching.record("daytona")
        self.assertEqual(
            Stub.seen,
            [
                ("GET", "/v1/usage/compare?provider=e2b", None),
                ("GET", "/v1/usage/compare?provider=modal&days=7", None),
                ("GET", "/v1/switching", None),
                ("POST", "/v1/switching", {"provider": "daytona"}),
            ],
        )

    def test_async(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.switching.compare("e2b", days=14)

        self.assertEqual(asyncio.run(go())["provider"], "e2b")
        self.assertEqual(Stub.seen, [("GET", "/v1/usage/compare?provider=e2b&days=14", None)])


if __name__ == "__main__":
    unittest.main()
