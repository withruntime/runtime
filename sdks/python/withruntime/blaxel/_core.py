"""What the sync and async Blaxel adapters share: Blaxel's errors and models,
and the rules that map a Blaxel call onto Runtime's SDK. Nothing here does
I/O."""
from __future__ import annotations

import json
import math
import os
import re
import time
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from .._errors import RuntimeError as _SDKError

# ---- errors: Blaxel's names --------------------------------------------------


class _Carries:
    """Runtime's ``code``, ``hint`` and ``request_id`` on an error made from a
    Runtime answer."""

    code: Optional[str] = None
    hint: Optional[str] = None
    request_id: Optional[str] = None


class SandboxAPIError(_Carries, Exception):
    """Blaxel's error for a sandbox call (create, get, list, update, delete,
    fork, snapshots, previews): ``status_code`` and ``code``."""

    def __init__(self, message: str, status_code: Optional[int] = None, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class SnapshotAPIError(SandboxAPIError):
    """Blaxel's error for a workspace snapshot call (``Snapshot``)."""


class DriveAPIError(SandboxAPIError):
    pass


class ApplicationAPIError(SandboxAPIError):
    pass


class _Reply:
    """What ``ResponseError.response`` offers of httpx's Response."""

    def __init__(self, status_code: int, data: Any) -> None:
        self.status_code = status_code
        self.reason_phrase = ""
        self.text = json.dumps(data)
        self._data = data

    def json(self) -> Any:
        return self._data


class ResponseError(_Carries, Exception):
    """Blaxel's error for a call inside the sandbox (processes and files).
    ``response.status_code``, ``data`` and ``status_code``."""

    def __init__(self, message: str, status_code: int = 0, code: Optional[str] = None) -> None:
        self.data: Dict[str, Any] = {"error": message, **({"code": code} if code else {})}
        super().__init__(f"Sandbox request failed with status {status_code or 'unknown'}: {message}")
        self.response = _Reply(status_code, self.data)
        self.status_code = status_code
        self.code = code
        self.error = None


class NotSupportedError(SandboxAPIError):
    """A call Blaxel supports and Runtime does not, or not the same way.
    Raised before anything is done. ``feature`` names what was asked;
    ``alternative`` says what to use on Runtime."""

    def __init__(self, feature: str, alternative: str, message: Optional[str] = None) -> None:
        super().__init__(message or f"{feature} is not supported on Runtime. {alternative}", None, "not_supported")
        self.feature = feature
        self.alternative = alternative


_KINDS = {"sandbox": SandboxAPIError, "snapshot": SnapshotAPIError}
_LS = "List the directory with sandbox.fs.ls(path)."
_AGAIN = "Try again in a moment."
BLAXEL_HINTS = {
    "name_taken": "SandboxInstance.create_if_not_exists({\"name\": ...}) answers the sandbox that has the name.",
    "file_not_found": _LS,
    "path_not_found": _LS,
    "is_a_directory": "That path is a directory: list it with sandbox.fs.ls(path), or name a file in it.",
    "cwd_not_found": "Make the directory with sandbox.fs.mkdir(path), or pass an existing working_dir to "
                     "sandbox.process.exec.",
    "sandbox_paused": "Call sandbox.unarchive(), then try again.",
    "not_running": "The sandbox is not running: call sandbox.unarchive() if it was archived, or make a new one with "
                   "SandboxInstance.create if it was deleted.",
    "trial_busy": "The trial's sandboxes are all in use: delete one you no longer need (sandbox.delete()) or archive "
                  "it (sandbox.archive()), then try again. Moving to paid credit is the account owner's decision.",
    "public_preview_not_allowed": "On the trial, share the port privately: sandbox.previews.create({\"metadata\": "
                                  "{\"name\": ...}, \"spec\": {\"port\": ..., \"public\": False}}) and a Runtime "
                                  "duration-based token from sandbox.withruntime.previews.get(port, ttl_seconds=seconds). "
                                  "A public preview needs a paid sandbox, which is the account owner's decision.",
    "busy": _AGAIN,
    "guest_busy": _AGAIN,
    "rate_limited": _AGAIN,
    "unauthorized": "Set RUNTIME_API_KEY to a Runtime key (https://withruntime.com/account/keys), or run "
                    "`npx withruntime login` once. A Blaxel key (BL_API_KEY) is never sent.",
}
"""Runtime's hints that name Runtime's calls, in the Blaxel calls a Blaxel
program makes: the TypeScript adapter's (errors.ts ``BLAXEL_HINTS``), word for
word, with Python's spelling of each call."""
TRIAL_CAP = "A trial sandbox has at most 4096 MB of memory (2 vCPUs); pass memory 4096 or add credit."


def translate(error: BaseException, subject: str = "sandbox") -> BaseException:
    """A Runtime SDK error as the Blaxel error code written for Blaxel
    expects: SandboxAPIError for a sandbox call, SnapshotAPIError for a
    workspace snapshot, ResponseError for a process or a file."""
    if not isinstance(error, _SDKError):
        return error
    hint = BLAXEL_HINTS.get(error.code or "", error.hint)
    if error.code == "invalid_trial":
        parts = [TRIAL_CAP]
        hint = None
    else:
        parts = [error.message]
    if hint:
        parts.append(f"Hint: {hint}")
    if error.code == "missing_api_key" and (os.environ.get("BL_API_KEY") or "").strip():
        parts.append("BL_API_KEY holds a Blaxel key, which is never sent to Runtime.")
    if error.request_id:
        parts.append(f"Request: {error.request_id}")
    message = "\n".join(parts)
    code = error.code or ""
    out: Exception
    if error.status == 503 and code.endswith("_unavailable"):
        out = NotSupportedError(code[: -len("_unavailable")], error.hint or "", message)
    elif subject in _KINDS:
        out = _KINDS[subject](message, error.status or None, code)
    else:
        out = ResponseError(message, error.status, code)
    out.hint, out.request_id = hint, error.request_id  # type: ignore[attr-defined]
    out.__cause__ = error
    return out


class Unset:
    """Blaxel's marker for a field left out. The drop-in's models leave a field
    out as None, so no value is ever Unset."""

    def __bool__(self) -> bool:
        return False


UNSET = Unset()


class Unsupported:
    """A Blaxel export Runtime has no counterpart for: importing it works;
    using it raises NotSupportedError naming the alternative."""

    def __init__(self, feature: str, alternative: str) -> None:
        self._refuse = unsupported(feature, alternative)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._refuse()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return self._refuse()

    def __getitem__(self, key: Any) -> Any:
        return self._refuse()


def unsupported_export(name: str, alternative: str) -> Unsupported:
    return Unsupported(f"Blaxel's {name}", alternative)


_CORE_ALTERNATIVES = {
    "applications": "Run the app in a sandbox and share its port with sandbox.previews.create(...).",
    "jobs": "Run the job as a process in a Runtime sandbox.",
    "functions": "Run the function's server in a sandbox and share its port with sandbox.previews.create(...).",
    "workspaces": "A Runtime account is one workspace; teams share it (withruntime.com/docs/teams).",
}


def core_alternative(kind: str) -> str:
    return _CORE_ALTERNATIVES[kind]


def api_call(name: str) -> Unsupported:
    """One of Blaxel's generated API calls (``module.asyncio`` and the rest)."""
    return Unsupported(f"Blaxel's generated API call {name}",
                       "Use SandboxInstance's methods; to change a sandbox's envs, fork it with envs=[...] or create "
                       "it with them." if name in ("get_sandbox", "update_sandbox") else
                       "Use the drop-in's classes, or the withruntime SDK for what Blaxel's API does here.")


def unsupported(feature: str, alternative: str) -> Callable[..., Any]:
    def refuse(*_: Any, **__: Any) -> Any:
        raise NotSupportedError(feature, alternative)
    return refuse


# ---- models: Blaxel's shapes ------------------------------------------------------


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _camel(name: str) -> str:
    head, *rest = name.rstrip("_").split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


class _Model:
    """A Blaxel model: attributes by snake_case name, ``to_dict()`` in the
    API's camelCase, ``from_dict()`` taking either spelling. Absent fields
    are None (Blaxel's UNSET)."""

    _nested: Dict[str, Any] = {}

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for one in fields(self):  # type: ignore[arg-type]
            value = getattr(self, one.name)
            if value is None:
                continue
            out[_camel(one.name)] = _plain(value)
        return out

    @classmethod
    def from_dict(cls, data: Any) -> Any:
        if data is None or isinstance(data, cls):
            return data
        known = {one.name for one in fields(cls)}  # type: ignore[arg-type]
        values: Dict[str, Any] = {}
        for key, value in dict(data).items():
            name = key if key in known else _snake(key)
            if name not in known and name + "_" in known:
                name += "_"
            if name not in known:
                continue
            nested = cls._nested.get(name)
            if nested is not None and value is not None:
                value = [nested.from_dict(one) for one in value] if isinstance(value, list) else nested.from_dict(value)
            values[name] = value
        return cls(**values)

    def __getitem__(self, key: str) -> Any:
        """Blaxel's generated models also read as ``model["field"]``."""
        return getattr(self, key if hasattr(self, key) else _snake(key))


@dataclass
class PaginationMeta(_Model):
    """Listing metadata; totals stay unknown when Runtime supplies none."""
    has_more: Optional[bool] = None
    next_cursor: Optional[str] = None
    total: Optional[int] = None
    total_is_partial: Optional[bool] = None
    additional_properties: Dict[str, Any] = field(default_factory=dict, init=False)

    def to_dict(self) -> Dict[str, Any]:
        out = dict(self.additional_properties)
        for name in ("has_more", "next_cursor", "total", "total_is_partial"):
            value = getattr(self, name)
            if value is not None and value is not UNSET:
                out[_camel(name)] = value
        return out

    @classmethod
    def from_dict(cls, data: Any) -> Any:
        if not data or isinstance(data, cls):
            return data if isinstance(data, cls) else None
        values = dict(data)
        result = cls(has_more=values.pop("hasMore", values.pop("has_more", None)),
                     next_cursor=values.pop("nextCursor", values.pop("next_cursor", None)),
                     total=values.pop("total", None),
                     total_is_partial=values.pop("totalIsPartial", values.pop("total_is_partial", None)))
        result.additional_properties = values
        return result

    @property
    def additional_keys(self) -> List[str]:
        return list(self.additional_properties)

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties


def _plain(value: Any) -> Any:
    if isinstance(value, _Model):
        return value.to_dict()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, list):
        return [_plain(one) for one in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


class _Named(str, Enum):
    def __str__(self) -> str:
        return str(self.value)


class Status(_Named):
    """A sandbox's deployment status."""

    ARCHIVED = "ARCHIVED"
    ARCHIVING = "ARCHIVING"
    BUILDING = "BUILDING"
    BUILT = "BUILT"
    DEACTIVATED = "DEACTIVATED"
    DEACTIVATING = "DEACTIVATING"
    DELETING = "DELETING"
    DEPLOYED = "DEPLOYED"
    DEPLOYING = "DEPLOYING"
    FAILED = "FAILED"
    TERMINATED = "TERMINATED"
    UNARCHIVING = "UNARCHIVING"
    UPLOADING = "UPLOADING"


class SandboxState(_Named):
    RUNNING = "RUNNING"
    STANDBY = "STANDBY"


class ProcessResponseStatus(_Named):
    COMPLETED = "completed"
    FAILED = "failed"
    KILLED = "killed"
    RUNNING = "running"
    STOPPED = "stopped"


@dataclass
class Port(_Model):
    target: int = 0
    name: Optional[str] = None
    protocol: Optional[str] = None


@dataclass
class Env(_Model):
    name: Optional[str] = None
    value: Optional[str] = None
    secret: Optional[bool] = None


@dataclass
class ExpirationPolicy(_Model):
    type_: Optional[str] = None
    """ttl-idle, ttl-max-age or date."""
    value: Optional[str] = None
    action: Optional[str] = None


@dataclass
class SandboxLifecycle(_Model):
    expiration_policies: Optional[List[ExpirationPolicy]] = None
    terminated_retention: Optional[str] = None
    _nested = {"expiration_policies": ExpirationPolicy}


@dataclass
class SandboxNetwork(_Model):
    allowed_domains: Optional[List[str]] = None
    forbidden_domains: Optional[List[str]] = None
    egress: Any = None
    firewall: Any = None
    proxy: Any = None
    subnet: Optional[str] = None


@dataclass
class VolumeAttachment(_Model):
    name: Optional[str] = None
    mount_path: Optional[str] = None
    read_only: Optional[bool] = None
    type_: Optional[str] = None
    size_mb: Optional[int] = None


@dataclass
class SandboxRuntime(_Model):
    image: Optional[str] = None
    memory: Optional[int] = None
    """MB."""
    ports: Optional[List[Port]] = None
    envs: Optional[List[Env]] = None
    ttl: Optional[str] = None
    expires: Optional[str] = None
    extra_args: Optional[Dict[str, str]] = None
    termination_grace_period_seconds: Optional[int] = None
    _nested = {"ports": Port, "envs": Env}


@dataclass
class SandboxSpec(_Model):
    runtime: Optional[SandboxRuntime] = None
    region: Optional[str] = None
    lifecycle: Optional[SandboxLifecycle] = None
    network: Optional[SandboxNetwork] = None
    volumes: Optional[List[VolumeAttachment]] = None
    enabled: Optional[bool] = True
    vpc: Optional[str] = None
    _nested = {"runtime": SandboxRuntime, "lifecycle": SandboxLifecycle, "network": SandboxNetwork,
               "volumes": VolumeAttachment}


@dataclass
class Metadata(_Model):
    name: Optional[str] = None
    display_name: Optional[str] = None
    external_id: Optional[str] = None
    labels: Optional[Dict[str, str]] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    plan: Optional[str] = None
    url: Optional[str] = None
    """None: a Runtime sandbox has no URL of its own; share a port with previews."""
    workspace: Optional[str] = None


@dataclass
class Sandbox(_Model):
    """A sandbox as Blaxel describes one. ``status`` DEPLOYED with ``state``
    RUNNING or STANDBY while it can run; TERMINATED once deleted."""

    metadata: Optional[Metadata] = None
    spec: Optional[SandboxSpec] = None
    status: Optional[Status] = None
    state: Optional[SandboxState] = None
    last_used_at: Optional[str] = None
    expires_in: Optional[int] = None
    events: Optional[List[Any]] = None
    errors: Optional[List[Any]] = None
    archive: Any = None
    node_generation: Optional[str] = None
    _nested = {"metadata": Metadata, "spec": SandboxSpec}


@dataclass
class ProcessRequest(_Model):
    command: str = ""
    env: Optional[Dict[str, str]] = None
    keep_alive: Optional[bool] = None
    max_restarts: Optional[int] = None
    name: Optional[str] = None
    restart_on_failure: Optional[bool] = None
    stdin: Optional[bool] = None
    timeout: Optional[int] = None
    wait_for_completion: Optional[bool] = None
    wait_for_ports: Optional[List[int]] = None
    working_dir: Optional[str] = None


@dataclass
class ProcessRequestWithLog(ProcessRequest):
    on_log: Optional[Callable[[str], Any]] = None
    on_stdout: Optional[Callable[[str], Any]] = None
    on_stderr: Optional[Callable[[str], Any]] = None


@dataclass
class ProcessResponse(_Model):
    command: str = ""
    completed_at: str = ""
    exit_code: int = 0
    logs: str = ""
    name: str = ""
    pid: str = ""
    """Runtime's process id."""
    started_at: str = ""
    status: ProcessResponseStatus = ProcessResponseStatus.RUNNING
    stderr: str = ""
    stdout: str = ""
    working_dir: str = ""
    keep_alive: Optional[bool] = None
    max_restarts: Optional[int] = None
    restart_count: Optional[int] = None
    restart_on_failure: Optional[bool] = None
    stdin: Optional[bool] = None


class ProcessResponseWithLog:
    """A process started with log callbacks: ``close()`` stops the
    callbacks, not the process."""

    def __init__(self, process_response: ProcessResponse, close_func: Callable[[], None]) -> None:
        self._process_response = process_response
        self._close_func = close_func

    def close(self) -> None:
        self._close_func()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._process_response, name)


