"""Runloop 2.0 input contracts over simulated native processes; no upstream code runs."""
import unittest
import base64
from types import SimpleNamespace
from unittest.mock import Mock, AsyncMock

from withruntime.runloop import Runloop, AsyncRunloop, RunloopSDK, AsyncRunloopSDK
from withruntime.runloop._sync import Execution, ExecutionsAPI
from withruntime.runloop._async import AsyncExecution, AsyncExecutionsAPI
from withruntime._request_scope import current
from withruntime._sync_client import Process
from withruntime._async_client import AsyncProcess


class InputServer:
    """Simulated offset admission: the first accepted write loses its response."""
    def __init__(self):
        self.data = b""
        self.requests = []
        self.lost = False

    def json(self, method, path, *, body):
        self.requests.append(body)
        chunk = base64.b64decode(body["base64"])
        if body["offset"] == len(self.data):
            self.data += chunk
        else:
            assert self.data[body["offset"]:body["offset"] + len(chunk)] == chunk
        if not self.lost:
            self.lost = True
            raise OSError("response lost after acceptance")
        return {"offset": body["offset"] + len(chunk)}


class SyncInput(unittest.TestCase):
    def setUp(self):
        self.process = SimpleNamespace(id="exec", write=Mock(), kill=Mock())
        self.runtime = SimpleNamespace(sandboxes=SimpleNamespace(get=Mock(
            return_value=SimpleNamespace(process=Mock(return_value=self.process)))))
        self.api = ExecutionsAPI(self.runtime)

    def test_body_validation_before_lookup(self):
        for body in ({}, {"text": ""}, {"text": 1}, {"text": "x", "signal": "EOF"},
                     {"signal": "TERM"}, {"text": None, "signal": None}):
            with self.subTest(body=body), self.assertRaisesRegex((TypeError, ValueError), "stdin"):
                self.api.send_std_in("exec", devbox_id="box", **body)
        self.runtime.sandboxes.get.assert_not_called()

    def test_text_eof_interrupt_and_failure(self):
        result = self.api.send_std_in("exec", devbox_id="box", text="héllo\n")
        self.assertEqual(dict(result), {"devbox_id": "box", "execution_id": "exec", "success": True})
        self.process.write.assert_called_once_with("héllo\n", eof=False)
        self.api.send_std_in("exec", devbox_id="box", signal="EOF")
        self.process.write.assert_called_with("", eof=True)
        self.api.send_std_in("exec", devbox_id="box", signal="INTERRUPT")
        self.process.kill.assert_called_once_with("SIGINT")
        self.process.write.side_effect = OSError("stdin closed")
        with self.assertRaisesRegex(OSError, "stdin closed"):
            self.api.send_std_in("exec", devbox_id="box", text="x")

    def test_high_level_helpers_and_request_deadline(self):
        execution = Execution("box", self.process)
        def written(text, *, eof):
            self.assertGreater(current().remaining(), 0)
            self.assertLessEqual(current().remaining(), 1)
        self.process.write.side_effect = written
        self.assertIsNone(execution.send_std_in("input", timeout=1))
        self.assertIsNone(execution.close_std_in(timeout=1))
        self.process.write.assert_called_with("", eof=True)
        self.assertIsNone(current().remaining())
        with self.assertRaisesRegex(ValueError, "stdin"):
            execution.send_std_in("")

    def test_unsupported_services_explain_native_alternative(self):
        for cls, names in ((Runloop, ("secrets", "objects", "axons", "gateway_configs", "mcp_configs", "network_policies")),
                           (RunloopSDK, ("secret", "storage_object", "axon", "gateway_config", "mcp_config", "network_policy"))):
            client = cls(runtime=self.runtime)
            for name in names:
                with self.subTest(cls=cls, name=name), self.assertRaisesRegex(ValueError, "Runtime.*(API|files|events|egress)"):
                    getattr(client, name)
        self.runtime.sandboxes.get.assert_not_called()

    def test_retry_after_lost_response_preserves_native_byte_offsets(self):
        server = InputServer()
        execution = Execution("box", Process(server, "box", {"id": "exec", "stdinOffset": 0}))
        with self.assertRaisesRegex(OSError, "response lost"):
            execution.send_std_in("é\n")
        execution.send_std_in("é\n")
        execution.close_std_in()
        self.assertEqual(server.data, "é\n".encode())
        self.assertEqual([r["offset"] for r in server.requests], [0, 0, 3])
        self.assertTrue(server.requests[-1]["eof"])

    def test_fractional_cpu_fails_before_allocation(self):
        with self.assertRaisesRegex(ValueError, "whole number on Runtime"):
            RunloopSDK(runtime=self.runtime).devbox.create(launch_parameters={"custom_cpu_cores": 0.5})
        self.runtime.sandboxes.get.assert_not_called()


