"""Vercel explicit filesystem capture over the real native sync/async SDK.

The transport is controlled: these checks prove client contracts, not Linux
capture consistency, process isolation, cold boots or hosted vendor behavior.
"""
import asyncio
import hashlib
import importlib.metadata
import json
import os
import sys
import unittest
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

from withruntime import AsyncRuntime, Runtime
from withruntime._async_client import AsyncSandbox as NativeAsyncSandbox
from withruntime._sync_client import Sandbox as NativeSandbox
from withruntime.vercel._async_sandbox import AsyncSandbox, get_snapshot as async_get_snapshot
from withruntime.vercel._sync_sandbox import Sandbox, get_snapshot

ID = "11111111-2222-4333-8444-555555555555"
NOW = "2026-09-30T00:00:00.123Z"
CREATED_MS = 1_790_726_400_123
EXPIRES_MS = 1_791_331_200_000


def snapshot_consumer(box):
    """Run unchanged against the pinned official and Runtime sync handles."""
    taken = box.snapshot(expiration=timedelta(days=7))
    return {"id": taken.id, "source": taken.source_session_id,
            "status": taken.status, "bytes": taken.size_bytes,
            "region": taken.region, "regions": taken.regions,
            "created": taken.created_at, "updated": taken.updated_at, "expires": taken.expires_at,
            "last_used": taken.last_used_at, "creation_method": taken.creation_method, "parent": taken.parent_id}


async def async_snapshot_consumer(box):
    """Run unchanged against the pinned official and Runtime async handles."""
    taken = await box.snapshot(expiration=timedelta(days=7))
    return {"id": taken.id, "source": taken.source_session_id,
            "status": taken.status, "bytes": taken.size_bytes,
            "region": taken.region, "regions": taken.regions,
            "created": taken.created_at, "updated": taken.updated_at, "expires": taken.expires_at,
            "last_used": taken.last_used_at, "creation_method": taken.creation_method, "parent": taken.parent_id}


def delete_consumer(taken):
    result = taken.delete()
    return {"same": result is taken, "status": taken.status, "id": taken.id}


async def async_delete_consumer(taken):
    result = await taken.delete()
    return {"same": result is taken, "status": taken.status, "id": taken.id}


class Transport:
    def __init__(self, *, returned_mode=None, fail=False, stop_fail=False, pending_stop=False, stop_wait_fail=False,
                 stop_wait_stays_pending=False):
        self.info = {"id": ID, "name": "snapshot-contract", "state": "running",
                     "onLeaseEnd": "pause", "labels": {}, "createdAt": NOW}
        self.snapshots = {}
        self.calls = []
        self.returned_mode, self.fail, self.stop_fail = returned_mode, fail, stop_fail
        self.pending_stop = pending_stop
        self.stop_wait_fail = stop_wait_fail
        self.stop_wait_stays_pending = stop_wait_stays_pending

    def json(self, method, path, **options):
        body = options.get("body") or {}
        self.calls.append((method, path, body))
        if path == f"/v1/sandboxes/{ID}:pause":
            self.info = {**self.info, "state": "paused"}
        elif path == f"/v1/sandboxes/{ID}:wake":
            self.info = {**self.info, "state": "running"}
        elif path == f"/v1/sandboxes/{ID}:stop":
            if self.stop_fail:
                from withruntime import RuntimeError
                raise RuntimeError("Stop failed", code="stop_failed", status=409)
            self.info = {**self.info, "state": "stopping" if self.pending_stop else "stopped"}
        elif path == f"/v1/sandboxes/{ID}:snapshot":
            if self.info["state"] != "paused":
                raise AssertionError("Capture must hold the source paused")
            taken = {"id": f"snapshot-{len(self.snapshots)}", "sourceSandboxId": ID,
                     "mode": self.returned_mode or body.get("mode", "memory"),
                     "state": "failed" if self.fail else "ready", "storedBytes": 1234,
                     "error": "Capture failed" if self.fail else None,
                     "createdAt": NOW, "expiresAt": "2026-10-07T00:00:00.000Z"}
            self.snapshots[taken["id"]] = taken
            return dict(taken)
        elif path.startswith("/v1/snapshots/"):
            snapshot_id = path.rsplit("/", 1)[-1].split(":", 1)[0]
            if path.endswith(":delete"):
                self.snapshots[snapshot_id] = {**self.snapshots[snapshot_id], "state": "deleted"}
            return dict(self.snapshots[snapshot_id])
        elif path == f"/v1/sandboxes/{ID}" and (options.get("query") or {}).get("waitFor") == "stopped":
            if self.stop_wait_fail:
                from withruntime import RuntimeError
                raise RuntimeError("Stop still pending", code="wait_timeout", status=409)
            if self.stop_wait_stays_pending:
                return dict(self.info)
            self.info = {**self.info, "state": "stopped"}
        elif path != f"/v1/sandboxes/{ID}":
            raise AssertionError(f"Unexpected controlled request {method} {path}")
        return dict(self.info)

    def adapter(self):
        return Sandbox(NativeSandbox(self, dict(self.info)), None)

    def stopped(self):
        return any(path.endswith(":stop") for _, path, _ in self.calls)


