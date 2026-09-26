from __future__ import annotations

from typing import Any


class AsyncReferrals:
    """``runtime.referrals``. When a company that signs up with your link makes
    its first top-up of at least $10, you and it each get credit equal to that
    top-up, at least $25 and at most $500 (up to $10,000 a calendar year for
    you). Money is integer microdollars in strings."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def get(self) -> dict[str, Any]:
        """Your referral ``link`` and ``code``, the companies that signed up with
        it (``signedUp``, ``pending``, ``paid``, ``capped``, ``reversed``) and
        the credit earned (``earnedMicros``, ``capRemainingMicros``)."""
        return await self._t.json("GET", "/v1/referrals")
