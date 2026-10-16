"""What e2b 2.55.1 changed in the calls withruntime.e2b implements, read from
its published sdist and wheel on 9 October 2026 (packages/cloud-sdk/E2B.md,
"e2b 2.55.0"): pause, create_snapshot and on_timeout take
``mode="full" | "filesystem"``, keep_memory is deprecated, and SnapshotMode and
DockerfileSyntaxError are exported."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2b_fake import World  # noqa: E402

import withruntime.e2b as e2b  # noqa: E402
import withruntime.e2b.code_interpreter as code_interpreter  # noqa: E402
from withruntime.e2b import AsyncSandbox, InvalidArgumentException, NotSupportedException, Sandbox  # noqa: E402


class SnapshotMode(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World()

    def create(self, **kwargs):
        return Sandbox.create(client=self.world.client(), **kwargs)

    def modes(self):
        return [call[2] for call in self.world.called("sandbox.snapshot")]

    def test_create_snapshot_filesystem_is_a_disk_snapshot_and_full_the_whole_machine(self):
        sbx = self.create()
        sbx.create_snapshot("files", mode="filesystem")
        sbx.create_snapshot(mode="full")
        Sandbox.create_snapshot(sbx.sandbox_id, mode="filesystem", client=self.world.client())
        sbx.create_snapshot()
        self.assertEqual(self.modes(), ["disk", "memory", "disk", None])
        self.assertEqual(self.world.called("sandbox.snapshot")[0][1], "files")

    def test_an_unknown_mode_is_invalid_before_anything_is_taken(self):
        sbx = self.create()
        with self.assertRaises(InvalidArgumentException) as caught:
            sbx.create_snapshot(mode="memory")
        self.assertEqual(str(caught.exception), "mode must be one of: full, filesystem (got 'memory').")
        self.assertEqual(self.world.called("sandbox.snapshot"), [])

    def test_a_files_only_pause_is_refused_naming_the_files_only_snapshot(self):
        sbx = self.create()
        for kwargs in ({"mode": "filesystem"}, {"keep_memory": False}):
            with self.assertRaises(NotSupportedException) as caught:
                sbx.pause(**kwargs)
            self.assertIn("create_snapshot(mode='filesystem')", str(caught.exception))
            with self.assertRaises(NotSupportedException):
                sbx.beta_pause(**kwargs)
            with self.assertRaises(NotSupportedException):
                Sandbox.pause(sbx.sandbox_id, client=self.world.client(), **kwargs)
        self.assertEqual(self.world.called("sandbox.pause"), [])

    def test_full_pauses_and_mode_beside_keep_memory_is_invalid(self):
        sbx = self.create()
        with self.assertRaises(InvalidArgumentException) as caught:
            sbx.pause(True, mode="full")
        self.assertEqual(str(caught.exception), "Pass either mode or the deprecated keep_memory, not both.")
        with self.assertRaises(InvalidArgumentException):
            sbx.pause(mode="warm")
        self.assertEqual(self.world.called("sandbox.pause"), [])
        self.assertTrue(sbx.pause(mode="full"))
        self.assertEqual(len(self.world.called("sandbox.pause")), 1)

    def test_on_timeout_mode(self):
        with self.assertRaises(NotSupportedException):
            self.create(lifecycle={"on_timeout": {"action": "pause", "mode": "filesystem"}})
        with self.assertRaises(InvalidArgumentException) as caught:
            self.create(lifecycle={"on_timeout": {"action": "kill", "mode": "full"}})
        self.assertEqual(str(caught.exception), "mode is only allowed when on_timeout action is 'pause'.")
        self.assertEqual(self.world.called("sandboxes.create"), [])
        self.create(lifecycle={"on_timeout": {"action": "pause", "mode": "full"}})
        self.assertEqual(self.world.called("sandboxes.create")[-1][0]["on_lease_end"], "pause")

    def test_async_follows_the_same_modes(self):
        world = World()

        async def scenario():
            sbx = await AsyncSandbox.create(client=world.async_client())
            await sbx.create_snapshot(mode="filesystem")
            with self.assertRaises(NotSupportedException):
                await sbx.pause(mode="filesystem")
            with self.assertRaises(InvalidArgumentException):
                await sbx.pause(False, mode="full")
            self.assertTrue(await sbx.pause(mode="full"))
        asyncio.run(scenario())
        self.assertEqual([call[2] for call in world.called("sandbox.snapshot")], ["disk"])
        self.assertEqual(len(world.called("sandbox.pause")), 1)


class Exports(unittest.TestCase):
    def test_dockerfile_syntax_error_is_e2bs(self):
        from withruntime.e2b.template.dockerfile_parser import DockerfileSyntaxError
        self.assertIs(DockerfileSyntaxError, e2b.DockerfileSyntaxError)
        self.assertIs(code_interpreter.DockerfileSyntaxError, DockerfileSyntaxError)
        error = DockerfileSyntaxError("bad substitution", 3)
        self.assertIsInstance(error, ValueError)
        self.assertNotIsInstance(error, e2b.SandboxException)
        self.assertEqual((error.line, str(error)), (3, "Dockerfile parse error on line 3: bad substitution"))
        self.assertEqual(str(DockerfileSyntaxError("x")), "Dockerfile parse error: x")

    def test_snapshot_mode_names_e2bs_two_modes(self):
        from withruntime.e2b.sandbox.sandbox_api import SnapshotMode as from_module
        self.assertIs(from_module, e2b.SnapshotMode)
        self.assertEqual(e2b.SnapshotMode.__args__, ("full", "filesystem"))


if __name__ == "__main__":
    unittest.main()
