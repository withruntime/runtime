"""What the sync and async adapters share: E2B's errors and data classes, and
the rules that map an E2B call onto Runtime's SDK. Nothing here does I/O."""
from __future__ import annotations

import math
import asyncio
import os
import re
import time
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Union

from .._errors import RuntimeError as _SDKError

# ---- errors: E2B's names and parents ------------------------------------


class SandboxException(Exception):
    """Base class for E2B's sandbox errors. One made from a Runtime answer also
    carries Runtime's ``code``, ``hint`` and ``request_id``."""

    def __init__(self, *args: Any, status_code: Optional[int] = None):
        super().__init__(*args)
        self.status_code = status_code
        self.code: Optional[str] = None
        self.hint: Optional[str] = None
        self.request_id: Optional[str] = None


class TimeoutException(SandboxException):
    pass


class InvalidArgumentException(SandboxException):
    pass


class NotEnoughSpaceException(SandboxException):
    pass


class NotFoundException(SandboxException):
    pass


class FileNotFoundException(NotFoundException):
    pass


class SandboxNotFoundException(NotFoundException):
    pass


class TemplateException(SandboxException):
    pass


class RateLimitException(SandboxException):
    pass


class AuthenticationException(Exception):
    """E2B's AuthenticationException extends Exception, not SandboxException."""


class ServiceBusyException(Exception):
    """E2B's ServiceBusyException extends Exception, not SandboxException."""

    status_code = 503


class NotSupportedException(SandboxException):
    """A call E2B supports and Runtime does not, or not the same way. Raised
    before anything is done. ``feature`` names what was asked; ``alternative``
    says what to use on Runtime."""

    def __init__(self, feature: str, alternative: str, message: Optional[str] = None):
        super().__init__(message or f"{feature} is not supported on Runtime. {alternative}")
        self.feature = feature
        self.alternative = alternative
        self.code = "not_supported"


class FilesystemEventType(Enum):
    CHMOD = "chmod"
    CREATE = "create"
    REMOVE = "remove"
    RENAME = "rename"
    WRITE = "write"


@dataclass
class FilesystemEvent:
    name: str
    type: FilesystemEventType
    entry: Optional["EntryInfo"] = None


# ---- data classes --------------------------------------------------------


@dataclass
class PtySize:
    rows: int
    cols: int


@dataclass
class CommandResult:
    stderr: str
    stdout: str
    exit_code: int
    error: Optional[str]
    #: Runtime's addition: some of the command's output was dropped before it
    #: was read, so ``stdout`` and ``stderr`` are missing part of it. A warning
    #: says so too.
    truncated: bool = False


@dataclass
class CommandExitException(SandboxException, CommandResult):
    """Raised when a command exits with a code other than 0; it carries the result."""

    def __post_init__(self) -> None:
        SandboxException.__init__(self, str(self))

    def __str__(self) -> str:
        return f"Command exited with code {self.exit_code} and error:\n{self.stderr}"


@dataclass
class ProcessInfo:
    """``pid`` is a number derived from Runtime's process id, not the Linux pid."""

    pid: int
    tag: Optional[str]
    cmd: str
    args: List[str]
    envs: Dict[str, str]
    cwd: Optional[str]


class FileType(Enum):
    FILE = "file"
    DIR = "dir"
    SYMLINK = "symlink"


@dataclass
class WriteInfo:
    name: str
    type: Optional[FileType]
    path: str
    metadata: Optional[Dict[str, str]] = field(default=None, kw_only=True)


@dataclass
class EntryInfo(WriteInfo):
    size: int
    mode: int
    permissions: str
    owner: str
    """Owner name when supplied by the guest; empty on older guest images."""
    group: str
    modified_time: datetime
    symlink_target: Optional[str] = None


@dataclass
class SandboxInfoLifecycle:
    on_timeout: str
    auto_resume: bool


@dataclass
class SandboxInfo:
    sandbox_id: str
    sandbox_domain: Optional[str]
    template_id: str
    """"base" for Runtime's stock image, else the image or snapshot id."""
    name: Optional[str]
    metadata: Dict[str, str]
    started_at: datetime
    end_at: datetime
    state: str
    cpu_count: int
    memory_mb: int
    envd_version: str
    lifecycle: Optional[SandboxInfoLifecycle] = None


