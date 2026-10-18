"""exec, exec_stream, spawn and terminal take user="root", sent only when given."""
import asyncio
import unittest

from withruntime._async_client import AsyncSandbox
from withruntime._sync_client import Sandbox

ID = "11111111-2222-4333-8444-555555555555"
RESULT = {"exitCode": 0, "stdout": "", "stderr": "", "state": "exited", "timedOut": False}


class Recorder:
    """Stands in for the transport: keeps each body and query it was given."""

    def __init__(self, is_async):
        self.is_async, self.bodies, self.queries = is_async, [], []

    def json(self, method, path, body=None, **_k):
        self.bodies.append(body)
        data = {"id": "p1", "state": "running"} if path.endswith("/processes") else RESULT
        if self.is_async:
            async def later():
                return data
            return later()
        return data

    def events(self, method, path, body=None, **_k):
        self.bodies.append(body)
        events = [{"type": "start", "processId": "p1"}, {"type": "exit", "exitCode": 0, "state": "exited"}]
        if self.is_async:
            async def gen():
                for event in events:
                    yield event
            return gen()
        return (event for event in events)

    def websocket(self, path, query):
        self.queries.append(query)
        raise OSError("stop")


def drive(is_async, call):
    recorder = Recorder(is_async)
    sandbox = (AsyncSandbox if is_async else Sandbox)(recorder, {"id": ID})

    def run(name, *args, **kwargs):
        result = getattr(sandbox, name)(*args, **kwargs)
        if name == "exec_stream":
            if is_async:
                async def drain():
                    return [e async for e in result]
                return asyncio.run(drain())
            return list(result)
        return asyncio.run(result) if is_async else result

    call(run)
    return recorder


class ExecUser(unittest.TestCase):
    def test_user_is_sent_only_when_given(self):
        for is_async in (False, True):
            def call(run):
                run("exec", "id", user="root")
                run("exec", "id")
                run("exec_stream", "id", user="root")
                run("exec_stream", "id")
                run("spawn", "sleep 1", user="root")
                run("spawn", "sleep 1")
            bodies = drive(is_async, call).bodies
            self.assertEqual([b.get("user") for b in bodies], ["root", None] * 3)
            self.assertTrue(all("user" not in b for b in bodies[1::2]))

    def test_terminal_sends_user_only_when_given(self):
        for is_async in (False, True):
            def call(run):
                for kwargs in ({"user": "root"}, {}):
                    try:
                        run("terminal", **kwargs)
                    except OSError:
                        pass
            queries = drive(is_async, call).queries
            self.assertEqual([q.get("user") for q in queries], ["root", None])

    def test_process_reports_its_user(self):
        from withruntime._sync_client import Process
        self.assertEqual(Process(None, ID, {"id": "p1", "user": "root"}).user, "root")
        self.assertIsNone(Process(None, ID, {"id": "p1"}).user)


if __name__ == "__main__":
    unittest.main()
