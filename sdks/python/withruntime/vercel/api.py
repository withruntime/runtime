"""Vercel's ``vercel.api.session``: on Runtime there is no session to set up,
so it only checks that no Vercel token is given."""
from __future__ import annotations

from typing import Any, Optional

from ._core import pick_key


class session:  # noqa: N801 - Vercel's own name
    """``async with session():`` or ``with session():``. A token must be a
    Runtime key; project and team options are accepted and have no meaning
    on Runtime, which has neither."""

    def __init__(self, *, token: Optional[str] = None, **_: Any) -> None:
        if token is not None:
            pick_key(token)

    def __enter__(self) -> "session":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    async def __aenter__(self) -> "session":
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None


__all__ = ["session"]
