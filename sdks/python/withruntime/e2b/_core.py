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
from typing import Any, Callable, Dict, List, Literal, Optional, Union

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


class PublicPreviewNotAllowedException(NotSupportedException):
    """Runtime's addition, for ``get_host`` and ``get_public_host``: a free-trial
    sandbox shares a port only privately, so a request needs the port's token,
    and a host name alone cannot carry one. The message says what works."""

    def __init__(self, sandbox_id: str, port: Optional[int], message: Optional[str] = None):
        where = "<port>" if port is None else str(port)
        alternative = (
            f"For an address that works on the trial, use sandbox.runtime.previews.create({where})['urlWithToken']: "
            "it carries the token, in a browser, fetch or curl. For other paths on it, send the token as the "
            "x-runtime-preview-token header or the runtime_preview_token query parameter. A public host needs a "
            "paid sandbox, which is the account owner's decision.")
        super().__init__("A public address on a free-trial sandbox", alternative, message or (
            f"Sandbox {sandbox_id} runs on the free trial, where a shared port is private: every request needs the "
            f"port's token, and a host name alone cannot carry one. {alternative}"))
        self.code = "public_preview_not_allowed"


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
"""E2B's default sandbox timeout, in seconds. Not sent: a sandbox created with
no timeout has no time limit on Runtime, running while it works and pausing
when idle (0300). Kept for code that imports it."""
MIN_LEASE, MAX_LEASE = 60, 3600
LONGEST_TIMEOUT = 86_400
"""E2B's longest sandbox timeout, 24 hours (its Pro plan), in seconds."""
KEEP_EVERY = 300
"""How often a timeout over an hour has its lease moved on, in seconds."""
KEEP_AHEAD = MAX_LEASE - 30
"""How far ahead a kept lease is moved: under the API's hour, for the clocks and the trip."""
PROCESS_LIFETIME_MS = 86_400_000
"""How long a command may run: a day, E2B's longest sandbox. E2B's own
timeout bounds only the connection."""
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
HttpVersion = Literal["1.1", "2"]
"""E2B's HTTP version (e2b 2.52.0): checked as E2B checks it, then left to
Runtime's SDK, which picks its own transport."""
MAX_FORK_COUNT = 20


def check_http_version(value: Optional[str]) -> None:
    source, version = ("http_version", value) if value is not None else (
        "E2B_HTTP_VERSION", os.getenv("E2B_HTTP_VERSION") or None)
    if version is not None and version not in ("1.1", "2"):
        raise InvalidArgumentException(f"{source} must be '1.1' or '2', got {version!r}")


def check_fork_count(count: Any) -> None:
    """E2B's own bound since 2.52.0, refused before anything happens."""
    if count is None:
        return
    if isinstance(count, bool) or not isinstance(count, int) or count < 1 or count > MAX_FORK_COUNT:
        raise InvalidArgumentException(f"count must be an integer between 1 and {MAX_FORK_COUNT}")


def request_seconds(owner: Any, value: Optional[float]) -> float:
    if value is not None:
        return value
    owner = getattr(owner, "_filesystem", owner)
    owner = getattr(owner, "_sandbox", owner)
    return getattr(owner, "_request_timeout", 60)


def check_connection(opts: Dict[str, Any]) -> None:
    check_http_version(opts.get("http_version"))
    for name, value in opts.items():
        if name == "http_version":
            continue
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


def check_timeout(timeout: Union[int, float]) -> None:
    if timeout is None or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise InvalidArgumentException(f"timeout must be a positive number of seconds, not {timeout}.")
    if timeout > LONGEST_TIMEOUT:
        raise InvalidArgumentException(f"timeout is at most 24 hours (86400 s), as on E2B, not {timeout}.")


def lease_seconds(timeout: Union[int, float]) -> int:
    """The first lease for ``timeout``: up to an hour; a longer timeout is
    carried on from there while the process runs."""
    global _warned_short
    check_timeout(timeout)
    seconds = min(math.ceil(timeout), MAX_LEASE)
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