class AsyncTransport(Transport):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.capture_entered = asyncio.Event()
        self.capture_gate = None

    async def json(self, method, path, **options):
        if path.endswith(":snapshot"):
            self.capture_entered.set()
            if self.capture_gate is not None:
                await self.capture_gate.wait()
        return super().json(method, path, **options)

    def adapter(self):
        return AsyncSandbox(NativeAsyncSandbox(self, dict(self.info)), None)


EXPECTED = {"id": "snapshot-0", "source": ID, "status": "created", "bytes": 1234,
            "region": "iad1", "regions": ("iad1",), "created": CREATED_MS, "updated": CREATED_MS,
            "expires": EXPIRES_MS, "last_used": None, "creation_method": None, "parent": None}


class SyncContract(unittest.TestCase):
    def test_snapshot_timestamps_use_milliseconds_without_losing_fraction(self):
        taken = Transport().adapter().snapshot(expiration=timedelta(days=7))
        self.assertEqual(taken.created_at, CREATED_MS)
        self.assertEqual(taken.expires_at, EXPIRES_MS)

    def test_delete_refreshes_handle_and_returns_it(self):
        t = Transport()
        with Runtime(api_key="rtcloud_fixture", base_url="https://vercel-snapshot.invalid") as client:
            client._t.json = t.json
            box = t.adapter()
            box._client = client
            taken = box.snapshot()
            self.assertIs(taken.delete(), taken)
            self.assertEqual(taken.status, "deleted")
        self.assertEqual(t.snapshots["snapshot-0"]["state"], "deleted")

    def test_disk_capture_source_stop_and_fresh_handle(self):
        t = Transport()
        self.assertEqual(snapshot_consumer(t.adapter()), EXPECTED)
        body = next(body for _, path, body in t.calls if path.endswith(":snapshot"))
        self.assertEqual(body, {"mode": "disk", "retentionDays": 7})
        self.assertEqual(t.snapshots["snapshot-0"]["mode"], "disk")
        fresh_transport = Transport()
        fresh_transport.snapshots = t.snapshots
        with Runtime(api_key="rtcloud_fixture", base_url="https://vercel-snapshot.invalid") as client:
            client._t.json = fresh_transport.json
            fresh = get_snapshot(snapshot_id="snapshot-0", client=client)
        self.assertEqual((fresh.id, fresh.source_session_id, fresh.size_bytes), ("snapshot-0", ID, 1234))
        self.assertEqual(fresh_transport.calls, [("GET", "/v1/snapshots/snapshot-0", {})])
        self.assertEqual(t.info["state"], "stopped")

    def test_non_disk_capture_is_rejected_without_stopping_source(self):
        t = Transport(returned_mode="memory")
        with self.assertRaises(Exception) as caught:
            snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "snapshot_mode_mismatch")
        self.assertFalse(t.stopped())
        self.assertEqual(t.info["state"], "running")

    def test_failed_capture_restores_source_without_stopping_it(self):
        t = Transport(fail=True)
        with self.assertRaises(Exception) as caught:
            snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "snapshot_failed")
        self.assertFalse(t.stopped())
        self.assertEqual(t.info["state"], "running")

    def test_stop_failure_preserves_successfully_captured_disk(self):
        t = Transport(stop_fail=True)
        with self.assertRaises(Exception) as caught:
            snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "stop_failed")
        self.assertEqual((caught.exception.data["snapshotId"], caught.exception.data["sourceSandboxId"]),
                         ("snapshot-0", ID))
        self.assertEqual(t.snapshots["snapshot-0"]["mode"], "disk")
        self.assertEqual(t.info["state"], "running")

    def test_waits_until_captured_source_is_stopped(self):
        t = Transport(pending_stop=True)
        snapshot_consumer(t.adapter())
        self.assertEqual(t.info["state"], "stopped")
        stopped_at = next(index for index, (_, path, _) in enumerate(t.calls) if path.endswith(":stop"))
        self.assertTrue(any(path == f"/v1/sandboxes/{ID}" for _, path, _ in t.calls[stopped_at + 1:]))

    def test_stop_wait_timeout_preserves_captured_disk(self):
        t = Transport(pending_stop=True, stop_wait_fail=True)
        with self.assertRaises(Exception) as caught:
            snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "wait_timeout")
        self.assertEqual((caught.exception.data["snapshotId"], caught.exception.data["sourceSandboxId"]),
                         ("snapshot-0", ID))
        self.assertEqual(t.snapshots["snapshot-0"]["mode"], "disk")
        self.assertEqual(t.info["state"], "stopping")

    def test_terminal_wait_can_return_stopping_with_http_success(self):
        t = Transport(pending_stop=True, stop_wait_stays_pending=True)
        with self.assertRaises(Exception) as caught:
            snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "snapshot_source_stop_timeout")
        self.assertEqual(caught.exception.data, {"snapshotId": "snapshot-0", "sourceSandboxId": ID})
        self.assertEqual(t.snapshots["snapshot-0"]["mode"], "disk")
        self.assertEqual(t.info["state"], "stopping")


