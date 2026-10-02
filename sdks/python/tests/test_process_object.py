"""A spawned process says what it is.

spawn() printed as ``<withruntime._sync_client.Process object at 0x…>`` and
had no state or exit code to read (live product, 2 October 2026).
"""
import asyncio
import unittest

from withruntime._async_client import AsyncProcess
from withruntime._sync_client import Process

INFO = {"id": "p1", "kind": "process", "state": "running", "exitCode": None,
        "command": "/usr/bin/env bash -c python3 server.py", "stdinOffset": 0}
SANDBOX = "11111111-2222-4333-8444-555555555555"
EVENTS = [{"type": "start", "processId": "p1"}, {"type": "stdout", "data": "hi\n", "offset": 0},
          {"type": "exit", "exitCode": 3, "state": "exited", "timedOut": False}]


class ProcessObject(unittest.TestCase):
    def test_sync_process_shows_id_command_state_and_exit_code(self):
        proc = Process(None, SANDBOX, dict(INFO))
        self.assertEqual((proc.id, proc.command, proc.state, proc.exit_code),
                         ("p1", INFO["command"], "running", None))
        self.assertEqual(repr(proc), "Process(id='p1', sandbox_id='11111111-2222-4333-8444-555555555555', "
                                     "command='/usr/bin/env bash -c python3 server.py', state='running', "
                                     "exit_code=None)")

    def test_sync_wait_updates_state_and_exit_code(self):
        proc = Process(None, SANDBOX, dict(INFO))
        proc.output = lambda *a, **k: iter(EVENTS)
        self.assertEqual(proc.wait().exit_code, 3)
        self.assertEqual((proc.state, proc.exit_code), ("exited", 3))
        self.assertIn("state='exited', exit_code=3", repr(proc))

    def test_async_process_matches(self):
        proc = AsyncProcess(None, SANDBOX, dict(INFO))
        self.assertTrue(repr(proc).startswith("AsyncProcess(id='p1', "))

        async def events(*_a, **_k):
            for event in EVENTS:
                yield event

        proc.output = events
        self.assertEqual(asyncio.run(proc.wait()).exit_code, 3)
        self.assertEqual((proc.state, proc.exit_code), ("exited", 3))


if __name__ == "__main__":
    unittest.main()
