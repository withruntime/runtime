import asyncio
from pathlib import Path
import sys
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from test_compat_new_providers import Base
from e2b_fake import FakeSandbox
from withruntime.runloop import RunloopSDK, AsyncRunloopSDK, RunloopError, PollingConfig, PollingTimeout
from withruntime._errors import RuntimeError as NativeError

MARKER = "compat.runloop.suspended"


class DiskLifecycle(Base):
    def setUp(self):
        super().setUp()
        def restart(sb, wait=True):
            sb._w.record("sandbox.restart", sb.id, wait)
            sb.info["state"] = "running" if wait else "starting"
            return sb
        patcher = patch.object(FakeSandbox, "restart", restart, create=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_disk_suspend_resume_shutdown_and_duplicate_intent(self):
        sdk = RunloopSDK(runtime=self.client)
        box = sdk.devbox.create(name="disk")
        box.file.write(file_path="/workspace/retained", contents="saved")
        self.assertEqual(box.suspend().status, "suspended")
        self.assertTrue(box._sandbox().info["persistent"])
        self.assertEqual(box.suspend().status, "suspended")
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)
        self.assertEqual(sdk.devbox.from_id(box.id).get_info().status, "suspended")
        self.assertEqual(box.resume().status, "running")
        self.assertNotIn(MARKER, box._sandbox().info["labels"])
        self.assertEqual(box.file.read(file_path="/workspace/retained"), "saved")
        self.assertEqual(box.shutdown().status, "shutdown")
        self.assertFalse(box._sandbox().info["persistent"])
        self.assertEqual(self.world.called("sandbox.pause"), [])
        self.assertEqual(self.world.called("sandbox.wake"), [])

    def test_paid_admission_failure_does_not_stop_ephemeral_guest(self):
        box = RunloopSDK(runtime=self.client).devbox.create()
        with patch.object(FakeSandbox, "update", side_effect=NativeError("paid required", status=402, code="payment_required")):
            with self.assertRaises(NativeError):
                box.suspend()
        self.assertEqual(self.world.called("sandbox.stop"), [])
        self.assertEqual(box.get_info().status, "running")
        self.assertNotIn(MARKER, box._sandbox().info["labels"])

    def test_failed_stop_and_restart_keep_disk_and_recovery_marker(self):
        box = RunloopSDK(runtime=self.client).devbox.create()
        with patch.object(FakeSandbox, "stop", side_effect=OSError("stop result unknown")):
            with self.assertRaisesRegex(OSError, "unknown"):
                box.suspend()
        self.assertTrue(box._sandbox().info["persistent"])
        self.assertEqual(box._sandbox().info["labels"][MARKER], "true")
        self.assertEqual(box.get_info().status, "running")
        box.suspend()
        with patch.object(FakeSandbox, "restart", side_effect=OSError("restart failed")):
            with self.assertRaisesRegex(OSError, "restart"):
                box.resume()
        self.assertEqual(box.get_info().status, "suspended")
        self.assertTrue(box._sandbox().info["persistent"])

    def test_two_handles_serialize_opposite_lifecycle_calls(self):
        sdk = RunloopSDK(runtime=self.client)
        one = sdk.devbox.create()
        two = sdk.devbox.from_id(one.id)
        entered, release, resuming = threading.Event(), threading.Event(), threading.Event()
        original_stop = FakeSandbox.stop
        failures = []
        def stop(sb, *args, **kwargs):
            entered.set()
            if not release.wait(2):
                raise AssertionError("Test did not release stop")
            return original_stop(sb, *args, **kwargs)
        def suspend():
            try: one.suspend()
            except BaseException as error: failures.append(error)
        def resume():
            resuming.set()
            try: two.resume()
            except BaseException as error: failures.append(error)
        with patch.object(FakeSandbox, "stop", stop):
            first = threading.Thread(target=suspend)
            second = threading.Thread(target=resume)
            first.start()
            try:
                self.assertTrue(entered.wait(2))
                second.start()
                self.assertTrue(resuming.wait(2))
                self.assertEqual(self.world.called("sandbox.restart"), [])
            finally:
                release.set()
                first.join(2)
                if second.ident is not None:
                    second.join(2)
        self.assertEqual(failures, [])
        self.assertEqual(two.get_info().status, "running")

    def test_async_same_protocol_and_resume_before_running(self):
        async def run():
            sdk = AsyncRunloopSDK(runtime=self.world.async_client())
            box = await sdk.devbox.create()
            self.assertEqual((await box.suspend()).status, "suspended")
            self.assertEqual((await box.resume_async()).status, "resuming")
            native = self.world.sandboxes[box.id]
            self.assertEqual(native.info["labels"][MARKER], "true")
            native.info["state"] = "running"
            self.assertEqual((await box.await_running()).status, "running")
            self.assertEqual(native.info["labels"][MARKER], "true")
            await box.resume()
            self.assertNotIn(MARKER, native.info["labels"])
            await box.shutdown()
            self.assertFalse(native.info["persistent"])
        asyncio.run(run())

    def test_wait_is_readonly_rejects_terminal_states_and_reports_deadline(self):
        box = RunloopSDK(runtime=self.client).devbox.create()
        box.suspend()
        before = len(self.world.calls)
        with self.assertRaisesRegex(RunloopError, "suspended"):
            box.await_running()
        self.assertTrue(all(call[0] == "sandboxes.get" for call in self.world.calls[before:]))
        native = box._sandbox()
        native.info["state"] = "starting"
        with self.assertRaises(PollingTimeout) as error:
            box.await_running(polling_config=PollingConfig(interval_seconds=0.01, max_attempts=2))
        self.assertEqual(error.exception.last_value.status, "resuming")
        self.assertEqual(native.info["labels"][MARKER], "true")

    def test_async_cancelled_wait_does_not_change_lifecycle(self):
        async def run():
            box = await AsyncRunloopSDK(runtime=self.world.async_client()).devbox.create()
            self.world.sandboxes[box.id].info["state"] = "starting"
            before = len(self.world.calls)
            waiter = asyncio.create_task(box.await_running())
            await asyncio.sleep(0)
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            self.assertTrue(all(call[0] == "sandboxes.get" for call in self.world.calls[before:]))
        asyncio.run(run())
