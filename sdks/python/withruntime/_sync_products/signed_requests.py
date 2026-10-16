"""GENERATED from _async_products/signed_requests.py by scripts/generate_sync.py. Do not edit."""
from typing import Any


class SignedRequests:
    """On or off for the whole account. An account without credit gets a
    ``RuntimeError`` with code ``payment_required`` (402) when it turns it
    on."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def get(self) -> dict[str, Any]:
        """``enabled``, ``allowed`` (accounts with credit) and, when not, ``why``."""
        return self._t.json("GET", "/v1/networks/signed-requests")

    def set(self, *, enabled: bool) -> dict[str, Any]:
        """``enabled=True`` lets your sandboxes sign their requests as
        Runtime's; ``False`` stops new signatures at once, and ones already
        given expire within 5 minutes."""
        return self._t.json("PUT", "/v1/networks/signed-requests", body={"enabled": enabled})
