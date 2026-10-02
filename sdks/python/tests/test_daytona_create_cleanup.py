"""Post-create retention cancellation cleans up only the newly allocated sandbox."""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dropin_fake import DropInSandbox, DropInWorld
from withruntime.daytona import AsyncDaytona, Daytona, CreateSandboxFromSnapshotParams

PARAMS = CreateSandboxFromSnapshotParams(auto_delete_interval=60 * 24 * 3)


class SyncCleanup(unittest.TestCase):
    def test_retention_failure_stops_allocated_sandbox(self):
        world = DropInWorld()
        original = ValueError("retention failure")
        with patch.object(DropInSandbox, "set_retention", side_effect=original):
            with self.assertRaises(ValueError) as caught:
                Daytona(client=world.client()).create(PARAMS)
        self.assertIs(caught.exception, original)
        self.assertEqual(len(world.called("sandbox.stop")), 1)
        self.assertEqual(next(iter(world.sandboxes.values())).state, "stopped")

    def test_cleanup_failure_preserves_retention_failure(self):
        world = DropInWorld()
        original, cleanup = ValueError("retention failure"), OSError("cleanup failure")
        with patch.object(DropInSandbox, "set_retention", side_effect=original), patch.object(DropInSandbox, "stop", side_effect=cleanup):
            with self.assertRaises(ValueError) as caught:
                Daytona(client=world.client()).create(PARAMS)
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, cleanup)


class AsyncCleanup(unittest.IsolatedAsyncioTestCase):
    async def test_real_task_cancellation_stops_new_guest_preserves_old_guest(self):
        world = DropInWorld()
        old = world.client().sandboxes.create(name="unrelated")
        entered, gate = asyncio.Event(), asyncio.Event()
        client = world.async_client()
        create = client.sandboxes.create
        async def allocate(**fields):
            sandbox = await create(**fields)
            async def retain(*args, **kwargs):
                entered.set()
                await gate.wait()
            sandbox.set_retention = retain
            return sandbox
        # Supply a controlled allocating client without modifying shared fakes.
        from types import SimpleNamespace
        client.sandboxes = SimpleNamespace(create=allocate)
        pending = asyncio.create_task(AsyncDaytona(client=client).create(PARAMS))
        await asyncio.wait_for(entered.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertEqual(old.state, "running")
        created = [box for box in world.sandboxes.values() if box.id != old.id]
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].state, "stopped")
        self.assertEqual(world.called("sandbox.stop"), [(created[0].id, False)])

    async def test_cleanup_failure_preserves_cancellation(self):
        world = DropInWorld()
        original, cleanup = asyncio.CancelledError("retention cancelled"), OSError("cleanup failure")
        with patch.object(DropInSandbox, "set_retention", side_effect=original), patch.object(DropInSandbox, "stop", side_effect=cleanup):
            with self.assertRaises(asyncio.CancelledError) as caught:
                await AsyncDaytona(client=world.async_client()).create(PARAMS)
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, cleanup)


if __name__ == "__main__":
    unittest.main()
