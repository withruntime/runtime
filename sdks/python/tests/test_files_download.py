"""A download that arrives short is never returned short (25 September 2026).

`s.files.read` of a 50 MB file returned 44 MB and raised nothing: a stream the
controller broke part way reached the client as a clean end of a chunked
body. The API now sends every body's length first (x-content-length) and a
small one's SHA-256; the SDK reads a short body again, then raises
``download_incomplete``. A real HTTP server here, so the chunked parsing in
``_http.py`` is what is tested, not a stand-in."""
import asyncio
import hashlib
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import AsyncRuntime, Runtime
from withruntime._errors import RuntimeError

ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"
WHOLE = bytes((i * 31) & 0xFF for i in range(3 * 1_048_576 + 7))


class World:
    def __init__(self, cuts, sha=None):
        self.cuts, self.sha, self.reads = list(cuts), sha, 0
        world = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                if "/files/stat" in self.path:
                    return self.json({"exists": True, "type": "file", "path": "/workspace/big.bin"})
                if "/files/content" in self.path:
                    cut = world.cuts[world.reads] if world.reads < len(world.cuts) else None
                    world.reads += 1
                    body = WHOLE if cut is None else WHOLE[:cut]
                    self.send_response(200)
                    self.send_header("content-type", "application/octet-stream")
                    self.send_header("transfer-encoding", "chunked")
                    self.send_header("x-content-length", str(len(WHOLE)))
                    if world.sha:
                        self.send_header("x-content-sha256", world.sha)
                    self.end_headers()
                    for at in range(0, len(body), 65536):
                        piece = body[at:at + 65536]
                        self.wfile.write(b"%x\r\n" % len(piece) + piece + b"\r\n")
                    # A clean end even when short: what Caddy 2.6 sends.
                    self.wfile.write(b"0\r\n\r\n")
                    return
                return self.json({"id": ID, "kind": "sandbox", "state": "running", "status": "active"})

            def json(self, value):
                data = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://localhost:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Downloads(unittest.TestCase):
    def world(self, cuts, sha=None):
        world = World(cuts, sha)
        self.addCleanup(world.close)
        return world, Runtime(api_key="rt_test", base_url=world.url, max_retries=0)

    def test_short_read_is_read_again(self):
        world, runtime = self.world([2_966_523, 1_441_474])
        self.assertEqual(runtime.sandboxes.get(ID).files.read("/workspace/big.bin"), WHOLE)
        self.assertEqual(world.reads, 3)

    def test_read_that_stays_short_raises(self):
        world, runtime = self.world([10, 20, 30, 40])
        with self.assertRaises(RuntimeError) as caught:
            runtime.sandboxes.get(ID).files.read("/workspace/big.bin")
        self.assertEqual(caught.exception.code, "download_incomplete")
        self.assertEqual(caught.exception.details, {"received": 30, "expected": len(WHOLE)})
        self.assertEqual(world.reads, 3)

    def test_digest_mismatch_raises(self):
        _, runtime = self.world([], sha="0" * 64)
        with self.assertRaises(RuntimeError):
            runtime.sandboxes.get(ID).files.read("/workspace/big.bin")
        _, runtime = self.world([], sha=hashlib.sha256(WHOLE).hexdigest())
        self.assertEqual(runtime.sandboxes.get(ID).files.read("/workspace/big.bin"), WHOLE)

    def test_read_stream_raises_when_short(self):
        _, runtime = self.world([2_000_000])
        files = runtime.sandboxes.get(ID).files
        with self.assertRaises(RuntimeError) as caught:
            b"".join(files.read_stream("/workspace/big.bin"))
        self.assertEqual(caught.exception.code, "download_incomplete")
        self.assertEqual(b"".join(files.read_stream("/workspace/big.bin")), WHOLE)

    def test_download_never_leaves_a_short_file(self):
        with tempfile.TemporaryDirectory() as directory:
            _, runtime = self.world([1_000_000])
            target = os.path.join(directory, "o.bin")
            runtime.sandboxes.get(ID).files.download("/workspace/big.bin", target)
            with open(target, "rb") as handle:
                self.assertEqual(handle.read(), WHOLE)
            _, runtime = self.world([1, 2, 3, 4])
            with self.assertRaises(RuntimeError):
                runtime.sandboxes.get(ID).files.download("/workspace/big.bin", os.path.join(directory, "lost.bin"))
            self.assertEqual(os.listdir(directory), ["o.bin"])

    def test_async_read_and_stream(self):
        world = World([5, 6])
        self.addCleanup(world.close)

        async def run():
            async with AsyncRuntime(api_key="rt_test", base_url=world.url, max_retries=0) as runtime:
                files = (await runtime.sandboxes.get(ID)).files
                self.assertEqual(await files.read("/workspace/big.bin"), WHOLE)
                world.cuts, world.reads = [7], 0
                with self.assertRaises(RuntimeError):
                    async for _ in files.read_stream("/workspace/big.bin"):
                        pass
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
