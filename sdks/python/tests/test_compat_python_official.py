"""Differential tests against installed, exactly pinned official SDK packages.

Opt in with RUNTIME_COMPAT_OFFICIAL=1 in an isolated environment containing the
six pinned wheels. Every vendor transport is controlled locally; an outbound
socket connection is a test failure. These are SDK contract tests, not service
acceptance against competitor infrastructure.
"""
import asyncio
import importlib.metadata
import io
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from test_compat_new_providers import Base
from test_compat_python_processes import LocalProcess, LocalSandbox
from e2b_fake import Result
from compatibility_pins import validate_pins
from withruntime.runloop import ExecutionResult, Runloop
from withruntime.prime import models as runtime_models
from withruntime.modal import ContainerProcess
from withruntime.sprites import SpritesClient

ENABLED = os.environ.get("RUNTIME_COMPAT_OFFICIAL") == "1"


@unittest.skipUnless(ENABLED, "Install pinned official SDKs and set RUNTIME_COMPAT_OFFICIAL=1")
class Official(Base):
    @classmethod
    def setUpClass(cls):
        validate_pins(installed_version=importlib.metadata.version)

    @classmethod
    def tearDownClass(cls):
        # The pinned Sprites sync runner owns a background loop. Its public
        # stop_loop joins the thread but does not close the selector/socket
        # pair; release that test-created loop after all consumer comparisons.
        import sprites.loop as upstream_loop
        loop = upstream_loop.get_existing_loop()
        upstream_loop.stop_loop()
        if loop is not None:
            loop.close()

    def setUp(self):
        super().setUp()
        blocker = patch.object(socket.socket, "connect", side_effect=AssertionError("Vendor network is forbidden in differential tests"))
        blocker.start()
        self.addCleanup(blocker.stop)

    def test_runloop_execution_result_properties_tails_and_pending_exit(self):
        from runloop_api_client.sdk import ExecutionResult as OfficialResult
        from runloop_api_client.types import DevboxAsyncExecutionDetailView
        for exit_code in (0, 7, None):
            for text in ("", "a\nb\n", "a\n\nb\n\n", "こんにちは\n"):
                raw = DevboxAsyncExecutionDetailView(devbox_id="box", execution_id="exec", status="completed",
                    exit_status=exit_code, stdout=text, stderr="error", stdout_truncated=False, stderr_truncated=False)
                official = OfficialResult(None, "box", raw)
                runtime = ExecutionResult(None, "box", raw)
                self.assertEqual((runtime.devbox_id, runtime.execution_id, runtime.exit_code, runtime.success, runtime.failed),
                                 (official.devbox_id, official.execution_id, official.exit_code, official.success, official.failed))
                for count in (None, -1, 0, 1, 2, 10):
                    self.assertEqual(runtime.stdout(count), official.stdout(count))
                self.assertEqual(runtime.stderr(), official.stderr())
                self.assertIs(runtime.result, raw)

    def test_runloop_rest_public_consumer_with_http_transport(self):
        import httpx
        from runloop_api_client import Runloop as OfficialClient
        requests = []
        def handle(request):
            requests.append(request)
            if request.url.path.endswith("/execute_sync"):
                return httpx.Response(200, json={"devbox_id": "box", "execution_id": "exec", "status": "completed",
                    "exit_status": 3, "stdout": "hello", "stderr": "bad"})
            return httpx.Response(200, json={"id": "box", "name": "contract", "status": "running"})
        official = OfficialClient(bearer_token="local-test", base_url="https://official.invalid",
                                  http_client=httpx.Client(transport=httpx.MockTransport(handle)), max_retries=0)
        runtime = Runloop(runtime=self.client)
        one = official.devboxes.create(name="contract", environment_variables={"A": "b"})
        two = runtime.devboxes.create(name="contract", environment_variables={"A": "b"})
        self.assertEqual((two.name, two.status), (one.name, one.status))
        self.world.exec = lambda *args: Result(exit_code=3, stdout="hello", stderr="bad")
        a = official.devboxes.execute_sync(one.id, command="echo hello; exit 3")
        b = runtime.devboxes.execute_sync(two.id, command="echo hello; exit 3")
        self.assertEqual((b.exit_status, b.stdout, b.stderr), (a.exit_status, a.stdout, a.stderr))
        self.assertTrue(requests)
        official.close()

    def test_runloop_actual_wait_rejects_suspended_without_resuming(self):
        import httpx
        from runloop_api_client import Runloop as OfficialClient
        status = "running"
        requests = []
        def response(request):
            requests.append(request)
            return httpx.Response(200, json={"id": "box", "status": status})
        official = OfficialClient(bearer_token="local-test", base_url="https://official.invalid",
            http_client=httpx.Client(transport=httpx.MockTransport(response)), max_retries=0)
        runtime = Runloop(runtime=self.client)
        box = runtime.devboxes.create()
        native = self.world.sandboxes[box.id]
        def outcome(client, box_id):
            try:
                return "result", client.devboxes.await_running(box_id).status
            except Exception as error:
                return type(error).__name__, str(error)
        try:
            for status in ("running", "suspended", "shutdown"):
                native.info["state"] = "running" if status == "running" else "stopped"
                native.info["labels"] = {"compat.provider": "runloop", **({"compat.runloop.suspended": "true"} if status == "suspended" else {})}
                before = len(self.world.calls)
                self.assertEqual(outcome(runtime, box.id), outcome(official, "box"))
                self.assertTrue(all(call[0] == "sandboxes.get" for call in self.world.calls[before:]))
            self.assertTrue(all(request.url.path.endswith("/wait_for_status") for request in requests))
        finally:
            official.close()

    def test_prime_response_models_aliases_and_defaults(self):
        from prime_sandboxes import models as official_models
        fixtures = {
            "BackgroundJob": {"job_id": "1234abcd", "sandbox_id": "box", "stdout_log_file": "/tmp/out", "stderr_log_file": "/tmp/err", "exit_file": "/tmp/exit"},
            "BackgroundJobStatus": {"job_id": "1234abcd", "completed": False},
            "CommandResponse": {"stdout": "hi", "stderr": "", "exit_code": 3},
            "ReadFileResponse": {"content": "hello", "size": 5},
            "FileUploadResponse": {"success": True, "path": "/tmp/a", "size": 5, "timestamp": "2026-09-29T00:00:00+00:00"},
            "SandboxListResponse": {"sandboxes": [], "total": 0, "page": 1, "perPage": 50, "hasNext": False},
            "Sandbox": {"id": "box", "name": "contract", "dockerImage": "python:3.12", "cpuCores": 1., "memoryGB": 2., "diskSizeGB": 8.,
                "diskMountPath": "/workspace", "gpuCount": 0, "status": "RUNNING", "timeoutMinutes": 60,
                "createdAt": "2026-09-29T00:00:00+00:00", "updatedAt": "2026-09-29T00:00:00+00:00"},
        }
        for name, data in fixtures.items():
            a = getattr(official_models, name)(**data)
            b = getattr(runtime_models, name)(**data)
            for aliases in (False, True):
                for exclude in (False, True):
                    self.assertEqual(b.model_dump(by_alias=aliases, exclude_none=exclude),
                                     a.model_dump(by_alias=aliases, exclude_none=exclude), name)

    def test_sprites_official_websocket_frames_and_result_errors(self):
        from sprites import SpritesClient as OfficialClient
        import sprites.websocket as websocket
        from sprites.exceptions import ExitError as OfficialExit
        client = OfficialClient(token="local-test", base_url="https://official.invalid")
        sprite = SpritesClient(runtime=self.client).create_sprite("contract")
        for code in (0, 7):
            class Socket:
                async def send(self, data): pass
                async def close(self): pass
                def __aiter__(self): return self.events()
                async def events(self):
                    yield b"\x01hello"
                    yield b"\x02bad"
                    yield bytes([3, code])
            async def connect(*args, **kwargs): return Socket()
            self.world.exec = lambda *args: Result(exit_code=code, stdout="hello", stderr="bad")
            with patch.object(websocket, "connect", connect):
                def outcome(command):
                    try: return ("result", command.combined_output())
                    except Exception as error: return ("error", error.exit_code(), error.stdout, error.stderr)
                self.assertEqual(outcome(sprite.command("program")), outcome(client.sprite("contract").command("program")))
        client.close()

    def test_sprites_default_run_error_output_matches(self):
        from sprites import SpritesClient as OfficialClient
        import sprites.websocket as websocket
        class Socket:
            async def send(self, data): pass
            async def close(self): pass
            def __aiter__(self): return self.events()
            async def events(self):
                yield b"\x01out"
                yield b"\x02err"
                yield b"\x03\x07"
        async def connect(*args, **kwargs): return Socket()
        official = OfficialClient(token="local-test", base_url="https://official.invalid")
        sprite = SpritesClient(runtime=self.client).create_sprite("contract")
        self.world.exec = lambda *args: Result(exit_code=7, stdout="out", stderr="err")
        def outcome(sprite, capture, check):
            try:
                result = sprite.run("program", capture_output=capture, check=check)
                return result.returncode, result.stdout, result.stderr
            except Exception as error:
                return "error", error.exit_code(), error.stdout, error.stderr
        with patch.object(websocket, "connect", connect):
            for capture in (False, True):
                for check in (False, True):
                    self.assertEqual(outcome(sprite, capture, check), outcome(official.sprite("contract"), capture, check))
        official.close()

    def test_modal_official_stream_reader_binary_and_utf8_chunks(self):
        import modal.io_streams as upstream
        params = upstream._StreamReaderThroughSandboxExecCommandRouterParams(
            file_descriptor=1, task_id="task", object_id="process", command_router_client=None, deadline=None)
        cases = [(False, False, [b"\x00\xff", b"\x80hello"]),
                 (True, False, [b"\xe3", b"\x81\x82\n", b"last"]),
                 (True, True, [b"one\npar", b"tial\nlast"])]
        for text, lines, chunks in cases:
            async def transport(_params, offset=0):
                position = 0
                for chunk in chunks:
                    position += len(chunk)
                    yield chunk, position
            class Process:
                def output_bytes(self):
                    for chunk in chunks: yield {"type": "stdout", "data": chunk}
                    yield {"type": "exit", "exitCode": 0}
            with patch.object(upstream, "_stdio_stream_from_command_router", transport):
                async def make_reader():
                    return upstream._StreamReader(params, text=text, by_line=lines)
                # Modal constructs its public reader on its synchronization
                # loop. Use the same factory boundary, then its public methods.
                official = upstream.synchronizer.create_blocking(make_reader)()
                runtime = ContainerProcess(Process(), text=text, bufsize=1 if lines else -1, binary_transport=True)
                # Chunk boundaries are not contractual; bytes, lines and EOF are.
                if lines:
                    self.assertEqual(list(runtime.stdout), list(official))
                else:
                    self.assertEqual(runtime.stdout.read(), official.read())
                self.assertEqual(runtime.stdout.read(), official.read())

    def test_prime_actual_rpc_process_bytes_cancellation_and_signals(self):
        from prime_sandboxes.process import AsyncSandboxProcess as OfficialProcess
        from prime_sandboxes._proto.command_session import command_session_pb2 as proto
        from withruntime.prime.process import AsyncSandboxProcess as RuntimeProcess
        async def exercise(official):
            queue, writes, signals = asyncio.Queue(), [], []
            async def events():
                if official:
                    start = proto.StartResponse()
                    start.event.start.pid = 123
                    yield start
                while True:
                    kind, value = await queue.get()
                    if official:
                        event = proto.StartResponse()
                        if kind == "exit":
                            event.event.end.exit_code = value
                        else:
                            setattr(event.event.data, kind, value)
                    else:
                        event = {"type": kind, "exitCode" if kind == "exit" else "data": value}
                    yield event
                    if kind == "exit":
                        return
            async def write(data):
                writes.append(data)
                await queue.put(("stdout", b"reply:" + data))
            async def signal(value):
                signals.append(value)
                await queue.put(("stderr", b"\xff\x80"))
                await queue.put(("exit", 137))
            async def close(): pass
            if official:
                process = await OfficialProcess._create(SimpleNamespace(close=close), events(), write, signal)
            else:
                process = RuntimeProcess(SimpleNamespace(info={"pid": 123}, output_bytes=events, write=write,
                    kill=lambda value: signal({"SIGTERM": "terminate", "SIGKILL": "kill"}[value])))
            try:
                pending = asyncio.create_task(process.wait())
                await asyncio.sleep(0)
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                self.assertIsNone(process.returncode)
                await process.write_stdin(b"\x00\x80input")
                output = await anext(process.stdout)
                await process.kill()
                code = await process.wait()
                stderr = b"".join([chunk async for chunk in process.stderr])
                with self.assertRaises(BrokenPipeError):
                    await process.write_stdin(b"late")
                return process.pid, output, stderr, code, writes, signals
            finally:
                await process.aclose()
        async def run():
            self.assertEqual(await exercise(False), await exercise(True))
        asyncio.run(run())

    def test_sprites_actual_http_label_update_and_model_defaults(self):
        import httpx
        from dataclasses import asdict
        from sprites import SpritesClient as OfficialClient
        from sprites.types import SpriteInfo as OfficialInfo
        from withruntime.sprites.types import SpriteInfo
        self.assertEqual(asdict(SpriteInfo("id", "name", "org", "running")),
                         asdict(OfficialInfo("id", "name", "org", "running")))
        requests = []
        def request(value):
            requests.append(value)
            import json
            return httpx.Response(200, json={"id": "id", "name": "one", "status": "running",
                "labels": json.loads(value.content)["labels"]})
        official = OfficialClient(token="local-test", base_url="https://official.invalid")
        official._client.close()
        official._client = httpx.Client(transport=httpx.MockTransport(request))
        runtime = SpritesClient(runtime=self.client)
        runtime.create_sprite("one", labels=["old"])
        try:
            for labels in (["one", "two"], []):
                a = official.sprite("one").update(labels=labels)
                b = runtime.sprite("one").update(labels=labels)
                self.assertEqual((a.name, a.status, a.labels), (b.name, b.status, b.labels))
            self.assertEqual(len(requests), 2)
        finally:
            official.close()

    def test_prime_close_after_stream_failure_escalates_failed_termination(self):
        from prime_sandboxes.process import AsyncSandboxProcess as OfficialProcess
        from prime_sandboxes.core import APIError as OfficialError
        from prime_sandboxes._proto.command_session import command_session_pb2 as proto
        from withruntime.prime.process import AsyncSandboxProcess as RuntimeProcess
        from withruntime.prime.exceptions import APIError as RuntimeError
        async def exercise(official):
            signals = []
            error = OfficialError if official else RuntimeError
            async def events():
                if official:
                    start = proto.StartResponse()
                    start.event.start.pid = 123
                    yield start
                raise error("stream disconnected")
            async def signal(value):
                signals.append(value)
                if value == "terminate":
                    raise OSError("termination request failed")
            async def noop(*args): pass
            if official:
                process = await OfficialProcess._create(SimpleNamespace(close=noop), events(), noop, signal)
            else:
                process = RuntimeProcess(SimpleNamespace(info={"pid": 123}, output_bytes=events, write=noop,
                    kill=lambda value: signal({"SIGTERM": "terminate", "SIGKILL": "kill"}[value])))
            with self.assertRaises(error):
                await process.wait()
            await process.aclose()
            await process.aclose()
            with self.assertRaises(error):
                await process.wait()
            return signals, process.returncode
        async def run():
            native = await exercise(False)
            self.assertEqual(native, await exercise(True))
            self.assertEqual(native, (["terminate", "kill"], None))
        asyncio.run(run())

    def test_modal_actual_filesystem_binary_write_read_validation_and_missing_file(self):
        import json
        from modal.sandbox_fs import _SandboxFilesystem as OfficialFilesystem
        from withruntime.modal._fs_async import AsyncFilesystem
        from withruntime._errors import RuntimeError as NativeError
        class Read:
            def __init__(self, value): self.value = value
            async def read(self): return self.value
        class Container:
            async def exec(self, tool, encoded, **kwargs):
                operation, options = next(iter(json.loads(encoded).items()))
                target = Path(options["path"])
                code, stdout, stderr = 0, b"", b""
                if operation == "ReadFile":
                    try: stdout = target.read_bytes()
                    except FileNotFoundError:
                        code, stderr = 1, json.dumps({"error_kind": "NotFound", "message": "missing"}).encode()
                elif operation != "WriteFile":
                    raise AssertionError(operation)
                if kwargs.get("text", True):
                    stdout, stderr = stdout.decode("utf-8"), stderr.decode("utf-8")
                async def write_stream(source):
                    data = source.read()
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    return len(data)
                async def wait(): return code
                return SimpleNamespace(stdout=Read(stdout), stderr=Read(stderr), wait=wait,
                                       _stdin_write_stream=write_stream)
        class NativeFiles:
            async def write(self, path, data):
                target = Path(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            async def read(self, path):
                try: return Path(path).read_bytes()
                except FileNotFoundError as error:
                    raise NativeError("missing", code="file_not_found", status=404) from error
        async def run():
            container = Container()
            official = OfficialFilesystem(container)
            runtime = AsyncFilesystem(SimpleNamespace(files=NativeFiles()))
            with tempfile.TemporaryDirectory() as directory:
                results = []
                for number, fs in enumerate((official, runtime)):
                    path = str(Path(directory, str(number), "binary"))
                    payload = bytes(range(256)) * 5000
                    await fs.write_bytes(memoryview(payload), path)
                    results.append(await fs.read_bytes(path))
                    for operation, args in (("read_bytes", (path + ".missing",)),
                                            ("read_bytes", ("relative/path",)),
                                            ("write_bytes", ("not bytes", path)),
                                            ("read_text", (path,))):
                        try:
                            await getattr(fs, operation)(*args)
                        except Exception as error:
                            results.append(type(error).__name__)
                        else:
                            self.fail(f"{operation} should reject the invalid request")
                self.assertEqual(results[:5], results[5:])
        asyncio.run(run())

    def test_e2b_async_pty_bytes_and_open_deadline_use_official_rpc_contract(self):
        from packaging.version import Version
        from protobuf import Oneof
        from e2b.connection_config import ConnectionConfig
        from e2b.envd.process import process_pb as pb
        from e2b.sandbox_async.commands.pty import Pty as OfficialPty
        from withruntime.e2b import AsyncPty, PtySize
        async def run():
            sent, options, closed = [], [], []
            payload = bytes(range(256))
            class RPC:
                def start(self, request, **kwargs):
                    sent.append((request, kwargs))
                    async def events():
                        try:
                            yield pb.StartResponse(event=pb.ProcessEvent(event=Oneof("start", pb.ProcessEvent.StartEvent(pid=42))))
                            await asyncio.sleep(.03)
                            yield pb.StartResponse(event=pb.ProcessEvent(event=Oneof("data", pb.ProcessEvent.DataEvent(output=Oneof("pty", payload)))))
                            yield pb.StartResponse(event=pb.ProcessEvent(event=Oneof("end", pb.ProcessEvent.EndEvent(exit_code=0))))
                        finally: closed.append("official")
                    return events()
            official = object.__new__(OfficialPty)
            official._rpc, official._envd_version = RPC(), Version("0.6.0")
            official._connection_config = ConnectionConfig(request_timeout=60)
            async def health(): return True
            official._check_health = health
            class Process:
                id = "process"
                info = {"id": id, "outputEncoding": "base64"}
                async def output_bytes(self, **kwargs):
                    try:
                        await asyncio.sleep(.03)
                        yield {"type": "stdout", "data": payload}
                        yield {"type": "exit", "exitCode": 0}
                    finally: closed.append("runtime")
            async def spawn(argv, **kwargs):
                options.append((argv, kwargs))
                return Process()
            async def home(_): pass
            runtime = AsyncPty(SimpleNamespace(runtime=SimpleNamespace(spawn=spawn), _envs={}, _ensure_home=home))
            outputs = []
            for pty in (official, runtime):
                chunks = []
                handle = await pty.create(PtySize(rows=33, cols=91), chunks.append, timeout=0,
                                          request_timeout=.01, envs={"TERM": "custom"})
                result = await handle.wait()
                outputs.append((result.exit_code, result.stdout, result.stderr, result.error, chunks))
            self.assertEqual(outputs[0], outputs[1])
            self.assertEqual(outputs[0][-1], [payload])
            request, kwargs = sent[0]
            self.assertEqual(options[0][0], [request.process.cmd, *request.process.args])
            self.assertEqual(options[0][1]["env"], dict(request.process.envs))
            self.assertEqual(options[0][1]["pty"], {"rows": request.pty.size.rows, "cols": request.pty.size.cols})
            self.assertIsNone(kwargs["timeout_ms"])
            self.assertNotIn("timeout_ms", options[0][1])
            self.assertEqual(sorted(closed), ["official", "runtime"])
        asyncio.run(run())

    def test_e2b_stream_reader_context_close_and_timeout_types(self):
        import httpx
        from e2b.sandbox.filesystem.filesystem import FileStreamReader as OfficialReader, AsyncFileStreamReader as OfficialAsyncReader
        from withruntime.e2b._sync_io import FileStreamReader
        from withruntime.e2b._async_io import AsyncFileStreamReader
        from withruntime._request_scope import limits
        closed = []
        class Body(httpx.SyncByteStream):
            def __iter__(self): yield b"\x00\xff"
            def close(self): closed.append("official")
        class Response:
            headers = {"content-length": "2"}
            def chunks(self): yield b"\x00\xff"
            def close(self): closed.append("runtime")
        for reader in (OfficialReader(httpx.Response(200, stream=Body())), FileStreamReader(Response(), limits())):
            with reader as stream:
                self.assertEqual(next(stream), b"\x00\xff")
            reader.close()
        self.assertEqual(closed, ["official", "runtime"])
        async def run():
            class Body(httpx.AsyncByteStream):
                async def __aiter__(self):
                    yield b"first"
                    await asyncio.sleep(2)
                async def aclose(self): closed.append("official-async")
            class Response:
                headers = {}
                async def chunks(self):
                    yield b"first"
                    await asyncio.sleep(2)
                async def close(self): closed.append("runtime-async")
            readers = (OfficialAsyncReader(httpx.Response(200, stream=Body()), idle_timeout=.01),
                       AsyncFileStreamReader(Response(), limits(idle_timeout=.01)))
            for reader in readers:
                async with reader as stream:
                    self.assertEqual(await stream.__anext__(), b"first")
                    with self.assertRaises(httpx.ReadTimeout): await stream.__anext__()
                await reader.aclose()
        asyncio.run(run())
        self.assertEqual(closed, ["official", "runtime", "official-async", "runtime-async"])

    def test_e2b_interpreter_result_models_and_chart_payloads(self):
        from e2b_code_interpreter.models import Result as OfficialResult, Execution as OfficialExecution, Logs as OfficialLogs
        from withruntime.e2b.code_interpreter._models import Result, Execution, Logs
        chart = {"type": "pie", "title": "Example", "elements": [{"label": "one", "angle": .5, "radius": 1}]}
        for data in ({}, {"text": "2", "html": "<b>2</b>", "json": {"ok": True}, "is_main_result": True},
                     {"data": {"columns": ["a"]}, "chart": chart}):
            official, runtime = OfficialResult(**data), Result(**data)
            self.assertEqual((list(runtime.formats()), str(runtime), runtime._repr_html_(), runtime._repr_json_()),
                             (list(official.formats()), str(official), official._repr_html_(), official._repr_json_()))
            if data.get("chart"):
                self.assertEqual(runtime.chart.to_dict(), official.chart.to_dict())
                self.assertEqual(vars(runtime.chart.elements[0]), vars(official.chart.elements[0]))
            one = OfficialExecution(results=[official], logs=OfficialLogs(stdout=["hello\n"], stderr=["warn\n"]))
            two = Execution(results=[runtime], logs=Logs(stdout=["hello\n"], stderr=["warn\n"]))
            self.assertEqual(two.to_json(), one.to_json())
            self.assertEqual(two.text, one.text)

    def test_e2b_interpreter_public_run_code_matches_official_stream_parser(self):
        import httpx
        import json
        from e2b_code_interpreter import AsyncSandbox as OfficialSandbox
        from withruntime.e2b.code_interpreter import AsyncSandbox
        from e2b_fake import World
        async def run():
            records = []
            def reply(request):
                records.append(request)
                lines = [{"type": "stdout", "text": "out\n", "timestamp": 123},
                         {"type": "stderr", "text": "warn\n", "timestamp": 124},
                         {"type": "result", "text": "2", "html": "<b>2</b>", "is_main_result": True},
                         {"type": "number_of_executions", "execution_count": 4}]
                return httpx.Response(200, text="\n".join(map(json.dumps, lines)))
            client = httpx.AsyncClient(transport=httpx.MockTransport(reply))
            official = SimpleNamespace(connection_config=SimpleNamespace(request_timeout=60), sandbox_id="owned",
                _envd_access_token=None, traffic_access_token=None, _client=client, _include_diagnostics=False,
                _jupyter_request_url=lambda _: "https://official.invalid/execute")
            world = World()
            world.interpreter = lambda *_: {"status": "ok", "stdout": "out\n", "stderr": "warn\n", "error": None,
                "executionCount": 4, "results": [{"main": True, "data": {"text/plain": "2", "text/html": "<b>2</b>"}}]}
            runtime = await AsyncSandbox.create(template="base", client=world.async_client())
            try:
                expected = await OfficialSandbox.run_code(official, "1+1")
                actual = await runtime.run_code("1+1")
                self.assertEqual((actual.text, actual.logs.stdout, actual.logs.stderr, actual.execution_count),
                                 (expected.text, expected.logs.stdout, expected.logs.stderr, expected.execution_count))
                self.assertEqual(actual.results[0].formats(), list(expected.results[0].formats()))
                self.assertEqual(records[0].extensions["timeout"]["read"], 300)
                self.assertEqual(world.called("interpreter.run")[0][1]["timeout_ms"], 0)
            finally: await client.aclose()
        asyncio.run(run())

    def test_e2b_sync_pty_iterator_and_wait_callback_match_published_signature(self):
        from packaging.version import Version
        from protobuf import Oneof
        from e2b.connection_config import ConnectionConfig
        from e2b.envd.process import process_pb as pb
        from e2b.sandbox_sync.commands.pty import Pty as OfficialPty
        from withruntime.e2b import Pty, PtySize
        payload = bytes(range(256))
        closed = []
        class RPC:
            def start(self, request, **kwargs):
                def events():
                    try:
                        yield pb.StartResponse(event=pb.ProcessEvent(event=Oneof("start", pb.ProcessEvent.StartEvent(pid=42))))
                        yield pb.StartResponse(event=pb.ProcessEvent(event=Oneof("data", pb.ProcessEvent.DataEvent(output=Oneof("pty", payload)))))
                        yield pb.StartResponse(event=pb.ProcessEvent(event=Oneof("end", pb.ProcessEvent.EndEvent(exit_code=0))))
                    finally: closed.append("official")
                return events()
        official = object.__new__(OfficialPty)
        official._rpc, official._envd_version = RPC(), Version("0.6.0")
        official._connection_config, official._check_health = ConnectionConfig(), lambda: True
        class Process:
            id, info = "process", {"outputEncoding": "base64"}
            def output_bytes(self, **kwargs):
                try:
                    yield {"type": "stdout", "data": payload}
                    yield {"type": "exit", "exitCode": 0}
                finally: closed.append("runtime")
        native = SimpleNamespace(spawn=lambda *a, **kw: Process())
        runtime = Pty(SimpleNamespace(runtime=native, _envs={}, _ensure_home=lambda _: None))
        results = []
        for pty in (official, runtime):
            handle = pty.create(PtySize(rows=24, cols=80), timeout=0, request_timeout=.001)
            errors = []
            for operation in (lambda: handle.send_stdin('x'), handle.close_stdin):
                try: operation()
                except Exception as error: errors.append((type(error).__name__, str(error)))
            outputs = list(handle)
            result = handle.wait()
            seen = []
            second = pty.create(PtySize(rows=24, cols=80), timeout=0)
            second.wait(on_pty=seen.append)
            results.append((outputs, result.stdout, result.stderr, result.exit_code, seen, errors))
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0][0], [(None, None, payload)])
        self.assertEqual(sorted(closed), ["official", "official", "runtime", "runtime"])

    def test_runloop_official_snapshot_wrapper_and_metadata_updates(self):
        import httpx
        import json
        from runloop_api_client import Runloop as OfficialClient
        from runloop_api_client.sdk.devbox import Devbox as OfficialDevbox
        from withruntime.runloop import RunloopSDK
        from test_compat_python_disk_snapshots import World
        from withruntime.runloop import _snapshots
        world = World()
        actual = RunloopSDK(runtime=world.runtime).devbox.from_id('source').snapshot_disk(
            name='checkpoint', metadata={'branch': 'main'}, commit_message='preserve files')
        value = dict(_snapshots.view(world.saved[actual.id]))
        requests = []
        def transport(request):
            requests.append((request.method, request.url.path))
            if request.url.path.endswith('/status'):
                return httpx.Response(200, json={'status': 'complete', 'error_message': None, 'snapshot': value})
            if request.url.path.endswith('/snapshot_disk_async'):
                return httpx.Response(200, json=value)
            if request.method == 'POST':
                value.update(json.loads(request.content))
                return httpx.Response(200, json=value)
            raise AssertionError(request.url.path)
        official = OfficialClient(bearer_token='reference-fixture', max_retries=0, http_client=httpx.Client(transport=httpx.MockTransport(transport)))
        try:
            reference = OfficialDevbox(official, 'source').snapshot_disk(
                name='checkpoint', metadata={'branch': 'main'}, commit_message='preserve files')
            self.assertEqual(actual.get_info().model_dump(), reference.get_info().model_dump())
            self.assertEqual(actual.update(name='renamed').model_dump(), reference.update(name='renamed').model_dump())
            self.assertIn(('POST', '/v1/devboxes/source/snapshot_disk_async'), requests)
        finally: official.close()

    def test_modal_official_filesystem_snapshot_returns_hydrated_image_with_exact_ttl(self):
        from modal.sandbox import _Sandbox as OfficialSandbox
        from withruntime.modal import Sandbox as RuntimeSandbox
        from test_compat_python_disk_snapshots import World
        async def run():
            requests = []
            async def snapshot(request, **options):
                requests.append((request, options))
                return SimpleNamespace(image_id='im-snapshot')
            async def task_id(): return 'task'
            async def router(_): return SimpleNamespace(snapshot_filesystem=snapshot)
            official = SimpleNamespace(_is_v2=True, _client=SimpleNamespace(), _get_task_id=task_id,
                                       _get_command_router_client=router)
            async def perform(timeout, *, ttl):
                return await OfficialSandbox._snapshot_filesystem(official, timeout, ttl=ttl)
            official._snapshot_filesystem = perform
            world = World()
            async def native_snapshot(**options): return world.source.snapshot(**options)
            box = RuntimeSandbox(world.runtime, SimpleNamespace(id='source', snapshot=native_snapshot))
            box._async_mode = True
            for ttl in (30 * 86400, 86400):
                expected = await OfficialSandbox.snapshot_filesystem(official, timeout=12, ttl=ttl)
                actual = await box.snapshot_filesystem.aio(timeout=12, ttl=ttl)
                self.assertEqual(actual.object_id, expected.object_id)
                self.assertEqual(requests[-1][0].ttl_seconds, world.calls[-1][1]['retention_days'] * 86400)
                self.assertEqual(requests[-1][1]['timeout'], 12.0)
        asyncio.run(run())
