"""``morphcloud.api`` (0.1.115) on Runtime. An instance is a sandbox, a snapshot
a Runtime snapshot, metadata its labels, an HTTP service a preview, a branch a
fork. Every call has its ``a``-prefixed twin, which runs the same call on a
worker thread, as Morph's own ``asetup``, ``aupload`` and ``abuild`` do.

What Runtime has no equivalent for (SSH keys and SSH clients, containers in
a snapshot, reboot, devboxes, volumes, the package index, the account's API
keys) raises ``CompatibilityError`` naming Runtime's way, before anything is
created. The labels and digests are the TypeScript adapter's
(``withruntime/morph``), so both languages find each other's snapshots."""
from __future__ import annotations

import asyncio
import builtins
import fnmatch
import hashlib
import json
import math
import os
import re
import sys
import time
import typing
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass, field, fields, is_dataclass
from datetime import datetime
from enum import Enum
from urllib.parse import urlparse

from .._compat import CompatibilityError, refused, runtime_key
from .._errors import RuntimeError as _NativeError
from .._sync_client import Runtime, Sandbox as _Sandbox

__all__ = [
    "ApiError", "CompatibilityError", "Image", "ImageAPI", "Instance", "InstanceAPI", "InstanceExecResponse",
    "InstanceHttpService", "InstanceNetworking", "InstanceRefs", "InstanceSshKey", "InstanceStatus",
    "MorphCloudClient", "ResourceSpec", "Snapshot", "SnapshotAPI", "SnapshotRefs", "SnapshotStatus", "SnapshotTTL",
    "TTL", "UserAPI", "WakeOn",
]

PROVIDER = "morph"
#: Morph's base image; on Runtime, the default image.
MORPH_DEFAULT_IMAGE = "morphvm-minimal"
# Labels the adapter keeps for itself; never shown as metadata.
_IMAGE_LABEL = "morph.image"
_DIGEST_LABEL = "morph.digest"
_HTTP_LABEL = "morph.http."
_SSH = ("reach a sandbox with `runtime sandboxes ssh <id>` (also VS Code and JetBrains), "
        "or instance.native.forward_port(port)")
_CONTAINER = ("build a Runtime image from the Dockerfile (withruntime.Runtime().images) and pass its name as "
              "image_id, or run `sudo enable-docker` in the instance")
_REBOOT = ("restart its programs at a new size with instance.native.resize(vcpu=..., memory_mib=...), "
           "or start a fresh copy from a snapshot")
# A day of retention is the smallest Runtime keeps a snapshot for.
_DAY = 86_400


def _print(text: str) -> None:
    print(text, flush=True)


# Errors ---------------------------------------------------------------------


class ApiError(Exception):
    """Morph's error for a failed call. A Runtime refusal arrives as one: its
    code is ``error_code``, its message ``detail``, and the Runtime error is
    the ``__cause__``."""

    def __init__(self, message: str, status_code: int, response_body: str):
        self.status_code = status_code
        self.response_body = response_body
        self.error_code: typing.Optional[str] = None
        self.detail: typing.Optional[str] = None
        try:
            payload = json.loads(response_body)
            if isinstance(payload, dict):
                if isinstance(payload.get("error_code"), str):
                    self.error_code = payload["error_code"]
                if isinstance(payload.get("detail"), str):
                    self.detail = payload["detail"]
        except (TypeError, ValueError):
            pass
        super().__init__(f"{message}\nStatus Code: {status_code}\nResponse Body: {response_body}")

    def as_managed_ssh_key_error(self) -> None:
        """Runtime has no managed SSH keys, so no error is one of theirs."""
        return None


def _api_error(code: str, status: int, message: str, hint: typing.Optional[str] = None,
               request_id: typing.Optional[str] = None) -> ApiError:
    body = json.dumps({"error_code": code, "detail": message, "hint": hint, "request_id": request_id}, indent=2)
    return ApiError(f"HTTP Error {status} for Runtime ({code})", status, body)


@contextmanager
def _api():
    """A Runtime refusal becomes Morph's ApiError; a connection failure
    (status 0) and the adapter's own errors pass as they are."""
    try:
        yield
    except _NativeError as error:
        if error.status == 0:
            raise
        raise _api_error(error.code, error.status, error.message, error.hint, error.request_id) from error


# Models -----------------------------------------------------------------------


def _dump(value: typing.Any) -> typing.Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, _Model):
        return {name: _dump(getattr(value, name)) for name in value._fields()}
    if isinstance(value, dict):
        return {k: _dump(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_dump(v) for v in value]
    return value


class _Model:
    """Morph's pydantic models as plain objects: fields by attribute,
    ``model_dump`` and ``model_dump_json``."""

    @classmethod
    def _fields(cls) -> list[str]:
        if is_dataclass(cls):
            return [f.name for f in fields(cls) if not f.name.startswith("_")]
        names: list[str] = []
        for klass in reversed(cls.__mro__):
            names += [n for n in vars(klass).get("__annotations__", {}) if not n.startswith("_") and n not in names]
        return names

    def model_dump(self, **_options: typing.Any) -> dict[str, typing.Any]:
        return _dump(self)

    def model_dump_json(self, **_options: typing.Any) -> str:
        return json.dumps(self.model_dump(), default=str)


class _StrEnum(str, Enum):
    def __repr__(self) -> str:
        return self.value

    def __str__(self) -> str:
        return self.value


class SnapshotStatus(_StrEnum):
    PENDING = "pending"
    READY = "ready"
    FAILED = "failed"
    DELETING = "deleting"
    DELETED = "deleted"


class InstanceStatus(_StrEnum):
    PENDING = "pending"
    READY = "ready"
    PAUSED = "paused"
    SAVING = "saving"
    ERROR = "error"


@dataclass
class TTL(_Model):
    """An instance's time limit: Runtime's ``timeoutSeconds``, its end, and
    what happens then (``pause``, or ``stop``, which deletes it as Morph's does)."""
    ttl_seconds: typing.Optional[int] = None
    ttl_expire_at: typing.Optional[int] = None
    ttl_action: typing.Optional[str] = "stop"


@dataclass
class SnapshotTTL(_Model):
    """How long a snapshot is kept: Runtime keeps one for whole days."""
    ttl_seconds: typing.Optional[int] = None
    ttl_expire_at: typing.Optional[int] = None


@dataclass
class WakeOn(_Model):
    """Runtime's ``autoWake``: any request wakes a paused sandbox, or none does."""
    wake_on_ssh: bool = False
    wake_on_http: bool = False


@dataclass
class InstanceSshKey(_Model):
    object: str = "instance_ssh_key"
    private_key: str = ""
    public_key: str = ""
    password: str = ""


@dataclass
class Image(_Model):
    id: str
    name: str
    disk_size: int
    created: int
    object: str = "image"
    description: typing.Optional[str] = None


@dataclass
class ResourceSpec(_Model):
    """vCPUs, and memory and disk in MiB."""
    vcpus: int
    memory: int
    disk_size: int


@dataclass
class SnapshotRefs(_Model):
    image_id: str


@dataclass
class InstanceHttpService(_Model):
    name: str
    port: int
    url: str


@dataclass
class InstanceNetworking(_Model):
    internal_ip: typing.Optional[str] = None
    http_services: list[InstanceHttpService] = field(default_factory=list)


@dataclass
class InstanceRefs(_Model):
    snapshot_id: str
    image_id: str


@dataclass
class InstanceExecResponse(_Model):
    exit_code: int
    stdout: str
    stderr: str


# Shapes ---------------------------------------------------------------------------


def _reserved(key: str) -> bool:
    return key in ("compat.provider", _IMAGE_LABEL, _DIGEST_LABEL) or key.startswith(_HTTP_LABEL)


def _labels(info: typing.Any) -> dict[str, str]:
    return dict(info.get("labels") or {})


def _metadata_of(labels: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in labels.items() if not _reserved(k)}


def _check_metadata(metadata: typing.Optional[dict[str, str]]) -> dict[str, str]:
    """Metadata must not write the adapter's own labels."""
    if metadata is None:
        return {}
    if not isinstance(metadata, dict):
        raise TypeError("metadata must be a dict")
    for key, value in metadata.items():
        if _reserved(key):
            raise CompatibilityError(f"Morph: metadata key {key} is the adapter's own label")
        if not isinstance(value, str):
            raise TypeError(f"metadata {key} must be a string")
    return dict(metadata)


def _seconds(iso: typing.Optional[str]) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()) if iso else 0