# ---- E2B's ``user``: "user" (or none) is the sandbox's own user, `runtime`;
# any other user that exists runs through ``sudo -u``. None is ever created.

_USER_NAME = re.compile(r"^[a-z_][a-z0-9_.-]{0,31}$", re.I)
MISSING, NOT_DIRECTORY, IS_DIRECTORY, EXISTS = 44, 45, 46, 47
WRITE_CHUNK = 786_432
"""Base64 text per exec: under the 1 MiB an exec's input may carry."""
FIND_FIELDS = "%y\\0%s\\0%m\\0%u\\0%g\\0%T@\\0%p\\0%l\\0"


def other_user(user: Optional[str]) -> Optional[str]:
    """The user to run as, or None for the sandbox's own; a bad name is refused."""
    if user is None or user == "user":
        return None
    if not isinstance(user, str) or not _USER_NAME.match(user):
        raise InvalidArgumentException(f'"{user}" is not a Linux user name.')
    return user


def no_such_user(user: str) -> InvalidArgumentException:
    return InvalidArgumentException(
        f'This sandbox has no user "{user}", and Runtime never creates one for you. Make it first, as root: '
        f'sandbox.commands.run("useradd -m {user}", user="root"). "user" is the sandbox\'s own user and "root" is root.')


def command_as(user: str, script: str, cwd_given: bool) -> List[str]:
    """``bash -c script`` as ``user``, keeping the environment Runtime gives the
    command; without a cwd it starts in the user's home, as E2B's does."""
    return ["sudo", "-n", "-E", "-H", "-u", user, "--", "/bin/bash", "-c",
            script if cwd_given else f"cd ~ 2>/dev/null\n{script}"]


def shell_as(user: str, cwd_given: bool) -> List[str]:
    return command_as(user, "exec /bin/bash -i -l", cwd_given)


def user_script(user: str, text: str, *args: str) -> List[str]:
    """One ``sh -c`` script as ``user``, its arguments passed apart, never pasted in."""
    return ["sudo", "-n", "-u", user, "--", "/bin/sh", "-c", text, "sh", *args]


USER_FILE_SCRIPTS = {
    "read": f'[ -e "$1" ] || exit {MISSING}; [ -d "$1" ] && exit {IS_DIRECTORY}; exec base64 -w 0 -- "$1"',
    "write": 'mkdir -p -- "$(dirname -- "$1")" && base64 -d > "$1"',
    "append": 'base64 -d >> "$1"',
    "list": (f'[ -e "$1" ] || exit {MISSING}; [ -d "$1" ] || exit {NOT_DIRECTORY}; '
             f'exec find "$1" -mindepth 1 -maxdepth "$2" -printf \'{FIND_FIELDS}\''),
    "stat": f'[ -e "$1" ] || [ -L "$1" ] || exit {MISSING}; exec find "$1" -maxdepth 0 -printf \'{FIND_FIELDS}\'',
    "exists": '[ -e "$1" ] || [ -L "$1" ]',
    "make_dir": f'[ -d "$1" ] && exit {EXISTS}; mkdir -p -- "$1"',
    "rename": f'[ -e "$1" ] || [ -L "$1" ] || exit {MISSING}; mv -fT -- "$1" "$2"',
    "remove": 'rm -rf -- "$1"',
}


def user_file_failure(user: str, path: str, exit_code: Optional[int], stderr: str) -> BaseException:
    if exit_code == MISSING:
        return FileNotFoundException(f"{path} does not exist.")
    if exit_code == NOT_DIRECTORY:
        return InvalidArgumentException(f"{path} is not a directory.")
    if exit_code == IS_DIRECTORY:
        return InvalidArgumentException(f"{path} is a directory.")
    return SandboxException(f'As the user "{user}": {stderr.strip() or f"exit status {exit_code}"}')


