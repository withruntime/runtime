"""sbx.metrics(), runtime.webhooks, runtime.otel, runtime.events and
verify_webhook against a stub API, sync and async. The routes are tested over
Postgres in packages/cloud (observability-api.test.ts)."""
import asyncio
import datetime
import json
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import withruntime.e2b as e2b
from withruntime import AsyncRuntime, Runtime, WebhookVerificationError, verify_webhook

SANDBOX_ID = "11111111-2222-4333-8444-555555555555"
HOOK_ID = "22222222-3333-4444-8555-666666666666"
METRICS = {
    "sandboxId": SANDBOX_ID, "range": "1h", "stepSeconds": 20, "vcpu": 2, "memoryLimitBytes": 4294967296,
    "diskLimitBytes": 10737418240, "state": "running",
    "latest": {"at": "2026-09-23T10:59:00.000Z", "cpuPercent": 25, "memoryBytes": 1073741824},
    "points": [
        {"at": "2026-09-23T10:58:00.000Z", "cpuPercent": None, "memoryBytes": 900000000},
        {"at": "2026-09-23T10:59:00.000Z", "cpuPercent": 25, "memoryBytes": 1073741824},
    ],
}


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
        Stub.seen.append(("GET", self.path, None))
        if self.path.startswith(f"/v1/sandboxes/{SANDBOX_ID}/metrics"):
            return self.answer(METRICS)
        if self.path.startswith(f"/v1/sandboxes/{SANDBOX_ID}"):
            return self.answer({"id": SANDBOX_ID, "state": "running"})
        return self.answer({"data": [], "nextCursor": None})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"null")
        Stub.seen.append(("POST", self.path, body))
        self.answer({"id": HOOK_ID, "secret": "whsec_" + "a" * 43, "state": "succeeded", "lastStatus": 204})


class ObservabilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen.clear()

    def test_sync_routes(self):
        runtime = Runtime(api_key="rk_x", base_url=self.url)
        sbx = runtime.sandboxes.get(SANDBOX_ID)
        self.assertEqual(sbx.metrics(range="1h")["latest"]["cpuPercent"], 25)
        self.assertEqual(Stub.seen[-1][1], f"/v1/sandboxes/{SANDBOX_ID}/metrics?range=1h")
        made = runtime.webhooks.create(url="https://example.com/h", events=["sandbox.stopped"])
        self.assertTrue(made["secret"].startswith("whsec_"))
        self.assertEqual(Stub.seen[-1][2], {"url": "https://example.com/h", "events": ["sandbox.stopped"]})
        runtime.webhooks.update(HOOK_ID, enabled=False)
        runtime.webhooks.rotate_secret(HOOK_ID, keep_previous_seconds=0)
        self.assertEqual(runtime.webhooks.test(HOOK_ID)["lastStatus"], 204)
        runtime.webhooks.deliveries(HOOK_ID, state="failed")
        runtime.webhooks.retry("33333333-4444-4555-8666-777777777777")
        runtime.webhooks.delete(HOOK_ID)
        runtime.otel.create(endpoint="https://otlp.example.com", headers={"Authorization": "Bearer t"})
        runtime.otel.flush("x")
        runtime.events.list(resource_id=SANDBOX_ID, limit=5)
        self.assertEqual([(m, p) for m, p, _ in Stub.seen[3:]], [
            ("POST", f"/v1/webhooks/{HOOK_ID}:update"),
            ("POST", f"/v1/webhooks/{HOOK_ID}:rotate-secret"),
            ("POST", f"/v1/webhooks/{HOOK_ID}:test"),
            ("GET", f"/v1/webhooks/{HOOK_ID}/deliveries?state=failed"),
            ("POST", "/v1/webhook-deliveries/33333333-4444-4555-8666-777777777777:retry"),
            ("POST", f"/v1/webhooks/{HOOK_ID}:delete"),
            ("POST", "/v1/otel-exports"),
            ("POST", "/v1/otel-exports/x:flush"),
            ("GET", f"/v1/events?resourceId={SANDBOX_ID}&limit=5"),
        ])

    def test_async_metrics(self):
        async def go():
            async with AsyncRuntime(api_key="rk_x", base_url=self.url) as runtime:
                sbx = await runtime.sandboxes.get(SANDBOX_ID)
                return await sbx.metrics()
        self.assertEqual(asyncio.run(go())["vcpu"], 2)
        self.assertEqual(Stub.seen[-1][1], f"/v1/sandboxes/{SANDBOX_ID}/metrics")

    def test_verify_webhook(self):
        # The vector packages/cloud (observability-api.test.ts) and the JavaScript SDK share.
        header = "t=1700000000,v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789"
        self.assertEqual(verify_webhook('{"a":1}', header, "whsec_test", now=1_700_000_100), {"a": 1})
        self.assertEqual(verify_webhook(b'{"a":1}', header, ["whsec_other", "whsec_test"], now=1_700_000_000),
                         {"a": 1})
        for body, head, secret, now in [
            ('{"a":1}', header, "whsec_wrong", 1_700_000_000),
            ('{"a":2}', header, "whsec_test", 1_700_000_000),
            ('{"a":1}', header, "whsec_test", 1_700_000_301),
            ('{"a":1}', None, "whsec_test", 1_700_000_000),
            ('{"a":1}', "t=x,v1=00", "whsec_test", 1_700_000_000),
        ]:
            with self.assertRaises(WebhookVerificationError):
                verify_webhook(body, head, secret, now=now)

    def test_e2b_get_metrics(self):
        fake = types.SimpleNamespace(runtime=types.SimpleNamespace(metrics=lambda range=None: METRICS))
        points = e2b.Sandbox.get_metrics(fake, start=datetime.datetime(2026, 9, 23, 10, 0, tzinfo=datetime.timezone.utc),
                                         end=datetime.datetime(2026, 9, 23, 12, 0, tzinfo=datetime.timezone.utc))
        self.assertEqual(len(points), 1)
        self.assertEqual((points[0].cpu_used_pct, points[0].cpu_count, points[0].mem_used, points[0].disk_used,
                          points[0].disk_total), (25, 2, 1073741824, None, 10737418240))


if __name__ == "__main__":
    unittest.main()