@dataclass
class SnapshotInfo:
    snapshot_id: str
    names: List[str]


@dataclass
class SandboxQuery:
    metadata: Optional[Dict[str, str]] = None
    state: Optional[List[str]] = None
    started_after: Optional[datetime] = None
    template: Optional[str] = None


# ---- rules -----------------------------------------------------------------

DEFAULT_VCPU = 2
"""E2B's default machine: 2 vCPU and 512 MiB (docs.e2b.dev/billing, checked 23 September 2026)."""
DEFAULT_MEMORY_MIB = 512
DEFAULT_TIMEOUT = 300
"""E2B's default sandbox timeout, in seconds."""
MIN_LEASE, MAX_LEASE = 60, 3600
COMMAND_TIMEOUT = 60
LONGEST_MS = 86_400_000



#: Where Runtime serves previews; get_host names a host under it.
PREVIEW_DOMAIN = "runtimehost.com"

def whole_output(_text: str) -> None:
    """Given to exec as an output callback so it streams and returns the whole
    output: an exec with no callback returns at most 64 KiB of each stream."""


STOCK_TEMPLATES = frozenset({"base", "code-interpreter-v1", "code-interpreter"})
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
HOME = "/workspace"
HOME_LINK = "[ -e /home/user ] || sudo ln -s /workspace /home/user"
RUNNING = ["starting", "running", "resuming"]
PAUSED = ["pausing", "paused"]
_warned_short = False


def pick_key(explicit: Optional[str]) -> Optional[str]:
    """Explicit key, then RUNTIME_API_KEY, then E2B_API_KEY when it holds a
    Runtime key. An E2B key (``e2b_...``) is never sent anywhere."""
    runtime_key = os.environ.get("RUNTIME_API_KEY")
    if explicit is not None and not explicit.startswith("e2b_"):
        return explicit
    if runtime_key:
        return runtime_key
    if explicit is not None:
        raise AuthenticationException(
            "The api_key passed is an E2B API key (e2b_...), and it was not sent. Set RUNTIME_API_KEY to a "
            "Runtime key (https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the "
            "Runtime key as api_key.")
    e2b = os.environ.get("E2B_API_KEY")
    return e2b if e2b and not e2b.startswith("e2b_") else None


REFUSED_CONNECTION = {
    "domain": "Remove it: this package talks only to Runtime (RUNTIME_API_URL overrides the API origin).",
    "api_url": "Remove it: this package talks only to Runtime (RUNTIME_API_URL overrides the API origin).",
    "sandbox_url": "Remove it: this package talks only to Runtime.",
    "headers": "Remove it: this package talks only to Runtime.",
    "api_headers": "Remove it: this package talks only to Runtime.",
    "proxy": "Set HTTPS_PROXY in the environment instead.",
}
IGNORED_CONNECTION = {"retries", "validate_api_key", "logger", "secure"}


def request_seconds(owner: Any, value: Optional[float]) -> float:
    if value is not None:
        return value
    owner = getattr(owner, "_filesystem", owner)
    owner = getattr(owner, "_sandbox", owner)
    return getattr(owner, "_request_timeout", 60)


def check_connection(opts: Dict[str, Any]) -> None:
    for name, value in opts.items():
        if name == "request_timeout":
            from .._request_scope import limits
            limits(value)
            continue
        if value is None or name in IGNORED_CONNECTION or name in ("api_key", "client"):
            continue
        if name == "debug":
            if value:
                raise NotSupportedException("E2B's debug mode (a local envd)", "Remove debug=True.")
            continue
        if name in REFUSED_CONNECTION:
            raise NotSupportedException(f'The E2B connection option "{name}"', REFUSED_CONNECTION[name])
        raise InvalidArgumentException(f"Unknown option {name!r}.")


