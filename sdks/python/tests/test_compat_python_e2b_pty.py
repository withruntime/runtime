"""Ordinary terminal consumers against real owned local PTYs."""
import asyncio
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from test_compat_python_processes import LocalProcess
from withruntime.e2b import AsyncPty, Pty, PtySize, TimeoutException
from withruntime._request_scope import current
from withruntime._errors import RuntimeError as NativeError


class Process:
    def __init__(self, argv, options, home):
        options["env"] = {**os.environ, **options["env"], "HOME": home, "PS1": "owned> "}
        self.local = LocalProcess(argv, **options)
        self.id = self.local.id
        self.info = {**self.local.info, "state": "running", "stdinOpen": True, "outputBytes": 0,
                     "pty": options["pty"]}
        self.resize(**options["pty"])
        self.events, self.opened, self.closed = [], 0, 0
        self.condition = threading.Condition()
        self.thread = threading.Thread(target=self._pump)
        self.thread.start()

    def _pump(self):
        for event in self.local.output_bytes():
            with self.condition:
                event = {**event, "offset": self.info["outputBytes"]}
                self.info["outputBytes"] += len(event.get("data", b""))
                if event["type"] == "exit": self.info["state"] = "exited"
                self.events.append(event)
                self.condition.notify_all()

    def output_bytes(self, cursor=0, timeout_seconds=None):
        until = None if timeout_seconds is None else time.monotonic() + timeout_seconds
        index = 0
        try:
            while True:
                with self.condition:
                    while index >= len(self.events):
                        remaining = None if until is None else until - time.monotonic()
                        if remaining is not None and remaining <= 0: raise TimeoutError("connection expired")
                        self.condition.wait(remaining)
                    event = self.events[index]
                    index += 1
                if event["type"] == "exit":
                    yield event
                    return
                if event["offset"] >= cursor: yield event
        finally:
            self.closed += 1

    def write(self, data, eof=False): self.local.write(data.encode() if isinstance(data, str) else data, eof=eof)
    def kill(self, signal="SIGTERM"): self.local.kill(signal)
    def resize(self, cols, rows):
        import fcntl, termios
        fcntl.ioctl(self.local._master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    def cleanup(self):
        self.local.kill("SIGKILL")
        self.thread.join(5)
        if self.thread.is_alive(): raise AssertionError("Owned PTY reader did not stop")


class Native:
    def __init__(self, home): self.home, self.processes_by_id, self.options = home, {}, []
    def spawn(self, argv, **options):
        self.options.append((argv, options.copy()))
        process = Process(argv, options, self.home)
        self.processes_by_id[process.id] = process
        return process
    def processes(self): return [p.info for p in self.processes_by_id.values()]
    def process(self, process_id): return self.processes_by_id[process_id]
    def cleanup(self):
        for process in self.processes_by_id.values(): process.cleanup()


class AsyncProcess:
    def __init__(self, source): self.source, self.id, self.info = source, source.id, source.info
    async def write(self, *args, **kwargs): self.source.write(*args, **kwargs)
    async def kill(self, *args, **kwargs): self.source.kill(*args, **kwargs)
    async def resize(self, *args, **kwargs): self.source.resize(*args, **kwargs)
    async def output_bytes(self, cursor=0, timeout_seconds=None):
        if current().deadline is not None: raise AssertionError("creation deadline leaked into terminal subscription")
        until = None if timeout_seconds is None else time.monotonic() + timeout_seconds
        index = 0
        self.source.opened += 1
        try:
            while True:
                if until is not None and time.monotonic() >= until: raise TimeoutError("connection expired")
                if index >= len(self.source.events):
                    await asyncio.sleep(.001)
                    continue
                event = self.source.events[index]
                index += 1
                if event["type"] == "exit":
                    yield event
                    return
                if event["offset"] >= cursor: yield event
        finally:
            self.source.closed += 1


class AsyncNative(Native):
    async def spawn(self, *args, **kwargs): return AsyncProcess(super().spawn(*args, **kwargs))
    async def processes(self): return super().processes()
    async def process(self, process_id): return AsyncProcess(super().process(process_id))


class PtyConsumer(unittest.TestCase):
    def test_sync_terminal_resize_input_bytes_and_result(self):
        with tempfile.TemporaryDirectory() as home:
            native = Native(home)
            pty = Pty(SimpleNamespace(runtime=native, _envs={}, _ensure_home=lambda _: None))
            seen = []
            try:
                handle = pty.create(PtySize(rows=20, cols=80), request_timeout=.2)
                pty.resize(handle.pid, PtySize(rows=31, cols=97))
                pty.send_stdin(handle.pid, b"stty size; printf '\\377'; exit 0\n")
                result = handle.wait(on_pty=seen.append)
                self.assertEqual((result.exit_code, result.stdout, result.stderr), (0, "", ""))
                self.assertIn(b"31 97", b"".join(seen))
                self.assertIn(b"\xff", b"".join(seen))
                self.assertEqual(native.options[0][0], ["/bin/bash", "-i", "-l"])
                self.assertNotIn("timeout_ms", native.options[0][1])
                self.assertEqual(native.options[0][1]["output_encoding"], "base64")
                self.assertFalse(pty.kill(handle.pid))
            finally:
                native.cleanup()

    def test_async_timeout_disconnect_and_reconnect_preserve_real_shell(self):
        async def run(home):
            native = AsyncNative(home)
            async def ensure(_): pass
            pty = AsyncPty(SimpleNamespace(runtime=native, _envs={}, _ensure_home=ensure))
            seen = []
            try:
                # Long enough that the subscription opens before the deadline on a
                # loaded machine; a deadline that passes first never subscribes.
                handle = await pty.create(PtySize(20, 80), seen.append, timeout=.5, request_timeout=.2)
                with self.assertRaises(TimeoutException): await handle.wait()
                process = next(iter(native.processes_by_id.values()))
                self.assertIsNone(process.local._p.poll())
                self.assertEqual((process.opened, process.closed), (1, 1))
                final = await pty.connect(handle.pid, seen.append, timeout=0, request_timeout=.2)
                await pty.send_stdin(final.pid, b"printf '\\200done'; exit\n")
                self.assertEqual((await final.wait()).exit_code, 0)
                self.assertIn(b"\x80done", b"".join(seen))
                self.assertEqual((process.opened, process.closed), (2, 2))
            finally:
                native.cleanup()
        with tempfile.TemporaryDirectory() as home: asyncio.run(run(home))

    def test_invalid_dimensions_and_native_capability_refusal(self):
        attempts = []
        def refuse(*args, **kwargs):
            attempts.append(kwargs)
            self.assertEqual(kwargs["output_encoding"], "base64")
            raise NativeError("Guest lacks binary output", code="unsupported_operation", status=409)
        pty = Pty(SimpleNamespace(runtime=SimpleNamespace(spawn=refuse), _envs={}, _ensure_home=lambda _: None))
        with self.assertRaises(Exception): pty.create(PtySize(0, 80))
        self.assertEqual(attempts, [])
        with self.assertRaisesRegex(Exception, "binary output"):
            pty.create(PtySize(20, 80))
        self.assertEqual(len(attempts), 1)
