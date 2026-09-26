"""End to end, against the real API: RuntimeToolset in Pydantic AI's own agent
loop, driven by a scripted model (FunctionModel), so no model is called.

    RUNTIME_API_KEY=... python scripts/e2e.py

Two runs of one agent, each in its own trial sandbox (the default size, a
ten-minute lease, stopped at the end of the run): write a file, run it, read it
back, list the folder. Then checks that neither sandbox is still running.
RUNTIME_API_URL points it elsewhere. Not part of the tests."""

import asyncio
import os
import sys
import uuid

from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from withruntime import AsyncRuntime

from pydantic_ai_withruntime import RuntimeToolset

STEPS = [
    ("runtime_write_file", {"path": "hello.py", "content": "import sys\nprint('hello from', sys.version_info[:2])\n"}),
    ("runtime_exec", {"command": "python3 hello.py"}),
    ("runtime_read_file", {"path": "hello.py"}),
    ("runtime_list_files", {"path": "."}),
]


def respond(messages, info):
    step = sum(1 for m in messages if isinstance(m, ModelResponse))
    if step < len(STEPS):
        name, args = STEPS[step]
        return ModelResponse(parts=[ToolCallPart(name, args, tool_call_id=f"c{step}")])
    returns = [p.content for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
    return ModelResponse(parts=[TextPart(repr(returns))])


async def main() -> int:
    if not os.environ.get("RUNTIME_API_KEY"):
        sys.exit("Set RUNTIME_API_KEY to a Runtime key (a test key).")
    run = uuid.uuid4().hex[:8]
    toolset = RuntimeToolset(create={"timeout_seconds": 600, "labels": {"e2e": run}})
    agent = Agent(FunctionModel(respond), toolsets=[toolset])
    failures = []
    for attempt in (1, 2):
        result = await agent.run("go")
        text = result.output
        ok = "hello from (3," in text and "hello.py" in text and "'exit_code': 0" in text
        print(f"{'ok ' if ok else 'FAIL'} run {attempt}: write, exec, read, list", flush=True)
        if not ok:
            failures.append(text[:500])
    async with AsyncRuntime() as runtime:
        left = [s for s in await (await runtime.sandboxes.list(labels={"e2e": run})).to_list()]
        made = await (await runtime.sandboxes.list(labels={"e2e": run}, include_stopped=True)).to_list()
    print(f"{'ok ' if len(made) == 2 else 'FAIL'} two sandboxes were made: {len(made)}")
    print(f"{'ok ' if not left else 'FAIL'} none still running: {[s.id for s in left]}")
    if len(made) != 2 or left:
        failures.append("sandboxes")
    print("All checks passed." if not failures else f"Failed: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
