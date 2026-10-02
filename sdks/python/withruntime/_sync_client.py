"""GENERATED from _async_client.py by scripts/generate_sync.py. Do not edit."""
from __future__ import annotations

import base64
import json
import math
import os
import random
import time
import uuid
from typing import Any, Iterator, Callable, Optional, Union
from urllib.parse import quote, urlencode

from ._api_defaults import KEEP_ALIVE_MARGIN_SECONDS, STREAMED_EXEC_TIMEOUT_MS, WAIT_FOR_TIMEOUT_SECONDS
from ._clock import sync_background as background
from ._clock import sync_interrupts as interrupts
from ._clock import sync_open_ws as open_ws
from ._clock import sync_parallel as parallel
from ._clock import sync_sleep as sleep
from ._clock import sync_slots as slots
from ._clock import sync_timeouts as timeouts
from ._errors import DELIBERATE as _DELIBERATE
from ._errors import WAITS_FOR_ROOM, CommandError, ConnectionError, RuntimeError, error_for
from ._http import SyncHTTP as HTTP
from ._http import Origin, default_base_url, reachable
from ._proxy import describe as describe_route
from ._unpack import Unpacker
from ._ws import SyncWebSocket as WebSocket
from ._tunnel import PortForward
from ._tunnel import sync_open_forward as open_forward
from ._version import VERSION
from ._sync_products.watch import Watches, WatchHandle

CHUNK = 1_048_576
# Chunks of a large write in flight at once. Each chunk's reply waits on the
# API and the guest, and the link idles while every chunk in flight waits: from
# a home link (12.6 MB/s up, 27 September 2026) 100 MB took 17-18 s at four and
# 11 s at eight, and sixteen was no faster. The TypeScript SDK sends eight too.
PARALLEL_CHUNKS = 8
_KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_.:-"


def _enc(value: str) -> str:
    return quote(value, safe="")


def _query(values: dict[str, Any]) -> str:
    items: list[tuple[str, str]] = []
    for key, value in values.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            items += [(key, str(v)) for v in value]
        elif isinstance(value, bool):
            items.append((key, "true" if value else "false"))
        else:
            items.append((key, str(value)))
    return "?" + urlencode(items) if items else ""


def _seconds_until(moment: Any) -> float:
    """Seconds from now until an ISO 8601 time the API answered; 0 when absent."""
    if not isinstance(moment, str):
        return 0.0
    from datetime import datetime
    return datetime.fromisoformat(moment.replace("Z", "+00:00")).timestamp() - time.time()


def _check_key(key: str) -> str:
    if not key or len(key) > 128 or not key.isascii() or not key[0].isalnum() or any(c.lower() not in _KEY_CHARS for c in key):
        raise ValueError("idempotency_key must be 1-128 letters, digits, '_', '.', ':' or '-'")
    return key


class CommandResult:
    """What a command did: its exit code (None when it did not exit by itself),
    its output, and whether it ran out of time."""

    __slots__ = ("exit_code", "stdout", "stderr", "timed_out", "stdout_truncated", "stderr_truncated",
                 "duration_ms", "process_id", "replayed")

    def __init__(self, exit_code: Optional[int], stdout: str, stderr: str, timed_out: bool = False,
                 stdout_truncated: bool = False, stderr_truncated: bool = False, duration_ms: Optional[int] = None,
                 process_id: Optional[str] = None, replayed: bool = False) -> None:
        self.exit_code, self.stdout, self.stderr, self.timed_out = exit_code, stdout, stderr, timed_out
        self.stdout_truncated, self.stderr_truncated = stdout_truncated, stderr_truncated
        self.duration_ms, self.process_id, self.replayed = duration_ms, process_id, replayed

    def __repr__(self) -> str:
        return (f"CommandResult(exit_code={self.exit_code!r}, stdout={self.stdout!r}, stderr={self.stderr!r}, "
                f"timed_out={self.timed_out!r})")

    def __eq__(self, other: object) -> bool:
        return isinstance(other, CommandResult) and self.to_dict() == other.to_dict()

    @staticmethod
    def from_json(data: dict[str, Any]) -> "CommandResult":
        return CommandResult(
            exit_code=data.get("exitCode"), stdout=data.get("stdout", ""), stderr=data.get("stderr", ""),
            timed_out=bool(data.get("timedOut")), stdout_truncated=bool(data.get("stdoutTruncated")),
            stderr_truncated=bool(data.get("stderrTruncated")), duration_ms=data.get("durationMs"),
            process_id=data.get("processId"), replayed=bool(data.get("replayed")))

    def to_dict(self) -> dict[str, Any]:
        return {"exitCode": self.exit_code, "stdout": self.stdout, "stderr": self.stderr, "timedOut": self.timed_out,
                "stdoutTruncated": self.stdout_truncated, "stderrTruncated": self.stderr_truncated,
                "durationMs": self.duration_ms, "processId": self.process_id}



def _missing_key() -> RuntimeError:
    """No key passed, none in RUNTIME_API_KEY, and none saved by `runtime login`."""
    return RuntimeError(
        "No Runtime key found: RUNTIME_API_KEY is not set and this machine is not connected.",
        code="missing_api_key",
        hint="Run `npx -y withruntime login` (a browser approval; nothing to copy), set RUNTIME_API_KEY "
             "to a key from https://withruntime.com/account/keys, or pass api_key.")


def _request_sleep(delay: float) -> None:
    from ._request_scope import current
    remaining = current().remaining()
    sleep(delay if remaining is None else min(delay, remaining))
    current().remaining()


