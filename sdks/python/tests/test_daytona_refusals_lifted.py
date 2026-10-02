"""Calls the Daytona adapter once refused and now carries out: PTY sessions,
running as another Linux user, autoStop past an hour (or never), computer use
over Runtime's desktop, and list filters and sorting. Sync and async."""
import asyncio
import base64
import os
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2b_fake  # noqa: E402
from dropin_fake import DropInSandbox, DropInWorld  # noqa: E402
from e2b_fake import FakeProcess, Result, _iso  # noqa: E402

from withruntime.daytona import (AsyncDaytona, CreateSandboxFromSnapshotParams, Daytona,  # noqa: E402
                                 DaytonaNotFoundError, DaytonaValidationError, ListSandboxesQuery,
                                 NotSupportedError, PtySize, ScreenshotOptions)


class FakeTerminal:
    """Runtime's terminal attached to a process: what it printed, then the end."""

    def __init__(self, world: Any, process_id: str, output: List[bytes], exit_code: Optional[int]) -> None:
        self._w, self.process_id = world, process_id
        self._output = list(output)
        self.exit_code = exit_code

    def recv(self) -> Optional[bytes]:
        return self._output.pop(0) if self._output else None

    def write(self, data: Any) -> None:
        self._w.record("terminal.write", self.process_id, data)

    def resize(self, cols: int, rows: int) -> None:
        self._w.record("terminal.resize", self.process_id, cols, rows)

    def close(self) -> None:
        self._w.record("terminal.close", self.process_id)


class FakeRecordings:
    def __init__(self, world: Any) -> None:
        self._w = world

    def start(self, **_: Any) -> Dict[str, Any]:
        self._w.record("recordings.start")
        return {"id": "rec-1", "state": "recording", "path": "/tmp/desktop/rec-1.mp4", "startedAt": 1_790_000_000_000}

    def stop(self, recording_id: str) -> Dict[str, Any]:
        return {"id": recording_id, "state": "finished", "path": "/tmp/desktop/rec-1.mp4",
                "startedAt": 1_790_000_000_000, "seconds": 12.5, "bytes": 4096}

    def list(self) -> List[Dict[str, Any]]:
        return [self.stop("rec-1")]

    def download(self, recording_id: str) -> bytes:
        return b"mp4 bytes"


def png_of(width: int, height: int) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x06\0\0\0"


class FakeDesktop:
    def __init__(self, world: Any) -> None:
        self._w = world
        self.recordings = FakeRecordings(world)
        self.running = True

    def __getattr__(self, name: str) -> Any:
        def act(*args: Any, **kwargs: Any) -> Any:
            if name == "cursor" and not self.running:
                raise e2b_fake.withruntime.ConflictError("The desktop is not running.", code="desktop_not_running",
                                                          status=409)
            self._w.record("desktop." + name, *args, *(f"{k}={v}" for k, v in kwargs.items()))
            return {"cursor": {"x": 5, "y": 6}, "windows": [{"id": "77", "title": "Chromium", "x": 0, "y": 0,
                                                              "width": 800, "height": 600}],
                    "screenshot": png_of(1280, 800)}.get(name, {})
        return act


def _terminal(self: Any, process_id: Optional[str] = None, **_: Any) -> FakeTerminal:
    self._w.record("sandbox.terminal", process_id)
    return FakeTerminal(self._w, process_id or "", getattr(self._w, "pty_output", [b"$ "]),
                        getattr(self._w, "pty_exit", 0))


def _resize(self: Any, cols: int, rows: int) -> None:
    self._w.record("process.resize", self.id, cols, rows)


def _desktop(self: Any) -> FakeDesktop:
    if not hasattr(self, "_desktop_fake"):
        self._desktop_fake = FakeDesktop(self._w)
    return self._desktop_fake


_spawn = DropInSandbox.spawn


def _spawn_argv(self: Any, command: Any, **options: Any) -> FakeProcess:
    """As Runtime lists it, a process's command is its argv joined by spaces."""
    process = _spawn(self, command, **options)
    if isinstance(command, list):
        process.info["command"] = " ".join(command)
    return process


