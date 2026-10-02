"""An unsupported fork lease must never reconnect or wake its source."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2b_fake import World
from withruntime.e2b import AsyncSandbox, Sandbox, NotSupportedException


class SyncFork(unittest.TestCase):
    def test_class_fork_timeout_refuses_before_lookup_or_wake(self):
        for timeout in (0, 60):
            with self.subTest(timeout=timeout):
                world = World()
                box = Sandbox.create(client=world.client())
                native = world.sandboxes[box.sandbox_id]
                native.info["state"] = "paused"
                world.calls.clear()
                with self.assertRaises(NotSupportedException):
                    Sandbox.fork(box.sandbox_id, timeout=timeout, client=world.client())
                self.assertEqual(world.calls, [])
                self.assertEqual(native.state, "paused")

    def test_omitted_timeout_still_wakes_and_forks(self):
        world = World()
        box = Sandbox.create(client=world.client())
        world.sandboxes[box.sandbox_id].info["state"] = "paused"
        world.calls.clear()
        copies = Sandbox.fork(box.sandbox_id, client=world.client())
        self.assertEqual(len(copies), 1)
        self.assertEqual(len(world.called("sandbox.wake")), 1)
        self.assertEqual(len(world.called("sandbox.fork")), 1)

    def test_instance_timeout_refuses_without_effects(self):
        world = World()
        box = Sandbox.create(client=world.client())
        world.calls.clear()
        with self.assertRaises(NotSupportedException):
            box.fork(timeout=60)
        self.assertEqual(world.calls, [])


class AsyncFork(unittest.IsolatedAsyncioTestCase):
    async def test_class_timeout_refuses_before_lookup_or_wake(self):
        for timeout in (0, 60):
            with self.subTest(timeout=timeout):
                world = World()
                box = await AsyncSandbox.create(client=world.async_client())
                native = world.sandboxes[box.sandbox_id]
                native.info["state"] = "paused"
                world.calls.clear()
                with self.assertRaises(NotSupportedException):
                    await AsyncSandbox.fork(box.sandbox_id, timeout=timeout, client=world.async_client())
                self.assertEqual(world.calls, [])
                self.assertEqual(native.state, "paused")

    async def test_omitted_timeout_still_wakes_and_forks(self):
        world = World()
        box = await AsyncSandbox.create(client=world.async_client())
        world.sandboxes[box.sandbox_id].info["state"] = "paused"
        world.calls.clear()
        copies = await AsyncSandbox.fork(box.sandbox_id, client=world.async_client())
        self.assertEqual(len(copies), 1)
        self.assertEqual(len(world.called("sandbox.wake")), 1)
        self.assertEqual(len(world.called("sandbox.fork")), 1)

    async def test_instance_timeout_refuses_without_effects(self):
        world = World()
        box = await AsyncSandbox.create(client=world.async_client())
        world.calls.clear()
        with self.assertRaises(NotSupportedException):
            await box.fork(timeout=60)
        self.assertEqual(world.calls, [])


if __name__ == "__main__":
    unittest.main()