def lease_seconds(timeout: Union[int, float]) -> int:
    global _warned_short
    if timeout is None or timeout <= 0:
        raise InvalidArgumentException(f"timeout must be a positive number of seconds, not {timeout}.")
    seconds = math.ceil(timeout)
    if seconds > MAX_LEASE:
        raise NotSupportedException(
            f"A sandbox timeout of {timeout} s (over one hour)",
            "Runtime leases last up to an hour (3600 s); call sandbox.set_timeout(...) before it ends to keep "
            "going, as often as needed.")
    if seconds < MIN_LEASE:
        if not _warned_short:
            _warned_short = True
            warnings.warn(f"timeout {timeout} is under Runtime's shortest lease; the sandbox gets 60 s. "
                          "Call kill() when done.", stacklevel=3)
        return MIN_LEASE
    return seconds


def on_lease_end(lifecycle: Optional[Dict[str, Any]]) -> str:
    if not lifecycle:
        return "stop"
    on_timeout = lifecycle.get("on_timeout", "kill")
    if isinstance(on_timeout, dict):
        if on_timeout.get("keep_memory") is False:
            raise NotSupportedException("A files-only pause (keep_memory=False)",
                                        "Runtime's pause keeps memory and files; leave keep_memory out.")
        on_timeout = on_timeout.get("action", "kill")
    return "pause" if on_timeout == "pause" else "stop"


REFUSED_CREATE = {
    "mcp": ("E2B's MCP gateway (mcp)", "Run MCP servers yourself with commands.run(..., background=True)."),
    "network": ("E2B's network rules (network)",
                "Pass Runtime's rules instead: runtime_create={'network': {'internet': True, 'allow': [...]}}."),
    "iam": ("E2B workload identity (iam)", "Pass credentials with envs."),
    "volume_mounts": ("E2B volumes (volume_mounts)",
                      "Use a Runtime volume: runtime_create={'volumes': [{'volume_id': ..., 'path': ...}]}."),
}


def refuse_create(opts: Dict[str, Any]) -> None:
    for name, (feature, alternative) in REFUSED_CREATE.items():
        if opts.get(name) is not None:
            raise NotSupportedException(feature, alternative)


def template_missing(template: str) -> TemplateException:
    error = TemplateException(
        f'No Runtime image is named "{template}". E2B templates do not run on Runtime; build the same '
        f"environment as a Runtime image with that name and this call starts from it: "
        f"`npx withruntime image build --dockerfile e2b.Dockerfile --name {template}`, or "
        f'runtime.images.build(name="{template}", dockerfile=...).')
    error.code = "template_not_found"
    return error


def refuse_user(user: Optional[str]) -> None:
    if user is not None and user != "user":
        raise NotSupportedException(
            f'Running as the user "{user}"',
            'Runtime runs as its sandbox owner, with passwordless sudo: prefix the command with "sudo".')


def command_timeout_ms(timeout: Optional[float]) -> int:
    # Pinned E2B SDKs treat None and 0 as an unlimited connection, not a
    # process lifetime. The default of 60 seconds lives on Commands.run.
    if timeout is None or timeout == 0:
        return 0
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout < 0:
        raise InvalidArgumentException("timeout must be a nonnegative finite number of seconds")
    return max(1, round(timeout * 1000))


def to_result(exit_code: Optional[int], stdout: str, stderr: str, truncated: bool = False) -> CommandResult:
    code = -1 if exit_code is None else exit_code
    error = None if code == 0 else ("terminated by a signal" if exit_code is None else f"exit status {code}")
    return CommandResult(stderr=stderr, stdout=stdout, exit_code=code, error=error, truncated=truncated)


def settle(exit_code: Optional[int], stdout: str, stderr: str, timed_out: bool, timeout_ms: int,
           truncated: bool = False) -> CommandResult:
    """E2B never loses output, so a result that did says so in ``truncated``
    rather than passing as whole."""
    if timed_out:
        raise TimeoutException(
            f"Command timed out after {timeout_ms} ms: this error is likely due to exceeding 'timeout'. "
            "Pass a larger 'timeout', or 0 for no limit.")
    result = to_result(exit_code, stdout, stderr, truncated)
    if truncated:
        warnings.warn("Part of the command's output was dropped before it was read, so stdout and stderr are "
                      "incomplete (result.truncated). Write large output to a file and read it with "
                      "sandbox.files.read.", stacklevel=3)
    if result.exit_code != 0:
        raise CommandExitException(stderr=result.stderr, stdout=result.stdout, exit_code=result.exit_code,
                                   error=result.error, truncated=result.truncated)
    return result