DropInSandbox.spawn = _spawn_argv  # type: ignore[method-assign]
DropInSandbox.terminal = _terminal  # type: ignore[attr-defined]
DropInSandbox.desktop = property(_desktop)  # type: ignore[attr-defined]
FakeProcess.resize = _resize  # type: ignore[attr-defined]
e2b_fake._WRAPPED = e2b_fake._WRAPPED + (FakeTerminal, FakeDesktop, FakeRecordings)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.world = DropInWorld()
        self.daytona = Daytona(client=self.world.client())
        self.made: List[Any] = []

    def tearDown(self) -> None:
        for sandbox in self.made:
            sandbox._end_keeping()

    def create(self, params: Optional[CreateSandboxFromSnapshotParams] = None) -> Any:
        sandbox = self.daytona.create(params)
        self.made.append(sandbox)
        return sandbox

    def argvs(self, method: str = "sandbox.exec") -> List[Any]:
        return [call[0] for call in self.world.called(method)]


class Pty(Base):
    def test_create_attach_send_and_wait(self):
        sandbox = self.create()
        self.world.pty_output = [b"$ ", b"hello\r\n"]
        seen: List[bytes] = []
        handle = sandbox.process.create_pty_session("dev", cwd="app", envs={"A": "1"},
                                                    pty_size=PtySize(rows=30, cols=100))
        argv, options = self.world.called("sandbox.spawn")[-1]
        self.assertEqual(argv[:4], ["bash", "-l", "-i", "-s"])
        self.assertEqual(argv[-1], "100x30")
        self.assertEqual(options["pty"], {"cols": 100, "rows": 30})
        self.assertEqual(options["cwd"], "/workspace/app")
        self.assertEqual(options["env"], {"TERM": "xterm-256color", "A": "1"})
        handle.send_input("ls\n")
        self.assertEqual(self.world.called("terminal.write")[-1][1], "ls\n")
        result = handle.wait(on_data=seen.append)
        self.assertEqual(b"".join(seen), b"$ hello\r\n")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(handle.exit_code, 0)

    def test_list_info_resize_reconnect_and_kill(self):
        sandbox = self.create()
        sandbox.process.create_pty_session("one").disconnect()
        listed = sandbox.process.list_pty_sessions()
        self.assertEqual([(one.id, one.cols, one.rows, one.active) for one in listed], [("one", 80, 24, True)])
        info = sandbox.process.resize_pty_session("one", PtySize(rows=40, cols=120))
        self.assertEqual((info.cols, info.rows), (120, 40))
        self.assertEqual(self.world.called("process.resize")[-1][1:], (120, 40))
        again = sandbox.process.connect_pty_session("one")
        self.assertEqual(again.session_id, "one")
        self.assertEqual(self.world.called("sandbox.terminal")[-1][0], "proc-1")
        sandbox.process.kill_pty_session("one")
        self.assertEqual(self.world.called("process.kill")[-1], ("proc-1", "SIGKILL"))
        self.assertEqual(sandbox.process.list_pty_sessions(), [])
        with self.assertRaises(DaytonaNotFoundError):
            sandbox.process.get_pty_session_info("one")


