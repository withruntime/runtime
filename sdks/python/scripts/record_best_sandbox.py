"""The recorded Python runs on the "best sandbox for <tool>" pages
(packages/cloud-guide/learn/compare/best-sandbox-for-*.md), against real
Runtime sandboxes.

    RUNTIME_API_KEY=... python scripts/record_best_sandbox.py [name ...]

Each framework's own agent loop runs with a scripted model, so no model is paid
for: the model asks for the tool calls below, the framework runs them through
`withruntime.tools.sandbox_tools`, and the script prints what came back. Needs
the frameworks installed beside `withruntime`; every sandbox it starts is
stopped, and the last line lists any still running.
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Callable, Sequence
from typing import Any

from withruntime import Runtime, Sandbox
from withruntime.tools import sandbox_tools

LABELS = {"verify": "best-sandbox-pages"}

FIZZ = "for i in range(1, 16):\n    print('Fizz' * (i % 3 == 0) + 'Buzz' * (i % 5 == 0) or i)\n"
SLOPE = "import numpy as np\nprint(round(np.polyfit([1, 2, 3], [2, 4.1, 6.2], 1)[0], 3))\n"


def _tool_calls(calls: list[tuple[str, dict[str, Any]]]):
    """The (name, arguments) a scripted model asks for, one a turn."""
    return list(calls)


# LangChain and LangGraph share a chat model that replays tool calls.
def _langchain_model(calls: list[tuple[str, dict[str, Any]]]):
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from pydantic import PrivateAttr

    script = [AIMessage(content="", tool_calls=[{"name": n, "args": a, "id": f"c{i}"}])
              for i, (n, a) in enumerate(calls)] + [AIMessage(content="done")]

    class Scripted(BaseChatModel):
        _turn: int = PrivateAttr(default=0)

        @property
        def _llm_type(self) -> str:
            return "scripted"

        def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> Scripted:  # noqa: ARG002
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:  # noqa: ARG002
            message = script[min(self._turn, len(script) - 1)]
            self._turn += 1
            return ChatResult(generations=[ChatGeneration(message=message)])

    return Scripted()


def langchain(sbx: Sandbox) -> Any:
    from langchain.agents import create_agent
    from langchain_core.tools import tool

    model = _langchain_model([
        ("runtime_write_file", {"path": "slope.py", "content": SLOPE}),
        ("runtime_exec", {"command": "python3 slope.py"}),
    ])
    agent = create_agent(model, tools=[tool(f) for f in sandbox_tools(sbx)])
    out = agent.invoke({"messages": [{"role": "user", "content": "Fit a line and give the slope."}]})
    return [m.content for m in out["messages"] if m.type == "tool"]


def langgraph(sbx: Sandbox) -> Any:
    from langchain_core.tools import tool
    from langgraph.graph import START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode, tools_condition

    tools = [tool(f) for f in sandbox_tools(sbx)]
    model = _langchain_model([
        ("runtime_write_file", {"path": "fizzbuzz.py", "content": FIZZ}),
        ("runtime_exec", {"command": "python3 fizzbuzz.py | tr '\\n' ' '"}),
    ]).bind_tools(tools)
    graph = StateGraph(MessagesState)
    graph.add_node("model", lambda state: {"messages": [model.invoke(state["messages"])]})
    graph.add_node("tools", ToolNode(tools))
    graph.add_edge(START, "model")
    graph.add_conditional_edges("model", tools_condition)
    graph.add_edge("tools", "model")
    out = graph.compile().invoke({"messages": [("user", "Write fizzbuzz.py and run it.")]})
    return [m.content for m in out["messages"] if m.type == "tool"]


def pydantic_ai(sbx: Sandbox) -> Any:
    from pydantic_ai import Agent
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
    from pydantic_ai.models.function import FunctionModel

    calls = [("runtime_exec", {"command": "python3 -c 'import sys, platform; print(sys.version.split()[0], platform.machine())'"}),
             ("runtime_exec", {"command": "pip install --quiet --break-system-packages humanize && python3 -c 'import humanize; print(humanize.naturalsize(52_428_800))'"})]

    def respond(messages, info):  # noqa: ARG001
        turn = sum(1 for m in messages if isinstance(m, ModelResponse))
        if turn < len(calls):
            return ModelResponse(parts=[ToolCallPart(calls[turn][0], calls[turn][1])])
        return ModelResponse(parts=[TextPart("done")])

    agent = Agent(FunctionModel(respond), tools=sandbox_tools(sbx))
    result = agent.run_sync("Which Python is this, and how big is 50 MiB in words?")
    return [p.content for m in result.all_messages() for p in m.parts if p.part_kind == "tool-return"]


def google_adk(sbx: Sandbox) -> Any:
    from google.adk.agents import Agent
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.adk.runners import InMemoryRunner
    from google.genai import types

    calls = [("runtime_write_file", {"path": "rates.py", "content": "print({c: round(100 * r, 2) for c, r in {'EUR': 0.9217, 'GBP': 0.7841}.items()})\n"}),
             ("runtime_exec", {"command": "python3 rates.py"})]

    class Scripted(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):  # noqa: ARG002
            turn = sum(1 for c in llm_request.contents if c.role == "model")
            if turn < len(calls):
                part = types.Part(function_call=types.FunctionCall(name=calls[turn][0], args=calls[turn][1]))
            else:
                part = types.Part(text="done")
            yield LlmResponse(content=types.Content(role="model", parts=[part]))

    agent = Agent(name="coder", model=Scripted(model="scripted"), instruction="Run code in the sandbox to answer.",
                  tools=sandbox_tools(sbx))

    async def run() -> list[Any]:
        runner = InMemoryRunner(agent=agent, app_name="record")
        session = await runner.session_service.create_session(app_name="record", user_id="u")
        out = []
        message = types.Content(role="user", parts=[types.Part(text="Convert 100 USD.")])
        async for event in runner.run_async(user_id="u", session_id=session.id, new_message=message):
            for part in (event.content.parts if event.content else []) or []:
                if part.function_response:
                    out.append(part.function_response.response)
        return out

    return asyncio.run(run())


def smolagents(sbx: Sandbox) -> Any:
    from smolagents import ChatMessage, Model, ToolCallingAgent, tool
    from smolagents.models import ChatMessageToolCall, ChatMessageToolCallFunction, MessageRole

    calls = [("runtime_exec", {"command": "nproc && free -m | awk '/Mem/ {print $2\" MiB\"}'"}),
             ("final_answer", {"answer": "done"})]

    class Scripted(Model):
        turn = 0

        def generate(self, messages, stop_sequences=None, response_format=None, tools_to_call_from=None, **kw):  # noqa: ARG002
            name, args = calls[min(self.turn, len(calls) - 1)]
            self.turn += 1
            call = ChatMessageToolCall(id=f"c{self.turn}", type="function",
                                       function=ChatMessageToolCallFunction(name=name, arguments=args))
            return ChatMessage(role=MessageRole.ASSISTANT, content="", tool_calls=[call])

    agent = ToolCallingAgent(tools=[tool(f) for f in sandbox_tools(sbx)], model=Scripted(), max_steps=4)
    agent.run("How many CPUs and how much memory does the sandbox have?")
    return [str(step.observations) for step in agent.memory.steps if getattr(step, "observations", None)]


def llamaindex(sbx: Sandbox) -> Any:
    from llama_index.core.tools import FunctionTool

    # LlamaIndex ships no scripted function-calling model; its FunctionTool is
    # what the agent calls, so the tools are called through it directly.
    tools = {t.metadata.name: t for t in (FunctionTool.from_defaults(fn=f) for f in sandbox_tools(sbx))}
    wrote = tools["runtime_write_file"].call(path="words.py", content="import collections, re\ntext = open('/etc/os-release').read().lower()\nprint(collections.Counter(re.findall('[a-z]+', text)).most_common(3))\n")
    ran = tools["runtime_exec"].call(command="python3 words.py")
    return [str(wrote), str(ran)]


def crewai(sbx: Sandbox) -> Any:
    from crewai.tools import tool

    # CrewAI's tool wrapper, called as an agent would call it; a crew needs a real LLM.
    tools = {t.name: t for t in (tool(f) for f in sandbox_tools(sbx))}
    ran = tools["runtime_exec"].run(command="git --version && gcc --version | head -1 && python3 --version")
    return [str(ran)]


RUNS: dict[str, Callable[[Sandbox], Any]] = {
    "langchain": langchain,
    "langgraph": langgraph,
    "pydantic-ai": pydantic_ai,
    "google-adk": google_adk,
    "smolagents": smolagents,
    "llamaindex": llamaindex,
    "crewai": crewai,
}


def main() -> int:
    runtime = Runtime()
    for name in sys.argv[1:] or list(RUNS):
        sbx = runtime.sandboxes.create(labels=LABELS, timeout_seconds=600, on_lease_end="stop")
        try:
            print(json.dumps({"name": name, "result": RUNS[name](sbx)}, indent=2, default=str))
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"name": name, "error": repr(error)}))
        finally:
            sbx.stop()
    left = [s for s in runtime.sandboxes.list(labels=LABELS) if s.state != "stopped"]
    print(json.dumps({"leftRunning": [s.id for s in left]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
