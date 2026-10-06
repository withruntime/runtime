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
                             SandboxException, SandboxNotFoundException, TemplateException, TimeoutException)
from withruntime.e2b._core import HOME_LINK, pick_key, pid_of  # noqa: E402
from withruntime.e2b import _sync_sandbox as sync_sandbox  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def output_events(result):
    """The native process API streams the same command result without its cap."""
    events = []
    offset = 0
    if result.stdout_truncated or result.stderr_truncated:
        events.append({"type": "truncated", "droppedBytes": 1, "resumeAt": 1})
    for kind in ("stdout", "stderr"):
        data = getattr(result, kind)
        if data:
            events.append({"type": kind, "data": data, "offset": offset})
            offset += len(data.encode())
    events.append({"type": "exit", "exitCode": result.exit_code, "timedOut": result.timed_out})
    return events


def as_users(files, users=("app",)):
    """World.exec for calls made as another Linux user: ``id -u`` knows
    ``users`` (and root), and the file scripts act on ``files``."""
    import base64
    from withruntime.e2b._core import USER_FILE_SCRIPTS
    names = {text: name for name, text in USER_FILE_SCRIPTS.items()}

    def run(command, options):
        if isinstance(command, list) and command[:3] == ["id", "-u", "--"]:
            known = command[3] in users
            return Result(0 if known else 1, "1001\n" if known else "", "" if known else "id: no such user\n")
        if isinstance(command, list) and command[0] == "sudo" and command[5:7] == ["/bin/sh", "-c"]:
            name, args = names[command[7]], command[9:]
            path = args[0]
            if name == "read":
                return Result(0, base64.b64encode(files[path]).decode()) if path in files else Result(44)
            if name in ("write", "append"):
                data = base64.b64decode(options.get("stdin") or "")
                files[path] = (files.get(path, b"") if name == "append" else b"") + data
                return Result(0)
            if name == "stat":
                if path not in files:
                    return Result(44)
                return Result(0, "\0".join(["f", str(len(files[path])), "600", "root", "root", "1790000000.5",
                                            path, ""]) + "\0")
            if name == "exists":
                return Result(0 if path in files else 1)
            if name == "remove":
                files.pop(path, None)
                return Result(0)
        return Result(0, f"ran {command}\n")
    return run


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World()
        self.world.output = lambda command: output_events(self.world.exec(command, {}))

    def create(self, *args, **kwargs):
        return Sandbox.create(*args, client=self.world.client(), **kwargs)

    def last_create(self):
        return self.world.called("sandboxes.create")[-1][0]

    def fake(self, sbx):
        return self.world.sandboxes[sbx.sandbox_id]


