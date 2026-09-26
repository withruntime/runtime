from __future__ import annotations

from typing import Any


class AsyncAudit:
    """``runtime.audit``. The account's audit log, newest first: members and
    roles, keys, connections, credit, network rules, secrets and deletions,
    each with who, when, the client address and the request id. Needs a key
    for every product or a read-only key, made by an owner or admin."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def list(
        self, *, action: str | None = None, limit: int | None = None, before: str | None = None
    ) -> dict[str, Any]:
        """One page: ``{"events": [...], "next": "..." or None}``. ``action`` is
        an action (``"key.created"``) or a group ending in a dot (``"member."``);
        pass the previous page's ``next`` as ``before`` for older entries."""
        query = {
            key: value
            for key, value in (("action", action), ("limit", limit), ("before", before))
            if value is not None
        }
        return await self._t.json("GET", "/v1/audit", query=query)
