"""E2B code interpreter's AsyncSandbox over Runtime's interpreter. The sync
Sandbox is generated from this file by scripts/generate_sync.py."""
from __future__ import annotations

import base64
import re
import time
from typing import Any, Callable, Dict, List, Optional, Union

from .. import _core as core
from .._async_io import call, wrap
from .._async_sandbox import AsyncSandbox as _Base
from .._async_sandbox import _guard
from ._models import Context, Execution, ExecutionError, Logs, OutputMessage, Result

_TEXT = re.compile(r"^text/|json|javascript|svg|latex")


def _lines(text: str) -> List[str]:
    return re.findall(r"[^\n]*\n|[^\n]+$", text or "")


def _language(requested: Optional[str]) -> str:
    if requested in (None, "python"):
        return "python"
    if requested in ("javascript", "js"):
        return "javascript"
    raise core.NotSupportedException(
        f"Running {requested} code in the interpreter",
        "Use sandbox.commands.run(code)." if requested == "bash" else
        "Runtime's interpreter runs Python and JavaScript; install the language and use sandbox.commands.run(...).")


class AsyncSandbox(_Base):
    """The code interpreter sandbox: the base sandbox plus run_code and contexts."""

    default_template = "code-interpreter-v1"

    def __init__(self, runtime: Any, client: Any, envs: Optional[Dict[str, str]] = None) -> None:
        super().__init__(runtime, client, envs)
        self._env_contexts: Dict[str, str] = {}

    @property
    def _interpreter(self) -> Any:
        return self.runtime.interpreter

    async def _context_for(self, language: str, context: Optional[Context]) -> Optional[str]:
        """The context asked for; else, when the sandbox has envs, one made once
        with them; else Runtime's default one."""
        if context is not None:
            return context.id
        if not self._envs:
            return None
        if language not in self._env_contexts:
            wanted = f"e2b-{language}"
            try:
                made = await _guard("sandbox", lambda: self._interpreter.contexts.create(
                    id=wanted, language=language, env=self._envs))
                self._env_contexts[language] = made["id"]
            except core.SandboxException:
                existing = await _guard("sandbox", lambda: self._interpreter.contexts.list())
                if not any(one["id"] == wanted for one in existing):
                    raise
                self._env_contexts[language] = wanted
        return self._env_contexts[language]

    async def _inline(self, result: Dict[str, Any]) -> Dict[str, Any]:
        data = dict(result.get("data") or {})
        for mime, ref in (result.get("refs") or {}).items():
            if mime in data:
                continue
            content = await _guard("sandbox", lambda ref=ref: self._interpreter.result(ref))
            data[mime] = content.decode() if _TEXT.search(mime) else base64.b64encode(content).decode()
        return data

    async def run_code(self, code: str, language: Optional[str] = None, context: Optional[Context] = None,
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
        target = await self._context_for(lang, context)
        timeout_ms = 60_000 if timeout is None else core.command_timeout_ms(timeout)
        now = lambda: time.time_ns()  # noqa: E731
        streams: Dict[str, Any] = {}
        if on_stdout is not None:
            streams["on_stdout"] = wrap(lambda text: on_stdout(OutputMessage(text, now(), False)))
        if on_stderr is not None:
            streams["on_stderr"] = wrap(lambda text: on_stderr(OutputMessage(text, now(), True)))
        if on_error is not None:
            streams["on_error"] = wrap(lambda error: on_error(ExecutionError(
                error["name"], error["value"], error["traceback"])))
        execution = await _guard("sandbox", lambda: self._interpreter.run(
            code, **({"context": target} if target else {"language": lang}), timeout_ms=timeout_ms, **streams))
        status = execution.get("status")
        if status == "timeout":
            raise core.TimeoutException(f"Execution timed out after {timeout_ms} ms: pass a larger 'timeout'.")
        if status == "lost":
            raise core.SandboxException("The interpreter lost this run (its context stopped); run it again.")
        results = []
        for result in execution.get("results") or []:
            results.append(Result(await self._inline(result), bool(result.get("main"))))
        for result in results:
            await call(on_result, result)
        error = execution.get("error")
        return Execution(
            results=results, logs=Logs(stdout=_lines(execution.get("stdout", "")),
                                       stderr=_lines(execution.get("stderr", ""))),
            error=ExecutionError(error["name"], error["value"], error["traceback"]) if error else None,
            execution_count=execution.get("executionCount"))

    async def create_code_context(self, cwd: Optional[str] = None, language: Optional[str] = None,
                                  request_timeout: Optional[float] = None) -> Context:
        lang = _language(language)
        made = await _guard("sandbox", lambda: self._interpreter.contexts.create(
            language=lang, cwd=cwd, env=self._envs or None))
        return Context(made["id"], made["language"], made["cwd"])

    async def remove_code_context(self, context: Union[Context, str]) -> None:
        context_id = context if isinstance(context, str) else context.id
        await _guard("sandbox", lambda: self._interpreter.contexts.remove(context_id))

    async def list_code_contexts(self) -> List[Context]:
        contexts = await _guard("sandbox", lambda: self._interpreter.contexts.list())
        return [Context(one["id"], one["language"], one["cwd"]) for one in contexts]

    async def restart_code_context(self, context: Union[Context, str]) -> None:
        context_id = context if isinstance(context, str) else context.id
        await _guard("sandbox", lambda: self._interpreter.contexts.restart(context_id))


__all__ = ["AsyncSandbox"]
