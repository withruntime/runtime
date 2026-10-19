"""GENERATED from _async_products/containers.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.containers``: one OCI image's process on its own microVM, billed at
# the sandbox rates. Private beta: an account outside it is refused with
# PermissionDeniedError, code ``product_in_beta`` (403), and retrying does not
# change it.
#
#     box = runtime.containers.create(image="nginx:1.27", vcpu=1, memory_mib=512, name="web")
#     box = runtime.containers.get(box["id"], wait_for="running", timeout_seconds=60)
#     print(box["state"], box["image"], box["port"])
#
# A container: id, name, labels, state (waiting, running, sleeping, stopped,
# failed, deleting, deleted), image (pinned to its digest), entrypoint,
# command, workingDir, user, port (or None), exposedPorts, onExit, sleep, vcpu,
# memoryMiB, envNames (the environment's names, never its values), error,
# createdAt, updatedAt and deletedAt (Unix milliseconds).
from __future__ import annotations

import uuid
from typing import Any, Optional

from .._errors import RuntimeError
from .apps import _UNSET, _Wait, _enc, _fields, _keep_key

# A wait ends at its target or at one of these, with the container's error.
CONTAINER_SETTLED = ("failed", "deleted")


class Containers:
    """``runtime.containers`` (private beta), at /v1/containers. Times are Unix
    milliseconds."""

    _base = "/v1/containers"

    def __init__(self, t: Any) -> None:
        self._t = t

    def create(self, *, image: str, vcpu: int, memory_mib: int, name: Optional[str] = None,
                     labels: Optional[dict[str, str]] = None, entrypoint: Optional[list[str]] = None,
                     command: Optional[list[str]] = None, env: Optional[dict[str, str]] = None,
                     working_dir: Optional[str] = None, user: Optional[str] = None, port: Optional[int] = None,
                     on_exit: Optional[str] = None, sleep: Optional[bool] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Run one copy of ``image`` (an OCI reference; the answer pins its
        digest) with ``vcpu`` (1 to 16) and ``memory_mib`` (128 to 65536).
        ``entrypoint`` replaces the image's Entrypoint and drops its Cmd;
        ``command`` replaces its Cmd. ``env`` is set over the image's own and
        never read back, only its names. ``port`` (1 to 65535) is required when
        the image exposes several TCP ports. ``on_exit`` is ``restart`` or
        ``stop``: by default it restarts when it serves a port, else stops. It
        never sleeps unless ``sleep=True``."""
        body = _fields(image=image, vcpu=vcpu, memory_mib=memory_mib, name=name, labels=labels,
                       entrypoint=entrypoint, command=command, env=env, working_dir=working_dir, user=user,
                       port=port, on_exit=on_exit, sleep=sleep)
        return self._t.json("POST", self._base, body=body, idempotency_key=idempotency_key)

    def get(self, container_id: str, *, wait_for: Optional[str] = None,
                  timeout_seconds: Optional[int] = None) -> dict[str, Any]:
        """One by id. ``wait_for`` (a state) holds the answer on the server up
        to ``timeout_seconds`` (1 to 60, default 30); check the state returned."""
        return self._t.json("GET", f"{self._base}/{_enc(container_id)}",
                                  query={"waitFor": wait_for, "timeoutSeconds": timeout_seconds})

    def list(self, *, name: Optional[str] = None, label: Optional[list[str]] = None,
                   state: Optional[list[str]] = None, limit: Optional[int] = None) -> Page:
        """Yours, filtered by ``name``, ``label`` (``key:value``, all must match)
        and ``state`` (all but deleting and deleted by default); ``limit`` 1 to
        100 a page. ``for`` walks every page."""
        from .._sync_client import Page
        query = {"name": name, "label": label, "state": state, "limit": limit}

        def fetch(cursor: Optional[str]) -> Page:
            body = self._t.json("GET", self._base, query={**query, "cursor": cursor})
            return Page(body["data"], body.get("nextCursor"), fetch)
        return fetch(None)

    def update(self, container_id: str, *, name: Optional[str] = _UNSET,
                     labels: Optional[dict[str, str]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Rename it or replace its labels; nothing else changes. ``name=None``
        clears the name."""
        body = _fields(labels=labels)
        if name is not _UNSET:
            body["name"] = name
        return self._t.json("POST", f"{self._base}/{_enc(container_id)}:update", body=body,
                                  idempotency_key=idempotency_key)

    def delete(self, container_id: str, *, wait: bool = False, timeout: float = 300, poll: float = 0.25,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Delete it and stop its process. With ``wait``, return once it is
        deleted, within ``timeout`` seconds (0: no deadline); a timed-out delete
        can be sent again with the same ``idempotency_key``."""
        path = f"{self._base}/{_enc(container_id)}"
        if not wait:
            return self._t.json("DELETE", path, idempotency_key=idempotency_key)
        waiting = _Wait(timeout, poll, idempotency_key or str(uuid.uuid4()))
        record = self._t.json("DELETE", path, idempotency_key=waiting.key, **waiting.options())
        return self._follow(container_id, "deleted", waiting, record)

    def wait(self, container_id: str, target: str, *, timeout: float = 300,
                   poll: float = 0.25) -> dict[str, Any]:
        """Follow it to ``target`` (``running``, say), within ``timeout``
        seconds. Reaching failed or deleted first raises with its error."""
        return self._follow(container_id, target, _Wait(timeout, poll, None))

    def _follow(self, container_id: str, target: str, waiting: _Wait,
                      record: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        path = f"{self._base}/{_enc(container_id)}"
        try:
            if record is None:
                record = self._t.json("GET", path, **waiting.options())
            while True:
                if record["state"] == target:
                    return record
                if record["state"] in CONTAINER_SETTLED:
                    error = record.get("error") or {}
                    raise RuntimeError(
                        error.get("message") or f"Expected {target}, but {container_id} reached {record['state']}.",
                        code=error.get("code") or "unexpected_state",
                        hint="Read the resource and inspect its error before starting another change.",
                        details={"id": container_id, "state": record["state"], "target": target,
                                 "resource": record},
                        idempotency_key=waiting.key)
                waiting.pause()
                record = self._t.json("GET", path, **waiting.options())
        except RuntimeError as error:
            raise _keep_key(error, waiting)
