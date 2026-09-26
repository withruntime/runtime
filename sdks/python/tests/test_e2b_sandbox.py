"""The E2B adapter against a fake of the withruntime SDK (tests/e2b_fake.py): every
mapped call and every refusal, sync and async."""
import asyncio
import os
import subprocess
import sys
import unittest
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2b_fake import Result, World  # noqa: E402

import withruntime.e2b as e2b  # noqa: E402
from withruntime.e2b import (AsyncSandbox, AuthenticationException, CommandExitException, FileNotFoundException,  # noqa: E402
                             FileType, InvalidArgumentException, NotSupportedException, Sandbox, SandboxQuery,
                             SandboxNotFoundException, TemplateException, TimeoutException)
from withruntime.e2b._core import pick_key, pid_of  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World()

    def create(self, *args, **kwargs):
        return Sandbox.create(*args, client=self.world.client(), **kwargs)

    def last_create(self):
        return self.world.called("sandboxes.create")[-1][0]

    def fake(self, sbx):
        return self.world.sandboxes[sbx.sandbox_id]


class Create(Base):
    def test_e2b_defaults_and_funding_left_to_runtime(self):
        sbx = self.create()
        self.assertEqual(self.last_create(), {"vcpu": 2, "memory_mib": 512, "timeout_seconds": 300,
                                              "on_lease_end": "stop"})
        self.assertEqual(sbx.sandbox_id, self.fake(sbx).id)

    def test_maps_timeout_metadata_internet_and_lifecycle(self):
        self.create(timeout=120, metadata={"job": "x"}, allow_internet_access=False,
                    lifecycle={"on_timeout": "pause"})
        self.assertEqual(self.last_create(), {"vcpu": 2, "memory_mib": 512, "timeout_seconds": 120,
                                              "on_lease_end": "pause", "auto_wake": False,
                                              "labels": {"job": "x"}, "network": {"internet": False}})
        # auto_resume is Runtime's automatic wake.
        self.create(lifecycle={"on_timeout": "pause", "auto_resume": True})
        self.assertEqual(self.last_create()["auto_wake"], True)

    def test_runtime_fields_pass_over(self):
        self.create(runtime_create={"funding": "trial", "memory_mib": 4096})
        self.assertEqual(self.last_create()["funding"], "trial")
        self.assertEqual(self.last_create()["memory_mib"], 4096)

    def test_short_timeout_rounds_up(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.create(timeout=5)
        self.assertEqual(self.last_create()["timeout_seconds"], 60)

    def test_refusals_before_anything_happens(self):
        cases = [
            ({"timeout": 7200}, "over one hour"),
            ({"lifecycle": {"on_timeout": {"action": "pause", "keep_memory": False}}}, "files-only"),
            ({"mcp": {}}, "MCP"),
            ({"network": {"deny_out": ["0.0.0.0/0"]}}, "network rules"),
            ({"iam": {}}, "workload identity"),
            ({"volume_mounts": {"/d": "v"}}, "volumes"),
            ({"domain": "e2b.app"}, '"domain"'),
            ({"debug": True}, "debug"),
        ]
        for kwargs, text in cases:
            with self.assertRaises(NotSupportedException) as caught:
                self.create(**kwargs)
            self.assertIn(text, str(caught.exception))
            self.assertTrue(caught.exception.alternative)
        self.assertEqual(self.world.called("sandboxes.create"), [])
        with self.assertRaises(InvalidArgumentException):
            self.create(timeout=0)
        with self.assertRaises(InvalidArgumentException):
            self.create(nonsense=1)

    def test_templates(self):
        self.create("base")
        self.assertNotIn("image", self.last_create())
        self.world.images.append({"id": "img-1", "name": "my-agent", "state": "ready"})
        self.create("my-agent")
        self.assertEqual(self.last_create()["image"], "img-1")
        with self.assertRaises(TemplateException) as caught:
            self.create("abc123xyz")
        self.assertIn("--name abc123xyz", str(caught.exception))
        uuid = "99999999-2222-4333-8444-555555555555"
        self.create(uuid)
        self.assertEqual(self.last_create(), {"snapshot": uuid, "timeout_seconds": 300, "on_lease_end": "stop"})
        self.world.forks_enabled = False
        with self.assertRaises(NotSupportedException) as caught:
            self.create(uuid)
        self.assertIn("Forks are paused", str(caught.exception))


class Keys(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = dict(os.environ)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self.saved)

    def test_e2b_keys_are_never_used(self):
        os.environ.pop("RUNTIME_API_KEY", None)
        os.environ["E2B_API_KEY"] = "e2b_abc"
        self.assertIsNone(pick_key(None))
        with self.assertRaises(AuthenticationException):
            pick_key("e2b_abc")

    def test_order(self):
        os.environ["RUNTIME_API_KEY"] = "rk_runtime"
        os.environ["E2B_API_KEY"] = "rk_other"
        self.assertEqual(pick_key(None), "rk_runtime")
        self.assertEqual(pick_key("e2b_abc"), "rk_runtime")
        self.assertEqual(pick_key("rk_given"), "rk_given")
        del os.environ["RUNTIME_API_KEY"]
        self.assertEqual(pick_key(None), "rk_other")


class Commands(Base):
    def test_result_cwd_envs_and_timeout(self):
        sbx = self.create(envs={"A": "1", "B": "2"})
        seen = []
        result = sbx.commands.run("echo hi", cwd="/tmp", envs={"B": "3"}, on_stdout=seen.append)
        self.assertEqual((result.exit_code, result.stdout, result.stderr, result.error), (0, "ran echo hi\n", "", None))
        self.assertEqual(seen, ["ran echo hi\n"])
        self.assertEqual(self.world.called("sandbox.exec")[-1],
                         ("echo hi", {"cwd": "/tmp", "env": {"A": "1", "B": "3"}, "timeout_ms": 60_000}))

    def test_whole_output_past_the_64_kib_an_exec_result_holds(self):
        # The judge panel's reproduction: python3 -c 'print("x"*70000)'.
        self.world.exec = lambda *_: Result(0, "x" * 70_000 + "\n", "y" * 70_000)
        sbx = self.create()
        result = sbx.commands.run("python3 -c 'print(\"x\"*70000)'", timeout=60)
        self.assertEqual((result.exit_code, len(result.stdout), len(result.stderr)), (0, 70_001, 70_000))

    def test_output_dropped_before_it_was_read_is_marked_and_warned(self):
        # A customer's report, 24 September 2026: output lost in a stream came
        # back looking whole.
        sbx = self.create()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            self.world.exec = lambda *_: Result(0, "tail\n", lost=True)
            self.assertTrue(sbx.commands.run("big").truncated)
            self.world.exec = lambda *_: Result(1, "tail\n", lost=True)
            with self.assertRaises(CommandExitException) as failed:
                sbx.commands.run("big")
            self.assertTrue(failed.exception.truncated)
            self.world.exec = lambda *_: Result(0, "whole\n")
            self.assertFalse(sbx.commands.run("small").truncated)
        self.assertEqual(len(caught), 2)
        self.assertIn("output was dropped", str(caught[0].message))
        self.world.output = lambda _: [{"type": "truncated", "droppedBytes": 10, "resumeAt": 10},
                                       {"type": "stdout", "data": "tail\n", "offset": 10},
                                       {"type": "exit", "exitCode": 0, "state": "exited", "timedOut": False}]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.assertTrue(sbx.commands.run("big", background=True).wait().truncated)

    def test_non_zero_exit(self):
        self.world.exec = lambda *_: Result(3, "partial\n", "boom\n")
        sbx = self.create()
        with self.assertRaises(CommandExitException) as caught:
            sbx.commands.run("exit 3")
        error = caught.exception
        self.assertEqual((error.exit_code, error.stdout, error.stderr, error.error),
                         (3, "partial\n", "boom\n", "exit status 3"))
        self.assertEqual(str(error), "Command exited with code 3 and error:\nboom\n")

    def test_timeouts_and_signals(self):
        self.world.exec = lambda *_: Result(None, timed_out=True)
        sbx = self.create()
        with self.assertRaises(TimeoutException):
            sbx.commands.run("sleep 9", timeout=1)
        self.world.exec = lambda *_: Result(0)
        sbx.commands.run("true", timeout=0)
        self.assertEqual(self.world.called("sandbox.exec")[-1][1]["timeout_ms"], 86_400_000)
        self.world.exec = lambda *_: Result(None)
        with self.assertRaises(CommandExitException) as caught:
            sbx.commands.run("kill -9 $$")
        self.assertEqual((caught.exception.exit_code, caught.exception.error), (-1, "terminated by a signal"))

    def test_users_and_home(self):
        sbx = self.create()
        with self.assertRaises(NotSupportedException):
            sbx.commands.run("id", user="root")
        sbx.commands.run("id", user="user")
        sbx.commands.run("cat /home/user/a")
        sbx.files.write("/home/user/b", "b")
        commands = [call[0] for call in self.world.called("sandbox.exec")]
        self.assertEqual(commands.count("[ -e /home/user ] || sudo ln -s /workspace /home/user"), 1)

    def test_background(self):
        sbx = self.create()
        handle = sbx.commands.run("python3 server.py", background=True)
        process = self.fake(sbx).process_list[0]
        self.assertEqual(handle.pid, pid_of(process.id))
        seen = []
        result = handle.wait(on_stdout=seen.append)
        self.assertEqual((result.exit_code, result.stdout), (0, "ran python3 server.py\n"))
        self.assertEqual(seen, ["ran python3 server.py\n"])

        self.world.output = lambda _: [{"type": "stderr", "data": "bad\n", "offset": 0},
                                       {"type": "exit", "exitCode": 2, "state": "exited", "timedOut": False}]
        failing = sbx.commands.run("false", background=True)
        with self.assertRaises(CommandExitException) as caught:
            failing.wait()
        self.assertEqual((caught.exception.exit_code, caught.exception.stderr), (2, "bad\n"))

    def test_stdin_list_connect_kill(self):
        self.world.output = lambda _: [{"type": "stdout", "data": "ready\n", "offset": 0}]
        sbx = self.create()
        closed = sbx.commands.run("cat", background=True)
        with self.assertRaises(InvalidArgumentException):
            closed.send_stdin("x")
        opened = sbx.commands.run("cat", background=True, stdin=True)
        opened.send_stdin("hello\n")
        opened.close_stdin()
        process = self.fake(sbx).process_list[1]
        self.assertEqual(self.world.called("process.write"), [(process.id, "hello\n", False), (process.id, b"", True)])
        listed = sbx.commands.list()
        self.assertIn(opened.pid, [one.pid for one in listed])
        self.assertEqual((listed[0].cmd, listed[0].args), ("/bin/bash", ["-c", "cat"]))
        sbx.commands.send_stdin(opened.pid, "more")
        self.assertEqual(sbx.commands.connect(opened.pid).pid, opened.pid)
        self.assertTrue(sbx.commands.kill(opened.pid))
        self.assertEqual(process.killed, "SIGKILL")
        self.assertFalse(sbx.commands.kill(12345))


class Files(Base):
    def test_read_write(self):
        sbx = self.create()
        info = sbx.files.write("notes/a.txt", "hello")
        self.assertEqual((info.name, info.type, info.path), ("a.txt", FileType.FILE, "/workspace/notes/a.txt"))
        self.assertEqual(sbx.files.read("/workspace/notes/a.txt"), "hello")
        self.assertEqual(sbx.files.read("notes/a.txt", format="bytes"), bytearray(b"hello"))
        self.assertEqual(b"".join(sbx.files.read("notes/a.txt", format="stream")), b"hello")
        written = sbx.files.write_files([{"path": "/workspace/b", "data": b"\x01"}, {"path": "c", "data": "c"}])
        self.assertEqual([one.path for one in written], ["/workspace/b", "/workspace/c"])

    def test_list_info_dirs_rename_remove(self):
        sbx = self.create()
        sbx.files.write("/workspace/d/x.py", "print(1)")
        entry = sbx.files.list("/workspace/d")[0]
        self.assertEqual((entry.name, entry.type, entry.size, entry.mode, entry.permissions),
                         ("x.py", FileType.FILE, 8, 0o644, "rw-r--r--"))
        self.assertEqual(self.world.called("files.list")[0][1], {"depth": 1, "hidden": True})
        self.assertEqual(sbx.files.get_info("/workspace/d").type, FileType.DIR)
        self.assertFalse(sbx.files.make_dir("/workspace/d"))
        self.assertTrue(sbx.files.make_dir("/workspace/e"))
        self.assertEqual(sbx.files.rename("/workspace/d/x.py", "/workspace/d/y.py").path, "/workspace/d/y.py")
        self.assertEqual(self.world.called("files.rename")[0][2], True)
        sbx.files.remove("/workspace/d")
        self.assertEqual(self.world.called("files.remove")[0], ("/workspace/d", True))
        self.assertFalse(sbx.files.exists("/workspace/d/y.py"))

    def test_missing_and_refused(self):
        sbx = self.create()
        with self.assertRaises(FileNotFoundException) as caught:
            sbx.files.read("/workspace/none")
        self.assertEqual((caught.exception.code, caught.exception.request_id), ("file_not_found", "req_1"))
        with self.assertRaises(FileNotFoundException):
            sbx.files.get_info("/workspace/none")
        for call in (lambda: sbx.files.watch_dir("/workspace"), lambda: sbx.files.read("/etc/x", user="root"),
                     lambda: sbx.files.write("/workspace/a", "a", metadata={"k": "v"})):
            with self.assertRaises(NotSupportedException):
                call()


class Lifecycle(Base):
    def test_kill(self):
        sbx = self.create()
        self.assertTrue(sbx.kill())
        self.assertEqual(self.world.called("sandbox.stop")[0], (sbx.sandbox_id, False))
        self.assertFalse(sbx.kill())
        self.assertFalse(Sandbox.kill(sbx.sandbox_id, client=self.world.client()))
        self.assertFalse(Sandbox.kill("nope", client=self.world.client()))

    def test_set_timeout(self):
        sbx = self.create(timeout=120)
        sbx.set_timeout(600)
        seconds = self.world.called("sandbox.extend")[0][1]
        self.assertTrue(478 <= seconds <= 482, seconds)
        with self.assertRaises(NotSupportedException):
            sbx.set_timeout(60)
        Sandbox.set_timeout(sbx.sandbox_id, 900, client=self.world.client())
        self.assertEqual(len(self.world.called("sandbox.extend")), 2)

    def test_info_pause_connect(self):
        sbx = self.create(metadata={"a": "b"})
        info = sbx.get_info()
        self.assertEqual((info.sandbox_id, info.template_id, info.metadata, info.state, info.cpu_count, info.memory_mb),
                         (sbx.sandbox_id, "base", {"a": "b"}, "running", 2, 512))
        self.assertEqual(Sandbox.get_info(sbx.sandbox_id, client=self.world.client()).sandbox_id, sbx.sandbox_id)
        self.assertTrue(sbx.is_running())
        self.assertTrue(sbx.pause())
        self.assertFalse(sbx.beta_pause())
        with self.assertRaises(NotSupportedException):
            sbx.pause(keep_memory=False)
        again = Sandbox.connect(sbx.sandbox_id, timeout=600, client=self.world.client())
        self.assertEqual(self.world.called("sandbox.wake")[0], (sbx.sandbox_id, 600))
        self.assertTrue(again.is_running())
        with self.assertRaises(NotSupportedException):
            Sandbox.connect(sbx.sandbox_id, on_resume="reboot", client=self.world.client())
        sbx.kill()
        with self.assertRaises(SandboxNotFoundException):
            Sandbox.connect(sbx.sandbox_id, client=self.world.client())

    def test_context_manager_kills(self):
        with self.create() as sbx:
            pass
        self.assertEqual(self.world.called("sandbox.stop")[0][0], sbx.sandbox_id)


class Listing(Base):
    def test_pages(self):
        a = self.create(metadata={"s": "x"})
        self.create(metadata={"s": "y"})
        c = self.create(metadata={"s": "x"})
        c.pause()
        paginator = Sandbox.list(query=SandboxQuery(metadata={"s": "x"}), limit=1, client=self.world.client())
        seen = []
        while paginator.has_next:
            seen.extend(paginator.next_items())
        self.assertEqual([(one.sandbox_id, one.state) for one in seen], [(a.sandbox_id, "running"),
                                                                         (c.sandbox_id, "paused")])
        self.assertEqual(self.world.called("sandboxes.list")[0][0]["state"],
                         ["starting", "running", "resuming", "pausing", "paused"])
        for kwargs in ({"query": SandboxQuery(template="mine")}, {"order": "desc"}, {"next_token": "t"}):
            with self.assertRaises(NotSupportedException):
                Sandbox.list(client=self.world.client(), **kwargs)


class ForksPortsAndGaps(Base):
    def test_forks_and_snapshots(self):
        sbx = self.create()
        forks = sbx.fork(count=2)
        self.assertEqual(len(forks), 2)
        self.assertEqual(len(Sandbox.fork(sbx.sandbox_id, count=1, client=self.world.client())), 1)
        with self.assertRaises(NotSupportedException):
            Sandbox.fork(sbx.sandbox_id, timeout=60, client=self.world.client())
        self.assertEqual(len(self.world.called("sandbox.fork")), 2)
        snapshot = sbx.create_snapshot("s")
        self.assertEqual(snapshot.names, ["s"])
        self.assertTrue(Sandbox.delete_snapshot(snapshot.snapshot_id, client=self.world.client()))
        self.assertFalse(Sandbox.delete_snapshot(snapshot.snapshot_id, client=self.world.client()))
        self.world.forks_enabled = False
        for call in (sbx.fork, sbx.create_snapshot):
            with self.assertRaises(NotSupportedException) as caught:
                call()
            self.assertEqual(caught.exception.code, "fork_unavailable")

    def test_ports(self):
        # 25 September 2026: get_host raised, so E2B code did not run unchanged.
        sbx = self.create()
        host = f"3000-{sbx.sandbox_id.replace('-', '')}.runtimehost.com"
        self.assertEqual(sbx.get_host(3000), host)
        self.assertEqual(sbx.get_host(3000), host)
        self.assertEqual(sbx.get_public_host(3000), host)
        self.assertEqual(len(self.world.called("previews.create")), 1)
        with self.assertRaises(e2b.InvalidArgumentException):
            sbx.get_host(0)

    def test_gaps(self):
        sbx = self.create()
        for call in (lambda: sbx.pty, lambda: sbx.git, sbx.update_network, sbx.upload_url,
                     sbx.download_url, sbx.get_mcp_token, e2b.Template, lambda: e2b.Volume.create("v"),
                     lambda: e2b.Secret.create("s"), lambda: e2b.wait_for_port(3000)):
            with self.assertRaises(NotSupportedException):
                call()


class Async(unittest.TestCase):
    def test_get_host_answers_at_once_and_the_share_lands_beside_it(self):
        world = World()

        async def scenario():
            async with await AsyncSandbox.create(client=world.async_client()) as sbx:
                host = sbx.get_host(8000)  # no await, as in E2B
                self.assertEqual(host, f"8000-{sbx.sandbox_id.replace('-', '')}.runtimehost.com")
                self.assertEqual(await sbx.get_public_host(8000), host)
                self.assertEqual(len(world.called("previews.create")), 1)
        asyncio.run(scenario())

    def test_async_sandbox_end_to_end(self):
        world = World()

        async def scenario():
            seen = []

            async def on_stdout(text):
                seen.append(text)

            async with await AsyncSandbox.create(envs={"A": "1"}, client=world.async_client()) as sbx:
                result = await sbx.commands.run("echo hi", on_stdout=on_stdout)
                await asyncio.sleep(0)
                self.assertEqual(result.stdout, "ran echo hi\n")
                handle = await sbx.commands.run("serve", background=True, on_stdout=on_stdout)
                self.assertEqual((await handle.wait()).exit_code, 0)
                await sbx.files.write("a.txt", "x")
                self.assertEqual(await sbx.files.read("a.txt"), "x")
                chunks = [chunk async for chunk in await sbx.files.read("a.txt", format="stream")]
                self.assertEqual(chunks, [b"x"])
                self.assertEqual((await sbx.get_info()).memory_mb, 512)
                world.exec = lambda *_: Result(1, "", "no\n")
                with self.assertRaises(CommandExitException):
                    await sbx.commands.run("false")
                paginator = AsyncSandbox.list(client=world.async_client())
                self.assertEqual(len(await paginator.next_items()), 1)
                self.assertTrue(await AsyncSandbox.pause(sbx.sandbox_id, client=world.async_client()))
                await AsyncSandbox.connect(sbx.sandbox_id, client=world.async_client())
            self.assertEqual(seen, ["ran echo hi\n", "ran serve\n"])
            self.assertEqual(world.called("sandbox.stop")[0][0], sbx.sandbox_id)
            self.assertEqual(world.called("sandbox.exec")[0][1]["env"], {"A": "1"})

        asyncio.run(scenario())

    def test_disconnect(self):
        world = World()
        world.output = lambda _: [{"type": "stdout", "data": "a", "offset": 0}]

        async def scenario():
            sbx = await AsyncSandbox.create(client=world.async_client())
            handle = await sbx.commands.run("serve", background=True)
            await handle.disconnect()
            with self.assertRaises(e2b.SandboxException):
                await handle.wait()

        asyncio.run(scenario())


class Isolation(unittest.TestCase):
    def test_importing_withruntime_does_not_load_the_e2b_layer(self):
        code = "import sys, withruntime; print(any(m.startswith('withruntime.e2b') for m in sys.modules))"
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(ROOT),
                                env={**os.environ, "PYTHONPATH": str(ROOT)})
        self.assertEqual(result.stdout.strip(), "False", result.stderr)


class Parity(unittest.TestCase):
    def test_generated_sync_modules_are_current(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "generate_e2b_sync.py"), "--check"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
