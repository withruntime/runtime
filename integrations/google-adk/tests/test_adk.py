"""The executor and the toolset against fake Runtime clients; nothing leaves the machine."""

import asyncio
import gc

import pytest
from google.adk.code_executors.code_execution_utils import CodeExecutionInput, File
from withruntime import CommandResult

from google_adk_withruntime import RuntimeCodeExecutor, RuntimeToolset


class FakeFiles:
    def __init__(self):
        self.data = {}

    def write(self, path, content):
        self.data[path] = content


class FakeSandbox:
    def __init__(self, fields, result):
        self.id, self.fields, self.result = "sbx_1", fields, result
        self.files, self.commands, self.stopped, self.kept_alive = FakeFiles(), [], False, None

    def exec(self, command, **options):
        self.commands.append((command, options))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def keep_alive(self, margin_seconds=600, **_):
        self.kept_alive = margin_seconds

    def stop(self, wait=True):
        self.stopped = True


class FakeRuntime:
    def __init__(self, result=None):
        self.sandboxes, self.made, self.got = self, [], []
        self.result = result or CommandResult(exit_code=0, stdout="4\n", stderr="")

    def create(self, **fields):
        self.made.append(FakeSandbox(fields, self.result))
        return self.made[-1]

    def get(self, sandbox_id):
        self.got.append(sandbox_id)
        return FakeSandbox({"id": sandbox_id}, self.result)


def run(executor, code, files=()):
    return executor.execute_code(None, CodeExecutionInput(code=code, input_files=list(files)))


def test_runs_each_block_with_python3_in_one_lazily_started_sandbox():
    runtime = FakeRuntime()
    executor = RuntimeCodeExecutor(runtime=runtime, create={"vcpu": 2}, timeout_seconds=30)
    assert runtime.made == []
    first = run(executor, "print(2 + 2)", [File(name="data.csv", content="a,b\n1,2\n")])
    run(executor, "print('again')")
    sandbox = runtime.made[0]
    assert len(runtime.made) == 1
    assert (first.stdout, first.stderr, first.exit_code) == ("4\n", "", 0)
    assert sandbox.commands[0] == (["python3", "-c", "print(2 + 2)"], {"cwd": "/workspace", "timeout_ms": 30_000})
    assert sandbox.files.data == {"/workspace/data.csv": "a,b\n1,2\n"}
    assert sandbox.fields["vcpu"] == 2 and sandbox.fields["on_lease_end"] == "stop"
    assert sandbox.fields["timeout_seconds"] == 1800 and sandbox.fields["labels"] == {"created_by": "google-adk"}
    assert sandbox.kept_alive == 600
    executor.close()
    executor.close()
    assert sandbox.stopped


def test_timeout_is_124_with_a_note_and_a_signal_is_128_plus_n():
    runtime = FakeRuntime(CommandResult(exit_code=-9, stdout="partial", stderr="", timed_out=True))
    result = run(RuntimeCodeExecutor(runtime=runtime, timeout_seconds=5), "while True: pass")
    assert result.exit_code == 124 and result.stdout == "partial"
    assert "ran past 5 seconds" in result.stderr
    runtime = FakeRuntime(CommandResult(exit_code=-15, stdout="", stderr=""))
    assert run(RuntimeCodeExecutor(runtime=runtime), "import os; os.kill(os.getpid(), 15)").exit_code == 143


def test_an_api_error_is_reported_to_the_model_not_raised():
    runtime = FakeRuntime(ConnectionError("reset"))
    result = run(RuntimeCodeExecutor(runtime=runtime), "print(1)")
    assert "reset" in result.stderr and result.exit_code is None


def test_an_existing_sandbox_is_used_and_never_stopped():
    runtime = FakeRuntime()
    executor = RuntimeCodeExecutor(runtime=runtime, sandbox_id="sbx_mine")
    run(executor, "print(1)")
    executor.close()
    assert runtime.got == ["sbx_mine"] and runtime.made == []


def test_garbage_collection_stops_the_sandbox():
    runtime = FakeRuntime()
    executor = RuntimeCodeExecutor(runtime=runtime)
    run(executor, "print(1)")
    sandbox = runtime.made[0]
    del executor
    gc.collect()
    assert sandbox.stopped


def test_stateful_is_refused():
    with pytest.raises(ValueError, match="stateful"):
        RuntimeCodeExecutor(stateful=True)