def pid_of(process_id: str) -> int:
    """A 31-bit FNV-1a hash of Runtime's process id, as the JavaScript package makes it."""
    value = 0x811C9DC5
    for char in process_id:
        value ^= ord(char)
        value = (value * 0x01000193) & 0xFFFFFFFF
    return (value >> 1) or 1


def describe_process(info: Dict[str, Any]) -> ProcessInfo:
    return ProcessInfo(pid=pid_of(info["id"]), tag=None, cmd="/bin/bash", args=["-c", info.get("command", "")],
                       envs={}, cwd=info.get("cwd"))


def absolute(path: str) -> str:
    if path.startswith("/"):
        return path
    return f"{HOME}/{path[2:] if path.startswith('./') else path}"


def refuse_file_user(user: Optional[str], metadata: Optional[Dict[str, str]] = None) -> None:
    if user is not None and user != "user":
        raise NotSupportedException(f'File access as the user "{user}"',
                                    "Runtime's file calls act as the sandbox owner; use commands.run('sudo ...').")
    if metadata:
        raise NotSupportedException("File metadata (user.e2b.* extended attributes)",
                                    "Keep the metadata beside the file, for example in a JSON file.")


_PERMS = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"]
_TYPES = {"file": FileType.FILE, "directory": FileType.DIR, "symlink": FileType.SYMLINK}


def _date(value: Any) -> datetime:
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return datetime.fromtimestamp(0, tz=timezone.utc)


def entry_info(entry: Dict[str, Any]) -> EntryInfo:
    try:
        raw_mode = entry.get("mode", 0)
        mode = int(raw_mode, 8) if isinstance(raw_mode, str) else int(raw_mode)
    except (ValueError, TypeError):
        mode = 0
    bits = mode & 0o777
    return EntryInfo(name=entry.get("name", ""), type=_TYPES.get(entry.get("type", "")), path=entry["path"],
                     size=int(entry.get("size", 0)), mode=mode,
                     permissions=_PERMS[(bits >> 6) & 7] + _PERMS[(bits >> 3) & 7] + _PERMS[bits & 7],
                     owner=entry.get("owner", ""), group=entry.get("group", ""),
                     modified_time=(datetime.fromtimestamp(entry["mtimeMs"] / 1000, tz=timezone.utc)
                                    if "mtimeMs" in entry else _date(entry.get("modifiedAt"))),
                     symlink_target=entry.get("symlinkTarget"))


def to_bytes(data: Any) -> bytes:
    if isinstance(data, str):
        return data.encode()
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    if hasattr(data, "read"):
        content = data.read()
        return content.encode() if isinstance(content, str) else bytes(content)
    raise InvalidArgumentException(f"Cannot write {type(data).__name__}; pass str, bytes or a file object.")


def simple_state(state: str) -> str:
    if state in ("paused", "pausing"):
        return "paused"
    if state in ("stopped", "stopping"):
        return "stopped"
    return "running"


def sandbox_info(info: Dict[str, Any]) -> SandboxInfo:
    template = info.get("image") or info.get("snapshot") or "base"
    state = simple_state(info.get("state", ""))
    return SandboxInfo(
        sandbox_id=info["id"], sandbox_domain=None, template_id=template, name=info.get("name"),
        metadata=dict(info.get("labels") or {}), started_at=_date(info.get("createdAt")),
        end_at=_date(info.get("expiresAt")), state="paused" if state == "stopped" else state,
        cpu_count=int(info.get("vcpu", 0)), memory_mb=int(info.get("memoryMiB", 0)), envd_version="runtime",
        lifecycle=SandboxInfoLifecycle(on_timeout="kill" if info.get("onLeaseEnd") == "stop" else "pause",
                                       auto_resume=info.get("autoWake") is True))


