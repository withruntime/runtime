import asyncio
import unittest
from withruntime import CommandResult
from withruntime._async_client import AsyncSandbox
from withruntime._sync_client import Process, Sandbox

FILES = {"read": ["/etc/hostname", "/usr/lib/"], "written": ["/tmp/out"], "truncated": False}
RESULT = {"exitCode": 0, "stdout": "", "stderr": "", "files": FILES}


class Wire:
    def __init__(self):
        self.calls = []

    def json(self, method, path, body=None, **kwargs):
        self.calls.append((method, path, body))
        return RESULT if path.endswith(":exec") else FILES

    def events(self, method, path, body=None, **kwargs):
        self.calls.append((method, path, body))
        yield {"type": "start", "processId": "p"}
        yield {"type": "exit", "exitCode": 0, "files": FILES}


class AsyncWire(Wire):
    async def json(self, *args, **kwargs):
        return super().json(*args, **kwargs)

    async def events(self, *args, **kwargs):
        for event in super().events(*args, **kwargs):
            yield event


class TraceFilesTests(unittest.TestCase):
    def test_sent_only_when_set(self):
        wire = Wire()
        sbx = Sandbox(wire, {"id": "s"})
        sbx.exec("ls")
        self.assertNotIn("traceFiles", wire.calls[-1][2])
        result = sbx.exec("ls", trace_files=True)
        self.assertIs(wire.calls[-1][2]["traceFiles"], True)
        self.assertEqual(result.files.to_dict(), FILES)
        self.assertEqual(result.to_dict()["files"], FILES)

    def test_streamed_exit_event_carries_files(self):
        wire = Wire()
        result = Sandbox(wire, {"id": "s"}).exec("ls", trace_files=True, on_stdout=lambda _: None)
        self.assertIs(wire.calls[-1][2]["traceFiles"], True)
        self.assertEqual(result.files.written, ["/tmp/out"])

    def test_spawn_and_process_files(self):
        wire = Wire()
        sbx = Sandbox(wire, {"id": "s"})
        wire.json = lambda method, path, body=None, **kw: (wire.calls.append((method, path, body)), {"id": "p"} if method == "POST" else FILES)[1]
        process = sbx.spawn("ls", trace_files=True)
        self.assertIs(wire.calls[-1][2]["traceFiles"], True)
        self.assertEqual(process.files().read, FILES["read"])
        self.assertEqual(wire.calls[-1][:2], ("GET", "/v1/sandboxes/s/processes/p/files"))

    def test_async(self):
        async def run():
            wire = AsyncWire()
            sbx = AsyncSandbox(wire, {"id": "s"})
            result = await sbx.exec("ls", trace_files=True)
            self.assertIs(wire.calls[-1][2]["traceFiles"], True)
            self.assertEqual(result.files.read, FILES["read"])
            self.assertIsNone(CommandResult.from_json({"exitCode": 0}).files)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
