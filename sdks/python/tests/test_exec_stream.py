"""A streamed exec that loses output or its connection (user lane, 25 September
2026): lost output never passes as whole, and a connection cut after the command
started does not end the command's output. Sync and async share the code, so
both are driven here over a fake wire."""
import asyncio
import json
import unittest

from withruntime import AsyncRuntime, ConnectionError, Runtime

ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"
INFO = json.dumps({"id": ID, "kind": "sandbox", "state": "running", "status": "active"}).encode()


class Wire:
    """Answers each path with scripted NDJSON lines, then an end or a failure."""

    def __init__(self, routes, is_async):
        self.routes, self.is_async, self.targets = routes, is_async, []

    def send(self, method, target, headers, data, timeout):
        self.targets.append(f"{method} {target}")
        lines, fail = next(((lines, fail) for suffix, (lines, fail) in self.routes.items()
                            if target.split("?")[0].endswith(suffix)), ([], False))
        body = [json.dumps(line) for line in lines]
        is_async = self.is_async

        class Answer:
            status, headers = 200, {}

            if is_async:
                async def read(self):
                    return INFO

                async def lines(self):
                    for line in body:
                        yield line
                    if fail:
                        raise OSError("connection reset")

                async def close(self):
                    return None
            else:
                def read(self):
                    return INFO

                def lines(self):
                    yield from body
                    if fail:
                        raise OSError("connection reset")

                def close(self):
                    return None
        answer = Answer()
        if self.is_async:
            async def later():
                return answer
            return later()
        return answer


def run_exec(routes):
    """One streamed exec, sync and async: each run's wire and outcome."""
    runs = []
    for is_async in (False, True):
        wire = Wire(routes, is_async)
        runtime = (AsyncRuntime if is_async else Runtime)(api_key="rk", base_url="https://api.example.test")
        runtime._t._http = wire

        def call():
            if is_async:
                async def go():
                    sbx = await runtime.sandboxes.get(ID)
                    return await sbx.exec("x", on_stdout=lambda _: None)
                return asyncio.run(go())
            return runtime.sandboxes.get(ID).exec("x", on_stdout=lambda _: None)
        try:
            outcome = call()
        except Exception as error:  # noqa: BLE001 - the outcome under test
            outcome = error
        runs.append((wire, outcome))
    return runs


EXIT = {"type": "exit", "exitCode": 0, "state": "exited", "timedOut": False}


class ExecStream(unittest.TestCase):
    def test_output_the_stream_skipped_is_reported_lost_even_unnamed(self):
        routes = {":exec": ([{"type": "start", "processId": "p1"}, {"type": "stdout", "data": "a\n", "offset": 0},
                             {"type": "stdout", "data": "b\n", "offset": 10}, EXIT], False)}
        for _, result in run_exec(routes):
            self.assertEqual(result.exit_code, 0)
            self.assertEqual(result.stdout, "a\nb\n")
            self.assertTrue(result.stdout_truncated)

    def test_a_cut_after_the_start_is_followed_from_where_it_stopped(self):
        routes = {":exec": ([{"type": "start", "processId": "p1"}, {"type": "stdout", "data": "a\n", "offset": 0}], True),
                  "/processes/p1/output": ([{"type": "stdout", "data": "b\n", "offset": 2}, EXIT], False)}
        for wire, result in run_exec(routes):
            self.assertEqual(result.stdout, "a\nb\n")
            self.assertFalse(result.stdout_truncated)
            self.assertIn(f"GET /v1/sandboxes/{ID}/processes/p1/output?cursor=2&follow=true", wire.targets)

    def test_a_stream_that_keeps_closing_is_given_up_naming_the_process(self):
        routes = {":exec": ([{"type": "start", "processId": "p1"}], False), "/processes/p1/output": ([], False)}
        for wire, error in run_exec(routes):
            self.assertIsInstance(error, ConnectionError)
            self.assertEqual(error.details, {"sandboxId": ID, "processId": "p1"})
            self.assertEqual(sum("/output" in t for t in wire.targets), 4)


