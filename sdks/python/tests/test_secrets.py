"""runtime.secrets and runtime.network.upstream_proxy against a stub API, sync and async. The routes, and the
host proxy opening what the API sealed, are tested in packages/cloud
(secrets-open-ports-postgres.test.ts)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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
        self.answer({"secrets": [SECRET]})

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
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
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
            ("DELETE", "/v1/egress-secrets/OPENAI_API_KEY", None),
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


class UpstreamProxyStub(BaseHTTPRequestHandler):
    seen: list = []
    proxy: dict | None = None

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
    """runtime.network.upstream_proxy, sync and async. The routes, and the
    host's CONNECT through the proxy, are tested in packages/cloud
    (linux-egress-upstream.test.ts)."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamProxyStub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
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
                runtime.network.upstream_proxy.get()
            saved = runtime.network.upstream_proxy.set("http://proxy.example.com:3128", secret="PROXY_AUTH",
                                                       hosts=["*.internal.example.com"])
            self.assertTrue(saved["enforced"])
            self.assertEqual(runtime.network.upstream_proxy.get()["secret"], "PROXY_AUTH")
            self.assertTrue(runtime.network.upstream_proxy.remove()["deleted"])
            with self.assertRaises(NotFoundError):
                runtime.network.upstream_proxy.remove()
        path = "/v1/network/upstream-proxy"
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
                await runtime.network.upstream_proxy.set("https://proxy.example.com:8443")
                return await runtime.network.upstream_proxy.get()

        self.assertEqual(asyncio.run(go())["url"], "https://proxy.example.com:8443")
        self.assertEqual(UpstreamProxyStub.seen[0][2], {"url": "https://proxy.example.com:8443"})


if __name__ == "__main__":
    unittest.main()
