# ``sbx.network``: the sandbox's own network rules. Changes apply at once,
# to open connections too.
#
#     await sbx.network.set(internet=True, allow=["registry.npmjs.org"])
#     await sbx.network.off()
#
# ``connect`` lists host:port pairs beyond ports 80 and 443 (paid sandboxes of
# organizations with a paid purchase only).
from __future__ import annotations

from typing import Any, Optional


class AsyncNetwork:
    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def _path(self) -> str:
        return f"/v1/sandboxes/{self._sandbox.id}/network"

    async def get(self) -> dict[str, Any]:
        return await self._t.json("GET", self._path())

    async def set(self, *, internet: bool, allow: Optional[list[str]] = None,
                  deny: Optional[list[str]] = None,
                  connect: Optional[list[str]] = None) -> dict[str, Any]:
        """Replaces the rules."""
        body: dict[str, Any] = {"internet": internet}
        for name, value in (("allow", allow), ("deny", deny), ("connect", connect)):
            if value is not None:
                body[name] = value
        return await self._t.json("PUT", self._path(), body=body)

    async def off(self) -> dict[str, Any]:
        """No outbound connections at all."""
        return await self._t.json("PUT", self._path(), body={"internet": False})

    async def on(self) -> dict[str, Any]:
        """The host's public-web policy and nothing narrower."""
        return await self._t.json("PUT", self._path(), body={"internet": True})
