"""Runtime sandboxes as a Pydantic AI toolset.

    from pydantic_ai import Agent
    from pydantic_ai_withruntime import RuntimeToolset

    agent = Agent("anthropic:claude-sonnet-4-6", toolsets=[RuntimeToolset()])
    result = agent.run_sync("Fit a line to (1,2), (2,4.1), (3,6.2) with numpy.")

Each agent run gets its own sandbox, a Firecracker microVM, created when the
run starts and stopped when it ends, even on an error. Pass ``sandbox=`` to use
one you created instead; it is never stopped for you. The model sees four
tools: ``runtime_exec``, ``runtime_read_file``, ``runtime_write_file`` and
``runtime_list_files``. The key comes from ``RUNTIME_API_KEY`` or this
machine's ``withruntime login``.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.toolsets import AbstractToolset, FunctionToolset, ToolsetTool
from typing_extensions import Self
from withruntime import AsyncRuntime, AsyncSandbox
from withruntime.tools import DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_SECONDS, WORKSPACE, sandbox_tools

__all__ = ["RuntimeToolset"]
__version__ = "0.1.0"
logger = logging.getLogger("pydantic_ai_withruntime")

_INSTRUCTIONS = (
    "You have a Linux sandbox (Ubuntu 24.04 with Python, Node.js, git and passwordless sudo). "
    "Use runtime_exec to run commands and the file tools to read and write files. "
    "Relative paths are under /workspace."
)


class RuntimeToolset(AbstractToolset[Any]):
    """Four tools bound to a Runtime sandbox, one sandbox per agent run.

    Args:
        sandbox: An ``AsyncSandbox`` you created and own. When given, every run
            shares it and it is never stopped for you.
        create: Fields for ``AsyncRuntime.sandboxes.create`` for each run's
            sandbox, such as ``{"vcpu": 2, "image": "my-image:v1"}``. A
            ``timeout_seconds`` lease of 30 minutes, ending in a stop, applies
            unless you set one, so a crashed process leaves nothing running.
        runtime: The client to create sandboxes with. Default: a new
            ``AsyncRuntime()`` for each run.
        root: Where relative paths resolve. Default ``/workspace``.
        timeout_seconds: Limit for a command the model starts without one.
        max_output_chars: Characters kept from each output; the rest is cut
            from the front, keeping the end, where errors are.
        instructions: Added to the agent's instructions. ``None`` adds none.
        id: The toolset's id, unique within an agent.
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
        instructions: str | None = _INSTRUCTIONS,
        id: str | None = "runtime",
    ) -> None:
        self._sandbox = sandbox
        self._owned = sandbox is None
        self._create = dict(create or {})
        self._runtime = runtime
        self._client: AsyncRuntime | None = None
        self._tool_options = {"root": root, "timeout_seconds": timeout_seconds, "max_output_chars": max_output_chars}
        self._instructions = instructions
        self._id = id
        self._tools: FunctionToolset[Any] | None = None if sandbox is None else self._bind(sandbox)
        self._entered = 0

    @property
    def id(self) -> str | None:
        return self._id

    @property
    def label(self) -> str:
        return f"RuntimeToolset({self._sandbox.id if self._sandbox else 'one sandbox per run'})"

    @property
    def sandbox(self) -> AsyncSandbox | None:
        """The sandbox the tools run in; ``None`` outside a run when the toolset makes its own."""
        return self._sandbox

    def _bind(self, sandbox: AsyncSandbox) -> FunctionToolset[Any]:
        return FunctionToolset(sandbox_tools(sandbox, **self._tool_options), id=f"{self._id or 'runtime'}-tools")

    async def for_run(self, ctx: RunContext[Any]) -> AbstractToolset[Any]:
        if not self._owned:
            return self
        return RuntimeToolset(
            create=self._create,
            runtime=self._runtime,
            instructions=self._instructions,
            id=self._id,
            **self._tool_options,
        )

    async def __aenter__(self) -> Self:
        self._entered += 1
        if self._owned and self._sandbox is None:
            try:
                if self._runtime is None:
                    self._client = AsyncRuntime()
                client = self._runtime or self._client
                fields = {"timeout_seconds": 1800, "on_lease_end": "stop", **self._create}
                fields["labels"] = {"created_by": "pydantic-ai", **(fields.get("labels") or {})}
                self._sandbox = await client.sandboxes.create(**fields)
                self._tools = self._bind(self._sandbox)
            except BaseException:
                self._entered -= 1
                sandbox, self._sandbox, self._tools = self._sandbox, None, None
                try:
                    try:
                        if sandbox is not None:
                            await sandbox.stop()
                    finally:
                        await self._close_client()
                except Exception as error:  # noqa: BLE001 - preserve the initialization failure
                    logger.warning("Runtime: could not clean up failed toolset initialization: %s", error)
                raise
        return self

    async def __aexit__(self, *args: object) -> bool | None:
        self._entered -= 1
        if self._entered == 0 and self._owned and self._sandbox is not None:
            sandbox, self._sandbox, self._tools = self._sandbox, None, None
            try:
                await sandbox.stop()
            finally:
                await self._close_client()
        return None

    async def _close_client(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.close()

    async def get_instructions(self, ctx: RunContext[Any]) -> str | None:
        return self._instructions

    async def get_tools(self, ctx: RunContext[Any]) -> dict[str, ToolsetTool[Any]]:
        if self._tools is None:
            raise RuntimeError("RuntimeToolset is used outside an agent run; its sandbox starts when the run does.")
        tools = await self._tools.get_tools(ctx)
        return {name: dataclasses.replace(tool, toolset=self) for name, tool in tools.items()}

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[Any], tool: ToolsetTool[Any]
    ) -> Any:
        assert self._tools is not None
        inner = (await self._tools.get_tools(ctx))[name]
        return await self._tools.call_tool(name, tool_args, ctx, inner)
