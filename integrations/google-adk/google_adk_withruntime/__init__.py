"""Runtime sandboxes for Google ADK.

Two ways in, both running in a Runtime sandbox (a Firecracker microVM):

    from google.adk.agents import Agent
    from google_adk_withruntime import RuntimeCodeExecutor, RuntimeToolset

    # The model writes Python blocks; ADK runs them in the sandbox.
    analyst = Agent(model="gemini-flash-latest", name="analyst", code_executor=RuntimeCodeExecutor())

    # The model calls shell and file tools in the sandbox.
    coder = Agent(model="gemini-flash-latest", name="coder", tools=[RuntimeToolset()])

The sandbox starts on first use and stops when the executor or toolset is
closed (``Runner.close()`` closes toolsets), when the object is garbage
collected, or at the end of its lease if the process dies first. The key comes
from ``RUNTIME_API_KEY`` or this machine's ``withruntime login``.
"""

from __future__ import annotations

import logging
import weakref
from typing import Any

from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.code_executors.base_code_executor import BaseCodeExecutor
from google.adk.code_executors.code_execution_utils import CodeExecutionInput, CodeExecutionResult
from google.adk.tools import BaseTool, FunctionTool
from google.adk.tools.base_toolset import BaseToolset
from pydantic import Field, PrivateAttr
from withruntime import AsyncRuntime, AsyncSandbox, Runtime, Sandbox
from withruntime.tools import DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_SECONDS, WORKSPACE, sandbox_tools

__all__ = ["RuntimeCodeExecutor", "RuntimeToolset"]
__version__ = "0.1.0"

logger = logging.getLogger("google_adk_withruntime")

_TIMEOUT_EXIT_CODE = 124
_LEASE_SECONDS = 1800


def _create_fields(create: dict[str, Any], created_by: str) -> dict[str, Any]:
    fields = {"timeout_seconds": _LEASE_SECONDS, "on_lease_end": "stop", **create}
    fields["labels"] = {"created_by": created_by, **(fields.get("labels") or {})}
    return fields


def _shell_exit_code(code: int | None, timed_out: bool) -> int | None:
    """Runtime gives a command a signal ended as the negative signal number; a shell says 128 + n."""
    if timed_out:
        return _TIMEOUT_EXIT_CODE
    if code is None:
        return None
    return 128 - code if code < 0 else code


def _stop_quietly(sandbox: Any) -> None:
    try:
        sandbox.stop(wait=False)
    except Exception as error:  # noqa: BLE001 - a finalizer must not raise; the lease stops it anyway
        logger.warning("Runtime: could not stop sandbox %s: %s", sandbox.id, error)


