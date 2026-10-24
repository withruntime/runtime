"""runtime.billing.topup(), topup_status() and auto top-up against a stub
API, sync and async. The routes are tested in packages/cloud (billing-api,
auto-top-up-api)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

TOPUP = {
    "purchaseId": "3f0c2a4e-1b7d-4c5a-9e2f-0a1b2c3d4e5f",
    "status": "open",
    "amountUsd": "20.00",
    "amount": "20.000000",
    "payBy": "2026-09-25T13:00:00.000Z",
    "networks": [{"network": "base", "address": "0xbase", "tokens": [{"currency": "usdc", "contract": "0xusdc"}]}],
}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def answer(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        Stub.seen.append((self.command, self.path, body, self.headers.get("idempotency-key")))
        data = json.dumps(TOPUP).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = answer
    do_POST = answer
    do_PUT = answer
    do_DELETE = answer


class BillingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen = []

    def test_sync_topup_and_status(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            self.assertEqual(runtime.billing.topup(20, idempotency_key="k1")["amount"], "20.000000")
            self.assertEqual(runtime.billing.topup_status(TOPUP["purchaseId"])["status"], "open")
        self.assertEqual(Stub.seen[0], ("POST", "/v1/billing/topups", {"usd": 20}, "k1"))
        self.assertEqual(Stub.seen[1][:2], ("GET", f"/v1/billing/topups/{TOPUP['purchaseId']}"))

    def test_async_topup(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.billing.topup(20)

        self.assertEqual(asyncio.run(go())["networks"][0]["address"], "0xbase")


    def test_sync_auto_top_up(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.billing.auto_top_up()
            runtime.billing.set_auto_top_up(True, 15, 20, 100, idempotency_key="k2")
            runtime.billing.auto_top_up_off()
        self.assertEqual(Stub.seen[0][:2], ("GET", "/v1/billing/auto-top-up"))
        self.assertEqual(
            Stub.seen[1],
            (
                "PUT",
                "/v1/billing/auto-top-up",
                {"enabled": True, "below": 15, "amount": 20, "monthlyLimit": 100},
                "k2",
            ),
        )
        self.assertEqual(Stub.seen[2][:2], ("DELETE", "/v1/billing/auto-top-up"))

    def test_async_auto_top_up(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.billing.set_auto_top_up(False, amount=50)

        asyncio.run(go())
        # A figure left out is not sent: the server keeps the saved one, or its default.
        self.assertEqual(Stub.seen[0][:3], ("PUT", "/v1/billing/auto-top-up", {"enabled": False, "amount": 50}))


if __name__ == "__main__":
    unittest.main()
