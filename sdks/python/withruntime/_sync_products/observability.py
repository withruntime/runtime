"""GENERATED from _async_products/observability.py by scripts/generate_sync.py. Do not edit."""
# Observability: a sandbox's CPU and memory over time, the account's lifecycle
# events, webhooks, and OpenTelemetry export.
#
#     m = sbx.metrics(range="1h")
#     hook = runtime.webhooks.create(url="https://example.com/hooks/runtime")
#     event = verify_webhook(body, headers["runtime-signature"], secret)
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


class Metrics:
    """``sbx.metrics(range="1h")``: the sandbox's measured CPU (percent of
    its vCPUs, and cores) and resident memory over ``range`` (15m, 1h, 6h, 24h,
    7d or 30d), and ``latest``, its newest reading."""

    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def __call__(self, range: Optional[str] = None) -> dict[str, Any]:
        return self._t.json("GET", f"/v1/sandboxes/{quote(self._sandbox.id, safe='')}/metrics",
                                  query=_drop_none({"range": range}))


class Events:
    """``runtime.events.list()``: lifecycle events of sandboxes, snapshots and
    volumes, newest first, kept 14 days."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def list(self, *, resource_id: Optional[str] = None, type: Optional[str] = None,
                   cursor: Optional[str] = None, limit: Optional[int] = None) -> dict[str, Any]:
        return self._t.json("GET", "/v1/events", query=_drop_none(
            {"resourceId": resource_id, "type": type, "cursor": cursor, "limit": limit}))


class Webhooks:
    """``runtime.webhooks``: signed lifecycle events POSTed to your URL. Verify
    each delivery with ``withruntime.verify_webhook``."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def _one(self, webhook_id: str, verb: str = "") -> str:
        return f"/v1/webhooks/{quote(webhook_id, safe='')}{verb}"

    def create(self, *, url: str, events: Optional[list[str]] = None,
                     description: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """The webhook with ``secret``, shown this once: keep it."""
        return self._t.json("POST", "/v1/webhooks", body=_drop_none(
            {"url": url, "events": events, "description": description}), idempotency_key=idempotency_key)

    def list(self) -> dict[str, Any]:
        return self._t.json("GET", "/v1/webhooks")

    def get(self, webhook_id: str) -> dict[str, Any]:
        return self._t.json("GET", self._one(webhook_id))

    def update(self, webhook_id: str, *, url: Optional[str] = None, events: Optional[list[str]] = None,
                     description: Optional[str] = None, enabled: Optional[bool] = None) -> dict[str, Any]:
        return self._t.json("POST", self._one(webhook_id, ":update"), body=_drop_none(
            {"url": url, "events": events, "description": description, "enabled": enabled}))

    def rotate_secret(self, webhook_id: str, *, keep_previous_seconds: Optional[int] = None) -> dict[str, Any]:
        """A new secret, returned once. The old one keeps signing beside it for
        ``keep_previous_seconds`` (a day by default, a week at most; 0 ends it now)."""
        return self._t.json("POST", self._one(webhook_id, ":rotate-secret"),
                                  body=_drop_none({"keepPreviousSeconds": keep_previous_seconds}))

    def delete(self, webhook_id: str) -> dict[str, Any]:
        return self._t.json("POST", self._one(webhook_id, ":delete"))

    def test(self, webhook_id: str) -> dict[str, Any]:
        """Sends a signed ``webhook.test`` now and answers how your endpoint replied."""
        return self._t.json("POST", self._one(webhook_id, ":test"), wait=10)

    def deliveries(self, webhook_id: str, *, state: Optional[str] = None, cursor: Optional[str] = None,
                         limit: Optional[int] = None) -> dict[str, Any]:
        return self._t.json("GET", self._one(webhook_id, "/deliveries"),
                                  query=_drop_none({"state": state, "cursor": cursor, "limit": limit}))

    def retry(self, delivery_id: str) -> dict[str, Any]:
        """Sends one delivery again, once, now."""
        return self._t.json("POST", f"/v1/webhook-deliveries/{quote(delivery_id, safe='')}:retry")


class Otel:
    """``runtime.otel``: push events (as logs) and CPU and memory (as metrics)
    to an OpenTelemetry endpoint over OTLP/HTTP."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def _one(self, export_id: str, verb: str = "") -> str:
        return f"/v1/otel-exports/{quote(export_id, safe='')}{verb}"

    def create(self, *, endpoint: str, headers: Optional[dict[str, str]] = None,
                     signals: Optional[list[str]] = None, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """``endpoint`` is the OTLP/HTTP base URL, as OTEL_EXPORTER_OTLP_ENDPOINT.
        ``headers`` authenticate to it and are never shown back."""
        return self._t.json("POST", "/v1/otel-exports", body=_drop_none(
            {"endpoint": endpoint, "headers": headers, "signals": signals}), idempotency_key=idempotency_key)

    def list(self) -> dict[str, Any]:
        return self._t.json("GET", "/v1/otel-exports")

    def get(self, export_id: str) -> dict[str, Any]:
        return self._t.json("GET", self._one(export_id))

    def update(self, export_id: str, *, endpoint: Optional[str] = None,
                     headers: Optional[dict[str, str]] = None, signals: Optional[list[str]] = None,
                     enabled: Optional[bool] = None) -> dict[str, Any]:
        return self._t.json("POST", self._one(export_id, ":update"), body=_drop_none(
            {"endpoint": endpoint, "headers": headers, "signals": signals, "enabled": enabled}))

    def flush(self, export_id: str) -> dict[str, Any]:
        """Push now instead of at the next interval."""
        return self._t.json("POST", self._one(export_id, ":flush"))

    def delete(self, export_id: str) -> dict[str, Any]:
        return self._t.json("POST", self._one(export_id, ":delete"))
