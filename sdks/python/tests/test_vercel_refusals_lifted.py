"""Calls the Vercel Sandbox adapter once refused and now carries out: an
execution time limit past an hour (the lease renewed while the sandbox object
lives), a shorter limit that still covers the lease, and query sorting and
cursors. Sync and async."""
import asyncio
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dropin_fake import DropInWorld  # noqa: E402

from withruntime.vercel import sandbox as async_sandbox  # noqa: E402
from withruntime.vercel.sandbox import (NotSupportedError, SandboxQueryByCreatedAt, SandboxQueryByName,  # noqa: E402
                                        SandboxQueryByStatusUpdatedAt)
from withruntime.vercel.sandbox import sync as sandbox  # noqa: E402


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def ends(box) -> float:
    return datetime.fromisoformat(box.withruntime.info["expiresAt"].replace("Z", "+00:00")).timestamp()


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.world = DropInWorld()
        self.client = self.world.client()
        self.boxes = []

    def tearDown(self) -> None:
        for box in self.boxes:
            box._end_keeping()

    def create(self, **kwargs):
        box = sandbox.create_sandbox(client=self.client, **kwargs)
        self.boxes.append(box)
        return box

    def extends(self):
        return self.world.called("sandbox.extend")


class TimeLimitPastAnHour(Base):
    def test_three_hours_starts_with_an_hour_and_reports_three(self):
        box = self.create(execution_time_limit=timedelta(hours=3))
        self.assertEqual(self.world.called("sandboxes.create")[-1][0]["timeout_seconds"], 3600)
        self.assertEqual(box.execution_time_limit, timedelta(hours=3))
        # A timer looks again in a minute while the limit runs past the lease.
        self.assertIsNotNone(box._timer)

    def test_the_lease_steps_an_hour_at_a_time_never_past_the_limit(self):
        box = self.create(execution_time_limit=timedelta(minutes=70))
        asked = time.time() + 70 * 60
        box.run_process("ls")
        self.assertEqual(self.extends(), [])
        box.withruntime.info["expiresAt"] = iso(time.time() + 300)
        box.run_process("ls")
        self.assertAlmostEqual(ends(box), time.time() + 3600, delta=2)
        later = time.time() + 55 * 60
        box.withruntime.info["expiresAt"] = iso(later + 300)
        with mock.patch.object(time, "time", lambda: later):
            box._tick()
        self.assertEqual(len(self.extends()), 2)
        self.assertAlmostEqual(ends(box), asked, delta=2)
        self.assertLessEqual(ends(box), asked + 1)

    def test_extend_past_an_hour_moves_the_limit(self):
        box = self.create(execution_time_limit=timedelta(minutes=30))
        box.extend_execution_time_limit(timedelta(hours=2))
        self.assertEqual(box.execution_time_limit, timedelta(minutes=150))
        self.assertLessEqual(ends(box) - time.time(), 3601)
        self.assertGreater(self.extends()[-1][1], 29 * 60)

    def test_update_shortens_a_limit_the_lease_has_not_reached(self):
        box = self.create(execution_time_limit=timedelta(hours=3))
        box.update(execution_time_limit=timedelta(hours=2))
        self.assertEqual(box.execution_time_limit, timedelta(hours=2))
        with self.assertRaises(NotSupportedError) as caught:
            box.update(execution_time_limit=timedelta(minutes=10))
        self.assertIn("earlier than the current lease", str(caught.exception))
        self.assertEqual(box.execution_time_limit, timedelta(hours=2))

    def test_a_sandbox_that_ends_on_stop_is_no_longer_renewed(self):
        box = self.create(execution_time_limit=timedelta(hours=3), persistent=False)
        box.stop()
        self.assertIsNone(box._timer)
        box.withruntime.info["state"] = "running"
        box.withruntime.info["expiresAt"] = iso(time.time() + 60)
        box.fs.mkdir("x")
        self.assertEqual(self.extends(), [])


class Queries(Base):
    def test_sorts_by_name_newest_first_and_continues_from_a_cursor(self):
        for name in ("web-b", "api", "web-a", "web-c"):
            self.create(name=name)
        names = lambda query, **kw: [one.name for one in sandbox.query_sandboxes(  # noqa: E731
            query, client=self.client, **kw)]
        self.assertEqual(names(SandboxQueryByName(name_prefix="web-")), ["web-c", "web-b", "web-a"])
        self.assertEqual(names(SandboxQueryByName(name_prefix="web-", sort_order="asc")), ["web-a", "web-b", "web-c"])
        self.assertEqual(names(SandboxQueryByName(sort_order="asc"), cursor="rt.2"), ["web-b", "web-c"])
        self.assertEqual(len(names(SandboxQueryByCreatedAt())), 4)
        self.assertEqual(len(names(SandboxQueryByStatusUpdatedAt())), 4)
        with self.assertRaises(ValueError):
            names(None, cursor="abc")


class Async(unittest.TestCase):
    def test_a_long_limit_renews_beside_the_caller(self):
        world = DropInWorld()
        client = world.async_client()

        async def scenario():
            box = await async_sandbox.create_sandbox(client=client, execution_time_limit=timedelta(hours=2))
            self.assertEqual(box.execution_time_limit, timedelta(hours=2))
            self.assertEqual(world.called("sandboxes.create")[-1][0]["timeout_seconds"], 3600)
            self.assertIsNotNone(box._timer)
            box.withruntime.info["expiresAt"] = iso(time.time() + 60)
            await box._tick()
            self.assertAlmostEqual(ends(box), time.time() + 3600, delta=2)
            await box.destroy()
            self.assertIsNone(box._timer)
        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
