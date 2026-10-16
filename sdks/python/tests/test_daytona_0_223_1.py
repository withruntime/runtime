"""What daytona 0.223.1 changed in the calls withruntime.daytona implements,
read from its published wheel and sdist on 9 October 2026 (DAYTONA.md):
sandbox.set_public(public) makes the sandbox's preview URLs public or private,
those already shared included. The rest of the release is documentation.
Sync and async."""
import asyncio
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dropin_fake import DropInWorld  # noqa: E402

from withruntime.daytona import AsyncDaytona, CreateSandboxFromSnapshotParams, Daytona, DaytonaError  # noqa: E402


def shared(world: Any, sandbox_id: str, ports: List[Dict[str, Any]]) -> None:
    """The ports Runtime already shares for the sandbox, as previews.list answers."""
    def listed() -> List[Dict[str, Any]]:
        world.record("previews.list")
        return ports
    world.sandboxes[sandbox_id].previews.list = listed


class SetPublic(unittest.TestCase):
    def setUp(self) -> None:
        self.world = DropInWorld()
        self.daytona = Daytona(client=self.world.client())

    def test_public_changes_private_shared_ports_and_later_links(self):
        sandbox = self.daytona.create(CreateSandboxFromSnapshotParams())
        shared(self.world, sandbox.id, [{"port": 3000, "visibility": "private"},
                                        {"port": 8080, "visibility": "public"}])
        self.assertFalse(sandbox.public)
        sandbox.set_public(True)
        # Only the port that was private changes; the public one is left alone.
        self.assertEqual(self.world.called("previews.create"), [(3000, {"visibility": "public"})])
        self.assertTrue(sandbox.public)
        sandbox.get_preview_link(5000)
        self.assertEqual(self.world.called("previews.create")[-1], (5000, {"visibility": "public"}))

    def test_private_again(self):
        sandbox = self.daytona.create(CreateSandboxFromSnapshotParams(public=True))
        shared(self.world, sandbox.id, [{"port": 3000, "visibility": "public"},
                                        {"port": 4000, "visibility": "public"}])
        sandbox.set_public(False, request_timeout=5)
        self.assertEqual(self.world.called("previews.create"),
                         [(3000, {"visibility": "private"}), (4000, {"visibility": "private"})])
        self.assertFalse(sandbox.public)
        sandbox.get_preview_link(3000)
        self.assertEqual(self.world.called("previews.create")[-1], (3000, {"visibility": "private"}))

    def test_a_refused_public_share_leaves_it_private(self):
        sandbox = self.daytona.create(CreateSandboxFromSnapshotParams())
        shared(self.world, sandbox.id, [{"port": 3000, "visibility": "private"}])
        self.world.refuse_public = True
        with self.assertRaises(DaytonaError) as raised:
            sandbox.set_public(True)
        self.assertEqual(getattr(raised.exception.__cause__, "code", None), "public_preview_not_allowed")
        self.assertFalse(sandbox.public)

    def test_async(self):
        world = DropInWorld()

        async def scenario() -> None:
            daytona = AsyncDaytona(client=world.async_client())
            sandbox = await daytona.create(CreateSandboxFromSnapshotParams())
            shared(world, sandbox.id, [{"port": 3000, "visibility": "private"}])
            await sandbox.set_public(True)
            self.assertEqual(world.called("previews.create"), [(3000, {"visibility": "public"})])
            self.assertTrue(sandbox.public)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
