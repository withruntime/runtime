"""GENERATED from _async_products/apps.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.apps`` and ``runtime.functions``: a server that runs as many copies
# as its traffic needs, deployed from an image or a build. Private beta: an
# account outside it is refused with PermissionDeniedError, code
# ``product_in_beta`` (403), and retrying does not change it.
#
#     app = runtime.apps.create(name="web", max_copies=4, vcpu=1, memory_mib=1024)
#     deploy = runtime.apps.deploy(app["id"], image="web:latest", wait=True)
#     print(deploy["url"])
#
# A deploy's outcome follows its own record, not the app's state: an older live
# version keeps serving through a failed rollout of a newer one.
from __future__ import annotations

import time
import uuid
from typing import Any, Optional
from urllib.parse import quote

from .._errors import InvalidRequestError, RuntimeError

# A deploy is done once it is one of these.
DEPLOY_ENDED = ("live", "failed", "superseded")
# An app's wait ends at its target or at one of these, with the app's error.
APP_SETTLED = ("failed", "deleted", "live")
_UNSET: Any = object()
_SPECIAL = {"memory_mib": "memoryMiB"}


def _enc(value: str) -> str:
    return quote(value, safe="")


def _camel(name: str) -> str:
    if name in _SPECIAL:
        return _SPECIAL[name]
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _fields(**values: Any) -> dict[str, Any]:
    """The API's body: camelCase names, a field left as None not sent. The
    defaults belong to the API, so the SDK fills in none."""
    return {_camel(name): value for name, value in values.items() if value is not None}


def _sleep(seconds: float) -> None:
    from .._sync_client import sleep  # here, not at the top: that module imports this one
    sleep(seconds)


def _check_wait(timeout: float, poll: float) -> None:
    for field, value in (("timeout", timeout), ("poll", poll)):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value != value \
                or value < 0 or value == float("inf"):
            raise InvalidRequestError(f"{field} must be a finite, nonnegative number of seconds.",
                                      code="invalid_request", details={"field": field},
                                      hint="Fix the option and call again; nothing was sent.")


def _timed_out(key: Optional[str]) -> RuntimeError:
    return RuntimeError("Waiting reached its deadline; the resource may still change.", code="timeout",
                        hint="Read the resource to resume waiting. Retry a write with the same idempotency_key.",
                        idempotency_key=key)


def _keep_key(error: RuntimeError, waiting: "_Wait") -> RuntimeError:
    """A read failure still belongs to the write that started the wait: keep its
    key, so a caller who lost the reply can send the write again safely. A
    request cut short by the wait's deadline is the wait timing out."""
    if waiting.deadline is not None and time.monotonic() >= waiting.deadline and error.code == "request_timeout":
        return _timed_out(waiting.key)
    if waiting.key and not error.idempotency_key:
        error.idempotency_key = waiting.key
    return error


class _Wait:
    """One deadline over a write, its retries and every read after it."""

    def __init__(self, timeout: float, poll: float, key: Optional[str]) -> None:
        _check_wait(timeout, poll)
        self.poll, self.key = poll, key
        self.deadline = time.monotonic() + timeout if timeout > 0 else None

    def options(self) -> dict[str, Any]:
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise _timed_out(self.key)
        return {} if self.deadline is None else {"deadline": self.deadline}

    def pause(self) -> None:
        left = None if self.deadline is None else self.deadline - time.monotonic()
        if left is not None and left <= 0:
            raise _timed_out(self.key)
        _sleep(self.poll if left is None else min(self.poll, left))


