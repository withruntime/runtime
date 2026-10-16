"""CLOUD.md section 4: one plural word names a product everywhere. An old
word keeps working for 30 days after the rename ships, each use warning with the
new word, and then raises name_retired with a hint.

The old words and their date are packages/cloud/src/product-names.ts's;
product-names.test.ts there holds this copy equal to it."""
from __future__ import annotations

import warnings
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from ._errors import RuntimeError

# The day the 6 October 2026 rename stops serving its old words, set when it
# ships; None until then.
RETIRES: Optional[str] = None

# Each old word and the property path of the product it became.
RENAMED: dict[str, str] = {
    "sandbox": "sandboxes",
    "snapshot": "snapshots",
    "image": "images",
    "volume": "volumes",
    "job": "jobs",
    "domain": "domains",
    "port": "ports",
    "address": "ips",
    "addresses": "ips",
    "network": "networks",
    "tunnel": "networks.wireguard",
}


def renamed(client: Any, name: str, *, retires: Optional[str] = None,
            now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> Any:
    """``client.<name>`` under an old word: the product it became, with a
    FutureWarning, or from the date a ``name_retired`` error."""
    to = RENAMED.get(name)
    if to is None:
        raise AttributeError(f"{type(client).__name__!r} object has no attribute {name!r}")
    date = retires if retires is not None else RETIRES
    if date is not None and now() >= datetime.fromisoformat(f"{date}T00:00:00+00:00"):
        raise RuntimeError(f"runtime.{name} was renamed runtime.{to} and stopped working on {date}.",
                           code="name_retired", status=410, hint=f"Use runtime.{to}.")
    by = "" if date is None else f" It stops working on {date}."
    warnings.warn(f"runtime.{name} is now runtime.{to}.{by}", FutureWarning, stacklevel=3)
    found = client
    for part in to.split("."):
        found = getattr(found, part)
    return found
