"""What modal 1.6.1 and 1.6.2 changed in the sandbox surface the drop-in serves:
Sandbox.from_name(include_terminated=True) returns the sandbox of that name that
stopped last when none runs, and modal.sandbox became a package
(modal.sandbox.sandbox holds SandboxFilesystem and SandboxSnapshot). Before,
include_terminated was a TypeError and withruntime.modal.sandbox did not import."""
import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from test_modal_dropin import World  # noqa: E402
import withruntime.modal as modal  # noqa: E402
from withruntime.modal import App, Sandbox  # noqa: E402
from withruntime.modal.exception import NotFoundError  # noqa: E402


class IncludeTerminated(World):
    def stopped(self, name, ended):
        box = Sandbox.create(app=App("jobs"), name=name, client=self.client)
        box.terminate()
        self.world.sandboxes[box.object_id].info["endedAt"] = ended
        return box.object_id

    def test_the_last_stopped_sandbox_of_the_name(self):
        self.stopped("job", "2026-10-16T01:00:00.000Z")
        last = self.stopped("job", "2026-10-16T03:00:00.000Z")
        self.stopped("job", "2026-10-16T02:00:00.000Z")
        self.stopped("other", "2026-10-16T05:00:00.000Z")
        with self.assertRaises(NotFoundError):
            Sandbox.from_name("jobs", "job", client=self.client)
        self.assertEqual(Sandbox.from_name("jobs", "job", include_terminated=True, client=self.client).object_id,
                         last)
        with self.assertRaises(NotFoundError):
            Sandbox.from_name("jobs", "none", include_terminated=True, client=self.client)

        async def run():
            found = await Sandbox.from_name.aio("jobs", "job", include_terminated=True,
                                                client=self.world.async_client())
            self.assertEqual(found.object_id, last)
        asyncio.run(run())

    def test_a_running_sandbox_still_wins(self):
        self.stopped("job", "2026-10-16T09:00:00.000Z")
        running = Sandbox.create(app=App("jobs"), name="job", client=self.client)
        self.assertEqual(Sandbox.from_name("jobs", "job", include_terminated=True, client=self.client).object_id,
                         running.object_id)


class Modules(unittest.TestCase):
    def test_the_import_paths_of_1_6_2_load(self):
        from withruntime.modal.sandbox import Probe, Sandbox as FromPackage
        from withruntime.modal.sandbox.sandbox import Sandbox as FromModule, SandboxFilesystem, SandboxSnapshot
        from withruntime.modal.sandbox_fs import SandboxFilesystem as Old
        self.assertIs(FromPackage, modal.Sandbox)
        self.assertIs(FromModule, modal.Sandbox)
        self.assertIs(Probe, modal.Probe)
        self.assertIs(SandboxSnapshot, modal.SandboxSnapshot)
        self.assertIs(SandboxFilesystem, Old)
        self.assertEqual(modal.UPSTREAM_VERSION, "1.6.2")


if __name__ == "__main__":
    unittest.main()