class FakeAsyncSandbox:
    def __init__(self, fields):
        self.id, self.fields, self.stopped = "sbx_async", fields, False

    async def exec(self, command, **options):
        return CommandResult(exit_code=0, stdout=f"ran {command}\n", stderr="")

    async def stop(self, **_):
        self.stopped = True


class FakeAsyncRuntime:
    def __init__(self):
        self.sandboxes, self.made = self, []

    async def create(self, **fields):
        self.made.append(FakeAsyncSandbox(fields))
        return self.made[-1]


async def test_toolset_starts_one_sandbox_gives_four_tools_and_stops_on_close():
    runtime = FakeAsyncRuntime()
    toolset = RuntimeToolset(runtime=runtime, create={"memory_mib": 2048})
    tools = await toolset.get_tools()
    await toolset.get_tools()
    assert [t.name for t in tools] == ["runtime_exec", "runtime_read_file", "runtime_write_file", "runtime_list_files"]
    assert len(runtime.made) == 1 and runtime.made[0].fields["memory_mib"] == 2048
    result = await tools[0].run_async(args={"command": "ls"}, tool_context=None)
    assert result["stdout"] == "ran ls\n" and result["exit_code"] == 0
    await toolset.close()
    assert runtime.made[0].stopped and toolset.sandbox is None


async def test_toolset_filter_and_a_sandbox_you_own():
    sandbox = FakeAsyncSandbox({})
    toolset = RuntimeToolset(sandbox, tool_filter=["runtime_exec"])
    assert [t.name for t in await toolset.get_tools()] == ["runtime_exec"]
    await toolset.close()
    assert not sandbox.stopped and toolset.sandbox is sandbox


async def test_concurrent_tool_requests_share_one_created_sandbox():
    class SlowRuntime(FakeAsyncRuntime):
        async def create(self, **fields):
            await asyncio.sleep(0)
            return await super().create(**fields)

    runtime = SlowRuntime()
    toolset = RuntimeToolset(runtime=runtime)
    first, second = await asyncio.gather(toolset.get_tools(), toolset.get_tools())
    assert len(runtime.made) == 1
    assert first == second
    await toolset.close()
    assert all(sandbox.stopped for sandbox in runtime.made)


async def test_close_waits_for_creation_and_stops_its_sandbox():
    started, release = asyncio.Event(), asyncio.Event()

    class SlowRuntime(FakeAsyncRuntime):
        async def create(self, **fields):
            started.set()
            await release.wait()
            return await super().create(**fields)

    runtime = SlowRuntime()
    toolset = RuntimeToolset(runtime=runtime)
    request = asyncio.create_task(toolset.get_tools())
    await started.wait()
    closing = asyncio.create_task(toolset.close())
    release.set()
    await asyncio.gather(request, closing)
    assert len(runtime.made) == 1 and runtime.made[0].stopped
    assert toolset.sandbox is None


async def test_failed_binding_stops_the_guest_and_closes_its_owned_client(monkeypatch):
    import google_adk_withruntime as adapter

    class OwnedRuntime(FakeAsyncRuntime):
        closed = False

        async def close(self):
            self.closed = True

    runtime = OwnedRuntime()
    monkeypatch.setattr(adapter, "AsyncRuntime", lambda: runtime)

    def fail_binding(*args, **kwargs):
        raise ValueError("bad binding")

    monkeypatch.setattr(adapter, "sandbox_tools", fail_binding)
    toolset = RuntimeToolset()
    with pytest.raises(ValueError, match="bad binding"):
        await toolset.get_tools()
    assert runtime.made[0].stopped and runtime.closed
    assert toolset.sandbox is None


async def test_failed_binding_does_not_stop_a_borrowed_guest(monkeypatch):
    import google_adk_withruntime as adapter

    def fail_binding(*args, **kwargs):
        raise ValueError("bad binding")

    monkeypatch.setattr(adapter, "sandbox_tools", fail_binding)
    sandbox = FakeAsyncSandbox({})
    toolset = RuntimeToolset(sandbox)
    with pytest.raises(ValueError, match="bad binding"):
        await toolset.get_tools()
    assert not sandbox.stopped and toolset.sandbox is sandbox


def test_failed_input_upload_is_reported_to_the_model():
    runtime = FakeRuntime()
    executor = RuntimeCodeExecutor(runtime=runtime)
    sandbox = executor.sandbox

    def fail_write(*args):
        raise ConnectionError("input upload reset")

    sandbox.files.write = fail_write
    result = run(executor, "print(1)", [File(name="input.txt", content="data")])
    assert "input upload reset" in result.stderr and result.exit_code is None
    assert sandbox.commands == []
    executor.close()
