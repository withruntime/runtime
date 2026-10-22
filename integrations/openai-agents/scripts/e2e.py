"""End to end, against the real API: a SandboxAgent run by the Agents SDK's
own Runner, with RuntimeCloudSandboxClient, driven by the SDK's ScriptedModel
(agents.testing), so no model is called and nothing is billed but the sandbox.

    pip install openai-agents-withruntime      # or "withruntime[openai-agents]"
    RUNTIME_API_KEY=... python3 scripts/e2e.py

One trial sandbox: the manifest's file is read by a command, a file written by
a command is read back by the next turn, a long command is polled through
write_stdin, and the run's cleanup stops the sandbox. Prints PASS or FAIL for
each check and exits non-zero on any failure."""
import asyncio
import json
import os
import re
import sys

if not os.environ.get("RUNTIME_API_KEY"):
    sys.exit("Set RUNTIME_API_KEY to a Runtime key.")

from agents import Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.entries import File
from agents.testing.model import (
    ModelStep,
    ScriptedModel,
    assistant_message,
    function_call,
)
from openai_agents_withruntime import (
    RuntimeCloudSandboxClient,
    RuntimeCloudSandboxClientOptions,
)
from withruntime import AsyncRuntime

failures = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def outputs(result):
    return [str(item.output) for item in result.new_items if getattr(item, "type", "") == "tool_call_output_item"]


async def main():
    label = f"oa-e2e-{os.getpid()}"
    model = ScriptedModel([
        [function_call("exec_command", {"cmd": "cat sales.csv && uname -sr && id -un"}, call_id="c1")],
        [function_call("exec_command", {"cmd": "python3 -c 'print(120+180)' > total.txt && cat total.txt"}, call_id="c2")],
        [function_call("exec_command", {"cmd": "sleep 3; echo slow-done", "yield_time_ms": 500}, call_id="c3")],
        # The session id is the one the previous tool output named.
        ModelStep(responder=lambda call: [function_call("write_stdin", {
            "session_id": int(re.findall(r"session ID (\d+)", str(call.input))[-1]),
            "chars": "", "yield_time_ms": 5000}, call_id="c4")]),
        [assistant_message("Total is 300.")],
    ])
    agent = SandboxAgent(
        name="Analyst",
        instructions="Answer from the files in the workspace.",
        model=model,
        default_manifest=Manifest(entries={"sales.csv": File(content=b"month,total\nJuly,120\nAugust,180\n")}),
    )
    client = RuntimeCloudSandboxClient()
    run_config = RunConfig(sandbox=SandboxRunConfig(
        client=client,
        options=RuntimeCloudSandboxClientOptions(funding="trial", labels={"e2e": label}),
    ))
    result = await Runner.run(agent, "What is the total?", run_config=run_config, max_turns=10)
    out = outputs(result)
    check("final answer", result.final_output == "Total is 300.", repr(result.final_output))
    check("manifest file read by a command", any("August,180" in o for o in out), json.dumps(out)[:400])
    check("a Linux kernel of its own", any("Linux" in o for o in out))
    check("command output", any("300" in o for o in out[1:2]), json.dumps(out[1:2])[:300])
    check("long command polled through write_stdin", any("slow-done" in o for o in out[2:]), json.dumps(out[2:])[:400])
    await client.aclose()

    async with AsyncRuntime() as runtime:
        items = await (await runtime.sandboxes.list(labels={"e2e": label}, include_stopped=True)).to_list()
        check("the run made one sandbox", len(items) == 1, str(len(items)))
        alive = [s for s in items if s.info.get("state") in ("running", "starting", "paused")]
        check("no sandbox left running", not alive, str(alive)[:300])
    print(f"\n{'all checks passed' if not failures else f'{len(failures)} failed'}")
    sys.exit(1 if failures else 0)


asyncio.run(main())
