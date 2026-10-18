"""What daytona 0.225.0 changed in the calls withruntime.daytona implements,
read from its published wheel and sdist, and the npm API clients, on
18 October 2026 (DAYTONA.md): no Python source changed; the API client's
GpuType gains B200. daytona exports GpuType, SandboxClass and the list sort
enums, which the drop-in did not, so code importing them failed to load. A
create asking for a GPU type, without a GPU count, now refuses as one with a
count already did, instead of making a CPU sandbox. Sync and async."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dropin_fake import DropInWorld  # noqa: E402

from withruntime.daytona import (AsyncDaytona, CreateSandboxFromImageParams,  # noqa: E402
                                 CreateSandboxFromSnapshotParams, Daytona, GpuType, ListSandboxesQuery,
                                 NotSupportedError, Resources, SandboxClass, SandboxListSortDirection,
                                 SandboxListSortField)


class Enums(unittest.TestCase):
    def test_upstreams_values(self):
        self.assertEqual(GpuType.B200.value, "B200")
        self.assertEqual(GpuType.RTX_PRO_6000.value, "RTX-PRO-6000")
        self.assertEqual(SandboxClass.LINUX_VM.value, "linux-vm")
        self.assertEqual(SandboxListSortField.MEMORYGIB.value, "memoryGib")
        self.assertEqual(SandboxListSortDirection.DESC.value, "desc")

    def test_sort_enums_drive_list(self):
        world = DropInWorld()
        daytona = Daytona(client=world.client())
        for name in ("b", "a"):
            daytona.create(CreateSandboxFromSnapshotParams(name=name))
        listed = daytona.list(ListSandboxesQuery(sort=SandboxListSortField.NAME,
                                                 order=SandboxListSortDirection.ASC))
        self.assertEqual([one.name for one in listed], ["a", "b"])


class GpuTypeOnCreate(unittest.TestCase):
    def test_a_gpu_type_alone_is_refused_before_anything_is_made(self):
        world = DropInWorld()
        daytona = Daytona(client=world.client())
        for gpu_type in (GpuType.B200, [GpuType.H100, GpuType.B200], "B200"):
            with self.subTest(gpu_type=gpu_type), self.assertRaises(NotSupportedError) as raised:
                daytona.create(CreateSandboxFromImageParams(image="python:3.12",
                                                            resources=Resources(gpu_type=gpu_type)))
            self.assertIn("gpu_type", str(raised.exception))
        self.assertEqual(world.called("images.build"), [])
        self.assertEqual(world.called("sandboxes.create"), [])

    def test_no_gpu_type_still_creates(self):
        world = DropInWorld()
        Daytona(client=world.client()).create(CreateSandboxFromImageParams(
            image="python:3.12", resources=Resources(cpu=2, gpu_type=[])))
        self.assertEqual(len(world.called("sandboxes.create")), 1)

    def test_async(self):
        world = DropInWorld()

        async def scenario() -> None:
            daytona = AsyncDaytona(client=world.async_client())
            with self.assertRaises(NotSupportedError):
                await daytona.create(CreateSandboxFromSnapshotParams(resources=Resources(gpu_type=GpuType.B200)))
        asyncio.run(scenario())
        self.assertEqual(world.called("sandboxes.create"), [])


if __name__ == "__main__":
    unittest.main()
