"""CLOUD.md section 4: one plural word per product. An old word answers the
product it became for 30 days, with a FutureWarning, then raises name_retired."""
import asyncio
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest
import warnings

from withruntime import AsyncRuntime, Runtime, RuntimeError
from withruntime._renamed import renamed


PAIRS = (("sandbox", "sandboxes"), ("snapshot", "snapshots"), ("image", "images"),
         ("volume", "volumes"), ("job", "jobs"), ("domain", "domains"),
         ("port", "ports"), ("address", "ips"), ("addresses", "ips"))
PATHS = [f"/v1/{path}" for path in ("sandboxes/fixture", "snapshots/fixture", "images/fixture",
         "volumes/fixture", "jobs/fixture", "domains/app.example.test", "ports", "ips", "ips")
         for _ in range(2)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True

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
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
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
        with warnings.catch_warnings(record=True) as said:
            warnings.simplefilter("always")
            for singular, plural in PAIRS:
                self.assertIs(getattr(runtime, singular), getattr(runtime, plural))
                self.assertIs(getattr(runtime, singular)._t, runtime._t)
            self.assertIs(runtime.network, runtime.networks)
            self.assertIs(runtime.tunnel, runtime.networks.wireguard)
        self.assertIn("runtime.sandbox is now runtime.sandboxes.", [str(w.message) for w in said])
        self.assertIn("runtime.tunnel is now runtime.networks.wireguard.", [str(w.message) for w in said])
        self.assertTrue(all(w.category is FutureWarning for w in said))
        for command in ("billing", "account", "secrets", "webhooks", "events", "referrals", "plans"):
            self.assertIsNotNone(getattr(runtime, command))
        self.assertFalse(hasattr(runtime, "secret"))
        self.assertFalse(hasattr(runtime, "event"))
        self.assertEqual(self.server.seen, [])

    def calls(self, runtime):
        for singular, plural in PAIRS:
            for name in (singular, plural):
                product = getattr(runtime, name)
                if singular in ("port", "address", "addresses"):
                    yield product.list()
                else:
                    yield product.get("app.example.test" if singular == "domain" else "fixture")

    def check_requests(self):
        self.assertEqual(self.server.seen, [(path, "Bearer rk_product_alias_test") for path in PATHS])

    def test_sync_identity_transport_and_historical_calls(self):
        with Runtime(api_key="rk_product_alias_test", base_url=self.url, max_retries=0) as runtime:
            self.check_identity(runtime)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                list(self.calls(runtime))
            self.check_requests()

    def test_from_its_date_an_old_word_raises_name_retired(self):
        with Runtime(api_key="rk_product_alias_test", base_url=self.url, max_retries=0) as runtime:
            before = lambda: datetime(2026, 10, 13, 23, 59, 59, tzinfo=timezone.utc)
            with warnings.catch_warnings(record=True) as said:
                warnings.simplefilter("always")
                self.assertIs(renamed(runtime, "addresses", retires="2026-10-14", now=before), runtime.ips)
            self.assertEqual(str(said[0].message),
                             "runtime.addresses is now runtime.ips. It stops working on 2026-10-14.")
            at = lambda: datetime(2026, 10, 14, tzinfo=timezone.utc)
            with self.assertRaises(RuntimeError) as raised:
                renamed(runtime, "addresses", retires="2026-10-14", now=at)
            self.assertEqual((raised.exception.code, raised.exception.status, raised.exception.hint),
                             ("name_retired", 410, "Use runtime.ips."))
            self.assertFalse(hasattr(runtime, "teapot"))

    def test_async_identity_transport_and_historical_calls(self):
        async def run():
            async with AsyncRuntime(api_key="rk_product_alias_test", base_url=self.url, max_retries=0) as runtime:
                self.check_identity(runtime)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    for call in self.calls(runtime):
                        await call
                self.check_requests()
        asyncio.run(run())