class _Transport:
    """One connection pool, one retry policy, one error shape for every product.
    Over HTTP/1.1 each call in flight holds a connection, so answers read whole
    are held to ``max_connections`` at once and the rest wait their turn, reusing
    those connections: a hundred calls at once stay under the edge's limit per
    address. Streams are long-lived and do not wait behind them."""

    def __init__(self, api_key: str, base_url: str, timeout: float, max_retries: int,
                 max_connections: int = 32, wait_for_capacity: float = 120) -> None:
        if api_key and any(c.isspace() for c in api_key):
            raise _missing_key()
        # Empty: the key `runtime login` saved for this machine, found on first use.
        self._key: Optional[str] = api_key or None
        self.origin = Origin(reachable(base_url))
        self.base_url = self.origin.base
        self._http = HTTP(self.origin)
        self._timeout = timeout
        self._max_retries = max_retries
        self._slots = slots(max(1, max_connections))
        # What sandboxes.create waits for room by default, in seconds.
        self.wait_for_capacity = max(0.0, float(wait_for_capacity))

    def _api_key(self) -> str:
        if self._key is None:
            from ._connection import saved_key
            self._key = saved_key(self.base_url)
            if self._key is None:
                raise _missing_key()
        return self._key

    def _headers(self, accept: str, key: Optional[str], content: Optional[str], wait: Optional[int]) -> dict[str, str]:
        headers = {"Authorization": "Bearer " + self._api_key(), "Accept": accept,
                   "User-Agent": f"runtime-sdk-python/{VERSION}", "X-Runtime-Client": f"sdk-python/{VERSION}"}
        if content:
            headers["Content-Type"] = content
        if key:
            headers["Idempotency-Key"] = key
        if wait:
            headers["Prefer"] = f"wait={min(120, int(wait))}"
        return headers

    def send(self, method: str, path: str, *, query: Optional[dict[str, Any]] = None, body: Any = None,
                   raw: Optional[bytes] = None, idempotency_key: Optional[str] = None, wait: Optional[int] = None,
                   accept: str = "application/json", timeout: Optional[float] = None, retry: bool = True,
                   wait_for_capacity: float = 0, deadline: Optional[float] = None,
                   on_capacity_wait: Optional[Callable[[RuntimeError, float], None]] = None,
                   read_body: bool = False, unlimited_body: bool = False) -> Any:
        """Sends a call and returns the response once it succeeded. Retries
        transport failures, 429, 502, 503 and 504 with backoff, with the same
        Idempotency-Key every time, so a retried write never happens twice.
        With ``wait_for_capacity`` (seconds; only a create sets it) a refusal
        that clears when a sandbox stops or a host frees room (WAITS_FOR_ROOM)
        is retried the same way until that long has passed, then raised;
        ``on_capacity_wait`` hears the refusal and the seconds before each try."""
        key = _check_key(idempotency_key) if idempotency_key else (str(uuid.uuid4()) if method != "GET" else None)
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        content = "application/octet-stream" if raw is not None else ("application/json" if body is not None else None)
        headers = self._headers(accept, key, content, wait)
        target = path + _query(query or {})
        from ._request_scope import current
        scope = current()
        if scope.deadline is not None:
            deadline = scope.deadline if deadline is None else min(deadline, scope.deadline)
        per_call = scope.timeout(timeout if timeout is not None else self._timeout)
        room_until = time.monotonic() + wait_for_capacity
        room_attempt = 0
        attempt = 0
        def retry_pause(delay):
            try:
                _request_sleep(delay)
            except timeouts() as error:
                raise RuntimeError("The request deadline expired.", code="request_timeout", idempotency_key=key) from error
        while True:
            try:
                scope.remaining()
                extra = {} if deadline is None else {"deadline": deadline}
                if not retry:
                    extra["retry_stale"] = False
                response = self._http.send(method, target, headers, data, per_call, **extra)
                status = response.status
                # Whole responses belong to the same attempt as their headers.
                # A write may already have happened when its body is lost; the
                # retry must retain this call's original idempotency key.
                if 200 <= status < 300 and response.headers.get("runtime-late-answer") == "true":
                    text = response.read()
                    failed = _late_failure(text)
                    if failed is None:
                        return Answered(status, response.headers, text)
                    status = failed
                elif 200 <= status < 300:
                    if not read_body:
                        return response
                    text = response.read(limit=None) if unlimited_body else response.read()
                    return Answered(status, response.headers, text)
                else:
                    text = response.read()
            except (OSError, ValueError, *timeouts()) as error:
                if (deadline is not None and time.monotonic() >= deadline) or (scope.configured and isinstance(error, timeouts())):
                    raise RuntimeError("The request deadline expired.", code="request_timeout", idempotency_key=key) from error
                if not retry or attempt >= self._max_retries:
                    via, hint = describe_route(self.origin.tls, self.origin.host, self.origin.port, error)
                    raise ConnectionError(
                        (f"No answer from Runtime at {self.base_url}{via}. The change may have happened; retrying "
                         "with the same idempotency key is safe.") if key
                        else f"No answer from Runtime at {self.base_url}{via}.",
                        code="connection_error", idempotency_key=key,
                        hint=hint or "Check the network, and RUNTIME_API_URL if you set it.") from error
                retry_pause(_backoff(attempt))
                attempt += 1
                continue
            try:
                parsed = json.loads(text or b"null")
            except ValueError:
                parsed = {"error": {"message": text[:500].decode("utf-8", "replace")}}
            error = error_for(status, parsed, key)
            # A full house: wait for a slot or for room, then send the same call
            # again. A request that can never fit (a fork of more copies than
            # the trial runs) is not waited for.
            if (retry and wait_for_capacity > 0 and error.code in WAITS_FOR_ROOM
                    and (error.details or {}).get("field") != "count"):
                left = room_until - time.monotonic()
                if left <= 0:
                    raise error
                pause = min(left, error.retry_after_ms / 1000 if error.retry_after_ms is not None
                            else _room_backoff(room_attempt))
                if on_capacity_wait is not None:
                    on_capacity_wait(error, pause)
                retry_pause(pause)
                room_attempt += 1
                continue
            if (not retry or status not in (429, 502, 503, 504) or error.code in _DELIBERATE
                    or attempt >= self._max_retries):
                raise error
            header = response.headers.get("retry-after")
            delay = (error.retry_after_ms / 1000 if error.retry_after_ms is not None
                     else float(header) if header and header.isdigit() else _backoff(attempt))
            retry_pause(min(30.0, delay) * random.uniform(0.9, 1.1))
            attempt += 1

    def json(self, method: str, path: str, **kwargs: Any) -> Any:
        with self._slots:
            response = self.send(method, path, read_body=True, **kwargs)
            text = response.read()
        return json.loads(text) if text else None

    def bytes(self, method: str, path: str, **kwargs: Any) -> bytes:
        with self._slots:
            response = self.send(method, path, accept="application/octet-stream", read_body=True, **kwargs)
            return response.read()

    def file_bytes(self, path: str, query: dict[str, Any]) -> bytes:
        """A file's bytes, read whole and checked: the API says a body's length
        (x-content-length) and, when small, its SHA-256 (x-content-sha256)
        before sending it. A body that falls short or differs is read again,
        twice, then refused with ``download_incomplete``. Nothing between the
        API and here reliably turns a stream cut part way into an error: on
        25 September 2026 a 50 MB file came back 44 MB long with no error."""
        attempt = 0
        while True:
            with self._slots:
                response = self.send("GET", path, query=query, accept="application/octet-stream",
                                           read_body=True, unlimited_body=True)
                data = response.read()
            problem = _check_body(response.headers, data)
            if problem is None:
                return data
            if attempt >= 2:
                raise problem
            _request_sleep(_backoff(attempt))
            attempt += 1

    def file_chunks(self, path: str, query: dict[str, Any]) -> Iterator[bytes]:
        """A file's bytes as they arrive. Raises ``download_incomplete`` at the
        end if they fall short of the length the API promised; never retried
        part way."""
        response = self.send("GET", path, query=query, accept="application/octet-stream")
        expected = _promised_length(response.headers)
        got = 0
        try:
            for data in response.chunks():
                got += len(data)
                if expected is not None and got > expected:
                    raise _incomplete(got, expected)
                yield data
            if expected is not None and got != expected:
                raise _incomplete(got, expected)
        finally:
            response.close()

    def events(self, method: str, path: str, *, deadline: Optional[float] = None,
                     **kwargs: Any) -> Iterator[dict[str, Any]]:
        extra = {} if deadline is None else {"deadline": deadline}
        response = self.send(method, path, accept="application/x-ndjson", **kwargs, **extra)
        lines = None
        try:
            lines = response.lines() if deadline is None else response.lines(deadline=deadline)
            for line in lines:
                yield json.loads(line)
        finally:
            # The line reader owns its subscription timer. Stop/join it before
            # releasing the response, even when someone retains the iterator.
            try:
                if lines is not None:
                    _close_events(lines)
            finally:
                response.close()

    def websocket(self, path: str, query: dict[str, Any]) -> WebSocket:
        socket = WebSocket(self.origin, path + _query(query), {
            "Authorization": "Bearer " + self._api_key(), "X-Runtime-Client": f"sdk-python/{VERSION}"})
        return open_ws(socket)

    def close(self) -> None:
        self._http.close()


#: Every field a create takes, as the API names them in snake_case. A name not
#: here is refused before anything is sent, with the one likely meant: until
#: 0.7.0, ``memory_mb=`` reached the API as "memoryMb is not a known field".
#: tests/create-types.test.ts holds this list to the API's own schema.
_CREATE_FIELDS = (
    "name", "labels", "funding", "region", "vcpu", "memory_mib", "disk_mib", "cpu", "cpu_floor_millis",
    "timeout_seconds", "pausable", "idle_pause_seconds", "auto_wake", "persistent", "max_total_cost_micros",
    "get_or_create", "on_lease_end", "max_cost_micros", "network", "image", "snapshot", "volumes",
    "env", "tailscale",
)


def _check_create_fields(fields: dict[str, Any]) -> None:
    import difflib
    known = {_camel(field) for field in _CREATE_FIELDS}
    for name in fields:
        if _camel(name) not in known:
            meant = difflib.get_close_matches(name, _CREATE_FIELDS, n=1, cutoff=0.6)
            raise TypeError(f"create() got an unexpected keyword argument {name!r}."
                            + (f" Did you mean {meant[0]!r}?" if meant else
                               f" It takes {', '.join(_CREATE_FIELDS)}."))


