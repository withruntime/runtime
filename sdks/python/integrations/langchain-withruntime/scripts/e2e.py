"""End to end against the real API: a Deep Agent works in Runtime sandboxes.

    RUNTIME_API_KEY=... python scripts/e2e.py

`create_deep_agent` runs with a scripted model, so no model is paid for. The
model calls each of the agent's sandbox tools in turn: `write_file`,
`edit_file`, `read_file`, `execute`, `ls`, `glob` and `grep`. The script checks
what every tool returned and then reads the file back through the backend
itself. It does this twice in each sandbox: under /workspace, which the Files
API serves, and under /tmp, where files move through a staged copy.

Two sandboxes, one after the other, on the account's default funding (the free
trial while it lasts), each with a ten minute lease so a crashed run cannot
leave one billing: the first made with `Sandbox.create` and wrapped in
`RuntimeSandbox`, the second made and stopped by `RuntimeProvider`, as
Deep Agents Code does. The script stops both and then checks that neither is
still running. RUNTIME_API_URL points it at another deployment.

`drive(backend, root)` is the whole agent run; the offline tests call it on a
stand-in sandbox. Needs `pip install langchain-withruntime`.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from collections.abc import Sequence
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import PrivateAttr

LEASE_SECONDS = 600
SOURCE = "def greet(name):\n    return 'Hello, ' + name + '!'\n"
EDITED = SOURCE.replace("Hello", "Hi")


class ScriptedModel(BaseChatModel):
    """A chat model that returns the messages it was given, in order."""

    script: list[AIMessage]
    _turn: int = PrivateAttr(default=0)

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> ScriptedModel:  # noqa: ARG002
        return self

    def _generate(self, messages: list[BaseMessage], stop: Any = None, run_manager: Any = None,
                  **kwargs: Any) -> ChatResult:
        message = self.script[min(self._turn, len(self.script) - 1)]
        self._turn += 1
        return ChatResult(generations=[ChatGeneration(message=message)])


def steps(root: str) -> list[tuple[str, dict[str, Any], str]]:
    """Each tool call the model makes, and a string its result must contain."""
    app = f"{root}/app"
    return [
        ("write_file", {"file_path": f"{app}/greet.py", "content": SOURCE}, f"{app}/greet.py"),
        ("edit_file", {"file_path": f"{app}/greet.py", "old_string": "Hello", "new_string": "Hi"}, "greet.py"),
        ("read_file", {"file_path": f"{app}/greet.py"}, "return 'Hi, ' + name"),
        ("execute", {"command": f"cd {root} && python3 -c 'from app.greet import greet; print(greet(\"Runtime\"))'"},
         "Hi, Runtime!"),
        ("ls", {"path": app}, f"{app}/greet.py"),
        ("glob", {"pattern": "**/*.py", "path": root}, f"{app}/greet.py"),
        ("grep", {"pattern": "Hi, ", "path": root, "output_mode": "content"}, "return 'Hi, ' + name"),
    ]


def drive(backend: Any, root: str) -> list[str]:
    """Run a Deep Agent on `backend` under `root`. Returns the failures, none when it worked."""
    from deepagents import create_deep_agent  # noqa: PLC0415

    plan = steps(root)
    calls = [(f"call_{i}", tool, args) for i, (tool, args, _) in enumerate(plan)]
    script = [AIMessage(content="", tool_calls=[{"id": cid, "name": tool, "args": args, "type": "tool_call"}])
              for cid, tool, args in calls]
    script.append(AIMessage(content="Done."))
    agent = create_deep_agent(model=ScriptedModel(script=script), backend=backend,
                              system_prompt="Use the sandbox tools.")
    result = agent.invoke({"messages": [{"role": "user", "content": "Write, fix and run greet.py."}]},
                          config={"recursion_limit": 60})
    replies = {m.tool_call_id: m for m in result["messages"] if isinstance(m, ToolMessage)}
    failures = []
    for (cid, tool, _), (_, _, expected) in zip(calls, plan, strict=True):
        reply = replies.get(cid)
        text = "" if reply is None else str(reply.content)
        if reply is None or reply.status == "error" or expected not in text:
            failures.append(f"{tool} under {root}: expected {expected!r}, got {text[:300]!r}")
    downloaded = backend.download_files([f"{root}/app/greet.py"])[0]
    if downloaded.error or downloaded.content != EDITED.encode():
        failures.append(f"download under {root}: {downloaded.error or downloaded.content!r}")
    if result["messages"][-1].content != "Done.":
        failures.append(f"the agent did not finish: {result['messages'][-1]!r}")
    return failures


def _run(name: str, backend: Any) -> list[str]:
    failures: list[str] = []
    for root in (f"/workspace/e2e-{uuid.uuid4().hex[:8]}", f"/tmp/e2e-{uuid.uuid4().hex[:8]}"):  # noqa: S108
        found = drive(backend, root)
        print(f"{name}: {len(steps(root))} tools under {root}: {'ok' if not found else 'FAILED'}")
        failures += found
    return failures


def main() -> int:
    if not os.environ.get("RUNTIME_API_KEY"):
        print("Set RUNTIME_API_KEY to a Runtime key (a test key) to run this against the real API.")
        return 2
    from withruntime import Runtime  # noqa: PLC0415

    from langchain_withruntime import RuntimeProvider, RuntimeSandbox  # noqa: PLC0415

    run = uuid.uuid4().hex[:8]
    labels = {"purpose": "langchain-withruntime-e2e", "run": run}
    client = Runtime()
    print(f"Running against {client.base_url}, run {run}")
    failures: list[str] = []
    created: list[str] = []

    sbx = client.sandboxes.create(timeout_seconds=LEASE_SECONDS, labels=labels)
    created.append(sbx.id)
    try:
        failures += _run(f"RuntimeSandbox({sbx.id})", RuntimeSandbox(sbx))
    finally:
        sbx.stop()

    provider = RuntimeProvider(client=client)
    backend = provider.get_or_create(timeout=LEASE_SECONDS, labels=labels)
    created.append(backend.id)
    try:
        failures += _run(f"RuntimeProvider({backend.id})", backend)
    finally:
        provider.delete(sandbox_id=backend.id)

    running = [s.id for s in client.sandboxes.list(labels=labels)]
    for sandbox_id in created:
        state = client.sandboxes.get(sandbox_id).state
        print(f"{sandbox_id}: {state}")
        if state not in ("stopped", "stopping"):
            failures.append(f"{sandbox_id} is {state} after the run")
    if running:
        failures.append(f"still listed as live after the run: {running}")
    print(json.dumps({"run": run, "sandboxes": created, "failures": failures}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
