"""Every failure the SDK raises. ``code`` is stable, ``hint`` says what to do
next, ``request_id`` is what to quote in a report (``runtime.feedback.submit``)."""
from __future__ import annotations

from typing import Any, Optional


# A product switched off on this deployment, or paused on purpose: the API
# answers these 503s in fixed words (serverFault "off" in
# packages/cloud/src/api/respond.ts) and retrying cannot change them.
# host_unavailable and busy pass, and are retried.
DELIBERATE = frozenset({"unavailable", "unsupported", "fork_unavailable", "previews_unavailable",
                        "network_unavailable", "network_rules_unavailable", "secrets_unavailable",
                        "identity_unavailable", "env_unavailable"})
# Refusals that pass on their own: a host frees room, a trial slot frees.
_PASSING = frozenset({"no_capacity", "trial_busy"})
# Refusals of a create that clear when a sandbox stops or pauses, or a host
# frees room: the trial's slots, an email domain's trial slots, the account's
# quota and the region's capacity. sandboxes.create waits them out, retrying
# with the same key and input, for up to wait_for_capacity seconds.
WAITS_FOR_ROOM = frozenset({"trial_busy", "trial_domain_limit", "trial_capacity", "quota_exceeded", "no_capacity",
                            "volume_releasing"})


class RuntimeError(Exception):  # noqa: A001 - the SDK's own base error, as in 0.1.0
    def __init__(self, message: str, *, code: str = "request_failed", status: int = 0,
                 request_id: Optional[str] = None, hint: Optional[str] = None,
                 details: Optional[dict[str, Any]] = None, idempotency_key: Optional[str] = None,
                 retry_after_ms: Optional[int] = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.request_id = request_id
        self.hint = hint
        self.details = details
        self.idempotency_key = idempotency_key
        self.retry_after_ms = retry_after_ms

    @property
    def retryable(self) -> bool:
        """Retrying this exact call is safe and may work. True for no_capacity
        and trial_busy as well, which clear by themselves when a host frees room
        or a trial sandbox stops. sandboxes.create already waits for those (see
        wait_for_capacity), so seeing one from a create means the wait ran out
        or was switched off."""
        if self.code in DELIBERATE:
            return False
        if self.code in _PASSING:
            # A fork asking for more copies than the trial runs at once never fits.
            return (self.details or {}).get("field") != "count"
        return self.status in (0, 429, 502, 503, 504)

    def __str__(self) -> str:
        parts = [f"[{self.code}{' ' + str(self.status) if self.status else ''}] {self.message}"]
        if self.hint:
            parts.append(f"Hint: {self.hint}")
        if self.request_id:
            parts.append(f"Request: {self.request_id}")
        return "\n".join(parts)


class AuthenticationError(RuntimeError): ...
class PermissionDeniedError(RuntimeError): ...
class NotFoundError(RuntimeError): ...
class ConflictError(RuntimeError): ...
class InvalidRequestError(RuntimeError): ...
class RateLimitError(RuntimeError): ...
class ServiceUnavailableError(RuntimeError): ...


class SecretPartlyStoredError(RuntimeError):
    """A secret write that reached one copy and not the other:
    ``details["stored"]`` names what took effect. The same call again is safe."""


class AccountBlockedError(RuntimeError):
    """The account may not spend: a payment on it is disputed or under review
    (``account_blocked``, 402). The message says which and what clears it."""


class ConnectionError(RuntimeError):  # noqa: A001
    """No answer arrived. Retrying with the same idempotency key is safe."""


class CommandError(RuntimeError):
    """Raised by exec(check=True) when a command exits non-zero or times out."""

    def __init__(self, result: dict[str, Any]) -> None:
        timed_out = bool(result.get("timedOut"))
        stderr = str(result.get("stderr") or "")
        super().__init__(
            "Command timed out." if timed_out else f"Command exited with {result.get('exitCode')}. {stderr.strip()[-500:]}".strip(),
            code="command_timeout" if timed_out else "command_failed")
        self.exit_code = result.get("exitCode")
        self.stdout = str(result.get("stdout") or "")
        self.stderr = stderr


def error_for(status: int, body: Any, key: Optional[str]) -> RuntimeError:
    error = body.get("error") if isinstance(body, dict) else None
    error = error if isinstance(error, dict) else {}
    kwargs = dict(
        code=str(error.get("code", "request_failed")), status=status,
        request_id=error.get("requestId"), hint=error.get("hint"),
        details=error.get("details") if isinstance(error.get("details"), dict) else None,
        idempotency_key=key,
        retry_after_ms=error.get("retryAfterMs") if isinstance(error.get("retryAfterMs"), int) else None)
    message = str(error.get("message", f"Runtime request failed ({status})."))
    cls: type[RuntimeError] = RuntimeError
    if kwargs["code"] == "account_blocked":
        cls = AccountBlockedError
    elif status == 401:
        cls = AuthenticationError
    elif status == 403:
        cls = PermissionDeniedError
    elif status == 404:
        cls = NotFoundError
    elif status == 409:
        cls = ConflictError
    elif status in (400, 413, 422):
        cls = InvalidRequestError
    elif status == 429:
        cls = RateLimitError
    elif status >= 500:
        cls = ServiceUnavailableError
    return cls(message, **kwargs)
