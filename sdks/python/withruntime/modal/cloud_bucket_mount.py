"""modal.CloudBucketMount as a native bucket mount (sbx.mounts.add)."""
from __future__ import annotations
from urllib.parse import urlparse
from .._compat import CompatibilityError

KEYED = ("Store the bucket's key with runtime.secrets.set(...) and mount it with the native sandbox's "
         "mounts.add(provider=..., bucket=..., path=..., secret=...)")


class CloudBucketMount:
    def __init__(self, bucket_name, bucket_endpoint_url=None, key_prefix=None, secret=None, oidc_auth_role_arn=None,
                 read_only=False, requester_pays=False, force_path_style=False):
        for value, name in ((secret, "secret"), (oidc_auth_role_arn, "oidc_auth_role_arn")):
            if value is not None:
                raise CompatibilityError(f"{name}: {KEYED}")
        for value, name in ((requester_pays, "requester_pays"), (force_path_style, "force_path_style")):
            if value:
                raise CompatibilityError(f"Runtime bucket mounts do not take {name}; {KEYED}")
        if key_prefix and not key_prefix.endswith("/"):
            raise ValueError("key_prefix will be prefixed to all object paths, so it must end in a '/'")
        self._bucket, self._endpoint, self._prefix, self._read_only = bucket_name, bucket_endpoint_url, key_prefix, read_only

    @property
    def bucket_name(self):
        return self._bucket

    @property
    def bucket_endpoint_url(self):
        return self._endpoint

    @property
    def key_prefix(self):
        return self._prefix

    @property
    def read_only(self):
        return self._read_only

    @property
    def secret(self):
        raise CompatibilityError(KEYED)

    @property
    def oidc_auth_role_arn(self):
        raise CompatibilityError(KEYED)

    @property
    def requester_pays(self):
        raise CompatibilityError(KEYED)

    @property
    def force_path_style(self):
        raise CompatibilityError(KEYED)

    def _mount(self, path):
        """The native mounts.add arguments for this bucket at `path`."""
        fields = {"bucket": self._bucket, "path": path}
        if self._prefix:
            fields["prefix"] = self._prefix
        if self._read_only:
            fields["read_only"] = True
        host = urlparse(self._endpoint).hostname or "" if self._endpoint else ""
        if host == "storage.googleapis.com":
            return {"provider": "gcs", **fields}
        if host.endswith(".r2.cloudflarestorage.com"):
            return {"provider": "r2", "account_id": host.split(".")[0], **fields}
        return {"provider": "s3", **fields, **({"endpoint": self._endpoint} if self._endpoint else {})}
