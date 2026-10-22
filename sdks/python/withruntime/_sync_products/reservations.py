"""GENERATED from _async_products/reservations.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.reservations``: book room for a burst.
#
#     booking = runtime.reservations.create(sandboxes=500, starts_at=start, ends_at=end)
#
# Holds room for that many sandboxes of one size for a window (up to 24 hours,
# starting within 14 days). It is confirmed or declined at once; a decline is a
# normal answer (``status == "declined"``, with ``reason``, ``message`` and
# ``nearestWindow``), not an error. In the window, creates are never refused
# ``no_capacity`` or ``quota_exceeded`` up to what you booked; running sandboxes
# bill as usual and booked room none of them use costs a quarter of the memory rate.
#
#     pool = runtime.reservations.keep(sandboxes=40, snapshots=[snapshot_id], for_key=True)
#
# Standing room is held from now until you cancel it, for a pool that deletes a
# sandbox after each use and makes another: a replacement is never refused up to
# it. With snapshots it is held on the servers holding them, at their size.
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional, Union
from urllib.parse import quote


def iso_time(at: Union[datetime, str]) -> str:
    """An ISO 8601 time with a zone. A naive datetime is local time; a string is sent as given."""
    if isinstance(at, datetime):
        return at.astimezone().isoformat() if at.tzinfo is None else at.isoformat()
    return at


class Reservations:
    """``runtime.reservations``: room booked for a window. A booking is a dict:
    ``id``, ``status`` (``confirmed``, ``declined`` or ``cancelled``), ``reason``
    (why it was declined: ``room``, ``share``, ``usage`` or ``credit``),
    ``message``, ``region``, ``sandboxes``, ``vcpu``, ``memoryMiB``, ``diskMiB``,
    ``startsAt``, ``endsAt``, ``heldUntil``, ``phase`` (``upcoming``, ``active``
    or ``ended``), ``largestSandboxes``, ``nearestWindow``, ``estimateMicros``
    (the most it can cost, microdollars as a string), ``unusedRateMicros``
    (what unused booked room costs per GiB-hour of memory, as quoted when
    booked), ``unusedMaxMicros`` (the most it costs if no sandbox runs),
    ``unusedChargedMicros`` (what its unused room has been charged so far),
    ``inUse``, ``peakInUse``, ``releasedPercent``,
    ``createdAt`` and ``cancelledAt``. Standing room also has ``standing``
    (true), ``snapshots``, ``forKey`` and ``unusedPerHourMicros`` (the most its
    unused room costs an hour); its ``endsAt``, ``heldUntil`` and
    ``unusedMaxMicros`` are None, and ``inUse`` is read live."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def create(self, *, sandboxes: int, starts_at: Union[datetime, str], ends_at: Union[datetime, str],
                     vcpu: Optional[int] = None, memory_mib: Optional[int] = None, disk_mib: Optional[int] = None,
                     region: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Book room for ``sandboxes`` sandboxes (1 to 10,000) from ``starts_at``
        to ``ends_at`` (datetimes or ISO strings; at most 24 hours long, starting
        within 14 days). ``vcpu``, ``memory_mib``, ``disk_mib`` and ``region``
        default to a create's defaults. Returns the booking, confirmed or
        declined."""
        body: dict[str, Any] = {"sandboxes": sandboxes, "startsAt": iso_time(starts_at), "endsAt": iso_time(ends_at)}
        for name, value in (("vcpu", vcpu), ("memoryMiB", memory_mib), ("diskMiB", disk_mib), ("region", region)):
            if value is not None:
                body[name] = value
        return self._t.json("POST", "/v1/reservations", body=body, idempotency_key=idempotency_key)

    def keep(self, *, sandboxes: int, snapshots: Optional[list[str]] = None, for_key: bool = False,
                   vcpu: Optional[int] = None, memory_mib: Optional[int] = None, disk_mib: Optional[int] = None,
                   region: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Keep standing room for ``sandboxes`` sandboxes (1 to 10,000) from now
        until you cancel it. ``snapshots`` (at most 20, one size): held on the
        servers holding them, at their size. ``for_key``: for this key's
        sandboxes alone. Keep a few more than the pool runs, for deletes still
        finishing. Returns the booking, confirmed or declined."""
        body: dict[str, Any] = {"standing": True, "sandboxes": sandboxes}
        for name, value in (("snapshots", snapshots), ("vcpu", vcpu), ("memoryMiB", memory_mib),
                            ("diskMiB", disk_mib), ("region", region)):
            if value is not None:
                body[name] = value
        if for_key:
            body["forKey"] = True
        return self._t.json("POST", "/v1/reservations", body=body, idempotency_key=idempotency_key)

    def update(self, id: str, *, sandboxes: Optional[int] = None, snapshots: Optional[list[str]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Change standing room in place: how many it holds, its snapshots, or
        both. It moves or grows only when all of it fits now; otherwise it
        raises ``no_capacity`` and nothing changes."""
        body: dict[str, Any] = {}
        if sandboxes is not None:
            body["sandboxes"] = sandboxes
        if snapshots is not None:
            body["snapshots"] = snapshots
        return self._t.json("POST", f"/v1/reservations/{quote(id, safe='')}:update", body=body,
                                  idempotency_key=idempotency_key)

    def list(self, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> dict[str, Any]:
        """A page of bookings, newest first: ``{"items": [...], "nextCursor": str | None}``.
        Pass ``nextCursor`` as ``cursor`` for the next page."""
        return self._t.json("GET", "/v1/reservations", query={"limit": limit, "cursor": cursor})

    def get(self, id: str) -> dict[str, Any]:
        """One booking."""
        return self._t.json("GET", f"/v1/reservations/{quote(id, safe='')}")

    def cancel(self, id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Give a booking back. Returns it with ``status`` ``cancelled``."""
        return self._t.json("DELETE", f"/v1/reservations/{quote(id, safe='')}",
                                  idempotency_key=idempotency_key)
