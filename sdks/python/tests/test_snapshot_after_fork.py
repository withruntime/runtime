"""snapshot() straight after fork() (user lane, 23 September 2026): the source
still reads "resuming" just after a fork answers, and snapshot() paused only a
"running" sandbox, so the snapshot was refused as not paused. It now waits for
where the sandbox is going first. Against a stub API."""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from withruntime import Runtime

SANDBOX = "11111111-2222-4333-8444-555555555555"


class Stub(BaseHTTPRequestHandler):
    state = "resuming"
    seen: list = []

    def log_message(self, *args):
        pass

    def _reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        wait_for = parse_qs(url.query).get("waitFor", [None])[0]
        Stub.seen.append(f"{self.command} {url.path}" + (f"?waitFor={wait_for}" if wait_for else ""))
        if wait_for:
            Stub.state = wait_for
        if url.path.endswith(":pause"):
            Stub.state = "paused"
        if url.path.endswith(":wake"):
            Stub.state = "running"
        if url.path.endswith(":snapshot"):
            if Stub.state != "paused":
                return self._reply(409, {"error": {"code": "sandbox_not_paused", "message": "not paused"}})
            return self._reply(201, {"id": "snap-1", "state": "ready"})
        return self._reply(200, {"id": SANDBOX, "state": Stub.state, "status": "active"})

    do_GET = do_POST = _route


class SnapshotAfterFork(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_resuming_is_waited_for_then_paused_snapshotted_and_woken(self):
        Stub.state, Stub.seen = "resuming", []
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        sbx = runtime.sandboxes.get(SANDBOX)
        self.assertEqual(sbx.snapshot()["id"], "snap-1")
        order = [entry for entry in Stub.seen if "waitFor" in entry or ":" in entry.split("/")[-1]]
        self.assertEqual(order, [
            f"GET /v1/sandboxes/{SANDBOX}?waitFor=running",
            f"POST /v1/sandboxes/{SANDBOX}:pause",
            f"POST /v1/sandboxes/{SANDBOX}:snapshot",
            f"POST /v1/sandboxes/{SANDBOX}:wake",
        ])

    def test_pausing_is_waited_for_and_left_paused(self):
        Stub.state, Stub.seen = "pausing", []
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        sbx = runtime.sandboxes.get(SANDBOX)
        self.assertEqual(sbx.snapshot()["id"], "snap-1")
        self.assertIn(f"GET /v1/sandboxes/{SANDBOX}?waitFor=paused", Stub.seen)
        self.assertFalse(any(entry.endswith((":pause", ":wake")) for entry in Stub.seen))


if __name__ == "__main__":
    unittest.main()