class AsyncContract(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_timestamps_use_milliseconds_without_losing_fraction(self):
        taken = await AsyncTransport().adapter().snapshot(expiration=timedelta(days=7))
        self.assertEqual(taken.created_at, CREATED_MS)
        self.assertEqual(taken.expires_at, EXPIRES_MS)

    async def test_delete_refreshes_handle_and_returns_it(self):
        t = AsyncTransport()
        async with AsyncRuntime(api_key="rtcloud_fixture", base_url="https://vercel-snapshot.invalid") as client:
            client._t.json = t.json
            box = t.adapter()
            box._client = client
            taken = await box.snapshot()
            self.assertIs(await taken.delete(), taken)
            self.assertEqual(taken.status, "deleted")
        self.assertEqual(t.snapshots["snapshot-0"]["state"], "deleted")

    async def test_disk_capture_source_stop_and_fresh_handle(self):
        t = AsyncTransport()
        self.assertEqual(await async_snapshot_consumer(t.adapter()), EXPECTED)
        body = next(body for _, path, body in t.calls if path.endswith(":snapshot"))
        self.assertEqual(body, {"mode": "disk", "retentionDays": 7})
        fresh_transport = AsyncTransport()
        fresh_transport.snapshots = t.snapshots
        async with AsyncRuntime(api_key="rtcloud_fixture", base_url="https://vercel-snapshot.invalid") as client:
            client._t.json = fresh_transport.json
            fresh = await async_get_snapshot(snapshot_id="snapshot-0", client=client)
        self.assertEqual((fresh.id, fresh.source_session_id, fresh.size_bytes), ("snapshot-0", ID, 1234))
        self.assertEqual(fresh_transport.calls, [("GET", "/v1/snapshots/snapshot-0", {})])

    async def test_non_disk_capture_is_rejected_without_stopping_source(self):
        t = AsyncTransport(returned_mode="memory")
        with self.assertRaises(Exception) as caught:
            await async_snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "snapshot_mode_mismatch")
        self.assertFalse(t.stopped())
        self.assertEqual(t.info["state"], "running")

    async def test_failed_capture_restores_source_without_stopping_it(self):
        t = AsyncTransport(fail=True)
        with self.assertRaises(Exception) as caught:
            await async_snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "snapshot_failed")
        self.assertFalse(t.stopped())
        self.assertEqual(t.info["state"], "running")

    async def test_task_cancellation_restores_source_without_stopping_it(self):
        t = AsyncTransport()
        t.capture_gate = asyncio.Event()
        pending = asyncio.create_task(async_snapshot_consumer(t.adapter()))
        await asyncio.wait_for(t.capture_entered.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertFalse(t.stopped())
        self.assertEqual(t.info["state"], "running")

    async def test_stop_failure_preserves_successfully_captured_disk(self):
        t = AsyncTransport(stop_fail=True)
        with self.assertRaises(Exception) as caught:
            await async_snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "stop_failed")
        self.assertEqual((caught.exception.data["snapshotId"], caught.exception.data["sourceSandboxId"]),
                         ("snapshot-0", ID))
        self.assertEqual(t.snapshots["snapshot-0"]["mode"], "disk")

    async def test_waits_until_captured_source_is_stopped(self):
        t = AsyncTransport(pending_stop=True)
        await async_snapshot_consumer(t.adapter())
        self.assertEqual(t.info["state"], "stopped")
        stopped_at = next(index for index, (_, path, _) in enumerate(t.calls) if path.endswith(":stop"))
        self.assertTrue(any(path == f"/v1/sandboxes/{ID}" for _, path, _ in t.calls[stopped_at + 1:]))

    async def test_stop_wait_timeout_preserves_captured_disk(self):
        t = AsyncTransport(pending_stop=True, stop_wait_fail=True)
        with self.assertRaises(Exception) as caught:
            await async_snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "wait_timeout")
        self.assertEqual((caught.exception.data["snapshotId"], caught.exception.data["sourceSandboxId"]),
                         ("snapshot-0", ID))
        self.assertEqual(t.snapshots["snapshot-0"]["mode"], "disk")
        self.assertEqual(t.info["state"], "stopping")

    async def test_terminal_wait_can_return_stopping_with_http_success(self):
        t = AsyncTransport(pending_stop=True, stop_wait_stays_pending=True)
        with self.assertRaises(Exception) as caught:
            await async_snapshot_consumer(t.adapter())
        self.assertEqual(caught.exception.code, "snapshot_source_stop_timeout")
        self.assertEqual(caught.exception.data, {"snapshotId": "snapshot-0", "sourceSandboxId": ID})
        self.assertEqual(t.snapshots["snapshot-0"]["mode"], "disk")
        self.assertEqual(t.info["state"], "stopping")


