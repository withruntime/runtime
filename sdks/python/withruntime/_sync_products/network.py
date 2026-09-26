"""GENERATED from _async_products/network.py by scripts/generate_sync.py. Do not edit."""
# ``sbx.network``: the sandbox's own network rules. Changes apply at once,
# to open connections too.
#
#     sbx.network.set(internet=True, allow=["registry.npmjs.org"])
#     sbx.network.off()
#
# ``connect`` lists host:port pairs beyond ports 80 and 443 (paid sandboxes of
# organizations with a paid purchase only).
from __future__ import annotations

from typing import Any, Optional


class Network:
    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def _path(self) -> str:
        return f"/v1/sandboxes/{self._sandbox.id}/network"

    def get(self) -> dict[str, Any]:
        return self._t.json("GET", self._path())

    def set(self, *, internet: bool, allow: Optional[list[str]] = None,
                  deny: Optional[list[str]] = None,
                  connect: Optional[list[str]] = None) -> dict[str, Any]:
        """Replaces the rules."""
        body: dict[str, Any] = {"internet": internet}
        for name, value in (("allow", allow), ("deny", deny), ("connect", connect)):
            if value is not None:
                body[name] = value
        return self._t.json("PUT", self._path(), body=body)

    def off(self) -> dict[str, Any]:
        """No outbound connections at all."""
        return self._t.json("PUT", self._path(), body={"internet": False})

    def on(self) -> dict[str, Any]:
        """The host's public-web policy and nothing narrower."""
        return self._t.json("PUT", self._path(), body={"internet": True})