@dataclass
class SuccessResponse(_Model):
    message: str = ""
    path: Optional[str] = None


@dataclass
class File(_Model):
    group: str = ""
    """Runtime's listing does not say who owns a file: always ""."""
    last_modified: str = ""
    name: str = ""
    owner: str = ""
    path: str = ""
    permissions: str = ""
    size: int = 0


@dataclass
class Subdirectory(_Model):
    name: str = ""
    path: str = ""


@dataclass
class Directory(_Model):
    files: List[File] = field(default_factory=list)
    name: str = ""
    path: str = ""
    subdirectories: List[Subdirectory] = field(default_factory=list)
    _nested = {"files": File, "subdirectories": Subdirectory}


@dataclass
class FindMatch(_Model):
    path: str = ""
    type_: str = "file"


@dataclass
class FindResponse(_Model):
    matches: List[FindMatch] = field(default_factory=list)
    total: int = 0


@dataclass
class ContentSearchMatch(_Model):
    column: int = 0
    line: int = 0
    path: str = ""
    text: str = ""
    context: Optional[str] = None


@dataclass
class ContentSearchResponse(_Model):
    matches: List[ContentSearchMatch] = field(default_factory=list)
    query: str = ""
    total: int = 0


@dataclass
class PreviewMetadata(_Model):
    name: str = ""
    display_name: Optional[str] = None
    resource_name: Optional[str] = None
    resource_type: Optional[str] = None
    created_at: Optional[str] = None
    workspace: Optional[str] = None


