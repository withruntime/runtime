"""The settled-usage export through real local HTTP: the range, the cursor,
exact amounts, and what is final."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest
from urllib.parse import parse_qs, urlsplit

from withruntime import AsyncRuntime, Runtime

SINCE = "2026-09-01T00:00:00Z"
UNTIL = "2026-10-01T00:00:00Z"


class ExportHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True

    def log_message(self, *_):
        pass

    def do_GET(self):
        url = urlsplit(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        self.server.seen.append((url.path, query))
        first = "cursor" not in query
        body = {
            "since": SINCE, "until": UNTIL, "csv": "header\n" if first else "",
            "nextCursor": "page/two+=" if first else None,
            "finalThrough": "2026-09-20T10:00:00.123456Z",
            "data": [{
                "intervalId": "i", "resourceId": "r", "name": None, "kind": "sandbox", "meter": "runtime",
                "fundedBy": "credit", "startsAt": "a", "endsAt": "b", "settledAt": "c",
                "billedMilliseconds": "60000", "chargedMicros": "9007199254740993", "quotedRates": [],
                "measurementsJson": None, "evidence": "measured", "final": not first,
            }],
        }
        encoded = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class UsageExport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), ExportHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.server.seen = []

    def check(self, pages):
        self.assertEqual(self.server.seen, [
            ("/v1/usage/export", {"since": SINCE, "until": UNTIL, "limit": "500"}),
            ("/v1/usage/export", {"since": SINCE, "until": UNTIL, "limit": "500", "cursor": "page/two+="}),
        ])
        self.assertEqual("".join(page["csv"] for page in pages), "header\n")
        self.assertEqual([page["finalThrough"] for page in pages], ["2026-09-20T10:00:00.123456Z"] * 2)
        self.assertEqual([page["data"][0]["final"] for page in pages], [False, True])
        self.assertEqual(pages[0]["data"][0]["chargedMicros"], "9007199254740993")

    def test_sync_follows_every_page(self):
        with Runtime(api_key="rk_export_test", base_url=self.url, max_retries=0) as runtime:
            pages, cursor = [], None
            while True:
                pages.append(runtime.usage_export(SINCE, UNTIL, cursor=cursor, limit=500))
                cursor = pages[-1]["nextCursor"]
                if cursor is None:
                    break
        self.check(pages)

    def test_async_follows_every_page(self):
        async def walk():
            async with AsyncRuntime(api_key="rk_export_test", base_url=self.url, max_retries=0) as runtime:
                pages, cursor = [], None
                while True:
                    pages.append(await runtime.usage_export(SINCE, UNTIL, cursor=cursor, limit=500))
                    cursor = pages[-1]["nextCursor"]
                    if cursor is None:
                        return pages
        self.check(asyncio.run(walk()))


if __name__ == "__main__":
    unittest.main()
