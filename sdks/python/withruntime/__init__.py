"""Runtime Cloud: one client for every product. Sandboxes first.

    from withruntime import Sandbox
    with Sandbox.create() as sbx:
        print(sbx.exec("echo hello").stdout)

``AsyncRuntime`` is the same client for asyncio, method for method.
Keep keys in the environment (RUNTIME_API_KEY), never in source code.
"""
from typing import Any, Optional

from ._async_client import (AsyncFeedback, AsyncFiles, AsyncPage, AsyncProcess, AsyncRuntime, AsyncSandbox,
                            AsyncSandboxes, AsyncSnapshots, AsyncSupport, AsyncTerminal, CommandResult)
from ._errors import (AccountBlockedError, AuthenticationError, CommandError, ConflictError, ConnectionError,
                      InvalidRequestError, NotFoundError, PermissionDeniedError, RateLimitError, RuntimeError,
                      SecretPartlyStoredError, ServiceUnavailableError)
from ._sync_client import Feedback, Files, Page, Process, Runtime, Sandboxes, Snapshots, Support, Terminal
from ._sync_client import Sandbox as _Sandbox
from ._tunnel import AsyncPortForward, PortForward
from ._version import VERSION
from .webhooks import WebhookVerificationError, verify_webhook

__version__ = VERSION
# Explicit names keep imports clear beside Python's built-in exceptions.
# The original names remain aliases for existing callers.
RuntimeAPIError = RuntimeError
RuntimeConnectionError = ConnectionError
_default: Optional[Runtime] = None


def _client() -> Runtime:
    global _default
    if _default is None:
        _default = Runtime()
    return _default


class Sandbox(_Sandbox):
    """A sandbox. ``Sandbox.create()`` reads RUNTIME_API_KEY; ``Runtime().sandboxes`` does the same explicitly."""

    @staticmethod
    def create(*, client: Optional[Runtime] = None, **fields: Any) -> _Sandbox:
        """Creates a sandbox (every field optional) and waits until it is running."""
        return (client or _client()).sandboxes.create(**fields)

    @staticmethod
    def get_or_create(name: str, *, client: Optional[Runtime] = None, **fields: Any) -> _Sandbox:
        """The sandbox named ``name`` in this account, woken if paused and
        restarted if stopped and persistent, or a new one created with
        ``fields``."""
        return (client or _client()).sandboxes.get_or_create(name, **fields)

    @staticmethod
    def connect(sandbox_id: str, *, client: Optional[Runtime] = None) -> _Sandbox:
        return (client or _client()).sandboxes.get(sandbox_id)

    @staticmethod
    def identity_token(audience: str, *, lifetime_seconds: Optional[int] = None, timeout: float = 10.0) -> str:
        """Inside a sandbox: a short-lived OIDC token, signed by Runtime, naming this
        sandbox, its organization and its image, for ``audience`` (for AWS,
        ``sts.amazonaws.com``). Needs no API key. See withruntime.com/docs/identity-tokens."""
        return _identity_token(audience, lifetime_seconds, timeout)


# The sandbox's own listener (packages/cloud/src/linux/egress.ts).
_ENVIRONMENT_URL = "http://runtime.internal/v1/environment"
_ENVIRONMENT_FILE = "/run/runtime/environment.json"


def _file_credentials():
    import json as _json
    try:
        with open(_ENVIRONMENT_FILE, "rb") as file:
            env = _json.load(file)
        return env.get("RUNTIME_ID_TOKEN_REQUEST_URL"), env.get("RUNTIME_ID_TOKEN_REQUEST_TOKEN")
    except (OSError, ValueError, AttributeError):
        return None, None


def _current_credentials(timeout: float):
    """The sandbox's request token as its host holds it now. The one in
    os.environ was current when the process started: it changes with every
    renewal of the sandbox's lease (about every 30 minutes for one that keeps
    running), and a server restored from a snapshot (an App's copies, a fork)
    holds the statement of the sandbox it was saved from."""
    import json as _json
    import urllib.request as _request
    try:
        with _request.urlopen(_ENVIRONMENT_URL, timeout=min(timeout, 5.0)) as answer:
            env = _json.load(answer)
        url, token = env.get("RUNTIME_ID_TOKEN_REQUEST_URL"), env.get("RUNTIME_ID_TOKEN_REQUEST_TOKEN")
        if isinstance(url, str) and url and isinstance(token, str) and token:
            return url, token
    except _request.HTTPError as error:  # type: ignore[attr-defined]
        error.close()
    except (OSError, ValueError, AttributeError):
        pass  # Not in a sandbox, or a host that predates the listener's environment.
    return _file_credentials()


def _identity_token(audience: str, lifetime_seconds: Optional[int], timeout: float) -> str:
    import json as _json
    import os as _os
    import urllib.parse as _parse
    import urllib.request as _request

    url = _os.environ.get("RUNTIME_ID_TOKEN_REQUEST_URL")
    token = _os.environ.get("RUNTIME_ID_TOKEN_REQUEST_TOKEN")
    if (not url or not token) and _os.path.exists(_ENVIRONMENT_FILE):
        # A process started without them (a server started before the guest
        # wrote its environment, a sandbox whose guest software predates the
        # variables) asks the host, which answers every running sandbox
        # whatever its image or age, then the guest's file. Only inside a
        # sandbox: elsewhere nothing is asked over the network.
        url, token = _current_credentials(timeout)
    if not url or not token:
        raise RuntimeError("Identity tokens are issued only inside a Runtime sandbox (RUNTIME_ID_TOKEN_REQUEST_TOKEN is not set).",
                           code="identity_unavailable")
    query = {"audience": audience}
    if lifetime_seconds is not None:
        query["lifetimeSeconds"] = str(lifetime_seconds)

    def ask(url, token):
        request = _request.Request(f"{url}?{_parse.urlencode(query)}", headers={"Authorization": f"Bearer {token}"})
        with _request.urlopen(request, timeout=timeout) as answer:
            return _json.load(answer)["token"]

    try:
        try:
            return ask(url, token)
        except _request.HTTPError as error:  # type: ignore[attr-defined]
            # Refused for a request token that is no longer this sandbox's
            # current one: ask once more with the one its host holds now.
            if error.code not in (401, 403):
                raise
            current_url, current_token = _current_credentials(timeout)
            if not current_url or not current_token or current_token == token:
                raise
            error.close()
            return ask(current_url, current_token)
    except _request.HTTPError as error:  # type: ignore[attr-defined]
        try:
            message = _json.load(error).get("error", {}).get("message", str(error))
        except ValueError:
            message = str(error)
        finally:
            error.close()
        raise RuntimeError(f"Could not get an identity token: {message}", code="identity_refused",
                           status=error.code) from None


__all__ = [
    "Runtime", "AsyncRuntime", "Sandbox", "AsyncSandbox", "Sandboxes", "AsyncSandboxes", "Files", "AsyncFiles",
    "Process", "AsyncProcess", "Terminal", "AsyncTerminal", "Page", "AsyncPage", "Feedback", "AsyncFeedback",
    "Support", "AsyncSupport", "Snapshots", "AsyncSnapshots", "CommandResult", "RuntimeError", "AuthenticationError", "PermissionDeniedError",
    "NotFoundError", "ConflictError", "InvalidRequestError", "RateLimitError", "ServiceUnavailableError", "AccountBlockedError", "SecretPartlyStoredError",
    "ConnectionError", "RuntimeAPIError", "RuntimeConnectionError", "CommandError", "verify_webhook", "WebhookVerificationError", "PortForward", "AsyncPortForward", "VERSION", "__version__",
]
