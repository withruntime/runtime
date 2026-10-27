"""The W3C trace context of the caller's active OpenTelemetry span, sent with
every call when the program uses OpenTelemetry for Python: Runtime's span of
the call (an export with "traces") is then a child of the caller's, in the
caller's own trace. The SDK does not depend on OpenTelemetry; without it, or
when it fails, nothing is sent and no call fails for it."""
from __future__ import annotations

from typing import Any, Optional

_propagate: Optional[Any] = None
_missing = False


def trace_headers() -> dict[str, str]:
    global _propagate, _missing
    if _missing:
        return {}
    if _propagate is None:
        try:
            from opentelemetry import propagate
        except Exception:
            # Looked for once: a program without OpenTelemetry pays nothing after.
            _missing = True
            return {}
        _propagate = propagate
    carrier: dict[str, str] = {}
    try:
        _propagate.inject(carrier)
    except Exception:
        return {}
    return {name: value for name, value in carrier.items()
            if name in ("traceparent", "tracestate") and isinstance(value, str) and len(value) <= 512}