class Create(Base):
    def test_e2b_defaults_and_funding_left_to_runtime(self):
        import time
        sbx = self.create()
        # Nobody asked for it to end, so E2B's default five minutes pauses it:
        # nothing is lost, and the next call wakes it.
        self.assertEqual(self.last_create(), {"vcpu": 2, "memory_mib": 512, "timeout_seconds": 300,
                                              "on_lease_end": "pause"})
        self.assertEqual(sbx.sandbox_id, self.fake(sbx).id)
        self.assertEqual(self.world.called("images.list"), [])
        info = sbx.get_info()
        self.assertGreater(info.end_at.timestamp(), time.time())
        self.assertEqual(info.lifecycle.on_timeout, "pause")

    def test_a_timeout_is_a_deadline_the_server_keeps_and_it_deletes(self):
        import time
        sbx = self.create(timeout=600)
        self.assertEqual((self.last_create()["timeout_seconds"], self.last_create()["on_lease_end"]), (600, "delete"))
        info = sbx.get_info()
        self.assertAlmostEqual(info.end_at.timestamp(), time.time() + 600, delta=5)
        self.assertEqual(info.lifecycle.on_timeout, "kill")
        sbx.set_timeout(1200)
        seconds = self.world.called("sandbox.extend")[-1][1]
        self.assertTrue(599 <= seconds <= 602, seconds)
        # An explicit on_timeout "kill" deletes too, with or without a timeout.
        self.create(lifecycle={"on_timeout": "kill"})
        self.assertEqual((self.last_create()["timeout_seconds"], self.last_create()["on_lease_end"]), (300, "delete"))

    def test_a_timeout_up_to_24_hours_is_sent_whole(self):
        # 5 October 2026: a 24-hour timeout was an hour's lease that this
        # process moved on every five minutes, so a create from a request
        # handler or a cron ended within the hour.
        sbx = self.create(timeout=86_400)
        self.assertEqual((self.last_create()["timeout_seconds"], self.last_create()["on_lease_end"]),
                         (86_400, "delete"))
        sbx.set_timeout(86_400)
        self.assertEqual(self.world.called("sandbox.extend"), [])  # the same end: nothing to move
        other = self.create(timeout=600)
        Sandbox.connect(other.sandbox_id, timeout=3 * 3600, client=self.world.client())
        self.assertGreater(self.world.called("sandbox.extend")[-1][1], 3 * 3600 - 610)

    def test_a_sandbox_the_server_keeps_running_has_no_end_to_move(self):
        sbx = self.create(runtime_create={"persistent": True})
        sbx.set_timeout(600)
        Sandbox.connect(sbx.sandbox_id, timeout=600, client=self.world.client())
        self.assertEqual(self.world.called("sandbox.extend"), [])
        # Its end is E2B's furthest, a day ahead, not where it is paid up to:
        # 5 October 2026, a pilot's read minutes ahead and looked about to end.
        import time
        self.assertAlmostEqual(sbx.get_info().end_at.timestamp(), time.time() + 86_400, delta=5)
        listed = Sandbox.list(client=self.world.client()).next_items()
        self.assertAlmostEqual(listed[0].end_at.timestamp(), time.time() + 86_400, delta=5)
        # A paused one keeps the time it stopped.
        sbx.pause()
        self.assertEqual(sbx.get_info().end_at.isoformat().replace("+00:00", "Z")[:19],
                         self.fake(sbx).info["expiresAt"][:19])

    def test_set_timeout_cannot_bring_the_end_sooner(self):
        sbx = self.create(timeout=600)
        with self.assertRaises(NotSupportedException) as caught:
            sbx.set_timeout(60)
        self.assertIn("kill()", str(caught.exception))

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
        # E2B's longest timeout is a day; past it is refused before anything happens.
        with self.assertRaises(InvalidArgumentException):
            self.create(timeout=86_401)
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_templates(self):
        from withruntime.e2b._core import TEMPLATE_LABEL
        self.create("base")
        self.assertNotIn("image", self.last_create())
        self.assertNotIn("labels", self.last_create())
        self.world.images.append({"id": "img-1", "name": "my-agent", "state": "ready"})
        # A name, with E2B's team and tag, goes to the create, which resolves it.
        for template, image in (("my-agent", "my-agent"), ("my-agent:v2", "my-agent:v2"),
                                ("acme/my-agent:v2", "my-agent:v2")):
            sbx = self.create(template, metadata={"job": "x"})
            self.assertEqual(self.last_create()["image"], image)
            self.assertEqual(self.last_create()["labels"], {"job": "x", TEMPLATE_LABEL: template})
            info = sbx.get_info()
            self.assertEqual((info.template_id, info.metadata), (template, {"job": "x"}))
        self.assertEqual(self.world.called("images.list"), [])
        paginator = Sandbox.list(query=SandboxQuery(template="acme/my-agent:v2"), client=self.world.client())
        self.assertEqual(len(paginator.next_items()), 1)
        # No room among 32 labels: the template goes unlabelled, metadata whole.
        full = {f"k{i}": "v" for i in range(32)}
        self.create("my-agent", metadata=full)
        self.assertEqual(self.last_create()["labels"], full)
        with self.assertRaises(TemplateException) as caught:
            self.create("abc123xyz:v1")
        self.assertIn("--name abc123xyz", str(caught.exception))
        self.assertEqual(caught.exception.code, "template_not_found")
        # It names the account the key belongs to: 5 October 2026, a
        # RUNTIME_API_KEY of another account looked like a missing image.
        self.assertIn('No Runtime image is named "abc123xyz:v1" in the account "Acme".', str(caught.exception))
        image = "11111111-2222-4333-8444-555555555555"
        self.world.images.append({"id": image, "name": None, "state": "ready"})
        self.create(image)
        self.assertEqual(self.last_create()["image"], image)
        uuid = "99999999-2222-4333-8444-555555555555"
        self.create(uuid)
        self.assertEqual(self.last_create(), {"snapshot": uuid, "timeout_seconds": 300, "on_lease_end": "pause",
                                              "labels": {TEMPLATE_LABEL: uuid}})
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
        # Never a quiet fall back to a saved login, which may be another account.
        with self.assertRaises(AuthenticationException) as caught:
            pick_key(None)
        self.assertIn("RUNTIME_API_KEY", str(caught.exception))
        with self.assertRaises(AuthenticationException):
            pick_key("e2b_abc")
        del os.environ["E2B_API_KEY"]
        self.assertIsNone(pick_key(None))

    def test_order(self):
        os.environ["RUNTIME_API_KEY"] = "rk_runtime"
        os.environ["E2B_API_KEY"] = "rk_other"
        self.assertEqual(pick_key(None), "rk_runtime")
        self.assertEqual(pick_key("e2b_abc"), "rk_runtime")
        self.assertEqual(pick_key("rk_given"), "rk_given")
        del os.environ["RUNTIME_API_KEY"]
        self.assertEqual(pick_key(None), "rk_other")

    def test_two_different_runtime_keys_are_said_once_and_errors_name_the_source(self):
        # 5 October 2026: a RUNTIME_API_KEY of another account silently beat
        # E2B_API_KEY, and the create failed as a missing image.
        import warnings
        from withruntime.e2b import _core
        _core._warned_two_keys = False
        with warnings.catch_warnings(record=True) as seen:
            warnings.simplefilter("always")
            os.environ["RUNTIME_API_KEY"] = os.environ["E2B_API_KEY"] = "rk_same"
            pick_key(None)
            os.environ["E2B_API_KEY"] = "e2b_left"
            pick_key(None)
            self.assertEqual(seen, [])
            os.environ["E2B_API_KEY"] = "rk_other"
            self.assertEqual(pick_key(None), "rk_same")
            pick_key(None)
        self.assertEqual(len(seen), 1)
        self.assertIn("RUNTIME_API_KEY and E2B_API_KEY hold different Runtime keys", str(seen[0].message))
        _core._warned_two_keys = False
        self.assertEqual(_core.key_source("rk_given"), "api_key")
        self.assertEqual(_core.key_source(None), "RUNTIME_API_KEY")
        del os.environ["RUNTIME_API_KEY"]
        self.assertEqual(_core.key_source(None), "E2B_API_KEY")
        del os.environ["E2B_API_KEY"]
        self.assertEqual(_core.key_source(None), "the saved login")
        self.assertEqual(_core.account_of({"orgId": "o", "orgName": "Acme"}, "RUNTIME_API_KEY"),
                         ' in the account "Acme" (key: RUNTIME_API_KEY)')
        self.assertEqual(_core.account_of(None, "RUNTIME_API_KEY"), "")


