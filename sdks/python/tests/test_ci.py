"""runtime.ci (CI/CD) against a stub API, sync and async: every route with its
method, path, query and body, paging by ``nextCursor``, the write keys, and the
beta refusal as the SDK's own error."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from withruntime import AsyncRuntime, PermissionDeniedError, Runtime

REPO_ID = "11111111-1111-4111-8111-111111111111"
CHECK_ID = "22222222-2222-4222-8222-222222222222"
JOB_ID = "33333333-3333-4333-8333-333333333333"
REPO = {"id": REPO_ID, "repository": "acme/web", "state": "connected", "error": None}
REVIEW = {"verdict": "block", "summary": "Moves a table.", "notes": [], "agent": "ci-review",
          "findings": [{"kind": "data-at-risk", "file": "db.sql", "line": 4, "what": "Drops it.", "fix": "Keep it."}],
          "account": "CLAUDE_TOKEN_1", "model": "opus", "session": "s-1", "cut": False}
JOB = {"id": JOB_ID, "checkId": CHECK_ID, "name": "test", "state": "failed", "sandboxIds": ["sbx-1"]}
CHECK = {"id": CHECK_ID, "repositoryId": REPO_ID, "state": "failed", "counts": {"failed": 1}}
TEST = {"repositoryId": REPO_ID, "file": "a.test.ts", "ms": 5, "quarantinedSince": None, "runs": []}


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    mode = "ok"

    def log_message(self, *args):
        pass

    def answer(self, value, status=200):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        Stub.seen.append((self.command, path, query, body, self.headers.get("idempotency-key")))
        if Stub.mode == "beta":
            return self.answer({"error": {"code": "product_in_beta", "message": "CI/CD is in a private beta.",
                                          "hint": "Ask us to join it."}}, 403)
        if path in ("/v1/ci/repositories", "/v1/ci/checks", "/v1/ci/tests") and self.command == "GET":
            record = {"/v1/ci/repositories": REPO, "/v1/ci/checks": CHECK, "/v1/ci/tests": TEST}[path]
            if "cursor" in query:
                return self.answer({"data": [{**record, "id": "second"}], "nextCursor": None})
            return self.answer({"data": [record], "nextCursor": "page-2"})
        if path == "/v1/ci/flakes" and self.command == "GET":
            return self.answer({"data": [{"id": "f1", "file": "t/a.test.ts", "state": "quarantined"}],
                                "nextCursor": None})
        if path == "/v1/ci/flakes/f1":
            return self.answer({"id": "f1", "runs": [], "failures": []})
        if path == "/v1/ci/flakes/f1:update":
            return self.answer({"id": "f1", "owner": {"login": body.get("owner")}})
        if path == f"/v1/ci/checks/{CHECK_ID}":
            return self.answer({**CHECK, "jobs": [JOB]})
        if path == f"/v1/ci/jobs/{JOB_ID}":
            return self.answer({**JOB, "log": "boom\n", "review": REVIEW})
        if path.startswith("/v1/ci/repositories"):
            return self.answer({**REPO, "state": "disconnected"} if self.command == "DELETE" else REPO)
        self.answer({"error": {"code": "not_found", "message": "no"}}, 404)

    do_GET = do_POST = do_PUT = do_DELETE = handle_any


class CiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen, Stub.mode = [], "ok"

    def client(self):
        return Runtime(api_key="rk_test", base_url=self.url, max_retries=2)

    def test_flakes_list_get_and_an_owners_say(self):
        with self.client() as runtime:
            flakes = runtime.ci.flakes.list(repository_id=REPO_ID, state=["quarantined", "gating"])
            one = runtime.ci.flakes.get("f1")
            handed = runtime.ci.flakes.update("f1", owner="acme/testers", prove=True)
            runtime.ci.flakes.update("f1", delete_reason="it timed a timer")
        self.assertEqual(flakes.data[0]["state"], "quarantined")
        self.assertEqual(one["runs"], [])
        self.assertEqual(handed["owner"], {"login": "acme/testers"})
        self.assertEqual([(s[0], s[1]) for s in Stub.seen], [
            ("GET", "/v1/ci/flakes"), ("GET", "/v1/ci/flakes/f1"), ("POST", "/v1/ci/flakes/f1:update"),
            ("POST", "/v1/ci/flakes/f1:update")])
        self.assertEqual(Stub.seen[0][2], {"repositoryId": [REPO_ID], "state": ["quarantined", "gating"]})
        self.assertEqual(Stub.seen[2][3], {"owner": "acme/testers", "prove": True})
        self.assertEqual(Stub.seen[3][3], {"deleteReason": "it timed a timer"})

    def test_every_verb_calls_its_route_with_the_apis_names(self):
        with self.client() as runtime:
            connected = runtime.ci.repositories.connect(
                "acme/web", production_branch="trunk", config_path="ci/runtime.yml", installation=7,
                name="web", labels={"team": "web"}, idempotency_key="connect-1")
            repos = runtime.ci.repositories.list(name="web", labels=["team:web", "env:prod"],
                                                 state=["connected"], limit=1)
            disconnected = runtime.ci.repositories.disconnect(REPO_ID)
            checks = runtime.ci.checks.list(repository_id=REPO_ID, state=["failed", "queued"], branch="main",
                                            commit="a" * 40, pull_request=12, limit=5)
            check = runtime.ci.checks.get(CHECK_ID)
            job = runtime.ci.jobs.get(JOB_ID)
            tests = runtime.ci.tests.list(REPO_ID, quarantined=True, limit=10)
        self.assertEqual(connected["id"], REPO_ID)
        self.assertEqual(disconnected["state"], "disconnected")
        self.assertEqual((repos.next_cursor, checks.next_cursor, tests.next_cursor), ("page-2",) * 3)
        self.assertEqual(check["jobs"][0]["id"], JOB_ID)
        self.assertEqual(job["log"], "boom\n")
        self.assertEqual(job["review"]["findings"][0]["kind"], "data-at-risk")
        self.assertEqual([(s[0], s[1]) for s in Stub.seen], [
            ("POST", "/v1/ci/repositories"), ("GET", "/v1/ci/repositories"),
            ("DELETE", f"/v1/ci/repositories/{REPO_ID}"), ("GET", "/v1/ci/checks"),
            ("GET", f"/v1/ci/checks/{CHECK_ID}"), ("GET", f"/v1/ci/jobs/{JOB_ID}"), ("GET", "/v1/ci/tests")])
        self.assertEqual(Stub.seen[0][3], {"repository": "acme/web", "productionBranch": "trunk",
                                           "configPath": "ci/runtime.yml", "installation": 7, "name": "web",
                                           "labels": {"team": "web"}})
        self.assertEqual(Stub.seen[0][4], "connect-1")
        self.assertEqual(Stub.seen[1][2], {"name": ["web"], "label": ["team:web", "env:prod"],
                                           "state": ["connected"], "limit": ["1"]})
        self.assertTrue(Stub.seen[2][4])
        self.assertEqual(Stub.seen[3][2], {"repositoryId": [REPO_ID], "state": ["failed", "queued"],
                                           "branch": ["main"], "commit": ["a" * 40], "pullRequest": ["12"],
                                           "limit": ["5"]})
        self.assertEqual(Stub.seen[6][2], {"repositoryId": [REPO_ID], "quarantined": ["true"], "limit": ["10"]})

    def test_a_connect_with_only_a_repository_sends_only_it(self):
        with self.client() as runtime:
            runtime.ci.repositories.connect("acme/web")
        self.assertEqual(Stub.seen[0][3], {"repository": "acme/web"})
        self.assertTrue(Stub.seen[0][4])

    def test_lists_walk_every_page_by_next_cursor(self):
        with self.client() as runtime:
            self.assertEqual([c["id"] for c in runtime.ci.checks.list()], [CHECK_ID, "second"])
            self.assertEqual(len(list(runtime.ci.tests.list(REPO_ID))), 2)
            self.assertEqual(len(list(runtime.ci.repositories.list())), 2)
            resumed = runtime.ci.checks.list(cursor="page-2")
        self.assertEqual(resumed.data[0]["id"], "second")
        self.assertEqual(Stub.seen[1][2], {"cursor": ["page-2"]})
        self.assertEqual(Stub.seen[-1][2], {"cursor": ["page-2"]})

    def test_outside_the_beta_the_403_is_the_sdks_permission_error(self):
        Stub.mode = "beta"
        with self.client() as runtime:
            with self.assertRaises(PermissionDeniedError) as caught:
                runtime.ci.checks.list()
        self.assertEqual(caught.exception.code, "product_in_beta")
        self.assertEqual(len(Stub.seen), 1)

    def test_async_client_calls_the_same_routes(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=2) as runtime:
                await runtime.ci.repositories.connect("acme/web")
                checks = await (await runtime.ci.checks.list(repository_id=REPO_ID)).to_list()
                check = await runtime.ci.checks.get(CHECK_ID)
                job = await runtime.ci.jobs.get(JOB_ID)
                tests = await (await runtime.ci.tests.list(REPO_ID)).to_list()
                await runtime.ci.repositories.disconnect(REPO_ID)
                return checks, check, job, tests
        checks, check, job, tests = asyncio.run(go())
        self.assertEqual(len(checks), 2)
        self.assertEqual(len(tests), 2)
        self.assertEqual(check["jobs"][0]["name"], "test")
        self.assertEqual(job["log"], "boom\n")
        self.assertEqual(job["review"]["findings"][0]["kind"], "data-at-risk")
        self.assertEqual(Stub.seen[-1][:2], ("DELETE", f"/v1/ci/repositories/{REPO_ID}"))


if __name__ == "__main__":
    unittest.main()
