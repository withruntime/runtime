"""withruntime.deepagents against stand-in sandboxes. Skipped without Deep Agents
(pip install "withruntime[deepagents]"). A real sandbox and create_deep_agent
were exercised on 23 September 2026; see packages/cloud-guide/docs/frameworks.md.
LocalSandbox runs Deep Agents' own commands on this machine, so every protocol
method is checked end to end; sdks/python/integrations/langchain-withruntime
runs LangChain's standard sandbox suite the same way."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import deepagents  # noqa: F401
    HAVE_DEEPAGENTS = True
except ImportError:
    HAVE_DEEPAGENTS = False

from withruntime import CommandResult
from withruntime._errors import NotFoundError
from withruntime._errors import RuntimeError as RuntimeCloudError


class Files:
    def __init__(self):
        self.data, self.removed = {}, []

    def read(self, path):
        if path not in self.data:
            raise NotFoundError("missing", code="file_not_found", status=404)
        return self.data[path]

    def write(self, path, data):
        self.data[path] = data

    def remove(self, path, recursive=False):
        self.removed.append(path)
        self.data.pop(path, None)


class StubSandbox:
    id = "sbx-1"

    def __init__(self):
        self.files, self.commands, self.outside = Files(), [], {}

    def exec(self, command, **kwargs):
        self.commands.append((command, kwargs))
        if isinstance(command, list) and command[:2] == ["sh", "-c"]:
            source, target = command[4], command[5]
            if source.startswith("/workspace/"):
                self.outside[target] = self.files.data[source]
            elif source in self.outside:
                self.files.data[target] = self.outside[source]
            else:
                return CommandResult(exit_code=1, stdout="", stderr=f"cat: {source}: No such file or directory\n")
            return CommandResult(exit_code=0, stdout="", stderr="")
        return CommandResult(exit_code=2, stdout="out\n", stderr="err\n", timed_out=True)


class LocalFiles:
    """The Files API over a temporary directory that stands for /workspace."""

    def __init__(self, root):
        self.root = root

    def host(self, path):
        assert path.startswith("/workspace/"), path
        return self.root / path[len("/workspace/"):]

    def read(self, path):
        target = self.host(path)
        if target.is_dir():
            raise RuntimeCloudError(f"{path} is a directory", code="is_directory", status=400)
        if not target.exists():
            raise NotFoundError("missing", code="file_not_found", status=404)
        return target.read_bytes()

    def write(self, path, data):
        target = self.host(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def remove(self, path, recursive=False):
        self.host(path).unlink()


class LocalSandbox:
    """exec runs on this machine: a string under bash -c, a list without a shell,
    with a /workspace argument mapped to the stand-in directory."""
    id = "sbx-local"

    def __init__(self, root):
        self.files = LocalFiles(root / "workspace")

    def exec(self, command, timeout_ms=None, **kwargs):
        if isinstance(command, str):
            argv = ["bash", "-c", command]
        else:
            argv = [str(self.files.host(a)) if a.startswith("/workspace/") else a for a in command]
        done = subprocess.run(argv, capture_output=True, timeout=None if timeout_ms is None else timeout_ms / 1000)
        return CommandResult(exit_code=done.returncode, stdout=done.stdout.decode(errors="replace"),
                             stderr=done.stderr.decode(errors="replace"))


@unittest.skipUnless(HAVE_DEEPAGENTS, "Deep Agents is not installed")
class DeepAgentsTest(unittest.TestCase):
    def test_execute_joins_output_and_reports_timeouts(self):
        from withruntime.deepagents import RuntimeSandbox
        sandbox = StubSandbox()
        response = RuntimeSandbox(sandbox, timeout_seconds=9).execute("make")
        self.assertEqual(response.exit_code, 2)
        self.assertTrue(response.output.startswith("out\nerr\n"))
        self.assertIn("ran past 9 seconds", response.output)
        self.assertEqual(sandbox.commands[-1][1], {"timeout_ms": 9000})

    def test_files_inside_and_outside_the_workspace(self):
        from withruntime.deepagents import RuntimeSandbox
        sandbox = StubSandbox()
        backend = RuntimeSandbox(sandbox)
        uploaded = backend.upload_files([("/workspace/a.txt", b"a"), ("/etc/app.conf", b"b"), ("rel.txt", b"c")])
        self.assertEqual([u.error for u in uploaded], [None, None, "invalid_path"])
        self.assertEqual(sandbox.outside["/etc/app.conf"], b"b")
        downloaded = backend.download_files(["/workspace/a.txt", "/etc/app.conf", "/workspace/none", "/etc/none"])
        self.assertEqual([d.content for d in downloaded[:2]], [b"a", b"b"])
        self.assertEqual([d.error for d in downloaded[2:]], ["file_not_found", "file_not_found"])
        self.assertTrue(all(path.startswith("/workspace/.deepagents-staging/") for path in sandbox.files.removed))
        self.assertEqual(backend.id, "sbx-1")

    def test_long_output_is_returned_whole_by_default(self):
        from withruntime.deepagents import RuntimeSandbox

        class Loud(StubSandbox):
            def exec(self, command, **kwargs):
                return CommandResult(exit_code=0, stdout="x" * 250_000, stderr="")

        response = RuntimeSandbox(Loud()).execute("cat big")
        self.assertEqual((len(response.output), response.truncated), (250_000, False))
        capped = RuntimeSandbox(Loud(), max_output_chars=10).execute("cat big")
        self.assertEqual((capped.output, capped.truncated), ("x" * 10, True))


@unittest.skipUnless(HAVE_DEEPAGENTS, "Deep Agents is not installed")
@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("bash") and shutil.which("python3"),
                     "LocalSandbox runs Deep Agents' GNU shell and python3 commands on this machine")
class DeepAgentsEndToEndTest(unittest.TestCase):
    def setUp(self):
        from withruntime.deepagents import RuntimeSandbox
        self.dir = Path(tempfile.mkdtemp(prefix="runtime-deepagents-test-"))
        self.root = str(self.dir / "outside")
        self.backend = RuntimeSandbox(LocalSandbox(self.dir))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_every_protocol_method(self):
        backend, root = self.backend, self.root
        self.assertIsNone(backend.write(f"{root}/src/app.py", "print('hello')\n").error)
        edited = backend.edit(f"{root}/src/app.py", "hello", "world")
        self.assertEqual((edited.error, edited.occurrences), (None, 1))
        read = backend.read(f"{root}/src/app.py")
        self.assertIn("print('world')", read.file_data["content"])
        ran = backend.execute(f"python3 {root}/src/app.py")
        self.assertEqual((ran.output, ran.exit_code, ran.truncated), ("world\n", 0, False))
        self.assertEqual([e["path"] for e in backend.ls(f"{root}/src").entries], [f"{root}/src/app.py"])
        self.assertEqual([m["path"] for m in backend.glob("**/*.py", path=root).matches], [f"{root}/src/app.py"])
        grep = backend.grep("world", path=root)
        self.assertEqual([(m["path"], m["line"]) for m in grep.matches], [(f"{root}/src/app.py", 1)])
        self.assertIsNone(backend.delete(f"{root}/src/app.py").error)
        self.assertIsNotNone(backend.read(f"{root}/src/app.py").error)
        # Nothing staged outside the workspace was left behind.
        self.assertEqual(list((self.dir / "workspace" / ".deepagents-staging").iterdir()), [])

    def test_a_file_past_the_old_output_cap_reads_back(self):
        backend, path = self.backend, f"{self.root}/big.txt"
        text = "".join(f"line {i:06d} {'x' * 90}\n" for i in range(1500))  # about 150 KB
        self.assertIsNone(backend.write(path, text).error)
        read = backend.read(path, limit=2000)
        self.assertIsNone(read.error)
        self.assertIn("line 001499", read.file_data["content"])

    def test_async_methods(self):
        import asyncio

        async def run():
            self.assertIsNone((await self.backend.awrite(f"{self.root}/a.txt", "one")).error)
            return await self.backend.aread(f"{self.root}/a.txt")

        self.assertIn("one", asyncio.run(run()).file_data["content"])


if __name__ == "__main__":
    unittest.main()
