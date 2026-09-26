"""Build contexts from a folder, their chunked upload, streamed build logs,
versions and tags, and registry credentials, against a stub API. The routes
themselves are tested in packages/cloud (images-api-v2)."""
import gzip
import hashlib
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from withruntime import Runtime
from withruntime._async_products.images import dockerignore_filter, pack_context

ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    uploaded: list = []
    created: dict = {}

    def log_message(self, *args):
        pass

    def _reply(self, status, value, kind="application/json"):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        is_json = (self.headers.get("content-type") or "").startswith("application/json")
        body = json.loads(raw) if raw and is_json else raw
        Stub.seen.append((self.command, url.path, url.query))
        path = url.path
        if path == "/v1/images/context/missing":
            return self._reply(200, {"missing": body["digests"][1:]})
        if path.startswith("/v1/images/context/"):
            Stub.uploaded.append((path.rsplit("/", 1)[1], hashlib.sha256(body).hexdigest()))
            return self._reply(200, {"sha256": "x", "size": len(body), "stored": True})
        if self.command == "POST" and path == "/v1/images":
            Stub.created = body
            return self._reply(200, {"id": ID, "state": "queued"})
        if path == f"/v1/images/{ID}/logs" and parse_qs(url.query).get("follow") == ["true"]:
            lines = [{"type": "line", "seq": 1, "at": "t", "stream": "build", "text": "step"},
                     {"type": "done", "state": "ready", "image": {"id": ID, "state": "ready", "version": 4}}]
            return self._reply(200, "".join(json.dumps(line) + "\n" for line in lines).encode(),
                               "application/x-ndjson")
        if path == "/v1/images/resolve":
            return self._reply(200, {"id": ID, "version": 2})
        if path == f"/v1/images/{ID}:tag":
            return self._reply(200, {"id": ID, "tags": [body["tag"]]})
        if path == "/v1/images/registries" and self.command == "POST":
            return self._reply(200, {"id": "r", "registry": body["registry"], "kind": "basic",
                                     "username": body.get("username")})
        return self._reply(404, {"error": {"code": "not_found", "message": path}})

    do_GET = do_POST = do_PUT = _route


class ImagesV2(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def client(self):
        return Runtime(api_key="rt_test", base_url=f"http://127.0.0.1:{self.server.server_port}", max_retries=0)

    def folder(self, files):
        root = tempfile.mkdtemp()
        for path, content in files.items():
            full = os.path.join(root, path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as handle:
                handle.write(content)
        return root

    def test_a_folder_packs_what_its_dockerignore_leaves_the_same_every_time(self):
        root = self.folder({".dockerignore": "node_modules\n*.log\n!keep.log\n", "app/main.py": "print(1)\n",
                            "node_modules/x.js": "x", "debug.log": "n", "keep.log": "k", "Dockerfile": "FROM a\n"})
        packed = pack_context(root)
        self.assertEqual(sorted(f["path"] for f in packed["files"]),
                         [".dockerignore", "Dockerfile", "app/main.py", "keep.log"])
        self.assertIn(b"print(1)", gzip.decompress(packed["archive"]))
        self.assertEqual(pack_context(root)["archive"], packed["archive"])

    def test_dockerignore_rules(self):
        ignored = dockerignore_filter("**/*.tmp\nbuild/\n!build/keep\n# note\n/secret\n")
        self.assertEqual([ignored(p) for p in ("a/b.tmp", "build/x", "secret/k")], [True, True, True])
        self.assertEqual([ignored(p) for p in ("build/keep", "src/secret", "main.py")], [False, False, False])

    def test_build_uploads_only_missing_chunks_then_streams_the_log(self):
        root = self.folder({"main.py": "x" * 3_000_000, "Dockerfile": "FROM a\nCOPY . .\n"})
        # Random-ish bytes so the archive is more than one chunk once compressed.
        with open(os.path.join(root, "blob.bin"), "wb") as handle:
            handle.write(os.urandom(1_500_000))
        Stub.uploaded.clear()
        lines = []
        image = self.client().images.build(name="app", dockerfile="FROM a\nCOPY . .\n", context_dir=root,
                                           tags=["v4"], start={"command": "python main.py", "ready_port": 8000},
                                           on_log=lambda line: lines.append(line["text"]), poll_seconds=0)
        self.assertEqual(image["version"], 4)
        self.assertEqual(lines, ["step"])
        context = Stub.created["context"]
        chunks = context["archive"]["chunks"]
        self.assertGreater(len(chunks), 1)
        # The stub has the first chunk already; only the others travel, each checked by its name.
        self.assertEqual([name for name, _ in Stub.uploaded], chunks[1:])
        self.assertTrue(all(name == digest for name, digest in Stub.uploaded))
        self.assertEqual(Stub.created["start"], {"command": "python main.py", "readyPort": 8000})
        self.assertEqual(Stub.created["tags"], ["v4"])
        self.assertNotIn("contextDir", Stub.created)

    def test_tags_resolve_names_and_registries_send_their_secret_once(self):
        client = self.client()
        self.assertEqual(client.images.tag("web:v2", "prod")["tags"], ["prod"])
        saved = client.images.registries.set("ghcr.io", username="me", password="ghp_x")
        self.assertEqual(saved["registry"], "ghcr.io")
        self.assertNotIn("password", saved)
        self.assertIn(("GET", "/v1/images/resolve", "ref=web%3Av2"), Stub.seen)


if __name__ == "__main__":
    unittest.main()
