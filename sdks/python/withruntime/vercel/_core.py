"""What the sync and async Vercel Sandbox adapters share: Vercel's errors and
models, and the rules that map a Vercel call onto Runtime's SDK. Nothing here
does I/O."""
from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from datetime import timedelta
from enum import Enum
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Union

from .._errors import RuntimeError as _SDKError

# ---- errors: Vercel's names --------------------------------------------------


class SandboxError(Exception):
    """Base class for Vercel Sandbox's errors. One made from a Runtime answer
    also carries Runtime's ``code``, ``hint`` and ``request_id``."""

    def __init__(self, message: str = "") -> None:
        super().__init__(message)
        self.hint: Optional[str] = None
        self.request_id: Optional[str] = None


class SandboxApiError(SandboxError):
    """The API answered with an error: ``status_code``, ``code`` and ``data``."""

    def __init__(self, message: str, status_code: int = 0, code: Optional[str] = None,
                 data: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.data = data or {}


class SandboxCredentialsError(SandboxError):
    pass


class SandboxPathNotFoundError(SandboxError, FileNotFoundError):
    pass


class SandboxTimeoutError(SandboxError, TimeoutError):
    pass


class SandboxStreamError(SandboxError):
    pass


class SandboxTerminalStateError(SandboxError):
    pass


class SandboxInvalidHandleError(SandboxError):
    pass


class SandboxFilesystemError(SandboxError, OSError):
    pass


class NotSupportedError(SandboxError):
    """A call Vercel supports and Runtime does not, or not the same way.
    Raised before anything is done. ``feature`` names what was asked;
    ``alternative`` says what to use on Runtime."""

    def __init__(self, feature: str, alternative: str, message: Optional[str] = None) -> None:
        super().__init__(message or f"{feature} is not supported on Runtime. {alternative}")
        self.feature = feature
        self.alternative = alternative
        self.code = "not_supported"


def translate(error: BaseException, subject: str = "other") -> BaseException:
    """A Runtime SDK error as Vercel's SandboxApiError (a missing path as
    SandboxPathNotFoundError)."""
    if not isinstance(error, _SDKError):
        return error
    parts = [error.message]
    if error.hint:
        parts.append(f"Hint: {error.hint}")
    if error.request_id:
        parts.append(f"Request: {error.request_id}")
    message = "\n".join(parts)
    code = error.code or ""
    out: SandboxError
    if error.status == 503 and code.endswith("_unavailable"):
        out = NotSupportedError(code[: -len("_unavailable")], error.hint or "", message)
    elif code == "file_not_found" or (error.status == 404 and subject == "file"):
        out = SandboxPathNotFoundError(message)
    else:
        out = SandboxApiError(message, status_code=error.status, code=code,
                              data={"error": {"code": code, "message": error.message}})
    out.hint, out.request_id = error.hint, error.request_id
    out.__cause__ = error
    return out


def unsupported(feature: str, alternative: str) -> Callable[..., Any]:
    def refuse(*_: Any, **__: Any) -> Any:
        raise NotSupportedError(feature, alternative)
    return refuse


# ---- models ----------------------------------------------------------------------


class SandboxStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"
    ABORTED = "aborted"
    SNAPSHOTTING = "snapshotting"


class ProcessStatus(str, Enum):
    RUNNING = "running"
    EXITED = "exited"


@dataclass
class SandboxResources:
    vcpus: Optional[int] = None
    memory: Optional[int] = None
    """Megabytes."""


@dataclass
class GitSource:
    url: str
    depth: Optional[int] = None
    revision: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None


@dataclass
class TarballSource:
    url: str


@dataclass
class SnapshotSource:
    snapshot_id: str


@dataclass
class SnapshotRetention:
    count: int
    expiration: Any = None
    delete_evicted: Optional[bool] = None


@dataclass
class NetworkPolicySubnets:
    allow: Optional[List[str]] = None
    deny: Optional[List[str]] = None


@dataclass
class NetworkPolicyTransform:
    headers: Optional[Dict[str, str]] = None
    header_names: Optional[List[str]] = None


@dataclass
class NetworkPolicyRule:
    transform: Optional[List[NetworkPolicyTransform]] = None
    forward_url: Optional[str] = None
    match: Any = None
    response: Any = None


@dataclass
class NetworkPolicy:
    mode: str = "allow-all"
    allow: Any = None
    subnets: Optional[NetworkPolicySubnets] = None

    @staticmethod
    def allow_all() -> "NetworkPolicy":
        return NetworkPolicy("allow-all")

    @staticmethod
    def deny_all() -> "NetworkPolicy":
        return NetworkPolicy("deny-all")

    @staticmethod
    def custom(allow: Any = None, subnets: Optional[NetworkPolicySubnets] = None) -> "NetworkPolicy":
        return NetworkPolicy("custom", allow, subnets)


@dataclass
class TagFilter:
    key: str
    value: str


@dataclass
class SandboxQueryByName:
    sort_order: str = "asc"
    name_prefix: Optional[str] = None
    tag: Optional[TagFilter] = None


@dataclass
class SandboxQueryByCreatedAt:
    sort_order: str = "asc"
    tag: Optional[TagFilter] = None


@dataclass
class DirectoryEntry:
    path: str
    """Relative to the listed directory."""
    kind: str
    """file, directory, symlink or other."""


@dataclass
class SandboxRoute:
    url: str
    port: int
    subdomain: str
    system: bool = False


@dataclass
class CompletedProcess:
    args: List[str]
    returncode: int
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    id: str = ""
    name: str = ""
    cwd: str = ""
    session_id: str = ""
    started_at: int = 0

    def check_returncode(self) -> None:
        if self.returncode:
            import subprocess
            raise subprocess.CalledProcessError(self.returncode, self.args, self.stdout, self.stderr)


# ---- rules ---------------------------------------------------------------------------

DEFAULT_VCPUS = 2
MEMORY_MIB_PER_VCPU = 2048
"""Vercel's default machine: 2 vCPUs with 2048 MB each (checked 23 September 2026)."""
DEFAULT_TIMEOUT = 300
"""Vercel's default session length, 5 minutes."""
MIN_LEASE, MAX_LEASE = 60, 3600
LONGEST_MS = 86_400_000
HOME = "/vercel/sandbox"
RUNTIME_HOME = "/workspace"
HOME_LINK = "[ -e /vercel/sandbox ] || { sudo mkdir -p /vercel && sudo ln -s /workspace /vercel/sandbox; }"
STOCK_IMAGE = re.compile(r"^(vercel/sandbox/)?(universal|ubuntu|node:2[246]|python:3\.1[34])(:latest)?$")
US_REGIONS = {"iad1", "sfo1", "cle1", "pdx1"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
GIT_HELPER = 'credential.helper=!f() { echo "username=$GIT_USER"; echo "password=$GIT_PASS"; }; f'
SIGNALS = {1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 9: "SIGKILL", 10: "SIGUSR1", 12: "SIGUSR2", 15: "SIGTERM"}


def seconds(value: Any) -> Optional[float]:
    """Seconds from a number or a timedelta."""
    if value is None:
        return None
    if isinstance(value, timedelta):
        return value.total_seconds()
    return float(value)


def lease_seconds(value: Any) -> int:
    total = DEFAULT_TIMEOUT if value is None else seconds(value)
    if total is None or total <= 0:
        raise ValueError(f"execution_time_limit must be positive, not {value}.")
    whole = math.ceil(total)
    if whole > MAX_LEASE:
        raise NotSupportedError(f"An execution time limit of {total:g} s (over one hour)",
                                "Runtime leases last up to an hour; call extend_execution_time_limit(...) before "
                                "it ends, as often as needed.")
    return max(whole, MIN_LEASE)


def retention_days(value: Any) -> int:
    total = seconds(value) or 0
    if total == 0:
        return 365
    return int(min(365, max(1, math.ceil(total / 86_400))))


def pick_key(token: Optional[str] = None) -> Optional[str]:
    """A Runtime key given as token, then RUNTIME_API_KEY. A Vercel token is
    never sent anywhere."""
    if token and token.startswith("rtcloud_"):
        return token
    runtime_key = os.environ.get("RUNTIME_API_KEY")
    if runtime_key:
        return runtime_key
    if token:
        raise SandboxCredentialsError(
            "The token passed is a Vercel token, and it was not sent. Set RUNTIME_API_KEY to a Runtime key "
            "(https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the Runtime key as token.")
    return None


def network_rules(policy: Any) -> Dict[str, Any]:
    """Vercel's network policy as Runtime's rules."""
    if isinstance(policy, str):
        policy = NetworkPolicy(policy)
    if policy.mode == "allow-all":
        return {"internet": True}
    if policy.mode == "deny-all":
        return {"internet": False}
    allow = policy.allow
    domains: List[str] = []
    if isinstance(allow, Mapping):
        for domain, rules in allow.items():
            if rules:
                raise NotSupportedError(f"Network rules that transform or forward requests (for {domain})",
                                        f"Allow the domain with no rules and store the credential as a Runtime secret for it: `npx withruntime secrets set NAME --host {domain}`. The sandbox sees a placeholder, and the egress proxy adds the value.")
            domains.append(domain)
    elif allow:
        domains = list(allow)
    subnets = policy.subnets or NetworkPolicySubnets()
    wildcard = "*" in domains
    listed = [one for one in domains if one != "*"] + list(subnets.allow or [])
    if not wildcard and not listed:
        return {"internet": False}
    rules: Dict[str, Any] = {"internet": True}
    if listed and not wildcard:
        rules["allow"] = listed
    if subnets.deny:
        rules["deny"] = list(subnets.deny)
    return rules


def refuse_create(mounts: Any, network_id: Any, region: Any, failover_regions: Any) -> None:
    if mounts:
        raise NotSupportedError("Vercel Drives (mounts)",
                                "Use a Runtime volume: runtime_create={'volumes': [{'volume_id': ..., 'path': ...}]}.")
    if network_id is not None:
        raise NotSupportedError("Secure Compute networks (network_id)",
                                "Remove it; restrict outbound traffic with network_policy instead.")
    if region is not None and region not in US_REGIONS:
        raise NotSupportedError(f"The region {region}", "Runtime runs in one US region (east). Remove region.")
    if failover_regions:
        raise NotSupportedError("Failover regions (failover_regions)", "Remove it: Runtime runs in one US region.")


def to_runtime_path(path: Any, cwd: Any = None) -> str:
    """Relative paths resolve against /vercel/sandbox, which is /workspace."""
    path = str(path)
    base = HOME if cwd is None else (str(cwd) if str(cwd).startswith("/") else f"{HOME}/{str(cwd)}")
    absolute = path if path.startswith("/") else f"{base}/{path[2:] if path.startswith('./') else path}"
    absolute = re.sub(r"/\.?$", "", absolute.rstrip("/")) or "/"
    if absolute == HOME or absolute.startswith(HOME + "/"):
        return RUNTIME_HOME + absolute[len(HOME):]
    return absolute


def status_of(state: str) -> SandboxStatus:
    return {"starting": SandboxStatus.PENDING, "running": SandboxStatus.RUNNING, "resuming": SandboxStatus.RUNNING,
            "pausing": SandboxStatus.STOPPING, "stopping": SandboxStatus.STOPPING}.get(state, SandboxStatus.STOPPED)


def exit_code(code: Optional[int], timed_out: bool) -> int:
    """A command killed at its time limit reports 137, as SIGKILL does; any
    other signal -1."""
    if code is not None:
        return code
    return 137 if timed_out else -1


def argv_of(command: str, args: Optional[Sequence[str]], sudo: bool) -> List[str]:
    return [*(["sudo", "--preserve-env"] if sudo else []), command, *(args or [])]


def signal_name(sig: Union[int, str, Any]) -> str:
    if isinstance(sig, str):
        return sig
    name = getattr(sig, "name", None)
    if name:
        return name
    if int(sig) in SIGNALS:
        return SIGNALS[int(sig)]
    raise ValueError(f"Signal {sig} has no name Runtime knows.")


class LinePump:
    """Splits one process's output events into stdout and stderr text, pulled
    as a reader asks for it."""

    def __init__(self, events: Any) -> None:
        self.events = events
        self.buffers: Dict[str, str] = {"stdout": "", "stderr": ""}
        self.exit: Optional[Dict[str, Any]] = None
        self.done = False

    def take(self, stream: str, size: int = -1, line: bool = False) -> Optional[str]:
        """What the buffer can answer now, or None when it needs more."""
        text = self.buffers[stream]
        if line:
            at = text.find("\n")
            if at >= 0:
                self.buffers[stream] = text[at + 1:]
                return text[:at + 1]
            if not self.done:
                return None
        elif size >= 0 and len(text) >= size:
            self.buffers[stream] = text[size:]
            return text[:size]
        elif not self.done:
            return None
        self.buffers[stream] = ""
        return text

    def feed(self, event: Dict[str, Any]) -> None:
        if event["type"] in ("stdout", "stderr"):
            self.buffers[event["type"]] += event["data"]
        elif event["type"] == "exit":
            self.exit = event
            self.done = True


def route(port: int, url: str) -> SandboxRoute:
    host = url.split("://", 1)[-1].split("/", 1)[0]
    return SandboxRoute(url=url.rstrip("/"), port=port, subdomain=host.split(".")[0])

