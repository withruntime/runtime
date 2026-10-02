"""A rival's sandbox may be asked to live longer than one Runtime lease (an
hour at most): Vercel's execution_time_limit over an hour, Daytona's
auto_stop_interval over an hour or 0. The drop-ins renew the lease toward the
time asked for while their sandbox object lives, never past it. The
TypeScript twin is packages/cloud-sdk/src/compat/lease.ts."""
from __future__ import annotations

import math
from datetime import datetime
from typing import Any

#: The most one lease runs ahead of now, in seconds.
LEASE_MAX_SECONDS = 3600
#: How often a keeper looks again while a lease must outlive its next renewal.
EVERY_SECONDS = 60


def epoch(stamp: Any) -> float:
    """An ISO 8601 time as epoch seconds; NaN when there is none."""
    if not stamp:
        return math.nan
    return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()


def extension_seconds(expires_at: float, until: float, now: float, margin: float) -> int:
    """Whole seconds to add to a lease ending at ``expires_at`` so it reaches
    toward ``until``, at most an hour ahead of ``now``; 0 when more than
    ``margin`` is left, nothing is to be added, or the lease has no end."""
    if not math.isfinite(expires_at) or expires_at - now > margin:
        return 0
    target = min(until, now + LEASE_MAX_SECONDS)
    return max(0, int(math.floor(target - expires_at)))
