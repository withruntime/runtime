"""The code interpreter adapter against the fake withruntime SDK."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2b_fake import World  # noqa: E402

from withruntime.e2b.code_interpreter import (AsyncSandbox, CommandExitException, Context, Execution,  # noqa: E402
                                              NotSupportedException, OutputMessage, Result, Sandbox,
                                              TimeoutException)


class RunCode(unittest.TestCase):
    def setUp(self) -> None:
        self.world = World()

    def create(self, **kwargs):
        return Sandbox.create(client=self.world.client(), **kwargs)

    def test_python_by_default(self):
        sbx = self.create()
        execution = sbx.run_code("1 + 1")
        self.assertIsInstance(execution, Execution)
        self.assertEqual(execution.text, "2")
        self.assertIsInstance(execution.results[0], Result)
        self.assertEqual(execution.results[0].formats(), ["text"])
        self.assertEqual((execution.logs.stdout, execution.logs.stderr), (["out 1 + 1\n"], []))
        self.assertEqual(execution.execution_count, 1)
        self.assertIsNone(execution.error)
        self.assertEqual(self.world.called("interpreter.run")[0],
                         ("1 + 1", {"language": "python", "timeout_ms": 60_000}))

    def test_base_commands_still_work(self):
        from e2b_fake import Result as Run
        self.world.exec = lambda *_: Run(1, "", "no\n")
        with self.assertRaises(CommandExitException):
            self.create().commands.run("false")

    def test_rich_results(self):
        self.world.interpreter = lambda *_: {
            "status": "ok", "stdout": "a\nb\npartial", "stderr": "warn\n", "executionCount": 4, "error": None,
            "results": [
                {"main": False, "data": {"image/png": "iVBOR", "text/plain": "<Figure>"}, "refs": {}},
                {"main": True, "data": {"application/vnd.runtime.table+json": {"columns": ["a"]}},
                 "refs": {"text/html": {"path": "/workspace/.runtime/interpreter/python/out/1.html"}}}]}
        execution = self.create().run_code("df")
        self.assertEqual(execution.logs.stdout, ["a\n", "b\n", "partial"])
        figure, table = execution.results
        self.assertEqual((figure.png, figure.text, figure.is_main_result), ("iVBOR", "<Figure>", False))
        self.assertEqual(table.html, "bytes of /workspace/.runtime/interpreter/python/out/1.html")
        self.assertEqual(table.extra, {"application/vnd.runtime.table+json": {"columns": ["a"]}})
        self.assertIsNone(table.data)
        self.assertIsNone(table.chart)

    def test_errors_timeouts_and_refusals(self):
        self.world.interpreter = lambda *_: {"status": "error", "stdout": "", "stderr": "", "results": [],
                                             "error": {"name": "ZeroDivisionError", "value": "division by zero",
                                                       "traceback": "..."}}
        sbx = self.create()
        self.assertEqual(sbx.run_code("1/0").error.name, "ZeroDivisionError")
        self.world.interpreter = lambda *_: {"status": "timeout", "stdout": "", "stderr": "", "results": []}
        with self.assertRaises(TimeoutException):
            sbx.run_code("while True: pass", timeout=1)
        for language in ("bash", "r", "typescript", "java"):
            with self.assertRaises(NotSupportedException):
                sbx.run_code("1", language=language)
        with self.assertRaises(NotSupportedException):
            sbx.run_code("1", envs={"A": "1"})

    def test_streams(self):
        sbx = self.create()
        out, results = [], []
        sbx.run_code("print(1)", on_stdout=out.append, on_result=results.append)
        self.assertIsInstance(out[0], OutputMessage)
        self.assertEqual((out[0].line, out[0].error), ("out print(1)\n", False))
        self.assertEqual([one.text for one in results], ["2"])

    def test_sandbox_envs_reach_code_through_one_context(self):
        sbx = self.create(envs={"TOKEN": "t"})
        sbx.run_code("import os")
        sbx.run_code("os.environ['TOKEN']")
        self.assertEqual(self.world.called("contexts.create"),
                         [({"id": "e2b-python", "language": "python", "env": {"TOKEN": "t"}},)])
        self.assertEqual([call[1] for call in self.world.called("interpreter.run")],
                         [{"context": "e2b-python", "timeout_ms": 60_000}] * 2)
        other = Sandbox.create(client=self.world.client(), envs={"TOKEN": "t"})
        other.runtime.contexts["e2b-python"] = {"id": "e2b-python", "language": "python", "cwd": "/workspace"}
        other.run_code("1")
        self.assertEqual(self.world.called("interpreter.run")[-1][1]["context"], "e2b-python")

    def test_contexts(self):
        sbx = self.create()
        context = sbx.create_code_context(cwd="/tmp", language="javascript")
        self.assertEqual(context, Context("ctx-1", "javascript", "/tmp"))
        self.assertEqual(sbx.list_code_contexts(), [context])
        sbx.run_code("x", context=context)
        self.assertEqual(self.world.called("interpreter.run")[0][1], {"context": "ctx-1", "timeout_ms": 60_000})
        sbx.restart_code_context(context)
        sbx.remove_code_context("ctx-1")
        self.assertEqual(self.world.called("contexts.remove"), [("ctx-1",)])
        with self.assertRaises(NotSupportedException):
            sbx.create_code_context(language="r")


class AsyncRunCode(unittest.TestCase):
    def test_async(self):
        world = World()

        async def scenario():
            seen = []

            async def on_stdout(message):
                seen.append(message.line)

            sbx = await AsyncSandbox.create(client=world.async_client())
            execution = await sbx.run_code("1 + 1", on_stdout=on_stdout)
            await asyncio.sleep(0)
            self.assertEqual(execution.text, "2")
            self.assertEqual(seen, ["out 1 + 1\n"])
            context = await sbx.create_code_context(language="python")
            self.assertEqual((await sbx.list_code_contexts())[0].id, context.id)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
