"""Python event names are additive, including output after reconnecting."""
import asyncio
import unittest

from withruntime._async_client import AsyncSandbox
from withruntime._sync_client import Sandbox


class Events:
    def events(self, method, path, **options):
        if method == "POST":
            yield {"type": "start", "processId": "p"}
            yield {"type": "stdout", "data": "a", "offset": 0}
            yield {"type": "continue", "processId": "p", "cursor": 1}
        else:
            yield {"type": "stdout", "data": "b", "offset": 7}
            yield {"type": "exit", "exitCode": 0, "timedOut": False, "durationMs": 12,
                   "stdoutTruncated": True, "stderrTruncated": False}


class AsyncEvents:
    async def events(self, *args, **options):
        for event in Events().events(*args, **options):
            yield event


class EventNames(unittest.TestCase):
    def check_names(self, events):
        self.assertEqual([event["type"] for event in events], ["start", "stdout", "truncated", "stdout", "exit"])
        self.assertEqual(events[0]["process_id"], events[0]["processId"])
        self.assertEqual(events[2]["dropped_bytes"], events[2]["droppedBytes"])
        self.assertEqual(events[2]["resume_at"], events[2]["resumeAt"])
        for snake, camel in (("exit_code", "exitCode"), ("timed_out", "timedOut"),
                             ("duration_ms", "durationMs"), ("stdout_truncated", "stdoutTruncated"),
                             ("stderr_truncated", "stderrTruncated")):
            self.assertEqual(events[-1][snake], events[-1][camel])
        self.assertEqual(events[-1]["exit_code"], 0)
        self.assertFalse(events[-1]["timed_out"])

    def test_sync_event_aliases_survive_reconnection_without_removing_existing_keys(self):
        self.check_names(list(Sandbox(Events(), {"id": "s", "state": "running"}).exec_stream("echo hello")))

    def test_async_event_aliases_survive_reconnection_without_removing_existing_keys(self):
        async def run():
            sandbox = AsyncSandbox(AsyncEvents(), {"id": "s", "state": "running"})
            self.check_names([event async for event in sandbox.exec_stream("echo hello")])
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