# Optional official-package evidence; regular tests require no vendor package.
# Run in a prepared environment with the pinned vercel and vercel-sandbox
# dependencies, setting RUNTIME_VERCEL_PYTHON_UPSTREAM=1 and the verified cache.
@unittest.skipUnless(os.environ.get("RUNTIME_VERCEL_PYTHON_UPSTREAM"), "pinned package comparison is opt-in")
class PublishedPackageContract(unittest.TestCase):
    def test_identical_sync_and_async_consumers(self):
        import vercel.sandbox._internal.async_runtime as official_async
        import vercel.sandbox._internal.sync_runtime as official_sync
        from vercel.sandbox._internal.models import SandboxStatus
        from vercel.sandbox._internal.state import SandboxState, SandboxRuntimeSessionState, SnapshotState, SnapshotSessionState

        root = Path(__file__).resolve().parents[3]
        lock = json.loads((root / "packages/cloud-sdk/compatibility-lock.json").read_text())
        pin = next(one for provider in lock["providers"] if provider["id"] == "vercel"
                   for one in provider["upstreams"] if one["name"] == "vercel-sandbox")
        self.assertEqual(importlib.metadata.version("vercel-sandbox"), pin["version"])
        cache = Path(os.environ["RUNTIME_VERCEL_SNAPSHOT_CACHE"]) / "pypi" / f"vercel-sandbox@{pin['version']}"
        self.assertEqual(json.loads((cache / ".runtime-contract-pin.json").read_text()),
                         {key: pin[key] for key in ("registry", "name", "version", "artifacts")})
        manifest = json.loads((cache / ".runtime-contract-files.json").read_text())
        installed = Path(official_async.__file__).resolve().parents[3]
        for name, digest in manifest.items():
            if name.startswith("vercel/"):
                self.assertEqual(hashlib.sha256((cache / name).read_bytes()).hexdigest(), digest)
                self.assertEqual(hashlib.sha256((installed / name).read_bytes()).hexdigest(), digest)

        session = SandboxRuntimeSessionState(id=ID, sandbox_name="snapshot-contract", status=SandboxStatus.RUNNING)
        stopped = SandboxRuntimeSessionState(id=ID, sandbox_name="snapshot-contract", status=SandboxStatus.STOPPED)
        state = SandboxState(name="snapshot-contract", current_session_id=ID, status=SandboxStatus.RUNNING,
                             persistent=True, current_session=session)
        snapshot = SnapshotState(id="snapshot-0", source_session_id=ID, region="iad1", regions=("iad1",),
                                 status="created", size_bytes=1234, created_at=CREATED_MS,
                                 updated_at=CREATED_MS, expires_at=EXPIRES_MS)
        calls = []

        class Service:
            async def create_snapshot(self, **fields):
                calls.append(fields)
                return SnapshotSessionState(snapshot=snapshot, session=stopped)

            async def delete_snapshot(self, *, snapshot_id):
                if snapshot_id != snapshot.id:
                    raise AssertionError("Wrong snapshot deletion")
                return replace(snapshot, status="deleted")

        sync = official_sync.SyncSandbox(payload=state, service=Service())
        transport = Transport()
        self.assertEqual(snapshot_consumer(sync), snapshot_consumer(transport.adapter()))
        self.assertEqual(transport.snapshots["snapshot-0"]["mode"], "disk")
        self.assertEqual(sync.current_session.status, SandboxStatus.STOPPED)
        with Runtime(api_key="rtcloud_fixture", base_url="https://vercel-snapshot.invalid") as client:
            client._t.json = transport.json
            local_snapshot = get_snapshot(snapshot_id="snapshot-0", client=client)
            original = official_sync.SyncSnapshot(payload=snapshot, service=Service())
            self.assertEqual(delete_consumer(local_snapshot), delete_consumer(original))

        async def compare():
            async_box = official_async.Sandbox(payload=state, service=Service())
            transport = AsyncTransport()
            self.assertEqual(await async_snapshot_consumer(async_box),
                             await async_snapshot_consumer(transport.adapter()))
            self.assertEqual(transport.snapshots["snapshot-0"]["mode"], "disk")
            self.assertEqual(async_box.current_session.status, SandboxStatus.STOPPED)
            async with AsyncRuntime(api_key="rtcloud_fixture", base_url="https://vercel-snapshot.invalid") as client:
                client._t.json = transport.json
                local_snapshot = await async_get_snapshot(snapshot_id="snapshot-0", client=client)
                original = official_async.Snapshot(payload=snapshot, service=Service())
                self.assertEqual(await async_delete_consumer(local_snapshot), await async_delete_consumer(original))

        asyncio.run(compare())
        self.assertEqual([one["session_id"] for one in calls], [ID, ID])
        self.assertEqual([one["expiration"].value for one in calls], [timedelta(days=7), timedelta(days=7)])


if __name__ == "__main__":
    unittest.main()
