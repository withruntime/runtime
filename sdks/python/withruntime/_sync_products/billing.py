"""GENERATED from _async_products/billing.py by scripts/generate_sync.py. Do not edit."""
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote


class Billing:
    """``runtime.billing``. Add credit without a browser, in stablecoins
    (USDC on Base, Solana or Tempo, as Stripe offers them). Billing is the
    account's, so it spans products."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def topup(self, usd: float, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Open a stablecoin top-up of ``usd`` dollars ($10 to $10,000). The
        answer holds ``amount``, the exact token amount to send to six
        decimals, and ``networks``: an ``address`` on each network and the
        ``tokens`` it takes. Send exactly ``amount`` before ``payBy``, then poll
        :meth:`topup_status` until ``status`` is ``paid``. A different amount,
        token or network cannot be matched or returned automatically. Pass
        the same ``idempotency_key`` when retrying to get the same top-up."""
        return self._t.json(
            "POST", "/v1/billing/topups", body={"usd": usd}, idempotency_key=idempotency_key
        )

    def topup_status(self, purchase_id: str) -> dict[str, Any]:
        """A top-up's ``status``: ``open`` (waiting for your payment),
        ``pending`` (Stripe is confirming), ``paid`` (credit added) or
        ``expired`` (nothing arrived in time)."""
        return self._t.json("GET", f"/v1/billing/topups/{quote(purchase_id, safe='')}")
