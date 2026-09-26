"""runtime.domains, runtime.ports, runtime.addresses and runtime.tunnel against
a stub API, sync and async. The handlers are tested on Postgres in
packages/cloud (network-products-postgres.test.ts)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime

SANDBOX = "11111111-2222-4333-8444-555555555555"


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def answer(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length)) if length else None

    def handle_any(self):
        Stub.seen.append((self.command, self.path, self.body()))
        self.answer({"data": [], "nextCursor": None, "ok": True})

    do_GET = do_POST = do_DELETE = handle_any


class NetworkProductsTest(unittest.TestCase):
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

    def test_sync_paths_and_bodies(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.domains.add("app.example.com", sandbox_id=SANDBOX, port=3000)
            runtime.domains.verify("app.example.com")
            self.assertEqual(runtime.domains.list(), [])
            runtime.domains.remove("app.example.com")
            runtime.ports.open(sandbox_id=SANDBOX, port=5432)
            runtime.ports.list(sandbox_id=SANDBOX)
            runtime.ports.close("p1")
            runtime.addresses.reserve(family=6)
            runtime.addresses.release("a1")
            runtime.tunnel.create(subnet="10.9.0.0/16")
            runtime.tunnel.add_peer("office", routes=["10.0.0.0/16"])
            runtime.tunnel.rotate_peer("peer1", public_key="k")
            runtime.tunnel.remove_peer("peer1")
        self.assertEqual([(m, p) for m, p, _ in Stub.seen], [
            ("POST", "/v1/domains"),
            ("POST", "/v1/domains/app.example.com:verify"),
            ("GET", "/v1/domains"),
            ("DELETE", "/v1/domains/app.example.com"),
            ("POST", "/v1/ports"),
            ("GET", f"/v1/ports?sandboxId={SANDBOX}"),
            ("DELETE", "/v1/ports/p1"),
            ("POST", "/v1/addresses"),
            ("DELETE", "/v1/addresses/a1"),
            ("POST", "/v1/tunnel"),
            ("POST", "/v1/tunnel/peers"),
            ("POST", "/v1/tunnel/peers/peer1:rotate"),
            ("DELETE", "/v1/tunnel/peers/peer1"),
        ])
        self.assertEqual(Stub.seen[0][2], {"hostname": "app.example.com", "sandboxId": SANDBOX, "port": 3000})
        self.assertEqual(Stub.seen[7][2], {"family": 6})
        self.assertEqual(Stub.seen[10][2], {"name": "office", "routes": ["10.0.0.0/16"]})

    def test_async_open_port(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.ports.open(sandbox_id=SANDBOX, port=22)

        self.assertTrue(asyncio.run(go())["ok"])
        self.assertEqual(Stub.seen[0][2], {"sandboxId": SANDBOX, "port": 22})


if __name__ == "__main__":
    unittest.main()