class AsyncInput(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.process = SimpleNamespace(id="exec", write=AsyncMock(), kill=AsyncMock())
        self.runtime = SimpleNamespace(sandboxes=SimpleNamespace(get=AsyncMock(
            return_value=SimpleNamespace(process=AsyncMock(return_value=self.process)))))
        self.api = AsyncExecutionsAPI(self.runtime)

    async def test_body_validation_before_lookup(self):
        for body in ({}, {"text": ""}, {"text": 1}, {"text": "x", "signal": "EOF"},
                     {"signal": "TERM"}, {"text": None, "signal": None}):
            with self.subTest(body=body), self.assertRaisesRegex((TypeError, ValueError), "stdin"):
                await self.api.send_std_in("exec", devbox_id="box", **body)
        self.runtime.sandboxes.get.assert_not_called()

    async def test_text_eof_interrupt_and_failure(self):
        result = await self.api.send_std_in("exec", devbox_id="box", text="héllo\n")
        self.assertEqual(dict(result), {"devbox_id": "box", "execution_id": "exec", "success": True})
        self.process.write.assert_awaited_once_with("héllo\n", eof=False)
        await self.api.send_std_in("exec", devbox_id="box", signal="EOF")
        self.process.write.assert_awaited_with("", eof=True)
        await self.api.send_std_in("exec", devbox_id="box", signal="INTERRUPT")
        self.process.kill.assert_awaited_once_with("SIGINT")
        self.process.write.side_effect = OSError("stdin closed")
        with self.assertRaisesRegex(OSError, "stdin closed"):
            await self.api.send_std_in("exec", devbox_id="box", text="x")

    async def test_high_level_helpers_and_request_deadline(self):
        execution = AsyncExecution("box", self.process)
        async def written(text, *, eof):
            self.assertGreater(current().remaining(), 0)
            self.assertLessEqual(current().remaining(), 1)
        self.process.write.side_effect = written
        self.assertIsNone(await execution.send_std_in("input", timeout=1))
        self.assertIsNone(await execution.close_std_in(timeout=1))
        self.process.write.assert_awaited_with("", eof=True)
        self.assertIsNone(current().remaining())
        with self.assertRaisesRegex(ValueError, "stdin"):
            await execution.send_std_in("")

    async def test_unsupported_services_explain_native_alternative(self):
        for cls, names in ((AsyncRunloop, ("secrets", "objects", "axons", "gateway_configs", "mcp_configs", "network_policies")),
                           (AsyncRunloopSDK, ("secret", "storage_object", "axon", "gateway_config", "mcp_config", "network_policy"))):
            client = cls(runtime=self.runtime)
            for name in names:
                with self.subTest(cls=cls, name=name), self.assertRaisesRegex(ValueError, "Runtime.*(API|files|events|egress)"):
                    getattr(client, name)
        self.runtime.sandboxes.get.assert_not_called()

    async def test_retry_after_lost_response_preserves_native_byte_offsets(self):
        server = InputServer()
        async def json(*args, **kwargs):
            return server.json(*args, **kwargs)
        execution = AsyncExecution("box", AsyncProcess(SimpleNamespace(json=json), "box", {"id": "exec", "stdinOffset": 0}))
        with self.assertRaisesRegex(OSError, "response lost"):
            await execution.send_std_in("é\n")
        await execution.send_std_in("é\n")
        await execution.close_std_in()
        self.assertEqual(server.data, "é\n".encode())
        self.assertEqual([r["offset"] for r in server.requests], [0, 0, 3])
        self.assertTrue(server.requests[-1]["eof"])

    async def test_fractional_cpu_fails_before_allocation(self):
        with self.assertRaisesRegex(ValueError, "whole number on Runtime"):
            await AsyncRunloopSDK(runtime=self.runtime).devbox.create(launch_parameters={"custom_cpu_cores": 0.5})
        self.runtime.sandboxes.get.assert_not_called()
