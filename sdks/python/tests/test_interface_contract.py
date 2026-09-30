"""Where the SDK disagrees with what the API answers, against a stub API.
Found in the interface sweep of 30 September 2026; the JavaScript twin is
packages/cloud-sdk/tests/interface-contract.test.ts.

The API answers a product switched off on this deployment with a fixed 503
(``serverFault`` "off" in packages/cloud/src/api/respond.ts). Retrying cannot
change it, and the SDK knew three of those codes: the rest were retried with
backoff and reported retryable."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime
from withruntime._errors import RuntimeError as RuntimeErr

OFF_CODES = ["unavailable", "unsupported", "fork_unavailable", "previews_unavailable", "network_unavailable",
             "network_rules_unavailable", "secrets_unavailable", "identity_unavailable", "env_unavailable"]


class Stub(BaseHTTPRequestHandler):
    code = "unavailable"
    seen: list = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        Stub.seen.append(self.path)
        data = json.dumps({"error": {"code": Stub.code, "status": 503, "message": "off", "requestId": "r",
                                     "hint": "h"}}).encode()
        self.send_response(503)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class OffCodesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_not_retryable(self):
        for code in OFF_CODES:
            with self.subTest(code=code):
                self.assertFalse(RuntimeErr("off", code=code, status=503).retryable)

    def test_sync_fails_at_once(self):
        for code in OFF_CODES:
            with self.subTest(code=code):
                Stub.code, Stub.seen = code, []
                with Runtime(api_key="rk_test", base_url=self.url, max_retries=2) as runtime:
                    with self.assertRaises(RuntimeErr) as raised:
                        runtime.limits.get()
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(len(Stub.seen), 1)

    def test_async_fails_at_once(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=2) as runtime:
                await runtime.limits.get()

        for code in OFF_CODES:
            with self.subTest(code=code):
                Stub.code, Stub.seen = code, []
                with self.assertRaises(RuntimeErr) as raised:
                    asyncio.run(go())
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(len(Stub.seen), 1)


if __name__ == "__main__":
    unittest.main()
