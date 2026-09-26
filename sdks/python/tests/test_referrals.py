"""runtime.referrals.get() against a stub API, sync and async. The route is
tested in packages/cloud (referrals-api)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

SUMMARY = {"code": "k7m2q9xd", "link": "https://withruntime.com/r/k7m2q9xd", "signedUp": 2, "paid": 1}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        Stub.seen.append((self.command, self.path))
        data = json.dumps(SUMMARY).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ReferralsTest(unittest.TestCase):
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
            self.assertEqual(runtime.referrals.get()["link"], SUMMARY["link"])
        self.assertEqual(Stub.seen, [("GET", "/v1/referrals")])

    def test_async_get(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.referrals.get()

        self.assertEqual(asyncio.run(go())["code"], "k7m2q9xd")


if __name__ == "__main__":
    unittest.main()