class User(Base):
    def test_a_user_from_the_image_runs_commands_and_owns_files(self):
        sandbox = self.create(CreateSandboxFromSnapshotParams(os_user="alice"))
        self.assertEqual(sandbox.user, "alice")
        self.assertEqual(self.world.called("sandboxes.create")[-1][0]["labels"]["compat.daytona-user"], "alice")
        ready = self.argvs()[0]
        self.assertEqual(ready[:2], ["sh", "-c"])
        self.assertIn("usermod -aG runtime", ready[2])
        self.assertEqual(ready[-1], "alice")
        sandbox.process.exec("whoami", env={"B": "2"})
        self.assertEqual(self.argvs()[-1][:9], ["sudo", "-u", "alice", "-H", "--", "env", "B=2", "sh", "-c"])
        sandbox.fs.upload_file(b"hi", "notes.txt")
        self.assertEqual(self.argvs()[-1], ["sudo", "chown", "alice", "--", "/workspace/notes.txt"])
        # Found again by id, the sandbox still runs as the user.
        found = self.daytona.get(sandbox.id)
        self.assertEqual(found.user, "alice")

    def test_a_user_missing_from_the_image_ends_the_sandbox_and_says_how(self):
        self.world.exec = lambda command, _: Result(3, "", "")
        with self.assertRaises(DaytonaValidationError) as caught:
            self.daytona.create(CreateSandboxFromSnapshotParams(os_user="bob"))
        self.assertIn("useradd -m bob", str(caught.exception))
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)
        with self.assertRaises(DaytonaValidationError):
            self.daytona.create(CreateSandboxFromSnapshotParams(os_user="Bob; rm -rf /"))


class AutoStop(Base):
    def test_two_hours_idle_renews_while_calls_come_and_stops_after(self):
        sandbox = self.create(CreateSandboxFromSnapshotParams(auto_stop_interval=120))
        self.assertEqual(self.world.called("sandboxes.create")[-1][0]["timeout_seconds"], 3600)
        self.assertIsNotNone(sandbox._timer)
        runtime = sandbox.withruntime
        now = time.time()
        runtime.info["expiresAt"] = _iso(now + 600)
        sandbox._tick()
        self.assertAlmostEqual(_seconds(runtime.info["expiresAt"]), now + 3600, delta=3)
        # Nothing since the last call for two hours: the lease is left to end.
        sandbox._last_active = now - 7200
        runtime.info["expiresAt"] = _iso(now + 60)
        extends = len(self.world.called("sandbox.extend"))
        sandbox._tick()
        self.assertEqual(len(self.world.called("sandbox.extend")), extends)

    def test_zero_never_stops_while_the_object_lives(self):
        sandbox = self.create(CreateSandboxFromSnapshotParams(auto_stop_interval=0))
        runtime = sandbox.withruntime
        sandbox._last_active = time.time() - 86_400
        runtime.info["expiresAt"] = _iso(time.time() + 60)
        sandbox._tick()
        self.assertAlmostEqual(_seconds(runtime.info["expiresAt"]), time.time() + 3600, delta=3)
        sandbox.delete()
        self.assertIsNone(sandbox._timer)


def _seconds(stamp: str) -> float:
    from datetime import datetime
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


class ComputerUse(Base):
    def test_mouse_keyboard_screen_and_windows(self):
        use = self.create().computer_use
        self.assertEqual(use.start().status, {"desktop": {"running": True}})
        self.assertEqual(use.get_status().status, "active")
        self.assertEqual((use.mouse.click(10, 20, "right").x, use.mouse.get_position().y), (10, 6))
        use.mouse.drag(1, 2, 3, 4)
        use.mouse.drag(1, 2, 3, 4, "middle")
        self.assertTrue(use.mouse.scroll(5, 5, "up", 3))
        use.keyboard.press("enter", ["ctrl", "cmd"])
        use.keyboard.hotkey("ctrl+shift+pageup")
        use.keyboard.type("hi", 30)
        calls = [call[0] for call in self.world.calls if call[0].startswith("desktop.")]
        self.assertIn(("desktop.drag", (1, 2), (3, 4)), self.world.calls)
        self.assertIn(("desktop.mouse_down", "middle"), self.world.calls)
        self.assertIn(("desktop.scroll", -3, "x=5", "y=5"), self.world.calls)
        self.assertIn(("desktop.press", "ctrl+super+Return"), self.world.calls)
        self.assertIn(("desktop.press", "ctrl+shift+Prior"), self.world.calls)
        self.assertIn(("desktop.type", "hi", "delay_ms=30"), self.world.calls)
        self.assertIn("desktop.click", calls)
        shot = use.screenshot.take_full_screen()
        self.assertEqual(base64.b64decode(shot.screenshot), png_of(1280, 800))
        self.assertEqual(shot.size_bytes, len(png_of(1280, 800)))
        use.screenshot.take_compressed(ScreenshotOptions(fmt="jpeg", quality=60))
        self.assertIn(("desktop.screenshot", "format=jpeg", "quality=60"), self.world.calls)
        display = use.display.get_info().displays[0]
        self.assertEqual((display.width, display.height), (1280, 800))
        self.assertEqual(use.display.get_windows().windows[0].id, 77)
        for refused in (lambda: use.screenshot.take_compressed(ScreenshotOptions(fmt="webp")),
                        lambda: use.screenshot.take_full_screen(show_cursor=True),
                        lambda: use.accessibility.get_tree(), lambda: use.get_process_status("xvfb")):
            with self.assertRaises(NotSupportedError):
                refused()

    def test_recordings_and_status(self):
        sandbox = self.create()
        use = sandbox.computer_use
        started = use.recording.start("demo")
        self.assertEqual((started.status, started.file_name, started.end_time), ("recording", "rec-1.mp4", None))
        done = use.recording.stop("rec-1")
        self.assertEqual((done.status, done.duration_seconds, done.size_bytes), ("completed", 12.5, 4096))
        self.assertTrue(done.end_time.endswith("Z"))
        self.assertEqual(len(use.recording.list().recordings), 1)
        with tempfile.TemporaryDirectory() as folder:
            target = os.path.join(folder, "out", "demo.mp4")
            use.recording.download("rec-1", target)
            self.assertEqual(Path(target).read_bytes(), b"mp4 bytes")
        sandbox.withruntime.desktop.running = False
        self.assertEqual(use.get_status().status, "inactive")


