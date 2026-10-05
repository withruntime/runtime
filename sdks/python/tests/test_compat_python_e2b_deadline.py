"""E2B connection deadlines through the native HTTP stream, with real children.

The local peer retains process output independently of a subscription. A client
timeout may close the socket, but must never send a process signal.

The client's deadline is half a second and the child runs for a second and a
half, so the request reaches the peer and the deadline ends while the child
runs, even on a loaded machine.
With 30 ms against 0.4 s, a full check on 3 October 2026 (load 24) timed out
before the peer's thread had started the child, and the test read a child that
did not exist yet.
"""
import asyncio
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import unittest

# The client's deadline, and how long the child runs: far apart on purpose.
DEADLINE_S = 0.5
CHILD_S = 1.5

from withruntime._sync_client import _Transport, Process, Sandbox
from withruntime._async_client import _Transport as AsyncTransport, AsyncProcess, AsyncSandbox
from withruntime.e2b._sync_sandbox import Commands
from withruntime.e2b._async_sandbox import AsyncCommands
from withruntime.e2b import TimeoutException
from withruntime.e2b._core import pid_of


class Deadline(unittest.TestCase):
    def setUp(self):
        self.completed = threading.Event()
        self.started = threading.Event()
        self.job = None
        self.collector = None
        self.payload = b""
        self.requests = []
        owner = self
        class Peer(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                owner.requests.append(("GET", self.path))
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.flush()
                if not owner.completed.wait(5):
                    return
                events = [{"type": "stdout", "data": owner.payload.decode(), "offset": 0},
                          {"type": "exit", "exitCode": owner.job.returncode, "timedOut": False}]
                try:
                    for event in events:
                        self.wfile.write((json.dumps(event) + "\n").encode())
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def do_POST(self):
                owner.requests.append(("POST", self.path))
                if not self.path.endswith(":exec"):
                    self.send_response(500)
                    self.end_headers()
                    return
                # A command waited on is started by a streamed exec, read from
                # its first byte; the same child as a spawned one.
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                owner.start_child()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.wfile.write((json.dumps({"type": "start", "processId": "local-process"}) + "\n").encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                if not owner.completed.wait(5):
                    return
                try:
                    for event in [{"type": "stdout", "data": owner.payload.decode(), "offset": 0},
                                  {"type": "exit", "exitCode": owner.job.returncode, "timedOut": False}]:
                        self.wfile.write((json.dumps(event) + "\n").encode())
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
        self.server_thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01))
        self.server_thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        if self.job is not None:
            if not self.completed.wait(5):
                self.job.kill()
            self.collector.join(5)
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(3)

    def start_child(self):
        self.job = subprocess.Popen([sys.executable, "-c", f"import time;time.sleep({CHILD_S});print('finished')"],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.started.set()
        def collect():
            self.payload, _ = self.job.communicate()
            self.completed.set()
        self.collector = threading.Thread(target=collect)
        self.collector.start()
        return {"id": "local-process", "state": "running", "stdinOpen": False, "outputBytes": 0}

    def commands(self, asynchronous=False):
        transport = (AsyncTransport if asynchronous else _Transport)("local-test", self.origin, 2, 0)
        owner = self
        class Native:
            def spawn(self, command, **options):
                owner.spawn_options = options
                self.process_handle = (AsyncProcess if asynchronous else Process)(transport, "local-sandbox", owner.start_child())
                return self.process_handle
            def exec_stream(self, command, **options):
                owner.spawn_options = options
                self.process_handle = (AsyncProcess if asynchronous else Process)(
                    transport, "local-sandbox", {"id": "local-process", "state": "running"})
                return (AsyncSandbox if asynchronous else Sandbox)(transport, {"id": "local-sandbox"}).exec_stream(
                    command, **options)
            def processes(self): return [self.process_handle.info]
            def process(self, process_id): return self.process_handle
        class NativeAsync(Native):
            async def spawn(self, *args, **kwargs): return super().spawn(*args, **kwargs)
            async def processes(self): return super().processes()
            async def process(self, *args): return super().process(*args)
        async def home_async(_): pass
        native = NativeAsync() if asynchronous else Native()
        sandbox = SimpleNamespace(runtime=native, _envs={}, _ensure_home=home_async if asynchronous else lambda _: None)
        return (AsyncCommands if asynchronous else Commands)(sandbox), transport

    def assert_not_killed(self):
        # E2B's timeout is the connection's, never the process's: a waited-on
        # command is given Runtime's longest life (a day), a background one none.
        # The peer starts the child on its own thread, which a loaded machine
        # may run after the client has already given up waiting.
        self.assertTrue(self.started.wait(5), "the exec never reached the peer")
        self.assertIsNone(self.job.poll())
        self.assertIn(self.spawn_options.get("timeout_ms"), (None, 86_400_000))
        self.assertFalse(any(method == "POST" and not path.endswith(":exec") for method, path in self.requests))

    def test_sync_timeout_disconnects_and_reconnect_completes(self):
        commands, transport = self.commands()
        try:
            with self.assertRaises(TimeoutException):
                commands.run("local child", timeout=DEADLINE_S)
            self.assert_not_killed()
            result = commands.connect(pid_of("local-process"), timeout=0).wait()
            self.assertEqual((result.stdout, result.exit_code), ("finished\n", 0))
            self.assert_not_killed() if self.job.poll() is None else None
        finally:
            transport.close()

    def test_background_deadline_starts_before_wait(self):
        commands, transport = self.commands()
        try:
            handle = commands.run("local child", background=True, timeout=0.01)
            time.sleep(0.03)
            with self.assertRaises(TimeoutException):
                handle.wait()
            self.assert_not_killed()
            result = commands.connect(handle.pid, timeout=None).wait()
            self.assertEqual(result.stdout, "finished\n")
        finally:
            transport.close()

    def test_async_timeout_and_cancel_do_not_kill_process(self):
        async def run():
            commands, transport = self.commands(asynchronous=True)
            try:
                with self.assertRaises(TimeoutException):
                    await commands.run("local child", timeout=DEADLINE_S)
                self.assert_not_killed()
                handle = await commands.connect(pid_of("local-process"), timeout=0)
                waiter = asyncio.create_task(handle.wait())
                await asyncio.sleep(0.01)
                waiter.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await waiter
                self.assert_not_killed()
                final = await commands.connect(handle.pid, timeout=0)
                self.assertEqual((await final.wait()).stdout, "finished\n")
            finally:
                await transport.close()
        asyncio.run(run())
