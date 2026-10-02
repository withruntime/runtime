"""GENERATED from _async_products/volumes.py by scripts/generate_sync.py. Do not edit."""
# Persistent disks: ``volume = runtime.volumes.create(10240)``, then
# ``runtime.sandboxes.create(volumes=[{"volume_id": volume["id"], "path": "/data"}])``.
# A volume is backed up off its server daily unless that is turned off, and on
# request with ``backup``; ``restore`` makes a new volume from a backup.
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote


def _enc(value: str) -> str:
    return quote(value, safe="")


class Volumes:
    """``runtime.volumes``. One sandbox at a time may write a volume; others
    may attach it with ``"mode": "snapshot"``, a read-only copy."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def create(self, size_mib: Optional[int] = None, *, name: Optional[str] = None,
                     labels: Optional[dict[str, str]] = None, region: Optional[str] = None,
                     from_backup: Optional[str] = None, shared: Optional[bool] = None, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Creates a volume and waits (up to 10 s) until it is ready. With
        ``from_backup``, a restore of that backup (omit ``size_mib``)."""
        body = {k: v for k, v in {"sizeMiB": size_mib, "name": name, "labels": labels, "region": region,
                                  "fromBackup": from_backup, "shared": shared}.items() if v is not None}
        return self._t.json("POST", "/v1/volumes", body=body, wait=10, idempotency_key=idempotency_key)

    def get(self, volume_id: str) -> dict[str, Any]:
        return self._t.json("GET", f"/v1/volumes/{_enc(volume_id)}")

    def list(self, *, state: Optional[str] = None, name: Optional[str] = None,
                   limit: Optional[int] = None) -> Page:
        from .._sync_client import Page  # here, not at the top: that module imports this one
        query: dict[str, Any] = {"state": state, "name": name, "limit": limit}

        def fetch(cursor: Optional[str]) -> Page:
            body = self._t.json("GET", "/v1/volumes", query={**query, "cursor": cursor})
            return Page(body["data"], body.get("nextCursor"), fetch)
        return fetch(None)

    def resize(self, volume_id: str, size_mib: int, *, wait: int = 10,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Grows a detached ordinary volume, waiting up to ``wait`` seconds."""
        return self._t.json("POST", f"/v1/volumes/{_enc(volume_id)}:resize",
                                  body={"sizeMiB": size_mib}, wait=wait, idempotency_key=idempotency_key)

    def attach(self, volume_id: str, sandbox_id: str, path: str, *, wait: int = 10,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Attaches a shared disk where shared disks are enabled."""
        return self._t.json("POST", f"/v1/volumes/{_enc(volume_id)}:attach",
                                  body={"sandboxId": sandbox_id, "path": path}, wait=wait,
                                  idempotency_key=idempotency_key)

    def detach(self, volume_id: str, attachment_id: str, *, wait: int = 10,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Detaches a shared disk and waits for its attachment to finish."""
        return self._t.json("POST", f"/v1/volumes/{_enc(volume_id)}/attachments/{_enc(attachment_id)}:detach",
                                  body={}, wait=wait, idempotency_key=idempotency_key)

    def get_attachment(self, volume_id: str, attachment_id: str) -> dict[str, Any]:
        return self._t.json("GET", f"/v1/volumes/{_enc(volume_id)}/attachments/{_enc(attachment_id)}")

    def delete(self, volume_id: str) -> dict[str, Any]:
        """Deletes a volume no sandbox holds. Its bytes are gone for good."""
        return self._t.json("POST", f"/v1/volumes/{_enc(volume_id)}:delete", body={})

    def backup(self, volume_id: str, *, retention_days: Optional[int] = None, name: Optional[str] = None,
                     wait: int = 60, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Backs the volume up now, off its server, and waits (up to ``wait``
        seconds) for the backup to be ready: copied off and checked."""
        body = {k: v for k, v in {"retentionDays": retention_days, "name": name}.items() if v is not None}
        return self._t.json("POST", f"/v1/volumes/{_enc(volume_id)}:backup", body=body, wait=wait,
                                  idempotency_key=idempotency_key)

    def set_backup_policy(self, volume_id: str, *, daily: Optional[bool] = None,
                                retention_days: Optional[int] = None) -> dict[str, Any]:
        """Turns daily backups on or off, and sets how many days each is kept."""
        body = {k: v for k, v in {"daily": daily, "retentionDays": retention_days}.items() if v is not None}
        return self._t.json("POST", f"/v1/volumes/{_enc(volume_id)}:backup-policy", body=body)

    def backups(self, volume_id: Optional[str] = None, *, state: Optional[str] = None,
                      limit: Optional[int] = None) -> Page:
        """Backups, newest first; those of one volume when ``volume_id`` is given."""
        from .._sync_client import Page
        query: dict[str, Any] = {"volumeId": volume_id, "state": state, "limit": limit}

        def fetch(cursor: Optional[str]) -> Page:
            body = self._t.json("GET", "/v1/volume-backups", query={**query, "cursor": cursor})
            return Page(body["data"], body.get("nextCursor"), fetch)
        return fetch(None)

    def get_backup(self, backup_id: str) -> dict[str, Any]:
        return self._t.json("GET", f"/v1/volume-backups/{_enc(backup_id)}")

    def delete_backup(self, backup_id: str) -> dict[str, Any]:
        """Deletes a backup and its copy off the server."""
        return self._t.json("POST", f"/v1/volume-backups/{_enc(backup_id)}:delete", body={})

    def restore(self, backup_id: str, *, name: Optional[str] = None,
                      idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """A new volume from a backup, the backup's size, on any server in its
        region. Ready once the backup is downloaded and checked."""
        return self.create(from_backup=backup_id, name=name, idempotency_key=idempotency_key)
