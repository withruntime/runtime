"""An answer later than the API holds its headers arrives as a 200 with
runtime-late-answer: true, then the answer or {"error": ...}. A failure is
raised as its typed error (packages/cloud/src/api/hold.ts). Sync and async."""
import asyncio
import json
import unittest

from withruntime import AsyncRuntime, NotFoundError, Runtime

ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"


class Wire:
    def __init__(self, body, is_async):
        self.body, self.is_async = body, is_async

    def send(self, method, target, headers, data, timeout):
        body = self.body.encode()
        is_async = self.is_async

        class Answer:
            status, headers = 200, {"runtime-late-answer": "true"}
            if is_async:
                async def read(self):
                    return body
            else:
                def read(self):
                    return body
        if is_async:
            async def later():
                return Answer()
            return later()
        return Answer()


def call(body):
    outcomes = []
    for is_async in (False, True):
        runtime = (AsyncRuntime if is_async else Runtime)(api_key="rk", base_url="https://api.example.test")
        runtime._t._http = Wire(body, is_async)
        try:
            if is_async:
                outcomes.append(asyncio.run(runtime._t.json("POST", f"/v1/sandboxes/{ID}:exec", body={})))
            else:
                outcomes.append(runtime._t.json("POST", f"/v1/sandboxes/{ID}:exec", body={}))
        except Exception as error:  # noqa: BLE001 - the outcome under test
            outcomes.append(error)
    return outcomes


class LateAnswer(unittest.TestCase):
    def test_a_late_success_is_the_answer(self):
        for outcome in call('\n\n{"exitCode": 0, "stdout": "done"}'):
            self.assertEqual(outcome["stdout"], "done")

    def test_a_late_failure_is_raised_typed(self):
        body = json.dumps({"error": {"code": "sandbox_not_found", "status": 404, "message": "Gone.",
                                     "requestId": "req_1"}})
        for outcome in call("\n" + body):
            self.assertIsInstance(outcome, NotFoundError)
            self.assertEqual(outcome.request_id, "req_1")

    def test_an_answer_with_its_own_error_field_stays_an_answer(self):
        for outcome in call(json.dumps({"status": "error", "error": {"name": "ValueError"}})):
            self.assertEqual(outcome["error"]["name"], "ValueError")


if __name__ == "__main__":
    unittest.main()
