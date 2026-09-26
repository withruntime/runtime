"""GENERATED from _async_products/secrets.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.secrets``: secrets your sandboxes use without seeing them.
#
#     runtime.secrets.set("OPENAI_API_KEY", value=key, hosts=["api.openai.com"])
#
# Every sandbox of your organization then has ``OPENAI_API_KEY`` set to a
# placeholder. The egress proxy swaps in the value on HTTPS requests to the
# hosts (in the URL and headers), or, with ``header``, sets that header on every
# request to them. The value is sealed and never returned by anything.
from __future__ import annotations

from typing import Any, Optional, TypedDict
from urllib.parse import quote


class _RulePaths(TypedDict):
    paths: list[str]


class SecretRule(_RulePaths, total=False):
    """Which requests to a secret's hosts carry it: ``methods`` (every method
    when absent) and ``paths``, each exact or a prefix ending in ``/*``."""
    methods: list[str]


class Secrets:
    def __init__(self, t: Any) -> None:
        self._t = t

    def set(self, name: str, *, value: str, hosts: list[str], header: Optional[str] = None,
                  format: Optional[str] = None,
                  rules: Optional[list[SecretRule]] = None) -> dict[str, Any]:
        """Store or replace a secret. ``value`` is visible ASCII and spaces, at
        most 8 KiB. ``hosts`` are names or ``*.domain``. ``header`` (with
        ``format``, ``{value}`` where the secret goes) sets that header on every
        request to the hosts. Replacing a secret keeps its placeholder.

        ``rules`` (paid accounts, 1 to 16) limit the value to the requests a
        rule allows, such as ``[{"methods": ["GET"], "paths": ["/repos/acme/*"]}]``.
        Paths are exact or end in ``/*``, written canonically: starting with
        ``/``, no ``.`` or ``..`` segments, no ``;`` or ``\\``, no encoded slash.
        Without rules, every request to the hosts; replacing a secret without
        rules clears them."""
        body: dict[str, Any] = {"value": value, "hosts": hosts}
        if header is not None:
            body["header"] = header
        if format is not None:
            body["format"] = format
        if rules is not None:
            body["rules"] = rules
        return self._t.json("PUT", f"/v1/egress-secrets/{quote(name, safe='')}", body=body)

    def list(self) -> list[dict[str, Any]]:
        """Names, hosts, headers and placeholders. Never values."""
        return (self._t.json("GET", "/v1/egress-secrets"))["secrets"]

    def delete(self, name: str) -> dict[str, Any]:
        """Delete a secret: its value is erased and its placeholder stops working."""
        return self._t.json("DELETE", f"/v1/egress-secrets/{quote(name, safe='')}")