def _status(state: str) -> InstanceStatus:
    if state == "running":
        return InstanceStatus.READY
    if state == "paused":
        return InstanceStatus.PAUSED
    if state == "pausing":
        return InstanceStatus.SAVING
    if state in ("stopping", "stopped"):
        return InstanceStatus.ERROR
    return InstanceStatus.PENDING


def _snapshot_status(state: str) -> SnapshotStatus:
    return SnapshotStatus.PENDING if state == "capturing" else SnapshotStatus(state)


def _digest_name(digest: str) -> str:
    """A Runtime snapshot name for a Morph digest: digests are any string, names are not."""
    return "morph-" + hashlib.sha256(digest.encode()).hexdigest()


def _ttl(ttl_seconds: typing.Optional[int], ttl_action: typing.Optional[str]) -> dict[str, typing.Any]:
    """A time limit at create; Morph's stop deletes an instance, as Runtime's ``delete`` does."""
    if ttl_action not in (None, "stop", "pause"):
        raise ValueError("ttl_action must be 'stop' or 'pause'")
    if ttl_seconds is None:
        if ttl_action is not None:
            raise CompatibilityError("Morph: ttl_action without ttl_seconds")
        return {}
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) or not 60 <= ttl_seconds <= _DAY:
        raise CompatibilityError("Morph: ttl_seconds outside 60 to 86400 whole seconds (Runtime's time limit)")
    return {"timeout_seconds": ttl_seconds, "on_lease_end": "pause" if ttl_action == "pause" else "delete"}


def _retention_days(ttl_seconds: typing.Optional[int]) -> typing.Optional[int]:
    """A snapshot's ttl_seconds as Runtime's retention: whole days, 1 to 365.
    None keeps it while the account has credit, up to a year."""
    if ttl_seconds is None:
        return None
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) or ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be greater than zero")
    if ttl_seconds % _DAY or not 1 <= ttl_seconds // _DAY <= 365:
        raise CompatibilityError("Morph: snapshot ttl_seconds other than whole days from 1 to 365 "
                                 "(86400 to 31536000); Runtime keeps a snapshot for whole days")
    return ttl_seconds // _DAY


def _image(image_id: typing.Optional[str]) -> typing.Optional[str]:
    """A Runtime image for a Morph image id: Morph's base image is Runtime's
    default; any other id is a Runtime image (id, name, name:tag)."""
    if image_id is None or image_id == MORPH_DEFAULT_IMAGE:
        return None
    if image_id.startswith("morphvm-"):
        raise CompatibilityError(f"Morph: image {image_id}; build it as a Runtime image "
                                 "(withruntime.Runtime().images) and pass its name")
    return image_id


def _runtime_url(base_url: typing.Optional[str]) -> typing.Optional[str]:
    if base_url is None:
        return None
    host = urlparse(base_url).hostname or ""
    if host != "withruntime.com" and not host.endswith(".withruntime.com") and host not in (
            "localhost", "127.0.0.1", "::1"):
        raise CompatibilityError("Morph: a Morph API endpoint; leave base_url out (Runtime's is used) "
                                 "or pass runtime=withruntime.Runtime(...)")
    return base_url


def _service(name: str, port: int, auth_mode: typing.Optional[str]) -> str:
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
        raise ValueError("name must be 1 to 64 letters, digits, dashes or underscores")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65_535:
        raise ValueError("port must be 1 to 65535")
    if auth_mode not in (None, "none", "api_key"):
        raise CompatibilityError(f"Morph: auth_mode {auth_mode}")
    return "private" if auth_mode == "api_key" else "public"


def _argv(command: typing.Union[str, typing.List[str]]) -> typing.Union[str, typing.List[str]]:
    """A string, or a one-item list, runs in a shell; a longer list runs as its arguments."""
    argv = [command] if isinstance(command, str) else command
    if not isinstance(argv, (list, tuple)) or not argv or any(not isinstance(a, str) for a in argv):
        raise TypeError("command must be a string or a nonempty list of strings")
    return argv[0] if len(argv) == 1 else list(argv)


def _exec_timeout_ms(timeout: typing.Optional[float]) -> int:
    """Morph waits for ever without one; Runtime's longest command is a day."""
    if timeout is None:
        return _DAY * 1000
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= _DAY:
        raise ValueError("timeout must be more than 0 and at most 86400 seconds")
    return int(timeout * 1000 + 0.999)


def _quiet(callback: typing.Optional[typing.Callable[[str], None]]):
    """Morph ignores an exception from an output callback."""
    if callback is None:
        return None

    def call(text: str) -> None:
        try:
            callback(text)
        except Exception:  # noqa: BLE001 - as Morph's streaming exec does
            pass
    return call


def _exec_response(result: typing.Any, timeout: typing.Optional[float]) -> InstanceExecResponse:
    if result.timed_out:
        raise builtins.TimeoutError(f"Command execution timed out after {timeout} seconds")
    return InstanceExecResponse(exit_code=-1 if result.exit_code is None else result.exit_code,
                                stdout=result.stdout, stderr=result.stderr)


def _auto_wake(wake_on_ssh: typing.Optional[bool], wake_on_http: typing.Optional[bool]) -> typing.Optional[bool]:
    """Runtime wakes a paused sandbox on any request (an API call, SSH, a
    visit to a preview) or on none: both values must agree."""
    if wake_on_ssh is None and wake_on_http is None:
        return None
    if wake_on_ssh is not None and wake_on_http is not None and wake_on_ssh != wake_on_http:
        raise CompatibilityError("Morph: different wake_on_ssh and wake_on_http; Runtime's auto_wake covers "
                                 "every kind of request")
    return bool(wake_on_ssh if wake_on_ssh is not None else wake_on_http)


def _extension(info: dict[str, typing.Any], ttl_seconds: typing.Optional[int],
               ttl_action: typing.Optional[str]) -> int:
    """Morph's set_ttl moves the end to now + ttl_seconds. Runtime moves a
    time limit later (up to a day ahead), never earlier, and sets one only at create."""
    alternative = "give ttl_seconds and ttl_action to instances.start or boot"
    if not info.get("timeoutSeconds") or not info.get("endsAt"):
        raise CompatibilityError(f"Morph: set_ttl on an instance started without ttl_seconds; {alternative}")
    if ttl_seconds is None:
        raise CompatibilityError(f"Morph: set_ttl(None), which removes a time limit; {alternative}")
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) or not 0 < ttl_seconds <= _DAY:
        raise CompatibilityError("Morph: set_ttl beyond 86400 seconds from now (Runtime's longest extension)")
    action = "pause" if info.get("onTimeout", info.get("onLeaseEnd")) == "pause" else "stop"
    if ttl_action is not None and ttl_action != action:
        raise CompatibilityError(f"Morph: set_ttl with ttl_action {ttl_action} on an instance whose limit "
                                 f"ends with {action}; {alternative}")
    later = int(time.time()) + ttl_seconds - _seconds(info["endsAt"])
    if later < 0:
        raise CompatibilityError("Morph: set_ttl to an earlier end; Runtime moves a time limit only later")
    return later