@dataclass
class PreviewSpec(_Model):
    port: Optional[int] = None
    public: Optional[bool] = None
    url: Optional[str] = None
    custom_domain: Optional[str] = None
    expires: Optional[str] = None
    prefix_url: Optional[str] = None
    region: Optional[str] = None
    request_headers: Optional[Dict[str, str]] = None
    response_headers: Optional[Dict[str, str]] = None
    ttl: Optional[str] = None


@dataclass
class Preview(_Model):
    metadata: Optional[PreviewMetadata] = None
    spec: Optional[PreviewSpec] = None
    status: Optional[str] = None
    events: Optional[List[Any]] = None
    _nested = {"metadata": PreviewMetadata, "spec": PreviewSpec}


@dataclass
class PreviewTokenMetadata(_Model):
    name: str = ""
    preview_name: Optional[str] = None
    resource_name: Optional[str] = None
    resource_type: Optional[str] = None


@dataclass
class PreviewTokenSpec(_Model):
    token: Optional[str] = None
    expires_at: Optional[str] = None
    expired: Optional[bool] = None


@dataclass
class PreviewToken(_Model):
    metadata: Optional[PreviewTokenMetadata] = None
    spec: Optional[PreviewTokenSpec] = None
    _nested = {"metadata": PreviewTokenMetadata, "spec": PreviewTokenSpec}


@dataclass
class SandboxSnapshotSpec(_Model):
    image: Optional[str] = None
    memory: Optional[int] = None
    region: Optional[str] = None


@dataclass
class SandboxSnapshotSource(_Model):
    name: str = ""
    kind: str = "sandbox"
    deleted: Optional[bool] = None


@dataclass
class SandboxSnapshot(_Model):
    created_at: str = ""
    id: str = ""
    name: str = ""
    status: str = ""
    """pending, ready or failed."""
    workspace: str = ""
    created_by: Optional[str] = None
    sandbox_name: Optional[str] = None
    source: Optional[SandboxSnapshotSource] = None
    spec: Optional[SandboxSnapshotSpec] = None
    _nested = {"source": SandboxSnapshotSource, "spec": SandboxSnapshotSpec}


@dataclass
class SandboxForkResponse(_Model):
    name: Optional[str] = None
    snapshot_id: Optional[str] = None
    type_: Optional[str] = None


@dataclass
class SandboxSnapshotRequest(_Model):
    name: Optional[str] = None
    source: Optional[SandboxSnapshotSource] = None
    _nested = {"source": SandboxSnapshotSource}


class VolumeBinding:
    def __init__(self, name: str, mount_path: str, read_only: Optional[bool] = False, type: Optional[str] = None,
                 size_mb: Optional[int] = None) -> None:
        self.name, self.mount_path, self.read_only = name, mount_path, read_only or False
        self.type, self.size_mb = type, size_mb

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "VolumeBinding":
        return cls(data["name"], data["mount_path"], data.get("read_only", False), data.get("type"),
                   data.get("size_mb"))


class SandboxCreateConfiguration:
    """Blaxel's simple create options. ``external_id`` is kept as a label, so
    ``get_by_external_id`` finds the sandbox."""

    def __init__(self, name: Optional[str] = None, image: Optional[str] = None, memory: Optional[int] = None,
                 ports: Optional[List[Any]] = None, envs: Optional[List[Any]] = None,
                 volumes: Optional[List[Any]] = None, ttl: Optional[str] = None, expires: Optional[datetime] = None,
                 region: Optional[str] = None, lifecycle: Any = None, network: Any = None,
                 snapshot_enabled: Optional[bool] = None, labels: Optional[Dict[str, str]] = None,
                 extra_args: Optional[Dict[str, str]] = None, external_id: Optional[str] = None) -> None:
        self.name, self.image, self.memory, self.ports, self.envs = name, image, memory, ports, envs
        self.volumes, self.ttl, self.expires, self.region = volumes, ttl, expires, region
        self.lifecycle, self.network, self.snapshot_enabled = lifecycle, network, snapshot_enabled
        self.labels, self.extra_args, self.external_id = labels, extra_args, external_id

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SandboxCreateConfiguration":
        expires = data.get("expires")
        if isinstance(expires, str):
            expires = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        return cls(name=data.get("name"), image=data.get("image"), memory=data.get("memory"),
                   ports=data.get("ports"), envs=data.get("envs"), volumes=data.get("volumes"), ttl=data.get("ttl"),
                   expires=expires, region=data.get("region"), lifecycle=data.get("lifecycle"),
                   network=data.get("network"), snapshot_enabled=data.get("snapshot_enabled"),
                   labels=data.get("labels"), extra_args=data.get("extra_args"),
                   external_id=data.get("external_id", data.get("externalId")))


class SandboxUpdateMetadata:
    def __init__(self, labels: Optional[Dict[str, str]] = None, display_name: Optional[str] = None) -> None:
        self.labels, self.display_name = labels, display_name


class SandboxUpdateNetwork:
    def __init__(self, network: Any = None) -> None:
        self.network = network


class SessionCreateOptions:
    def __init__(self, expires_at: Optional[datetime] = None, response_headers: Optional[Dict[str, str]] = None,
                 request_headers: Optional[Dict[str, str]] = None) -> None:
        self.expires_at = expires_at
        self.response_headers = response_headers or {}
        self.request_headers = request_headers or {}


class SessionWithToken:
    def __init__(self, name: str, url: str, token: str, expires_at: datetime) -> None:
        self.name, self.url, self.token, self.expires_at = name, url, token, expires_at


class SandboxFilesystemFile:
    def __init__(self, path: str, content: str) -> None:
        self.path, self.content = path, content

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SandboxFilesystemFile":
        return cls(data["path"], data["content"])


class CopyResponse:
    def __init__(self, message: str, source: str, destination: str) -> None:
        self.message, self.source, self.destination = message, source, destination


class WatchEvent:
    """``op`` is CREATE, WRITE, REMOVE, RENAME or CHMOD; ``path`` the
    directory and ``name`` the entry, as Blaxel reports them."""

    def __init__(self, op: str, path: str, name: str, content: Optional[str] = None) -> None:
        self.op, self.path, self.name, self.content = op, path, name, content


class _Handle:
    """Blaxel's stream and watch handles: ``close()``, a context manager, and
    ``handle["close"]()``."""

    def __init__(self, close_func: Callable[[], None], wait_func: Optional[Callable[..., Any]] = None) -> None:
        self._close_func, self._wait_func = close_func, wait_func
        self._closed = False

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._close_func()

    @property
    def closed(self) -> bool:
        return self._closed

    def __enter__(self) -> Any:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    async def __aenter__(self) -> Any:
        return self

    async def __aexit__(self, *_: Any) -> None:
        self.close()

    def __getitem__(self, key: str) -> Any:
        if key == "close":
            return self.close
        if key == "wait" and self._wait_func is not None:
            return self.wait  # type: ignore[attr-defined]
        raise KeyError(key)


