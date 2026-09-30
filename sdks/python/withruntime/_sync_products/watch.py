"""GENERATED from _async_products/watch.py by scripts/generate_sync.py. Do not edit."""
# File watching in a sandbox: E2B's ``watch_dir``, with filters, batches and
# a watch that loses nothing across a pause.
#
#     watch = sbx.files.watch("/workspace", recursive=True, exclude=["node_modules"])
#     for event in watch.events():
#         print(event["type"], event["path"])
#
# ``get_new_events()`` polls instead, the way E2B's handle does.
from __future__ import annotations

from typing import Any, Iterator, Optional
from urllib.parse import quote

from .._errors import RuntimeError


def _enc(value: str) -> str:
    return quote(value, safe="")


class WatchHandle:
    """A running watch. ``cursor`` is where the next read starts; after a
    pause, ``events()`` again carries on from it."""

    def __init__(self, t: Any, base: str, info: dict[str, Any]) -> None:
        self._t = t
        self._base = base
        self.id: str = info["id"]
        self.path: str = info.get("path", "")
        self.cursor: int = int(info.get("cursor") or 0)
        #: overflow / limit / lost notices seen so far: events were missed, rescan.
        self.notices: list[dict[str, Any]] = []
        #: Why delivery stopped: "stopped", "timeout", "root-removed", "paused"...
        self.exit_reason: Optional[str] = None

    def get_new_events(self, wait_ms: int = 0) -> list[dict[str, Any]]:
        """The events since the last call, waiting up to ``wait_ms`` (8000 at most) for some."""
        read = self._t.json("GET", f"{self._base}/{_enc(self.id)}/events",
                                  query={"cursor": self.cursor, "waitMs": max(0, min(8000, wait_ms))})
        self.cursor = read["nextCursor"]
        if read.get("lostBytes"):
            self.notices.append({"k": "lost", "bytes": read["lostBytes"]})
        for notice in read.get("notices", []):
            if notice.get("k") == "end":
                self.exit_reason = notice.get("reason")
            else:
                self.notices.append(notice)
        if read.get("ended") and self.exit_reason is None:
            self.exit_reason = "exited"
        return list(read.get("events", []))

    def events(self) -> Iterator[dict[str, Any]]:
        """Each event as it happens, until the watch ends or the sandbox
        pauses (``exit_reason`` says which). Reconnects by itself every
        110 seconds without losing anything."""
        while True:
            again = False
            for line in self._t.events("GET", f"{self._base}/{_enc(self.id)}/events",
                                             query={"cursor": self.cursor, "follow": True}, timeout=150):
                self.cursor = line.get("cursor", self.cursor)
                kind = line.get("k")
                if kind == "events":
                    for event in line.get("events", []):
                        yield event
                elif kind == "continue":
                    again = True
                elif kind in ("end", "paused"):
                    self.exit_reason = "paused" if kind == "paused" else line.get("reason")
                    return
                elif kind == "failure":
                    raise RuntimeError(str(line.get("message")), code=str(line.get("code")),
                                       status=line.get("status") or 0, hint=line.get("hint"),
                                       request_id=line.get("requestId"))
                else:
                    self.notices.append(line)
            if not again:
                return

    def stop(self) -> bool:
        """Stops the watch in the sandbox."""
        self.exit_reason = self.exit_reason or "stopped"
        return bool((self._t.json("DELETE", f"{self._base}/{_enc(self.id)}"))["stopped"])


class Watches:
    """``sbx.files.watches``: the watches running in a sandbox."""

    def __init__(self, t: Any, sandbox_id: str) -> None:
        self._t = t
        self._base = f"/v1/sandboxes/{_enc(sandbox_id)}/files/watches"

    def start(self, path: str, *, recursive: bool = False, events: Optional[list[str]] = None,
                    include: Optional[list[str]] = None, exclude: Optional[list[str]] = None,
                    batch_ms: Optional[int] = None, timeout_ms: Optional[int] = None,
                    max_watches: Optional[int] = None, id: Optional[str] = None,  # noqa: A002
                    webhook: bool = False,
                    idempotency_key: Optional[str] = None) -> WatchHandle:
        """Starts a watch. ``webhook=True`` also has Runtime send its changes to the
        account's webhooks as ``sandbox.files.changed`` events, with nothing reading
        it here; pass ``timeout_ms=0`` for one that runs until stopped."""
        body = {k: v for k, v in {"path": path, "recursive": recursive, "events": events, "include": include,
                                  "exclude": exclude, "batchMs": batch_ms, "timeoutMs": timeout_ms,
                                  "maxWatches": max_watches, "id": id,
                                  "webhook": True if webhook else None}.items() if v is not None}
        info = self._t.json("POST", self._base, body=body, idempotency_key=idempotency_key)
        return WatchHandle(self._t, self._base, info)

    def list(self) -> list[dict[str, Any]]:
        return (self._t.json("GET", self._base))["data"]

    def stop(self, watch_id: str) -> bool:
        return bool((self._t.json("DELETE", f"{self._base}/{_enc(watch_id)}"))["stopped"])
