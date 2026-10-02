"""Account request counts and public aliases through real local HTTP."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

import withruntime
from withruntime import AsyncRuntime, InvalidRequestError, PermissionDeniedError, Runtime


class UsageHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.server.seen.append((self.path, self.headers.get("Authorization")))
        url = urlsplit(self.path)
        window = parse_qs(url.query).get("range", ["24h"])[0]
        if self.server.forbidden:
            status, body = 403, {"error": {"code": "forbidden", "message": "Not allowed."}}
        elif url.path != "/v1/usage/requests" or window not in ("24h", "7d", "30d", "90d"):
            status, body = 400, {"error": {"code": "invalid_request", "message": "Invalid range."}}
        else:
            status, body = 200, {
                "range": window, "since": "2026-09-29T00:00:00.000Z", "until": "2026-09-30T00:00:00.000Z",
                "calls": "0" if self.server.empty else "9007199254740993",
                "clientErrors": "0", "serverErrors": "0", "errorPercent": None if self.server.empty else 0,
                "operations": [] if self.server.empty else [{
                    "operation": "sandboxes.create", "calls": "9007199254740993",
                    "clientErrors": "0", "serverErrors": "0", "errorPercent": 0,
                }],
            }
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class CustomerUsage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), UsageHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.server.seen = []
        self.server.forbidden = False
        self.server.empty = False

    def check_counts(self, answer, window):
        self.assertEqual(answer["range"], window)
        self.assertEqual(answer["calls"], "9007199254740993")
        self.assertEqual(answer["operations"][0]["calls"], "9007199254740993")
        self.assertEqual(answer["errorPercent"], 0)

    def check_requests(self):
        self.assertEqual(self.server.seen, [
            (f"/v1/usage/requests?range={window}", "Bearer rk_usage_test")
            for window in ("24h", "7d", "30d", "90d")
        ])

    def test_sync_ranges_auth_exact_counts_and_errors(self):
        with Runtime(api_key="rk_usage_test", base_url=self.url, max_retries=0) as runtime:
            self.check_counts(runtime.usage_requests(), "24h")
            for window in ("7d", "30d", "90d"):
                self.check_counts(runtime.usage_requests(window), window)
            self.check_requests()
            self.server.empty = True
            answer = runtime.usage_requests()
            self.assertEqual((answer["calls"], answer["errorPercent"], answer["operations"]), ("0", None, []))
            with self.assertRaises(InvalidRequestError):
                runtime.usage_requests("invalid")
            self.server.forbidden = True
            with self.assertRaises(PermissionDeniedError):
                runtime.usage_requests()

    def test_async_ranges_auth_exact_counts_and_errors(self):
        async def run():
            async with AsyncRuntime(api_key="rk_usage_test", base_url=self.url, max_retries=0) as runtime:
                self.check_counts(await runtime.usage_requests(), "24h")
                for window in ("7d", "30d", "90d"):
                    self.check_counts(await runtime.usage_requests(window), window)
                self.check_requests()
                self.server.empty = True
                answer = await runtime.usage_requests()
                self.assertEqual((answer["calls"], answer["errorPercent"], answer["operations"]), ("0", None, []))
                with self.assertRaises(InvalidRequestError):
                    await runtime.usage_requests("invalid")
                self.server.forbidden = True
                with self.assertRaises(PermissionDeniedError):
                    await runtime.usage_requests()
        asyncio.run(run())

    def test_singular_product_alias_preserves_the_original_collection(self):
        with Runtime(api_key="rk_usage_test", base_url=self.url) as runtime:
            self.assertIs(runtime.sandbox, runtime.sandboxes)

        async def run():
            async with AsyncRuntime(api_key="rk_usage_test", base_url=self.url) as runtime:
                self.assertIs(runtime.sandbox, runtime.sandboxes)
        asyncio.run(run())

    def test_explicit_error_aliases_preserve_old_exception_identity(self):
        self.assertIs(withruntime.RuntimeAPIError, withruntime.RuntimeError)
        self.assertIs(withruntime.RuntimeConnectionError, withruntime.ConnectionError)
        self.assertTrue(issubclass(PermissionDeniedError, withruntime.RuntimeAPIError))
        self.assertTrue(issubclass(withruntime.RuntimeConnectionError, withruntime.RuntimeAPIError))
        self.assertIn("RuntimeAPIError", withruntime.__all__)
        self.assertIn("RuntimeConnectionError", withruntime.__all__)


if __name__ == "__main__":
    unittest.main()
