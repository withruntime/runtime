"""Sandbox sessions (ARCHITECTURE.md section 3.12) against a stub API: the
backend makes, lists and revokes them with ``sbx.sessions``; a page's code
drives the sandbox with ``Sandbox.from_session`` and the token alone; and the
Blaxel adapter's ``sandbox.sessions`` and ``from_session`` map onto them. The
routes are tested in packages/cloud (sandbox-sessions-postgres.test.ts)."""
import asyncio
import json
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import withruntime.blaxel as bl
from withruntime import AsyncSandbox, Runtime, Sandbox
from withruntime.blaxel import NotSupportedError, SyncSandboxInstance

ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    sessions: list = []
    url = ""

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
        body = json.loads(self.rfile.read(length) or b"null") if length else None
        path = self.path.split("?")[0]
        Stub.seen.append((self.command, path, self.headers.get("authorization"), body))
        if path == f"/v1/sandboxes/{ID}/sessions" and self.command == "POST":
            sid = f"00000000-0000-4000-8000-{len(Stub.sessions):012d}"
            made = {"id": sid, "sandboxId": ID, "name": None, "origins": body.get("origins", []),
                    "createdBy": "agent", "createdAt": "2026-09-28T10:00:00Z",
                    "expiresAt": (datetime.now(timezone.utc)
                                  + timedelta(seconds=body.get("ttlSeconds", 3600))).isoformat(),
                    "revokedAt": None, "state": "active"}
            Stub.sessions.insert(0, made)
            return self.answer({**made, "token": f"rtsess_{sid}_{'t' * 43}", "apiUrl": Stub.url})
        if path == f"/v1/sandboxes/{ID}/sessions":
            return self.answer({"data": Stub.sessions, "nextCursor": None})
        if path.endswith(":revoke"):
            sid = path.split("/")[-1].split(":")[0]
            for one in Stub.sessions:
                if one["id"] == sid:
                    one.update(state="revoked", revokedAt="2026-09-28T10:30:00Z")
                    return self.answer(one)
            return self.answer({"error": {"code": "not_found", "status": 404, "message": "x"}}, 404)
        if path.endswith(":exec"):
            return self.answer({"exitCode": 0, "stdout": "hi\n", "stderr": "", "timedOut": False})
        return self.answer({"id": ID, "name": "web", "state": "running", "labels": {}, "autoWake": True,
                            "memoryMiB": 4096, "createdAt": "2026-09-28T10:00:00Z",
                            "expiresAt": "2026-09-28T11:00:00Z", "onLeaseEnd": "stop"})

    do_GET = do_POST = do_PUT = handle_any


class SessionsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = Stub.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen, Stub.sessions = [], []

    def test_backend_makes_lists_and_revokes(self):
        with Runtime(api_key="rtcloud_k", base_url=self.url, max_retries=0) as runtime:
            sbx = runtime.sandboxes.get(ID)
            made = sbx.sessions.create(ttl_seconds=900, origins=["https://app.example.com"], name="u1")
            self.assertTrue(made["token"].startswith("rtsess_"))
            self.assertEqual(Stub.seen[-1][3], {"ttlSeconds": 900, "origins": ["https://app.example.com"],
                                                "name": "u1"})
            self.assertEqual([one["id"] for one in sbx.sessions.list()], [made["id"]])
            self.assertEqual(sbx.sessions.revoke(made["id"])["state"], "revoked")

    def test_page_uses_the_token_alone(self):
        token = f"rtsess_{'0' * 8}-0000-4000-8000-{'0' * 12}_{'t' * 43}"
        sbx = Sandbox.from_session(token, ID, self.url)
        self.assertEqual(Stub.seen, [])
        self.assertEqual(sbx.exec("echo hi").stdout, "hi\n")
        self.assertEqual(Stub.seen[-1][2], f"Bearer {token}")
        with self.assertRaises(Exception):
            Sandbox.from_session("rtcloud_key", ID, self.url)

        async def go():
            page = AsyncSandbox.from_session(token, ID, self.url)
            return (await page.exec("echo hi")).stdout

        self.assertEqual(asyncio.run(go()), "hi\n")

    def test_blaxel_sessions_and_from_session(self):
        runtime = Runtime(api_key="rtcloud_k", base_url=self.url, max_retries=0)
        bl.use_client(runtime)
        try:
            box = SyncSandboxInstance(_runtime=runtime.sandboxes.get(ID))
            session = box.sessions.create({
                "expires_at": datetime.now(timezone.utc) + timedelta(minutes=15),
                "response_headers": {"Access-Control-Allow-Origin": "https://app.example.com",
                                     "Access-Control-Allow-Methods": "GET"}})
            self.assertTrue(session.token.startswith("rtsess_"))
            self.assertEqual(session.url, f"{self.url}/v1/sandboxes/{ID}")
            self.assertEqual(Stub.seen[-1][3]["origins"], ["https://app.example.com"])
            self.assertIn(Stub.seen[-1][3]["ttlSeconds"], (899, 900))
            box.sessions.create()  # Blaxel's default: a day, Runtime's most.
            self.assertEqual(Stub.seen[-1][3]["ttlSeconds"], 86_400)
            self.assertEqual(len(box.sessions.list()), 2)
            self.assertEqual(box.sessions.get(session.name)["url"], session.url)
            box.sessions.delete(session.name)
            self.assertNotIn(session.name, [one.name for one in box.sessions.list()])
            kept = box.sessions.create_if_expired({}, delta_seconds=60)
            self.assertEqual(box.sessions.create_if_expired({}, delta_seconds=60).token, kept.token)

            page = SyncSandboxInstance.from_session(session)
            self.assertEqual(page.metadata.name, "web")
            self.assertTrue(any(auth == f"Bearer {session.token}" for _, _, auth, _ in Stub.seen))

            before = len(Stub.seen)
            for options in ({"response_headers": {"Access-Control-Allow-Origin": "*"}},
                            {"response_headers": {"X-Frame-Options": "DENY"}},
                            {"request_headers": {"Authorization": "x"}},
                            {"expires_at": datetime.now(timezone.utc) + timedelta(days=2)}):
                with self.assertRaises(NotSupportedError):
                    box.sessions.create(options)
            self.assertEqual(len(Stub.seen), before)
            with self.assertRaises(NotSupportedError):
                SyncSandboxInstance.from_session({"url": "https://blaxel.dev/x", "token": "bl_x"})
        finally:
            bl.use_client(None)
            runtime.close()


if __name__ == "__main__":
    unittest.main()
