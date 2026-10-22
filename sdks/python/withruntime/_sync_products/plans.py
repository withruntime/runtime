"""GENERATED from _async_products/plans.py by scripts/generate_sync.py. Do not edit."""
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote


class Plans:
    """``runtime.plans``: monthly plans whose fee is prepaid usage. The fee
    comes back as plan usage, spent first each month at the same measured
    prices, plus a bonus for committing; plan usage left at the period's end
    ends with it. Money is integer microdollars in strings.

    Every change answers ``{"checkoutUrl", "current"}``: ``checkoutUrl`` is
    where a person starts a first plan or a trial in the browser, ``None``
    once the change was made; ``current`` is the plan as it is now."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def list(self) -> dict[str, Any]:
        """``{"current", "plans"}``: the plan your organization holds (or
        ``None``, Free) and every plan you may choose.

        A plan has ``id``, ``name``, ``card`` (plans sharing one are one card
        with a switch), ``feeMicros``, ``yearlyFeeMicros`` (``None`` without a
        yearly price), ``bonusMicros``, ``trialDays``, ``firstPeriodDouble``,
        ``support`` (docs, agent, slack or dedicated), ``collection`` (card or
        invoice), ``contract``, ``position``, ``included`` (``product``,
        ``meter``, ``quantity``, ``unit``), ``limits`` (``limit``, ``max``,
        ``None`` for no limit), ``features`` and ``addOns`` (``id``, ``name``,
        ``feeMicros``, ``limits`` of ``limit`` and ``add``, ``feature``).

        ``current`` has ``planId``, ``name``, ``status`` (incomplete,
        trialing, active, past_due or canceled), ``interval`` (month or year),
        ``periodStart``, ``periodEnd``, ``trialEndsAt``, ``cancelAtPeriodEnd``,
        ``nextPlanId``, ``startedAt``, ``addOns`` (``id``, ``quantity``,
        ``endsAt``), ``autoUpgrade`` and ``planUsage`` (``grantedMicros``,
        ``leftMicros``, ``expiresAt``, or ``None``)."""
        return self._t.json("GET", "/v1/plans")

    def choose(self, plan: str, interval: Optional[str] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Start a plan, or move to another. With no plan, answers
        ``checkoutUrl``. A dearer plan starts at once, prorated; a cheaper one
        at ``periodEnd`` (``nextPlanId``). ``interval="year"`` pays ten months
        for twelve; monthly unless asked."""
        body: dict[str, Any] = {"plan": plan}
        if interval is not None:
            body["interval"] = interval
        return self._t.json("POST", "/v1/plans/choose", body=body, idempotency_key=idempotency_key)

    def cancel(self, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """End the plan at ``periodEnd`` (``cancelAtPeriodEnd``)."""
        return self._t.json("POST", "/v1/plans/cancel", body={}, idempotency_key=idempotency_key)

    def resume(self, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Keep a plan you cancelled, before ``periodEnd``."""
        return self._t.json("POST", "/v1/plans/resume", body={}, idempotency_key=idempotency_key)

    def add_on(self, add_on: str, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Add an add-on by id: charged now for the rest of the period,
        prorated, then with the plan."""
        return self._t.json("POST", "/v1/plans/add-ons", body={"addOn": add_on},
                                  idempotency_key=idempotency_key)

    def remove_add_on(self, add_on: str, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Remove an add-on: its charge stops now, and it holds to
        ``periodEnd``."""
        return self._t.json("DELETE", f"/v1/plans/add-ons/{quote(add_on, safe='')}",
                                  idempotency_key=idempotency_key)

    def auto_upgrade(self, on: bool, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Move up a plan by itself when a limit refuses (``True``), or not.
        Owners, and keys an owner made."""
        return self._t.json("PUT", "/v1/plans/auto-upgrade", body={"on": on},
                                  idempotency_key=idempotency_key)