class StreamHandle(_Handle):
    def wait(self, timeout: Optional[float] = None) -> None:
        if self._wait_func is not None:
            self._wait_func(timeout)


class AsyncStreamHandle(_Handle):
    async def wait(self, timeout: Optional[float] = None) -> None:
        if self._wait_func is not None:
            await self._wait_func(timeout)


class WatchHandle(_Handle):
    pass


class AsyncWatchHandle(_Handle):
    pass


# ---- the code interpreter's results ----------------------------------------------


class OutputMessage:
    def __init__(self, text: str, timestamp: Optional[float], is_stderr: bool) -> None:
        self.text, self.timestamp, self.is_stderr = text, timestamp, is_stderr


class Result:
    """One rich result: its MIME data as ``text``, ``html``, ``markdown``,
    ``png``, ``jpeg``, ``svg``, ``json`` and ``latex``; ``is_main_result``
    for the cell's value."""

    def __init__(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)


class ExecutionError:
    def __init__(self, name: str, value: Any, traceback: Any) -> None:
        self.name, self.value, self.traceback = name, value, traceback


class Logs:
    def __init__(self) -> None:
        self.stdout: List[str] = []
        self.stderr: List[str] = []


class Execution:
    def __init__(self) -> None:
        self.results: List[Result] = []
        self.logs = Logs()
        self.error: Optional[ExecutionError] = None
        self.execution_count: Optional[int] = None


class Context:
    def __init__(self, id: str) -> None:  # noqa: A002 - Blaxel's name
        self.id = id

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> "Context":
        return cls(id=str(data.get("id") or data.get("context_id") or ""))


_MIME = {"text/plain": "text", "text/html": "html", "text/markdown": "markdown", "image/png": "png",
         "image/jpeg": "jpeg", "image/svg+xml": "svg", "application/json": "json", "text/latex": "latex",
         "application/javascript": "javascript"}


def result_of(bundle: Dict[str, Any]) -> Result:
    """A Runtime MIME bundle as Blaxel's Result."""
    values: Dict[str, Any] = {_MIME.get(mime, mime): value for mime, value in (bundle.get("data") or {}).items()}
    values["is_main_result"] = bool(bundle.get("main"))
    return Result(**values)



# ---- rules ---------------------------------------------------------------------------

DEFAULT_IMAGE = "blaxel/base-image:latest"
DEFAULT_MEMORY = 4096
"""Blaxel's default sandbox: 4096 MB (checked 27 September 2026)."""
MEMORY_PER_VCPU = 2048
STOCK_IMAGE = re.compile(
    r"^(docker\.io/)?blaxel/(prod-)?(base|base-image|py-app|ts-app|node|jupyter-server|docker-in-sandbox)(:latest)?$")
"""Blaxel's templates whose tools Runtime's stock image has (Python, Node, a
shell, git, Docker after `sudo enable-docker`), and the Jupyter server that
CodeInterpreter uses, whose work Runtime's interpreter does. The framework,
browser and desktop templates are not."""
MAX_VCPU = 16
IDLE_PAUSE_SECONDS = 60
"""The shortest idle pause Runtime allows. Blaxel scales a sandbox to zero
after about 15 seconds without a connection (docs, checked 27 September 2026)."""
LEASE_SECONDS = 3600
"""The longest lease: a lease that ends pauses a standby sandbox, as idling does."""
RENEW_BELOW_SECONDS = 600
"""A lease in use is moved on once less than this is left."""
KEEP_DAYS = 365
"""A Blaxel sandbox with no TTL or lifecycle is kept until deleted: 365 days
paused is the longest Runtime keeps one."""
MAX_PROCESS_MS = 86_400_000
KEEP_ALIVE_SECONDS = 600
"""Blaxel kills a keep_alive process after 10 minutes unless timeout says otherwise."""
PORT_WAIT_SECONDS = 60
HOME = "/blaxel"
"""Blaxel's working directory and HOME in its templates (their Dockerfiles,
checked 27 September 2026)."""
RUNTIME_HOME = "/workspace"
ENV_FILE = "/etc/runtime-blaxel/env"
"""The sandbox's envs, on the sandbox itself: one line each, sourced by every
process the adapter starts, so a fresh client (Python or TypeScript) needs
nothing but the sandbox. Readable by the sandbox user, written with sudo."""
LABEL = "blaxel/"
"""Runtime labels under this prefix carry what Blaxel keeps and Runtime has no
field for; metadata.labels shows only the others."""
MARK = ": rt-blaxel"
KEEP_MARK = ": rt-blaxel-keep"
"""Marks a keep_alive process's command line (after its name, inside the 256
characters Runtime keeps), so any client can tell whether one still runs."""
IDLE_LABEL = "idlePauseSeconds"
"""``blaxel/idlePauseSeconds``: the idle pause a keep_alive process raised the
sandbox's from, given back by whichever client first sees that no keep_alive
process runs any more."""
KEEP = "RUNTIME_BLAXEL_KEEP"
"""Names a process's own env, which wins over the sandbox's."""
RESTART_NOTE = re.compile(r"\n\[Process failed with exit code \d+\. Attempting restart (\d+)/")
STANDBY: Dict[str, Any] = {"timeout_seconds": LEASE_SECONDS, "on_lease_end": "pause",
                           "idle_pause_seconds": IDLE_PAUSE_SECONDS, "auto_wake": True}
"""Blaxel's standby on Runtime: pause after a minute idle or at the lease's
end, wake on the next request."""
RUNTIME_KEEP_DAYS = 30
"""How long Runtime keeps a paid sandbox paused unless told otherwise. A trial
sandbox is kept seven days, which no call changes (pricing guide, checked 27
September 2026); Blaxel's first tier keeps a sandbox at most seven days too."""
US_REGIONS = {"us-pdx-1", "us-was-1", "auto"}
"""Blaxel's regions in the United States, where Runtime runs."""
REGION = "us-was-1"
"""What spec.region reports when none was asked: Runtime runs in one US region, in the east."""
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86_400, "w": 604_800}
SIGNAL_KILL = 9


def pick_key() -> Optional[str]:
    """RUNTIME_API_KEY, then BL_API_KEY when it holds a Runtime key, then the
    key `npx withruntime login` saved (None). A Blaxel key is never sent."""
    runtime_key = os.environ.get("RUNTIME_API_KEY")
    if runtime_key:
        return runtime_key
    blaxel_key = (os.environ.get("BL_API_KEY") or "").strip()
    return blaxel_key if blaxel_key.startswith("rtcloud_") else None


def _invalid(message: str) -> SandboxAPIError:
    return SandboxAPIError(message, 400, "invalid_request")


def duration(value: Any) -> int:
    """Seconds from Blaxel's duration: "30s", "5m", "24h", "7d", "1w", or
    several at once ("1h30m")."""
    text = str(value).strip()
    if not re.fullmatch(r"(?:\d+[smhdw])+", text):
        raise _invalid(f'invalid duration "{value}": use units s, m, h, d or w')
    return sum(int(count) * _UNITS[unit] for count, unit in re.findall(r"(\d+)([smhdw])", text))


def epoch(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).timestamp()
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class Plan:
    """How long Runtime keeps a sandbox, from Blaxel's ttl, expires and
    lifecycle. Never shorter than Blaxel would."""

    timeout_seconds: int = LEASE_SECONDS
    on_lease_end: str = "pause"
    retention_days: int = KEEP_DAYS