def seconds_later(info: Dict[str, Any], timeout: float) -> float:
    """How many seconds past the current end ``now + timeout`` is."""
    return time.time() + timeout - _date(info.get("expiresAt")).timestamp()


def list_filter(query: Optional[SandboxQuery], limit: Optional[int], next_token: Optional[str],
                order: Optional[str]) -> Dict[str, Any]:
    query = query or SandboxQuery()
    if query.template is not None and query.template not in STOCK_TEMPLATES:
        raise NotSupportedException("Listing by template",
                                    "Filter by metadata instead: give sandboxes a metadata key when you create them.")
    if query.started_after is not None:
        raise NotSupportedException("Listing by start time (started_after)",
                                    "List them all and filter on get_info().started_at.")
    if order == "desc":
        raise NotSupportedException("Newest-first listing (order='desc')",
                                    "Runtime lists oldest first; reverse the list yourself.")
    if next_token is not None:
        raise NotSupportedException("Starting a list from a saved next_token",
                                    "Keep the paginator and call next_items() again.")
    states = query.state or ["running", "paused"]
    out: Dict[str, Any] = {"state": [s for one in states for s in (RUNNING if one == "running" else PAUSED)]}
    if query.metadata:
        out["labels"] = dict(query.metadata)
    if limit:
        out["limit"] = min(limit, 100)
    return out


def file_timeout(error: BaseException) -> BaseException:
    try:
        from httpx import ReadTimeout
    except ImportError:
        return TimeoutException(str(error) or "The file transfer timed out")
    return ReadTimeout(str(error) or "The file transfer timed out")


def translate(error: BaseException, subject: str = "other") -> BaseException:
    """A Runtime SDK error as the E2B exception code written for E2B expects."""
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)):
        return file_timeout(error) if subject == "file_http" else TimeoutException(str(error) or "The request deadline expired")
    if not isinstance(error, _SDKError):
        return error
    parts = [error.message]
    if error.hint:
        parts.append(f"Hint: {error.hint}")
    if error.request_id:
        parts.append(f"Request: {error.request_id}")
    message = "\n".join(parts)
    status, code = error.status, error.code or ""
    out: BaseException
    if status == 503 and code.endswith("_unavailable"):
        out = NotSupportedException(code[: -len("_unavailable")], error.hint or "", message)
    elif status in (401, 403):
        out = AuthenticationException(message)
    elif code == "file_not_found" or (status == 404 and subject in ("file", "file_http")):
        out = FileNotFoundException(message)
    elif status == 404 and subject == "sandbox":
        out = SandboxNotFoundException(message)
    elif status == 404:
        out = NotFoundException(message)
    elif status == 429:
        out = RateLimitException(message)
    elif re.search(r"space|disk_full|no_room", code):
        out = NotEnoughSpaceException(message)
    elif status in (400, 413, 422):
        out = InvalidArgumentException(message)
    elif status == 503:
        out = ServiceBusyException(message)
    elif code in ("command_timeout", "request_timeout"):
        out = file_timeout(error) if subject == "file_http" else TimeoutException(message)
    else:
        out = SandboxException(message)
    if isinstance(out, SandboxException) and status:
        out.status_code = status
    for name, value in (("code", code), ("hint", error.hint), ("request_id", error.request_id)):
        if value is not None:
            setattr(out, name, value)
    out.__cause__ = error
    return out


def unsupported(feature: str, alternative: str) -> Callable[..., Any]:
    def refuse(*_: Any, **__: Any) -> Any:
        raise NotSupportedException(feature, alternative)
    return refuse


class class_method_variant:  # noqa: N801 - E2B's own name for the same idea
    """A method that works on an instance, or on the class with a sandbox id
    first (``Sandbox.kill(sandbox_id)``), as E2B's methods do."""

    def __init__(self, class_method_name: str) -> None:
        self._name = class_method_name
        self._method: Optional[Callable[..., Any]] = None

    def __call__(self, method: Callable[..., Any]) -> "class_method_variant":
        self._method = method
        return self

    def __get__(self, obj: Any, objtype: Any = None) -> Any:
        if obj is None:
            return getattr(objtype, self._name)
        assert self._method is not None
        return self._method.__get__(obj, objtype)