class Commands(Base):
    def test_result_cwd_envs_and_timeout(self):
        # The sandbox's envs are Runtime's to keep (its create's env); a
        # command's own go with the command, and Runtime puts them over the sandbox's.
        sbx = self.create(envs={"A": "1", "B": "2"})
        self.assertEqual(self.last_create()["env"], {"A": "1", "B": "2"})
        seen = []
        result = sbx.commands.run("echo hi", cwd="/tmp", envs={"B": "3"}, on_stdout=seen.append)
        self.assertEqual((result.exit_code, result.stdout, result.stderr, result.error), (0, "ran echo hi\n", "", None))
        self.assertEqual(seen, ["ran echo hi\n"])
        # Read from its first byte by the request that starts it, so Runtime
        # holds a fast writer back instead of dropping output before a read.
        self.assertEqual(self.world.called("sandbox.exec_stream")[-1],
                         ("echo hi", {"cwd": "/tmp", "env": {"B": "3"}, "timeout_ms": 86_400_000}))
        self.assertEqual(self.world.called("sandbox.spawn"), [])

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
        self.assertEqual(self.world.called("sandbox.exec_stream")[-1][1]["timeout_ms"], 86_400_000)
        self.world.exec = lambda *_: Result(None)
        with self.assertRaises(CommandExitException) as caught:
            sbx.commands.run("kill -9 $$")
        self.assertEqual((caught.exception.exit_code, caught.exception.error), (-1, "terminated by a signal"))

    def test_users_and_home(self):
        self.world.exec = as_users({})
        sbx = self.create()
        sbx.commands.run("id", user="root")
        self.assertEqual(self.world.called("sandbox.exec_stream")[-1][0],
                         ["sudo", "-n", "-E", "-H", "-u", "root", "--", "/bin/bash", "-c", "cd ~ 2>/dev/null\nid"])
        sbx.commands.run("id", user="app", cwd="/srv")
        self.assertEqual(self.world.called("sandbox.exec_stream")[-1][0][-1], "id")
        sbx.commands.run("id", user="app")
        self.assertEqual([call[0] for call in self.world.called("sandbox.exec")].count(["id", "-u", "--", "app"]), 1)
        with self.assertRaises(InvalidArgumentException) as caught:
            sbx.commands.run("id", user="ghost")
        self.assertIn('no user "ghost"', str(caught.exception))
        self.assertIn("useradd", str(caught.exception))
        with self.assertRaises(InvalidArgumentException):
            sbx.commands.run("id", user="a b")
        handle = sbx.commands.run("serve", user="root", background=True)
        self.assertEqual(self.world.called("sandbox.spawn")[-1][0][:6], ["sudo", "-n", "-E", "-H", "-u", "root"])
        handle.kill()
        sbx.commands.run("id", user="user")
        sbx.commands.run("cat /home/user/a")
        sbx.files.write("/home/user/b", "b")
        commands = [call[0] for call in self.world.called("sandbox.exec")]
        self.assertEqual(commands.count(HOME_LINK), 1)

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
        with self.assertRaisesRegex(SandboxException, "Sending stdin is not supported"):
            closed.send_stdin("x")
        opened = sbx.commands.run("cat", background=True, stdin=True)
        opened.send_stdin("hello\n")
        opened.close_stdin()
        process = self.fake(sbx).process_list[1]
        self.assertEqual(self.world.called("process.write"), [(process.id, "hello\n", False), (process.id, b"", True)])
        listed = sbx.commands.list()
        self.assertIn(opened.pid, [one.pid for one in listed])
        self.assertEqual((listed[0].cmd, listed[0].args), ("/bin/bash", ["-l", "-c", "cat"]))
        # As E2B starts each: /bin/bash -l -c and the customer's own script,
        # also through sudo for another user, and /bin/bash -i -l for a PTY
        # (5 October 2026: args were ["-c", "bash -c cat"]).
        from withruntime.e2b._core import command_as, listed_as, shell_as
        from e2b_fake import guest_command
        self.assertEqual(listed_as(guest_command(command_as("root", "npm run dev", False))),
                         ("/bin/bash", ["-l", "-c", "npm run dev"]))
        self.assertEqual(listed_as(guest_command(command_as("root", "a && b", True))), ("/bin/bash", ["-l", "-c", "a && b"]))
        self.assertEqual(listed_as(guest_command(shell_as("root", False))), ("/bin/bash", ["-i", "-l"]))
        self.assertEqual(listed_as(guest_command(["/bin/bash", "-i", "-l"])), ("/bin/bash", ["-i", "-l"]))
        self.assertEqual(listed_as("python3 -m http.server 8000"), ("python3", ["-m", "http.server", "8000"]))
        sbx.commands.send_stdin(opened.pid, "more")
        self.assertEqual(sbx.commands.connect(opened.pid).pid, opened.pid)
        self.assertTrue(sbx.commands.kill(opened.pid))
        self.assertEqual(process.killed, "SIGKILL")
        self.assertFalse(sbx.commands.kill(12345))


