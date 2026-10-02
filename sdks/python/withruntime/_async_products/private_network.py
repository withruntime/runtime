"""``runtime.network.private``: your sandboxes reach each other by name.

Paid accounts only, free, and off until you turn it on. When on, a program in
any of your sandboxes connects to another at ``<name>.sandbox.internal:<port>``
(the name it was created with) or ``<id>.sandbox.internal:<port>``, over TCP,
on any port but 10800, 10802 and 10853. Only your organization's sandboxes
answer.

    await runtime.network.private.set(enabled=True)
    # in any of your sandboxes: psql -h db.sandbox.internal -p 5432
"""
from typing import Any


class AsyncPrivateNetwork:
    """On or off for the whole account. An account that has not added credit
    gets a ``RuntimeError`` with code ``payment_required`` (402) when it turns
    it on."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def get(self) -> dict[str, Any]:
        """``enabled``, ``allowed`` (paid accounts only) and, when not, ``why``."""
        return await self._t.json("GET", "/v1/network/private")

    async def set(self, *, enabled: bool) -> dict[str, Any]:
        """``enabled=True`` lets your sandboxes reach each other by name;
        ``False`` stops it and cuts open connections between them within
        seconds."""
        return await self._t.json("PUT", "/v1/network/private", body={"enabled": enabled})
