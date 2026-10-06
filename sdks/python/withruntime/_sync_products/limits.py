"""GENERATED from _async_products/limits.py by scripts/generate_sync.py. Do not edit."""
from __future__ import annotations

from typing import Any


class Limits:
    """``runtime.limits``. Whether this key is read-only, the daily spending
    limit an owner set on its agent, and the machine time the account can still run without credit. A key can read the limit, never change it:
    the owner sets it at https://withruntime.com/account/keys. Past it, a
    create, wake, extension or renewal fails with ``spending_limit_reached``
    (HTTP 402). Money is integer microdollars in strings (1,000,000 = $1)."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def get(self) -> dict[str, Any]:
        """``access`` (``full``, ``read`` or ``selected``) and ``daily``:
        ``limitMicros`` (None for no limit), ``usedMicros`` in the last 24
        hours, and ``remainingMicros`` (None for no limit); and ``trial``, the
        machine time the account can still run without credit, in milliseconds
        (``availableMs``, with ``offer`` and ``renewsAt``), or None when it has
        none."""
        return self._t.json("GET", "/v1/limits")