class SandboxGone(Base):
    def test_a_command_whose_sandbox_is_killed_under_it_fails_with_e2bs_timeout(self):
        # 5 October 2026, E2B's own suite: it was a SandboxNotFoundException.
        from e2b_fake import not_found
        sbx = self.create()
        self.world.output_error = not_found("not_found", "No sandbox with that id.")
        handle = sbx.commands.run("sleep 60", background=True)
        with self.assertRaisesRegex(TimeoutException, "ended before the stream completed"):
            handle.wait()


class Files(Base):
    def test_read_write(self):
        sbx = self.create()
        # 5 October 2026, E2B's own suite: a relative write came back as
        # /workspace/... where E2B gives /home/user/...
        info = sbx.files.write("notes/a.txt", "hello")
        self.assertEqual((info.name, info.type, info.path), ("a.txt", FileType.FILE, "/home/user/notes/a.txt"))
        self.assertEqual(sbx.files.get_info("./notes/a.txt").path, "/home/user/notes/a.txt")
        self.assertEqual([one.path for one in sbx.files.list("notes")], ["/home/user/notes/a.txt"])
        self.assertEqual(sbx.files.get_info("/workspace/notes/a.txt").path, "/workspace/notes/a.txt")
        self.assertEqual(sbx.files.rename("notes/a.txt", "notes/b.txt").path, "/home/user/notes/b.txt")
        sbx.files.rename("notes/b.txt", "notes/a.txt")
        # Asked once, after the first call: /home/user leads to /workspace.
        self.assertEqual([c[0] for c in self.world.called("sandbox.exec")].count(HOME_LINK), 1)
        self.assertEqual(sbx.files.read("/workspace/notes/a.txt"), "hello")
        self.assertEqual(sbx.files.read("notes/a.txt", format="bytes"), bytearray(b"hello"))
        self.assertEqual(b"".join(sbx.files.read("notes/a.txt", format="stream")), b"hello")
        written = sbx.files.write_files([{"path": "/workspace/b", "data": b"\x01"}, {"path": "c", "data": "c"}])
        self.assertEqual([one.path for one in written], ["/workspace/b", "/home/user/c"])

    def test_an_image_with_its_own_home_gets_workspace_paths_that_name_the_file(self):
        sbx = self.create()
        self.world.exec = lambda command, _: Result(0, "")
        self.assertEqual(sbx.files.write("a.txt", "a").path, "/workspace/a.txt")
        self.assertEqual(sbx.files.get_info("a.txt").path, "/workspace/a.txt")

    def test_list_info_dirs_rename_remove(self):
        sbx = self.create()
        sbx.files.write("/workspace/d/x.py", "print(1)")
        entry = sbx.files.list("/workspace/d")[0]
        self.assertEqual((entry.name, entry.type, entry.size, entry.mode, entry.permissions),
                         ("x.py", FileType.FILE, 8, 0o644, "-rw-r--r--"))
        self.assertEqual(self.world.called("files.list")[0][1], {"depth": 1, "hidden": True})
        with self.assertRaisesRegex(InvalidArgumentException, "^depth should be at least one$"):
            sbx.files.list("/workspace/d", depth=0)
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
        with self.assertRaises(NotSupportedException):
            sbx.files.write("/workspace/a", "a", metadata={"k": "v"})

    def test_files_as_another_user(self):
        # Refused before 2 October 2026; now run with sudo -u, creating no one.
        files = {"/etc/secret": b"s3cret"}
        self.world.exec = as_users(files)
        sbx = self.create()
        self.assertEqual(sbx.files.read("/etc/secret", user="root"), "s3cret")
        self.assertEqual(sbx.files.read("/etc/secret", format="bytes", user="root"), bytearray(b"s3cret"))
        with self.assertRaises(FileNotFoundException):
            sbx.files.read("/etc/none", user="root")
        info = sbx.files.write("/root/a.txt", "hello", user="root")
        self.assertEqual((info.path, files["/root/a.txt"]), ("/root/a.txt", b"hello"))
        entry = sbx.files.get_info("/root/a.txt", user="root")
        self.assertEqual((entry.name, entry.type, entry.size, entry.owner), ("a.txt", FileType.FILE, 5, "root"))
        self.assertTrue(sbx.files.exists("/root/a.txt", user="root"))
        sbx.files.remove("/root/a.txt", user="root")
        self.assertFalse(sbx.files.exists("/root/a.txt", user="root"))
        self.assertEqual(self.world.called("files.read") + self.world.called("files.write"), [])
        with self.assertRaises(InvalidArgumentException):
            sbx.files.read("/etc/secret", user="ghost")


