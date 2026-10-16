"""runtime.networks.signed_requests against a stub API, sync and async. The routes are tested on Postgres in
packages/cloud (signed-requests-api-postgres.test.ts)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    enabled = False

    def log_message(self, *args):
        pass

    def answer(self):
        data = json.dumps({"enabled": Stub.enabled, "allowed": True, "why": None,
                           "enabledAt": None, "disabledAt": None}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
        Stub.seen.append(("PUT", self.path, body))
        Stub.enabled = body["enabled"]
        self.answer()

    def do_GET(self):
        Stub.seen.append(("GET", self.path, None))
        self.answer()


class SignedRequestsTest(unittest.TestCase):
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
        Stub.enabled = False

    def test_sync_on_then_read(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            self.assertTrue(runtime.networks.signed_requests.set(enabled=True)["enabled"])
            self.assertTrue(runtime.networks.signed_requests.get()["allowed"])
        self.assertEqual(Stub.seen, [("PUT", "/v1/networks/signed-requests", {"enabled": True}),
                                     ("GET", "/v1/networks/signed-requests", None)])

    def test_async_off(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.networks.signed_requests.set(enabled=False)

        self.assertFalse(asyncio.run(go())["enabled"])
        self.assertEqual(Stub.seen, [("PUT", "/v1/networks/signed-requests", {"enabled": False})])


if __name__ == "__main__":
    unittest.main()
