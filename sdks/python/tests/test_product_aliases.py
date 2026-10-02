"""Canonical and historical product names through the same local HTTP client."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from withruntime import AsyncRuntime, Runtime


PAIRS = (("sandbox", "sandboxes"), ("snapshot", "snapshots"), ("image", "images"),
         ("volume", "volumes"), ("job", "jobs"), ("domain", "domains"),
         ("port", "ports"), ("address", "addresses"))
PATHS = [f"/v1/{path}" for path in ("sandboxes/fixture", "snapshots/fixture", "images/fixture",
         "volumes/fixture", "jobs/fixture", "domains/app.example.test", "ports", "addresses")
         for _ in range(2)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.server.seen.append((self.path, self.headers.get("Authorization")))
        body = json.dumps({"id": "fixture", "state": "running", "data": [], "nextCursor": None}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ProductAliases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
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

    def check_identity(self, runtime):
        for singular, plural in PAIRS:
            self.assertIs(getattr(runtime, singular), getattr(runtime, plural))
            self.assertIs(getattr(runtime, singular)._t, runtime._t)
        for command in ("billing", "account", "secrets", "webhooks", "events", "referrals"):
            self.assertIsNotNone(getattr(runtime, command))
        self.assertFalse(hasattr(runtime, "secret"))
        self.assertFalse(hasattr(runtime, "event"))
        self.assertEqual(self.server.seen, [])

    def calls(self, runtime):
        for singular, plural in PAIRS:
            for name in (singular, plural):
                product = getattr(runtime, name)
                if singular in ("port", "address"):
                    yield product.list()
                else:
                    yield product.get("app.example.test" if singular == "domain" else "fixture")

    def check_requests(self):
        self.assertEqual(self.server.seen, [(path, "Bearer rk_product_alias_test") for path in PATHS])

    def test_sync_identity_transport_and_historical_calls(self):
        with Runtime(api_key="rk_product_alias_test", base_url=self.url, max_retries=0) as runtime:
            self.check_identity(runtime)
            list(self.calls(runtime))
            self.check_requests()

    def test_async_identity_transport_and_historical_calls(self):
        async def run():
            async with AsyncRuntime(api_key="rk_product_alias_test", base_url=self.url, max_retries=0) as runtime:
                self.check_identity(runtime)
                for call in self.calls(runtime):
                    await call
                self.check_requests()
        asyncio.run(run())
