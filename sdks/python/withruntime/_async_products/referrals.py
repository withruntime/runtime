from __future__ import annotations

from typing import Any


class AsyncReferrals:
    """``runtime.referrals``. A company that signs up with your link has every
    payment in its first 30 days matched, up to $1,000 in total, and you get the
    same; its first payment of at least $10 gives each side at least $25. Then
    for 12 months you earn 10% of what it spends from credit it paid for (up to
    $50,000 a calendar year for you, matches and share together). Money is
    integer microdollars in strings."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def get(self) -> dict[str, Any]:
        """Your referral ``link`` and ``code``, the companies that signed up with
        it (``signedUp``, ``pending``, ``paid``, ``payingCompanies``) and the
        credit earned (``earnedMicros``, ``shareEarnedMicros``,
        ``capRemainingMicros``)."""
        return await self._t.json("GET", "/v1/referrals")
