"""GENERATED from _async_products/switching.py by scripts/generate_sync.py. Do not edit."""
from __future__ import annotations

from typing import Any, Optional


class Switching:
    """``runtime.switching``. What your sandboxes would have cost at a rival,
    and the switching credit: record the rival you are leaving before your
    first top-up, and that top-up is matched, up to $100, once the payment
    settles. Money is integer microdollars in strings."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def compare(self, provider: str, days: Optional[int] = None) -> dict[str, Any]:
        """Your settled sandbox usage over the last ``days`` (default 30, at
        most 90), priced on Runtime and at ``provider``'s published rates
        (``e2b``, ``daytona``, ``vercel``, ``modal``, ``cloudflare``, ``fly``,
        ``fly-machines`` and others): ``runtimeMicros``, ``rivalMicros``,
        ``savingMicros``, ``savingPercent`` and ``perMonth``. With no usage
        yet, ``basis`` is ``example`` and ``note`` says what was priced."""
        query: dict[str, Any] = {"provider": provider}
        if days is not None:
            query["days"] = days
        return self._t.json("GET", "/v1/usage/compare", query=query)

    def get(self) -> dict[str, Any]:
        """Whether a switch can still be recorded (``eligible``), and the one
        recorded (``switch``: provider, status, ``creditMicros``)."""
        return self._t.json("GET", "/v1/switching")

    def record(self, provider: str) -> dict[str, Any]:
        """Record the rival you are switching from, once and before your
        first top-up. The same provider again answers the same summary;
        another raises a 409 error."""
        return self._t.json("POST", "/v1/switching", body={"provider": provider})
