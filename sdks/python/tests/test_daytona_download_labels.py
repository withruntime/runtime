"""Daytona deadlines and label replacement through native HTTP, sync and async."""
import asyncio
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime
from withruntime._async_client import AsyncSandbox as NativeAsyncSandbox
from withruntime._sync_client import Sandbox as NativeSandbox
from withruntime.daytona import AsyncSandbox, Sandbox, FileDownloadRequest


class World:
    def __init__(self):
        self.delay = 0.0
        self.requests = []
        self.info = {"id": "sandbox", "state": "running", "expiresAt": "2030-01-01T00:00:00Z",
                     "timeoutSeconds": 900, "labels": {"old": "remove", "code-toolbox-language": "typescript",
                                                          "compat.provider": "daytona"}}
        world = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_GET(self):
                world.requests.append(self.path)
                if "/files/stat" in self.path:
                    data = json.dumps({"exists": True, "type": "file", "path": "/workspace/data", "size": 2}).encode()
                else:
                    data = b"\x00\xff"
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.send_header("connection", "close")
                self.end_headers()
                if "/files/stat" not in self.path:
                    time.sleep(world.delay)
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
                world.requests.append(body)
                world.info["labels"] = body["labels"]
                data = json.dumps(world.info).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.send_header("connection", "close")
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class DaytonaDownloadLabels(unittest.TestCase):
    def setUp(self):
        self.world = World()

    def tearDown(self):
        self.world.close()

    def sync_client(self):
        client = Runtime(api_key="rtcloud_fixture", base_url=self.world.url, max_retries=0)
        return client, Sandbox(NativeSandbox(client._t, dict(self.world.info)), client)

    def test_sync_seconds_overload_deadline_and_recovery(self):
        client, sandbox = self.sync_client()
        try:
            self.world.delay = 0.1
            with self.assertRaises(Exception):
                sandbox.fs.download_file("data", 0.01)
            self.world.delay = 0
            self.assertEqual(sandbox.fs.download_file("data", timeout=1), b"\x00\xff")
        finally:
            client.close()

    def test_sync_local_deadline_preserves_destination_and_cleans_partial(self):
        client, sandbox = self.sync_client()
        self.world.delay = 0.1
        try:
            with tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "data"
                target.write_bytes(b"original")
                with self.assertRaises(Exception):
                    sandbox.fs.download_file("data", str(target), 0.01)
                self.assertEqual(target.read_bytes(), b"original")
                self.assertEqual([path.name for path in Path(directory).iterdir()], ["data"])
        finally:
            client.close()

    def test_sync_labels_replace_and_persist_reserved_values(self):
        client, sandbox = self.sync_client()
        try:
            expected = {"team": "new", "code-toolbox-language": "typescript", "compat.provider": "daytona"}
            self.assertEqual(sandbox.set_labels({"team": "new", "code-toolbox-language": "python",
                                                  "compat.provider": "foreign"}), expected)
            self.assertEqual(self.world.info["labels"], expected)
            reconnect = Sandbox(NativeSandbox(client._t, dict(self.world.info)), client)
            self.assertEqual(reconnect._language, "typescript")
            self.assertEqual(reconnect.labels, expected)
        finally:
            client.close()

    def test_async_deadlines_local_cleanup_and_labels(self):
        async def run():
            async with AsyncRuntime(api_key="rtcloud_fixture", base_url=self.world.url, max_retries=0) as client:
                sandbox = AsyncSandbox(NativeAsyncSandbox(client._t, dict(self.world.info)), client)
                self.world.delay = 0.1
                with self.assertRaises(Exception):
                    await sandbox.fs.download_file("data", 0.01)
                with tempfile.TemporaryDirectory() as directory:
                    target = Path(directory) / "data"
                    target.write_bytes(b"original")
                    with self.assertRaises(Exception):
                        await sandbox.fs.download_file("data", str(target), timeout=0.01)
                    self.assertEqual(target.read_bytes(), b"original")
                    self.assertEqual([path.name for path in Path(directory).iterdir()], ["data"])
                self.world.delay = 0
                self.assertEqual(await sandbox.fs.download_file("data", timeout=0), b"\x00\xff")
                expected = {"team": "new", "code-toolbox-language": "typescript", "compat.provider": "daytona"}
                self.assertEqual(await sandbox.set_labels({"team": "new"}), expected)
                self.assertEqual(sandbox.labels, expected)
        asyncio.run(run())

    def test_batch_deadline_stops_before_the_next_file(self):
        client, sandbox = self.sync_client()
        self.world.delay = 0.1
        try:
            with self.assertRaises(Exception):
                sandbox.fs.download_files([FileDownloadRequest(source="one"), FileDownloadRequest(source="two")], timeout=0.01)
            self.assertEqual(len(self.world.requests), 1)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
