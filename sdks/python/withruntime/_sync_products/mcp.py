"""GENERATED from _async_products/mcp.py by scripts/generate_sync.py. Do not edit."""
# The MCP catalog, and catalog MCP servers running in a sandbox.
#
#     catalog = runtime.mcp.catalog()
#     gw = sbx.mcp.start([{"id": "github", "secrets": {"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN"}}])
#     gw = sbx.mcp.ready()              # every server installed
#     url, headers = gw["servers"][0]["url"], gw["headers"]
from __future__ import annotations

import time
from typing import Any, Optional



def _sleep(seconds: float) -> None:
    from .._sync_client import sleep  # here, not at the top: that module imports this one
    sleep(seconds)


class Mcp:
    """``runtime.mcp``: the catalog of MCP servers a sandbox can run."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def catalog(self) -> list[dict[str, Any]]:
        return (self._t.json("GET", "/v1/mcp/catalog"))["data"]


class SandboxMcp:
    """``sbx.mcp``: MCP servers inside the sandbox, at URLs an agent connects to."""

    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def _path(self) -> str:
        return f"/v1/sandboxes/{self._sandbox.id}/mcp"

    def start(self, servers: list[dict[str, Any]], *, port: Optional[int] = None,
                    replace: bool = False) -> dict[str, Any]:
        body: dict[str, Any] = {"servers": servers}
        if port is not None:
            body["port"] = port
        if replace:
            body["replace"] = True
        return self._t.json("POST", self._path(), body=body)

    def get(self) -> dict[str, Any]:
        """Their state, and fresh URLs."""
        return self._t.json("GET", self._path())

    def ready(self, *, timeout: float = 600, interval: float = 2) -> dict[str, Any]:
        """Waits until no server is still installing."""
        deadline = time.monotonic() + timeout
        while True:
            state = self.get()
            if not state["running"] or all(s["status"] != "installing" for s in state["servers"]):
                return state
            if time.monotonic() > deadline:
                return state
            _sleep(interval)

    def stop(self) -> bool:
        return bool((self._t.json("DELETE", self._path()))["stopped"])