class Apps:
    """``runtime.apps`` (private beta). Times are Unix milliseconds."""

    _base = "/v1/apps"

    def __init__(self, t: Any) -> None:
        self._t = t

    def create(self, *, max_copies: int, vcpu: int, memory_mib: int, name: Optional[str] = None,
                     labels: Optional[dict[str, str]] = None, min_copies: Optional[int] = None,
                     concurrency: Optional[int] = None, spares: Optional[int] = None,
                     port: Optional[int] = None, health_path: Optional[str] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Create one waiting for its first version. ``max_copies`` (1 to 1000)
        bounds the awake copies, each ``vcpu`` (1 to 16) and ``memory_mib`` (128
        to 65536). ``min_copies`` (Apps only) keeps that many awake, at most
        ``max_copies``; ``concurrency`` (default 100) is the requests one copy
        takes at once, ``spares`` (default 2) the warm copies kept beside them.
        The server answers on ``port`` (default 8080); ``health_path`` (such as
        ``/healthz``) must answer 200, else the port accepting connections is
        enough."""
        body = _fields(name=name, labels=labels, max_copies=max_copies, vcpu=vcpu, memory_mib=memory_mib,
                       min_copies=self._min_copies(min_copies), concurrency=concurrency, spares=spares,
                       port=port, health_path=health_path)
        return self._t.json("POST", self._base, body=body, idempotency_key=idempotency_key)

    def _min_copies(self, value: Optional[int]) -> Optional[int]:
        return value

    def get(self, app_id: str, *, wait_for: Optional[str] = None,
                  timeout_seconds: Optional[int] = None) -> dict[str, Any]:
        """One by id. ``wait_for`` (a state) holds the answer on the server up
        to ``timeout_seconds`` (1 to 60, default 30); check the state returned."""
        return self._t.json("GET", f"{self._base}/{_enc(app_id)}",
                                  query={"waitFor": wait_for, "timeoutSeconds": timeout_seconds})

    def list(self, *, name: Optional[str] = None, label: Optional[list[str]] = None,
                   state: Optional[list[str]] = None, limit: Optional[int] = None) -> Page:
        """Yours, filtered by ``name``, ``label`` (``key:value``, all must match)
        and ``state`` (waiting, live and failed by default); ``limit`` 1 to 100
        a page. ``for`` walks every page."""
        from .._sync_client import Page
        query = {"name": name, "label": label, "state": state, "limit": limit}

        def fetch(cursor: Optional[str]) -> Page:
            body = self._t.json("GET", self._base, query={**query, "cursor": cursor})
            return Page(body["data"], body.get("nextCursor"), fetch)
        return fetch(None)

    def update(self, app_id: str, *, name: Optional[str] = _UNSET, labels: Optional[dict[str, str]] = None,
                     min_copies: Optional[int] = None, max_copies: Optional[int] = None,
                     concurrency: Optional[int] = None, spares: Optional[int] = None, vcpu: Optional[int] = None,
                     memory_mib: Optional[int] = None, port: Optional[int] = None,
                     health_path: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Change its settings in place; a field left out stays. ``name=None``
        clears the name. The live version keeps serving."""
        body = _fields(labels=labels, min_copies=self._min_copies(min_copies), max_copies=max_copies,
                       concurrency=concurrency, spares=spares, vcpu=vcpu, memory_mib=memory_mib, port=port,
                       health_path=health_path)
        if name is not _UNSET:
            body["name"] = name
        return self._t.json("POST", f"{self._base}/{_enc(app_id)}:update", body=body,
                                  idempotency_key=idempotency_key)

    def delete(self, app_id: str, *, wait: bool = False, timeout: float = 300, poll: float = 0.25,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Delete it. With ``wait``, return once it is deleted, within
        ``timeout`` seconds (0: no deadline); a timed-out delete can be sent
        again with the same ``idempotency_key``."""
        path = f"{self._base}/{_enc(app_id)}"
        if not wait:
            return self._t.json("DELETE", path, idempotency_key=idempotency_key)
        waiting = _Wait(timeout, poll, idempotency_key or str(uuid.uuid4()))
        record = self._t.json("DELETE", path, idempotency_key=waiting.key, **waiting.options())
        return self._follow(app_id, "deleted", waiting, record)

    def wait(self, app_id: str, target: str, *, timeout: float = 300,
                   poll: float = 0.25) -> dict[str, Any]:
        """Follow it to ``target``, ``live`` or ``deleted``, within ``timeout``
        seconds. This follows the app's state, not a deploy: use
        ``wait_deploy`` for one rollout."""
        return self._follow(app_id, target, _Wait(timeout, poll, None))

    def _follow(self, app_id: str, target: str, waiting: _Wait,
                      record: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        path = f"{self._base}/{_enc(app_id)}"
        try:
            if record is None:
                record = self._t.json("GET", path, **waiting.options())
            while True:
                if record["state"] == target:
                    return record
                if record["state"] in APP_SETTLED:
                    error = record.get("error") or {}
                    raise RuntimeError(
                        error.get("message") or f"Expected {target}, but {app_id} reached {record['state']}.",
                        code=error.get("code") or "unexpected_state",
                        hint="Read the resource and inspect its error before starting another change.",
                        details={"id": app_id, "state": record["state"], "target": target, "resource": record},
                        idempotency_key=waiting.key)
                waiting.pause()
                record = self._t.json("GET", path, **waiting.options())
        except RuntimeError as error:
            raise _keep_key(error, waiting)

    def deploy(self, app_id: str, *, image: Optional[str] = None, build: Optional[str] = None,
                     env: Optional[dict[str, str]] = None, keep_env: Optional[bool] = None,
                     port: Optional[int] = None, health_path: Optional[str] = None, wait: bool = False,
                     timeout: float = 300, poll: float = 0.25,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Deploy a new version beside the live one, from ``image`` (an image of
        this account, ready: id, name, ``name:tag`` or ``name@version``) or
        ``build`` (a succeeded build's id). ``env`` sets its environment, sealed.
        ``keep_env=True`` carries the last deploy's environment, with ``env``'s
        names set over it (that needs a key that may reveal the App's secrets;
        otherwise ``keep_env_refused``, 409). Returns the deploy: id, version,
        state and URL. A failure leaves the old version serving and says why
        (``error`` with code, hint and lastOutput). ``wait=True`` returns once it
        is live, failed or superseded, within ``timeout`` seconds."""
        if (image is None) == (build is None):
            raise InvalidRequestError("Give image= or build=, one of them.", code="invalid_request",
                                      details={"field": "image"},
                                      hint="Nothing was sent. Name the image or the build to deploy.")
        body = _fields(image=image, build=build, env=env, keep_env=keep_env, port=port, health_path=health_path)
        return self._write_deploy(app_id, "deploys", body, wait, timeout, poll, idempotency_key)

    def rollback(self, app_id: str, *, wait: bool = False, timeout: float = 300, poll: float = 0.25,
                       idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Return to the previous version without a build: within a second for
        15 minutes after a deploy went live, later from its saved copy. Returns
        a deploy to follow; ``rollback_unavailable`` means there is no previous
        version."""
        return self._write_deploy(app_id, "rollback", {}, wait, timeout, poll, idempotency_key)

    def get_deploy(self, app_id: str, deploy_id: str, *, wait_for: Optional[str] = None,
                         timeout_seconds: Optional[int] = None) -> dict[str, Any]:
        """One deploy. ``wait_for`` (such as ``live``) holds the answer up to
        ``timeout_seconds`` (1 to 60); live, failed or superseded also end it."""
        return self._get_deploy(app_id, deploy_id, wait_for, timeout_seconds, {})

    def wait_deploy(self, app_id: str, deploy_id: str, *, timeout: float = 300,
                          poll: float = 0.25) -> dict[str, Any]:
        """Follow a deploy by id until it is live, failed or superseded: resume
        after a restart without making another version."""
        waiting = _Wait(timeout, poll, None)
        record = self._get_deploy(app_id, deploy_id, None, None, waiting.options())
        return self._follow_deploy(app_id, record, waiting)

    def versions(self, app_id: str) -> list[dict[str, Any]]:
        """Its versions, live and previous marked; only those two keep saved copies."""
        return self._t.json("GET", f"{self._base}/{_enc(app_id)}/versions")

    def copies(self, app_id: str) -> list[dict[str, Any]]:
        """Its copies: version, region, state and when that state began."""
        return self._t.json("GET", f"{self._base}/{_enc(app_id)}/copies")

    def _get_deploy(self, app_id: str, deploy_id: str, wait_for: Optional[str],
                          timeout_seconds: Optional[int], options: dict[str, Any]) -> dict[str, Any]:
        return self._t.json("GET", f"{self._base}/{_enc(app_id)}/deploys/{_enc(deploy_id)}",
                                  query={"waitFor": wait_for, "timeoutSeconds": timeout_seconds}, **options)

    def _follow_deploy(self, app_id: str, record: dict[str, Any], waiting: _Wait) -> dict[str, Any]:
        try:
            while record["state"] not in DEPLOY_ENDED:
                record = self._get_deploy(app_id, record["id"], "live", 60, waiting.options())
                if record["state"] not in DEPLOY_ENDED:
                    waiting.pause()
            return record
        except RuntimeError as error:
            raise _keep_key(error, waiting)

    def _write_deploy(self, app_id: str, verb: str, body: dict[str, Any], wait: bool, timeout: float,
                            poll: float, idempotency_key: Optional[str]) -> dict[str, Any]:
        path = f"{self._base}/{_enc(app_id)}/{verb}"
        if not wait:
            return self._t.json("POST", path, body=body, idempotency_key=idempotency_key)
        waiting = _Wait(timeout, poll, idempotency_key or str(uuid.uuid4()))
        record = self._t.json("POST", path, body=body, idempotency_key=waiting.key, **waiting.options())
        return self._follow_deploy(app_id, record, waiting)


class Functions(Apps):
    """``runtime.functions`` (private beta): an App whose copies all sleep when
    no request comes, so it takes no ``min_copies``."""

    _base = "/v1/functions"

    def _min_copies(self, value: Optional[int]) -> Optional[int]:
        if value is not None:
            raise InvalidRequestError("A Function keeps no copies awake: leave min_copies out.",
                                      code="invalid_request", details={"field": "minCopies"},
                                      hint="Nothing was sent. Use runtime.apps for copies kept awake.")
        return None
