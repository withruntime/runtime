"""runtime.audit.list() against a stub API, sync and async. The route and who
may read it are tested in packages/db (teams) and packages/cloud."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

PAGE = {
    "events": [
        {
            "seq": "7",
            "action": "key.created",
            "actor": {"kind": "person", "id": "p", "name": "Marc", "person": None},
            "ip": "203.0.113.7",
        }
    ],
    "next": None,
}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        Stub.seen.append((self.command, self.path))
        data = json.dumps(PAGE).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class AuditTest(unittest.TestCase):
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

    def test_sync_list_with_filters(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            page = runtime.audit.list(action="member.", limit=10)
        self.assertEqual(page["events"][0]["action"], "key.created")
        self.assertEqual(Stub.seen, [("GET", "/v1/audit?action=member.&limit=10")])

    def test_async_list(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.audit.list()

        self.assertIsNone(asyncio.run(go())["next"])
        self.assertEqual(Stub.seen, [("GET", "/v1/audit")])


if __name__ == "__main__":
    unittest.main()