def _page(items: list, page: int, limit: int) -> dict[str, typing.Any]:
    if page < 1 or limit < 1:
        raise ValueError("page and limit must be at least 1")
    pages = max(1, -(-len(items) // limit))
    chunk = items[(page - 1) * limit:page * limit]
    return {"total": len(items), "page": page, "size": len(chunk), "total_pages": pages,
            "has_next": page < pages, "has_prev": page > 1}


def _check_count(count: int) -> None:
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise ValueError("count must be a positive integer")


def _check_upload(local_path: str, recursive: bool) -> None:
    if recursive:
        if os.path.isfile(local_path):
            raise ValueError("Cannot recursively upload a single file without a directory.")
        if not os.path.exists(local_path):
            raise ValueError(f"Local path does not exist: {os.path.abspath(local_path)}")
    elif os.path.isdir(local_path):
        raise ValueError(f"Source '{os.path.abspath(local_path)}' is a directory. Use --recursive.")
    elif not os.path.exists(local_path):
        raise ValueError(f"Local file not found: {os.path.abspath(local_path)}")


def _check_download(entry: dict[str, typing.Any], remote_path: str, recursive: bool) -> None:
    if not recursive and entry.get("type") == "directory":
        raise ValueError(f"Remote source '{remote_path}' is a directory. Use --recursive.")


def _cleanup_action(action: str) -> None:
    if action not in ("stop", "pause"):
        raise ValueError(f"Invalid action '{action}'. Must be one of: ['stop', 'pause']")


def _previews(sandbox: _Sandbox) -> list[dict[str, typing.Any]]:
    if not any(key.startswith(_HTTP_LABEL) for key in _labels(sandbox.info)):
        return []
    return sandbox.previews.list()


# Client -----------------------------------------------------------------------------


class MorphCloudClient:
    """Morph's client, on Runtime. ``MorphCloudClient()`` reads
    ``RUNTIME_API_KEY`` (or a saved ``runtime login``), never
    ``MORPH_API_KEY``; ``runtime=`` takes a ``withruntime.Runtime`` client."""

    def __init__(self, api_key: typing.Optional[str] = None, base_url: typing.Optional[str] = None,
                 profile: typing.Optional[str] = None, api_host: typing.Optional[str] = None,
                 service_base_url: typing.Optional[str] = None, volumes_base_url: typing.Optional[str] = None,
                 volumes_service_api_key: typing.Optional[str] = None, admin_base_url: typing.Optional[str] = None,
                 db_base_url: typing.Optional[str] = None, simple_index_base_url: typing.Optional[str] = None,
                 ssh_hostname: typing.Optional[str] = None, ssh_port: typing.Optional[int] = None,
                 devbox_base_url: typing.Optional[str] = None, *, runtime: typing.Optional[Runtime] = None):
        if any(value is not None for value in (profile, api_host, service_base_url, volumes_base_url,
                                               volumes_service_api_key, admin_base_url, db_base_url,
                                               simple_index_base_url, ssh_hostname, ssh_port, devbox_base_url)):
            raise CompatibilityError("Morph: profile, Morph's service endpoints and SSH gateway; leave them out "
                                     "(Runtime's endpoint is used) or pass runtime=withruntime.Runtime(...)")
        url = _runtime_url(base_url)
        self.runtime = runtime or Runtime(api_key=runtime_key(api_key), base_url=url)
        self.base_url = self.runtime._t.base_url
        # Runtime's key stays inside its client.
        self.api_key = ""
        self._instances = InstanceAPI(self)
        self._snapshots = SnapshotAPI(self)
        self._images = ImageAPI(self)

    @property
    def instances(self) -> InstanceAPI:
        return self._instances

    @property
    def snapshots(self) -> SnapshotAPI:
        return self._snapshots

    @property
    def images(self) -> ImageAPI:
        return self._images

    @property
    def devbox(self) -> typing.Any:
        raise CompatibilityError("Morph: devboxes are not a Runtime product; a sandbox created with "
                                 "persistent=True, or found by name with sandboxes.get_or_create, keeps its machine")

    @devbox.setter
    def devbox(self, value: typing.Any) -> None:
        raise CompatibilityError("Morph: devboxes are not a Runtime product")

    @property
    def devbox_async(self) -> typing.Any:
        raise CompatibilityError("Morph: devboxes are not a Runtime product; a sandbox created with "
                                 "persistent=True, or found by name with sandboxes.get_or_create, keeps its machine")

    @devbox_async.setter
    def devbox_async(self, value: typing.Any) -> None:
        raise CompatibilityError("Morph: devboxes are not a Runtime product")

    @property
    def computers(self) -> typing.Any:
        """Deprecated: Computer API has been removed."""
        raise AttributeError("The Computer API has been removed from the SDK.")

    @property
    def user(self) -> typing.Any:
        raise CompatibilityError("Morph: the account's API keys, secrets and SSH keys; manage keys in Runtime's "
                                 "console, secrets with withruntime.Runtime().secrets")

    @property
    def volumes(self) -> typing.Any:
        raise CompatibilityError("Morph: Morph volumes; use withruntime.Runtime().volumes and "
                                 "sandboxes.create(volumes=[...])")

    @volumes.setter
    def volumes(self, value: typing.Any) -> None:
        raise CompatibilityError("Morph: Morph volumes; use withruntime.Runtime().volumes")

    @property
    def simple_index(self) -> typing.Any:
        raise CompatibilityError("Morph: Morph's package index; install packages in the sandbox, or build them "
                                 "into a Runtime image")

    @simple_index.setter
    def simple_index(self, value: typing.Any) -> None:
        raise CompatibilityError("Morph: Morph's package index")


UserAPI = refused("Morph", "UserAPI", "manage API keys in Runtime's console, secrets with "
                  "withruntime.Runtime().secrets, and reach a sandbox with `runtime sandboxes ssh <id>`")


class BaseAPI:
    def __init__(self, client: MorphCloudClient):
        self._client = client


# Images -----------------------------------------------------------------------------


class ImageAPI(BaseAPI):
    def list(self) -> typing.List[Image]:
        """Morph's base image, which is Runtime's default image. Build others
        with withruntime.Runtime().images and pass their names as image_id."""
        return [Image(id=MORPH_DEFAULT_IMAGE, name=MORPH_DEFAULT_IMAGE, description="Runtime's default image",
                      disk_size=4096 * 1024 * 1024, created=0)]

    async def alist(self) -> typing.List[Image]:
        return self.list()


# Snapshots --------------------------------------------------------------------------


class SnapshotAPI:
    def __init__(self, client: MorphCloudClient):
        self._client = client

    @dataclass
    class ListPaginatedResponse(_Model):
        snapshots: typing.List["Snapshot"]
        total: int
        page: int
        size: int
        total_pages: int
        has_next: bool
        has_prev: bool

    def list(self, digest: typing.Optional[str] = None,
             metadata: typing.Optional[typing.Dict[str, str]] = None) -> typing.List[Snapshot]:
        """Snapshots made with this digest, whose metadata all match."""
        want = {k: str(v) for k, v in (metadata or {}).items()}
        found = []
        with _api():
            for native in self._client.runtime.snapshots.list(**({"name": _digest_name(digest)} if digest else {})):
                if native.get("state") in ("deleting", "failed"):
                    continue
                labels = _labels(native)
                if digest and labels.get(_DIGEST_LABEL) != digest:
                    continue
                if any(labels.get(k) != v for k, v in want.items()):
                    continue
                found.append(Snapshot(native, self))
        return found

    def list_paginated(self, page: int = 1, limit: int = 50, *, digest: typing.Optional[str] = None,
                       metadata: typing.Optional[typing.Dict[str, str]] = None) -> "SnapshotAPI.ListPaginatedResponse":
        everything = self.list(digest=digest, metadata=metadata)
        shape = _page(everything, page, limit)
        return SnapshotAPI.ListPaginatedResponse(snapshots=everything[(page - 1) * limit:page * limit], **shape)

    async def alist(self, digest: typing.Optional[str] = None,
                    metadata: typing.Optional[typing.Dict[str, str]] = None) -> typing.List[Snapshot]:
        return await asyncio.to_thread(self.list, digest, metadata)

    def create(self, image_id: typing.Optional[str] = None, vcpus: typing.Optional[int] = None,
               memory: typing.Optional[int] = None, disk_size: typing.Optional[int] = None,
               digest: typing.Optional[str] = None, metadata: typing.Optional[typing.Dict[str, str]] = None,
               ttl_seconds: typing.Optional[int] = None) -> Snapshot:
        """A bootable snapshot of an image at a size (memory and disk_size in
        MiB): Runtime boots a sandbox from the image, keeps its disk and
        deletes the sandbox. With a digest, a snapshot already made with it is
        answered instead."""
        days = _retention_days(ttl_seconds)
        metadata = _check_metadata(metadata)
        if digest:
            cached = self.list(digest=digest)
            if cached:
                return cached[0]
        image = _image(image_id)
        sizes = {"image": image, "vcpu": vcpus, "memory_mib": memory, "disk_mib": disk_size}
        with _api():
            sandbox = self._client.runtime.sandboxes.create(
                labels={"compat.provider": PROVIDER}, **{k: v for k, v in sizes.items() if v is not None})
            try:
                native = sandbox.snapshot(
                    mode="disk", retention_days=days, name=_digest_name(digest) if digest else None,
                    labels={**metadata, _IMAGE_LABEL: image_id or MORPH_DEFAULT_IMAGE,
                            **({_DIGEST_LABEL: digest} if digest else {})})
            finally:
                # The snapshot stays when its source is deleted.
                sandbox.delete()
        return Snapshot(native, self)

    async def acreate(self, image_id: typing.Optional[str] = None, vcpus: typing.Optional[int] = None,
                      memory: typing.Optional[int] = None, disk_size: typing.Optional[int] = None,
                      digest: typing.Optional[str] = None, metadata: typing.Optional[typing.Dict[str, str]] = None,
                      ttl_seconds: typing.Optional[int] = None) -> Snapshot:
        return await asyncio.to_thread(self.create, image_id, vcpus, memory, disk_size, digest, metadata,
                                       ttl_seconds)

    def get(self, snapshot_id: str) -> Snapshot:
        with _api():
            return Snapshot(self._client.runtime.snapshots.get(snapshot_id), self)

    async def aget(self, snapshot_id: str) -> Snapshot:
        return await asyncio.to_thread(self.get, snapshot_id)


class Snapshot(_Model):
    id: str
    object: str
    created: int
    status: SnapshotStatus
    spec: ResourceSpec
    refs: SnapshotRefs
    digest: typing.Optional[str]
    metadata: typing.Dict[str, str]
    ttl: SnapshotTTL

    def __init__(self, native: dict[str, typing.Any], api: SnapshotAPI):
        self._api = api
        self._load(native)

    def _load(self, native: dict[str, typing.Any]) -> None:
        #: The Runtime snapshot behind it, as the API answered it.
        self.native = native
        labels = _labels(native)
        shape = native.get("shape") or {}
        self.id = native["id"]
        self.object = "snapshot"
        self.created = _seconds(native.get("createdAt"))
        self.status = _snapshot_status(native.get("state", "ready"))
        self.spec = ResourceSpec(vcpus=shape.get("vcpu", 0), memory=shape.get("memoryMiB", 0),
                                 disk_size=shape.get("diskMiB", 0))
        self.refs = SnapshotRefs(image_id=labels.get(_IMAGE_LABEL, MORPH_DEFAULT_IMAGE))
        self.digest = labels.get(_DIGEST_LABEL)
        self.metadata = _metadata_of(labels)
        days = native.get("retentionDays")
        self.ttl = SnapshotTTL(ttl_seconds=days * _DAY if days else None,
                               ttl_expire_at=_seconds(native.get("expiresAt")) or None)

    def __repr__(self) -> str:
        return f"Snapshot(id={self.id!r}, status={self.status!r}, digest={self.digest!r})"

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Snapshot) and self.model_dump() == other.model_dump()

    def _refresh(self) -> None:
        with _api():
            self._load(self._api._client.runtime.snapshots.get(self.id))

    def delete(self) -> None:
        with _api():
            self._api._client.runtime.snapshots.delete(self.id)

    async def adelete(self) -> None:
        await asyncio.to_thread(self.delete)

    def set_metadata(self, metadata: typing.Dict[str, str]) -> None:
        """Replaces the snapshot's metadata, as Morph's does: to keep the
        rest, pass ``{**snapshot.metadata, **changes}``."""
        metadata = _check_metadata(metadata)
        kept = {k: v for k, v in _labels(self.native).items() if _reserved(k)}
        with _api():
            self._load(self._api._client.runtime.snapshots.update(self.id, labels={**kept, **metadata}))

    async def aset_metadata(self, metadata: typing.Dict[str, str]) -> None:
        await asyncio.to_thread(self.set_metadata, metadata)

    def set_ttl(self, ttl_seconds: typing.Optional[int]) -> None:
        """Keeps it ttl_seconds from now, in whole days (1 to 365); None
        keeps it while the account has credit, up to a year from when it was taken."""
        days = _retention_days(ttl_seconds)
        with _api():
            self._load(self._api._client.runtime.snapshots.extend(self.id, days))

    async def aset_ttl(self, ttl_seconds: typing.Optional[int]) -> None:
        await asyncio.to_thread(self.set_ttl, ttl_seconds)

    def wait_until_ready(self, timeout: typing.Optional[float] = None) -> None:
        """Wait until the snapshot is ready."""
        until = math.inf if timeout is None else time.time() + timeout
        while self.status != SnapshotStatus.READY:
            if time.time() > until:
                raise builtins.TimeoutError("Snapshot did not become ready before timeout")
            time.sleep(0.5)
            self._refresh()
            if self.status == SnapshotStatus.FAILED:
                raise builtins.RuntimeError("Snapshot creation failed / encountered an error")

    async def await_until_ready(self, timeout: typing.Optional[float] = None) -> None:
        await asyncio.to_thread(self.wait_until_ready, timeout)

    @staticmethod
    def compute_chain_hash(parent_chain_hash: str, effect_identifier: str) -> str:
        """Morph's chain hash: SHA-256 of the parent's hash, a newline and the effect."""
        hasher = hashlib.sha256()
        hasher.update(parent_chain_hash.encode("utf-8"))
        hasher.update(b"\n")
        hasher.update(effect_identifier.encode("utf-8"))
        return hasher.hexdigest()

    def _run_command_effect(self, instance: Instance, command: str, background: bool, get_pty: bool) -> None:
        """Morph's command step: the output streams here as it comes, and a
        failing command raises. A background one is left running."""
        if background:
            with _api():
                instance.native.spawn(command)
            _print(f"Command is running in the background: {command}")
            return
        _print(f"🔧 {command}")
        result = instance.exec(command, on_stdout=lambda text: sys.stdout.write(text),
                               on_stderr=lambda text: sys.stderr.write(text))
        if result.exit_code != 0:
            raise builtins.RuntimeError(f"Command `{command}` failed with exit code {result.exit_code}.")

    def _cache_effect(self, fn: typing.Callable[..., None], *args: typing.Any, **kwargs: typing.Any) -> Snapshot:
        """Morph's cache: the effect's chain hash (its parent's digest or id,
        the function's name and arguments) is the new snapshot's digest. A
        snapshot with it is answered; otherwise a copy of this snapshot runs
        the effect, is snapshotted with that digest and stopped."""
        parent_chain_hash = self.digest or self.id
        new_chain_hash = self.compute_chain_hash(parent_chain_hash, fn.__name__ + str(args) + str(kwargs))
        candidates = self._api.list(digest=new_chain_hash)
        if candidates:
            _print(f"✅ Using cached snapshot with digest {new_chain_hash} for effect {fn.__name__}.")
            return candidates[0]
        _print(f"🚀 Building new snapshot with digest {new_chain_hash}.")
        instance = self._api._client.instances.start(self.id)
        try:
            instance.wait_until_ready(timeout=300)
            fn(instance, *args, **kwargs)
            new_snapshot = instance.snapshot(digest=new_chain_hash)
        finally:
            instance.stop()
        _print(f"🎉 New snapshot created with digest {new_chain_hash}.")
        return new_snapshot

    def setup(self, command: str) -> Snapshot:
        """Runs ``command`` on a copy of this snapshot and snapshots the
        result, once: a later setup of the same command on the same snapshot
        answers the snapshot made the first time."""
        return self._cache_effect(fn=self._run_command_effect, command=command, background=False, get_pty=True)

    def exec(self, command: str) -> Snapshot:
        return self.setup(command)

    async def aexec(self, command: str) -> Snapshot:
        return await self.asetup(command)

    async def asetup(self, command: str) -> Snapshot:
        return await asyncio.to_thread(self.setup, command)

    def upload(self, local_path: str, remote_path: str, recursive: bool = False) -> Snapshot:
        """A copy of this snapshot with the local file or folder in it, made once."""
        def _upload_effect(instance: Instance, local_path, remote_path, recursive):
            instance.upload(local_path, remote_path, recursive=recursive)
        return self._cache_effect(fn=_upload_effect, local_path=local_path, remote_path=remote_path,
                                  recursive=recursive)

    def download(self, remote_path: str, local_path: str, recursive: bool = False) -> Snapshot:
        def _download_effect(instance: Instance, remote_path, local_path, recursive):
            instance.download(remote_path, local_path, recursive=recursive)
        return self._cache_effect(fn=_download_effect, remote_path=remote_path, local_path=local_path,
                                  recursive=recursive)

    async def aupload(self, local_path: str, remote_path: str, recursive: bool = False) -> Snapshot:
        return await asyncio.to_thread(self.upload, local_path, remote_path, recursive)

    async def adownload(self, remote_path: str, local_path: str, recursive: bool = False) -> Snapshot:
        return await asyncio.to_thread(self.download, remote_path, local_path, recursive)

    def as_container(self, image: typing.Optional[str] = None, dockerfile: typing.Optional[str] = None,
                     build_context: typing.Optional[str] = None, container_name: str = "container",
                     container_args: typing.Optional[typing.List[str]] = None,
                     ports: typing.Optional[typing.Dict[int, int]] = None,
                     volumes: typing.Optional[typing.List[str]] = None, env: typing.Optional[typing.Dict[str, str]] = None,
                     restart_policy: str = "unless-stopped") -> Snapshot:
        raise CompatibilityError(f"Morph: as_container; {_CONTAINER}")

    async def aas_container(self, image: typing.Optional[str] = None, dockerfile: typing.Optional[str] = None,
                            build_context: typing.Optional[str] = None, container_name: str = "container",
                            container_args: typing.Optional[typing.List[str]] = None,
                            ports: typing.Optional[typing.Dict[int, int]] = None,
                            volumes: typing.Optional[typing.List[str]] = None,
                            env: typing.Optional[typing.Dict[str, str]] = None,
                            restart_policy: str = "unless-stopped") -> Snapshot:
        raise CompatibilityError(f"Morph: as_container; {_CONTAINER}")

    def _format_step_for_log(self, step: typing.Union[str, typing.Callable[[Instance], None]],
                             max_len: int = 120) -> str:
        if isinstance(step, str):
            s = step.strip().replace("\n", "\\n")
            return f"$ {s[:max_len - 3] + '...' if len(s) > max_len else s}"
        name = getattr(step, "__qualname__", getattr(step, "__name__", repr(step)))
        return f"{getattr(step, '__module__', '')}.{name} (src:{_source_hash(step)[:10]})"

    def _effect_identifier_for_step(self, step: typing.Union[str, typing.Callable[[Instance], None]]) -> str:
        """Morph's identifier for a build step: a shell step's is setup's own,
        so build and setup share their cache."""
        if isinstance(step, str):
            kwargs = {"command": step, "background": False, "get_pty": True}
            return f"{self._run_command_effect.__name__}{str(())}{str(kwargs)}"
        name = getattr(step, "__qualname__", getattr(step, "__name__", repr(step)))
        pseudo_kwargs = {"callable": f"{getattr(step, '__module__', '')}.{name}", "src": _source_hash(step)[:16]}
        return f"{name}{str(())}{str(pseudo_kwargs)}"

    def build(self, steps: typing.List[typing.Union[str, typing.Callable[[Instance], None]]]) -> Snapshot:
        """Runs the steps on one copy of this snapshot, snapshotting after
        each, and reuses the longest prefix of steps already built."""
        if not steps:
            return self
        digests: list[str] = []
        parent = self.digest or self.id
        for step in steps:
            parent = Snapshot.compute_chain_hash(parent, self._effect_identifier_for_step(step))
            digests.append(parent)
        cached_len, last_cached = 0, None
        for digest in digests:
            candidates = self._api.list(digest=digest)
            if not candidates:
                break
            cached_len, last_cached = cached_len + 1, candidates[0]
        if cached_len:
            _print(f"✅ Using cached snapshot through step {cached_len} (digest {digests[cached_len - 1]}).")
        if cached_len == len(steps):
            return typing.cast(Snapshot, last_cached)
        instance = self._api._client.instances.start((last_cached or self).id)
        try:
            instance.wait_until_ready(timeout=300)
            current = last_cached
            for index in range(cached_len, len(steps)):
                step = steps[index]
                _print(f"Step {index + 1}/{len(steps)} → {self._format_step_for_log(step)}")
                if isinstance(step, str):
                    self._run_command_effect(instance, command=step, background=False, get_pty=True)
                else:
                    step(instance)
                current = instance.snapshot(digest=digests[index])
            _print(f"🎉 Build complete → final snapshot {current.id}.")
            return typing.cast(Snapshot, current)
        finally:
            try:
                instance.stop()
            except Exception as error:  # noqa: BLE001 - the build's own result or error is what matters
                _print(f"Warning: failed to stop instance: {error}")

    async def abuild(self, steps: typing.List[typing.Union[str, typing.Callable[[Instance], None]]]) -> Snapshot:
        return await asyncio.to_thread(self.build, steps)


def _source_hash(step: typing.Callable[..., typing.Any]) -> str:
    import inspect
    try:
        return hashlib.sha256(inspect.getsource(step).encode("utf-8")).hexdigest()
    except Exception:  # noqa: BLE001 - Morph's own fallback for a step without source
        return hashlib.sha256(repr(step).encode("utf-8")).hexdigest()


# Instances --------------------------------------------------------------------------


class InstanceAPI(BaseAPI):
    @dataclass
    class ListPaginatedResponse(_Model):
        instances: typing.List["Instance"]
        total: int
        page: int
        size: int
        total_pages: int
        has_next: bool
        has_prev: bool

    def list(self, metadata: typing.Optional[typing.Dict[str, str]] = None) -> typing.List[Instance]:
        """Running and paused instances whose metadata all match."""
        labels = {k: str(v) for k, v in (metadata or {}).items()}
        with _api():
            return [Instance(sandbox, self._client, _previews(sandbox))
                    for sandbox in self._client.runtime.sandboxes.list(**({"labels": labels} if labels else {}))]

    def list_paginated(self, page: int = 1, limit: int = 50, *,
                       metadata: typing.Optional[typing.Dict[str, str]] = None) -> "InstanceAPI.ListPaginatedResponse":
        everything = self.list(metadata=metadata)
        shape = _page(everything, page, limit)
        return InstanceAPI.ListPaginatedResponse(instances=everything[(page - 1) * limit:page * limit], **shape)

    async def alist(self, metadata: typing.Optional[typing.Dict[str, str]] = None) -> typing.List[Instance]:
        return await asyncio.to_thread(self.list, metadata)

    def start(self, snapshot_id: str, metadata: typing.Optional[typing.Dict[str, str]] = None,
              ttl_seconds: typing.Optional[int] = None, ttl_action: typing.Union[None, str] = None,
              timeout: typing.Optional[float] = None) -> Instance:
        """A running copy of a snapshot: files, and memory and processes when
        the snapshot kept them. ``timeout`` is seconds to wait until it runs;
        one that does not run by then is stopped and the error raised."""
        return self._create(snapshot_id, metadata, ttl_seconds, ttl_action, timeout, {})

    def _create(self, snapshot_id: str, metadata: typing.Optional[typing.Dict[str, str]],
                ttl_seconds: typing.Optional[int], ttl_action: typing.Optional[str],
                timeout: typing.Optional[float], sizes: dict[str, typing.Any]) -> Instance:
        metadata = _check_metadata(metadata)
        ttl = _ttl(ttl_seconds, ttl_action)
        runtime = self._client.runtime
        with _api():
            image = _labels(runtime.snapshots.get(snapshot_id)).get(_IMAGE_LABEL)
            sandbox = runtime.sandboxes.create(
                wait=False, snapshot=snapshot_id, **ttl, **sizes,
                labels={**metadata, "compat.provider": PROVIDER, **({_IMAGE_LABEL: image} if image else {})})
        instance = Instance(sandbox, self._client)
        instance.refs.snapshot_id = snapshot_id
        try:
            instance.wait_until_ready(timeout=timeout or None)
        except BaseException:
            instance.stop()
            raise
        return instance

    async def astart(self, snapshot_id: str, metadata: typing.Optional[typing.Dict[str, str]] = None,
                     ttl_seconds: typing.Optional[int] = None, ttl_action: typing.Union[None, str] = None,
                     timeout: typing.Optional[float] = None) -> Instance:
        return await asyncio.to_thread(self.start, snapshot_id, metadata, ttl_seconds, ttl_action, timeout)

    def get(self, instance_id: str) -> Instance:
        with _api():
            sandbox = self._client.runtime.sandboxes.get(instance_id)
            return Instance(sandbox, self._client, _previews(sandbox))

    async def aget(self, instance_id: str) -> Instance:
        return await asyncio.to_thread(self.get, instance_id)

    def stop(self, instance_id: str) -> None:
        """Deletes it, with its disk and memory, as Morph's stop does; its snapshots stay."""
        with _api():
            self._client.runtime.sandboxes.delete(instance_id)

    async def astop(self, instance_id: str) -> None:
        await asyncio.to_thread(self.stop, instance_id)

    def reboot(self, instance_id: str, *, vcpus: typing.Optional[int] = None, memory: typing.Optional[int] = None,
               disk_size: typing.Optional[int] = None, metadata: typing.Optional[typing.Dict[str, str]] = None,
               ttl_seconds: typing.Optional[int] = None, ttl_action: typing.Union[None, str] = None) -> Instance:
        raise CompatibilityError(f"Morph: reboot; {_REBOOT}")

    async def areboot(self, instance_id: str, *, vcpus: typing.Optional[int] = None,
                      memory: typing.Optional[int] = None, disk_size: typing.Optional[int] = None,
                      metadata: typing.Optional[typing.Dict[str, str]] = None, ttl_seconds: typing.Optional[int] = None,
                      ttl_action: typing.Union[None, str] = None) -> Instance:
        raise CompatibilityError(f"Morph: reboot; {_REBOOT}")

    def boot(self, snapshot_id: str, vcpus: typing.Optional[int] = None, memory: typing.Optional[int] = None,
             disk_size: typing.Optional[int] = None, metadata: typing.Optional[typing.Dict[str, str]] = None,
             ttl_seconds: typing.Optional[int] = None, ttl_action: typing.Union[None, str] = None) -> Instance:
        """As start, at another size (memory and disk_size in MiB). A disk
        snapshot (``snapshots.create``) boots fresh at any size, its disk at
        least the saved one. A copy of a running machine keeps its disk's size
        and restarts its programs at another vCPU or memory size."""
        with _api():
            mode = self._client.runtime.snapshots.get(snapshot_id).get("mode")
        sizes = {"vcpu": vcpus, "memory_mib": memory, "disk_mib": disk_size}
        if mode == "disk":
            return self._create(snapshot_id, metadata, ttl_seconds, ttl_action, None,
                                {k: v for k, v in sizes.items() if v is not None})
        instance = self.start(snapshot_id, metadata=metadata, ttl_seconds=ttl_seconds, ttl_action=ttl_action)
        try:
            resize = _resize(instance.spec, vcpus, memory, disk_size)
            if not resize:
                return instance
            with _api():
                sandbox = instance.native.resize(**resize)
        except BaseException:
            instance.stop()
            raise
        resized = Instance(sandbox, self._client)
        resized.refs.snapshot_id = snapshot_id
        return resized

    async def aboot(self, snapshot_id: str, vcpus: typing.Optional[int] = None, memory: typing.Optional[int] = None,
                    disk_size: typing.Optional[int] = None, metadata: typing.Optional[typing.Dict[str, str]] = None,
                    ttl_seconds: typing.Optional[int] = None, ttl_action: typing.Union[None, str] = None) -> Instance:
        return await asyncio.to_thread(self.boot, snapshot_id, vcpus, memory, disk_size, metadata, ttl_seconds,
                                       ttl_action)

    def cleanup(self, snapshot_pattern: typing.Optional[str] = None,
                snapshot_exclude_pattern: typing.Optional[str] = None, service_pattern: typing.Optional[str] = None,
                service_exclude_pattern: typing.Optional[str] = None, exclude_paused: bool = True,
                action: str = "stop", max_workers: int = 10, confirm: bool = False) -> typing.Dict[str, typing.Any]:
        """Stops (deletes) or pauses the instances the patterns pick, as
        Morph's cleanup does: comma-separated globs over snapshot ids and
        HTTP service names. With confirm, asks on the terminal first."""
        _cleanup_action(action)
        try:
            everything = self.list()
        except Exception as error:  # noqa: BLE001 - Morph answers a failed listing, not raises
            return {"success": False, "error": str(error)}
        if not everything:
            return {"success": True, "total": 0, "processed": 0, "kept": 0, "errors": []}
        chosen = [i for i in everything if _cleanup_picks(i, snapshot_pattern, snapshot_exclude_pattern,
                                                         service_pattern, service_exclude_pattern,
                                                         exclude_paused, action)]
        kept = len(everything) - len(chosen)
        if not chosen:
            return {"success": True, "total": len(everything), "processed": 0, "kept": kept, "errors": []}
        if confirm:
            for instance in chosen:
                _print(f"  {instance.id}  {instance.refs.snapshot_id}  {instance.status.value}")
            answer = input(f"\nDo you want to proceed to {action} {len(chosen)} instances? (y/N): ").lower().strip()
            if answer not in ("y", "yes"):
                return {"success": True, "total": len(everything), "processed": 0, "kept": len(everything),
                        "cancelled": True, "errors": []}
        errors: list[dict[str, str]] = []
        done = 0
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(instance.stop if action == "stop" else instance.pause): instance.id
                       for instance in chosen}
            for future in as_completed(futures):
                try:
                    future.result()
                    done += 1
                except ApiError as error:
                    errors.append({"instance_id": futures[future], "error": f"API Error: {error.status_code}"})
                except Exception as error:  # noqa: BLE001 - reported per instance, the rest go on
                    errors.append({"instance_id": futures[future], "error": f"Unexpected Error: {error}"})
        return {"success": not errors, "total": len(everything), "processed": done, "failed": len(errors),
                "kept": kept, "errors": errors}

    async def acleanup(self, snapshot_pattern: typing.Optional[str] = None,
                       snapshot_exclude_pattern: typing.Optional[str] = None,
                       service_pattern: typing.Optional[str] = None,
                       service_exclude_pattern: typing.Optional[str] = None, exclude_paused: bool = True,
                       action: str = "stop", max_concurrency: int = 10,
                       confirm: bool = False) -> typing.Dict[str, typing.Any]:
        return await asyncio.to_thread(self.cleanup, snapshot_pattern, snapshot_exclude_pattern, service_pattern,
                                       service_exclude_pattern, exclude_paused, action, max_concurrency, confirm)