def plan(ttl: Any = None, expires: Any = None, lifecycle: Any = None, now: Optional[float] = None) -> Plan:
    """Blaxel deletes at the first of: ``ttl`` (or ``ttl-max-age``) after
    creation, the ``date`` (or ``expires``), and ``ttl-idle`` after the last
    resume or suspend. On Runtime a sandbox pauses when idle and is kept paused
    for ``retention_days``; a limit of an hour or less that runs from creation
    is also the lease, which then ends the sandbox rather than pausing it."""
    now = time.time() if now is None else now
    from_creation: List[int] = []
    idle: List[int] = []
    if ttl:
        from_creation.append(duration(ttl))
    if expires:
        from_creation.append(int(epoch(expires) - now))
    for policy in _policies(lifecycle):
        kind = str(getattr(policy.type_, "value", policy.type_) or "")
        action = str(getattr(policy.action, "value", policy.action) or "delete")
        if action != "delete":
            raise NotSupportedError(f"The expiration action {action}", 'Use action "delete", the only one Blaxel defines.')
        if not policy.value:
            raise _invalid("an expiration policy needs a value")
        if kind == "ttl-max-age":
            from_creation.append(duration(policy.value))
        elif kind == "date":
            try:
                from_creation.append(int(epoch(policy.value) - now))
            except ValueError:
                raise _invalid(f'invalid date "{policy.value}"') from None
        elif kind == "ttl-idle":
            idle.append(duration(policy.value))
        else:
            raise _invalid(f"unknown expiration policy type {kind}")
    if any(limit <= 0 for limit in from_creation):
        raise _invalid("the sandbox's expiry is in the past")
    limits = from_creation + idle
    if not limits:
        return Plan()
    shortest = min(limits)
    days = int(min(KEEP_DAYS, max(1, math.ceil(shortest / 86_400))))
    if from_creation and min(from_creation) <= LEASE_SECONDS:
        return Plan(timeout_seconds=max(60, min(from_creation)), on_lease_end="stop", retention_days=days)
    return Plan(retention_days=days)


def _policies(lifecycle: Any) -> List[ExpirationPolicy]:
    if lifecycle is None:
        return []
    if isinstance(lifecycle, dict):
        lifecycle = SandboxLifecycle.from_dict(lifecycle)
    return list(getattr(lifecycle, "expiration_policies", None) or [])


def vcpus(memory: int) -> int:
    """One vCPU per 2048 MB, rounded half up, 1 to 16."""
    return min(MAX_VCPU, max(1, math.floor(memory / MEMORY_PER_VCPU + 0.5)))


def check_region(region: Optional[str]) -> None:
    if region and region not in US_REGIONS:
        raise NotSupportedError(f"The region {region}",
                                'Runtime runs in one US region (east); use a US region such as "us-was-1", or '
                                "remove region and BL_REGION.")


VOLUMES = ("Blaxel drives", "Use a Runtime volume: create one with runtime.volumes.create(10240, name=...) and "
           "mount it at create with volumes=[{\"name\": ..., \"mount_path\": ...}].")


def check_create(config: SandboxCreateConfiguration) -> None:
    """Refuses before anything is done what Runtime cannot do as asked."""
    for key in config.extra_args or {}:
        if key != "iptables":
            raise NotSupportedError(f"The extra argument {key}",
                                    "Remove it; iptables (iptables-legacy) is always there on Runtime.")
    if config.snapshot_enabled is False:
        raise NotSupportedError("Turning snapshots off (snapshot_enabled=False)",
                                "Remove it: a Runtime sandbox can always be paused and snapshotted.")
    check_region(config.region or os.environ.get("BL_REGION"))
    network_rules(config.network)


def network_rules(network: Any) -> Optional[Dict[str, Any]]:
    """Blaxel's network as Runtime's rules: allowed and forbidden domains."""
    if network is None:
        return None
    if isinstance(network, dict):
        network = SandboxNetwork.from_dict(network)
    for name in ("egress", "firewall", "subnet"):
        if getattr(network, name):
            raise NotSupportedError(f"Network {name} settings",
                                    "Runtime has no dedicated egress IPs or subnets; restrict outbound traffic with "
                                    "allowed_domains and forbidden_domains.")
    proxy = network.proxy or {}
    if not isinstance(proxy, dict):
        proxy = {k: v for k, v in vars(proxy).items() if v is not None}
    unknown = [key for key in proxy if key not in ("allowedDomains", "allowed_domains", "forbiddenDomains",
                                                    "forbidden_domains")]
    if unknown:
        raise NotSupportedError(f"Network proxy {unknown[0]}",
                                "To send credentials to a host without the sandbox seeing them, use Runtime secrets "
                                "(runtime.secrets): the egress proxy adds them on HTTPS to the hosts you name.")
    allow = list(network.allowed_domains or []) + list(proxy.get("allowedDomains") or proxy.get("allowed_domains") or [])
    deny = list(network.forbidden_domains or []) + list(proxy.get("forbiddenDomains") or proxy.get("forbidden_domains")
                                                       or [])
    rules: Dict[str, Any] = {"internet": True}
    if allow:
        rules["allow"] = allow
    if deny:
        rules["deny"] = deny
    return rules


def to_runtime_path(path: Any, cwd: str = HOME) -> str:
    """Blaxel's paths as Runtime's: /blaxel, Blaxel's working directory and
    HOME, is /workspace; ~ and a relative path start there."""
    text = str(path)
    if text == "~" or text.startswith("~/"):
        text = HOME + text[1:]
    if not text.startswith("/"):
        text = f"{cwd.rstrip('/')}/{text[2:] if text.startswith('./') else ('' if text == '.' else text)}"
    text = text.rstrip("/") or "/"
    if text == HOME or text.startswith(HOME + "/"):
        return RUNTIME_HOME + text[len(HOME):]
    return text


SMALL = 1_048_576
"""The largest file the files API writes outside /workspace in one request."""
RM = """p="$1"
if [ -d "$p" ] && [ ! -L "$p" ]; then
  if [ "$2" = 1 ]; then rm -rf -- "$p" 2>/dev/null || sudo rm -rf -- "$p" || exit 3
  else
    if [ -n "$(ls -A -- "$p" 2>/dev/null)" ]; then echo "directory not empty" >&2; exit 4; fi
    rmdir -- "$p" 2>/dev/null || sudo rmdir -- "$p" || exit 3
  fi
  echo Directory
elif [ -e "$p" ] || [ -L "$p" ]; then rm -f -- "$p" 2>/dev/null || sudo rm -f -- "$p" || exit 3; echo File
else exit 2; fi"""
"""Removes as Blaxel's root does: as the sandbox user, then with sudo."""


def as_asked(runtime_path: str, asked: str, runtime_asked: str) -> str:
    """A path Runtime answered, in the spelling the caller used."""
    if runtime_path == runtime_asked or runtime_path.startswith(runtime_asked.rstrip("/") + "/"):
        return asked.rstrip("/") + runtime_path[len(runtime_asked.rstrip("/")):] if asked != "/" else runtime_path
    return runtime_path


def envs_of(envs: Any) -> Dict[str, str]:
    """Blaxel's envs, [{"name", "value"}] or Env, as a mapping."""
    out: Dict[str, str] = {}
    for one in envs or []:
        if isinstance(one, Env):
            name, value = one.name, one.value
        elif isinstance(one, dict):
            if "name" not in one or "value" not in one:
                raise ValueError(f"Environment variable dict must have 'name' and 'value' keys: {one}")
            name, value = one["name"], one["value"]
        else:
            raise ValueError(f"Invalid env type: {type(one)}. Expected dict with 'name' and 'value' keys.")
        out[str(name)] = str(value)
    return out


def ports_of(ports: Any) -> List[Port]:
    out = []
    for one in ports or []:
        port = Port.from_dict(one) if isinstance(one, dict) else one
        if not isinstance(port, Port):
            raise ValueError(f"Invalid port type: {type(one)}. Expected Port object or dict.")
        out.append(Port(target=int(port.target), name=port.name, protocol=port.protocol or "HTTP"))
    return out


def config_of(sandbox: Any) -> SandboxCreateConfiguration:
    """Any of Blaxel's create inputs (None, the simple options as a dict or a
    SandboxCreateConfiguration, or a whole Sandbox as a model or dict) as the
    simple options."""
    if sandbox is None:
        return SandboxCreateConfiguration()
    if isinstance(sandbox, SandboxCreateConfiguration):
        return sandbox
    if isinstance(sandbox, dict) and "metadata" not in sandbox and "spec" not in sandbox:
        return SandboxCreateConfiguration.from_dict(sandbox)
    model = Sandbox.from_dict(sandbox) if isinstance(sandbox, dict) else sandbox
    if not isinstance(model, Sandbox):
        raise ValueError(f"Unexpected sandbox type: {type(sandbox)}")
    meta = model.metadata or Metadata()
    spec = model.spec or SandboxSpec()
    run = spec.runtime or SandboxRuntime()
    return SandboxCreateConfiguration(
        name=meta.name, image=run.image, memory=run.memory, ports=run.ports, envs=run.envs, volumes=spec.volumes,
        ttl=run.ttl, expires=run.expires, region=spec.region, lifecycle=spec.lifecycle, network=spec.network,
        labels=meta.labels, extra_args=run.extra_args, external_id=meta.external_id)


