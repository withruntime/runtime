"""GENERATED from _async_products/interpreter.py by scripts/generate_sync.py. Do not edit."""
# A stateful interpreter in a sandbox, in Python, JavaScript, TypeScript, R,
# Java, Bash or Go:
# ``execution = sbx.interpreter.run("import pandas as pd; pd.DataFrame({'a': [1]})")``.
# Variables persist between runs of the same context, like a notebook.
from __future__ import annotations

import re
from typing import Any, Callable, Optional, Union
from urllib.parse import quote

from .._errors import RuntimeError
from .._request_scope import request_scope

_RESULT = re.compile(r"^/workspace/\.runtime/interpreter/([a-z0-9][a-z0-9-]*)/out/([A-Za-z0-9][A-Za-z0-9_.-]*)$")
Callback = Optional[Callable[[Any], Any]]


def _enc(value: str) -> str:
    return quote(value, safe="")


def _notify(handler, value):
    import inspect  # on the first callback, not on every import of the SDK
    outcome = handler(value)
    if inspect.isawaitable(outcome):
        outcome


class InterpreterContexts:
    """``sbx.interpreter.contexts``: isolated interpreters with their own state,
    directory and environment. Each language's own name ("python", "r", "go"...) is
    its default context, started on first use."""

    def __init__(self, t: Any, base: Callable[[], str]) -> None:
        self._t = t
        self._base = base

    def list(self) -> list[dict[str, Any]]:
        return (self._t.json("GET", f"{self._base()}/contexts"))["data"]

    def create(self, *, id: Optional[str] = None, language: Optional[str] = None,  # noqa: A002
                     cwd: Optional[str] = None, env: Optional[dict[str, str]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        body = {k: v for k, v in {"id": id, "language": language, "cwd": cwd, "env": env}.items() if v is not None}
        return self._t.json("POST", f"{self._base()}/contexts", body=body, idempotency_key=idempotency_key)

    def restart(self, context_id: str) -> dict[str, Any]:
        """Starts the context again with empty state."""
        return self._t.json("POST", f"{self._base()}/contexts/{_enc(context_id)}:restart", body={})

    def interrupt(self, context_id: str) -> bool:
        """Stops the running cell, as Ctrl-C would, and keeps the state."""
        return bool((self._t.json("POST", f"{self._base()}/contexts/{_enc(context_id)}:interrupt",
                                        body={}))["interrupted"])

    def remove(self, context_id: str) -> bool:
        return bool((self._t.json("DELETE", f"{self._base()}/contexts/{_enc(context_id)}"))["deleted"])


class Interpreter:
    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox
        self.contexts = InterpreterContexts(t, self._base)

    def _base(self) -> str:
        return f"/v1/sandboxes/{_enc(self._sandbox.id)}/interpreter"

    def run(self, code: str, *, language: Optional[str] = None, context: Optional[str] = None,
                  timeout_ms: Optional[int] = None, on_stdout: Callback = None, on_stderr: Callback = None,
                  on_result: Callback = None, on_error: Callback = None,
                  idempotency_key: Optional[str] = None, interrupt_on_disconnect: Optional[bool] = None) -> dict[str, Any]:
        """Runs a cell and returns the execution: status, stdout, stderr,
        results (MIME bundles: text/plain, text/html, image/png as base64,
        application/json, application/vnd.runtime.table+json) and error. With
        any ``on_*`` callback, output streams to it as it happens."""
        body: dict[str, Any] = {"code": code}
        for name, value in (("language", language), ("context", context), ("timeoutMs", timeout_ms),
                            ("interruptOnDisconnect", interrupt_on_disconnect)):
            if value is not None:
                body[name] = value
        # An unlimited cell does not override an enclosing request deadline.
        with request_scope(**({"idle_timeout": 0} if timeout_ms == 0 else {})):
            timeout = None if timeout_ms == 0 else (timeout_ms or 60_000) / 1000 + 60
            if not (on_stdout or on_stderr or on_result or on_error):
                return self._t.json("POST", f"{self._base()}:run", body=body, timeout=timeout,
                                          idempotency_key=idempotency_key)
            from .._sync_client import _close_events
            events = self._t.events("POST", f"{self._base()}:run", body={**body, "stream": True},
                                    timeout=timeout, idempotency_key=idempotency_key)
            try:
                for event in events:
                    kind = event.get("k")
                    if kind in ("stdout", "stderr"):
                        handler = on_stdout if kind == "stdout" else on_stderr
                        if handler:
                            _notify(handler, event["text"])
                    elif kind == "result" and on_result:
                        _notify(on_result, {"main": event["main"], "data": event["data"], "refs": event["refs"]})
                    elif kind == "error" and on_error:
                        _notify(on_error, {"name": event["name"], "value": event["value"], "traceback": event["traceback"]})
                    elif kind == "execution":
                        return event["execution"]
                    elif kind == "failure":
                        raise RuntimeError(event["message"], code=event["code"], status=event.get("status") or 0,
                                           hint=event.get("hint"), request_id=event.get("requestId"))
            finally:
                _close_events(events)
            raise RuntimeError("The interpreter stream ended without a result.", code="stream_ended")

    def result(self, ref: Union[dict[str, Any], str]) -> bytes:
        """The bytes of a result too large to travel inline (a ``refs`` entry)."""
        match = _RESULT.match(ref if isinstance(ref, str) else ref["path"])
        if not match:
            raise ValueError("Not an interpreter result path.")
        return self._t.bytes("GET", f"{self._base()}/contexts/{match[1]}/results/{match[2]}")
