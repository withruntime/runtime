"""The report of an image's start command is the create's alone: the API
keeps no record of it, so a later read of the same sandbox keeps it
(28 September 2026, when a refresh dropped it)."""
import asyncio
import unittest
from withruntime._async_client import AsyncSandbox
from withruntime._sync_client import Sandbox

START = {"state": "ready", "processId": "p1", "readyMs": 420}


class Transport:
    def json(self, method, path, **kwargs):
        return {"id": "s", "state": "stopped" if path.endswith(":stop") else "running"}


class AsyncTransport:
    async def json(self, method, path, **kwargs):
        return {"id": "s", "state": "running"}


class StartReportKept(unittest.TestCase):
    def test_a_refresh_and_a_lifecycle_answer_keep_it(self):
        sbx = Sandbox(Transport(), {"id": "s", "state": "running", "start": START})
        sbx.refresh()
        self.assertEqual(sbx.info["start"], START)
        sbx.stop()
        self.assertEqual(sbx.state, "stopped")
        self.assertEqual(sbx.info["start"], START)

    def test_a_sandbox_read_without_one_has_none(self):
        sbx = Sandbox(Transport(), {"id": "s", "state": "running"})
        sbx.refresh()
        self.assertNotIn("start", sbx.info)

    def test_async_keeps_it_too(self):
        sbx = AsyncSandbox(AsyncTransport(), {"id": "s", "state": "running", "start": START})
        asyncio.run(sbx.refresh())
        self.assertEqual(sbx.info["start"], START)


if __name__ == "__main__":
    unittest.main()
