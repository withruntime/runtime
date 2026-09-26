"""Watching files, desktop recordings and MCP servers against a stub API: the watch is created with the options
given, a stream is followed across `continue` from its cursor, notices are
kept, a pause ends delivery with the cursor kept, and polling reads carry the
cursor. The routes are tested in packages/cloud (watch.test.ts)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from withruntime import AsyncRuntime, Runtime
from withruntime._async_client import AsyncSandbox
from withruntime._sync_client import Sandbox

SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"
BASE = f"/v1/sandboxes/{SANDBOX}/files/watches"


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
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        Stub.seen.append((self.command, url.path, query, body))
        if self.command == "POST" and url.path == BASE:
            return self._reply({"id": "w1", "path": body["path"], "cursor": 10, "processId": "p", "state": "running"})
        if url.path == BASE + "/w1/events" and query.get("follow") == "true":
            cursor = int(query["cursor"])
            if cursor == 10:
                lines = [{"k": "events", "events": [{"type": "create", "path": "/workspace/a", "isDir": False}],
                          "cursor": 50}, {"k": "overflow", "dropped": 3, "reason": "rate", "cursor": 60},
                         {"k": "continue", "cursor": 60}]
            else:
                lines = [{"k": "events", "events": [{"type": "remove", "path": "/workspace/a", "isDir": False}],
                          "cursor": 90}, {"k": "paused", "cursor": 90}]
            return self._reply("".join(json.dumps(line) + "\n" for line in lines).encode(), "application/x-ndjson")
        if url.path == BASE + "/w1/events":
            return self._reply({"events": [{"type": "write", "path": "/workspace/b", "isDir": False, "count": 4}],
                                "notices": [{"k": "end", "reason": "timeout"}], "nextCursor": 120, "lostBytes": 7,
                                "ended": True})
        if self.command == "DELETE" and url.path == BASE + "/w1":
            return self._reply({"stopped": True})
        if url.path == BASE:
            return self._reply({"data": [{"id": "w1"}]})
        desktop = f"/v1/sandboxes/{SANDBOX}/desktop/recordings"
        if url.path == desktop and self.command == "POST":
            return self._reply({"id": "rec-00000000aaaa", "state": "recording", "path": "/x.mp4", "bytes": 0})
        if url.path == desktop + "/rec-00000000aaaa:stop":
            return self._reply({"id": "rec-00000000aaaa", "state": "finished", "reason": "stopped", "bytes": 9})
        if url.path == desktop + "/rec-00000000aaaa/video":
            return self._reply(b"\x00\x00\x00\x18ftypmp42", "video/mp4")
        if url.path == "/v1/mcp/catalog":
            return self._reply({"data": [{"id": "github", "license": "MIT"}]})
        if url.path == f"/v1/sandboxes/{SANDBOX}/mcp":
            Stub.polls = getattr(Stub, "polls", 0) + (1 if self.command == "GET" else 0)
            status = "installing" if self.command == "POST" or Stub.polls < 2 else "ready"
            return self._reply({"running": True, "port": 8765, "token": "t", "headers": {"Authorization": "Bearer t"},
                                "servers": [{"name": "github", "status": status, "url": "https://p/mcp/github"}],
                                "warnings": []})
        self.send_response(404)
        self.end_headers()

    do_GET = do_POST = do_DELETE = _route


class Watch(unittest.TestCase):
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

    def test_follow_reconnects_on_continue_and_stops_at_a_pause_keeping_the_cursor(self):
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        sbx = Sandbox(runtime.sandboxes._t, {"id": SANDBOX})
        watch = sbx.files.watch("/workspace", recursive=True, exclude=["node_modules"], batch_ms=50)
        self.assertEqual(Stub.seen[0][3], {"path": "/workspace", "recursive": True, "exclude": ["node_modules"],
                                           "batchMs": 50})
        events = list(watch.events())
        self.assertEqual([e["type"] for e in events], ["create", "remove"])
        self.assertEqual((watch.exit_reason, watch.cursor), ("paused", 90))
        self.assertEqual(watch.notices, [{"k": "overflow", "dropped": 3, "reason": "rate", "cursor": 60}])
        self.assertEqual([s[2]["cursor"] for s in Stub.seen if s[1].endswith("/events")], ["10", "60"])

    def test_polling_reads_from_the_cursor_and_reports_losses_and_the_end(self):
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        watch = Sandbox(runtime.sandboxes._t, {"id": SANDBOX}).files.watch("/workspace")
        events = watch.get_new_events(wait_ms=99_999)
        self.assertEqual(events[0]["count"], 4)
        self.assertEqual(Stub.seen[-1][2], {"cursor": "10", "waitMs": "8000"})
        self.assertEqual((watch.cursor, watch.exit_reason), (120, "timeout"))
        self.assertEqual(watch.notices, [{"k": "lost", "bytes": 7}])
        self.assertTrue(watch.stop())

    def test_recordings_and_mcp(self):
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        sbx = Sandbox(runtime.sandboxes._t, {"id": SANDBOX})
        started = sbx.desktop.recordings.start(fps=5, max_mib=64)
        self.assertEqual(Stub.seen[-1][3], {"fps": 5, "maxMiB": 64})
        self.assertEqual(sbx.desktop.recordings.stop(started["id"])["reason"], "stopped")
        self.assertTrue(sbx.desktop.recordings.download(started["id"]).startswith(b"\x00\x00\x00\x18ftyp"))
        self.assertEqual(runtime.mcp.catalog()[0]["id"], "github")
        Stub.polls = 0
        gw = sbx.mcp.start([{"id": "github", "secrets": {"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN"}}])
        self.assertEqual(Stub.seen[-1][3], {"servers": [{"id": "github", "secrets": {
            "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN"}}]})
        self.assertEqual(gw["servers"][0]["status"], "installing")
        self.assertEqual(sbx.mcp.ready(interval=0)["servers"][0]["status"], "ready")

    def test_async_twin(self):
        async def main():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                sbx = AsyncSandbox(runtime.sandboxes._t, {"id": SANDBOX})
                watch = await sbx.files.watch("/workspace")
                seen = [event async for event in watch.events()]
                self.assertEqual(len(seen), 2)
                self.assertEqual((await sbx.files.watches.list())[0]["id"], "w1")
        asyncio.run(main())


if __name__ == "__main__":
    unittest.main()
