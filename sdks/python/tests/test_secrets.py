"""runtime.secrets and runtime.networks.upstream_proxy against a stub API, sync and async. The routes, and the
host proxy opening what the API sealed, are tested in packages/cloud
(secrets-open-ports-postgres.test.ts)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

from withruntime import AsyncRuntime, NotFoundError, Runtime

SECRET = {
    "name": "OPENAI_API_KEY",
    "hosts": ["api.openai.com"],
    "placeholder": "rtsec_0123456789abcdef0123456789abcdef",
    "valueBytes": 7,
    "createdAt": "2026-09-23T10:00:00.000Z",
    "updatedAt": "2026-09-23T10:00:00.000Z",
}


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def answer(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length)) if length else None

    def do_GET(self):
        Stub.seen.append((self.command, self.path, None))
        # The jobs copies: none here.
        self.answer([] if self.path.startswith("/v1/secrets") else {"secrets": [SECRET]})

    def do_PUT(self):
        Stub.seen.append((self.command, self.path, self.body()))
        self.answer({**SECRET, "enforced": True})

    def do_DELETE(self):
        Stub.seen.append((self.command, self.path, None))
        self.answer({"name": SECRET["name"], "deleted": True, "enforced": True})


class SecretsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen = []

    def test_sync_set_list_delete(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            saved = runtime.secrets.set("OPENAI_API_KEY", value="sk-live", hosts=["api.openai.com"],
                                        header="Authorization", format="Bearer {value}")
            self.assertEqual(saved["placeholder"], SECRET["placeholder"])
            self.assertEqual(runtime.secrets.list(), [SECRET])
            self.assertTrue(runtime.secrets.delete("OPENAI_API_KEY")["deleted"])
        self.assertEqual(Stub.seen, [
            ("PUT", "/v1/egress-secrets/OPENAI_API_KEY", {"value": "sk-live", "hosts": ["api.openai.com"],
                                                  "header": "Authorization", "format": "Bearer {value}"}),
            ("GET", "/v1/egress-secrets", None),
            ("GET", "/v1/secrets?limit=100", None),
            ("DELETE", "/v1/egress-secrets/OPENAI_API_KEY", None),
        ])

    def test_narrow_sends_only_given_fields_sync_and_async(self):
        rules = [{"methods": ["GET"], "paths": ["/repos/acme/*"]}]
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.secrets.narrow("GITHUB_TOKEN", hosts=["api.github.com"])
            runtime.secrets.narrow("GITHUB_TOKEN", rules=rules)

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                await runtime.secrets.narrow("GITHUB_TOKEN", hosts=["api.github.com"], rules=rules)

        asyncio.run(go())
        self.assertEqual(Stub.seen, [
            ("PUT", "/v1/egress-secrets/GITHUB_TOKEN/rules", {"hosts": ["api.github.com"]}),
            ("PUT", "/v1/egress-secrets/GITHUB_TOKEN/rules", {"rules": rules}),
            ("PUT", "/v1/egress-secrets/GITHUB_TOKEN/rules", {"hosts": ["api.github.com"], "rules": rules}),
        ])

    def test_async_set(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.secrets.set("K", value="v", hosts=["a.example.com"])

        self.assertTrue(asyncio.run(go())["enforced"])
        self.assertEqual(Stub.seen[0][2], {"value": "v", "hosts": ["a.example.com"]})

    def test_rules_are_sent_sync_and_async(self):
        rules = [{"methods": ["GET", "HEAD"], "paths": ["/repos/acme/*"]}, {"paths": ["/user"]}]
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.secrets.set("GITHUB_TOKEN", value="ghp_x", hosts=["api.github.com"], rules=rules)

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                await runtime.secrets.set("GITHUB_TOKEN", value="ghp_x", hosts=["api.github.com"], rules=rules)

        asyncio.run(go())
        expected = {"value": "ghp_x", "hosts": ["api.github.com"], "rules": rules}
        self.assertEqual([seen[2] for seen in Stub.seen], [expected, expected])

    def test_env_is_sent_only_when_given(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.secrets.set("GH_REPO_A", value="ghp_x", hosts=["api.github.com"], env="GITHUB_TOKEN")
            runtime.secrets.set("GH_REPO_A", value="ghp_x", hosts=["api.github.com"])
        base = {"value": "ghp_x", "hosts": ["api.github.com"]}
        self.assertEqual([seen[2] for seen in Stub.seen], [{**base, "env": "GITHUB_TOKEN"}, base])

    def test_only_and_scope_are_sent_sync_and_async(self):
        only = {"labels": [{"role": "hub"}], "sandboxes": ["ef01c6ef-6648-450b-acd2-6fe82ac31960"]}
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.secrets.set("SLACK_APP_TOKEN", value="xapp_x", hosts=["slack.com"], only=only)
            runtime.secrets.set("SLACK_APP_TOKEN", value="xapp_x", hosts=["slack.com"], only={})
            runtime.secrets.set("SLACK_APP_TOKEN", value="xapp_x", hosts=["slack.com"])
            scoped = runtime.secrets.scope("SLACK_APP_TOKEN", {"labels": [{"role": "hub"}]})
            runtime.secrets.scope("SLACK_APP_TOKEN", {})

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.secrets.scope("A B", only)

        self.assertTrue(asyncio.run(go())["enforced"])
        self.assertTrue(scoped["enforced"])
        base = {"value": "xapp_x", "hosts": ["slack.com"]}
        path = "/v1/egress-secrets/SLACK_APP_TOKEN"
        self.assertEqual(Stub.seen, [
            ("PUT", path, {**base, "only": only}),
            ("PUT", path, {**base, "only": {}}),
            ("PUT", path, base),  # no `only`: the scope the secret has stays
            ("PUT", f"{path}/sandboxes", {"labels": [{"role": "hub"}]}),
            ("PUT", f"{path}/sandboxes", {}),
            ("PUT", "/v1/egress-secrets/A%20B/sandboxes", only),
        ])

    def test_github_app_git_api_and_only_are_sent_sync_and_async(self):
        pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"
        github_app = {"id": 12345, "installation": 67890, "repositories": ["runtime-cloud"],
                      "permissions": {"contents": "write"}, "api": "https://github.example.com/api/v3"}
        git = {"push": ["refs/heads/task/{label.task}", "refs/heads/task/{label.task}--*"]}
        api = {"callsPerHour": 500, "writesPerHour": 0, "keep": 100, "copies": True, "fresh": 60,
               "graphql": {"path": "/api/graphql", "mutations": ["createPullRequest"]}}
        only = {"labels": [{"role": "hub"}]}
        hosts = ["api.github.com", "github.com"]
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.secrets.set("GITHUB_APP", value=pem, hosts=hosts, github_app=github_app, git=git, api=api,
                                only=only)
            runtime.secrets.set("NO_PUSH", value=pem, hosts=hosts, github_app=github_app, git={"push": []})

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                await runtime.secrets.set("GITHUB_APP", value=pem, hosts=hosts, github_app=github_app, git=git,
                                          api=api, only=only)

        asyncio.run(go())
        expected = {"value": pem, "hosts": hosts, "only": only, "githubApp": github_app, "git": git, "api": api}
        self.assertEqual(Stub.seen[0][2], expected)
        self.assertEqual(Stub.seen[1][2]["git"], {"push": []})
        self.assertNotIn("api", Stub.seen[1][2])
        self.assertEqual(Stub.seen[2][2], expected)
        # Nothing set: no policy field is sent at all.
        Stub.seen = []
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            runtime.secrets.set("K", value="v", hosts=["a.example.com"])
        self.assertEqual(Stub.seen[0][2], {"value": "v", "hosts": ["a.example.com"]})


class UpstreamProxyStub(BaseHTTPRequestHandler):
    seen: list = []
    proxy: Optional[dict] = None

    def log_message(self, *args):
        pass

    def answer(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def none(self):
        self.answer(404, {"error": {"code": "not_found", "message": "No upstream proxy is set."}})

    def do_PUT(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length))
        UpstreamProxyStub.seen.append(("PUT", self.path, body))
        UpstreamProxyStub.proxy = {**body, "updatedAt": "2026-09-25T10:00:00.000Z"}
        self.answer(200, {**UpstreamProxyStub.proxy, "enforced": True})

    def do_GET(self):
        UpstreamProxyStub.seen.append(("GET", self.path, None))
        if UpstreamProxyStub.proxy is None:
            return self.none()
        self.answer(200, UpstreamProxyStub.proxy)

    def do_DELETE(self):
        UpstreamProxyStub.seen.append(("DELETE", self.path, None))
        if UpstreamProxyStub.proxy is None:
            return self.none()
        UpstreamProxyStub.proxy = None
        self.answer(200, {"deleted": True, "enforced": True})


class UpstreamProxyTest(unittest.TestCase):
    """runtime.networks.upstream_proxy, sync and async. The routes, and the
    host's CONNECT through the proxy, are tested in packages/cloud
    (linux-egress-upstream.test.ts)."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamProxyStub)
        threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        UpstreamProxyStub.seen = []
        UpstreamProxyStub.proxy = None

    def test_sync_set_get_remove(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            with self.assertRaises(NotFoundError):
                runtime.networks.upstream_proxy.get()
            saved = runtime.networks.upstream_proxy.set("http://proxy.example.com:3128", secret="PROXY_AUTH",
                                                       hosts=["*.internal.example.com"])
            self.assertTrue(saved["enforced"])
            self.assertEqual(runtime.networks.upstream_proxy.get()["secret"], "PROXY_AUTH")
            self.assertTrue(runtime.networks.upstream_proxy.remove()["deleted"])
            with self.assertRaises(NotFoundError):
                runtime.networks.upstream_proxy.remove()
        path = "/v1/networks/upstream-proxy"
        self.assertEqual(UpstreamProxyStub.seen, [
            ("GET", path, None),
            ("PUT", path, {"url": "http://proxy.example.com:3128", "secret": "PROXY_AUTH",
                           "hosts": ["*.internal.example.com"]}),
            ("GET", path, None),
            ("DELETE", path, None),
            ("DELETE", path, None),
        ])

    def test_async_set_sends_only_what_is_given(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                await runtime.networks.upstream_proxy.set("https://proxy.example.com:8443")
                return await runtime.networks.upstream_proxy.get()

        self.assertEqual(asyncio.run(go())["url"], "https://proxy.example.com:8443")
        self.assertEqual(UpstreamProxyStub.seen[0][2], {"url": "https://proxy.example.com:8443"})


COPY = {"id": "sec_1", "name": "HUB_KEY", "ownerId": "p", "createdBy": "agent_a", "usableBy": [], "version": 1,
        "createdAt": 0, "updatedAt": 0, "deletedAt": None}


class ShareStub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def answer(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        ShareStub.seen.append((self.command, self.path, None))
        self.answer([COPY] if self.path.startswith("/v1/secrets") else {"secrets": []})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
        ShareStub.seen.append((self.command, self.path, body))
        self.answer({**COPY, "usableBy": body["agents"]})


class ShareTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), ShareStub)
        threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        ShareStub.seen = []

    def test_sync_share_replaces_who_may_use_the_jobs_copy(self):
        with Runtime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
            self.assertEqual(runtime.secrets.share("HUB_KEY", ["agent_b"])["usableBy"], ["agent_b"])
            self.assertEqual(runtime.secrets.share("HUB_KEY", "all")["usableBy"], "all")
            with self.assertRaises(NotFoundError):
                runtime.secrets.share("MISSING", [])
        self.assertEqual([seen[2] for seen in ShareStub.seen if seen[0] == "POST"],
                         [{"agents": ["agent_b"]}, {"agents": "all"}])
        self.assertEqual(ShareStub.seen[1][:2], ("POST", "/v1/secrets/sec_1:share"))

    def test_async_share(self):
        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                return await runtime.secrets.share("HUB_KEY", [])

        self.assertEqual(asyncio.run(go())["usableBy"], [])
        self.assertEqual(ShareStub.seen[-1], ("POST", "/v1/secrets/sec_1:share", {"agents": []}))


if __name__ == "__main__":
    unittest.main()
