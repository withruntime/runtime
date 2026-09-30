"""GENERATED from _async_products/previews.py by scripts/generate_sync.py. Do not edit."""
# ``sbx.previews``: share ports of a sandbox at public HTTPS addresses.
#
#     preview = sbx.previews.create(3000)
#     # send preview["token"] as the x-runtime-preview-token header,
#     # or open preview["urlWithToken"] in a browser.
#
# WebSockets work. The server must listen on 0.0.0.0 or localhost.
from __future__ import annotations

from typing import Any, Optional


class Previews:
    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def _base(self) -> str:
        return f"/v1/sandboxes/{self._sandbox.id}/previews"

    def create(self, port: int, *, visibility: Optional[str] = None,
                     ttl_seconds: Optional[int] = None,
                     embed_origins: Optional[list[str]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Shares ``port``, or changes its visibility and embed origins if it is shared
        already. ``visibility`` is "private" (default: a token is needed) or "public".
        ``embed_origins`` names the sites that may show it in an iframe
        (``["https://app.example.com", "https://*.example.com"]``, up to 16); any other
        site's iframe is refused. Omitted, a shared port keeps its list; ``[]`` is any
        site, the default."""
        body: dict[str, Any] = {"port": port}
        if visibility is not None:
            body["visibility"] = visibility
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        if embed_origins is not None:
            body["embedOrigins"] = list(embed_origins)
        return self._t.json("POST", self._base(), body=body, idempotency_key=idempotency_key)

    def list(self) -> list[dict[str, Any]]:
        """Every shared port, each private one with a fresh token."""
        return (self._t.json("GET", self._base()))["data"]

    def get(self, port: int, *, ttl_seconds: Optional[int] = None) -> dict[str, Any]:
        query = {"ttlSeconds": ttl_seconds} if ttl_seconds is not None else None
        return self._t.json("GET", f"{self._base()}/{int(port)}", query=query)

    def rotate(self, port: int) -> dict[str, Any]:
        """Refuses every token issued for this port so far and returns a new one."""
        return self._t.json("POST", f"{self._base()}/{int(port)}:rotate", body={})

    def delete(self, port: int) -> dict[str, Any]:
        """Stops sharing ``port``. Its open connections are closed before this returns."""
        return self._t.json("DELETE", f"{self._base()}/{int(port)}")
