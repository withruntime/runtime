"""Verifying Runtime's webhook deliveries.

    from withruntime import verify_webhook

    @app.post("/hooks/runtime")
    def hook(request):
        event = verify_webhook(request.body, request.headers.get("runtime-signature"), SECRET)
        if event["type"] == "sandbox.stopped":
            ...
        return 204

Each delivery carries ``Runtime-Signature: t=<unix seconds>,v1=<hex>``, the
hex HMAC-SHA256 of ``f"{t}.{body}"`` keyed with the webhook's secret; during a
rotation there is one ``v1`` per live secret. Pass the body exactly as
received, before any JSON parsing.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Optional, Sequence, Union


class WebhookVerificationError(Exception):
    """The delivery is not signed by the secret, or is older than the tolerance."""


def verify_webhook(body: Union[str, bytes], header: Optional[str], secret: Union[str, Sequence[str]], *,
                   tolerance_seconds: int = 300, now: Optional[int] = None) -> dict[str, Any]:
    """Returns the event when ``header`` is a valid signature of ``body`` by
    ``secret`` (or any of several secrets) made within ``tolerance_seconds``,
    which stops a captured delivery being replayed later. Raises
    ``WebhookVerificationError`` otherwise."""
    text = body.decode() if isinstance(body, (bytes, bytearray)) else body
    if not header:
        raise WebhookVerificationError("Missing Runtime-Signature header.")
    parts = [part.strip().split("=", 1) for part in header.split(",")]
    stamp = next((value for key, value in (p for p in parts if len(p) == 2) if key == "t"), None)
    given = [value for key, value in (p for p in parts if len(p) == 2) if key == "v1" and value]
    if stamp is None or not stamp.isdigit() or not given:
        raise WebhookVerificationError("Malformed Runtime-Signature header.")
    moment = int(time.time()) if now is None else now
    if abs(moment - int(stamp)) > tolerance_seconds:
        raise WebhookVerificationError("The signature is too old; the delivery may be a replay.")
    secrets = [secret] if isinstance(secret, str) else list(secret)
    signed = f"{stamp}.{text}".encode()
    for key in secrets:
        expected = hmac.new(key.encode(), signed, hashlib.sha256).hexdigest()
        if any(hmac.compare_digest(value, expected) for value in given):
            try:
                return json.loads(text)
            except ValueError as error:
                raise WebhookVerificationError("The body is not JSON.") from error
    raise WebhookVerificationError("No signature matches the secret.")