def volumes_of(volumes: Any) -> List[VolumeAttachment]:
    """Blaxel's volume bindings (VolumeBinding, VolumeAttachment or dicts),
    each checked for what a Runtime volume mount can do."""
    out = []
    for one in volumes or []:
        if isinstance(one, VolumeBinding):
            one = VolumeAttachment(name=one.name, mount_path=one.mount_path, read_only=one.read_only, type_=one.type)
        elif isinstance(one, dict):
            if "name" not in one or "mount_path" not in one and "mountPath" not in one:
                raise ValueError(f"Volume binding dict must have 'name' and 'mount_path' keys: {one}")
            one = VolumeAttachment.from_dict(one)
        if str(one.type_ or "") == "ephemeral":
            raise NotSupportedError("Ephemeral volumes",
                                    "Write scratch files under /blaxel (or /tmp); they go with the sandbox.")
        if one.read_only:
            raise NotSupportedError("Read-only volume mounts",
                                    "Mount it read-write, or give the sandbox a copy with runtime_create={\"volumes\": "
                                    "[{\"volume_id\": ..., \"path\": ..., \"mode\": \"snapshot\"}]}.")
        out.append(one)
    return out


def labels_for(config: SandboxCreateConfiguration, image: str) -> Dict[str, str]:
    """The Runtime labels a new sandbox carries: the caller's, and Blaxel's
    own fields under ``blaxel/``."""
    labels = {str(k): str(v) for k, v in (config.labels or {}).items()}
    mine = {"image": image, "memory": str(config.memory or DEFAULT_MEMORY)}
    if config.external_id:
        mine["externalId"] = str(config.external_id)
    ports = ports_of(config.ports)
    if ports:
        mine["ports"] = ",".join(str(port.target) for port in ports)
    if config.region:
        mine["region"] = str(config.region)
    if config.ttl:
        mine["ttl"] = str(config.ttl)
    if config.expires:
        mine["expires"] = iso(epoch(config.expires))
    if config.lifecycle:
        lifecycle = config.lifecycle if isinstance(config.lifecycle, dict) else config.lifecycle.to_dict()
        mine["lifecycle"] = json.dumps(lifecycle, separators=(",", ":"))
    labels.update({LABEL + key: value for key, value in mine.items()})
    return labels


def user_labels(labels: Mapping[str, str]) -> Dict[str, str]:
    return {k: v for k, v in labels.items() if not k.startswith(LABEL)}


def own(labels: Mapping[str, str], key: str) -> Optional[str]:
    return labels.get(LABEL + key)


def sandbox_model(info: Mapping[str, Any], envs: Optional[Dict[str, str]] = None, deleted: bool = False) -> Sandbox:
    """A Runtime sandbox as Blaxel's Sandbox."""
    labels = dict(info.get("labels") or {})
    runtime_state = info.get("state", "")
    archived = own(labels, "archived") == "1"
    if deleted or runtime_state in ("stopping", "stopped"):
        status = Status.DELETING if runtime_state == "stopping" else Status.TERMINATED
        state = None
    elif runtime_state == "starting":
        status, state = Status.DEPLOYING, SandboxState.RUNNING
    elif runtime_state in ("paused", "pausing"):
        status = Status.ARCHIVED if archived else Status.DEPLOYED
        state = SandboxState.STANDBY
    else:
        status, state = Status.DEPLOYED, SandboxState.RUNNING
    lifecycle_text = own(labels, "lifecycle")
    ports = [Port(target=int(one), protocol="HTTP") for one in (own(labels, "ports") or "").split(",") if one]
    runtime = SandboxRuntime(
        image=own(labels, "image") or (DEFAULT_IMAGE if not info.get("image") else str(info.get("image"))),
        memory=int(info.get("memoryMiB") or own(labels, "memory") or DEFAULT_MEMORY),
        ports=ports or None, envs=[Env(name=k, value=v) for k, v in envs.items()] if envs else None,
        ttl=own(labels, "ttl"), expires=own(labels, "expires"))
    spec = SandboxSpec(runtime=runtime, region=own(labels, "region") or REGION,
                       lifecycle=SandboxLifecycle.from_dict(json.loads(lifecycle_text)) if lifecycle_text else None)
    meta = Metadata(name=info.get("name") or info.get("id"), display_name=own(labels, "displayName"),
                    external_id=own(labels, "externalId"), labels=user_labels(labels),
                    created_at=info.get("createdAt"), updated_at=info.get("readyAt") or info.get("createdAt"))
    return Sandbox(metadata=meta, spec=spec, status=status, state=state, last_used_at=info.get("lastActiveAt"),
                   expires_in=expires_in(info), events=[], errors=[])


def expires_in(info: Mapping[str, Any], now: Optional[float] = None) -> Optional[int]:
    """Seconds until Runtime deletes the sandbox: the lease when it ends the
    sandbox, the paused retention while paused, else not yet known."""
    now = time.time() if now is None else now
    state = info.get("state")
    if state == "paused" and info.get("pausedExpiresAt"):
        return max(0, int(epoch(info["pausedExpiresAt"]) - now))
    if state in ("running", "starting", "resuming") and info.get("onLeaseEnd") == "stop" and info.get("expiresAt"):
        return max(0, int(epoch(info["expiresAt"]) - now))
    return None


# ---- processes ---------------------------------------------------------------------


def request_of(process: Any) -> Tuple[ProcessRequest, Dict[str, Any]]:
    """A Blaxel exec input (dict, ProcessRequest or ProcessRequestWithLog) and
    its log callbacks."""
    callbacks: Dict[str, Any] = {}
    if isinstance(process, dict):
        data = dict(process)
        for key in ("on_log", "on_stdout", "on_stderr"):
            if data.get(key) is not None:
                callbacks[key] = data.pop(key)
            data.pop(key, None)
        request = ProcessRequest.from_dict(data)
    elif isinstance(process, ProcessRequestWithLog):
        callbacks = {k: getattr(process, k) for k in ("on_log", "on_stdout", "on_stderr") if getattr(process, k)}
        request = ProcessRequest(**{one.name: getattr(process, one.name) for one in fields(ProcessRequest)})
    elif isinstance(process, ProcessRequest):
        request = process
    else:
        raise ValueError(f"Invalid process type: {type(process)}. Expected a dict or a ProcessRequest.")
    if not request.command:
        raise ValueError("A process needs a command.")
    return request, callbacks


@dataclass
class Record:
    """What Runtime's record of a process says about a Blaxel process."""

    name: str
    command: str
    keep_alive: bool = False


def shell_quote(text: str) -> str:
    """Single-quoted for bash: any text, taken literally."""
    return "'" + text.replace("'", "'\\''") + "'"


def _unquote(text: str) -> str:
    return text.replace("'\\''", "'")


IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def check_env_names(names: Any) -> None:
    for name in names:
        if not IDENTIFIER.match(name):
            raise NotSupportedError(f'The environment variable name "{name}"',
                                    "Use a name of letters, digits and underscores that does not start with a digit.")


def env_file_lines(envs: Mapping[str, str]) -> str:
    """The env file's lines: each exports its variable unless the process was
    given its own (named in RUNTIME_BLAXEL_KEEP), so a process's env wins over
    the sandbox's. Lines stand alone: a fork's envs are appended and win."""
    check_env_names(envs.keys())
    return "".join(f'case ":${{{KEEP}-}}:" in *:{name}:*) ;; *) export {name}={shell_quote(value)} ;; esac\n'
                   for name, value in envs.items())


def parse_env_file(text: str) -> Dict[str, str]:
    """The envs an env file holds; later lines win, as when it is sourced."""
    return {name: _unquote(value) for name, value in re.findall(
        r"\*\) export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)' ;; esac", text)}


