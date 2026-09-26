"""GENERATED from _async_products/sso.py by scripts/generate_sync.py. Do not edit."""
from __future__ import annotations

from typing import Any


class Sso:
    """``runtime.sso``: the account's single sign-on and SCIM directory sync,
    read only (an owner changes it on the website). Needs a key made by an
    owner or admin. The JavaScript SDK's ``runtime.sso``."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def get(self) -> dict[str, Any]:
        """``connections`` (each identity provider: ``protocol``, ``provider``,
        ``domain``, ``domainVerifiedAt``, the ``verification`` TXT record,
        ``defaultRole``, ``requireSso``), ``scim`` (``tokens``, ``users``,
        ``activeUsers``, ``groups`` with the role each gives) and ``manage``,
        where an owner changes it."""
        return self._t.json("GET", "/v1/sso")
