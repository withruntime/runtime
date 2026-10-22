"""RuntimeExecutor against a fake sandbox whose interpreter answers the way
Runtime's API does (shapes recorded from the live API on 2 October 2026)."""
import base64
import io
import unittest

import PIL.Image
from smolagents import CodeAgent, FinalAnswerTool
from smolagents.models import ChatMessage, MessageRole, Model
from smolagents.utils import AgentError

from smolagents_withruntime import RuntimeExecutor


def png():
    out = io.BytesIO()
    PIL.Image.new("RGB", (2, 2)).save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode()


class FakeInterpreter:
    def __init__(self, sandbox):
        self.sandbox, self.namespace = sandbox, {}

    def run(self, code, *, language=None, timeout_ms=None):
        self.sandbox.runs.append((code, language, timeout_ms))
        if self.sandbox.respond:
            return self.sandbox.respond(code)
        answer = self.sandbox.answers.pop(0) if self.sandbox.answers else None
        if answer is not None:
            return answer
        return {"status": "ok", "stdout": "", "stderr": "", "results": [], "error": None}


class FakeSandbox:
    def __init__(self, answers=()):
        self.id, self.runs, self.answers, self.stopped, self.respond = "sbx-1", [], list(answers), 0, None
        self.interpreter = FakeInterpreter(self)

    def stop(self):
        self.stopped += 1


def ok(results=(), stdout=""):
    return {"status": "ok", "stdout": stdout, "stderr": "", "results": list(results), "error": None}


class Executor(unittest.TestCase):
    def test_the_main_result_and_logs(self):
        sbx = FakeSandbox([ok([{"main": True, "data": {"text/plain": "42"}}], stdout="hi\n")])
        out = RuntimeExecutor(sandbox=sbx)("x * 21")
        self.assertEqual((out.output, out.logs, out.is_final_answer), ("42", "hi\n", False))
        self.assertEqual(sbx.runs[-1][1:], ("python", 60000))

    def test_a_figure_without_a_main_result_comes_back_as_an_image(self):
        sbx = FakeSandbox([ok([{"main": False, "data": {"image/png": png()}}])])
        self.assertIsInstance(RuntimeExecutor(sandbox=sbx)("plt.show()").output, PIL.Image.Image)

    def test_json_results_are_values(self):
        sbx = FakeSandbox([ok([{"main": True, "data": {"application/json": '{"a": 1}', "text/plain": "{'a': 1}"}}])])
        self.assertEqual(RuntimeExecutor(sandbox=sbx)("d").output, {"a": 1})

    def test_an_error_raises_with_its_traceback(self):
        error = {"name": "ZeroDivisionError", "value": "division by zero", "traceback": "Traceback ...\n"}
        sbx = FakeSandbox([{"status": "error", "stdout": "", "stderr": "", "results": [], "error": error}])
        with self.assertRaisesRegex(AgentError, "ZeroDivisionError\ndivision by zero\nTraceback"):
            RuntimeExecutor(sandbox=sbx)("1/0")

    def test_the_final_answer_exception_is_the_answer(self):
        executor = RuntimeExecutor(sandbox=FakeSandbox())
        executor.send_tools({"final_answer": FinalAnswerTool()})
        from smolagents.serialization import SafeSerializer
        encoded = SafeSerializer.dumps("done", allow_pickle=False)
        executor.sandbox.answers.append({"status": "error", "stdout": "", "stderr": "", "results": [],
                                         "error": {"name": "FinalAnswerException", "value": encoded, "traceback": ""}})
        out = executor("final_answer('done')")
        self.assertEqual((out.output, out.is_final_answer), ("done", True))

    def test_packages_install_into_the_interpreters_python(self):
        sbx = FakeSandbox()
        executor = RuntimeExecutor(["numpy", "pillow"], sandbox=sbx)
        self.assertEqual(executor.installed_packages, ["numpy", "pillow"])
        self.assertIn("[sys.executable, '-m', 'pip', 'install', '--quiet', *['numpy', 'pillow']]", sbx.runs[0][0])
        # 2 October 2026: without it the package was installed but not importable.
        self.assertIn("site.addsitedir(site.getusersitepackages())", sbx.runs[0][0])

    def test_cleanup_stops_only_a_sandbox_it_created(self):
        given = FakeSandbox()
        RuntimeExecutor(sandbox=given).cleanup()
        self.assertEqual(given.stopped, 0)
        made = FakeSandbox()
        import smolagents_withruntime as module
        original = module.Sandbox
        module.Sandbox = type("S", (), {"create": staticmethod(lambda **kw: made)})
        try:
            executor = RuntimeExecutor(vcpu=2)
            executor.cleanup()
            executor.cleanup()
        finally:
            module.Sandbox = original
        self.assertEqual(made.stopped, 1)

    def test_a_failed_install_stops_the_sandbox_it_made(self):
        made = FakeSandbox([{"status": "error", "stdout": "", "stderr": "", "results": [],
                             "error": {"name": "RuntimeError", "value": "pip install exited with 1", "traceback": ""}}])
        import smolagents_withruntime as module
        original = module.Sandbox
        module.Sandbox = type("S", (), {"create": staticmethod(lambda **kw: made)})
        try:
            with self.assertRaises(AgentError):
                RuntimeExecutor(["nosuchpackagezz"])
        finally:
            module.Sandbox = original
        self.assertEqual(made.stopped, 1)


class ScriptedModel(Model):
    def __init__(self, replies):
        super().__init__(model_id="scripted")
        self.replies = list(replies)

    def generate(self, messages, stop_sequences=None, **kwargs):
        return ChatMessage(role=MessageRole.ASSISTANT, content=self.replies.pop(0))


class InACodeAgent(unittest.TestCase):
    def test_a_code_agent_runs_its_steps_in_the_executor(self):
        from smolagents.serialization import SafeSerializer
        sbx = FakeSandbox()
        agent = CodeAgent(tools=[], model=ScriptedModel(["<code>\nfinal_answer(6 * 7)\n</code>"]),
                          executor=RuntimeExecutor(sandbox=sbx), max_steps=2)
        final = {"name": "FinalAnswerException", "value": SafeSerializer.dumps(42, allow_pickle=False), "traceback": ""}
        sbx.respond = lambda code: (
            {"status": "error", "stdout": "", "stderr": "", "results": [], "error": final}
            if code.strip() == "final_answer(6 * 7)" else ok())
        self.assertEqual(agent.run("6 times 7?"), 42)
        self.assertTrue(any("final_answer(6 * 7)" in code for code, _, _ in sbx.runs))


if __name__ == "__main__":
    unittest.main()