_FIND_TYPES = {"f": "file", "d": "directory", "l": "symlink"}


def found_entries(output: str) -> List[Dict[str, Any]]:
    """``find -printf`` output, eight NUL-ended fields an entry, as the files API's entries."""
    fields = output.split("\0")
    out = []
    for i in range(0, len(fields) - 7, 8):
        kind, size, mode, owner, group, mtime, path, link = fields[i:i + 8]
        entry: Dict[str, Any] = {
            "name": [part for part in path.split("/") if part][-1] if path.strip("/") else path,
            "path": path, "type": _FIND_TYPES.get(kind, "other"), "size": int(size or 0), "mode": f"0{mode}",
            "mtimeMs": round(float(mtime or 0) * 1000), "owner": owner, "group": group}
        if kind == "l" and link:
            entry["symlinkTarget"] = link
        out.append(entry)
    return out


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
    other_user(user)
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
        # With no time limit, where it is paid up to: always ahead, moving on.
        end_at=_date(info.get("endsAt") or info.get("expiresAt")), state="paused" if state == "stopped" else state,
        cpu_count=int(info.get("vcpu", 0)), memory_mb=int(info.get("memoryMiB", 0)), envd_version="runtime",
        lifecycle=SandboxInfoLifecycle(on_timeout="kill" if info.get("onLeaseEnd") == "stop" else "pause",
                                       auto_resume=info.get("autoWake") is True))


def no_limit(info: Dict[str, Any]) -> bool:
    """Whether the sandbox has no time limit: it renews itself while it works
    (0300), and has no end to move. An older server sends no ``endsAt``."""
    return "endsAt" in info and info["endsAt"] is None


def seconds_later(info: Dict[str, Any], timeout: float) -> float:
    """How many seconds past the current end ``now + timeout`` is."""
    return time.time() + timeout - _date(info.get("endsAt") or info.get("expiresAt")).timestamp()


def list_filter(query: Optional[SandboxQuery], limit: Optional[int], next_token: Optional[str],
                order: Optional[str]) -> Dict[str, Any]:
    """Runtime filters by state and metadata itself; a template, start time,
    newest-first order or a saved next_token are done here (``local``)."""
    query = query or SandboxQuery()
    if limit is not None and (not isinstance(limit, int) or limit < 1):
        raise InvalidArgumentException(f"limit must be a positive whole number, not {limit}.")
    states = query.state or ["running", "paused"]
    server: Dict[str, Any] = {"state": [s for one in states for s in (RUNNING if one == "running" else PAUSED)]}
    if query.metadata:
        server["labels"] = dict(query.metadata)
    local = (query.template is not None or query.started_after is not None or order == "desc"
             or next_token is not None)
    server["limit"] = 100 if local else min(limit or 100, 100)
    return {"server": server, "local": local, "page_size": limit or 100, "offset": token_offset(next_token),
            "template": query.template, "started_after": query.started_after, "order": order}


def token_offset(token: Optional[str]) -> int:
    if token is None:
        return 0
    match = re.match(r"^runtime:(\d+)$", token)
    if not match:
        raise InvalidArgumentException(
            f'"{token}" is not a next_token this package gave; pass the paginator\'s own next_token.')
    return int(match.group(1))


def matching(infos: List[SandboxInfo], templates: Optional[set], filters: Dict[str, Any]) -> List[SandboxInfo]:
    after = filters["started_after"]
    if after is not None and after.tzinfo is None:
        after = after.replace(tzinfo=timezone.utc)
    kept = [info for info in infos if (templates is None or info.template_id in templates)
            and (after is None or info.started_at >= after)]
    return sorted(kept, key=lambda info: info.started_at, reverse=filters["order"] == "desc")


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
    elif code == "public_preview_not_allowed":
        # A 403 about the sandbox's funding, not the key.
        out = PublicPreviewNotAllowedException("", None, message)
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