class Lifecycle(Base):
    def test_kill_deletes(self):
        # E2B's kill destroys the sandbox. Until 5 October 2026 it was a stop,
        # which on Runtime keeps the disk: about 3 GiB booked per kill.
        sbx = self.create()
        self.assertTrue(sbx.kill())
        self.assertEqual(self.world.called("sandbox.delete"), [(sbx.sandbox_id,)])
        self.assertEqual(self.world.called("sandbox.stop"), [])
        self.assertNotIn(sbx.sandbox_id, self.world.sandboxes)
        self.assertFalse(sbx.kill())
        other = self.create()
        self.assertTrue(Sandbox.kill(other.sandbox_id, client=self.world.client()))
        self.assertFalse(other.is_running())
        self.assertFalse(Sandbox.kill(sbx.sandbox_id, client=self.world.client()))
        self.assertFalse(Sandbox.kill("nope", client=self.world.client()))

    def test_set_timeout(self):
        sbx = self.create(timeout=120)
        sbx.set_timeout(600)
        seconds = self.world.called("sandbox.extend")[0][1]
        self.assertTrue(479 <= seconds <= 482, seconds)
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
        self.assertEqual(self.world.called("sandbox.delete")[0][0], sbx.sandbox_id)

    def test_a_sandbox_runtime_paused_for_being_idle_is_running_to_e2b(self):
        # E2B never pauses an idle sandbox; Runtime does, and the next call
        # wakes it, so code written for E2B sees it running.
        sbx = self.create(metadata={"s": "idle"})
        self.fake(sbx).info.update(state="paused", stopReason="idle")
        self.assertTrue(sbx.is_running())
        self.assertEqual(sbx.get_info().state, "running")
        running = Sandbox.list(query=SandboxQuery(state=["running"]), client=self.world.client())
        self.assertEqual([one.sandbox_id for one in running.next_items()], [sbx.sandbox_id])
        paused = Sandbox.list(query=SandboxQuery(state=["paused"]), client=self.world.client())
        self.assertEqual(paused.next_items(), [])
        sbx.runtime.info["stopReason"] = "requested"
        self.assertFalse(sbx.is_running())


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
        with self.assertRaises(InvalidArgumentException):
            Sandbox.list(next_token="t", client=self.world.client())

    def test_template_start_order_and_next_token(self):
        # Refused before 2 October 2026; Runtime's list has none of these, so
        # the adapter reads every match once and filters, sorts and pages here.
        from datetime import datetime, timezone
        self.world.images.append({"id": "img-1", "name": "mine", "state": "ready"})
        a = self.create()
        b = self.create("mine")
        c = self.create("mine")
        self.fake(a).info["createdAt"] = "2026-09-01T00:00:00.000Z"
        self.fake(b).info["createdAt"] = "2026-09-02T00:00:00.000Z"
        self.fake(c).info["createdAt"] = "2026-09-03T00:00:00.000Z"

        def ids(**kwargs):
            paginator = Sandbox.list(client=self.world.client(), **kwargs)
            return [one.sandbox_id for one in paginator.next_items()], paginator

        self.assertEqual(ids(query=SandboxQuery(template="mine"))[0], [b.sandbox_id, c.sandbox_id])
        self.assertEqual(ids(query=SandboxQuery(template="base"))[0], [a.sandbox_id])
        self.assertEqual(ids(query=SandboxQuery(started_after=datetime(2026, 9, 2, tzinfo=timezone.utc)))[0],
                         [b.sandbox_id, c.sandbox_id])
        self.assertEqual(ids(order="desc")[0], [c.sandbox_id, b.sandbox_id, a.sandbox_id])
        first, paginator = ids(order="desc", limit=2)
        self.assertEqual((first, paginator.has_next), ([c.sandbox_id, b.sandbox_id], True))
        self.assertEqual(ids(order="desc", limit=2, next_token=paginator.next_token)[0], [a.sandbox_id])


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

    def test_e2b_2_52_fork_count_and_http_version(self):
        # e2b 2.52.0 (1 October 2026) bounds a fork's count to 1..20 before
        # sending, and takes http_version ("1.1" or "2", or E2B_HTTP_VERSION).
        from unittest import mock
        sbx = self.create(http_version="1.1")
        looked_up = len(self.world.called("sandboxes.get"))
        for bad in (0, 21, 1.5, True):
            with self.assertRaises(InvalidArgumentException) as caught:
                sbx.fork(count=bad)
            self.assertEqual(str(caught.exception), "count must be an integer between 1 and 20")
            with self.assertRaises(InvalidArgumentException):
                Sandbox.fork(sbx.sandbox_id, count=bad, client=self.world.client())
        self.assertEqual((self.world.called("sandbox.fork"), len(self.world.called("sandboxes.get"))), ([], looked_up))
        self.assertEqual(len(sbx.fork(count=20)), 20)
        with self.assertRaises(InvalidArgumentException):
            self.create(http_version="3")
        with mock.patch.dict(os.environ, {"E2B_HTTP_VERSION": "h3"}):
            with self.assertRaises(InvalidArgumentException) as caught:
                self.create()
            self.assertIn("E2B_HTTP_VERSION", str(caught.exception))

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

    def test_get_host_on_the_trial_names_the_address_that_works(self):
        # Live, 2 October 2026: on a trial sandbox get_host raised
        # AuthenticationException (the 403 refusing a public share), while
        # Node warned and handed back a host that answered 404.
        self.world.funding = "trial"
        sbx = self.create()
        for call in (sbx.get_host, sbx.get_public_host):
            with self.assertRaises(e2b.PublicPreviewNotAllowedException) as caught:
                call(3000)
            self.assertIsInstance(caught.exception, NotSupportedException)
            self.assertNotIsInstance(caught.exception, AuthenticationException)
            self.assertIn("urlWithToken", str(caught.exception))
        self.assertEqual(self.world.called("previews.create"), [])

    def test_a_refused_public_share_is_not_an_authentication_error(self):
        # The sandbox's funding changed after it was read: Runtime's 403 is
        # still the trial refusal, not a bad key.
        self.world.refuse_public = True
        sbx = self.create()
        with self.assertRaises(e2b.PublicPreviewNotAllowedException):
            sbx.get_public_host(3000)

    def test_gaps(self):
        sbx = self.create()
        for call in (lambda: sbx.git, sbx.update_network, sbx.upload_url,
                     sbx.download_url, sbx.get_mcp_token, e2b.Template, lambda: e2b.Volume.create("v"),
                     lambda: e2b.Secret.create("s"), lambda: e2b.wait_for_port(3000)):
            with self.assertRaises(NotSupportedException):
                call()
        with self.assertRaises(NotSupportedException) as caught:
            e2b.Secret.create("s")
        self.assertIn("withruntime secrets set", str(caught.exception))


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
        world.output = lambda command: output_events(world.exec(command, {}))

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
            self.assertEqual(world.called("sandbox.delete")[0][0], sbx.sandbox_id)
            # The sandbox's envs went with its create, not with each command.
            self.assertEqual(world.called("sandboxes.create")[0][0]["env"], {"A": "1"})
            self.assertIsNone(world.called("sandbox.spawn")[0][1]["env"])

        asyncio.run(scenario())

    def test_async_users_long_timeouts_and_the_trial_host(self):
        from withruntime.e2b import PtySize
        from withruntime.e2b import _async_sandbox as async_sandbox
        world = World()
        world.funding = "trial"
        world.exec = as_users({"/etc/secret": b"s3cret"})
        world.output = lambda command: output_events(Result(0, "ran\n"))

        async def scenario():
            sbx = await AsyncSandbox.create(timeout=7200, client=world.async_client())
            # The whole two hours, kept by the server: no timer in this process.
            self.assertEqual(world.called("sandboxes.create")[0][0]["timeout_seconds"], 7200)
            self.assertEqual((await sbx.commands.run("id", user="root")).stdout, "ran\n")
            self.assertEqual(world.called("sandbox.exec_stream")[-1][0][:6], ["sudo", "-n", "-E", "-H", "-u", "root"])
            self.assertEqual(await sbx.files.read("/etc/secret", user="root"), "s3cret")
            with self.assertRaises(InvalidArgumentException):
                await sbx.commands.run("id", user="ghost")
            await sbx.pty.create(PtySize(20, 80), lambda _: None, user="app", cwd="/srv")
            self.assertEqual(world.called("sandbox.spawn")[-1][0],
                             ["sudo", "-n", "-E", "-H", "-u", "app", "--", "/bin/bash", "-c", "exec /bin/bash -i -l"])
            with self.assertRaises(e2b.PublicPreviewNotAllowedException):
                sbx.get_host(3000)
            self.assertTrue(await sbx.kill())
            self.assertEqual(world.called("sandbox.delete"), [(sbx.sandbox_id,)])
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