def _resize(spec: ResourceSpec, vcpus: typing.Optional[int], memory: typing.Optional[int],
            disk_size: typing.Optional[int]) -> dict[str, int]:
    if disk_size is not None and disk_size != spec.disk_size:
        raise CompatibilityError("Morph: boot of a running machine's snapshot at another disk_size; boot a "
                                 "snapshots.create snapshot, or snapshot a sandbox created with that disk_mib")
    resize = {}
    if vcpus is not None and vcpus != spec.vcpus:
        resize["vcpu"] = vcpus
    if memory is not None and memory != spec.memory:
        resize["memory_mib"] = memory
    return resize


def _matches(value: str, patterns: typing.Optional[str]) -> bool:
    return bool(patterns) and any(fnmatch.fnmatch(value, p.strip()) for p in typing.cast(str, patterns).split(","))


def _cleanup_picks(instance: Instance, snapshot_pattern, snapshot_exclude_pattern, service_pattern,
                   service_exclude_pattern, exclude_paused: bool, action: str) -> bool:
    """Morph's cleanup filter, rule for rule."""
    picked = instance.status in ((InstanceStatus.READY, InstanceStatus.PAUSED) if action == "stop"
                                 else (InstanceStatus.READY,))
    if exclude_paused and instance.status == InstanceStatus.PAUSED:
        picked = False
    snapshot_id = instance.refs.snapshot_id
    if snapshot_pattern and not _matches(snapshot_id, snapshot_pattern):
        picked = False
    if snapshot_exclude_pattern and _matches(snapshot_id, snapshot_exclude_pattern):
        picked = False
    if service_pattern or service_exclude_pattern:
        names = {service.name for service in instance.networking.http_services}
        keep_match = any(_matches(name, service_pattern) for name in names)
        exclude_match = any(_matches(name, service_exclude_pattern) for name in names)
        if service_pattern and keep_match:
            pass
        elif service_exclude_pattern and exclude_match:
            picked = False
        elif service_pattern and not keep_match:
            picked = False
    return picked


