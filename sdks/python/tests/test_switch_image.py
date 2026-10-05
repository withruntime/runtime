"""Switching a sandbox's image, and deleting one, from the Python SDK against
a stub API: the paths and bodies they send, sync and async. The routes are
tested in packages/cloud (sandbox-switch-image-postgres, sandbox-env-delete-
postgres)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from withruntime import AsyncRuntime, Runtime

SANDBOX = "11111111-2222-4333-8444-555555555555"


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def _route(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        Stub.seen.append((self.command, url.path, body, self.headers.get("prefer")))
        state = "deleted" if self.command == "DELETE" else "running"
        data = json.dumps({"id": SANDBOX, "state": "running", "status": state}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_DELETE = _route


class SwitchImage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def expect_switch(self, seen):
        method, path, body, prefer = seen[-1]
        self.assertEqual((method, path), ("POST", f"/v1/sandboxes/{SANDBOX}:switch-image"))
        self.assertEqual(body, {"image": "app:v2", "keep": "workspace"})
        self.assertEqual(prefer, "wait=120")

    def test_sync(self):
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        sbx = runtime.sandboxes.get(SANDBOX)
        self.assertIs(sbx.switch_image("app:v2", keep="workspace"), sbx)
        self.expect_switch(Stub.seen)
        # keep is optional and still sent, so an API from before it was
        # optional accepts the call too.
        sbx.switch_image("app:v2")
        self.expect_switch(Stub.seen)

    def test_async(self):
        async def main():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                sbx = await runtime.sandboxes.get(SANDBOX)
                await sbx.switch_image("app:v2", keep="workspace")
                self.expect_switch(Stub.seen)
                await sbx.switch_image("app:v2")
                self.expect_switch(Stub.seen)
                await sbx.resize(vcpu=2)
                method, path, body, _ = Stub.seen[-1]
                self.assertEqual((method, path, body),
                                 ("POST", f"/v1/sandboxes/{SANDBOX}:resize", {"restart": True, "vcpu": 2}))
        asyncio.run(main())


if __name__ == "__main__":
    unittest.main()