class RuntimeCodeExecutor(BaseCodeExecutor):
    """Runs the model's Python code blocks in a Runtime sandbox.

    One sandbox serves every execution of this executor, so files written by
    one block (and input files) are there for the next; each block runs in a
    fresh ``python3`` process in ``/workspace``.

    Attributes:
      create: Fields for ``Runtime.sandboxes.create``, such as ``{"vcpu": 2}``
        or ``{"image": "my-image:v1"}``. A 30-minute lease that ends in a
        stop applies unless ``timeout_seconds`` is given there, and the lease
        is kept ahead while the executor is open.
      sandbox_id: Run in this existing sandbox instead. It is never stopped.
      timeout_seconds: Wall-clock limit for one code block; it is killed
        after it and reports exit code 124.
    """

    create: dict[str, Any] = Field(default_factory=dict)
    sandbox_id: str | None = None
    timeout_seconds: int = Field(default=300, gt=0)
    stateful: bool = Field(default=False, frozen=True, exclude=True)
    optimize_data_file: bool = Field(default=False, frozen=True, exclude=True)

    _runtime: Runtime | None = PrivateAttr(default=None)
    _sandbox: Sandbox | None = PrivateAttr(default=None)
    _finalizer: weakref.finalize | None = PrivateAttr(default=None)

    def __init__(self, *, runtime: Runtime | None = None, **data: Any) -> None:
        if data.get("stateful"):
            raise ValueError("RuntimeCodeExecutor runs each block in a new process; stateful=True is not supported.")
        if data.get("optimize_data_file"):
            raise ValueError("RuntimeCodeExecutor does not support optimize_data_file=True.")
        super().__init__(**data)
        self._runtime = runtime

    @property
    def sandbox(self) -> Sandbox:
        """The sandbox, started on first use."""
        if self._sandbox is None:
            self._runtime = self._runtime or Runtime()
            if self.sandbox_id:
                self._sandbox = self._runtime.sandboxes.get(self.sandbox_id)
            else:
                self._sandbox = self._runtime.sandboxes.create(**_create_fields(self.create, "google-adk"))
                self._sandbox.keep_alive(margin_seconds=600)
                self._finalizer = weakref.finalize(self, _stop_quietly, self._sandbox)
        return self._sandbox

    def execute_code(
        self,
        invocation_context: Any,
        code_execution_input: CodeExecutionInput,
    ) -> CodeExecutionResult:
        sandbox = self.sandbox
        for file in code_execution_input.input_files:
            path = file.name if file.name.startswith("/") else f"{WORKSPACE}/{file.name}"
            sandbox.files.write(path, file.content)
        try:
            result = sandbox.exec(
                ["python3", "-c", code_execution_input.code],
                cwd=WORKSPACE,
                timeout_ms=self.timeout_seconds * 1000,
            )
        except Exception as error:  # noqa: BLE001 - reported to the model, as other executors do
            return CodeExecutionResult(stderr=f"Runtime sandbox error: {error}")
        stderr = result.stderr
        if result.timed_out:
            note = f"Timed out: the code ran past {self.timeout_seconds} seconds and was killed.\n"
            stderr = f"{stderr}{'' if not stderr or stderr.endswith(chr(10)) else chr(10)}{note}"
        return CodeExecutionResult(
            stdout=result.stdout, stderr=stderr, exit_code=_shell_exit_code(result.exit_code, result.timed_out)
        )

    def close(self) -> None:
        """Stops the sandbox this executor started. Safe to call twice."""
        if self._finalizer is not None:
            self._finalizer()
            self._finalizer = None
        self._sandbox = None


class RuntimeToolset(BaseToolset):
    """``runtime_exec``, ``runtime_read_file``, ``runtime_write_file`` and
    ``runtime_list_files`` as ADK tools, bound to one Runtime sandbox.

    Args:
      sandbox: An ``AsyncSandbox`` you created and own; it is never stopped.
      create: Fields for ``AsyncRuntime.sandboxes.create`` when the toolset
        makes its own sandbox, on the first ``get_tools``. A 30-minute lease
        that ends in a stop applies unless you set ``timeout_seconds``.
      runtime: The client to create it with. Default: ``AsyncRuntime()``.
      root, timeout_seconds, max_output_chars: as for ``withruntime.tools``.
      tool_filter, tool_name_prefix: as for any ADK toolset.
    """

    def __init__(
        self,
        sandbox: AsyncSandbox | None = None,
        *,
        create: dict[str, Any] | None = None,
        runtime: AsyncRuntime | None = None,
        root: str = WORKSPACE,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        max_output_chars: int = DEFAULT_MAX_OUTPUT_CHARS,
        tool_filter: Any = None,
        tool_name_prefix: str | None = None,
    ) -> None:
        super().__init__(tool_filter=tool_filter, tool_name_prefix=tool_name_prefix)
        self._sandbox = sandbox
        self._owned = sandbox is None
        self._create = dict(create or {})
        self._runtime = runtime
        self._client: AsyncRuntime | None = None
        self._options = {"root": root, "timeout_seconds": timeout_seconds, "max_output_chars": max_output_chars}
        self._tools: list[BaseTool] | None = None

    @property
    def sandbox(self) -> AsyncSandbox | None:
        return self._sandbox

    async def get_tools(self, readonly_context: ReadonlyContext | None = None) -> list[BaseTool]:
        if self._tools is None:
            if self._sandbox is None:
                if self._runtime is None:
                    self._client = AsyncRuntime()
                client = self._runtime or self._client
                self._sandbox = await client.sandboxes.create(**_create_fields(self._create, "google-adk"))
            self._tools = [FunctionTool(f) for f in sandbox_tools(self._sandbox, **self._options)]
        return [tool for tool in self._tools if self._is_tool_selected(tool, readonly_context)]

    async def close(self) -> None:
        sandbox, self._tools = self._sandbox, None
        if self._owned:
            self._sandbox = None
        try:
            if self._owned and sandbox is not None:
                await sandbox.stop()
        finally:
            client, self._client = self._client, None
            if client is not None:
                await client.close()
