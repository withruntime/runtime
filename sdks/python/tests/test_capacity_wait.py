"""A create that finds every trial slot, the account's quota or the region full
waits for room and sends the same call again, instead of failing a CI job that
burst past its limit (judge panel, 23 September 2026). Sync and async share
the transport's code, so both are driven here over a fake wire."""
import asyncio
import json
import time
import unittest

from withruntime import AsyncRuntime, ConflictError, Runtime

RUNNING = json.dumps({"id": "sbx", "kind": "sandbox", "state": "running", "status": "active"}).encode()


def refusal(code, status=409, details=None):
    error = {"code": code, "status": status, "message": "full", "retryAfterMs": 5}
    if details is not None:
        error["details"] = details
    return status, json.dumps({"error": error}).encode()


class Wire:
    """Answers each call with the next refusal, then with a running sandbox."""

    def __init__(self, refusals, is_async):
        self.refusals, self.is_async = list(refusals), is_async
        self.keys, self.bodies, self.targets = [], [], []

    def _answer(self, method, target, headers, data):
        self.keys.append(headers.get("Idempotency-Key"))
        self.bodies.append(data)
        self.targets.append(target)
        status, body = self.refusals.pop(0) if self.refusals else (200, RUNNING)
        is_async = self.is_async

        class Answer:
            def __init__(self):
                self.status, self.headers = status, {}

            if is_async:
                async def read(self):
                    return body
            else:
                def read(self):
                    return body
        return Answer()

    def send(self, method, target, headers, data, timeout):
        if self.is_async:
            async def later():
                return self._answer(method, target, headers, data)
            return later()
        return self._answer(method, target, headers, data)


def create(refusals, client_options=None, **create_options):
    """Runs one create, sync and async, and returns each run's wire and outcome."""
    runs = []
    for is_async in (False, True):
        wire = Wire(refusals, is_async)
        options = {"api_key": "rk", "base_url": "https://api.example.test", **(client_options or {})}
        runtime = AsyncRuntime(**options) if is_async else Runtime(**options)
        runtime._t._http = wire
        started = time.monotonic()
        try:
            if is_async:
                outcome = asyncio.run(runtime.sandboxes.create(**create_options))
            else:
                outcome = runtime.sandboxes.create(**create_options)
        except Exception as error:  # noqa: BLE001 - the outcome under test
            outcome = error
        runs.append((wire, outcome, time.monotonic() - started))
    return runs


class CapacityWait(unittest.TestCase):
    def test_a_full_trial_is_waited_out_with_the_same_key_and_input(self):
        busy = refusal("no_credit_running_limit", details={"sandboxIds": ["a"], "concurrent": 8})
        for wire, outcome, _ in create([busy, busy], funding="trial", labels={"ci": "1"}):
            self.assertEqual(outcome.id, "sbx")
            self.assertEqual(len(wire.keys), 3)
            self.assertEqual(len(set(wire.keys)), 1)
            self.assertIsNotNone(wire.keys[0])
            self.assertEqual(len(set(wire.bodies)), 1)
            self.assertEqual(json.loads(wire.bodies[0]), {"funding": "trial", "labels": {"ci": "1"}})

    def test_a_create_says_why_it_waits_before_each_wait(self):
        heard = []
        busy = refusal("no_credit_running_limit")
        for _, outcome, _ in create([busy, busy], on_capacity_wait=lambda error, seconds: heard.append(
                (error.code, seconds))):
            self.assertEqual(outcome.id, "sbx")
        # Sync, then async: two waits each, of retryAfterMs.
        self.assertEqual(heard, [("no_credit_running_limit", 0.005)] * 4)

    def test_the_paid_limit_a_domain_limit_and_a_full_region_are_waited_out_too(self):
        for code in ("quota_exceeded", "no_credit_domain_limit", "no_capacity"):
            for wire, outcome, _ in create([refusal(code)]):
                self.assertEqual(outcome.id, "sbx", code)
                self.assertEqual(len(wire.keys), 2)
        # no_credit_capacity_full is a 503: waited for as room, not spent from max_retries.
        for wire, outcome, _ in create([refusal("no_credit_capacity_full", 503)] * 6, {"max_retries": 1}):
            self.assertEqual(outcome.id, "sbx")
            self.assertEqual(len(wire.keys), 7)

    def test_when_the_wait_runs_out_the_original_refusal_is_raised(self):
        for wire, outcome, took in create([refusal("no_credit_running_limit")] * 1000, {"wait_for_capacity": 0.2}):
            self.assertIsInstance(outcome, ConflictError)
            self.assertEqual(outcome.code, "no_credit_running_limit")
            self.assertGreater(len(wire.keys), 2)
            self.assertGreaterEqual(took, 0.19)
            self.assertLess(took, 1.5)

    def test_zero_fails_at_once_on_the_client_or_on_one_call(self):
        for wire, outcome, _ in create([refusal("no_credit_running_limit")], {"wait_for_capacity": 0}):
            self.assertEqual(getattr(outcome, "code", None), "no_credit_running_limit")
            self.assertEqual(len(wire.keys), 1)
        for wire, outcome, _ in create([refusal("quota_exceeded")], wait_for_capacity=0):
            self.assertEqual(getattr(outcome, "code", None), "quota_exceeded")
            self.assertEqual(len(wire.keys), 1)

    def test_a_request_that_can_never_fit_is_not_waited_for(self):
        never = refusal("no_credit_running_limit", details={"field": "count", "concurrent": 8})
        for wire, outcome, _ in create([never]):
            self.assertEqual(getattr(outcome, "code", None), "no_credit_running_limit")
            self.assertEqual(len(wire.keys), 1)

    def test_only_a_create_waits(self):
        # A fork's failure names copies that started, and its key replays that
        # failure, so a fork is never retried by waiting.
        wire = Wire([refusal("no_credit_running_limit")], False)
        runtime = Runtime(api_key="rk", base_url="https://api.example.test")
        runtime._t._http = wire
        from withruntime._sync_client import Sandbox
        sandbox = Sandbox(runtime._t, {"id": "sbx", "state": "running"})
        with self.assertRaises(ConflictError):
            sandbox.fork()
        self.assertEqual(len(wire.keys), 1)


if __name__ == "__main__":
    unittest.main()
