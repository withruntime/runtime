"""RuntimeToolset under Pydantic AI's own agent loop, with a scripted model
(FunctionModel) and a fake Runtime client, so nothing leaves the machine."""

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from withruntime import CommandResult

from pydantic_ai_withruntime import RuntimeToolset


class FakeFiles:
    def __init__(self):
        self.data = {}

    async def read(self, path):
        if path not in self.data:
            from withruntime import NotFoundError

            raise NotFoundError("missing", code="file_not_found", status=404)
        return self.data[path]

    async def write(self, path, content):
        self.data[path] = content.encode() if isinstance(content, str) else content


class FakeSandbox:
    def __init__(self, n, fields):
        self.id, self.fields, self.stopped, self.commands = f"sbx_{n}", fields, False, []
        self.files = FakeFiles()

    async def exec(self, command, **options):
        self.commands.append((command, options))
        return CommandResult(exit_code=0, stdout=f"ran in {self.id}\n", stderr="")

    async def stop(self, **_):
        self.stopped = True


class FakeRuntime:
    def __init__(self, fail=False):
        self.sandboxes = self
        self.made, self.fail = [], fail

    async def create(self, **fields):
        if self.fail:
            raise ConnectionError("no capacity")
        sandbox = FakeSandbox(len(self.made), fields)
        self.made.append(sandbox)
        return sandbox


def scripted(calls):
    """Calls each (tool, args) in turn, then answers with what the last tool returned."""
    seen: list[list[str]] = []

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(sorted(tool.name for tool in info.function_tools))
        step = sum(1 for m in messages if isinstance(m, ModelResponse))
        if step < len(calls):
            name, args = calls[step]
            return ModelResponse(parts=[ToolCallPart(name, args, tool_call_id=f"c{step}")])
        returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
        return ModelResponse(parts=[TextPart(str(returns[-1].content) if returns else "none")])

    return FunctionModel(respond), seen


TOOLS = ["runtime_exec", "runtime_list_files", "runtime_read_file", "runtime_write_file"]


async def test_each_run_gets_its_own_sandbox_and_stops_it():
    runtime = FakeRuntime()
    model, seen = scripted([("runtime_exec", {"command": "python3 --version"})])
    agent = Agent(model, toolsets=[RuntimeToolset(runtime=runtime, create={"vcpu": 2})])

    first = await agent.run("go")
    second = await agent.run("go")

    assert [s.id for s in runtime.made] == ["sbx_0", "sbx_1"]
    assert all(s.stopped for s in runtime.made)
    assert "ran in sbx_0" in first.output and "ran in sbx_1" in second.output
    assert seen[0] == TOOLS
    fields = runtime.made[0].fields
    assert fields["vcpu"] == 2 and fields["timeout_seconds"] == 1800 and fields["on_lease_end"] == "stop"
    assert fields["labels"] == {"created_by": "pydantic-ai"}
    assert runtime.made[0].commands[0][0] == "python3 --version"


async def test_the_sandbox_is_stopped_when_the_run_fails():
    runtime = FakeRuntime()

    def boom(messages, info):
        raise ValueError("model down")

    agent = Agent(FunctionModel(boom), toolsets=[RuntimeToolset(runtime=runtime)])
    with pytest.raises(ValueError, match="model down"):
        await agent.run("go")
    assert runtime.made[0].stopped


async def test_a_failed_create_fails_the_run_and_leaves_nothing():
    agent = Agent(scripted([])[0], toolsets=[RuntimeToolset(runtime=FakeRuntime(fail=True))])
    with pytest.raises(ConnectionError, match="no capacity"):
        await agent.run("go")


async def test_a_sandbox_you_pass_is_shared_and_never_stopped():
    runtime = FakeRuntime()
    sandbox = await runtime.create()
    model, _ = scripted(
        [
            ("runtime_write_file", {"path": "notes.md", "content": "hello"}),
            ("runtime_read_file", {"path": "notes.md"}),
        ]
    )
    toolset = RuntimeToolset(sandbox, instructions=None)
    result = await Agent(model, toolsets=[toolset]).run("go")
    assert result.output == "hello"
    assert sandbox.files.data == {"/workspace/notes.md": b"hello"}
    assert not sandbox.stopped and toolset.sandbox is sandbox


async def test_instructions_reach_the_model_and_can_be_turned_off():
    captured = []

    def respond(messages, info):
        captured.append(info.instructions)
        return ModelResponse(parts=[TextPart("ok")])

    await Agent(FunctionModel(respond), toolsets=[RuntimeToolset(runtime=FakeRuntime())]).run("go")
    await Agent(FunctionModel(respond), toolsets=[RuntimeToolset(runtime=FakeRuntime(), instructions=None)]).run("go")
    assert "/workspace" in (captured[0] or "")
    assert not captured[1]


def test_used_outside_a_run_says_why():
    import asyncio

    with pytest.raises(RuntimeError, match="outside an agent run"):
        asyncio.run(RuntimeToolset(runtime=FakeRuntime()).get_tools(None))
