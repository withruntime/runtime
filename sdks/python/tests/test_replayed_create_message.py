"""A create replayed under its key, whose sandbox has since stopped, says so
rather than that it failed to start (10 October 2026)."""
import asyncio
import unittest

from withruntime._async_client import AsyncSandboxes
from withruntime._sync_client import Sandboxes


class Transport:
    wait_for_capacity = 0

    def __init__(self, replayed):
        self.replayed, self.calls = replayed, 0

    def json(self, method, path, **kwargs):
        self.calls += 1
        if method == "POST":
            return {"id": "fixture", "state": "starting", **({"replayed": True} if self.replayed else {})}
        return {"id": "fixture", "state": "stopped"}


class AsyncTransport(Transport):
    async def json(self, *args, **kwargs):
        return Transport.json(self, *args, **kwargs)


class ReplayedCreate(unittest.TestCase):
    def check(self, error, replayed):
        self.assertEqual(error.code, "start_failed")
        if replayed:
            self.assertIn("earlier call with this idempotency key", str(error))
            self.assertIn("is stopped now", str(error))
            self.assertIn("did not fail to start", str(error))
        else:
            self.assertIn("Sandbox fixture is stopped, not running.", str(error))
            self.assertNotIn("earlier call", str(error))

    def test_sync(self):
        for replayed in (True, False):
            with self.assertRaises(Exception) as caught:
                Sandboxes(Transport(replayed)).create(idempotency_key="k")
            self.check(caught.exception, replayed)

    def test_async(self):
        for replayed in (True, False):
            async def run():
                await AsyncSandboxes(AsyncTransport(replayed)).create(idempotency_key="k")
            with self.assertRaises(Exception) as caught:
                asyncio.run(run())
            self.check(caught.exception, replayed)


if __name__ == "__main__":
    unittest.main()