def env_file_command(append: bool) -> List[str]:
    """Writes the env file (replacing it, or appending to it) from standard
    input, so no value appears in a command line."""
    script = (f"sudo mkdir -p /etc/runtime-blaxel && sudo sh -c 'cat >> {ENV_FILE}' && "
              f'sudo chgrp "$(id -g)" {ENV_FILE} && sudo chmod 0640 {ENV_FILE}' if append
              else f'sudo install -D -m 0640 -g "$(id -g)" /dev/stdin {ENV_FILE}')
    return ["bash", "-c", script]


LINK_HOME = re.compile(r"/blaxel(/|\s|$|[\"'`;:])")


AS_ROOT = 'export __rt_cmd; exec sudo -E env "PATH=$PATH" "HOME=$HOME" bash -c'
"""How a Blaxel process becomes root, as on Blaxel: the sandbox user's shell
hands over to sudo (passwordless in Runtime's image), keeping every variable,
the sandbox user's PATH and HOME. ``exec`` leaves no extra shell, so a signal
reaches sudo and Runtime ends the whole process tree."""


def process_line(command: str, name: str, max_restarts: Optional[int] = None, link_home: bool = False,
                 keep_alive: bool = False) -> str:
    """The shell line a Blaxel process runs as, byte for byte the TypeScript
    adapter's (``processLine``, packages/cloud-sdk BLAXEL.md "The process
    line"): its name, the keep_alive mark, HOST as Blaxel sets it, the
    sandbox's envs, and the command run as root, repeated on failure when
    asked (with Blaxel's note in the output). Runtime keeps the first 256
    characters, so the name and the mark come first."""
    prelude = [f"{MARK} {shell_quote(name)}", *([KEEP_MARK] if keep_alive else []), 'export HOST="${HOST:-0.0.0.0}"',
               f"[ -r {ENV_FILE} ] && . {ENV_FILE}", f"unset {KEEP}",
               *([f"{{ [ -e {HOME} ] || sudo ln -s {RUNTIME_HOME} {HOME}; }} 2>/dev/null"] if link_home else []),
               f"__rt_cmd={shell_quote(command)}"]
    if max_restarts is None:
        evaluate = shell_quote('eval "$__rt_cmd"')
        return "; ".join([*prelude, f"{AS_ROOT} {evaluate}"])
    limit = "unlimited" if max_restarts < 0 else str(max_restarts)
    loop = ('__rt_n=0; while :; do ( eval "$__rt_cmd" ); __rt_c=$?; [ $__rt_c -eq 0 ] && exit 0; '
            + ("" if max_restarts < 0 else f"[ $__rt_n -ge {max_restarts} ] && exit $__rt_c; ")
            + "__rt_n=$((__rt_n+1)); printf '\\n[Process failed with exit code %d. Attempting restart %d/%s...]\\n' "
            + f"$__rt_c $__rt_n '{limit}'; done")
    return "; ".join([*prelude, f"{AS_ROOT} {shell_quote(loop)}"])


def parse_record(recorded: str) -> Optional[Record]:
    """The Blaxel name and command of a process the adapter started, from
    Runtime's record of it (cut at 256 characters: a long command is cut too);
    None for any other process."""
    name = re.search(r": rt-blaxel '((?:[^']|'\\'')*)'", recorded)
    if not name:
        return None
    command = re.search(r"__rt_cmd='((?:[^']|'\\'')*)'", recorded)
    partial = re.search(r"__rt_cmd='(.*)$", recorded)
    text = command.group(1) if command else re.sub(r"'\\?'?$", "", partial.group(1)) if partial else ""
    return Record(_unquote(name.group(1)), _unquote(text), f"{KEEP_MARK};" in recorded)


def random_name() -> str:
    """A name for an unnamed process, as Blaxel gives one: 8 letters and digits."""
    import secrets
    return "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(8))


def restarts_in(logs: str) -> int:
    counts = [int(found) for found in RESTART_NOTE.findall(logs)]
    return max(counts) if counts else 0


def process_status(state: str, exit_code: Optional[int]) -> ProcessResponseStatus:
    if state == "running" and exit_code is None:
        return ProcessResponseStatus.RUNNING
    if exit_code is None:
        return ProcessResponseStatus.KILLED
    if exit_code < 0:
        return ProcessResponseStatus.KILLED if -exit_code == SIGNAL_KILL else ProcessResponseStatus.STOPPED
    return ProcessResponseStatus.COMPLETED if exit_code == 0 else ProcessResponseStatus.FAILED


def http_date(value: Any) -> str:
    """Blaxel's times on a process: "Wed, 01 Jan 2023 12:00:00 GMT"."""
    if not value:
        return ""
    from email.utils import formatdate
    return formatdate(epoch(value), usegmt=True)


def working_dir_of(runtime_cwd: str) -> str:
    if runtime_cwd == RUNTIME_HOME or runtime_cwd.startswith(RUNTIME_HOME + "/"):
        return HOME + runtime_cwd[len(RUNTIME_HOME):]
    return runtime_cwd


class Lines:
    """Output cut into lines, as Blaxel's log callbacks receive it (no
    newline); a partial line waits for the rest or the end."""

    def __init__(self) -> None:
        self.partial: Dict[str, str] = {"stdout": "", "stderr": ""}

    def feed(self, stream: str, text: str) -> List[str]:
        parts = (self.partial[stream] + text).split("\n")
        self.partial[stream] = parts.pop()
        return parts

    def flush(self, stream: str) -> List[str]:
        rest, self.partial[stream] = self.partial[stream], ""
        return [rest] if rest else []


LOOPBACK = ["0100007F", "00000000000000000000000001000000", "0000000000000000FFFF00000100007F"]


def port_wait_script(ports: List[int], seconds: int,
                     tables: Tuple[str, ...] = ("/proc/net/tcp", "/proc/net/tcp6")) -> List[str]:
    """Waits, inside the sandbox, until every port listens on an address other
    than loopback, as Blaxel's waitForPorts counts a port ready (its
    IsRoutableListener), reading whichever socket tables exist (a guest
    without IPv6 has no tcp6). The TypeScript adapter's ``portWaitScript``,
    byte for byte."""
    for port in ports:
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65_535:
            raise ResponseError(f"invalid port {port}", 400, "invalid_request")
    hexes = " ".join(format(port, "04X") for port in ports)
    skip = " && ".join(f'a[1] != "{address}"' for address in LOOPBACK)
    return ["bash", "-c",
            f't=""; for f in {" ".join(tables)}; do [ -r "$f" ] && t="$t $f"; done; '
            f"end=$((SECONDS+{seconds})); while :; do ok=1; for h in {hexes}; do "
            f"awk -v h=\"$h\" '$4 == \"0A\" {{ split($2, a, \":\"); if (a[2] == h && {skip}) f = 1 }} END {{ exit !f }}' "
            "$t </dev/null || ok=0; done; [ $ok = 1 ] && exit 0; "
            "[ $SECONDS -ge $end ] && exit 1; sleep 0.2; done"]


# ---- files -------------------------------------------------------------------------

def file_of(entry: Mapping[str, Any], path: str) -> File:
    try:
        bits = int(str(entry.get("mode", "0")), 8) & 0o777
    except ValueError:
        bits = 0
    return File(last_modified=str(entry.get("modifiedAt", "")), name=str(entry.get("name", "")), path=path,
                permissions=f"{bits:o}".rjust(3, "0"), size=int(entry.get("size") or 0))


def grep_matches(stdout: str, query: str, case_sensitive: bool) -> List[ContentSearchMatch]:
    """grep -n output (path:line:text, or path-line-text for context) as
    Blaxel's matches."""
    out: List[ContentSearchMatch] = []
    for line in stdout.splitlines():
        found = re.match(r"^(.*?):(\d+):(.*)$", line)
        if not found:
            continue
        text = found.group(3)
        at = (text if case_sensitive else text.lower()).find(query if case_sensitive else query.lower())
        out.append(ContentSearchMatch(column=max(at, 0) + 1, line=int(found.group(2)), path=found.group(1),
                                      text=text))
    return out


def watch_op(kind: str) -> str:
    return {"create": "CREATE", "write": "WRITE", "modify": "WRITE", "remove": "REMOVE", "delete": "REMOVE",
            "rename": "RENAME", "chmod": "CHMOD"}.get(str(kind).lower(), str(kind).upper())



# ---- the rest of Blaxel's surface -------------------------------------------------

