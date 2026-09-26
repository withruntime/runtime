"""Previews, network rules and the desktop against a stub API: the paths,
methods and bodies the SDK sends. The routes themselves are tested in
packages/cloud (previews-edge, network-previews-postgres, desktop-actions)."""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from withruntime import Runtime

SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def _reply(self, value, kind="application/json"):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        if url.path == f"/v1/sandboxes/{SANDBOX}" and self.command == "GET":
            return self._reply({"id": SANDBOX, "kind": "sandbox", "state": "running", "status": "active"})
        Stub.seen.append((self.command, url.path + (f"?{url.query}" if url.query else ""), body))
        if url.path.endswith("/previews") and self.command == "GET":
            return self._reply({"data": [{"id": "p1", "port": 3000}], "nextCursor": None})
        if url.path.endswith("/desktop/screenshot"):
            return self._reply(b"\x89PNG", "image/png")
        if body and body.get("action") == "windows":
            return self._reply({"windows": [{"id": "0x1", "title": "Firefox"}]})
        return self._reply({"ok": True})

    do_GET = do_POST = do_PUT = do_DELETE = _route


class PreviewsNetworkDesktop(unittest.TestCase):
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
        self.sbx = Runtime(api_key="rk_test", base_url=self.url, max_retries=0).sandboxes.get(SANDBOX)
        Stub.seen = []

    def test_previews(self):
        base = f"/v1/sandboxes/{SANDBOX}/previews"
        self.sbx.previews.create(3000, visibility="public", ttl_seconds=600)
        self.assertEqual(self.sbx.previews.list(), [{"id": "p1", "port": 3000}])
        self.sbx.previews.get(3000, ttl_seconds=3600)
        self.sbx.previews.rotate(3000)
        self.sbx.previews.delete(3000)
        self.assertEqual(Stub.seen, [
            ("POST", base, {"port": 3000, "visibility": "public", "ttlSeconds": 600}),
            ("GET", base, None),
            ("GET", base + "/3000?ttlSeconds=3600", None),
            ("POST", base + "/3000:rotate", {}),
            ("DELETE", base + "/3000", None),
        ])

    def test_network(self):
        path = f"/v1/sandboxes/{SANDBOX}/network"
        self.sbx.network.set(internet=True, allow=["registry.npmjs.org"], connect=["db.example.com:5432"])
        self.sbx.network.off()
        self.sbx.network.get()
        self.assertEqual(Stub.seen, [
            ("PUT", path, {"internet": True, "allow": ["registry.npmjs.org"], "connect": ["db.example.com:5432"]}),
            ("PUT", path, {"internet": False}),
            ("GET", path, None),
        ])

    def test_desktop(self):
        base = f"/v1/sandboxes/{SANDBOX}/desktop"
        self.sbx.desktop.start(width=1024, height=768)
        self.sbx.desktop.right_click(10, 20)
        self.sbx.desktop.drag((1, 2), (3, 4))
        self.sbx.desktop.press("ctrl+l")
        self.assertEqual(self.sbx.desktop.windows()[0]["title"], "Firefox")
        self.assertEqual(self.sbx.desktop.screenshot(format="jpeg"), b"\x89PNG")
        self.assertEqual(Stub.seen, [
            ("POST", base + ":start", {"width": 1024, "height": 768}),
            ("POST", base + ":act", {"action": "click", "button": "right", "x": 10, "y": 20}),
            ("POST", base + ":act", {"action": "drag", "from": [1, 2], "to": [3, 4]}),
            ("POST", base + ":act", {"action": "key", "keys": "ctrl+l"}),
            ("POST", base + ":act", {"action": "windows"}),
            ("GET", base + "/screenshot?format=jpeg", None),
        ])


if __name__ == "__main__":
    unittest.main()
