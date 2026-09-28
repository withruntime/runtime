"""runtime.jobs and the jobs copy of runtime.secrets against a stub API, sync and
async. The routes run over Postgres in packages/cloud (product-api.test.ts)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import (AsyncRuntime, InvalidRequestError, Runtime, SecretPartlyStoredError,
                         ServiceUnavailableError)

JOB_ID = "11111111-1111-4111-8111-111111111111"
RUN_ID = "22222222-2222-4222-8222-222222222222"
SECRET_ID = "33333333-3333-4333-8333-333333333333"
JOB = {"id": JOB_ID, "name": "nightly", "state": "active", "nextRunAt": 1}
RUN = {"id": RUN_ID, "jobId": JOB_ID, "state": "succeeded", "exitCode": 0}
COPY = {"id": SECRET_ID, "name": "DB_PASSWORD", "version": 2, "deletedAt": None}
EGRESS = {"name": "API_TOKEN", "hosts": ["api.example.com"], "placeholder": "rtsec_x", "enforced": True}


class Stub(BaseHTTPRequestHandler):
    seen: list = []
    mode = "ok"
    copies: list = []

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
        path = self.path.split("?")[0]
        Stub.seen.append((self.command, self.path, body, self.headers.get("idempotency-key")))
        if Stub.mode == "off" or (Stub.mode == "jobs-off" and path.startswith("/v1/secrets")):
            return self.answer({"error": {"code": "unavailable", "message": "This product is not enabled on this "
                                          "deployment.", "hint": "not yet"}}, 503)
        if path == "/v1/jobs" and self.command == "GET":
            return self.answer({"items": [JOB], "nextCursor": None})
        if path.endswith("/runs"):
            return self.answer({"items": [RUN], "nextCursor": None})
        if path.endswith("/logs"):
            return self.answer({"chunks": [{"offset": 0, "stream": "stdout", "text": "hi\n"}], "nextCursor": 3,
                                "truncated": False, "complete": True})
        if path.startswith("/v1/job-runs/"):
            return self.answer(RUN)
        if path.startswith("/v1/jobs"):
            return self.answer(JOB)
        if path == "/v1/secrets" and self.command == "GET":
            return self.answer(Stub.copies)
        if path.endswith(":reveal"):
            return self.answer({"id": SECRET_ID, "version": 2, "value": "hunter2"})
        if path.startswith("/v1/secrets"):
            return self.answer({**COPY, "version": 1})
        if path.startswith("/v1/egress-secrets"):
            return self.answer(EGRESS if self.command == "PUT" else {"name": "x", "deleted": True, "enforced": True})
        self.answer({"error": {"code": "not_found", "message": "no"}}, 404)

    do_GET = do_POST = do_PUT = do_DELETE = handle_any


class JobsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen, Stub.mode, Stub.copies = [], "ok", []

    def client(self):
        return Runtime(api_key="rk_test", base_url=self.url, max_retries=2)

    def test_create_fills_defaults_and_every_verb_calls_its_route(self):
        with self.client() as runtime:
            runtime.jobs.create("nightly", cron="0 3 * * *", timezone="Europe/Berlin", command=["echo", "hi"])
            self.assertEqual([j["id"] for j in runtime.jobs.list()], [JOB_ID])
            self.assertEqual(runtime.jobs.runs(JOB_ID).data[0]["id"], RUN_ID)
            self.assertEqual(runtime.jobs.run(RUN_ID)["state"], "succeeded")
            self.assertTrue(runtime.jobs.logs(RUN_ID, cursor=0)["complete"])
            runtime.jobs.pause(JOB_ID)
            runtime.jobs.resume(JOB_ID)
            runtime.jobs.cancel(JOB_ID)
        first = Stub.seen[0]
        self.assertEqual(first[:2], ("POST", "/v1/jobs"))
        self.assertTrue(first[3])
        self.assertEqual(first[2]["compute"], {"region": "us-east", "vcpu": 2, "cpuMode": "shared",
                                               "cpuFloorMillis": 50, "memoryMiB": 4096, "diskMiB": 4096,
                                               "durationSeconds": 1860})
        self.assertEqual(first[2]["schedule"], {"kind": "cron", "expression": "0 3 * * *",
                                                "timezone": "Europe/Berlin"})
        self.assertEqual([s[1].split("?")[0] for s in Stub.seen[1:]], [
            "/v1/jobs", f"/v1/jobs/{JOB_ID}/runs", f"/v1/job-runs/{RUN_ID}", f"/v1/job-runs/{RUN_ID}/logs",
            f"/v1/jobs/{JOB_ID}:pause", f"/v1/jobs/{JOB_ID}:resume", f"/v1/jobs/{JOB_ID}:cancel"])

    def test_mistakes_are_refused_before_sending(self):
        with self.client() as runtime:
            for kwargs, pattern in [
                ({"at": 1, "compute": {"vcpu": 32}}, "at most 16 vCPU"),
                ({"at": 1, "compute": {"diskMiB": 512}}, "at least 3072 MiB"),
                ({"cron": "0 3 * *"}, "five fields"),
                ({"at": "tomorrow"}, "must be a time"),
                ({}, "at= for one run or cron="),
                ({"at": 1, "timezone": "UTC"}, "timezone goes with cron"),
            ]:
                with self.assertRaisesRegex(InvalidRequestError, pattern):
                    runtime.jobs.create("x", command=["true"], **kwargs)
        self.assertEqual(Stub.seen, [])

    def test_switched_off_names_the_product_and_is_not_retried(self):
        Stub.mode = "off"
        with self.client() as runtime:
            with self.assertRaises(ServiceUnavailableError) as caught:
                runtime.jobs.list()
        self.assertEqual(caught.exception.message, "Jobs are not enabled on this Runtime API yet.")
        self.assertIn("retrying will not help", caught.exception.hint)
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(len(Stub.seen), 1)

    def test_secret_jobs_copy_set_rotate_reveal_delete(self):
        with self.client() as runtime:
            saved = runtime.secrets.set("DB_PASSWORD", value="hunter2", jobs=True)
            self.assertEqual(saved["jobs"]["version"], 1)
            Stub.copies = [COPY]
            runtime.secrets.set("DB_PASSWORD", value="new", jobs=True)
            self.assertEqual(runtime.secrets.reveal("DB_PASSWORD")["value"], "hunter2")
            self.assertEqual(runtime.secrets.delete("DB_PASSWORD")["from"], ["sandboxes", "jobs"])
        lines = [(s[0], s[1].split("?")[0]) for s in Stub.seen]
        self.assertEqual(lines, [
            ("GET", "/v1/secrets"), ("POST", "/v1/secrets"),
            ("GET", "/v1/secrets"), ("POST", f"/v1/secrets/{SECRET_ID}:rotate"),
            ("GET", "/v1/secrets"), ("POST", f"/v1/secrets/{SECRET_ID}:reveal"),
            ("GET", "/v1/secrets"), ("DELETE", "/v1/egress-secrets/DB_PASSWORD"),
            ("POST", f"/v1/secrets/{SECRET_ID}:delete")])
        self.assertEqual(Stub.seen[3][2], {"value": "new", "expectedVersion": 2})

    def test_both_copies_report_a_partial_store_and_the_retry_finishes(self):
        Stub.mode = "jobs-off"

        async def go():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                with self.assertRaises(SecretPartlyStoredError) as caught:
                    await runtime.secrets.set("API_TOKEN", value="t", hosts=["api.example.com"], jobs=True)
                self.assertEqual(caught.exception.details["stored"], ["sandboxes"])
                Stub.mode = "ok"
                saved = await runtime.secrets.set("API_TOKEN", value="t", hosts=["api.example.com"], jobs=True)
                self.assertEqual(saved["placeholder"], "rtsec_x")
                self.assertEqual(saved["jobs"]["version"], 1)
        asyncio.run(go())


if __name__ == "__main__":
    unittest.main()
