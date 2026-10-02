"""GENERATED from _async_products/private_network.py by scripts/generate_sync.py. Do not edit."""
from typing import Any


class PrivateNetwork:
    """On or off for the whole account. An account that has not added credit
    gets a ``RuntimeError`` with code ``payment_required`` (402) when it turns
    it on."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def get(self) -> dict[str, Any]:
        """``enabled``, ``allowed`` (paid accounts only) and, when not, ``why``."""
        return self._t.json("GET", "/v1/network/private")

    def set(self, *, enabled: bool) -> dict[str, Any]:
        """``enabled=True`` lets your sandboxes reach each other by name;
        ``False`` stops it and cuts open connections between them within
        seconds."""
        return self._t.json("PUT", "/v1/network/private", body={"enabled": enabled})
