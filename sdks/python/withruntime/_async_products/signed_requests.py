"""``runtime.networks.signed_requests``: your sandboxes' requests carry
Runtime's signature.

Free, for an account with credit, and off until you turn it on. When on,
Runtime's browser signs every request it sends with Runtime's Web Bot Auth
signature (RFC 9421 HTTP message signatures), so sites behind Cloudflare and
other bot managers can tell Runtime's agents from anonymous traffic.

    await runtime.networks.signed_requests.set(enabled=True)
"""
from typing import Any


class AsyncSignedRequests:
    """On or off for the whole account. An account without credit gets a
    ``RuntimeError`` with code ``payment_required`` (402) when it turns it
    on."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def get(self) -> dict[str, Any]:
        """``enabled``, ``allowed`` (accounts with credit) and, when not, ``why``."""
        return await self._t.json("GET", "/v1/networks/signed-requests")

    async def set(self, *, enabled: bool) -> dict[str, Any]:
        """``enabled=True`` lets your sandboxes sign their requests as
        Runtime's; ``False`` stops new signatures at once, and ones already
        given expire within 5 minutes."""
        return await self._t.json("PUT", "/v1/networks/signed-requests", body={"enabled": enabled})
