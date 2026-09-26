"""End to end, against the real API: RuntimeCodeExecutor and RuntimeToolset in
ADK's own Runner, driven by a scripted model (a BaseLlm), so no model is called.

    RUNTIME_API_KEY=... python scripts/e2e.py

1. An agent with code_executor=RuntimeCodeExecutor(): the model answers with a
   Python block, ADK runs it in the sandbox and feeds the output back.
2. An agent with tools=[RuntimeToolset()]: the model calls runtime_exec.
Each makes one trial sandbox with a ten-minute lease, stopped at the end.
Then checks that nothing labelled with this run is still running."""

import asyncio
import os
import sys
import uuid
from collections.abc import AsyncGenerator

from google.adk.agents import Agent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.genai import types
from withruntime import AsyncRuntime

from google_adk_withruntime import RuntimeCodeExecutor, RuntimeToolset


class Scripted(BaseLlm):
    """Replies with each part in `script` in turn, then echoes what came back."""

    script: list

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        turns = sum(1 for c in llm_request.contents if c.role == "model")
        if turns < len(self.script):
            part = self.script[turns]
        else:
            last = llm_request.contents[-1]
            part = types.Part(
                text="DONE "
                + " | ".join(str(p.text or p.function_response or p.code_execution_result) for p in last.parts)
            )
        yield LlmResponse(content=types.Content(role="model", parts=[part]))


async def ask(agent: Agent) -> str:
    runner = InMemoryRunner(agent=agent, app_name="e2e")
    session = await runner.session_service.create_session(app_name="e2e", user_id="u")
    text = []
    try:
        async for event in runner.run_async(
            user_id="u", session_id=session.id, new_message=types.Content(role="user", parts=[types.Part(text="go")])
        ):
            for part in event.content.parts if event.content else []:
                text.append(str(part.text or part.code_execution_result or part.function_response or ""))
    finally:
        await runner.close()
    return "\n".join(text)


async def main() -> int:
    if not os.environ.get("RUNTIME_API_KEY"):
        sys.exit("Set RUNTIME_API_KEY to a Runtime key (a test key).")
    run = uuid.uuid4().hex[:8]
    create = {"timeout_seconds": 600, "labels": {"e2e": run}}
    failures = []

    executor = RuntimeCodeExecutor(create=create, timeout_seconds=60)
    code = "import platform, sys\nprint('kernel', platform.release(), 'python', sys.version_info[:2])"
    analyst = Agent(
        name="analyst",
        model=Scripted(model="scripted", script=[types.Part(text=f"```python\n{code}\n```")]),
        code_executor=executor,
    )
    try:
        out = await ask(analyst)
    finally:
        executor.close()
    ok = "kernel" in out and "python (3," in out
    print(f"{'ok ' if ok else 'FAIL'} code executor: ADK ran the model's block in the sandbox", flush=True)
    if not ok:
        failures.append(out[:500])

    call = types.Part(function_call=types.FunctionCall(name="runtime_exec", args={"command": "uname -sr && id -un"}))
    coder = Agent(name="coder", model=Scripted(model="scripted", script=[call]), tools=[RuntimeToolset(create=create)])
    out = await ask(coder)
    ok = "Linux" in out and "exit_code" in out
    print(f"{'ok ' if ok else 'FAIL'} toolset: runtime_exec ran through ADK's function calling", flush=True)
    if not ok:
        failures.append(out[:500])

    async with AsyncRuntime() as runtime:
        made = await (await runtime.sandboxes.list(labels={"e2e": run}, include_stopped=True)).to_list()
        left = await (await runtime.sandboxes.list(labels={"e2e": run})).to_list()
    left = [s for s in left if s.state not in ("stopped", "stopping")]
    print(f"{'ok ' if len(made) == 2 else 'FAIL'} two sandboxes were made: {len(made)}")
    print(f"{'ok ' if not left else 'FAIL'} none still running: {[s.id for s in left]}")
    if len(made) != 2 or left:
        failures.append("sandboxes")
    print("All checks passed." if not failures else f"Failed: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
