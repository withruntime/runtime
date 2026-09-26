# The MCP catalog, and catalog MCP servers running in a sandbox.
#
#     catalog = await runtime.mcp.catalog()
#     gw = await sbx.mcp.start([{"id": "github", "secrets": {"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN"}}])
#     gw = await sbx.mcp.ready()              # every server installed
#     url, headers = gw["servers"][0]["url"], gw["headers"]
from __future__ import annotations

import time
from typing import Any, Optional



async def _sleep(seconds: float) -> None:
    from .._async_client import sleep  # here, not at the top: that module imports this one
    await sleep(seconds)


class AsyncMcp:
    """``runtime.mcp``: the catalog of MCP servers a sandbox can run."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def catalog(self) -> list[dict[str, Any]]:
        return (await self._t.json("GET", "/v1/mcp/catalog"))["data"]


class AsyncSandboxMcp:
    """``sbx.mcp``: MCP servers inside the sandbox, at URLs an agent connects to."""

    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def _path(self) -> str:
        return f"/v1/sandboxes/{self._sandbox.id}/mcp"

    async def start(self, servers: list[dict[str, Any]], *, port: Optional[int] = None,
                    replace: bool = False) -> dict[str, Any]:
        body: dict[str, Any] = {"servers": servers}
        if port is not None:
            body["port"] = port
        if replace:
            body["replace"] = True
        return await self._t.json("POST", self._path(), body=body)

    async def get(self) -> dict[str, Any]:
        """Their state, and fresh URLs."""
        return await self._t.json("GET", self._path())

    async def ready(self, *, timeout: float = 600, interval: float = 2) -> dict[str, Any]:
        """Waits until no server is still installing."""
        deadline = time.monotonic() + timeout
        while True:
            state = await self.get()
            if not state["running"] or all(s["status"] != "installing" for s in state["servers"]):
                return state
            if time.monotonic() > deadline:
                return state
            await _sleep(interval)

    async def stop(self) -> bool:
        return bool((await self._t.json("DELETE", self._path()))["stopped"])
