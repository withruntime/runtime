"""Vercel validation and cancellation before/after allocation.

Controlled native-client fakes prove client effects, not live guest behavior.
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dropin_fake import DropInWorld, DropInSandbox
from withruntime.vercel._core import NetworkPolicy, NetworkPolicyRule, NotSupportedError, SnapshotRetention, retention_days
from withruntime.vercel._sync_sandbox import Sandbox, create_sandbox
from withruntime.vercel._async_sandbox import AsyncSandbox, create_sandbox as async_create_sandbox


BAD_OPTIONS = (
    {"snapshot_retention": SnapshotRetention(count=1)},
    {"snapshot_retention": {}},
    {"ports": [3000, 65536]},
    {"ports": [3000, True]},
    {"snapshot_expiration": "bad"},
    {"snapshot_expiration": -1},
    {"snapshot_expiration": float("nan")},
    {"snapshot_expiration": float("inf")},
    {"snapshot_expiration": float("-inf")},
    {"network_policy": NetworkPolicy.custom(allow={"example.com": [NetworkPolicyRule(forward_url="https://other.com")]})},
)


class SyncValidation(unittest.TestCase):
    def test_retention_preserves_existing_bounded_rounding(self):
        self.assertEqual([retention_days(value) for value in (0, 1, 86400, 86401, 366 * 86400)],
                         [365, 1, 1, 2, 365])

    def test_invalid_snapshot_expiration_has_no_effects(self):
        for expiration in (-1, float("nan"), float("inf"), float("-inf")):
            with self.subTest(expiration=expiration):
                world = DropInWorld()
                box = create_sandbox(client=world.client())
                world.calls.clear()
                with self.assertRaises(ValueError):
                    box.snapshot(expiration=expiration)
                self.assertEqual(world.calls, [])

    def test_invalid_create_options_have_no_effects(self):
        for options in BAD_OPTIONS:
            with self.subTest(options=options):
                world = DropInWorld()
                with self.assertRaises((ValueError, NotSupportedError)):
                    create_sandbox(client=world.client(), **options)
                self.assertEqual(world.calls, [])

    def test_omitted_retention_accepts_supported_ports(self):
        world = DropInWorld()
        box = create_sandbox(client=world.client(), snapshot_retention=None, ports=[3000])
        self.assertEqual(box.routes[0].port, 3000)
        self.assertEqual(len(world.called("sandboxes.create")), 1)

    def test_invalid_update_options_do_not_extend_or_change_network(self):
        for options in BAD_OPTIONS:
            with self.subTest(options=options):
                world = DropInWorld()
                box = create_sandbox(client=world.client())
                world.calls.clear()
                with self.assertRaises((ValueError, NotSupportedError)):
                    box.update(execution_time_limit=600, **options)
                self.assertEqual(world.calls, [])

    def test_invalid_retention_or_ports_do_not_change_network(self):
        for options in ({"snapshot_expiration": "bad"}, {"ports": [65536]}):
            with self.subTest(options=options):
                world = DropInWorld()
                box = create_sandbox(client=world.client())
                world.calls.clear()
                with self.assertRaises(ValueError):
                    box.update(network_policy=NetworkPolicy.deny_all(), **options)
                self.assertEqual(world.calls, [])

    def test_setup_error_stops_created_sandbox(self):
        world = DropInWorld()
        original = ValueError("setup failure")
        with patch.object(Sandbox, "_setup", side_effect=original):
            with self.assertRaises(ValueError) as caught:
                create_sandbox(client=world.client())
        self.assertIs(caught.exception, original)
        self.assertEqual(len(world.called("sandbox.stop")), 1)
        self.assertEqual(next(iter(world.sandboxes.values())).state, "stopped")

    def test_cleanup_failure_preserves_setup_error(self):
        world = DropInWorld()
        original, cleanup = ValueError("setup failure"), OSError("cleanup failure")
        with patch.object(Sandbox, "_setup", side_effect=original), patch.object(DropInSandbox, "stop", side_effect=cleanup):
            with self.assertRaises(ValueError) as caught:
                create_sandbox(client=world.client())
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, cleanup)


class AsyncValidation(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_snapshot_expiration_has_no_effects(self):
        for expiration in (-1, float("nan"), float("inf"), float("-inf")):
            with self.subTest(expiration=expiration):
                world = DropInWorld()
                box = await async_create_sandbox(client=world.async_client())
                world.calls.clear()
                with self.assertRaises(ValueError):
                    await box.snapshot(expiration=expiration)
                self.assertEqual(world.calls, [])

    async def test_invalid_create_options_have_no_effects(self):
        for options in BAD_OPTIONS:
            with self.subTest(options=options):
                world = DropInWorld()
                with self.assertRaises((ValueError, NotSupportedError)):
                    await async_create_sandbox(client=world.async_client(), **options)
                self.assertEqual(world.calls, [])

    async def test_invalid_update_options_have_no_effects(self):
        for options in BAD_OPTIONS:
            with self.subTest(options=options):
                world = DropInWorld()
                box = await async_create_sandbox(client=world.async_client())
                world.calls.clear()
                with self.assertRaises((ValueError, NotSupportedError)):
                    await box.update(execution_time_limit=600, **options)
                self.assertEqual(world.calls, [])

    async def test_task_cancellation_stops_allocated_sandbox(self):
        world = DropInWorld()
        entered, gate = asyncio.Event(), asyncio.Event()
        async def setup(*args, **kwargs):
            entered.set()
            await gate.wait()
        async def create():
            return await async_create_sandbox(client=world.async_client())
        with patch.object(AsyncSandbox, "_setup", setup):
            pending = asyncio.create_task(create())
            await asyncio.wait_for(entered.wait(), 1)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        self.assertEqual(len(world.called("sandbox.stop")), 1)
        self.assertEqual(next(iter(world.sandboxes.values())).state, "stopped")

    async def test_cleanup_failure_preserves_original_cancellation(self):
        world = DropInWorld()
        original, cleanup = asyncio.CancelledError("setup cancelled"), OSError("cleanup failure")
        with patch.object(AsyncSandbox, "_setup", side_effect=original), patch.object(DropInSandbox, "stop", side_effect=cleanup):
            with self.assertRaises(asyncio.CancelledError) as caught:
                await async_create_sandbox(client=world.async_client())
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, cleanup)


if __name__ == "__main__":
    unittest.main()
