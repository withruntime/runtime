# A sandbox on your own Tailscale network, paid sandboxes only:
# ``await sbx.tailscale.up(auth_key_secret="TS_AUTHKEY", tags=["tag:agents"])``.
# The auth key is a secret stored for jobs (``runtime secrets set TS_AUTHKEY
# --jobs``); it stays in the sandbox's memory. ``down()`` takes the machine
# off the tailnet at once; after a stop or a delete, Tailscale removes it.
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote


class AsyncTailscale:
    """``sbx.tailscale``: this sandbox on your own Tailscale network."""

    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def _path(self) -> str:
        return f"/v1/sandboxes/{quote(self._sandbox.id, safe='')}/tailscale"

    async def up(self, *, auth_key_secret: str, hostname: Optional[str] = None,
                 tags: Optional[list[str]] = None) -> dict[str, Any]:
        """Joins the tailnet the key in ``auth_key_secret`` names. Answers the
        machine's ``addresses``, ``dnsName`` and ``mode``, never the key."""
        body = {k: v for k, v in {"authKeySecret": auth_key_secret, "hostname": hostname,
                                  "tags": tags}.items() if v is not None}
        return await self._t.json("POST", self._path(), body=body)

    async def status(self) -> dict[str, Any]:
        """Whether it is on a tailnet (``tailnet`` is None when not), and its
        addresses there."""
        return await self._t.json("GET", self._path())

    async def down(self) -> dict[str, Any]:
        """Logs the machine out: it leaves the tailnet at once."""
        return await self._t.json("DELETE", self._path())
