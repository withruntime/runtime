"""runtime.browsers against a stub API, sync and async: a run started in one
call and followed by long polls on its steps until it ends, every runs route
with the API's names, and a refused model key returned, not raised."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from withruntime import AsyncRuntime, Runtime

RUN_ID = "66666666-6666-4666-8666-666666666666"


def run(state, **fields):
    return {"id": RUN_ID, "state": state, "task": "Find the title", "model": "claude-sonnet-5-5",
            "startUrl": None, "output": None, "error": None, "steps": 0, "url": None, "sandboxId": None,
            "labels": {}, "createdAt": "2026-10-26T00:00:00Z", "startedAt": None, "endedAt": None, **fields}


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    # Each read of the run answers the next of these; the last repeats.
    states: list = []

    def log_message(self, *args):
        pass

    def answer(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_any(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        Stub.seen.append((self.command, url.path, body if self.command == "POST" else query))
        if url.path == "/v1/browsers/runs" and self.command == "POST":
            return self.answer(run("queued", task=body["task"]), 201)
        if url.path == "/v1/browsers/runs":
            return self.answer({"data": [run("done")], "nextCursor": None})
        if url.path == f"/v1/browsers/runs/{RUN_ID}/steps":
            if query.get("after", "0") == "0":
                return self.answer({"data": [{"n": 0, "seq": 2, "url": "https://example.com/", "frame": None},
                                             {"n": 1, "seq": 3, "url": "https://example.com/", "frame": None}],
                                    "after": 3, "ended": False})
            return self.answer({"data": [], "after": 3, "ended": True})
        if url.path == f"/v1/browsers/runs/{RUN_ID}:stop":
            return self.answer(run("stopped"))
        if url.path == f"/v1/browsers/runs/{RUN_ID}":
            state = Stub.states.pop(0) if len(Stub.states) > 1 else Stub.states[0]
            return self.answer(state)
        return self.answer({"error": {"code": "not_found", "message": "no"}}, 404)

    do_GET = do_POST = handle_any


class BrowsersTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        Stub.seen = []
        Stub.states = [run("running"), run("done", output="Example Domain", steps=1)]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_run_starts_one_and_follows_its_steps_until_it_ends(self):
        with Runtime(api_key="rk_test", base_url=self.url) as runtime:
            done = runtime.browsers.run("Find the title", start_url="https://example.com", max_steps=5)
        self.assertEqual((done["state"], done["output"]), ("done", "Example Domain"))
        self.assertEqual(Stub.seen, [
            ("POST", "/v1/browsers/runs", {"task": "Find the title", "startUrl": "https://example.com",
                                           "maxSteps": 5}),
            ("GET", f"/v1/browsers/runs/{RUN_ID}", {}),
            ("GET", f"/v1/browsers/runs/{RUN_ID}/steps", {"after": "0", "frames": "false", "wait": "30"}),
            ("GET", f"/v1/browsers/runs/{RUN_ID}/steps", {"after": "3", "frames": "false", "wait": "30"}),
            ("GET", f"/v1/browsers/runs/{RUN_ID}", {}),
        ])

    def test_every_runs_verb_calls_its_route_and_a_failed_run_is_returned(self):
        Stub.states = [run("failed", error="Store your key as the egress secret OPENAI_API_KEY.")]
        with Runtime(api_key="rk_test", base_url=self.url) as runtime:
            runtime.browsers.runs.create("Read the invoice", model="gpt-5", allowed_domains=["example.com"],
                                         labels={"team": "billing"})
            self.assertEqual(runtime.browsers.runs.list(limit=5).data[0]["state"], "done")
            steps = [s["n"] for s in runtime.browsers.runs.follow(RUN_ID)]
            self.assertEqual(steps, [0, 1])
            self.assertEqual(runtime.browsers.runs.stop(RUN_ID)["state"], "stopped")
            failed = runtime.browsers.runs.wait(RUN_ID)
        self.assertIn("OPENAI_API_KEY", failed["error"])
        self.assertEqual(Stub.seen[0], ("POST", "/v1/browsers/runs", {
            "task": "Read the invoice", "model": "gpt-5", "allowedDomains": ["example.com"],
            "labels": {"team": "billing"}}))
        self.assertEqual(Stub.seen[1], ("GET", "/v1/browsers/runs", {"limit": "5"}))
        self.assertEqual(Stub.seen[2], ("GET", f"/v1/browsers/runs/{RUN_ID}/steps", {"after": "0", "wait": "30"}))
        self.assertEqual(Stub.seen[-2], ("POST", f"/v1/browsers/runs/{RUN_ID}:stop", {}))
        # A run that has ended is answered without a wait.
        self.assertEqual(Stub.seen[-1], ("GET", f"/v1/browsers/runs/{RUN_ID}", {}))

    def test_async_run(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url) as runtime:
                return await runtime.browsers.run("Find the title")
        self.assertEqual(asyncio.run(go())["output"], "Example Domain")


if __name__ == "__main__":
    unittest.main()
