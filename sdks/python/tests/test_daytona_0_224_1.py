"""What daytona 0.224.1 changed in the calls withruntime.daytona implements,
read from its published wheel and sdist on 15 October 2026 (DAYTONA.md):
the create params take their own target (region), over the client's. Runtime
runs in one US region, so "us" (or none) creates the sandbox and any other
region is refused before anything is made, as the client's target already
was. Its docs now resolve a snapshot's region_id per call too, and the drop-in
refuses region_id as the TypeScript one does, instead of dropping it. The
rest of the release is documentation and Daytona's own output decoding. Sync
and async."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dropin_fake import DropInWorld  # noqa: E402

from withruntime.daytona import (AsyncDaytona, CreateSandboxFromImageParams,  # noqa: E402
                                 CreateSandboxFromSnapshotParams, CreateSnapshotParams, Daytona,
                                 DaytonaConfig, NotSupportedError)


class CreateTarget(unittest.TestCase):
    def setUp(self) -> None:
        self.world = DropInWorld()
        self.daytona = Daytona(client=self.world.client())

    def test_us_or_empty_creates_the_sandbox(self):
        sandbox = self.daytona.create(CreateSandboxFromSnapshotParams(target="us"))
        self.assertEqual(sandbox.target, "us")
        self.daytona.create(CreateSandboxFromImageParams(image="python:3.12", target=""))
        self.assertEqual(len(self.world.called("sandboxes.create")), 2)

    def test_another_region_is_refused_before_anything_is_made(self):
        with self.assertRaises(NotSupportedError) as raised:
            self.daytona.create(CreateSandboxFromSnapshotParams(target="eu"))
        self.assertIn('The Daytona target "eu"', str(raised.exception))
        self.assertIn('use "us"', str(raised.exception))
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_a_create_target_overrides_the_clients(self):
        pinned = Daytona(DaytonaConfig(target="us"), client=self.world.client())
        with self.assertRaises(NotSupportedError):
            pinned.create(CreateSandboxFromImageParams(image="python:3.12", target="eu"))
        self.assertEqual(self.world.called("images.build"), [])
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_a_snapshot_region_is_refused_not_dropped(self):
        with self.assertRaises(NotSupportedError) as raised:
            self.daytona.snapshot.create(CreateSnapshotParams(name="placed", image="python:3.12", region_id="eu"))
        self.assertIn("region_id", str(raised.exception))
        self.assertEqual(self.world.called("images.build"), [])
        self.daytona.snapshot.create(CreateSnapshotParams(name="default", image="python:3.12", region_id=""))
        self.assertEqual(len(self.world.called("images.build")), 1)

    def test_async(self):
        world = DropInWorld()

        async def scenario() -> None:
            daytona = AsyncDaytona(client=world.async_client())
            sandbox = await daytona.create(CreateSandboxFromSnapshotParams(target="us"))
            self.assertEqual(sandbox.target, "us")
            with self.assertRaises(NotSupportedError):
                await daytona.create(CreateSandboxFromSnapshotParams(target="eu"))
            with self.assertRaises(NotSupportedError):
                await daytona.snapshot.create(CreateSnapshotParams(name="placed", image="python:3.12",
                                                                   region_id="eu"))
            self.assertEqual(len(world.called("sandboxes.create")), 1)
            self.assertEqual(world.called("images.build"), [])

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
