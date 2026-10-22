"""End to end, against the real API: a smolagents CodeAgent whose code runs
in a Runtime sandbox through RuntimeExecutor, driven by a scripted model, so
no model is called and nothing is billed but the sandbox.

    pip install smolagents-withruntime
    RUNTIME_API_KEY=... python3 scripts/e2e.py

One sandbox: a package installed into the interpreter, a variable kept from
one step to the next, a tool sent to the sandbox and called there, an error
the agent sees and recovers from, a figure returned as an image, and the
final answer. Then cleanup must have stopped the sandbox. Prints PASS or FAIL
for each check and exits non-zero on any failure."""
import os
import sys

if not os.environ.get("RUNTIME_API_KEY"):
    sys.exit("Set RUNTIME_API_KEY to a Runtime key.")

import PIL.Image
from smolagents import CodeAgent, tool
from smolagents.models import ChatMessage, MessageRole, Model
from withruntime import Runtime

from smolagents_withruntime import RuntimeExecutor

failures = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f": {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


class ScriptedModel(Model):
    def __init__(self, replies):
        super().__init__(model_id="scripted")
        self.replies = list(replies)

    def generate(self, messages, stop_sequences=None, **kwargs):
        return ChatMessage(role=MessageRole.ASSISTANT, content=self.replies.pop(0))


@tool
def double(x: int) -> int:
    """Doubles a number.

    Args:
        x: The number to double.
    """
    return 2 * x


label = f"smol-e2e-{os.getpid()}"
steps = [
    "<code>\nimport cowsay, platform\nkept = 21\nprint(platform.system(), cowsay.__name__)\n</code>",
    "<code>\nprint(double(kept))\n</code>",
    "<code>\n1 / 0\n</code>",
    "<code>\nimport matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nfig = plt.figure(); plt.plot([1, 2]); fig\n</code>",
    "<code>\nfinal_answer(double(kept))\n</code>",
]
executor = RuntimeExecutor(["cowsay"], labels={"e2e": label})
sandbox_id = executor.sandbox.id
agent = CodeAgent(tools=[double], model=ScriptedModel(steps), executor=executor, max_steps=6, verbosity_level=0)
try:
    answer = agent.run("Double 21.")
finally:
    agent.cleanup()

observations = [str(getattr(s, "observations", "") or "") for s in agent.memory.steps]
errors = [str(getattr(s, "error", "") or "") for s in agent.memory.steps]
check("final answer", answer == 42, repr(answer))
check("package installed into the interpreter", any("Linux cowsay" in o for o in observations), str(observations)[:400])
check("variable kept and tool called in the sandbox", any("42" in o for o in observations), str(observations)[:400])
check("an error reached the agent", any("ZeroDivisionError" in e for e in errors), str(errors)[:400])
outputs = [getattr(s, "action_output", None) for s in agent.memory.steps]
check("a figure came back as an image", any(isinstance(o, PIL.Image.Image) for o in outputs), str(outputs)[:300])
state = Runtime().sandboxes.get(sandbox_id).info.get("state")
check("cleanup stopped the sandbox", state in ("stopped", "stopping"), state)
print(f"\n{'all checks passed' if not failures else f'{len(failures)} failed'}")
sys.exit(1 if failures else 0)