class Instance(_Model):
    id: str
    object: str
    created: int
    status: InstanceStatus
    spec: ResourceSpec
    refs: InstanceRefs
    networking: InstanceNetworking
    ttl: TTL
    wake_on: WakeOn
    metadata: typing.Dict[str, str]

    def __init__(self, sandbox: _Sandbox, client: MorphCloudClient,
                 previews: typing.Optional[list[dict[str, typing.Any]]] = None):
        self._client = client
        self._api = client.instances
        info = sandbox.info
        self.id = sandbox.id
        self.object = "instance"
        self.created = _seconds(info.get("createdAt"))
        self.spec = ResourceSpec(vcpus=info.get("vcpu", 0), memory=info.get("memoryMiB", 0),
                                 disk_size=info.get("diskMiB", 0))
        snapshot_id = info.get("snapshotId") or info.get("sourceSnapshotId")
        self.refs = InstanceRefs(snapshot_id=snapshot_id if isinstance(snapshot_id, str) else "",
                                 image_id=_labels(info).get(_IMAGE_LABEL, MORPH_DEFAULT_IMAGE))
        self._update(sandbox, previews or [])

    def _update(self, sandbox: _Sandbox, previews: list[dict[str, typing.Any]]) -> None:
        self._native = sandbox
        info = sandbox.info
        labels = _labels(info)
        self.status = _status(info.get("state", ""))
        self.metadata = _metadata_of(labels)
        by_port = {p.get("port"): p for p in previews}
        services = []
        for key, value in labels.items():
            preview = by_port.get(int(value)) if key.startswith(_HTTP_LABEL) and value.isdigit() else None
            if preview:
                services.append(InstanceHttpService(name=key[len(_HTTP_LABEL):], port=preview["port"],
                                                    url=preview["url"]))
        self.networking = InstanceNetworking(http_services=services)
        self.ttl = (TTL(ttl_seconds=info["timeoutSeconds"],
                        ttl_expire_at=_seconds(info.get("endsAt")) or None,
                        ttl_action="pause" if info.get("onTimeout", info.get("onLeaseEnd")) == "pause" else "stop")
                    if info.get("timeoutSeconds") else TTL(ttl_action=None))
        wake = info.get("autoWake") is not False
        self.wake_on = WakeOn(wake_on_ssh=wake, wake_on_http=wake)

    @property
    def native(self) -> _Sandbox:
        """The Runtime sandbox behind it, for what Morph has no call for."""
        return self._native

    def __repr__(self) -> str:
        return f"Instance(id={self.id!r}, status={self.status!r})"

    def _refresh(self) -> None:
        with _api():
            sandbox = self._client.runtime.sandboxes.get(self.id)
            self._update(sandbox, _previews(sandbox))

    def stop(self) -> None:
        """Deletes it, with its disk and memory, as Morph's stop does; its snapshots stay."""
        self._api.stop(self.id)

    async def astop(self) -> None:
        await asyncio.to_thread(self.stop)

    def pause(self) -> None:
        """Keeps memory and disk, and stops compute charges."""
        with _api():
            self._native.pause()
        self._refresh()

    async def apause(self) -> None:
        await asyncio.to_thread(self.pause)

    def resume(self) -> None:
        with _api():
            self._native.wake()
        self._refresh()

    async def aresume(self) -> None:
        await asyncio.to_thread(self.resume)

    def snapshot(self, digest: typing.Optional[str] = None, metadata: typing.Optional[typing.Dict[str, str]] = None,
                 ttl_seconds: typing.Optional[int] = None) -> Snapshot:
        """Files, memory and running processes; a running instance pauses
        for the moment it takes, then runs on. ttl_seconds is whole days."""
        days = _retention_days(ttl_seconds)
        metadata = _check_metadata(metadata)
        with _api():
            native = self._native.snapshot(
                name=_digest_name(digest) if digest else None, retention_days=days,
                labels={**metadata, _IMAGE_LABEL: self.refs.image_id, **({_DIGEST_LABEL: digest} if digest else {})})
        return Snapshot(native, self._client.snapshots)

    async def asnapshot(self, digest: typing.Optional[str] = None,
                        metadata: typing.Optional[typing.Dict[str, str]] = None,
                        ttl_seconds: typing.Optional[int] = None) -> Snapshot:
        return await asyncio.to_thread(self.snapshot, digest, metadata, ttl_seconds)

    def reboot(self, *, vcpus: typing.Optional[int] = None, memory: typing.Optional[int] = None,
               disk_size: typing.Optional[int] = None, metadata: typing.Optional[typing.Dict[str, str]] = None,
               ttl_seconds: typing.Optional[int] = None, ttl_action: typing.Union[None, str] = None) -> None:
        raise CompatibilityError(f"Morph: reboot; {_REBOOT}")

    async def areboot(self, *, vcpus: typing.Optional[int] = None, memory: typing.Optional[int] = None,
                      disk_size: typing.Optional[int] = None, metadata: typing.Optional[typing.Dict[str, str]] = None,
                      ttl_seconds: typing.Optional[int] = None, ttl_action: typing.Union[None, str] = None) -> None:
        raise CompatibilityError(f"Morph: reboot; {_REBOOT}")

    def branch(self, count: int) -> typing.Tuple[Snapshot, typing.List[Instance]]:
        """``count`` running copies, with its files, memory and processes,
        and the snapshot they were started from, which is kept."""
        t = self._native._t
        _check_count(count)
        with _api():
            reply = t.json("POST", f"/v1/sandboxes/{self.id}:fork", body={"count": count, "keepSnapshot": True},
                           wait=60)
        if not reply.get("snapshot"):
            raise builtins.RuntimeError("Runtime did not keep the branch's snapshot")
        snapshot = Snapshot(reply["snapshot"], self._client.snapshots)
        instances = [Instance(_Sandbox(t, info), self._client) for info in reply["sandboxes"]]
        for instance in instances:
            instance.refs.snapshot_id = snapshot.id
        return snapshot, instances

    async def abranch(self, count: int) -> typing.Tuple[Snapshot, typing.List[Instance]]:
        return await asyncio.to_thread(self.branch, count)

    def expose_http_service(self, name: str, port: int, auth_mode: typing.Optional[str] = None) -> str:
        """Shares ``port`` at an HTTPS address and answers it. With no
        auth_mode anyone with the address reaches it (Runtime's public
        preview, which needs a kept top-up); with ``"api_key"`` a request needs
        the preview's token in ``x-runtime-preview-token``
        (``instance.native.previews.get(port)``)."""
        visibility = _service(name, port, auth_mode)
        with _api():
            preview = self._native.previews.create(port, visibility=visibility)
            self._native.update(labels={**_labels(self._native.info), f"{_HTTP_LABEL}{name}": str(port)})
        self._refresh()
        return preview["url"]

    async def aexpose_http_service(self, name: str, port: int, auth_mode: typing.Optional[str] = None) -> str:
        return await asyncio.to_thread(self.expose_http_service, name, port, auth_mode)

    def hide_http_service(self, name: str) -> None:
        labels = _labels(self._native.info)
        port = labels.pop(f"{_HTTP_LABEL}{name}", None)
        if port is None:
            raise _api_error("not_found", 404, f"HTTP service {name} not found")
        with _api():
            if not any(k.startswith(_HTTP_LABEL) and v == port for k, v in labels.items()):
                self._native.previews.delete(int(port))
            self._native.update(labels=labels)
        self._refresh()

    async def ahide_http_service(self, name: str) -> None:
        await asyncio.to_thread(self.hide_http_service, name)

    def exec(self, command: typing.Union[str, typing.List[str]], timeout: typing.Optional[float] = None,
             on_stdout: typing.Optional[typing.Callable[[str], None]] = None,
             on_stderr: typing.Optional[typing.Callable[[str], None]] = None) -> InstanceExecResponse:
        """A string, or a one-item list, runs in a shell; a longer list runs
        as its arguments. Output streams to on_stdout and on_stderr as it
        comes. Without a timeout it may run a day; a timeout raises TimeoutError."""
        argv = _argv(command)
        with _api():
            result = self._native.exec(argv, timeout_ms=_exec_timeout_ms(timeout), on_stdout=_quiet(on_stdout),
                                       on_stderr=_quiet(on_stderr))
        return _exec_response(result, timeout)

    async def aexec(self, command: typing.Union[str, typing.List[str]], timeout: typing.Optional[float] = None,
                    on_stdout: typing.Optional[typing.Callable[[str], None]] = None,
                    on_stderr: typing.Optional[typing.Callable[[str], None]] = None) -> InstanceExecResponse:
        return await asyncio.to_thread(self.exec, command, timeout, on_stdout, on_stderr)

    def wait_until_ready(self, timeout: typing.Optional[float] = None) -> None:
        """Waits until it runs, waking it if paused."""
        until = math.inf if timeout is None else time.time() + timeout
        self._refresh()
        if self.status == InstanceStatus.PAUSED:
            self.resume()
        while self.status != InstanceStatus.READY:
            if self.status == InstanceStatus.ERROR:
                raise builtins.RuntimeError("Instance encountered an error")
            if time.time() > until:
                raise builtins.TimeoutError("Instance did not become ready before timeout")
            time.sleep(0.25)
            self._refresh()

    async def await_until_ready(self, timeout: typing.Optional[float] = None) -> None:
        await asyncio.to_thread(self.wait_until_ready, timeout)

    def set_metadata(self, metadata: typing.Dict[str, str]) -> None:
        """Adds or changes these metadata keys; the others stay."""
        metadata = _check_metadata(metadata)
        with _api():
            self._native.update(labels={**_labels(self._native.info), **metadata})
        self._refresh()

    async def aset_metadata(self, metadata: typing.Dict[str, str]) -> None:
        await asyncio.to_thread(self.set_metadata, metadata)

    def set_wake_on(self, wake_on_ssh: typing.Optional[bool] = None,
                    wake_on_http: typing.Optional[bool] = None) -> None:
        """Runtime wakes a paused sandbox on any request (an API call, SSH, a
        visit to a preview) or on none, so the two must agree."""
        auto_wake = _auto_wake(wake_on_ssh, wake_on_http)
        if auto_wake is None:
            return
        with _api():
            self._native.update(auto_wake=auto_wake)
        self._refresh()

    async def aset_wake_on(self, wake_on_ssh: typing.Optional[bool] = None,
                           wake_on_http: typing.Optional[bool] = None) -> None:
        await asyncio.to_thread(self.set_wake_on, wake_on_ssh, wake_on_http)

    def ssh_connect(self) -> typing.Any:
        raise CompatibilityError(f"Morph: ssh_connect; {_SSH}")

    def ssh(self) -> typing.Any:
        raise CompatibilityError(f"Morph: ssh; {_SSH}")

    def upload(self, local_path: str, remote_path: str, recursive: bool = False) -> None:
        """Copies a local file to ``remote_path``, or with recursive a local
        folder's contents into it. Commands run as the user ``runtime`` (with
        sudo), not root: write where it may, such as /workspace or /tmp."""
        _check_upload(local_path, recursive)
        self.wait_until_ready()
        with _api():
            self._native.files.upload(local_path, remote_path)

    def download(self, remote_path: str, local_path: str, recursive: bool = False) -> None:
        """Copies ``remote_path`` to a local file, or with recursive a folder's contents."""
        self.wait_until_ready()
        with _api():
            _check_download(self._native.files.stat(remote_path), remote_path, recursive)
            self._native.files.download(remote_path, local_path)

    async def aupload(self, local_path: str, remote_path: str, recursive: bool = False) -> None:
        await asyncio.to_thread(self.upload, local_path, remote_path, recursive)

    async def adownload(self, remote_path: str, local_path: str, recursive: bool = False) -> None:
        await asyncio.to_thread(self.download, remote_path, local_path, recursive)

    def __enter__(self) -> Instance:
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.stop()

    async def __aenter__(self) -> Instance:
        return self

    async def __aexit__(self, exc_type, exc_value, traceback) -> None:
        await self.astop()

    def as_container(self, image: typing.Optional[str] = None, dockerfile: typing.Optional[str] = None,
                     build_context: typing.Optional[str] = None, container_name: str = "container",
                     container_args: typing.Optional[typing.List[str]] = None,
                     ports: typing.Optional[typing.Dict[int, int]] = None,
                     volumes: typing.Optional[typing.List[str]] = None, env: typing.Optional[typing.Dict[str, str]] = None,
                     restart_policy: str = "unless-stopped") -> None:
        raise CompatibilityError(f"Morph: as_container; {_CONTAINER}")

    async def aas_container(self, image: typing.Optional[str] = None, dockerfile: typing.Optional[str] = None,
                            build_context: typing.Optional[str] = None, container_name: str = "container",
                            container_args: typing.Optional[typing.List[str]] = None,
                            ports: typing.Optional[typing.Dict[int, int]] = None,
                            volumes: typing.Optional[typing.List[str]] = None,
                            env: typing.Optional[typing.Dict[str, str]] = None,
                            restart_policy: str = "unless-stopped") -> None:
        raise CompatibilityError(f"Morph: as_container; {_CONTAINER}")

    def set_ttl(self, ttl_seconds: typing.Optional[int], ttl_action: typing.Optional[str] = None) -> None:
        """Moves the end of the instance's time limit to ttl_seconds from now.
        Runtime sets a time limit at start and moves it only later (up to a
        day ahead); a shorter one, none, or another action raises."""
        later = _extension(self._native.info, ttl_seconds, ttl_action)
        if later:
            with _api():
                self._native.extend(later)
        self._refresh()

    async def aset_ttl(self, ttl_seconds: typing.Optional[int], ttl_action: typing.Optional[str] = None) -> None:
        await asyncio.to_thread(self.set_ttl, ttl_seconds, ttl_action)

    def ssh_key(self) -> InstanceSshKey:
        raise CompatibilityError(f"Morph: ssh_key; {_SSH}")

    async def assh_key(self) -> InstanceSshKey:
        raise CompatibilityError(f"Morph: ssh_key; {_SSH}")

    def ssh_key_rotate(self) -> InstanceSshKey:
        raise CompatibilityError(f"Morph: ssh_key_rotate; {_SSH}")

    async def assh_key_rotate(self) -> InstanceSshKey:
        raise CompatibilityError(f"Morph: ssh_key_rotate; {_SSH}")
