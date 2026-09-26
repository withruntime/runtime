"""Sandboxes by name, settings after create and keeping a sandbox alive, sync
and async, against a stub API that records each call. The routes themselves are
tested in packages/cloud (wake-on-request-postgres.test.ts)."""
import asyncio
import json
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

ID = "11111111-2222-4333-8444-555555555555"


def info(**extra):
    expires = datetime.now(timezone.utc) + timedelta(seconds=Stub.expires_in)
    return {"id": ID, "kind": "sandbox", "name": "dev", "state": Stub.state, "status": "active",
            "expiresAt": expires.isoformat().replace("+00:00", "Z"), "autoWake": True, "persistent": False,
            **extra}


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    state = "running"
    expires_in = 60

    def log_message(self, *args):
        pass

    def _answer(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        Stub.seen.append(("GET", self.path, None))
        self._answer(info())

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        Stub.seen.append(("POST", self.path, body))
        if self.path.endswith(":update"):
            self._answer(info(**body))
        elif self.path == "/v1/sandboxes":
            self._answer(info(**({"reused": True} if body.get("getOrCreate") else {})))
        else:
            self._answer(info())


class LifecycleSettingsTest(unittest.TestCase):
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
        Stub.state = "running"
        Stub.expires_in = 60

    def posts(self, suffix):
        return [body for method, path, body in Stub.seen if method == "POST" and path.endswith(suffix)]

    def test_get_or_create_sends_the_name(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            sbx = runtime.sandboxes.get_or_create("dev", vcpu=2, idle_pause_seconds=600, auto_wake=False)
        self.assertEqual(self.posts("/v1/sandboxes")[0],
                         {"name": "dev", "getOrCreate": True, "vcpu": 2, "idlePauseSeconds": 600, "autoWake": False})
        self.assertTrue(sbx.info["reused"])

    def test_create_from_a_snapshot_sends_the_field_the_api_takes(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.sandboxes.create(snapshot_id="snap-1", wait=False)
        self.assertEqual(self.posts("/v1/sandboxes")[0], {"snapshot": "snap-1"})

    def test_update_sends_only_what_changes(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            sbx = runtime.sandboxes.get(ID)
            sbx.update(auto_wake=False, persistent=True, max_total_cost_micros=None)
        self.assertEqual(self.posts(":update"), [{"autoWake": False, "persistent": True, "maxTotalCostMicros": None}])
        self.assertFalse(sbx.info["autoWake"])

    def test_keep_alive_extends_to_its_margin_and_stops(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            sbx = runtime.sandboxes.get(ID)
            stop = sbx.keep_alive(every_seconds=3600, margin_seconds=600)
            for _ in range(100):
                if self.posts(":extend"):
                    break
                time.sleep(0.01)
            stop()
        seconds = self.posts(":extend")[0]["seconds"]
        self.assertTrue(535 <= seconds <= 541, seconds)

    def test_async_keep_alive_ends_on_stop(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                sbx = await runtime.sandboxes.get(ID)
                sbx.keep_alive(every_seconds=3600)
                for _ in range(100):
                    if self.posts(":extend"):
                        break
                    await asyncio.sleep(0.01)
                await sbx.stop(wait=False)
                self.assertIsNone(sbx._keep_alive)

        asyncio.run(go())
        self.assertEqual(len(self.posts(":extend")), 1)

    def test_a_stopped_sandbox_ends_keep_alive_without_extending(self):
        Stub.state = "stopped"
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            sbx = runtime.sandboxes.get(ID)
            sbx.keep_alive(every_seconds=3600)
            for _ in range(100):
                if sbx._keep_alive is None:
                    break
                time.sleep(0.01)
            self.assertIsNone(sbx._keep_alive)
        self.assertEqual(self.posts(":extend"), [])


if __name__ == "__main__":
    unittest.main()