RESTORE = ("Restoring a sandbox to a snapshot in place",
           "Start a new sandbox from it: await sandbox.fork(\"new-name\", snapshot_id=snapshot.id), or "
           "await snapshot.fork(\"new-name\"): files, memory and running processes as they were.")
# ---- sessions (ARCHITECTURE.md section 3.12) ------------------------------------
#
# Blaxel's session is a private preview of the sandbox's API with a token;
# Runtime's is a sandbox session: a token that runs commands, uses files and
# reaches previews of that one sandbox and nothing else. expires_at defaults to
# a day, Blaxel's default and Runtime's most; the page that may use it is
# response_headers["Access-Control-Allow-Origin"]; request_headers have nothing
# to go to. url is the sandbox's address in Runtime's API, name session-<id>.

SESSION_PREFIX = "session-"
_SESSION_URL = re.compile(
    r"^(https?://[^/]+)/v1/sandboxes/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", re.I)


def session_options(options: Any) -> Tuple[int, List[str]]:
    """What Runtime is asked for: the lifetime in seconds and the origins.
    Refuses, before anything is sent, what a Runtime session cannot be."""
    if options is None:
        options = SessionCreateOptions()
    elif isinstance(options, dict):
        options = SessionCreateOptions(expires_at=options.get("expires_at", options.get("expiresAt")),
                                       response_headers=options.get("response_headers",
                                                                    options.get("responseHeaders")),
                                       request_headers=options.get("request_headers",
                                                                   options.get("requestHeaders")))
    if options.request_headers:
        raise NotSupportedError("Session request headers (request_headers)",
                                "A Runtime session drives the sandbox's commands and files directly; pass what "
                                "the headers carried as the command's env or a file.")
    origins: List[str] = []
    for name, value in (options.response_headers or {}).items():
        lower = name.lower()
        if lower == "access-control-allow-origin":
            for origin in (one.strip() for one in str(value).split(",")):
                if not origin:
                    continue
                if origin == "*":
                    raise NotSupportedError('A session for every origin (Access-Control-Allow-Origin: "*")',
                                            'Name the page that uses it: response_headers={"Access-Control-Allow-'
                                            'Origin": "https://app.example.com"}.')
                origins.append(origin.rstrip("/"))
        elif not lower.startswith("access-control-"):
            raise NotSupportedError(f"Session response header {name}",
                                    "Runtime answers a session's CORS headers itself; set other headers in the "
                                    "server your page talks to.")
    expires = options.expires_at
    now = datetime.now(timezone.utc)
    if expires is None:
        seconds = 86_400
    else:
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        seconds = int((expires - now).total_seconds())
    if seconds < 60:
        raise SandboxAPIError("A session must last at least a minute.", 400, "invalid_request")
    if seconds > 86_405:
        raise NotSupportedError("A session lasting more than a day",
                                "Make one for a day at most, and create_if_expired() again before it ends.")
    return min(seconds, 86_400), origins


def session_with_token(session: Dict[str, Any], api_url: str, token: str = "") -> SessionWithToken:
    return SessionWithToken(name=SESSION_PREFIX + session["id"],
                            url=f"{api_url}/v1/sandboxes/{session['sandboxId']}",
                            token=session.get("token") or token,
                            expires_at=datetime.fromisoformat(str(session["expiresAt"]).replace("Z", "+00:00")))


def session_id(name: str) -> str:
    return name[len(SESSION_PREFIX):] if name.startswith(SESSION_PREFIX) else name


def session_target(session: Any) -> Tuple[str, str, str]:
    """The API origin, sandbox id and token a session reaches; a session
    Runtime did not make is refused, never sent."""
    url = session.get("url") if isinstance(session, dict) else getattr(session, "url", None)
    token = session.get("token") if isinstance(session, dict) else getattr(session, "token", None)
    found = _SESSION_URL.match(str(url or ""))
    if not found or not str(token or "").startswith("rtsess_"):
        raise NotSupportedError("A session Runtime did not make",
                                "Make the session with sandbox.sessions.create() on your backend, where a Runtime "
                                "key is set, and pass what it returns.")
    return found.group(1), found.group(2), str(token)


def check_fork(target_type: str, port: Any, traffic: Any, custom_domain: Any, prefix: Any) -> None:
    if target_type != "sandbox":
        raise NotSupportedError(f'Forking into an {target_type}',
                                "Runtime forks into sandboxes; share the app's port with sandbox.previews.create(...).")
    for name, value in (("port", port), ("traffic", traffic), ("custom_domain", custom_domain), ("prefix", prefix)):
        if value is not None:
            raise NotSupportedError(f"{name} on a fork",
                                    "Fork without it; share a port of the copy with its previews.create(...).")


def image_ref(image: str) -> Tuple[str, str]:
    """A Blaxel image ``ns/name:tag`` as the Runtime image name and tag it
    maps to: every "/" becomes "-" (``ns-name``), the tag ``latest`` when
    none is given."""
    slash = image.rfind("/")
    colon = image.rfind(":")
    name, tag = (image[:colon], image[colon + 1:]) if colon > slash else (image, "latest")
    return name.replace("/", "-"), tag or "latest"


def image_alternative(image: str) -> str:
    name, tag = image_ref(image)
    return (f"Build it as a Runtime image named {name}: `npx withruntime image build --dockerfile Dockerfile "
            f"--name {name} -t {name}:{tag}`. The code can keep \"{image}\": the adapter starts from {name}:{tag}.")


class SandboxConfiguration:
    """Blaxel's ``sandbox.config``: the sandbox, and no URL or headers of its
    own (the adapter reaches it through Runtime's API)."""

    def __init__(self, sandbox: Sandbox, force_url: Optional[str] = None, headers: Optional[Dict[str, str]] = None,
                 params: Optional[Dict[str, str]] = None) -> None:
        self.sandbox, self.force_url = sandbox, force_url
        self.headers, self.params = headers or {}, params or {}

    @property
    def metadata(self) -> Any:
        return self.sandbox.metadata

    @property
    def status(self) -> Any:
        return self.sandbox.status

    @property
    def spec(self) -> Any:
        return self.sandbox.spec


PREVIEW_TOKEN_HEADER = "x-runtime-preview-token"


def fetch_request(preview: Mapping[str, Any], path: str, options: Mapping[str, Any]) -> Tuple[str, Dict[str, str],
                                                                                            Optional[bytes]]:
    """The target, headers and body of a request through a preview, from
    httpx's keyword arguments."""
    from urllib.parse import urlencode, urlsplit
    known = {"headers", "params", "content", "json", "data", "timeout"}
    other = [key for key in options if key not in known]
    if other:
        raise NotSupportedError(f"fetch({other[0]}=...)", "Pass headers, params, content, json or data.")
    base = urlsplit(str(preview["url"]))
    target = (base.path.rstrip("/") + (path if path.startswith("/") else f"/{path}")) or "/"
    params = options.get("params")
    if params:
        target += ("&" if "?" in target else "?") + urlencode(params, doseq=True)
    headers = {str(k): str(v) for k, v in (options.get("headers") or {}).items()}
    if preview.get("token"):
        headers[PREVIEW_TOKEN_HEADER] = str(preview["token"])
    body: Optional[bytes] = None
    if options.get("json") is not None:
        body = json.dumps(options["json"]).encode()
        headers.setdefault("Content-Type", "application/json")
    elif options.get("content") is not None:
        content = options["content"]
        body = content.encode() if isinstance(content, str) else bytes(content)
    elif options.get("data") is not None:
        body = urlencode(options["data"], doseq=True).encode()
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    return target, headers, body


class FetchResponse:
    """What ``fetch`` answers, as much of httpx's Response as code reads:
    ``status_code``, ``headers``, ``content``, ``text``, ``json()`` and
    ``is_success``."""

    def __init__(self, status_code: int, headers: Mapping[str, str], content: bytes) -> None:
        self.status_code = status_code
        self.headers = dict(headers)
        self.content = content

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")

    def json(self) -> Any:
        return json.loads(self.content)

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def raise_for_status(self) -> "FetchResponse":
        if not self.is_success:
            raise ResponseError(f"{self.status_code} from the sandbox", self.status_code, "http_error")
        return self
STANDBY_SETTINGS = {"idlePauseSeconds": IDLE_PAUSE_SECONDS, "autoWake": True}
