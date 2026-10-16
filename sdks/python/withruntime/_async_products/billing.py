from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote


class AsyncBilling:
    """``runtime.billing``. Add credit without a browser, in stablecoins
    (USDC on Base, Solana or Tempo, as Stripe offers them). Billing is the
    account's, so it spans products."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def topup(self, usd: float, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Open a stablecoin top-up of ``usd`` dollars ($10 to $10,000). The
        answer holds ``amount``, the exact token amount to send to six
        decimals, and ``networks``: an ``address`` on each network and the
        ``tokens`` it takes. Send exactly ``amount`` before ``payBy``, then poll
        :meth:`topup_status` until ``status`` is ``paid``. A different amount,
        token or network cannot be matched or returned automatically. Pass
        the same ``idempotency_key`` when retrying to get the same top-up."""
        return await self._t.json(
            "POST", "/v1/billing/topups", body={"usd": usd}, idempotency_key=idempotency_key
        )

    async def topup_status(self, purchase_id: str) -> dict[str, Any]:
        """A top-up's ``status``: ``open`` (waiting for your payment),
        ``pending`` (Stripe is confirming), ``paid`` (credit added) or
        ``expired`` (nothing arrived in time)."""
        return await self._t.json("GET", f"/v1/billing/topups/{quote(purchase_id, safe='')}")

    async def auto_top_up(self) -> dict[str, Any]:
        """Auto top-up's settings: ``enabled``, ``below``, ``amount`` and
        ``monthlyLimit`` in dollars, ``thisMonth``, whether a ``card`` is
        saved, ``offReason`` when it turned itself off, and ``saveCardAt``,
        where a person saves the card, while none is saved."""
        return await self._t.json("GET", "/v1/billing/auto-top-up")

    async def set_auto_top_up(
        self,
        enabled: bool,
        below: Optional[float] = None,
        amount: Optional[float] = None,
        monthly_limit: Optional[float] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        """When credit falls below ``below`` dollars ($10 at least), charge the
        saved card ``amount`` ($20 to $10,000, at most $500 in an account's
        first week) plus tax, at most ``monthly_limit`` ($100 at least) a
        calendar month. A figure left out keeps the one saved, or takes its
        default: $10, $20 and $500. Each automatic top-up adds 5% more as
        credit, and while it is on the account may run 200 sandboxes at once.
        ``enabled`` turns it on once a card is saved."""
        body: dict[str, Any] = {"enabled": enabled}
        if below is not None:
            body["below"] = below
        if amount is not None:
            body["amount"] = amount
        if monthly_limit is not None:
            body["monthlyLimit"] = monthly_limit
        return await self._t.json(
            "PUT",
            "/v1/billing/auto-top-up",
            body=body,
            idempotency_key=idempotency_key,
        )

    async def auto_top_up_off(self, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Turn auto top-up off. The figures and the card are kept, and running
        sandboxes are never stopped."""
        return await self._t.json("DELETE", "/v1/billing/auto-top-up", idempotency_key=idempotency_key)