class Answered:
    """A complete response already read within its retry attempt."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status, self.headers, self._body = status, headers, body

    def read(self) -> bytes:
        return self._body

    def close(self) -> None:
        return None


def _late_failure(text: bytes) -> Optional[int]:
    """The status a late answer's body failed with, or None when it is an
    answer. An API error is a body of ``error`` alone, with a code; an answer
    may carry an ``error`` of its own (a code cell's exception)."""
    try:
        body = json.loads(text or b"null")
    except ValueError:
        return 502
    if not isinstance(body, dict) or list(body) != ["error"]:
        return None
    error = body["error"]
    if not isinstance(error, dict) or not isinstance(error.get("code"), str):
        return None
    status = error.get("status")
    return status if isinstance(status, int) and status >= 400 else 500


def _promised_length(headers: dict[str, str]) -> Optional[int]:
    value = headers.get("x-content-length")
    return int(value) if value is not None and value.isdigit() else None


def _incomplete(got: int, expected: int) -> RuntimeError:
    return RuntimeError(f"The download ended at {got} of {expected} bytes.", code="download_incomplete",
                        hint="Read the file again; nothing was written for this read. If it keeps happening, "
                             "report it with `npx withruntime feedback`.",
                        details={"received": got, "expected": expected})


def _check_body(headers: dict[str, str], data: bytes) -> Optional[RuntimeError]:
    """Why a whole body cannot be trusted, or None when it can."""
    expected = _promised_length(headers)
    if expected is not None and len(data) != expected:
        return _incomplete(len(data), expected)
    digest = headers.get("x-content-sha256")
    if digest:
        import hashlib
        if hashlib.sha256(data).hexdigest() != digest.lower():
            return RuntimeError("The file's bytes did not match the SHA-256 the API sent with them.",
                                code="download_incomplete",
                                hint="Read the file again. If it keeps happening, report it with "
                                     "`npx withruntime feedback`.")
    return None


def _backoff(attempt: int) -> float:
    return min(8.0, 0.25 * 2 ** attempt) * random.uniform(0.5, 1.5)


def _room_backoff(attempt: int) -> float:
    """Between tries for room: 0.5 s, 1 s, 2 s, 4 s, then every 8 s, jittered,
    so a queue of CI jobs spreads out instead of knocking at once."""
    return min(8.0, 0.5 * 2 ** attempt) * random.uniform(0.75, 1.25)


class Page:
    """One page of a list. ``for item in page`` walks every page."""

    def __init__(self, data: list[Any], next_cursor: Optional[str], fetch: Callable[[str], Any]) -> None:
        self.data = data
        self.next_cursor = next_cursor
        self._fetch = fetch

    @property
    def has_more(self) -> bool:
        return self.next_cursor is not None

    def next_page(self) -> Optional["Page"]:
        return None if self.next_cursor is None else self._fetch(self.next_cursor)

    def __iter__(self) -> Iterator[Any]:
        page: Optional[Page] = self
        while page is not None:
            for item in page.data:
                yield item
            page = page.next_page()

    def to_list(self, limit: int = 10_000) -> list[Any]:
        items: list[Any] = []
        for item in self:
            items.append(item)
            if len(items) >= limit:
                break
        return items


def _command(command: Union[str, list[str], tuple[str, ...]], cwd: Optional[str], env: Optional[dict[str, str]],
             stdin: Optional[Union[str, bytes]], timeout_ms: Optional[int]) -> dict[str, Any]:
    body: dict[str, Any] = {"command": command} if isinstance(command, str) else {"argv": list(command)}
    if cwd is not None:
        body["cwd"] = cwd
    if env is not None:
        body["env"] = env
    if isinstance(stdin, str):
        body["stdin"] = stdin
    elif stdin is not None:
        body["stdinBase64"] = base64.b64encode(stdin).decode()
    if timeout_ms is not None:
        body["timeoutMs"] = timeout_ms
    return body


def _close_events(events: Any) -> None:
    # The sync source generator removes await; choose the corresponding
    # iterator method so both clients close nested streams explicitly.
    close = getattr(events, "aclose", None) or events.close
    close()


def _process_bytes(encoded: str) -> bytes:
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise RuntimeError("The process returned invalid base64 output.",
                           code="invalid_process_output", status=502) from error


class _OutputCursor:
    """Where a reader of a process's output is, in bytes of stdout and stderr
    together. Output it did not receive, named by the server or not, becomes a
    ``truncated`` event: a chunk starting past the cursor means the bytes
    between were lost. A server error event is raised."""

    def __init__(self, cursor: int = 0) -> None:
        self.cursor = cursor

    def pass_event(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        if event["type"] == "error":
            raise RuntimeError(event["error"].get("message", "Stream failed."),
                               code=event["error"].get("code", "stream_failed"),
                               request_id=event["error"].get("requestId"))
        if event["type"] == "truncated":
            self.cursor = max(self.cursor, event.get("resumeAt", 0))
        out = []
        if event["type"] in ("stdout", "stderr"):
            if event["offset"] > self.cursor:
                out.append({"type": "truncated", "droppedBytes": event["offset"] - self.cursor,
                            "resumeAt": event["offset"]})
            self.cursor = max(self.cursor, event["offset"] + (len(_process_bytes(event["base64"]))
                if "base64" in event else len(event["data"].encode())))
        out.append(event)
        return out


def _cut_off(error: BaseException) -> bool:
    """A stream cut off by the network rather than refused by Runtime: worth
    reconnecting to from the cursor."""
    if isinstance(error, ConnectionError):
        return True
    return isinstance(error, (OSError, TimeoutError, ValueError)) and not isinstance(error, RuntimeError)


class Process:
    """A background process: its output, its input, its end."""

    def __init__(self, t: _Transport, sandbox_id: str, info: dict[str, Any]) -> None:
        self._t, self.sandbox_id, self.info = t, sandbox_id, info
        self._input_offset = int(info.get("stdinOffset") or 0)
        self._input_writes = slots(1)

    @property
    def id(self) -> str:
        return self.info["id"]

    def _path(self, suffix: str = "") -> str:
        return f"/v1/sandboxes/{_enc(self.sandbox_id)}/processes/{_enc(self.id)}{suffix}"

    def output(self, cursor: int = 0, *, timeout_seconds: Optional[float] = None) -> Iterator[dict[str, Any]]:
        """Every output event from ``cursor`` until the process exits. A
        connection that drops is followed again from the cursor; one that keeps
        closing with nothing new is given up with ConnectionError. Optional
        timeout_seconds bounds this subscription, never the process."""
        if timeout_seconds is not None and (not math.isfinite(timeout_seconds) or timeout_seconds < 0):
            raise ValueError("timeout_seconds must be a nonnegative finite number")
        deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
        read = _OutputCursor(cursor)
        idle = 0
        while True:
            before, resumed = read.cursor, False
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise RuntimeError("Process output deadline exceeded.", code="request_timeout")
            extra = {} if deadline is None else {"deadline": deadline, "retry": False}
            events = self._t.events("GET", self._path("/output"), query={"cursor": read.cursor, "follow": True},
                                    timeout=180 if remaining is None else min(180, remaining), **extra)
            try:
                for event in events:
                    if deadline is not None and time.monotonic() >= deadline:
                        raise RuntimeError("Process output deadline exceeded.", code="request_timeout")
                    if event["type"] == "continue":
                        read.cursor, resumed = max(read.cursor, event["cursor"]), True
                        break
                    passing = read.pass_event(event)
                    if event["type"] == "exit":
                        # Closed before the last event is handed over: a reader
                        # that stops at exit leaves no stream open for the
                        # loop's shutdown to close twice at once.
                        _close_events(events)
                    for passed in passing:
                        yield passed
                    if event["type"] == "exit":
                        return
            except Exception as error:  # noqa: BLE001 - reconnect only when the network cut it
                if deadline is not None and time.monotonic() >= deadline:
                    raise RuntimeError("Process output deadline exceeded.", code="request_timeout") from error
                if not _cut_off(error):
                    raise
            finally:
                _close_events(events)
            idle = 0 if resumed or read.cursor > before else idle + 1
            if idle > 3:
                raise ConnectionError(
                    f"The output stream of process {self.id} keeps closing before it ends.",
                    code="connection_error", details={"sandboxId": self.sandbox_id, "processId": self.id},
                    hint=f"Read what it printed so far: runtime sandbox logs {self.sandbox_id} {self.id}")

    def output_bytes(self, cursor: int = 0, *, timeout_seconds: Optional[float] = None) -> Iterator[dict[str, Any]]:
        """Lossless bytes for a process spawned with output_encoding="base64"."""
        if self.info.get("outputEncoding") != "base64":
            raise RuntimeError("Spawn with output_encoding='base64' to read lossless bytes.",
                               code="binary_output_unavailable")
        events = self.output(cursor=cursor, timeout_seconds=timeout_seconds)
        try:
            for event in events:
                if event["type"] in ("stdout", "stderr"):
                    if "base64" not in event:
                        raise RuntimeError("The process returned text without its original bytes.",
                                           code="binary_output_unavailable")
                    yield {"type": event["type"], "offset": event["offset"],
                           "data": _process_bytes(event["base64"])}
                else:
                    yield event
        finally:
            _close_events(events)

    def wait(self) -> CommandResult:
        out = {"stdout": "", "stderr": ""}
        exit_event: dict[str, Any] = {}
        dropped = False
        for event in self.output():
            if event["type"] in ("stdout", "stderr"):
                out[event["type"]] += event["data"]
            elif event["type"] == "truncated":
                dropped = True
            elif event["type"] == "exit":
                exit_event = event
        return CommandResult(exit_code=exit_event.get("exitCode"), stdout=out["stdout"], stderr=out["stderr"],
                             timed_out=bool(exit_event.get("timedOut")), stdout_truncated=dropped,
                             stderr_truncated=dropped, process_id=self.id)

    def write(self, data: Union[str, bytes], eof: bool = False) -> None:
        """Sends input; offsets are tracked, so a retried write is never typed twice."""
        payload = data.encode() if isinstance(data, str) else bytes(data)
        with self._input_writes:
            sent = 0
            chunk_size = CHUNK
            while True:
                chunk = payload[sent:sent + chunk_size]
                reply = self._t.json("POST", self._path(":write"), body={
                    "base64": base64.b64encode(chunk).decode(), "offset": self._input_offset,
                    "eof": eof and sent + len(chunk) == len(payload)})
                offset = reply.get("offset")
                if type(offset) is not int or offset < self._input_offset or offset > self._input_offset + len(chunk):
                    raise ConnectionError("The process returned an invalid input offset.", code="connection_error")
                accepted = offset - self._input_offset
                sent += accepted
                self._input_offset = offset
                if sent >= len(payload):
                    return
                if accepted == 0 and chunk:
                    # The guest's input buffer is full. Yield before resending
                    # the same bytes, so draining and cancellation can run.
                    chunk_size = min(chunk_size, 65_536)
                    sleep(0.1)
                elif accepted < len(chunk):
                    # Resend only as much as the guest showed it can accept,
                    # rather than sending a whole MiB for every small advance.
                    chunk_size = accepted

    def kill(self, signal: str = "SIGTERM") -> None:
        self._t.json("POST", self._path(":signal"), body={"signal": signal})

    def resize(self, cols: int, rows: int) -> None:
        self._t.json("POST", self._path(":resize"), body={"cols": cols, "rows": rows})

    def refresh(self) -> dict[str, Any]:
        self.info = self._t.json("GET", self._path())
        return self.info


class Terminal:
    """An interactive terminal over a WebSocket: write() types, recv() reads."""

    def __init__(self, socket: WebSocket, process_id: Optional[str]) -> None:
        self._socket, self.process_id = socket, process_id
        self.exit_code: Optional[int] = None

    def write(self, data: Union[str, bytes]) -> None:
        self._socket.send(data.encode() if isinstance(data, str) else data)

    def resize(self, cols: int, rows: int) -> None:
        self._socket.send(json.dumps({"type": "resize", "cols": cols, "rows": rows}))

    def recv(self) -> Optional[bytes]:
        """The next output bytes, or None once the terminal has ended."""
        while True:
            message = self._socket.recv()
            if message is None:
                return None
            if isinstance(message, bytes):
                return message
            event = json.loads(message)
            if event.get("type") == "exit":
                self.exit_code = event.get("exitCode")

    def close(self) -> None:
        self._socket.close()


class Files:
    """Files in the sandbox. Paths are absolute; any path the sandbox user may use."""

    def __init__(self, t: _Transport, sandbox_id: str) -> None:
        self._t, self._id = t, sandbox_id

    def _path(self, suffix: str) -> str:
        return f"/v1/sandboxes/{_enc(self._id)}{suffix}"

    @property
    def watches(self) -> Watches:
        """The watches running in the sandbox."""
        return Watches(self._t, self._id)

    def watch(self, path: str, **options: Any) -> WatchHandle:
        """Watch a directory: create, write, remove, rename and chmod events.
        Options: recursive, events, include, exclude (globs), batch_ms,
        timeout_ms (1 h by default), max_watches. Read with ``events()`` or
        ``get_new_events()``; ``stop()`` ends it."""
        return self.watches.start(path, **options)

    def read(self, path: str) -> bytes:
        """A file's bytes, any size, checked against the length (and for a
        small file the SHA-256) the API sends first: a short read is read
        again, then raises ``download_incomplete``, never returns short. For a
        file too big to hold in memory use ``read_stream`` or ``download``."""
        return self._t.file_bytes(self._path("/files/content"), {"path": path})

    def _open_read(self, path: str):
        """Open a response for adapters that expose an owned streaming reader."""
        return self._t.send("GET", self._path("/files/content"), query={"path": path},
                                  accept="application/octet-stream")

    def read_stream(self, path: str) -> Iterator[bytes]:
        """A file's bytes in pieces as they arrive, any size, without holding
        it in memory (Daytona's ``download_file_stream``). Raises
        ``download_incomplete`` at the end if it falls short::

            for piece in sbx.files.read_stream("/workspace/big.tar"):
                out.write(piece)
        """
        chunks = self._t.file_chunks(self._path("/files/content"), {"path": path})
        try:
            for piece in chunks:
                yield piece
        finally:
            _close_events(chunks)

    def read_text(self, path: str, encoding: str = "utf-8") -> str:
        return (self.read(path)).decode(encoding)

    def write(self, path: str, data: Union[str, bytes], mode: Optional[int] = None) -> dict[str, Any]:
        """Writes a file, atomically, making parent directories. Under
        /workspace any size, large ones in parallel 1 MiB chunks checked against
        their SHA-256; elsewhere, with the sandbox user's rights, up to 1 MiB.
        ``mode`` sets its permissions (0o755 for a program); 0o644 when left out."""
        payload = data.encode() if isinstance(data, str) else bytes(data)
        octal = None if mode is None else format(mode & 0o777, "03o")
        if len(payload) <= CHUNK:
            query = {"path": path, **({"mode": octal} if octal else {})}
            response = self._t.send("PUT", self._path("/files/content"), query=query, raw=payload)
            response.read()
            return {"path": path, "size": len(payload)}
        import hashlib
        body = {"path": path, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
        try:
            begin = self._t.json("POST", self._path("/uploads"), body={
                **body, **({"mode": octal} if octal else {})})
        except RuntimeError as error:
            if not octal or error.code != "guest_upgrade_required":
                raise
            # The API aborted before accepting chunks. A new call gets a new key.
            begin = self._t.json("POST", self._path("/uploads"), body=body)
        upload, step = begin["uploadId"], begin["chunkBytes"]

        def chunk(offset: int) -> None:
            response = self._t.send("PUT", self._path(f"/uploads/{_enc(upload)}"), query={"offset": offset},
                                          raw=payload[offset:offset + step])
            response.read()
        try:
            parallel(chunk, range(0, len(payload), step), PARALLEL_CHUNKS)
            self._t.json("POST", self._path(f"/uploads/{_enc(upload)}:commit"), body={})
            if octal and begin.get("mode") != octal:  # Older images need chmod after commit.
                self._t.json("POST", self._path("/files:chmod"), body={"path": path, "mode": octal})
        except BaseException:
            try:
                self._t.json("POST", self._path(f"/uploads/{_enc(upload)}:abort"), body={})
            except RuntimeError:
                pass
            raise
        return {"path": path, "size": len(payload)}

    def list(self, path: str = "/workspace", *, depth: Optional[int] = None, glob: Optional[str] = None,
                   hidden: Optional[bool] = None, limit: Optional[int] = None) -> list[dict[str, Any]]:
        return (self._t.json("GET", self._path("/files/list"), query={
            "path": path, "depth": depth, "glob": glob, "hidden": hidden, "limit": limit}))["data"]

    def glob(self, pattern: str, root: str = "/workspace") -> list[dict[str, Any]]:
        return self.list(root, glob=pattern)

    def stat(self, path: str) -> dict[str, Any]:
        return self._t.json("GET", self._path("/files/stat"), query={"path": path})

    def exists(self, path: str) -> bool:
        return bool((self.stat(path)).get("exists"))

    def mkdir(self, path: str, parents: bool = True) -> None:
        self._t.json("POST", self._path("/files:mkdir"), body={"path": path, "parents": parents})

    def remove(self, path: str, recursive: bool = False) -> bool:
        return bool((self._t.json("POST", self._path("/files:remove"), body={"path": path, "recursive": recursive}))["removed"])

    def rename(self, source: str, target: str, overwrite: bool = False) -> None:
        self._t.json("POST", self._path("/files:rename"), body={"from": source, "to": target, "overwrite": overwrite})

    def archive(self, path: str, *, gzip: bool = True, user: str = "sandbox",
                      exclude: Optional[list[str]] = None) -> bytes:
        """Pack a folder as tar bytes, gzip-compressed by default. ``exclude``
        contains relative paths, not globs. ``user='root'`` explicitly uses
        passwordless sudo inside this sandbox."""
        data = bytearray()
        chunks = self._t.file_chunks(self._path("/files/archive"),
                                     {"path": path, "gzip": gzip, "user": user, "exclude": exclude})
        try:
            for piece in chunks:
                data.extend(piece)
        finally:
            _close_events(chunks)
        return bytes(data)

    def unarchive(self, path: str, data: bytes, *, gzip: Optional[bool] = None,
                        user: str = "sandbox", idempotency_key: Optional[str] = None) -> None:
        """Unpack tar bytes into a folder, merging existing files. Gzip is
        detected from the header when omitted. Large archives use bounded
        upload parts. ``user='root'`` explicitly uses guest root."""
        import hashlib
        from ._request_scope import Limits, request_scope
        payload = bytes(data)
        compressed = payload.startswith(b"\x1f\x8b")
        if gzip is not None and gzip != compressed:
            raise ValueError("gzip does not match the archive header")
        key = _check_key(idempotency_key) if idempotency_key is not None else str(uuid.uuid4())
        def phase(name):
            return hashlib.sha256(json.dumps(["files.unarchive", key, name], separators=(",", ":")).encode()).hexdigest()
        if len(payload) <= CHUNK:
            self._t.json("PUT", self._path("/files/archive"), query={"path": path, "user": user},
                               raw=payload, idempotency_key=key)
            return
        begin = self._t.json("POST", self._path("/files/archive/uploads"),
                                   body={"path": path, "gzip": compressed, "user": user},
                                   idempotency_key=phase("begin"))
        upload = self._path(f"/files/archive/uploads/{_enc(begin['uploadId'])}")
        try:
            step = begin["chunkBytes"]
            if type(step) is not int or not 0 < step <= CHUNK:
                raise ConnectionError("The archive upload returned an invalid chunk size.", code="connection_error")
            for offset in range(0, len(payload), step):
                self._t.json("PUT", upload, query={"offset": offset}, raw=payload[offset:offset + step],
                                   idempotency_key=phase(f"chunk:{offset}"))
            self._t.json("POST", upload + ":commit", body={}, idempotency_key=phase("commit"))
        except BaseException:
            # An expired caller scope must not skip cleanup or replace the
            # original failure with a failure to abort the partial upload.
            try:
                with request_scope(captured=Limits()):
                    self._t.json("POST", upload + ":abort", body={}, idempotency_key=phase("abort"))
            except BaseException:
                pass
            raise

    def upload(self, local_path: str, remote_path: str, *, user: str = "sandbox") -> None:
        """Copies a local file or directory in. A directory travels as one gzipped tar
        to the API's folder routes, unpacked by the sandbox's own tar."""
        if os.path.isfile(local_path):
            if user != "sandbox":
                raise ValueError("Root uploads take a folder; use unarchive() for archive bytes")
            with open(local_path, "rb") as source:
                # Its permissions travel with it: an uploaded script stays runnable.
                self.write(remote_path, source.read(), mode=os.stat(local_path).st_mode & 0o777)
            return
        import io
        import tarfile
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            archive.add(local_path, arcname=".")
        self.unarchive(remote_path, buffer.getvalue(), gzip=True, user=user)

    def _stream_to(self, remote_path: str, local_path: str) -> None:
        """Streams a file to disk through a partial file beside the target,
        renamed into place only once every byte has arrived: a failed copy
        never leaves a short file under the name asked for. A short stream is
        tried again, twice, as a short ``read`` is."""
        partial = f"{local_path}.runtime-partial-{uuid.uuid4().hex[:8]}"
        attempt = 0
        while True:
            try:
                with open(partial, "wb") as target:
                    for piece in self.read_stream(remote_path):
                        target.write(piece)
                os.replace(partial, local_path)
                return
            except BaseException as error:
                try:
                    os.remove(partial)
                except FileNotFoundError:
                    pass
                if attempt >= 2 or not isinstance(error, RuntimeError) or error.code != "download_incomplete":
                    raise
                attempt += 1

    def download(self, remote_path: str, local_path: str, *, user: str = "sandbox") -> None:
        """Copies a file or directory out. A file streams to disk, any size,
        checked against its length."""
        # Root folder reads cannot first stat the path as the sandbox user:
        # root's tar checks it directly, and rejects a missing or non-folder path.
        entry = {"exists": True, "type": "directory"} if user == "root" else self.stat(remote_path)
        if not entry.get("exists"):
            raise RuntimeError(f"{remote_path} does not exist.", code="file_not_found", status=404)
        if entry.get("type") != "directory":
            os.makedirs(os.path.dirname(os.path.abspath(local_path)), exist_ok=True)
            self._stream_to(remote_path, local_path)
            return
        # The sandbox's own tar packs it as it streams, and it is unpacked as it
        # arrives; one cut short is refused and nothing is put in place.
        unpacker = Unpacker(local_path)
        try:
            chunks = self._t.file_chunks(self._path("/files/archive"), {"path": remote_path, "gzip": True, "user": user})
            try:
                for piece in chunks:
                    unpacker.feed(piece)
            finally:
                _close_events(chunks)
            unpacker.finish()
        finally:
            unpacker.discard()


class SandboxSessions:
    """Sessions: a short-lived token your backend makes and hands to your own
    frontend, which then runs commands, uses files and reaches previews in this
    one sandbox directly. A session cannot stop, pause, extend, fork, snapshot
    or change the sandbox, create anything, or reach anything else. It lasts an
    hour unless asked (a day at most), ends when the key that made it is
    revoked, and is revocable at once."""

    def __init__(self, t: _Transport, sandbox_id: str) -> None:
        self._t, self._id = t, sandbox_id

    def _path(self, suffix: str = "") -> str:
        return f"/v1/sandboxes/{_enc(self._id)}/sessions{suffix}"

    def create(self, ttl_seconds: Optional[int] = None, origins: Optional[list[str]] = None,
                     name: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """A new session. ``origins`` are the exact pages that will use it
        (``https://app.example.com``, or ``http://localhost:5173`` while
        developing): the API answers CORS for them and refuses other pages.
        ``token`` is in this answer only."""
        body: dict[str, Any] = {}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        if origins is not None:
            body["origins"] = list(origins)
        if name is not None:
            body["name"] = name
        made = self._t.json("POST", self._path(), body=body, idempotency_key=idempotency_key)
        if made.get("token"):
            return made
        # A replay of a create whose answer was lost: a token is shown once, so
        # end that session and make a fresh one.
        try:
            self.revoke(made["id"])
        except RuntimeError:
            pass
        fresh = self._t.json("POST", self._path(), body=body)
        if not fresh.get("token"):
            raise RuntimeError("The session was made but its token did not arrive.", code="session_token_lost",
                               status=0, hint=f"Revoke session {fresh['id']} and create another.")
        return fresh

    def list(self) -> list[dict[str, Any]]:
        """Sessions still active, and those that ended in the last day, newest first."""
        return (self._t.json("GET", self._path()))["data"]

    def revoke(self, session_id: str) -> dict[str, Any]:
        """Ends a session now; its next request is refused."""
        return self._t.json("POST", self._path(f"/{_enc(session_id)}:revoke"), body={})


class Sandbox:
    """A sandbox. ``with runtime.sandboxes.create() as sbx:`` stops it at the end."""

    def __init__(self, t: _Transport, info: dict[str, Any]) -> None:
        self._t = t
        self.info = info
        self._keep_alive: Optional[Callable[[], None]] = None
        self.files = Files(t, info["id"])
        self.sessions = SandboxSessions(t, info["id"])
        # Imported here, not at the top, so a product module may itself import
        # this one without a cycle.
        from ._sync_products import SANDBOX as SANDBOX_PRODUCTS
        for name, product in SANDBOX_PRODUCTS.items():
            setattr(self, name, product(t, self))

    @property
    def info(self) -> dict[str, Any]:
        """What the API last said about this sandbox. ``start``, the report of
        an image's start command, is the create's alone: the API keeps no
        record of it, so a later read of this sandbox keeps it here."""
        return self._info

    @info.setter
    def info(self, value: dict[str, Any]) -> None:
        start = getattr(self, "_info", {}).get("start")
        self._info = {**value, "start": start} if start is not None and "start" not in value else value

    @property
    def id(self) -> str:
        return self.info["id"]

    @property
    def state(self) -> str:
        return self.info.get("state", "")

    @staticmethod
    def from_session(token: str, sandbox_id: str, api_url: Optional[str] = None, *,
                     timeout: float = 300) -> "Sandbox":
        """A sandbox reached with a session token instead of an API key: its
        commands, processes, files and previews, and nothing else. Makes no
        call. The backend makes the session with ``sbx.sessions.create()``."""
        if not token.startswith("rtsess_"):
            raise RuntimeError("That is not a sandbox session token (they start rtsess_).",
                               code="invalid_request", status=0,
                               hint="Make one on your backend with sbx.sessions.create() and pass its token.")
        t = _Transport(token, api_url or default_base_url(), timeout, 4)
        return Sandbox(t, {"id": sandbox_id})

    def _path(self, suffix: str = "") -> str:
        return f"/v1/sandboxes/{_enc(self.id)}{suffix}"

    def refresh(self) -> "Sandbox":
        self.info = self._t.json("GET", self._path())
        return self

    def wait_for(self, state: str, timeout_seconds: int = WAIT_FOR_TIMEOUT_SECONDS) -> "Sandbox":
        """Waits (server-side, no polling) until the sandbox reaches ``state``."""
        self.info = self._t.json("GET", self._path(), query={"waitFor": state, "timeoutSeconds": timeout_seconds})
        return self

    def exec(self, command: Union[str, list[str], tuple[str, ...]], *, cwd: Optional[str] = None,
                   env: Optional[dict[str, str]] = None, stdin: Optional[Union[str, bytes]] = None,
                   timeout_ms: Optional[int] = None, on_stdout: Optional[Callable[[str], Any]] = None,
                   on_stderr: Optional[Callable[[str], Any]] = None, check: bool = False,
                   idempotency_key: Optional[str] = None) -> CommandResult:
        """Runs a command: a string under ``bash -c``, a list without a shell.
        With on_stdout/on_stderr the output streams. The timeout is 60 s by
        default, 24 h when the output streams. A timeout is a result
        (timed_out=True, the output so far), never an error; ``check=True``
        raises CommandError on a non-zero exit."""
        streaming = on_stdout is not None or on_stderr is not None or (timeout_ms or 0) > 60_000
        if not streaming:
            data = self._t.json("POST", self._path(":exec"), body=_command(command, cwd, env, stdin, timeout_ms),
                                      idempotency_key=idempotency_key, timeout=(timeout_ms or 60_000) / 1000 + 60)
            result = CommandResult.from_json(data)
        else:
            out = {"stdout": "", "stderr": ""}
            exit_event: dict[str, Any] = {}
            process_id = None
            # A "truncated" event means the reader fell more than the process's
            # output buffer behind. It does not say which stream lost bytes, so
            # both flags carry it.
            dropped = False
            try:
                for event in self.exec_stream(command, cwd=cwd, env=env, stdin=stdin, timeout_ms=timeout_ms,
                                                    idempotency_key=idempotency_key):
                    if event["type"] == "start":
                        process_id = event["processId"]
                    elif event["type"] in ("stdout", "stderr"):
                        out[event["type"]] += event["data"]
                        callback = on_stdout if event["type"] == "stdout" else on_stderr
                        if callback is not None:
                            callback(event["data"])
                    elif event["type"] == "truncated":
                        dropped = True
                    elif event["type"] == "exit":
                        exit_event = event
            except interrupts():
                # Ctrl-C or a cancelled task stops the command in the sandbox
                # too, as it would at a terminal; it used to run on unseen.
                if process_id is not None:
                    try:
                        Process(self._t, self.id, {"id": process_id}).kill("SIGTERM")
                    except Exception:  # noqa: BLE001 - the interrupt is what the caller hears
                        pass
                raise
            except ConnectionError as error:
                if process_id is None or (error.details or {}).get("processId"):
                    raise
                raise ConnectionError(
                    f"Lost the output of process {process_id}; the command may still be running.",
                    code="connection_error", details={"sandboxId": self.id, "processId": process_id},
                    hint=(f"Follow it: runtime sandbox logs {self.id} {process_id} -f, or stop it: "
                          f"runtime sandbox kill {self.id} {process_id}.")) from error
            result = CommandResult(exit_code=exit_event.get("exitCode"), stdout=out["stdout"], stderr=out["stderr"],
                                   timed_out=bool(exit_event.get("timedOut")), stdout_truncated=dropped,
                                   stderr_truncated=dropped, duration_ms=exit_event.get("durationMs"),
                                   process_id=process_id)
        if check and (result.exit_code != 0 or result.timed_out):
            raise CommandError(result.to_dict())
        return result

    def exec_stream(self, command: Union[str, list[str], tuple[str, ...]], *, cwd: Optional[str] = None,
                          env: Optional[dict[str, str]] = None, stdin: Optional[Union[str, bytes]] = None,
                          timeout_ms: Optional[int] = None,
                          idempotency_key: Optional[str] = None) -> Iterator[dict[str, Any]]:
        """The command's events as they happen: start, stdout, stderr, exit.
        Resumes by itself when the server ends a long stream or the connection
        drops after the command started, and yields ``truncated`` for output it
        did not receive, so lost output never passes as whole. Event fields have
        snake_case aliases; the original camelCase fields remain available."""
        def event_names(event):
            aliases = {"processId": "process_id", "exitCode": "exit_code", "timedOut": "timed_out",
                       "durationMs": "duration_ms", "stdoutTruncated": "stdout_truncated",
                       "stderrTruncated": "stderr_truncated", "droppedBytes": "dropped_bytes",
                       "resumeAt": "resume_at"}
            return {**event, **{alias: event[name] for name, alias in aliases.items() if name in event}}
        body = {**_command(command, cwd, env, stdin, timeout_ms if timeout_ms is not None else STREAMED_EXEC_TIMEOUT_MS), "stream": True}
        events = self._t.events("POST", self._path(":exec"), body=body, idempotency_key=idempotency_key,
                                timeout=((timeout_ms or STREAMED_EXEC_TIMEOUT_MS) / 1000) + 60)
        read = _OutputCursor()
        process_id: Optional[str] = None
        try:
            for event in events:
                if event["type"] == "start":
                    process_id = event["processId"]
                if event["type"] == "continue":
                    process_id, read.cursor = event["processId"], event["cursor"]
                    break
                passing = read.pass_event(event)
                if event["type"] == "exit":
                    _close_events(events)  # as in Process.output
                for passed in passing:
                    yield event_names(passed)
                if event["type"] == "exit":
                    return
        except Exception as error:  # noqa: BLE001 - reconnect only when the network cut it
            if process_id is None or not _cut_off(error):
                raise
        finally:
            _close_events(events)
        # The server ended a long stream, or the connection closed after the
        # command started: its output is kept on the sandbox, so follow it.
        if process_id is None:
            raise ConnectionError("The exec stream closed before the command started.", code="connection_error",
                                  hint="Run it again; to be sure it runs once, pass the same idempotency_key.")
        continued = Process(self._t, self.id, {"id": process_id}).output(cursor=read.cursor)
        try:
            for rest in continued:
                yield event_names(rest)
        finally:
            _close_events(continued)

    def spawn(self, command: Union[str, list[str], tuple[str, ...]], *, cwd: Optional[str] = None,
                    env: Optional[dict[str, str]] = None, stdin: Optional[str] = None,
                    pty: Optional[dict[str, int]] = None, timeout_ms: Optional[int] = None,
                    output_encoding: Optional[str] = None) -> Process:
        """Starts a background process and returns at once. ``stdin="pipe"``
        keeps input open for write(); ``pty={"cols": 120, "rows": 40}`` gives a terminal."""
        body = _command(command, cwd, env, None if stdin == "pipe" else stdin, timeout_ms)
        if output_encoding is not None:
            if output_encoding not in ("utf8", "base64"):
                raise ValueError("output_encoding must be utf8 or base64")
            body["outputEncoding"] = output_encoding
        if stdin == "pipe":
            body["stdinMode"] = "pipe"
        if pty is not None:
            body["pty"] = pty
        info = self._t.json("POST", self._path("/processes"), body=body)
        return Process(self._t, self.id, info)

    def processes(self) -> list[dict[str, Any]]:
        return (self._t.json("GET", self._path("/processes")))["data"]

    def process(self, process_id: str) -> Process:
        return Process(self._t, self.id, self._t.json("GET", self._path(f"/processes/{_enc(process_id)}")))

    def terminal(self, *, cols: int = 80, rows: int = 24, command: Optional[str] = None,
                       cwd: Optional[str] = None, process_id: Optional[str] = None) -> Terminal:
        """An interactive terminal over a WebSocket."""
        socket = self._t.websocket(self._path("/terminal"), {
            "cols": cols, "rows": rows, "command": command, "cwd": cwd, "processId": process_id})
        ready = socket.recv()
        if not isinstance(ready, str):
            raise RuntimeError("The terminal did not start.", code="terminal_refused")
        event = json.loads(ready)
        if event.get("type") != "ready":
            raise RuntimeError(event.get("error", {}).get("message", "The terminal did not start."), code="terminal_refused")
        return Terminal(socket, event.get("processId"))

    def forward_port(self, port: int, *, local_port: Optional[int] = None,
                           host: str = "127.0.0.1") -> PortForward:
        """Listens on a local port (``port`` unless ``local_port`` says; 0 for
        any) and carries each connection to ``port`` on the sandbox's loopback,
        over one authenticated WebSocket, until ``close()``. No port of the
        sandbox is opened to the internet."""
        return open_forward(self._t.websocket, self._path("/tunnel"), port, local_port, host)

    def _lifecycle(self, verb: str, wait: bool, body: Optional[dict[str, Any]] = None,
                         idempotency_key: Optional[str] = None) -> "Sandbox":
        self.info = self._t.json("POST", self._path(f":{verb}"), body=body or {}, wait=60 if wait else None,
                                       idempotency_key=idempotency_key)
        return self

    def stop(self, wait: bool = True, idempotency_key: Optional[str] = None) -> "Sandbox":
        self.stop_keep_alive()
        return self._lifecycle("stop", wait, idempotency_key=idempotency_key)

    def pause(self, wait: bool = True, idempotency_key: Optional[str] = None) -> "Sandbox":
        return self._lifecycle("pause", wait, idempotency_key=idempotency_key)

    def switch_image(self, image: str, *, keep: str,
                           idempotency_key: Optional[str] = None) -> "Sandbox":
        """Moves it to another image (id, name, name:tag or name@version),
        keeping its id, /workspace (its home: dotfiles, pip --user and npm -g
        installs), volumes, environment, name and previews. Its processes
        restart, and everything else on its old disk (sudo installs, apt
        packages, /etc) is lost, which ``keep="workspace"`` says you know;
        snapshot it first to keep everything. A running sandbox is paused
        first. A switch that fails is undone (``switch_undone``), the sandbox
        on its old image with nothing lost. Charged as a wake."""
        self.info = self._t.json("POST", self._path(":switch-image"), body={"image": image, "keep": keep},
                                       wait=120, idempotency_key=idempotency_key)
        return self

    def delete(self, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Deletes it for good: stops it if it runs or is paused, deletes its
        disk and paused memory, revokes its previews and ports, and removes it
        from lists. Its snapshots, usage and audit entries stay. Deleting it
        again answers the same. Answers ``{"id", "status": "deleted",
        "deletedAt", ...}``."""
        self.stop_keep_alive()
        return self._t.json("DELETE", self._path(), idempotency_key=idempotency_key)

    def wake(self, wait: bool = True, timeout_seconds: Optional[int] = None,
                   idempotency_key: Optional[str] = None) -> "Sandbox":
        """Carries on a paused sandbox; ``timeout_seconds`` is its new lease.
        Waking one that is already awake is done, not an error (unless a new
        lease was asked for, which was not given)."""
        try:
            return self._lifecycle("wake", wait, {} if timeout_seconds is None else {"timeoutSeconds": timeout_seconds},
                                         idempotency_key)
        except RuntimeError as error:
            if error.code != "not_paused" or timeout_seconds is not None:
                raise
            self.refresh()
            if self.state not in ("running", "starting"):
                raise
            return self

    def extend(self, seconds: int, idempotency_key: Optional[str] = None) -> "Sandbox":
        """More time before the lease ends (at most an hour ahead of now)."""
        return self._lifecycle("extend", False, {"seconds": seconds}, idempotency_key)

    def update(self, idempotency_key: Optional[str] = None, **settings: Any) -> "Sandbox":
        """Changes its settings; what you leave out stays as it is: ``name``,
        ``labels``, ``env`` (a value sets a variable, None removes it; commands
        started afterwards get the change), ``auto_wake`` (a request wakes it when paused),
        ``idle_pause_seconds`` (pause after this long with no activity, counted
        from now; 0 never, otherwise 10 to 86400; a new sandbox has 60),
        ``persistent`` (keep it running while credit lasts
        and keep its disk after a stop; paid only) and
        ``max_total_cost_micros`` (None removes the cap)."""
        return self._lifecycle("update", False, {_camel(k): v for k, v in settings.items()}, idempotency_key)

    def keep_alive(self, every_seconds: float = 60, margin_seconds: int = KEEP_ALIVE_MARGIN_SECONDS) -> Callable[[], None]:
        """Keeps a running sandbox's lease ahead of now, in the background,
        until ``stop()`` or the function it returns ends it: every
        ``every_seconds`` it extends the lease so that ``margin_seconds``
        (60 to 3600) remain, never more than the hour ahead the API allows.
        Running time is billed as it is used. A paused sandbox is left paused
        (a request wakes it unless auto_wake is off); a stopped one ends it."""
        self.stop_keep_alive()
        state: dict[str, Any] = {"on": True}
        margin = min(3600, max(60, int(margin_seconds)))
        every = max(10.0, float(every_seconds))

        def loop() -> None:
            while state["on"]:
                try:
                    self.refresh()
                    if self.state in ("stopped", "stopping"):
                        break
                    if self.state == "running":
                        need = math.ceil(margin - _seconds_until(self.info.get("expiresAt")))
                        if need >= 1:
                            self.extend(min(3600, need))
                except RuntimeError:
                    pass  # The next check tries again.
                if state["on"]:
                    sleep(every)
            state["on"] = False
            if self._keep_alive is state.get("end"):
                self._keep_alive = None

        cancel = background(loop)

        def end() -> None:
            state["on"] = False
            cancel()
            if self._keep_alive is end:
                self._keep_alive = None
        state["end"] = end
        self._keep_alive = end
        return end

    def stop_keep_alive(self) -> None:
        """Ends ``keep_alive()``, if it runs."""
        if self._keep_alive is not None:
            self._keep_alive()

    def set_retention(self, days: int, idempotency_key: Optional[str] = None) -> "Sandbox":
        """Days a paused sandbox is kept before deletion (1 to 365)."""
        return self._lifecycle("retention", False, {"days": days}, idempotency_key)

    def snapshot(self, *, name: Optional[str] = None, labels: Optional[dict[str, str]] = None,
                       retention_days: Optional[int] = None, mode: Optional[str] = None,
                       idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Keep a whole-machine snapshot, or a disk-only snapshot with mode='disk'.
        A running source stays paused until capture finishes, then wakes; an
        already paused source stays paused. Capture waits at most 60 seconds;
        restoring the original running state may take additional time."""
        if mode is not None and mode not in ("memory", "disk"):
            raise ValueError("Snapshot mode must be memory or disk")
        from ._request_scope import Limits, request_scope
        body = {"name": name, "labels": labels, "retentionDays": retention_days, "mode": mode}
        self.refresh()
        if self.state in ("resuming", "starting"):
            self.wait_for("running")
        elif self.state == "pausing":
            self.wait_for("paused")
        running = self.state == "running"
        snapshot = None
        primary_error = None
        try:
            if running:
                self.pause()
            try:
                with request_scope(60):
                    snapshot = self._t.json("POST", self._path(":snapshot"),
                                                  body={k: v for k, v in body.items() if v is not None},
                                                  wait=10, idempotency_key=idempotency_key)
                    while snapshot["state"] == "capturing":
                        _request_sleep(.2)
                        snapshot = self._t.json("GET", f"/v1/snapshots/{_enc(snapshot['id'])}")
            except (RuntimeError, *timeouts()) as error:
                if isinstance(error, RuntimeError) and error.code != "request_timeout":
                    raise
                raise RuntimeError("Snapshot capture did not finish within one minute.", code="snapshot_timeout",
                                   details={"snapshotId": snapshot["id"]} if snapshot else None) from error
            if snapshot["state"] != "ready":
                raise RuntimeError(snapshot.get("error") or f"Snapshot capture ended in state {snapshot['state']}.",
                                   code="snapshot_failed", status=409, details={"snapshotId": snapshot["id"]})
            if mode == "disk" and snapshot.get("mode") != "disk":
                raise RuntimeError("The server did not confirm a disk-only snapshot.", code="snapshot_mode_mismatch",
                                   status=409, details={"snapshotId": snapshot["id"]})
            return snapshot
        except BaseException as error:
            primary_error = error
            raise
        finally:
            if running:
                # Capture's deadline must never prevent restoring the source.
                try:
                    with request_scope(captured=Limits()):
                        self.wake()
                except BaseException as error:
                    failure = primary_error if primary_error is not None else error
                    recovery = {"message": str(error)}
                    if isinstance(error, RuntimeError):
                        recovery["code"] = error.code
                    details = {"sourceSandboxId": self.id, "sourceWakeError": recovery}
                    if snapshot is not None:
                        details["snapshotId"] = snapshot["id"]
                    if isinstance(failure, RuntimeError):
                        failure.details = {**(failure.details or {}), **details}
                    else:
                        for key, value in details.items():
                            setattr(failure, key, value)
                    if primary_error is None:
                        raise

    def fork(self, count: Optional[int] = None, *, name: Optional[str] = None,
                   labels: Optional[dict[str, str]] = None, keep_snapshot: Optional[bool] = None,
                   funding: Optional[str] = None, idempotency_key: Optional[str] = None) -> Any:
        """Copies of this sandbox as it is now (files, memory, running processes),
        answered once they run. A running sandbox is paused for the moment its
        snapshot takes, then woken. One Sandbox without ``count``; a list with it.
        ``funding`` ("trial" or "paid") is what the copies run on, as for a
        create; omitted, they keep this sandbox's."""
        body = {"count": count, "name": name, "labels": labels, "keepSnapshot": keep_snapshot, "funding": funding}
        reply = self._t.json("POST", self._path(":fork"), body={k: v for k, v in body.items() if v is not None},
                                   wait=60, idempotency_key=idempotency_key)
        sandboxes = [Sandbox(self._t, info) for info in reply["sandboxes"]]
        return sandboxes if count is not None else sandboxes[0]

    def restart(self, wait: bool = True, idempotency_key: Optional[str] = None) -> "Sandbox":
        """Starts a stopped persistent sandbox again from its disk (memory is not kept)."""
        return self._lifecycle("restart", wait, idempotency_key=idempotency_key)

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *_: Any) -> None:
        self.stop_keep_alive()
        if self.state != "stopped":
            try:
                self.stop(wait=False)
            except RuntimeError:
                pass

    def __repr__(self) -> str:
        return f"Sandbox(id={self.id!r}, state={self.state!r})"


class Sandboxes:
    def __init__(self, t: _Transport) -> None:
        self._t = t

    def create(self, *, wait: bool = True, idempotency_key: Optional[str] = None,
                     wait_for_capacity: Optional[float] = None,
                     on_capacity_wait: Optional[Callable[[RuntimeError, float], None]] = None,
                     **fields: Any) -> Sandbox:
        """Creates a sandbox and waits until it is running. Every field is
        optional (name, labels, env (variables for every command, terminal
        and SSH session in it; values are never shown again), funding, region, vcpu, memory_mib, disk_mib,
        cpu, cpu_floor_millis, timeout_seconds, pausable, on_lease_end,
        max_cost_micros, network={"internet": True, "deny": [...]}, and
        image, snapshot, volumes and the rest of _CREATE_FIELDS; a misspelled one
        raises TypeError, naming the one meant).
        When every trial slot or the account's quota is taken, it waits for one
        to free, up to ``wait_for_capacity`` seconds (the client's, 120 by
        default; 0 fails at once), then raises the refusal as it came;
        ``on_capacity_wait(refusal, seconds)`` is called before each wait, to
        tell a person why nothing has happened yet."""
        _check_create_fields(fields)
        body = {_camel(k): v for k, v in fields.items() if v is not None}
        if isinstance(body.get("volumes"), list):
            body["volumes"] = [{_camel(k): v for k, v in item.items()} for item in body["volumes"]]
        info = self._t.json("POST", "/v1/sandboxes", body=body, wait=60 if wait else None,
                                  idempotency_key=idempotency_key,
                                  wait_for_capacity=self._t.wait_for_capacity if wait_for_capacity is None
                                  else max(0.0, float(wait_for_capacity)),
                                  on_capacity_wait=on_capacity_wait)
        sandbox = Sandbox(self._t, info)
        if wait and sandbox.state != "running":
            sandbox.wait_for("running", WAIT_FOR_TIMEOUT_SECONDS)
            if sandbox.state != "running":
                raise RuntimeError(f"Sandbox {sandbox.id} is {sandbox.state}, not running.", code="start_failed",
                                   hint="Read it with runtime.sandboxes.get(id); stopReason says why.")
        return sandbox

    def get_or_create(self, name: str, *, wait: bool = True, idempotency_key: Optional[str] = None,
                            **fields: Any) -> Sandbox:
        """The sandbox named ``name`` in this account, ready to use: running as
        it is, woken if paused, restarted if stopped and persistent, or created
        with ``fields`` when no sandbox has the name. ``sandbox.info.get("reused")``
        says which. The other fields apply only when it is created."""
        return self.create(wait=wait, idempotency_key=idempotency_key, name=name, get_or_create=True,
                                 **fields)

    def get(self, sandbox_id: str) -> Sandbox:
        return Sandbox(self._t, self._t.json("GET", f"/v1/sandboxes/{_enc(sandbox_id)}"))

    def delete(self, sandbox_id: str, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Deletes a sandbox for good, by id, without reading it first: see
        ``Sandbox.delete``."""
        return self._t.json("DELETE", f"/v1/sandboxes/{_enc(sandbox_id)}", idempotency_key=idempotency_key)

    def list(self, *, state: Optional[list[str]] = None, include_stopped: bool = False,
                   labels: Optional[dict[str, str]] = None, name: Optional[str] = None,
                   limit: Optional[int] = None) -> Page:
        """Live sandboxes, oldest first; ``for`` walks every page."""
        query: dict[str, Any] = {"state": state, "includeStopped": include_stopped or None,
                                 "label": [f"{k}:{v}" for k, v in labels.items()] if labels else None,
                                 "name": name, "limit": limit}

        def fetch(cursor: Optional[str]) -> Page:
            body = self._t.json("GET", "/v1/sandboxes", query={**query, "cursor": cursor})
            return Page([Sandbox(self._t, info) for info in body["data"]], body.get("nextCursor"), fetch)
        return fetch(None)


class Snapshots:
    """``runtime.snapshots``. Take one with ``sbx.snapshot()``; start from one
    with ``runtime.sandboxes.create(snapshot_id=...)``."""

    def __init__(self, t: _Transport) -> None:
        self._t = t

    def create(self, sandbox_id: str, **fields: Any) -> dict[str, Any]:
        return self._t.json("POST", f"/v1/sandboxes/{_enc(sandbox_id)}:snapshot",
                                  body={_camel(k): v for k, v in fields.items() if v is not None})

    def get(self, snapshot_id: str) -> dict[str, Any]:
        return self._t.json("GET", f"/v1/snapshots/{_enc(snapshot_id)}")

    def list(self, *, sandbox_id: Optional[str] = None, name: Optional[str] = None,
                   state: Optional[str] = None, limit: Optional[int] = None) -> Page:
        query: dict[str, Any] = {"sandboxId": sandbox_id, "name": name, "state": state, "limit": limit}

        def fetch(cursor: Optional[str]) -> Page:
            body = self._t.json("GET", "/v1/snapshots", query={**query, "cursor": cursor})
            return Page(body["data"], body.get("nextCursor"), fetch)
        return fetch(None)

    def update(self, snapshot_id: str, *, idempotency_key: Optional[str] = None, **fields: Any) -> dict[str, Any]:
        """Replace supplied name/labels; omission preserves and name=None clears.
        if_labels optionally fences concurrent metadata replacement."""
        unknown = fields.keys() - {"name", "labels", "if_labels"}
        if unknown:
            raise TypeError(f"Unknown snapshot fields: {', '.join(sorted(unknown))}")
        return self._t.json("POST", f"/v1/snapshots/{_enc(snapshot_id)}:update",
                                  body={_camel(k): v for k, v in fields.items()}, idempotency_key=idempotency_key)

    def delete(self, snapshot_id: str) -> None:
        self._t.json("POST", f"/v1/snapshots/{_enc(snapshot_id)}:delete", body={})

    def extend(self, snapshot_id: str, retention_days: int) -> dict[str, Any]:
        return self._t.json("POST", f"/v1/snapshots/{_enc(snapshot_id)}:extend", body={"retentionDays": retention_days})


class Feedback:
    def __init__(self, t: _Transport) -> None:
        self._t = t

    def submit(self, kind: str, summary: str, *, detail: Optional[str] = None, competitor: Optional[str] = None,
                     resource_id: Optional[str] = None, request_id: Optional[str] = None,
                     context: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Tell the Runtime team something. Please do, generously: bugs, missing
        features, what another provider does better, what blocks a migration.
        kind: bug, missing_feature, competitor_gap, migration_blocker, docs, pricing, praise, other."""
        body = {"kind": kind, "summary": summary, "detail": detail, "competitor": competitor,
                "resourceId": resource_id, "requestId": request_id, "context": context}
        return self._t.json("POST", "/v1/feedback", body={k: v for k, v in body.items() if v is not None})

    def list(self, limit: Optional[int] = None) -> list[dict[str, Any]]:
        return (self._t.json("GET", "/v1/feedback", query={"limit": limit}))["data"]


class Support:
    def __init__(self, t: _Transport) -> None:
        self._t = t

    def message(self, message: Optional[str] = None, *, conversation_id: Optional[str] = None,
                      approve_action_id: Optional[str] = None, approve_input_hash: Optional[str] = None,
                      deny_action_id: Optional[str] = None) -> dict[str, Any]:
        """Ask Runtime support. If status is "working", read() again in a minute."""
        body = {"message": message, "conversationId": conversation_id, "approveActionId": approve_action_id,
                "approveInputHash": approve_input_hash, "denyActionId": deny_action_id}
        return self._t.json("POST", "/v1/support/messages", body={k: v for k, v in body.items() if v is not None},
                                  retry=False, timeout=120)

    def read(self, conversation_id: str) -> dict[str, Any]:
        return self._t.json("GET", f"/v1/support/conversations/{_enc(conversation_id)}")


class Account:
    """The account this key belongs to: ``runtime.account``."""

    def __init__(self, t: _Transport) -> None:
        self._t = t

    def close(self, *, confirm: str) -> dict[str, Any]:
        """Close the account for good: stop and delete everything it runs and
        stores, end every key and dissolve it. ``confirm`` must be the
        account's name exactly (``me()["orgName"]``). Needs a key for every
        product made by an owner. Moves no money: what is unspent of a purchase
        made in the last 15 days is refunded on request; other credit is forfeited."""
        return self._t.json("POST", "/v1/account:close", body={"confirm": confirm}, retry=False)


def _camel(name: str) -> str:
    special = {"memory_mib": "memoryMiB", "disk_mib": "diskMiB", "snapshot_id": "snapshot"}
    if name in special:
        return special[name]
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


class Runtime:
    """One client for every Runtime Cloud product. Create it once and reuse it:
    it keeps its connections open. ``with Runtime() as runtime:``."""

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, *, timeout: float = 300,
                 max_retries: int = 4, max_connections: int = 32, wait_for_capacity: float = 120) -> None:
        """``wait_for_capacity``: seconds ``sandboxes.create`` keeps retrying,
        with the same key and input, when the trial's slots, the account's
        quota or the region is full (trial_busy, quota_exceeded, no_capacity
        and the like). 0 fails at once."""
        self._t = _Transport(api_key or os.environ.get("RUNTIME_API_KEY", ""),
                             base_url or default_base_url(), timeout, max_retries,
                             max_connections, wait_for_capacity)
        self.base_url = self._t.base_url
        self.sandboxes = Sandboxes(self._t)
        self.sandbox = self.sandboxes
        self.snapshots = Snapshots(self._t)
        self.snapshot = self.snapshots
        self.feedback = Feedback(self._t)
        self.account = Account(self._t)
        self.support = Support(self._t)
        from ._sync_products import CLIENT as PRODUCTS
        for name, product in PRODUCTS.items():
            setattr(self, name, product(self._t))
        # Match the CLI's product names without making another client or pool.
        # Account commands such as secrets, events and billing keep their names.
        for singular, plural in (("image", "images"), ("volume", "volumes"), ("job", "jobs"),
                                ("domain", "domains"), ("port", "ports"), ("address", "addresses")):
            setattr(self, singular, getattr(self, plural))

    def me(self) -> dict[str, Any]:
        """Who this key is: organization, agent and credential."""
        return self._t.json("GET", "/v1/me")

    def usage(self) -> dict[str, Any]:
        """Credit, holds, trial time and per-resource charges. Money is integer
        microdollars in strings (1,000,000 = $1): ``credited``, ``spent``,
        ``held``, ``expired``, ``available`` (credited - spent - expired - held)
        and ``takenBack`` (the part of spent that refunds and disputes took);
        ``trial`` is in milliseconds, or None; ``outbound`` is this month's
        outbound traffic in bytes, with ``chargedMicros`` for what went past
        the month's free ``allowanceBytes``."""
        return self._t.json("GET", "/v1/usage")

    def usage_requests(self, range: str = "24h") -> dict[str, Any]:
        """This account's authenticated API answers: 24h, 7d, 30d or 90d.
        Counts are exact decimal strings; errorPercent is None without calls.
        The key needs usage permission. The window ends with the partial hour."""
        return self._t.json("GET", "/v1/usage/requests", query={"range": range})

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        """Any API route, with the client's auth, retries and errors."""
        return self._t.json(method, path, **kwargs)

    def close(self) -> None:
        self._t.close()

    def __enter__(self) -> "Runtime":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


__all__ = ["Runtime", "Sandbox", "Sandboxes", "SandboxSessions", "Files", "Process", "Terminal",
           "Page", "Feedback", "Support", "Snapshots", "CommandResult"]
