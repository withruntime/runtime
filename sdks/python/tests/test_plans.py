"""runtime.plans against a stub API, sync and async. The routes are tested in
packages/cloud (plans-api)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

NOW = {
    "planId": "pro", "name": "Pro", "status": "active", "interval": "month",
    "periodStart": "2026-10-01T00:00:00.000Z", "periodEnd": "2026-11-01T00:00:00.000Z", "trialEndsAt": None,
    "cancelAtPeriodEnd": False, "nextPlanId": None, "startedAt": "2026-10-01T00:00:00.000Z",
    "addOns": [{"id": "extra-seats", "quantity": 1, "endsAt": None}], "autoUpgrade": False,
    "planUsage": {"grantedMicros": "110000000", "leftMicros": "80000000", "expiresAt": "2026-11-01T00:00:00.000Z"},
}
PLAN = {
    "id": "pro", "name": "Pro", "card": "pro", "feeMicros": "100000000", "yearlyFeeMicros": "1000000000",
    "bonusMicros": "10000000", "trialDays": 14, "firstPeriodDouble": True, "support": "agent",
    "collection": "card", "contract": False, "position": 1,
    "included": [{"product": "apps", "meter": "egress", "quantity": 100, "unit": "GB"}],
    "limits": [{"limit": "sandbox.count", "max": 50}], "features": ["sso"],
    "addOns": [{"id": "extra-seats", "name": "Extra seats", "feeMicros": "20000000",
                "limits": [{"limit": "member.count", "add": 10}], "feature": None}],
}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        Stub.seen.append((self.command, self.path, None, None))
        self.reply({"current": NOW, "plans": [PLAN]})

    def change(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        Stub.seen.append((self.command, self.path, json.loads(raw) if raw else None,
                          self.headers.get("idempotency-key")))
        if self.path == "/v1/plans/choose":
            self.reply({"checkoutUrl": "https://checkout.example.test/c/1", "current": None})
        else:
            self.reply({"checkoutUrl": None, "current": NOW})

    do_POST = change
    do_PUT = change
    do_DELETE = change


class PlansTest(unittest.TestCase):
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

    def test_sync(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            listed = runtime.plans.list()
            self.assertEqual(listed["plans"][0]["yearlyFeeMicros"], "1000000000")
            self.assertEqual(listed["plans"][0]["addOns"][0]["limits"], [{"limit": "member.count", "add": 10}])
            self.assertEqual(listed["current"]["planUsage"]["leftMicros"], "80000000")
            self.assertEqual(runtime.plans.choose("pro")["checkoutUrl"], "https://checkout.example.test/c/1")
            runtime.plans.choose("pro", interval="year", idempotency_key="k-1")
            self.assertEqual(runtime.plans.cancel()["current"]["status"], "active")
            self.assertIsNone(runtime.plans.resume()["checkoutUrl"])
            self.assertEqual(runtime.plans.add_on("extra-seats")["current"]["addOns"][0]["id"], "extra-seats")
            runtime.plans.remove_add_on("extra-seats")
            self.assertFalse(runtime.plans.auto_upgrade(True)["current"]["autoUpgrade"])
        self.assertEqual([seen[:3] for seen in Stub.seen], [
            ("GET", "/v1/plans", None),
            ("POST", "/v1/plans/choose", {"plan": "pro"}),
            ("POST", "/v1/plans/choose", {"plan": "pro", "interval": "year"}),
            ("POST", "/v1/plans/cancel", {}),
            ("POST", "/v1/plans/resume", {}),
            ("POST", "/v1/plans/add-ons", {"addOn": "extra-seats"}),
            ("DELETE", "/v1/plans/add-ons/extra-seats", None),
            ("PUT", "/v1/plans/auto-upgrade", {"on": True}),
        ])
        keys = [seen[3] for seen in Stub.seen[1:]]
        self.assertEqual(keys[1], "k-1")
        self.assertTrue(all(keys), keys)

    def test_async(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                listed = await runtime.plans.list()
                chosen = await runtime.plans.choose("team", interval="year")
                await runtime.plans.auto_upgrade(False)
                return listed, chosen

        listed, chosen = asyncio.run(go())
        self.assertEqual(listed["current"]["name"], "Pro")
        self.assertIn("checkoutUrl", chosen)
        self.assertEqual([seen[:3] for seen in Stub.seen[-2:]], [
            ("POST", "/v1/plans/choose", {"plan": "team", "interval": "year"}),
            ("PUT", "/v1/plans/auto-upgrade", {"on": False}),
        ])


if __name__ == "__main__":
    unittest.main()
