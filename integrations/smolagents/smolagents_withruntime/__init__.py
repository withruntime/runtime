"""Runtime Cloud sandboxes as a smolagents code executor.

``RuntimeExecutor`` runs the Python a ``CodeAgent`` writes in a Runtime Cloud
sandbox, a Firecracker microVM with its own kernel, through the sandbox's
stateful interpreter: variables, imports and files persist between steps, as
in E2B's or Modal's executor::

    from smolagents import CodeAgent, InferenceClientModel
    from smolagents_withruntime import RuntimeExecutor

    agent = CodeAgent(tools=[], model=InferenceClientModel(), executor=RuntimeExecutor())
    agent.run("What is the 20th Fibonacci number?")
    agent.cleanup()  # stops the sandbox

The package also registers ``runtime`` in the ``smolagents.executors`` entry
point group, so a smolagents release that loads executors from it accepts
``executor_type="runtime"``. The key comes from RUNTIME_API_KEY or the
machine's ``npx withruntime login``.
"""
from __future__ import annotations

import base64
import json
from io import BytesIO
from typing import Any

from smolagents.local_python_executor import CodeOutput
from smolagents.monitoring import AgentLogger, LogLevel
from smolagents.remote_executors import RemotePythonExecutor
from smolagents.utils import AgentError
from withruntime import Sandbox

__all__ = ["RuntimeExecutor"]
__version__ = "0.1.0"

# The richest representation first, as smolagents' E2B executor reads a result.
_DATA_TYPES = ("application/json", "text/html", "text/markdown", "text/latex", "image/svg+xml", "text/plain")


class RuntimeExecutor(RemotePythonExecutor):
    """Run a CodeAgent's code in a Runtime Cloud sandbox.

    Args:
        additional_imports: Python packages to install in the sandbox first.
        logger: The agent's logger; a default one is made when it is omitted.
        allow_pickle: As for every smolagents remote executor: whether values
            that JSON cannot carry may travel as pickles. Leave it False unless
            you trust the sandbox's output.
        sandbox: An existing ``withruntime.Sandbox`` to run in. The caller keeps
            it; ``cleanup()`` leaves it running.
        timeout_seconds: How long one code step may run, 60 by default.
        **create: Sandbox fields for a new sandbox, such as ``image``,
            ``vcpu``, ``memory_mib``, ``network`` or ``labels``. The executor
            owns that sandbox and ``cleanup()`` stops it.
    """

    def __init__(
        self,
        additional_imports: list[str] | None = None,
        logger: AgentLogger | None = None,
        allow_pickle: bool = False,
        *,
        sandbox: Sandbox | None = None,
        timeout_seconds: float = 60,
        **create: Any,
    ):
        super().__init__(list(additional_imports or []), logger or AgentLogger(level=LogLevel.INFO), allow_pickle)
        self.timeout_ms = int(timeout_seconds * 1000)
        self._owns_sandbox = sandbox is None
        self.sandbox = sandbox if sandbox is not None else Sandbox.create(**create)
        try:
            self.installed_packages = self.install_packages(self.additional_imports)
        except BaseException:
            self.cleanup()
            raise
        self.logger.log(f"Runtime sandbox {self.sandbox.id} is running", level=LogLevel.INFO)

    def run_code_raise_errors(self, code: str) -> CodeOutput:
        execution = self.sandbox.interpreter.run(code, language="python", timeout_ms=self.timeout_ms)
        logs = (execution.get("stdout") or "") + (execution.get("stderr") or "")
        error = execution.get("error")
        if error:
            if error.get("name") == self.FINAL_ANSWER_EXCEPTION:
                answer = self._deserialize_final_answer(error.get("value") or "", self.allow_pickle)
                return CodeOutput(output=answer, logs=logs, is_final_answer=True)
            raise AgentError(
                f"{logs}\nExecuting code yielded an error:\n{error.get('name')}\n{error.get('value')}\n"
                f"{error.get('traceback') or ''}",
                self.logger,
            )
        if execution.get("status") not in (None, "ok"):
            raise AgentError(f"{logs}\nExecuting code did not finish: {execution.get('status')}", self.logger)
        return CodeOutput(output=_output(execution.get("results") or []), logs=logs, is_final_answer=False)

    def install_packages(self, additional_imports: list[str]) -> list[str]:
        """Installs into the interpreter's own Python, which a shell's
        ``pip`` may not be."""
        if additional_imports:
            code = (
                "import subprocess, sys\n"
                f"_r = subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', *{list(additional_imports)!r}],"
                " capture_output=True, text=True)\n"
                "print(_r.stdout[-2000:], _r.stderr[-2000:])\n"
                "if _r.returncode: raise RuntimeError(f'pip install exited with {_r.returncode}')\n"
                # pip installs into the user site, which a running interpreter
                # leaves off sys.path when the folder did not exist at its start.
                "import importlib, site\n"
                "site.addsitedir(site.getusersitepackages())\n"
                "importlib.invalidate_caches()"
            )
            self.logger.log(self.run_code_raise_errors(code).logs)
        return list(additional_imports)

    def cleanup(self) -> None:
        """Stops the sandbox this executor created; one passed in is left running."""
        sandbox = self.__dict__.pop("sandbox", None)
        if sandbox is None or not self._owns_sandbox:
            return
        try:
            self.logger.log("Stopping the Runtime sandbox...", level=LogLevel.INFO)
            sandbox.stop()
        except Exception as e:  # noqa: BLE001 - cleanup reports and never raises, as smolagents' executors do
            self.logger.log_error(f"Error stopping the Runtime sandbox: {e}")

    def delete(self) -> None:
        self.cleanup()

    def __del__(self) -> None:
        try:
            self.cleanup()
        except Exception:  # noqa: BLE001, S110 - nothing can be reported from a finalizer
            pass


def _output(results: list[dict[str, Any]]) -> Any:
    """The main result, as E2B's executor returns it; else the last image a
    cell displayed, such as a matplotlib figure; else None."""
    main = next((r for r in results if r.get("main")), None)
    images = [r for r in results if "image/png" in (r.get("data") or {}) or "image/jpeg" in (r.get("data") or {})]
    chosen = main or (images[-1] if images else None)
    if chosen is None:
        return None
    data = chosen.get("data") or {}
    for kind in ("image/png", "image/jpeg"):
        if kind in data:
            import PIL.Image

            return PIL.Image.open(BytesIO(base64.b64decode(data[kind])))
    for kind in _DATA_TYPES:
        if kind in data:
            value = data[kind]
            return json.loads(value) if kind == "application/json" and isinstance(value, str) else value
    return None
