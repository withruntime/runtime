"""GENERATED from code_interpreter/_async_ci.py by scripts/generate_e2b_sync.py. Do not edit."""
from __future__ import annotations

import base64
import re
import time
from typing import Any, Callable, Dict, List, Optional, Union

from .. import _core as core
from .._sync_io import call
from ..._request_scope import request_scope
from .._sync_sandbox import Sandbox as _Base
from .._sync_sandbox import _guard
from ._models import Context, Execution, ExecutionError, Logs, OutputMessage, Result

_TEXT = re.compile(r"^text/|json|javascript|svg|latex")


def _lines(text: str) -> List[str]:
    return re.findall(r"[^\n]*\n|[^\n]+$", text or "")


def _language(requested: Optional[str]) -> str:
    if requested in (None, "python"):
        return "python"
    if requested in ("javascript", "js"):
        return "javascript"
    if requested in ("typescript", "r", "java", "bash", "go"):
        return requested
    raise core.NotSupportedException(
        f"Running {requested} code in the interpreter",
        "Use Python, JavaScript, TypeScript, R, Java, Bash or Go.")


class Sandbox(_Base):
    """The code interpreter sandbox: the base sandbox plus run_code and contexts."""

    default_template = "code-interpreter-v1"

    @property
    def _interpreter(self) -> Any:
        return self.runtime.interpreter

    def _inline(self, result: Dict[str, Any]) -> Dict[str, Any]:
        data = dict(result.get("data") or {})
        for mime, ref in (result.get("refs") or {}).items():
            if mime in data:
                continue
            content = _guard("sandbox", lambda ref=ref: self._interpreter.result(ref))
            data[mime] = content.decode() if _TEXT.search(mime) else base64.b64encode(content).decode()
        return data

    def run_code(self, code: str, language: Optional[str] = None, context: Optional[Context] = None,
                       on_stdout: Optional[Callable[[OutputMessage], Any]] = None,
                       on_stderr: Optional[Callable[[OutputMessage], Any]] = None,
                       on_result: Optional[Callable[[Result], Any]] = None,
                       on_error: Optional[Callable[[ExecutionError], Any]] = None,
                       envs: Optional[Dict[str, str]] = None, timeout: Optional[float] = None,
                       request_timeout: Optional[float] = None) -> Execution:
        """Runs code in a stateful context. Errors in the code come back in
        ``execution.error``; a run past ``timeout`` seconds raises TimeoutException."""
        if language is not None and context is not None:
            raise core.InvalidArgumentException("Pass language or context, not both.")
        if envs:
            raise core.NotSupportedException(
                "Environment variables for one run (run_code envs)",
                "Make a context with them: sandbox.runtime.interpreter.contexts.create(env=...), then "
                "run_code(code, context=Context(id, language, cwd)).")
        lang = _language(context.language if context is not None else language)
        target = context.id if context is not None else None
        timeout_ms = 300_000 if timeout is None else core.command_timeout_ms(timeout)
        now = lambda: time.time_ns()  # noqa: E731
        streams: Dict[str, Any] = {}
        if on_stdout is not None:
            streams["on_stdout"] = lambda text: on_stdout(OutputMessage(text, now(), False))
        if on_stderr is not None:
            streams["on_stderr"] = lambda text: on_stderr(OutputMessage(text, now(), True))
        if on_error is not None:
            streams["on_error"] = lambda error: on_error(ExecutionError(
                error["name"], error["value"], error["traceback"]))
        # A consumer deadline detaches its request; it must not interrupt the cell.
        with request_scope(timeout_ms / 1000, connect_timeout=core.request_seconds(self, request_timeout)):
            execution = _guard("sandbox", lambda: self._interpreter.run(
                code, **({"context": target} if target else {"language": lang}), timeout_ms=0,
                interrupt_on_disconnect=False, **streams))
        status = execution.get("status")
        if status == "timeout":
            raise core.TimeoutException(f"Execution timed out after {timeout_ms} ms: pass a larger 'timeout'.")
        if status == "lost":
            raise core.SandboxException("The interpreter lost this run (its context stopped); run it again.")
        results = []
        for result in execution.get("results") or []:
            results.append(Result._from_mime(self._inline(result), bool(result.get("main"))))
        for result in results:
            call(on_result, result)
        error = execution.get("error")
        return Execution(
            results=results, logs=Logs(stdout=_lines(execution.get("stdout", "")),
                                       stderr=_lines(execution.get("stderr", ""))),
            error=ExecutionError(error["name"], error["value"], error["traceback"]) if error else None,
            execution_count=execution.get("executionCount"))

    def create_code_context(self, cwd: Optional[str] = None, language: Optional[str] = None,
                                  request_timeout: Optional[float] = None) -> Context:
        lang = _language(language)
        made = _guard("sandbox", lambda: self._interpreter.contexts.create(
            language=lang, cwd=cwd), core.request_seconds(self, request_timeout))
        return Context(made["id"], made["language"], made["cwd"])

    def remove_code_context(self, context: Union[Context, str]) -> None:
        context_id = context if isinstance(context, str) else context.id
        _guard("sandbox", lambda: self._interpreter.contexts.remove(context_id))

    def list_code_contexts(self) -> List[Context]:
        contexts = _guard("sandbox", lambda: self._interpreter.contexts.list())
        return [Context(one["id"], one["language"], one["cwd"]) for one in contexts]

    def restart_code_context(self, context: Union[Context, str]) -> None:
        context_id = context if isinstance(context, str) else context.id
        _guard("sandbox", lambda: self._interpreter.contexts.restart(context_id))


__all__ = ["Sandbox"]
