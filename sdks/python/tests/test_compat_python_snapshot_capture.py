import asyncio
from unittest.mock import patch
import unittest
from withruntime._sync_client import Sandbox
from withruntime._async_client import AsyncSandbox
from withruntime._errors import RuntimeError


class SnapshotCapture(unittest.TestCase):
    def fixture(self, state="running", result="ready", mode="disk"):
        events = []
        class Transport:
            def json(self, method, path, **kwargs):
                events.append((method, path, kwargs))
                if path.endswith(":snapshot"):
                    return {"id": "snap", "state": "capturing", "mode": mode}
                if path.startswith("/v1/snapshots/"):
                    return {"id": "snap", "state": result, "mode": mode, "error": "fixture failure"}
                if path.endswith(":pause"):
                    self.state = "paused"
                elif path.endswith(":wake"):
                    self.state = "running"
                return {"id": "owned", "state": self.state}
        transport = Transport()
        transport.state = state
        return transport, events

    def test_sync_capture_polls_while_paused_and_wakes_after_ready(self):
        transport, events = self.fixture()
        with patch("withruntime._sync_client.sleep"):
            result = Sandbox(transport, {"id": "owned", "state": "running"}).snapshot(mode="disk")
        self.assertEqual(result["state"], "ready")
        self.assertEqual([path for _, path, _ in events], ["/v1/sandboxes/owned", "/v1/sandboxes/owned:pause",
            "/v1/sandboxes/owned:snapshot", "/v1/snapshots/snap", "/v1/sandboxes/owned:wake"])
        self.assertEqual(events[2][2]["body"]["mode"], "disk")

    def test_refusal_failed_capture_and_wrong_mode_preserve_source_state(self):
        for initial in ("running", "paused"):
            for result, mode, expected in (("failed", "disk", "snapshot_failed"), ("ready", "memory", "snapshot_mode_mismatch")):
                transport, events = self.fixture(initial, result, mode)
                box = Sandbox(transport, {"id": "owned", "state": initial})
                with patch("withruntime._sync_client.sleep"), self.assertRaises(RuntimeError) as error:
                    box.snapshot(mode="disk")
                self.assertEqual(error.exception.code, expected)
                self.assertEqual(transport.state, initial)
                if initial == "paused":
                    self.assertFalse(any(path.endswith(":wake") for _, path, _ in events))
        transport, events = self.fixture()
        with self.assertRaises(ValueError):
            Sandbox(transport, {"id": "owned", "state": "running"}).snapshot(mode="other")
        self.assertEqual(events, [])

    def test_async_capture_wakes_after_ready_and_stays_paused_past_the_deadline(self):
        # Waking a source mid-capture fails the capture (4 October 2026): past
        # the deadline the source stays paused and the error names the snapshot.
        async def run(timeout):
            sync, events = self.fixture()
            class Transport:
                async def json(self, *args, **kwargs): return sync.json(*args, **kwargs)
            async def sleep(_):
                if timeout: raise TimeoutError("fixture deadline")
            with patch("withruntime._async_client.sleep", sleep):
                box = AsyncSandbox(Transport(), {"id": "owned", "state": "running"})
                if timeout:
                    with self.assertRaises(RuntimeError) as error:
                        await box.snapshot(mode="disk")
                    self.assertEqual(error.exception.code, "snapshot_timeout")
                    self.assertEqual(error.exception.details, {"snapshotId": "snap", "sourceSandboxId": "owned"})
                    self.assertEqual(sync.state, "paused")
                    self.assertFalse(any(path.endswith(":wake") for _, path, _ in events))
                else:
                    self.assertEqual((await box.snapshot(mode="disk"))["mode"], "disk")
                    self.assertEqual(sync.state, "running")
                    self.assertTrue(events[-1][1].endswith(":wake"))
        asyncio.run(run(False))
        asyncio.run(run(True))

    def test_capture_deadline_is_ten_minutes_unless_given(self):
        # It was one minute, whatever the caller needed (4 October 2026).
        from withruntime import _request_scope
        for given, expected in ((None, 600.0), (1800, 1800)):
            seen = []
            real = _request_scope.request_scope
            def scope(*args, **kwargs):
                if args: seen.append(args[0])
                return real(*args, **kwargs)
            transport, _ = self.fixture()
            with patch("withruntime._sync_client.sleep"), patch.object(_request_scope, "request_scope", scope):
                Sandbox(transport, {"id": "owned", "state": "running"}).snapshot(mode="disk", timeout_seconds=given)
            self.assertIn(expected, seen)


class SnapshotMetadata(unittest.TestCase):
    def test_native_update_keeps_explicit_null_empty_labels_and_precondition(self):
        from withruntime._sync_client import Snapshots
        calls = []
        class Transport:
            def json(self, *args, **kwargs):
                calls.append((args, kwargs))
                return {'id': 'snapshot'}
        snapshots = Snapshots(Transport())
        snapshots.update('snapshot', name=None, labels={}, if_labels={'old': 'value'}, idempotency_key='owned')
        self.assertEqual(calls[0][1], {'body': {'name': None, 'labels': {}, 'ifLabels': {'old': 'value'}}, 'idempotency_key': 'owned'})
        with self.assertRaises(TypeError): snapshots.update('snapshot', unknown=True)
        self.assertEqual(len(calls), 1)
