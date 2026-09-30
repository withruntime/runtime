"""A sandbox on your tailnet from the Python SDK against a stub API: the paths
and bodies sbx.tailscale sends, sync and async. The route is tested in
packages/cloud (tailscale-api)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from withruntime import AsyncRuntime, Runtime

SANDBOX = "11111111-2222-4333-8444-555555555555"
NODE = {"running": True, "mode": "kernel", "addresses": ["100.101.102.103"], "hostname": "agent-1"}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def _reply(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        Stub.seen.append((self.command, url.path, body))
        if url.path.endswith("/tailscale") and self.command == "POST":
            return self._reply(NODE)
        if url.path.endswith("/tailscale") and self.command == "GET":
            return self._reply({**NODE, "tailnet": {"hostname": "agent-1"}})
        if url.path.endswith("/tailscale"):
            return self._reply({"left": True})
        return self._reply({"id": SANDBOX, "state": "running", "status": "active"})

    do_GET = do_POST = do_DELETE = _route


class Tailscale(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_up_status_down(self):
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        sbx = runtime.sandboxes.get(SANDBOX)
        node = sbx.tailscale.up(auth_key_secret="TS_AUTHKEY", tags=["tag:agents"])
        self.assertEqual(node["addresses"], ["100.101.102.103"])
        self.assertEqual(Stub.seen[-1], ("POST", f"/v1/sandboxes/{SANDBOX}/tailscale",
                                         {"authKeySecret": "TS_AUTHKEY", "tags": ["tag:agents"]}))
        self.assertEqual(sbx.tailscale.status()["tailnet"], {"hostname": "agent-1"})
        self.assertEqual(sbx.tailscale.down(), {"left": True})
        self.assertEqual(Stub.seen[-1][0], "DELETE")

    def test_async(self):
        async def main():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                sbx = await runtime.sandboxes.get(SANDBOX)
                node = await sbx.tailscale.up(auth_key_secret="TS_AUTHKEY", hostname="agent-1")
                self.assertEqual(Stub.seen[-1][2], {"authKeySecret": "TS_AUTHKEY", "hostname": "agent-1"})
                return node
        self.assertTrue(asyncio.run(main())["running"])


if __name__ == "__main__":
    unittest.main()
