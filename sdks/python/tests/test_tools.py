"""withruntime.tools against a recording stand-in for a sandbox, sync and async.
The frameworks that consume these functions were run against a real sandbox
on 23 September 2026; see packages/cloud-guide/docs/frameworks.md."""
import asyncio
import inspect
import typing
import unittest

from withruntime import CommandResult
from withruntime._errors import NotFoundError
from withruntime.tools import sandbox_tools


class Files:
    def __init__(self, calls):
        self.calls, self.data = calls, {"/workspace/a.txt": b"alpha"}

    def read(self, path):
        self.calls.append(("read", path))
        if path not in self.data:
            raise NotFoundError("missing", code="file_not_found", status=404)
        return self.data[path]

    def write(self, path, data):
        self.calls.append(("write", path, data))
        self.data[path] = data.encode() if isinstance(data, str) else data


class StubSandbox:
    def __init__(self, stdout="ok\n"):
        self.calls, self.stdout = [], stdout
        self.files = Files(self.calls)

    def exec(self, command, **kwargs):
        self.calls.append(("exec", command, kwargs))
        return CommandResult(exit_code=0, stdout=self.stdout, stderr="")


class AsyncFiles(Files):
    async def read(self, path):
        return Files.read(self, path)

    async def write(self, path, data):
        return Files.write(self, path, data)


class AsyncStubSandbox(StubSandbox):
    def __init__(self, stdout="ok\n"):
        super().__init__(stdout)
        self.files = AsyncFiles(self.calls)

    async def exec(self, command, **kwargs):
        return StubSandbox.exec(self, command, **kwargs)


class ToolsTest(unittest.TestCase):
    def test_names_docs_and_real_annotations(self):
        tools = sandbox_tools(StubSandbox())
        self.assertEqual([t.__name__ for t in tools],
                         ["runtime_exec", "runtime_read_file", "runtime_write_file", "runtime_list_files"])
        for tool in tools:
            self.assertIn("Args:", tool.__doc__)
            # CrewAI and Pydantic build schemas from these; strings would not resolve.
            for parameter in inspect.signature(tool).parameters.values():
                self.assertNotIsInstance(parameter.annotation, str, tool.__name__)
        self.assertEqual(typing.get_type_hints(tools[0])["timeout_seconds"], typing.Optional[int])

    def test_exec_resolves_cwd_caps_output_and_passes_the_timeout(self):
        sandbox = StubSandbox(stdout="x" * 30)
        run = sandbox_tools(sandbox, max_output_chars=10, timeout_seconds=7)[0]
        result = run("make", cwd="src")
        self.assertEqual(sandbox.calls[-1], ("exec", "make", {"cwd": "/workspace/src", "timeout_ms": 7000}))
        self.assertEqual(result["stdout"], "[20 earlier characters omitted]\n" + "x" * 10)
        run("make", timeout_seconds=2)
        self.assertEqual(sandbox.calls[-1][2]["timeout_ms"], 2000)

    def test_files_inside_the_workspace_use_the_files_api(self):
        sandbox = StubSandbox()
        _, read, write, _ = sandbox_tools(sandbox)
        self.assertEqual(read("a.txt"), "alpha")
        self.assertEqual(read("../workspace/missing.txt"), "No such file: /workspace/missing.txt")
        self.assertEqual(write("dir/b.txt", "héllo"), "Wrote 6 bytes to /workspace/dir/b.txt")
        self.assertEqual(sandbox.files.data["/workspace/dir/b.txt"], "héllo".encode())

    def test_files_elsewhere_go_through_a_command(self):
        sandbox = StubSandbox(stdout="root file")
        _, read, write, _ = sandbox_tools(sandbox)
        self.assertEqual(read("/etc/hostname"), "root file")
        self.assertEqual(sandbox.calls[-1][1], ["cat", "--", "/etc/hostname"])
        write("/tmp/x.txt", "data")
        command, kwargs = sandbox.calls[-1][1], sandbox.calls[-1][2]
        self.assertEqual(command[-1], "/tmp/x.txt")
        self.assertEqual(kwargs["stdin"], "data")

    def test_list_parses_find_output(self):
        sandbox = StubSandbox(stdout="d\t4096\t/workspace/src\nf\t12\t/workspace/src/a.py\n")
        listing = sandbox_tools(sandbox)[3]("src", depth=2)
        self.assertEqual(listing, [{"path": "/workspace/src", "type": "directory", "size": 4096},
                                   {"path": "/workspace/src/a.py", "type": "file", "size": 12}])
        self.assertEqual(sandbox.calls[-1][1][-2:], ["/workspace/src", "2"])

    def test_an_async_sandbox_gives_coroutines(self):
        sandbox = AsyncStubSandbox()
        tools = sandbox_tools(sandbox)
        self.assertTrue(all(inspect.iscoroutinefunction(tool) for tool in tools))

        async def flow():
            await tools[2]("n.txt", "note")
            return await tools[0]("true"), await tools[1]("n.txt")
        result, text = asyncio.run(flow())
        self.assertEqual((result["exit_code"], text), (0, "note"))


if __name__ == "__main__":
    unittest.main()
