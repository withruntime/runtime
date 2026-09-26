"""Bucket mounts from the Python SDK against a stub API: the paths and bodies
sbx.mounts sends. The route is tested in packages/cloud (mounts-api)."""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from withruntime import Runtime

SANDBOX = "11111111-2222-4333-8444-555555555555"


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
        if url.path.endswith("/mounts") and self.command == "POST":
            return self._reply({**body, "mounted": True})
        if url.path.endswith("/mounts"):
            return self._reply({"data": [{"path": "/data", "mounted": True}]})
        if url.path.endswith("/mounts:unmount"):
            return self._reply({"path": body["path"], "mounted": False})
        return self._reply({"id": SANDBOX, "state": "running", "status": "active"})

    do_GET = do_POST = _route


class Mounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_add_list_remove(self):
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        sbx = runtime.sandboxes.get(SANDBOX)
        made = sbx.mounts.add(provider="r2", bucket="assets", path="/assets", account_id="a" * 32,
                              secret="R2_KEYS", read_only=True)
        self.assertTrue(made["mounted"])
        self.assertEqual(Stub.seen[-1], ("POST", f"/v1/sandboxes/{SANDBOX}/mounts", {
            "provider": "r2", "bucket": "assets", "path": "/assets", "accountId": "a" * 32,
            "secret": "R2_KEYS", "readOnly": True}))
        self.assertEqual([m["path"] for m in sbx.mounts.list()], ["/data"])
        self.assertEqual(sbx.mounts.remove("/assets"), {"path": "/assets", "mounted": False})


if __name__ == "__main__":
    unittest.main()
