"""GENERATED from _async_products/apps.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.apps`` and ``runtime.functions``: a server that runs as many copies
# as its traffic needs, deployed from an image or a build. Private beta: an
# account outside it is refused with PermissionDeniedError, code
# ``product_in_beta`` (403), and retrying does not change it.
#
#     app = runtime.apps.create(name="web", max_copies=4, vcpu=1, memory_mib=1024)
#     deploy = runtime.apps.deploy(app["id"], image="web:latest", wait=True)
#     print(deploy["url"])
#     for event in runtime.apps.logs(app["id"], follow=True, since="15m"):
#         print(event.get("text", event))
#
# An App with a volume keeps one copy on it: each deploy, rollback and restart
# stops the old copy before the new one boots, and its record says the downtime.
#
#     db = runtime.apps.create(name="db", max_copies=1, vcpu=1, memory_mib=1024,
#                                    volume={"volume_id": volume_id, "path": "/data"})
#
# A deploy's outcome follows its own record, not the app's state: an older live
# version keeps serving through a failed rollout of a newer one.
from __future__ import annotations

import time
import uuid
from typing import Any, Iterator, Optional
from urllib.parse import quote

from .._errors import ConnectionError, InvalidRequestError, RuntimeError

# A deploy is done once it is one of these.
DEPLOY_ENDED = ("live", "failed", "superseded")
# An app's wait ends at its target or at one of these, with the app's error.
APP_SETTLED = ("failed", "deleted", "live")
# Where a log line was printed.
LOG_STREAMS = ("stdout", "stderr")
_UNSET: Any = object()
_SPECIAL = {"memory_mib": "memoryMiB"}


def _enc(value: str) -> str:
    return quote(value, safe="")


def _cursor(value: Any) -> bool:
    """An opaque log cursor as the API gives it: short text, no control characters."""
    return isinstance(value, str) and 0 < len(value) <= 4096 and \
        not any(ord(c) < 0x20 or ord(c) == 0x7F for c in value)


def _failure(code: str, hint: str, cursor: Optional[str]) -> RuntimeError:
    return RuntimeError(hint, code=code, hint=hint, details={"cursor": cursor})


def _log_invalid(cursor: Optional[str], hint: str = "Retry the log from the last received cursor.") -> RuntimeError:
    return _failure("app_log_invalid", hint, cursor)


def _log_line(event: dict[str, Any]) -> bool:
    stamp, copy, version = event.get("at"), event.get("copy"), event.get("version")
    return (_cursor(event.get("cursor")) and isinstance(event.get("text"), str)
            and event.get("stream") in LOG_STREAMS
            and isinstance(stamp, int) and not isinstance(stamp, bool) and stamp >= 0
            and (copy is None or isinstance(copy, str))
            and (version is None or (isinstance(version, int) and not isinstance(version, bool))))


def _camel(name: str) -> str:
    if name in _SPECIAL:
        return _SPECIAL[name]
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _fields(**values: Any) -> dict[str, Any]:
    """The API's body: camelCase names, a field left as None not sent. The
    defaults belong to the API, so the SDK fills in none."""
    return {_camel(name): value for name, value in values.items() if value is not None}


def _volume(value: Any) -> Any:
    """``{"volume_id": ..., "path": ...}`` as the API names it; None stays None."""
    return value if value is None or value is _UNSET else {_camel(k): v for k, v in value.items()}


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
                     release_watch: Optional[str] = None, sleep_after_ms: Optional[int] = None,
                     cdn: Optional[bool] = None,
                     health_fail_seconds: Optional[int] = None, volume: Optional[dict[str, str]] = None,
                     stop_grace_seconds: Optional[int] = None,
                     release_stages: Optional[str] = None, release_soak_seconds: Optional[int] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Create one waiting for its first version. ``max_copies`` (1 to the account's App copies at once, its plan's sandboxes at once)
        bounds the awake copies, each ``vcpu`` (1 to 16) and ``memory_mib`` (128
        to 65536). ``min_copies`` (Apps only) keeps that many awake, at most
        ``max_copies``; ``concurrency`` (default 100) is the requests one copy
        takes at once, ``spares`` (default 2) the warm copies kept beside them.
        The server answers on ``port`` (default 8080); ``health_path`` (such as
        ``/healthz``) must answer 200, else the port accepting connections is
        enough; a live copy failing it ``health_fail_seconds`` (10 to 3600,
        default 60) is replaced. ``release_watch`` says what happens when a new
        version's errors or speed get clearly worse in its first 15 minutes:
        ``alert`` (the default) tells the owners, ``rollback`` also goes back
        to the previous version, ``off`` does neither. ``sleep_after_ms``
        (Functions only; 250 to 5000, default 1000) is at most how long a copy
        stays awake after its last request ends; awake time with no request in
        flight is not billed. ``cdn`` (default true) puts Cloudflare's CDN in
        front of its addresses; ``False`` sends visitors straight to Runtime's
        routers, with nothing cached.

        Apps only: ``volume`` (``{"volume_id": ..., "path": "/data"}``, a path
        under /data, /mnt, /state, /storage or /volumes) mounts one volume of
        this account in the App's one copy; it needs ``max_copies=1``, and then
        ``min_copies`` defaults to 1 and ``spares`` to 0. Each deploy, rollback
        and restart stops the old copy before the new one boots, giving it
        ``stop_grace_seconds`` (0 to 900, default 30) after SIGTERM. A bad volume
        is ``volume_invalid`` (400).

        Apps only: ``release_stages`` says how a new version goes live:
        ``"at_once"`` (the default) switches every copy together; ``"staged"``
        starts one copy of it beside the live version's, then about 10%, 50%
        and all of them, each stage running ``release_soak_seconds`` (60 to
        3600, default 300) once its copies serve and judged on its visitors'
        errors and speed before the next. A stage that does worse goes back:
        its copies finish their requests and stop, then the deploy fails with
        ``deploy_stage_failed``, and the live version never stops serving.
        ``app["stagedRelease"]`` follows it."""
        self._stateful(_UNSET if volume is None else volume, stop_grace_seconds)
        self._releases(release_stages, release_soak_seconds)
        body = _fields(name=name, labels=labels, max_copies=max_copies, vcpu=vcpu, memory_mib=memory_mib,
                       min_copies=self._min_copies(min_copies), concurrency=concurrency, spares=spares,
                       port=port, health_path=health_path, release_watch=release_watch,
                       sleep_after_ms=sleep_after_ms, cdn=cdn, health_fail_seconds=health_fail_seconds,
                       volume=_volume(volume), stop_grace_seconds=stop_grace_seconds,
                       release_stages=release_stages, release_soak_seconds=release_soak_seconds)
        return self._t.json("POST", self._base, body=body, idempotency_key=idempotency_key)

    def _min_copies(self, value: Optional[int]) -> Optional[int]:
        return value

    def _stateful(self, volume: Any, stop_grace_seconds: Optional[int]) -> None:
        pass

    def _releases(self, release_stages: Optional[str], release_soak_seconds: Optional[int]) -> None:
        pass

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
                     health_path: Optional[str] = None, release_watch: Optional[str] = None,
                     sleep_after_ms: Optional[int] = None, cdn: Optional[bool] = None,
                     health_fail_seconds: Optional[int] = None,
                     volume: Optional[dict[str, str]] = _UNSET, stop_grace_seconds: Optional[int] = None,
                     release_stages: Optional[str] = None, release_soak_seconds: Optional[int] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Change its settings in place; a field left out stays. ``name=None``
        clears the name; ``volume=None`` takes the volume away, only before the
        App's first deploy (else ``volume_change_refused``, 409). The live
        version keeps serving. ``sleep_after_ms`` is for Functions only (250 to
        5000); ``release_stages`` and ``release_soak_seconds`` for Apps only, and
        a change of them moves a staged release under way (``"at_once"`` sends
        it to every copy)."""
        self._stateful(volume, stop_grace_seconds)
        self._releases(release_stages, release_soak_seconds)
        body = _fields(labels=labels, min_copies=self._min_copies(min_copies), max_copies=max_copies,
                       concurrency=concurrency, spares=spares, vcpu=vcpu, memory_mib=memory_mib, port=port,
                       health_path=health_path, release_watch=release_watch,
                       sleep_after_ms=sleep_after_ms, cdn=cdn, health_fail_seconds=health_fail_seconds,
                       stop_grace_seconds=stop_grace_seconds, release_stages=release_stages,
                       release_soak_seconds=release_soak_seconds)
        if name is not _UNSET:
            body["name"] = name
        if volume is not _UNSET:
            body["volume"] = _volume(volume)
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

    def restart(self, app_id: str, *, wait: bool = False, timeout: float = 300, poll: float = 0.25,
                      idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Start a fresh copy of the live version, as a deploy of its own
        (``restartOf`` names the version it restarted); with a volume, the old
        copy stops first and ``downtime`` (stopMs, bootMs, totalMs) says how
        long it was down. Follow it as a deploy; ``restart_unavailable`` (409)
        means nothing is live."""
        return self._write_deploy(app_id, "restart", {}, wait, timeout, poll, idempotency_key)

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
        """Its versions, live and previous marked; only those two keep saved
        copies. Each says its ``boot`` (saved or cold), ``restartOf``, the
        ``replacements`` of live copies (health or exited) and ``downtime``."""
        return self._t.json("GET", f"{self._base}/{_enc(app_id)}/versions")

    def copies(self, app_id: str) -> list[dict[str, Any]]:
        """Its copies: version, region, state and when that state began."""
        return self._t.json("GET", f"{self._base}/{_enc(app_id)}/copies")

    def logs(self, app_id: str, *, since: Optional[str] = None, version: Optional[int] = None,
             copy: Optional[str] = None, stream: Optional[str] = None, limit: Optional[int] = None,
             cursor: Optional[str] = None, follow: bool = False, timeout: float = 0) -> Any:
        """What its copies printed. ``since`` is an RFC 3339 time or a duration
        back from now (``30s``, ``15m``, ``2h``, ``7d``; default ``1h``, at most
        14 days); ``version``, ``copy`` (a copy's id) and ``stream`` (``stdout``
        or ``stderr``) narrow it. Without ``follow``: ``await`` a page, ``lines``
        oldest first (``at`` in Unix ms, ``stream``, ``copy``, ``version``,
        ``text``), the newest ``limit`` (1 to 500, default 100) in the window;
        ``nextCursor``, sent back as ``cursor`` with the same filters, reads the
        next older page. With ``follow=True``: ``async for`` each event as it
        comes, ``line`` or ``gap`` (lines lost before they could be read),
        resuming after ``cursor``. It reconnects by itself, gives each line once
        and runs until you stop iterating, or for ``timeout`` seconds (0, the
        default: no deadline); an error's ``details["cursor"]`` is where to resume."""
        query = {"since": since, "version": version, "copy": copy, "stream": stream, "limit": limit}
        if follow:
            return self._follow_logs(app_id, query, cursor, timeout)
        return self._logs_page(app_id, query, cursor)

    def _logs_page(self, app_id: str, query: dict[str, Any], cursor: Optional[str]) -> dict[str, Any]:
        return self._t.json("GET", f"{self._base}/{_enc(app_id)}/logs", query={**query, "cursor": cursor})

    def _follow_logs(self, app_id: str, query: dict[str, Any], cursor: Optional[str],
                           timeout: float) -> Iterator[dict[str, Any]]:
        _check_wait(timeout, 0)
        if cursor is not None and not _cursor(cursor):
            raise _failure("invalid_log_options", "Use the opaque cursor a log answer gave.", cursor)
        path = f"{self._base}/{_enc(app_id)}/logs"
        deadline = time.monotonic() + timeout if timeout > 0 else None
        # Cursors are opaque positions: a line already given is known only by its cursor.
        seen: dict[str, None] = {} if cursor is None else {cursor: None}
        failures = 0

        def ended() -> RuntimeError:
            return _failure("timeout", "The follow reached its deadline; resume from details.cursor.", cursor)

        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise ended()
            continued = False
            try:
                # The filters go with every reconnection; only the cursor moves.
                for event in self._t.events("GET", path, query={**query, "follow": True, "cursor": cursor},
                                                  deadline=deadline):
                    if not isinstance(event, dict):
                        raise _log_invalid(cursor)
                    at = event.get("cursor")
                    if at is not None and not _cursor(at):
                        raise _log_invalid(cursor)
                    kind = event.get("type")
                    if kind == "line":
                        if not _log_line(event):
                            raise _log_invalid(cursor)
                        if at in seen:
                            continue
                        seen[at] = None
                        if len(seen) > 10_000:
                            del seen[next(iter(seen))]
                        cursor, failures = at, 0
                        yield event
                    elif kind == "gap":
                        if at is None:
                            raise _log_invalid(cursor)
                        cursor = at
                        yield event
                    elif kind == "continue":
                        # The server ends each follow after about two minutes;
                        # its cursor resumes exactly there.
                        if at is not None:
                            cursor = at
                        continued = True
                        break
                    elif kind == "error":
                        code, hint = event.get("code"), event.get("hint")
                        if not isinstance(code, str) or not code or not isinstance(hint, str) or not hint:
                            raise _log_invalid(cursor)
                        raise _failure(code, hint, cursor)
                    else:
                        raise _log_invalid(cursor)
            except ValueError as error:
                raise _log_invalid(cursor, "The log contained invalid JSON; retry from details.cursor.") from error
            except ConnectionError:
                # Lost the connection: reconnect from the last line. HTTP refusals
                # and protocol errors are the caller's to act on; the transport
                # already retried the retryable ones.
                if deadline is not None and time.monotonic() >= deadline:
                    raise ended()
            except RuntimeError as error:
                if error.code == "request_timeout" and deadline is not None and time.monotonic() >= deadline:
                    raise ended() from error
                raise
            if not continued:
                failures += 1
                if failures > 3:
                    raise _failure("app_log_interrupted",
                                   "Reconnect with logs(id, follow=True, cursor=details['cursor']).", cursor)
            # A service gone or answering continue at once must not spin.
            _sleep(0.05 * max(1, failures))

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
        path = f"{self._base}/{_enc(app_id)}" + (f":{verb}" if verb == "restart" else f"/{verb}")
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

    def _stateful(self, volume: Any, stop_grace_seconds: Optional[int]) -> None:
        """``volume`` is _UNSET when left out: ``volume=None`` is a change too."""
        for field, given in (("volume", volume is not _UNSET),
                             ("stopGraceSeconds", stop_grace_seconds is not None)):
            if given:
                raise InvalidRequestError(f"A Function takes no volume: leave {field} out.",
                                          code="invalid_request", details={"field": field},
                                          hint="Nothing was sent. Use runtime.apps for a server with a volume.")

    def _releases(self, release_stages: Optional[str], release_soak_seconds: Optional[int]) -> None:
        for field, given in (("releaseStages", release_stages is not None),
                             ("releaseSoakSeconds", release_soak_seconds is not None)):
            if given:
                raise InvalidRequestError(f"A Function's versions go live at once: leave {field} out.",
                                          code="invalid_request", details={"field": field},
                                          hint="Nothing was sent. Use runtime.apps for staged releases.")
