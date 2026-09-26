"""GENERATED from _async_products/mounts.py by scripts/generate_sync.py. Do not edit."""
# Buckets mounted in a sandbox: ``sbx.mounts.add(provider="s3", bucket="data",
# region="eu-west-1", path="/data", secret="DATA_BUCKET")``. The secret holds
# ACCESS_KEY_ID:SECRET_KEY with header Authorization and format
# "AWS4-HMAC-SHA256 {value}"; the sandbox never sees the key, because the egress
# proxy signs every request. A mount lasts through a pause and a wake.
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote


class Mounts:
    """``sbx.mounts``: your own S3, R2 or Google Cloud Storage bucket as a
    directory in this sandbox."""

    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def _base(self) -> str:
        return f"/v1/sandboxes/{quote(self._sandbox.id, safe='')}/mounts"

    def add(self, *, provider: str, bucket: str, path: str, prefix: Optional[str] = None,
                  region: Optional[str] = None, endpoint: Optional[str] = None,
                  account_id: Optional[str] = None, secret: Optional[str] = None,
                  read_only: Optional[bool] = None) -> dict[str, Any]:
        """Mounts the bucket at ``path``. ``provider`` is "s3" (any S3-compatible
        store with ``endpoint``), "r2" (with ``account_id``) or "gcs" (HMAC keys)."""
        body = {k: v for k, v in {"provider": provider, "bucket": bucket, "path": path, "prefix": prefix,
                                  "region": region, "endpoint": endpoint, "accountId": account_id,
                                  "secret": secret, "readOnly": read_only}.items() if v is not None}
        return self._t.json("POST", self._base(), body=body)

    def list(self) -> list[dict[str, Any]]:
        return (self._t.json("GET", self._base()))["data"]

    def remove(self, path: str) -> dict[str, Any]:
        """Unmounts the bucket at ``path``. What was written stays in the bucket."""
        return self._t.json("POST", self._base() + ":unmount", body={"path": path})