class Listing(Base):
    def test_filters_and_sort_apply_to_every_sandbox(self):
        for name, vcpu in (("web-b", 2), ("api", 4), ("Web-a", 1), ("web-c", 8)):
            self.create(CreateSandboxFromSnapshotParams(name=name))
            self.world.sandboxes[self.made[-1].id].info["vcpu"] = vcpu
        names = lambda query: [one.name for one in self.daytona.list(query)]  # noqa: E731
        self.assertEqual(names(ListSandboxesQuery(name="web", sort="name", order="asc")), ["Web-a", "web-b", "web-c"])
        self.assertEqual(names(ListSandboxesQuery(min_cpu=2, max_cpu=4, sort="cpu")), ["api", "web-b"])
        self.assertEqual(names(ListSandboxesQuery(sort="cpu", limit=1)), ["web-c", "api", "web-b", "Web-a"])
        self.assertEqual(names(ListSandboxesQuery(targets=["eu"])), [])
        with self.assertRaises(NotSupportedError):
            names(ListSandboxesQuery(is_public=True))
        with self.assertRaises(ValueError):
            names(ListSandboxesQuery(sort="size"))


class Async(unittest.TestCase):
    def test_pty_user_computer_use_and_autostop_in_async(self):
        world = DropInWorld()
        world.pty_output = [b"ok\r\n"]

        async def scenario():
            daytona = AsyncDaytona(client=world.async_client())
            sandbox = await daytona.create(CreateSandboxFromSnapshotParams(os_user="alice", auto_stop_interval=0))
            self.assertEqual(sandbox.user, "alice")
            self.assertIsNotNone(sandbox._timer)
            seen: List[bytes] = []

            async def on_data(data: bytes) -> None:
                seen.append(data)
            handle = await sandbox.process.create_pty_session("t", on_data)
            result = await handle.wait()
            self.assertEqual((b"".join(seen), result.exit_code), (b"ok\r\n", 0))
            spawned = world.called("sandbox.spawn")[-1][0]
            self.assertEqual(spawned[:3], ["sudo", "-u", "alice"])
            await sandbox.computer_use.mouse.click(1, 2)
            self.assertIn(("desktop.click", 1, 2, "button=left", "double=False"), world.calls)
            self.assertEqual([one.name async for one in daytona.list(ListSandboxesQuery(sort="name"))],
                             [sandbox.name])
            await sandbox.delete()
            self.assertIsNone(sandbox._timer)
        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