class Spell(Wire):
    """The output route answers a spell of passing failures first: a 503 busy,
    a 429, an error event from a host restarting and a dropped connection."""

    def __init__(self, routes, is_async):
        super().__init__(routes, is_async)
        self.spell = [("status", 503, "busy"), ("status", 429, "rate_limited"), ("event", 503, "host_unavailable"),
                      ("cut", 0, ""), ("status", 503, "host_unavailable")]

    def send(self, method, target, headers, data, timeout):
        if not target.split("?")[0].endswith("/processes/p1/output") or not self.spell:
            return super().send(method, target, headers, data, timeout)
        self.targets.append(f"{method} {target}")
        kind, status, code = self.spell.pop(0)
        if kind == "event":
            lines = [{"type": "error", "error": {"code": code, "status": status, "message": "m"}}]
        else:
            lines = []
        body = json.dumps({"error": {"code": code, "status": status, "message": "m", "retryAfterMs": 1}}).encode()
        answer_status = status if kind == "status" else 200
        fail = kind == "cut"
        is_async = self.is_async
        encoded = [json.dumps(line) for line in lines]

        class Answer:
            def __init__(self):
                self.status, self.headers = answer_status, {}

            if is_async:
                async def read(self, limit=None):
                    return body

                async def lines(self):
                    for line in encoded:
                        yield line
                    if fail:
                        raise OSError("connection reset")

                async def close(self):
                    return None
            else:
                def read(self, limit=None):
                    return body

                def lines(self):
                    yield from encoded
                    if fail:
                        raise OSError("connection reset")

                def close(self):
                    return None
        answer = Answer()
        if self.is_async:
            async def later():
                return answer
            return later()
        return answer


class Outage(unittest.TestCase):
    """A thousand agents each follow a long command, reconnecting every 110 s.
    A reconnect that meets a busy API, a 429, a host restarting or a dropped
    connection keeps following: the command is still running. Four such in a
    row used to end the exec with "keeps closing" and fail the agent's task."""

    def test_a_long_command_outlives_a_spell_of_refusals_and_cuts(self):
        routes = {":exec": ([{"type": "start", "processId": "p1"}, {"type": "stdout", "data": "a\n", "offset": 0},
                             {"type": "continue", "processId": "p1", "cursor": 2}], False),
                  "/processes/p1/output": ([{"type": "stdout", "data": "b\n", "offset": 2}, EXIT], False)}
        for is_async in (False, True):
            wire = Spell(routes, is_async)
            runtime = (AsyncRuntime if is_async else Runtime)(api_key="rk", base_url="https://api.example.test",
                                                               max_retries=0)
            runtime._t._http = wire
            if is_async:
                async def go():
                    sbx = await runtime.sandboxes.get(ID)
                    return await sbx.exec("x", on_stdout=lambda _: None)
                result = asyncio.run(go())
            else:
                result = runtime.sandboxes.get(ID).exec("x", on_stdout=lambda _: None)
            self.assertEqual(result.exit_code, 0)
            self.assertEqual(result.stdout, "a\nb\n")
            self.assertEqual(sum("/output" in t for t in wire.targets), 6)

    def test_a_deliberate_refusal_still_ends_the_follow_at_once(self):
        routes = {":exec": ([{"type": "start", "processId": "p1"}], True)}
        for is_async in (False, True):
            wire = Spell(routes, is_async)
            wire.spell = [("status", 503, "unavailable")]
            runtime = (AsyncRuntime if is_async else Runtime)(api_key="rk", base_url="https://api.example.test",
                                                               max_retries=0)
            runtime._t._http = wire
            with self.assertRaises(Exception) as caught:
                if is_async:
                    async def go():
                        sbx = await runtime.sandboxes.get(ID)
                        return await sbx.exec("x", on_stdout=lambda _: None)
                    asyncio.run(go())
                else:
                    runtime.sandboxes.get(ID).exec("x", on_stdout=lambda _: None)
            self.assertEqual(getattr(caught.exception, "code", None), "unavailable")
            self.assertEqual(sum("/output" in t for t in wire.targets), 1)


if __name__ == "__main__":
    unittest.main()


class CreateFields(unittest.TestCase):
    """A misspelled create field is refused before anything is sent, naming the
    one meant (user lane: memory_mb= reached the API as "memoryMb is not a
    known field")."""

    def test_a_misspelled_field_names_the_one_meant(self):
        runtime = Runtime(api_key="rk", base_url="https://api.example.test")
        runtime._t._http = None  # nothing may be sent
        with self.assertRaises(TypeError) as caught:
            runtime.sandboxes.create(memory_mb=8192)
        self.assertIn("Did you mean 'memory_mib'?", str(caught.exception))

    def test_snake_and_camel_names_both_pass(self):
        from withruntime._sync_client import _check_create_fields
        _check_create_fields({"memory_mib": 1, "memoryMiB": 1, "snapshot_id": "s", "get_or_create": True})
