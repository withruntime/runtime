"""Sandbox.identity_token() against a stub of /v1/identity/token: the request
token from the environment as the bearer, the audience and lifetime in the
query, the token back. The route itself is tested in packages/cloud
(identity-tokens.test.ts)."""
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import withruntime
from withruntime import RuntimeError, Sandbox


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    # What the sandbox's listener answers at /v1/environment; None: nothing.
    current = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urlparse(self.path)
        Stub.seen.append((url.path, parse_qs(url.query), self.headers.get("Authorization")))
        if url.path == "/v1/environment":
            body, status = (Stub.current, 200) if Stub.current else ({}, 404)
        elif self.headers.get("Authorization") != "Bearer rtid1.statement.sig":
            body, status = {"error": {"code": "unauthorized", "message": "This request token is not valid."}}, 401
        else:
            body, status = {"token": "header.payload.signature", "expiresAt": "2026-09-24T00:10:00Z"}, 200
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class IdentityTokenTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.saved = {k: os.environ.get(k) for k in ("RUNTIME_ID_TOKEN_REQUEST_URL", "RUNTIME_ID_TOKEN_REQUEST_TOKEN")}
        os.environ["RUNTIME_ID_TOKEN_REQUEST_URL"] = f"http://127.0.0.1:{self.server.server_port}/v1/identity/token"
        Stub.seen, Stub.current = [], None
        self.where = (withruntime._ENVIRONMENT_URL, withruntime._ENVIRONMENT_FILE)
        withruntime._ENVIRONMENT_URL = f"http://127.0.0.1:{self.server.server_port}/v1/environment"
        withruntime._ENVIRONMENT_FILE = "/nonexistent/runtime/environment.json"

    def tearDown(self):
        withruntime._ENVIRONMENT_URL, withruntime._ENVIRONMENT_FILE = self.where
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.assertEqual(self.server.fileno(), -1, "fixture listener was not closed")
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_asks_with_the_sandbox_request_token_for_the_audience(self):
        os.environ["RUNTIME_ID_TOKEN_REQUEST_TOKEN"] = "rtid1.statement.sig"
        token = Sandbox.identity_token("sts.amazonaws.com", lifetime_seconds=900)
        self.assertEqual(token, "header.payload.signature")
        path, query, auth = Stub.seen[0]
        self.assertEqual(path, "/v1/identity/token")
        self.assertEqual(query, {"audience": ["sts.amazonaws.com"], "lifetimeSeconds": ["900"]})
        self.assertEqual(auth, "Bearer rtid1.statement.sig")

    def test_a_refusal_carries_the_api_message(self):
        os.environ["RUNTIME_ID_TOKEN_REQUEST_TOKEN"] = "rtid1.other.sig"
        import urllib.error
        import urllib.request
        from unittest.mock import patch
        urlopen = urllib.request.urlopen
        responses = []

        def record_error(*args, **kwargs):
            try:
                return urlopen(*args, **kwargs)
            except urllib.error.HTTPError as error:
                responses.append(error)
                raise

        try:
            with patch("urllib.request.urlopen", side_effect=record_error):
                with self.assertRaises(RuntimeError) as caught:
                    Sandbox.identity_token("sts.amazonaws.com")
            self.assertIn("not valid", str(caught.exception))
            self.assertEqual(caught.exception.status, 401)
            # The listener had nothing newer: one ask, and its environment read.
            self.assertEqual([seen[0] for seen in Stub.seen], ["/v1/identity/token", "/v1/environment"])
            self.assertEqual(len(responses), 2)
            self.assertTrue(all(r.closed for r in responses), "an error response was not closed")
        finally:
            # Preserve deterministic cleanup even against the unfixed client;
            # the assertion above observes SDK ownership, before this fallback.
            for response in responses:
                response.close()

    def test_a_stale_request_token_is_read_again_from_the_host_once(self):
        # The build sandbox's statement, as an App copy's saved server holds it.
        os.environ["RUNTIME_ID_TOKEN_REQUEST_TOKEN"] = "rtid1.build.sig"
        Stub.current = {"RUNTIME_ID_TOKEN_REQUEST_URL": os.environ["RUNTIME_ID_TOKEN_REQUEST_URL"],
                        "RUNTIME_ID_TOKEN_REQUEST_TOKEN": "rtid1.statement.sig"}
        self.assertEqual(Sandbox.identity_token("sts.amazonaws.com"), "header.payload.signature")
        self.assertEqual([(path, auth) for path, _, auth in Stub.seen], [
            ("/v1/identity/token", "Bearer rtid1.build.sig"),
            ("/v1/environment", None),
            ("/v1/identity/token", "Bearer rtid1.statement.sig"),
        ])

    def test_a_sandbox_whose_programs_lack_the_variables_asks_its_host(self):
        # An older guest: no variables in the process, a file without them.
        import tempfile
        os.environ.pop("RUNTIME_ID_TOKEN_REQUEST_TOKEN", None)
        url = os.environ.pop("RUNTIME_ID_TOKEN_REQUEST_URL")
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as file:
            json.dump({"SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt"}, file)
        self.addCleanup(os.unlink, file.name)
        withruntime._ENVIRONMENT_FILE = file.name
        Stub.current = {"RUNTIME_ID_TOKEN_REQUEST_URL": url, "RUNTIME_ID_TOKEN_REQUEST_TOKEN": "rtid1.statement.sig"}
        self.assertEqual(Sandbox.identity_token("sts.amazonaws.com"), "header.payload.signature")
        self.assertEqual([(path, auth) for path, _, auth in Stub.seen], [
            ("/v1/environment", None),
            ("/v1/identity/token", "Bearer rtid1.statement.sig"),
        ])

    def test_outside_a_sandbox_nothing_is_asked_over_the_network(self):
        os.environ.pop("RUNTIME_ID_TOKEN_REQUEST_TOKEN", None)
        Stub.current = {"RUNTIME_ID_TOKEN_REQUEST_URL": os.environ["RUNTIME_ID_TOKEN_REQUEST_URL"],
                        "RUNTIME_ID_TOKEN_REQUEST_TOKEN": "rtid1.statement.sig"}
        with self.assertRaises(RuntimeError) as caught:
            Sandbox.identity_token("sts.amazonaws.com")
        self.assertEqual(caught.exception.code, "identity_unavailable")
        self.assertEqual(Stub.seen, [])

    def test_outside_a_sandbox_there_is_nothing_to_ask_with(self):
        os.environ.pop("RUNTIME_ID_TOKEN_REQUEST_TOKEN", None)
        if os.path.exists("/run/runtime/environment.json"):
            self.skipTest("running inside a sandbox")
        with self.assertRaises(RuntimeError) as caught:
            Sandbox.identity_token("sts.amazonaws.com")
        self.assertEqual(caught.exception.code, "identity_unavailable")


if __name__ == "__main__":
    unittest.main()
