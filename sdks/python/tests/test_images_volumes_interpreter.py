"""Images, volumes and the interpreter against a stub API: the paths and
bodies the SDK sends, the build helper's polling and log lines, and the
interpreter's NDJSON stream turned into callbacks and one execution. The
routes themselves are tested in packages/cloud (images-api, interpreter)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from withruntime import AsyncRuntime, AsyncSandbox, Runtime, RuntimeError
from withruntime._sync_client import Sandbox

SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"
EXECUTION = {"id": "e1", "contextId": "python", "status": "ok", "stdout": "hi\n", "results": [], "error": None}


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    polls = 0
    fail = False

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
        body = json.loads(self.rfile.read(length)) if length else None
        Stub.seen.append((self.command, url.path, url.query, body, self.headers.get("prefer")))
        path, method = url.path, self.command
        if method == "POST" and path == "/v1/images":
            return self._reply(201, {"id": "img-1", "state": "queued"})
        if path == "/v1/images/img-1/logs":
            first = url.query == "after=0"
            return self._reply(200, {"lines": [{"seq": 1, "text": "pulling"}] if first else [], "nextAfter": 1,
                                     "done": False})
        if path == "/v1/images/img-1":
            Stub.polls += 1
            state = "building" if Stub.polls < 2 else ("failed" if Stub.fail else "ready")
            return self._reply(200, {"id": "img-1", "state": state, "error": "exit 1" if Stub.fail else None})
        if path == "/v1/images":
            return self._reply(200, {"data": [{"id": "img-1"}], "nextCursor": None})
        if path == "/v1/volumes" and method == "POST":
            return self._reply(201, {"id": "vol-1", "state": "ready", "sizeMiB": body["sizeMiB"]})
        if path == "/v1/volumes/vol-1:delete":
            return self._reply(200, {"id": "vol-1", "state": "deleting"})
        base = f"/v1/sandboxes/{SANDBOX}/interpreter"
        if path == base + ":run":
            if not body.get("stream"):
                return self._reply(200, EXECUTION)
            lines = [{"k": "start", "n": 1}, {"k": "stdout", "text": "hi\n"},
                     {"k": "result", "main": True, "data": {"text/plain": "2"}, "refs": {}},
                     {"k": "end"}, {"k": "execution", "execution": EXECUTION}]
            return self._reply(200, "".join(json.dumps(line) + "\n" for line in lines).encode(),
                               "application/x-ndjson")
        if path == base + "/contexts" and method == "POST":
            return self._reply(201, {"id": body["id"], "language": body["language"]})
        if path == base + "/contexts/py2:interrupt":
            return self._reply(200, {"interrupted": True})
        if path == base + "/contexts/python/results/r1.png":
            return self._reply(200, b"\x89PNG", "image/png")
        return self._reply(404, {"error": {"code": "not_found", "message": path}})

    do_GET = do_POST = do_DELETE = _route


class ImagesVolumesInterpreter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen, Stub.polls, Stub.fail = [], 0, False

    def client(self):
        return Runtime(api_key="rk_test", base_url=self.url, max_retries=0)

    def test_build_polls_to_ready_and_passes_log_lines(self):
        lines = []
        image = self.client().images.build(recipe={"pip": ["pandas"], "files": {"a.txt": b"\x00"}},
                                           build={"max_image_mib": 2048}, build_args={"V": "1"},
                                           on_log=lambda line: lines.append(line["text"]), poll_seconds=0)
        self.assertEqual(image["state"], "ready")
        self.assertEqual(lines, ["pulling"])
        method, path, _, body, _ = Stub.seen[0]
        self.assertEqual((method, path), ("POST", "/v1/images"))
        self.assertEqual(body, {"recipe": {"pip": ["pandas"], "files": [
            {"path": "a.txt", "content": "AA==", "encoding": "base64"}]},
            "build": {"maxImageMiB": 2048}, "buildArgs": {"V": "1"}})

    def test_a_failed_build_raises_with_its_error(self):
        Stub.fail = True
        with self.assertRaises(RuntimeError) as caught:
            self.client().images.build(image="alpine:3.20", poll_seconds=0)
        self.assertEqual(caught.exception.code, "image_build_failed")
        self.assertIn("exit 1", str(caught.exception))

    def test_images_list_and_volumes(self):
        runtime = self.client()
        self.assertEqual([i["id"] for i in runtime.images.list(state="ready")], ["img-1"])
        volume = runtime.volumes.create(1024, name="data")
        self.assertEqual(volume["sizeMiB"], 1024)
        self.assertEqual(Stub.seen[-1][3:], ({"sizeMiB": 1024, "name": "data"}, "wait=10"))
        self.assertEqual(runtime.volumes.delete("vol-1")["state"], "deleting")

    def test_interpreter_run_plain_and_streamed(self):
        sbx = Sandbox(self.client().sandboxes._t, {"id": SANDBOX})
        self.assertEqual(sbx.interpreter.run("print('hi')", timeout_ms=5000)["stdout"], "hi\n")
        self.assertEqual(Stub.seen[-1][3], {"code": "print('hi')", "timeoutMs": 5000})
        out, results = [], []
        execution = sbx.interpreter.run("1+1", on_stdout=out.append, on_result=results.append)
        self.assertEqual((execution["status"], out), ("ok", ["hi\n"]))
        self.assertEqual(results, [{"main": True, "data": {"text/plain": "2"}, "refs": {}}])
        self.assertTrue(Stub.seen[-1][3]["stream"])
        self.assertEqual(sbx.interpreter.contexts.create(id="py2", language="python")["id"], "py2")
        self.assertTrue(sbx.interpreter.contexts.interrupt("py2"))
        ref = {"path": "/workspace/.runtime/interpreter/python/out/r1.png"}
        self.assertEqual(sbx.interpreter.result(ref), b"\x89PNG")
        with self.assertRaises(ValueError):
            sbx.interpreter.result({"path": "/etc/passwd"})

    def test_async_twin(self):
        async def main():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                image = await runtime.images.build(image="alpine:3.20", poll_seconds=0)
                sbx = AsyncSandbox(runtime.sandboxes._t, {"id": SANDBOX})
                execution = await sbx.interpreter.run("1+1", on_stdout=lambda text: None)
                return image["state"], execution["status"]
        self.assertEqual(asyncio.run(main()), ("ready", "ok"))


if __name__ == "__main__":
    unittest.main()
