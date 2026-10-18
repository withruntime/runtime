"""runtime.apps, runtime.functions and runtime.builds against a stub API, sync and
async. The routes run over Postgres in packages/cloud (apps-product.test.ts,
builds-product.test.ts); this holds the SDK to their paths, bodies, paging,
waits and the build log's follow."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from withruntime import AsyncRuntime, InvalidRequestError, PermissionDeniedError, Runtime
from withruntime import RuntimeError as RuntimeAPIError

APP_ID = "11111111-1111-4111-8111-111111111111"
DEPLOY_ID = "22222222-2222-4222-8222-222222222222"
BUILD_ID = "33333333-3333-4333-8333-333333333333"
REPO_ID = "44444444-4444-4444-8444-444444444444"
APP = {"id": APP_ID, "name": "web", "state": "waiting", "error": None}
BUILD = {"id": BUILD_ID, "repositoryId": REPO_ID, "ref": "main", "state": "queued", "error": None}
REPO = {"id": REPO_ID, "provider": "github", "repository": "acme/web", "state": "connected", "error": None}


def line(cursor, text):
    return {"type": "line", "cursor": cursor, "at": 1, "step": "build", "text": text, "stream": "stdout"}


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    mode = "ok"
    # Each GET of a deploy answers the next of these states; the last repeats.
    deploys: list = []
    # Each follow of a build's log answers the next of these event lists.
    follows: list = []

    def log_message(self, *args):
        pass

    def answer(self, value, status=200, kind="application/json"):
        data = ("".join(json.dumps(v) + "\n" for v in value) if kind == "application/x-ndjson"
                else json.dumps(value)).encode()
        self.send_response(status)
        self.send_header("content-type", kind)
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
            return self.answer({"error": {"code": "product_in_beta", "message": "Apps is in a private beta.",
                                          "hint": "Ask us to join it."}}, 403)
        if path in ("/v1/apps", "/v1/functions", "/v1/builds", "/v1/repositories") and self.command == "GET":
            record = {"/v1/builds": BUILD, "/v1/repositories": REPO}.get(path, APP)
            # Two pages: the first names the cursor of the second.
            if "cursor" in query:
                return self.answer({"data": [{**record, "id": "second"}], "nextCursor": None})
            return self.answer({"data": [record], "nextCursor": "page-2"})
        if "/deploys/" in path:
            state = Stub.deploys.pop(0) if len(Stub.deploys) > 1 else Stub.deploys[0]
            return self.answer({"id": DEPLOY_ID, "version": 2, "url": "https://x/", "state": state})
        if path.endswith("/deploys") or path.endswith("/rollback"):
            return self.answer({"id": DEPLOY_ID, "version": 2, "url": "https://x/", "state": "building"})
        if path.endswith("/versions"):
            return self.answer([{"version": 1, "live": True, "previous": False, "saved": True,
                                 "deploy": DEPLOY_ID, "build": None}])
        if path.endswith("/copies"):
            return self.answer([])
        if path.startswith("/v1/apps/") or path.startswith("/v1/functions/"):
            if self.command == "DELETE":
                return self.answer({**APP, "state": "deleting"})
            if Stub.mode == "live":
                return self.answer({**APP, "state": "live"})
            gets = sum(1 for s in Stub.seen if s[0] == "GET" and s[1] == path)
            return self.answer({**APP, "state": "deleted" if gets > 1 else "deleting"}
                               if Stub.mode == "deleting" else APP)
        if path.endswith("/logs") and query.get("follow") == ["true"]:
            return self.answer(Stub.follows.pop(0), kind="application/x-ndjson")
        if path.endswith("/logs"):
            return self.answer({"lines": [], "cursor": None, "state": "failed", "reason": "exit 1",
                                "failingStep": {"name": "build", "exitCode": 1, "lastLines": ["boom"]},
                                "hasMore": False, "nextCursor": None})
        if path == "/v1/repositories/github:install":
            return self.answer({"url": "https://github.com/apps/runtime/installations/new", "expiresAt": "x"})
        if path.startswith("/v1/repositories"):
            return self.answer(REPO)
        if path.startswith("/v1/builds") or path == "/v1/builds":
            return self.answer({**BUILD, "state": "cancelled"} if path.endswith(":cancel") else BUILD)
        if path in ("/v1/apps", "/v1/functions"):
            return self.answer(APP)
        self.answer({"error": {"code": "not_found", "message": "no"}}, 404)

    do_GET = do_POST = do_PUT = do_DELETE = handle_any


class AppsBuildsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen, Stub.mode, Stub.deploys, Stub.follows = [], "ok", ["live"], []

    def client(self):
        return Runtime(api_key="rk_test", base_url=self.url, max_retries=2)

    def routes(self):
        return [(s[0], s[1]) for s in Stub.seen]

    def test_every_app_verb_calls_its_route_with_the_apis_names(self):
        with self.client() as runtime:
            runtime.apps.create(name="web", max_copies=4, vcpu=1, memory_mib=1024, min_copies=1,
                                health_path="/healthz")
            runtime.apps.get(APP_ID, wait_for="live", timeout_seconds=5)
            self.assertEqual([a["id"] for a in runtime.apps.list(label=["team:web"])], [APP_ID, "second"])
            runtime.apps.update(APP_ID, name=None, max_copies=8)
            runtime.apps.deploy(APP_ID, image="web:latest", env={"A": "1"}, keep_env=True)
            runtime.apps.get_deploy(APP_ID, DEPLOY_ID)
            runtime.apps.rollback(APP_ID)
            self.assertTrue(runtime.apps.versions(APP_ID)[0]["live"])
            self.assertEqual(runtime.apps.copies(APP_ID), [])
            runtime.apps.delete(APP_ID)
        base = f"/v1/apps/{APP_ID}"
        self.assertEqual(self.routes(), [
            ("POST", "/v1/apps"), ("GET", base), ("GET", "/v1/apps"), ("GET", "/v1/apps"),
            ("POST", f"{base}:update"), ("POST", f"{base}/deploys"), ("GET", f"{base}/deploys/{DEPLOY_ID}"),
            ("POST", f"{base}/rollback"), ("GET", f"{base}/versions"), ("GET", f"{base}/copies"),
            ("DELETE", base)])
        self.assertEqual(Stub.seen[0][3], {"name": "web", "maxCopies": 4, "vcpu": 1, "memoryMiB": 1024,
                                           "minCopies": 1, "healthPath": "/healthz"})
        self.assertEqual(Stub.seen[1][2], {"waitFor": ["live"], "timeoutSeconds": ["5"]})
        self.assertEqual(Stub.seen[2][2], {"label": ["team:web"]})
        self.assertEqual(Stub.seen[3][2], {"label": ["team:web"], "cursor": ["page-2"]})
        # name=None clears the name; a field left out is not sent.
        self.assertEqual(Stub.seen[4][3], {"name": None, "maxCopies": 8})
        self.assertEqual(Stub.seen[5][3], {"image": "web:latest", "env": {"A": "1"}, "keepEnv": True})
        self.assertEqual(Stub.seen[7][3], {})
        # Every write carries a key, so the transport's retries never write twice.
        self.assertTrue(all(s[4] for s in Stub.seen if s[0] != "GET"))

    def test_a_deploy_with_wait_follows_its_own_record_under_one_key(self):
        Stub.deploys = ["warming", "switching", "live"]
        with self.client() as runtime:
            deploy = runtime.apps.deploy(APP_ID, build=BUILD_ID, wait=True, poll=0, idempotency_key="deploy-1")
        self.assertEqual(deploy["state"], "live")
        reads = [s for s in Stub.seen if "/deploys/" in s[1]]
        self.assertEqual(len(reads), 3)
        self.assertTrue(all(r[2] == {"waitFor": ["live"], "timeoutSeconds": ["60"]} for r in reads))
        self.assertEqual(Stub.seen[0][3], {"build": BUILD_ID})
        self.assertEqual(Stub.seen[0][4], "deploy-1")

    def test_a_failed_deploy_is_returned_with_its_reasons_not_raised(self):
        Stub.deploys = ["failed"]
        with self.client() as runtime:
            self.assertEqual(runtime.apps.wait_deploy(APP_ID, DEPLOY_ID, poll=0)["state"], "failed")
            self.assertEqual(runtime.apps.rollback(APP_ID, wait=True, poll=0)["state"], "failed")

    def test_a_wait_past_its_deadline_says_timeout_and_keeps_the_writes_key(self):
        Stub.deploys = ["warming"]
        with self.client() as runtime:
            with self.assertRaises(RuntimeAPIError) as caught:
                runtime.apps.deploy(APP_ID, image="web", wait=True, timeout=0.3, poll=0.05,
                                    idempotency_key="deploy-2")
        self.assertEqual(caught.exception.code, "timeout")
        self.assertEqual(caught.exception.idempotency_key, "deploy-2")

    def test_delete_with_wait_follows_the_app_to_deleted(self):
        Stub.mode = "deleting"
        with self.client() as runtime:
            self.assertEqual(runtime.apps.delete(APP_ID, wait=True, poll=0)["state"], "deleted")
        self.assertEqual(self.routes()[0], ("DELETE", f"/v1/apps/{APP_ID}"))

    def test_an_app_wait_that_settles_elsewhere_raises_its_error(self):
        Stub.mode = "live"
        with self.client() as runtime:
            with self.assertRaises(RuntimeAPIError) as caught:
                runtime.apps.wait(APP_ID, "deleted", poll=0)
        self.assertEqual(caught.exception.code, "unexpected_state")
        self.assertEqual(caught.exception.details["state"], "live")

    def test_mistakes_are_refused_before_sending(self):
        with self.client() as runtime:
            with self.assertRaises(InvalidRequestError):
                runtime.apps.deploy(APP_ID, image="web", build=BUILD_ID)
            with self.assertRaises(InvalidRequestError):
                runtime.apps.deploy(APP_ID)
            with self.assertRaises(InvalidRequestError):
                runtime.functions.create(max_copies=1, vcpu=1, memory_mib=256, min_copies=1)
            with self.assertRaises(InvalidRequestError):
                runtime.apps.wait(APP_ID, "live", timeout=-1)
            with self.assertRaises(RuntimeAPIError) as caught:
                list(runtime.builds.logs(BUILD_ID, follow=True, page_cursor="p"))
        self.assertEqual(caught.exception.code, "invalid_log_options")
        self.assertEqual(Stub.seen, [])

    def test_functions_share_the_shape_at_their_own_path(self):
        with self.client() as runtime:
            runtime.functions.create(max_copies=2, vcpu=1, memory_mib=256)
            runtime.functions.deploy(APP_ID, image="fn")
        self.assertEqual(self.routes(), [("POST", "/v1/functions"), ("POST", f"/v1/functions/{APP_ID}/deploys")])

    def test_outside_the_beta_the_403_is_the_sdks_permission_error(self):
        Stub.mode = "beta"
        with self.client() as runtime:
            for call in (lambda: runtime.apps.list(), lambda: runtime.builds.get(BUILD_ID),
                         lambda: runtime.builds.repositories.install_github()):
                with self.assertRaises(PermissionDeniedError) as caught:
                    call()
                self.assertEqual(caught.exception.code, "product_in_beta")
                self.assertEqual(caught.exception.status, 403)
                self.assertEqual(caught.exception.hint, "Ask us to join it.")
                self.assertFalse(caught.exception.retryable)
        # Refused once each: a 403 is never retried.
        self.assertEqual(len(Stub.seen), 3)

    def test_every_build_and_repository_verb_calls_its_route(self):
        with self.client() as runtime:
            runtime.builds.repositories.connect(provider="github", repository="acme/web", deploy=f"app:{APP_ID}",
                                                start_command="bun start", build_env={"NODE_ENV": "production"})
            self.assertEqual(len(runtime.builds.repositories.list().to_list()), 2)
            runtime.builds.repositories.update(REPO_ID, build_command=None, production_branch="release")
            runtime.builds.repositories.disconnect(REPO_ID)
            self.assertIn("github.com", runtime.builds.repositories.install_github()["url"])
            runtime.builds.create(REPO_ID, "main", branch="main")
            runtime.builds.get(BUILD_ID)
            self.assertEqual(runtime.builds.list(state=["failed", "cancelled"]).data[0]["id"], BUILD_ID)
            self.assertEqual(runtime.builds.cancel(BUILD_ID)["state"], "cancelled")
            log = runtime.builds.logs(BUILD_ID)
        self.assertEqual(log["failingStep"]["lastLines"], ["boom"])
        self.assertEqual(self.routes(), [
            ("POST", "/v1/repositories"), ("GET", "/v1/repositories"), ("GET", "/v1/repositories"),
            ("POST", f"/v1/repositories/{REPO_ID}:update"), ("DELETE", f"/v1/repositories/{REPO_ID}"),
            ("POST", "/v1/repositories/github:install"), ("POST", "/v1/builds"), ("GET", f"/v1/builds/{BUILD_ID}"),
            ("GET", "/v1/builds"), ("POST", f"/v1/builds/{BUILD_ID}:cancel"), ("GET", f"/v1/builds/{BUILD_ID}/logs")])
        self.assertEqual(Stub.seen[0][3], {"provider": "github", "repository": "acme/web", "deploy": f"app:{APP_ID}",
                                           "startCommand": "bun start", "buildEnv": {"NODE_ENV": "production"}})
        self.assertEqual(Stub.seen[3][3], {"productionBranch": "release", "buildCommand": None})
        self.assertEqual(Stub.seen[6][3], {"repositoryId": REPO_ID, "ref": "main", "branch": "main"})
        self.assertEqual(Stub.seen[8][2], {"state": ["failed", "cancelled"]})

    def test_a_follow_reconnects_from_its_cursor_and_gives_each_line_once(self):
        Stub.follows = [
            [line("c1", "one"), line("c2", "two"), {"type": "continue", "cursor": "c2"}],
            [line("c2", "two"), line("c3", "three"),
             {"type": "terminal", "cursor": "c3", "state": "failed", "reason": "exit 1",
              "failingStep": {"name": "build", "exitCode": 1, "lastLines": ["three"]}}],
        ]
        with self.client() as runtime:
            events = list(runtime.builds.logs(BUILD_ID, follow=True))
        self.assertEqual([e.get("text") or e["type"] for e in events], ["one", "two", "three", "terminal"])
        follows = [s[2] for s in Stub.seen]
        self.assertEqual(follows, [{"follow": ["true"]}, {"follow": ["true"], "cursor": ["c2"]}])

    def test_a_follow_raises_the_services_error_and_refuses_a_malformed_event(self):
        Stub.follows = [[line("c1", "one"), {"type": "error", "cursor": "c1", "code": "build_not_found",
                                             "hint": "Check the build id."}],
                        [{"type": "line", "cursor": "c1", "text": 5}]]
        with self.client() as runtime:
            with self.assertRaises(RuntimeAPIError) as caught:
                list(runtime.builds.logs(BUILD_ID, follow=True))
            self.assertEqual((caught.exception.code, caught.exception.details), ("build_not_found", {"cursor": "c1"}))
            with self.assertRaises(RuntimeAPIError) as caught:
                list(runtime.builds.logs(BUILD_ID, follow=True))
            self.assertEqual(caught.exception.code, "build_log_invalid")

    def test_a_follow_whose_stream_keeps_ending_says_where_to_resume(self):
        Stub.follows = [[line("c1", "one")], [], [], []]
        with self.client() as runtime:
            with self.assertRaises(RuntimeAPIError) as caught:
                list(runtime.builds.logs(BUILD_ID, follow=True))
        self.assertEqual((caught.exception.code, caught.exception.details), ("build_log_interrupted", {"cursor": "c1"}))

    def test_async_clients_await_and_iterate_the_same_way(self):
        Stub.deploys = ["warming", "live"]
        Stub.follows = [[line("c1", "one"), {"type": "terminal", "cursor": "c1", "state": "succeeded",
                                             "reason": "built", "failingStep": None}]]

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=2) as runtime:
                await runtime.apps.create(max_copies=1, vcpu=1, memory_mib=256)
                ids = [a["id"] async for a in await runtime.apps.list()]
                deploy = await runtime.apps.deploy(APP_ID, image="web", wait=True, poll=0)
                build = await runtime.builds.create(REPO_ID, "main")
                log = await runtime.builds.logs(BUILD_ID)
                events = [e async for e in runtime.builds.logs(BUILD_ID, follow=True)]
                repos = await (await runtime.builds.repositories.list()).to_list()
                return ids, deploy, build, log, events, repos
        ids, deploy, build, log, events, repos = asyncio.run(go())
        self.assertEqual(ids, [APP_ID, "second"])
        self.assertEqual(deploy["state"], "live")
        self.assertEqual(build["id"], BUILD_ID)
        self.assertEqual(log["state"], "failed")
        self.assertEqual([e["type"] for e in events], ["line", "terminal"])
        self.assertEqual(len(repos), 2)


if __name__ == "__main__":
    unittest.main()
