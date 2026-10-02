"""A failed source wake must retain the capture result or its primary error."""
import asyncio
import unittest

from withruntime._async_client import AsyncSandbox
from withruntime._errors import ConnectionError, RuntimeError
from withruntime._request_scope import current, request_scope
from withruntime._sync_client import Sandbox


class CaptureTransport:
    def __init__(self, capture, wake_error=None, state="running"):
        self.capture, self.wake_error, self.state = capture, wake_error, state
        self.calls = []
        self.wake_deadline = "unset"

    def json(self, method, path, **kwargs):
        self.calls.append((method, path))
        if path.endswith(":pause"):
            self.state = "paused"
        elif path.endswith(":wake"):
            self.wake_deadline = current().deadline
            if self.wake_error is not None:
                raise self.wake_error
            self.state = "running"
        elif path.endswith(":snapshot"):
            if isinstance(self.capture, BaseException):
                raise self.capture
            return self.capture
        return {"id": "source", "state": self.state}


class AsyncCaptureTransport:
    def __init__(self, transport):
        self.transport = transport

    async def json(self, *args, **kwargs):
        return self.transport.json(*args, **kwargs)


class SnapshotRecovery(unittest.TestCase):
    def ready(self):
        return {"id": "kept", "state": "ready", "mode": "disk"}

    def wake_error(self):
        return ConnectionError("The source could not wake.", code="host_unavailable", status=503,
                               details={"existing": "retained"})

    def check_recovery(self, failure):
        self.assertEqual(failure.details["sourceSandboxId"], "source")
        self.assertEqual(failure.details["sourceWakeError"]["code"], "host_unavailable")
        self.assertIn("The source could not wake.", failure.details["sourceWakeError"]["message"])

    def test_sync_successful_capture_preserves_ids_and_wake_error_identity(self):
        wake = self.wake_error()
        transport = CaptureTransport(self.ready(), wake)
        with request_scope(10), self.assertRaises(ConnectionError) as caught:
            Sandbox(transport, {"id": "source", "state": "running"}).snapshot(mode="disk")
        self.assertIs(caught.exception, wake)
        self.assertEqual((wake.code, wake.status), ("host_unavailable", 503))
        self.assertEqual(wake.details["existing"], "retained")
        self.assertEqual(wake.details["snapshotId"], "kept")
        self.check_recovery(wake)
        self.assertIsNone(transport.wake_deadline)

    def test_async_successful_capture_preserves_ids_and_wake_error_identity(self):
        async def run():
            wake = self.wake_error()
            transport = CaptureTransport(self.ready(), wake)
            with request_scope(10), self.assertRaises(ConnectionError) as caught:
                await AsyncSandbox(AsyncCaptureTransport(transport), {"id": "source", "state": "running"}).snapshot(mode="disk")
            self.assertIs(caught.exception, wake)
            self.assertEqual(wake.details["snapshotId"], "kept")
            self.check_recovery(wake)
            self.assertIsNone(transport.wake_deadline)
        asyncio.run(run())

    def test_sync_primary_capture_error_survives_failed_wake(self):
        primary = RuntimeError("Capture denied.", code="capture_denied", status=409, details={"cause": "kept"})
        transport = CaptureTransport(primary, self.wake_error())
        with self.assertRaises(RuntimeError) as caught:
            Sandbox(transport, {"id": "source", "state": "running"}).snapshot()
        self.assertIs(caught.exception, primary)
        self.assertEqual((primary.code, primary.status), ("capture_denied", 409))
        self.assertEqual(primary.details["cause"], "kept")
        self.check_recovery(primary)
        self.assertNotIn("snapshotId", primary.details)

    def test_async_primary_capture_error_survives_failed_wake(self):
        async def run():
            primary = RuntimeError("Capture denied.", code="capture_denied", status=409, details={"cause": "kept"})
            transport = CaptureTransport(primary, self.wake_error())
            with self.assertRaises(RuntimeError) as caught:
                await AsyncSandbox(AsyncCaptureTransport(transport), {"id": "source", "state": "running"}).snapshot()
            self.assertIs(caught.exception, primary)
            self.assertEqual(primary.details["cause"], "kept")
            self.check_recovery(primary)
        asyncio.run(run())

    def test_async_cancellation_is_preserved_when_recovery_fails(self):
        async def run():
            primary = asyncio.CancelledError()
            transport = CaptureTransport(primary, self.wake_error())
            with self.assertRaises(asyncio.CancelledError) as caught:
                await AsyncSandbox(AsyncCaptureTransport(transport), {"id": "source", "state": "running"}).snapshot()
            self.assertIs(caught.exception, primary)
            self.assertEqual(primary.sourceSandboxId, "source")
            self.assertEqual(primary.sourceWakeError["code"], "host_unavailable")
            self.assertTrue(transport.calls[-1][1].endswith(":wake"))
        asyncio.run(run())

    def test_sync_interrupt_is_preserved_when_recovery_fails(self):
        primary = KeyboardInterrupt()
        transport = CaptureTransport(primary, self.wake_error())
        with self.assertRaises(KeyboardInterrupt) as caught:
            Sandbox(transport, {"id": "source", "state": "running"}).snapshot()
        self.assertIs(caught.exception, primary)
        self.assertEqual(primary.sourceSandboxId, "source")

    def test_already_paused_source_is_not_woken(self):
        transport = CaptureTransport(self.ready(), self.wake_error(), state="paused")
        answer = Sandbox(transport, {"id": "source", "state": "paused"}).snapshot(mode="disk")
        self.assertEqual(answer["id"], "kept")
        self.assertFalse(any(path.endswith(":wake") for _, path in transport.calls))


if __name__ == "__main__":
    unittest.main()
