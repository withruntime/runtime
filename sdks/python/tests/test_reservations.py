"""runtime.reservations against a stub API, sync and async. The routes are
tested in packages/cloud (reservations.ts)."""
import asyncio
import json
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

BOOKING = {"id": "b1", "status": "confirmed", "reason": None, "sandboxes": 500, "estimateMicros": "1000000",
           "unusedRateMicros": "15000", "unusedMaxMicros": "250000", "unusedChargedMicros": "0"}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def handle_any(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        Stub.seen.append((self.command, self.path, body, self.headers.get("idempotency-key")))
        if self.command == "GET" and self.path.startswith("/v1/reservations?"):
            out = {"items": [BOOKING], "nextCursor": None}
        elif self.command == "DELETE":
            out = {**BOOKING, "status": "cancelled"}
        else:
            out = BOOKING
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_DELETE = handle_any


class ReservationsTest(unittest.TestCase):
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

    def check(self):
        create, lst, get, cancel = Stub.seen
        self.assertEqual(create[:2], ("POST", "/v1/reservations"))
        self.assertEqual(create[2], {"sandboxes": 500, "startsAt": "2026-11-01T10:00:00+00:00",
                                     "endsAt": "2026-11-01T12:00:00+00:00", "memoryMiB": 8192})
        self.assertTrue(create[3])
        self.assertEqual(lst[:2], ("GET", "/v1/reservations?limit=5&cursor=c1"))
        self.assertEqual(get[:2], ("GET", "/v1/reservations/b1"))
        self.assertEqual(cancel[:2], ("DELETE", "/v1/reservations/b1"))
        self.assertTrue(cancel[3])

    def test_sync(self):
        start = datetime(2026, 11, 1, 10, tzinfo=timezone.utc)
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            booking = runtime.reservations.create(sandboxes=500, starts_at=start, ends_at=start + timedelta(hours=2),
                                                  memory_mib=8192)
            self.assertEqual(booking["status"], "confirmed")
            self.assertEqual(runtime.reservations.list(limit=5, cursor="c1")["items"][0]["id"], "b1")
            self.assertEqual(runtime.reservations.get("b1")["id"], "b1")
            self.assertEqual(runtime.reservations.cancel("b1")["status"], "cancelled")
        self.check()

    def test_async(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                await runtime.reservations.create(sandboxes=500, starts_at="2026-11-01T10:00:00+00:00",
                                                  ends_at="2026-11-01T12:00:00+00:00", memory_mib=8192)
                await runtime.reservations.list(limit=5, cursor="c1")
                await runtime.reservations.get("b1")
                return await runtime.reservations.cancel("b1")

        self.assertEqual(asyncio.run(go())["status"], "cancelled")
        self.check()

    def test_standing_room_sync_and_async(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.reservations.keep(sandboxes=40, snapshots=["s1"], for_key=True)
            runtime.reservations.update("b1", snapshots=["s2"])

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                await runtime.reservations.keep(sandboxes=4, memory_mib=1024)
                await runtime.reservations.update("b1", sandboxes=6)

        asyncio.run(go())
        keep, update, akeep, aupdate = Stub.seen
        self.assertEqual(keep[:3], ("POST", "/v1/reservations",
                                    {"standing": True, "sandboxes": 40, "snapshots": ["s1"], "forKey": True}))
        self.assertTrue(keep[3])
        self.assertEqual(update[:3], ("POST", "/v1/reservations/b1:update", {"snapshots": ["s2"]}))
        self.assertEqual(akeep[2], {"standing": True, "sandboxes": 4, "memoryMiB": 1024})
        self.assertEqual(aupdate[:3], ("POST", "/v1/reservations/b1:update", {"sandboxes": 6}))

    def test_naive_datetime_is_local_with_zone(self):
        from withruntime._sync_products.reservations import iso_time
        out = iso_time(datetime(2026, 11, 1, 10))
        self.assertIsNotNone(datetime.fromisoformat(out).tzinfo)
        self.assertTrue(out.startswith("2026-11-01T10:00:00"))


if __name__ == "__main__":
    unittest.main()
