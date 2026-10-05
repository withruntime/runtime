"""What the sync and async Daytona adapters share: Daytona's errors and data
classes, and the rules that map a Daytona call onto Runtime's SDK. Nothing
here does I/O."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Union

from .._errors import RuntimeError as _SDKError

# ---- errors: Daytona's names and parents ---------------------------------


class DaytonaError(Exception):
    """Base class for Daytona's errors. One made from a Runtime answer also
    carries Runtime's ``code``, ``hint`` and ``request_id``."""

    def __init__(self, message: str = "", status_code: Optional[int] = None, headers: Any = None,
                 error_code: Optional[str] = None, source: Optional[str] = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.headers = headers or {}
        self.error_code = error_code
        self.code = error_code
        self.source = source
        self.hint: Optional[str] = None
        self.request_id: Optional[str] = None


class DaytonaBadRequestError(DaytonaError):
    pass


class DaytonaAuthenticationError(DaytonaError):
    pass


class DaytonaForbiddenError(DaytonaError):
    pass


class DaytonaNotFoundError(DaytonaError):
    pass


class DaytonaTimeoutError(DaytonaError):
    pass


class DaytonaConflictError(DaytonaError):
    pass


class DaytonaGoneError(DaytonaError):
    pass


class DaytonaUnprocessableEntityError(DaytonaError):
    pass


class DaytonaRateLimitError(DaytonaError):
    pass


class DaytonaInternalServerError(DaytonaError):
    pass


class DaytonaBadGatewayError(DaytonaError):
    pass


class DaytonaServiceUnavailableError(DaytonaError):
    pass


class DaytonaValidationError(DaytonaBadRequestError):
    pass


class DaytonaAuthorizationError(DaytonaForbiddenError):
    pass


class DaytonaConnectionError(DaytonaError):
    pass


class DaytonaFileNotFoundError(DaytonaNotFoundError):
    pass


class DaytonaProcessExecutionTimeoutError(DaytonaTimeoutError):
    pass


class DaytonaProcessNotFoundError(DaytonaNotFoundError):
    pass


class DaytonaSessionEndedError(DaytonaGoneError):
    pass


class DaytonaCommandAlreadyCompletedError(DaytonaGoneError):
    pass


class DaytonaGitAuthFailedError(DaytonaAuthenticationError):
    pass


class DaytonaGitRepoNotFoundError(DaytonaNotFoundError):
    pass


class DaytonaGitBranchNotFoundError(DaytonaNotFoundError):
    pass


class DaytonaGitBranchExistsError(DaytonaConflictError):
    pass


class DaytonaGitPushRejectedError(DaytonaConflictError):
    pass


class DaytonaGitMergeConflictError(DaytonaConflictError):
    pass


class NotSupportedError(DaytonaError):
    """A call Daytona supports and Runtime does not, or not the same way.
    Raised before anything is done. ``feature`` names what was asked;
    ``alternative`` says what to use on Runtime."""

    def __init__(self, feature: str, alternative: str, message: Optional[str] = None) -> None:
        super().__init__(message or f"{feature} is not supported on Runtime. {alternative}",
                         error_code="not_supported")
        self.feature = feature
        self.alternative = alternative


_BY_STATUS = {400: DaytonaBadRequestError, 401: DaytonaAuthenticationError, 403: DaytonaForbiddenError,
              404: DaytonaNotFoundError, 408: DaytonaTimeoutError, 409: DaytonaConflictError, 410: DaytonaGoneError,
              413: DaytonaBadRequestError, 422: DaytonaUnprocessableEntityError, 429: DaytonaRateLimitError,
              500: DaytonaInternalServerError, 502: DaytonaBadGatewayError, 503: DaytonaServiceUnavailableError,
              504: DaytonaTimeoutError}


def translate(error: BaseException, subject: str = "other") -> BaseException:
    """A Runtime SDK error as the Daytona error code written for Daytona expects."""
    if not isinstance(error, _SDKError):
        return error
    parts = [error.message]
    if error.hint:
        parts.append(f"Hint: {error.hint}")
    if error.request_id:
        parts.append(f"Request: {error.request_id}")
    message = "\n".join(parts)
    status, code = error.status, error.code or ""
    out: DaytonaError
    if status == 503 and code.endswith("_unavailable"):
        out = NotSupportedError(code[: -len("_unavailable")], error.hint or "", message)
    elif code == "file_not_found" or (status == 404 and subject == "file"):
        out = DaytonaFileNotFoundError(message)
    elif status == 404 and subject == "process":
        out = DaytonaProcessNotFoundError(message)
    elif code == "command_timeout":
        out = DaytonaProcessExecutionTimeoutError(message)
    elif not status:
        out = DaytonaConnectionError(message)
    else:
        out = _BY_STATUS.get(status, DaytonaError)(message)
    if status:
        out.status_code = status
    if not isinstance(out, NotSupportedError):
        out.code = out.error_code = code
    out.hint, out.request_id = error.hint, error.request_id
    out.__cause__ = error
    return out


def unsupported(feature: str, alternative: str) -> Callable[..., Any]:
    def refuse(*_: Any, **__: Any) -> Any:
        raise NotSupportedError(feature, alternative)
    return refuse


# ---- configuration and parameters ------------------------------------------


class CodeLanguage(str, Enum):
    PYTHON = "python"
    TYPESCRIPT = "typescript"
    JAVASCRIPT = "javascript"


class SandboxState(str, Enum):
    STARTED = "started"
    STARTING = "starting"
    STOPPING = "stopping"
    STOPPED = "stopped"
    PAUSED = "paused"
    DESTROYING = "destroying"
    DESTROYED = "destroyed"


@dataclass
class DaytonaConfig:
    """Daytona's client options. ``api_key`` must be a Runtime key
    (``rtcloud_...``); a Daytona key is never sent. ``api_url`` and
    ``server_url`` are ignored: this package talks only to Runtime."""

    api_key: Optional[str] = None
    jwt_token: Optional[str] = None
    organization_id: Optional[str] = None
    api_url: Optional[str] = None
    server_url: Optional[str] = None
    target: Optional[str] = None
    otel_enabled: Optional[bool] = None
    connection_pool_maxsize: Optional[int] = None
    use_deprecated_polling: Optional[bool] = None


@dataclass
class Resources:
    cpu: Optional[int] = None
    memory: Optional[int] = None
    """GiB."""
    disk: Optional[int] = None
    """GiB."""
    gpu: Optional[int] = None
    gpu_type: Any = None


@dataclass
class VolumeMount:
    volume_id: str
    mount_path: str
    subpath: Optional[str] = None


@dataclass
class CreateSandboxBaseParams:
    name: Optional[str] = None
    language: Optional[str] = None
    os_user: Optional[str] = None
    user: Optional[str] = None
    env_vars: Optional[Dict[str, str]] = None
    labels: Optional[Dict[str, str]] = None
    public: Optional[bool] = None
    timeout: Optional[float] = None
    auto_stop_interval: Optional[int] = None
    auto_pause_interval: Optional[int] = None
    auto_archive_interval: Optional[int] = None
    auto_delete_interval: Optional[int] = None
    ttl_minutes: Optional[int] = None
    volumes: Optional[List[VolumeMount]] = None
    network_block_all: Optional[bool] = None
    network_allow_list: Optional[str] = None
    domain_allow_list: Optional[str] = None
    outbound_proxy_url: Optional[str] = None
    otel_endpoint_override: Optional[str] = None
    ephemeral: Optional[bool] = None
    spot: Optional[bool] = None
    linked_sandbox: Optional[str] = None
    secrets: Optional[Dict[str, str]] = None


@dataclass
class CreateSandboxFromSnapshotParams(CreateSandboxBaseParams):
    snapshot: Optional[str] = None
    resources: Optional[Resources] = None


@dataclass
class CreateSandboxFromImageParams(CreateSandboxBaseParams):
    image: Any = None
    """A registry reference, or an Image."""
    resources: Optional[Resources] = None


@dataclass
class CreateSnapshotParams:
    name: str
    image: Any
    resources: Optional[Resources] = None
    entrypoint: Optional[List[str]] = None
    region_id: Optional[str] = None


@dataclass
class ListSandboxesQuery:
    """Daytona's list filters. ``limit`` is the page size: every match is
    listed. ``id`` and ``name`` are prefixes, any case."""
    limit: Optional[int] = None
    name: Optional[str] = None
    labels: Optional[Dict[str, str]] = None
    states: Optional[List[str]] = None
    id: Optional[str] = None
    snapshots: Optional[List[str]] = None
    targets: Optional[List[str]] = None
    min_cpu: Optional[int] = None
    max_cpu: Optional[int] = None
    min_memory_gib: Optional[int] = None
    max_memory_gib: Optional[int] = None
    min_disk_gib: Optional[int] = None
    max_disk_gib: Optional[int] = None
    is_public: Optional[bool] = None
    is_recoverable: Optional[bool] = None
    created_at_after: Any = None
    created_at_before: Any = None
    last_activity_after: Any = None
    last_activity_before: Any = None
    auto_destroy_at_after: Any = None
    auto_destroy_at_before: Any = None
    sort: Any = None
    """name, cpu, memoryGib, diskGib, lastActivityAt or createdAt."""
    order: Any = None
    """asc, or desc (the default when sorting)."""


# ---- results ------------------------------------------------------------------


@dataclass
class ExecutionArtifacts:
    stdout: str = ""
    charts: Optional[List[Any]] = None


@dataclass
class ExecuteResponse:
    """``result`` is the command's stdout and stderr together, in order."""

    exit_code: int
    result: str
    artifacts: Optional[ExecutionArtifacts] = None


@dataclass
class CodeRunParams:
    argv: Optional[List[str]] = None
    env: Optional[Dict[str, str]] = None


@dataclass
class SessionExecuteRequest:
    command: str
    run_async: Optional[bool] = None
    var_async: Optional[bool] = None
    suppress_input_echo: Optional[bool] = False


@dataclass
class SessionExecuteResponse:
    cmd_id: Optional[str] = None
    output: Optional[str] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    exit_code: Optional[int] = None


@dataclass
class SessionCommandLogsResponse:
    output: Optional[str] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None


@dataclass
class Command:
    id: str
    command: str
    exit_code: Optional[int] = None


@dataclass
class Session:
    session_id: str
    commands: List[Command] = field(default_factory=list)


@dataclass
class FileInfo:
    name: str
    is_dir: bool
    size: int
    mod_time: str
    mode: str
    permissions: str
    owner: str = ""
    """Runtime's listing does not say who owns a file: always ""."""
    group: str = ""


@dataclass
class Match:
    file: str
    line: int
    content: str


@dataclass
class ReplaceResult:
    file: Optional[str] = None
    success: Optional[bool] = None
    error: Optional[str] = None


@dataclass
class SearchFilesResponse:
    files: List[str]


@dataclass
class FileUpload:
    source: Union[bytes, str]
    destination: str


@dataclass
class FileDownloadRequest:
    source: str
    destination: Optional[str] = None


@dataclass
class FileDownloadResponse:
    source: str
    result: Union[bytes, str, None] = None
    error: Optional[str] = None


@dataclass
class GitStatus:
    current_branch: str
    ahead: int = 0
    behind: int = 0
    branch_published: bool = False
    file_status: List[Dict[str, str]] = field(default_factory=list)


@dataclass
class GitCommitResponse:
    sha: str


@dataclass
class ListBranchResponse:
    branches: List[str]


@dataclass
class PortPreviewUrl:
    """For a private preview, send ``token`` as the ``x-runtime-preview-token``
    header (Daytona's is x-daytona-preview-token). "" when public."""

    url: str
    token: str
    sandbox_id: str = ""
    port: int = 0


@dataclass
class OutputMessage:
    output: str


@dataclass
class ExecutionError:
    name: str
    value: str
    traceback: Optional[str] = None


@dataclass
class ExecutionResult:
    stdout: str = ""
    stderr: str = ""
    error: Optional[ExecutionError] = None


@dataclass
class InterpreterContext:
    id: str
    cwd: str
    language: str = "python"
    active: bool = True


@dataclass
class Snapshot:
    """A Daytona snapshot: on Runtime, an image."""

    id: str
    name: str
    image_name: str
    state: str
    size: Optional[float] = None
    error_reason: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class PaginatedSnapshots:
    items: List[Snapshot]
    total: int
    page: int
    total_pages: int


@dataclass
class Volume:
    id: str
    name: str
    state: str
    created_at: str = ""
    error_reason: Optional[str] = None


# ---- rules ------------------------------------------------------------------------

DEFAULT_CPU, DEFAULT_MEMORY_GIB, DEFAULT_DISK_GIB = 1, 1, 3
"""Daytona's default machine (checked 23 September 2026)."""
DEFAULT_AUTO_STOP_MINUTES = 15
HOME = "/workspace"
DAYTONA_HOME = "/home/daytona"
HOME_LINK = f"[ -e {DAYTONA_HOME} ] || sudo ln -s {HOME} {DAYTONA_HOME}"
LONGEST_MS = 86_400_000


def whole_output(_text: str) -> None:
    """Given to exec as an output callback so it streams and returns the whole
    output: an exec with no callback returns at most 64 KiB of each stream."""


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
STOCK_SNAPSHOT = re.compile(r"^daytona(io)?[-/:]|^daytona$")
LANGUAGE_LABEL = "code-toolbox-language"
"""Daytona's label for a sandbox's code language."""
USER_LABEL = "compat.daytona-user"
"""The Linux user given at create, so get() and list() run as it too."""
OWNER = ("daytona", "runtime")
"""The sandbox owner's names: Daytona's and Runtime's."""
USER_NAME = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
USER_READY = ('id -u "$1" >/dev/null 2>&1 || exit 3; [ "$1" = root ] || '
              '{ sudo usermod -aG runtime "$1" && sudo chmod 2775 /workspace; }')
"""Readies a new sandbox for create's user: it must be in the image, as on
Daytona. It joins the owner's group, and the working directory gives that
group what is made in it, so both may change each other's files."""


def chosen_user(params: Any) -> Optional[str]:
    """create's user when it is not the sandbox owner."""
    user = getattr(params, "os_user", None) or getattr(params, "user", None)
    return None if user is None or user in OWNER else user


def missing_user(user: str, exit_code: Optional[int], stderr: str) -> "DaytonaError":
    if exit_code == 3:
        return DaytonaValidationError(
            f'The user "{user}" does not exist in this sandbox\'s image. Add it to the image (RUN useradd -m {user}), '
            "or leave user out to run as the sandbox owner, who has passwordless sudo.", 400)
    return DaytonaError(f'The sandbox could not be readied for the user "{user}": '
                        f"{stderr.strip() or f'exit {exit_code}'}", 400)


def run_as(user: Optional[str], argv: List[str], env: Optional[Dict[str, str]]) -> tuple:
    """A command and its environment as Runtime runs them: as given for the
    sandbox owner; for another user through sudo, its environment carried on
    the command line (sudo resets it) and umask 002, so files it makes in the
    shared working directory stay writable by the owner's group."""
    if not user:
        return argv, env or None
    pairs = [f"{name}={value}" for name, value in (env or {}).items()]
    return ["sudo", "-u", user, "-H", "--", "env", *pairs, "sh", "-c", 'umask 002; exec "$@"', "sh", *argv], None


# ---- PTY sessions: Daytona's terminals over processes started with a PTY ------

PTY_TAG = "daytona-pty:"


def pty_tag(session_id: str) -> str:
    """A session id as one word of the shell's command line, found again by
    list_pty_sessions in any client."""
    import base64
    return PTY_TAG + base64.urlsafe_b64encode(session_id.encode()).decode().rstrip("=")


def pty_of(command: Any) -> Optional[tuple]:
    """(id, cols, rows) of a PTY session's shell, or None for another process."""
    import base64
    words = str(command or "").split()
    for index, word in enumerate(words):
        if word.startswith(PTY_TAG):
            encoded = word[len(PTY_TAG):]
            session_id = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
            size = re.fullmatch(r"(\d+)x(\d+)", words[index + 1] if index + 1 < len(words) else "")
            return session_id, int(size.group(1)) if size else 80, int(size.group(2)) if size else 24
    return None


@dataclass
class PtySize:
    """A terminal's size."""
    rows: int
    cols: int


@dataclass
class PtyResult:
    """How a PTY session ended: its exit code, or why there is none."""
    exit_code: Optional[int] = None
    error: Optional[str] = None


@dataclass
class PtySessionInfo:
    id: str
    cwd: str
    envs: Dict[str, str]
    cols: int
    rows: int
    created_at: str
    active: bool
    lazy_start: bool = False


# ---- computer use: Daytona's shapes over Runtime's desktop ------------------------


@dataclass
class ScreenshotRegion:
    x: int
    y: int
    width: int
    height: int


@dataclass
class ScreenshotOptions:
    show_cursor: Optional[bool] = None
    fmt: Optional[str] = None
    quality: Optional[int] = None
    scale: Optional[float] = None


@dataclass
class MousePosition:
    """Daytona's MousePositionResponse, MouseClickResponse and MouseDragResponse."""
    x: Optional[int] = None
    y: Optional[int] = None


@dataclass
class ScreenshotResponse:
    screenshot: Optional[str] = None
    """The image, base64."""
    size_bytes: Optional[int] = None
    cursor_position: Optional[MousePosition] = None


@dataclass
class DisplayInfo:
    id: Optional[int] = None
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    is_active: Optional[bool] = None


@dataclass
class DisplayInfoResponse:
    displays: List[DisplayInfo] = field(default_factory=list)


@dataclass
class WindowInfo:
    id: Optional[int] = None
    title: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    is_active: Optional[bool] = None


@dataclass
class WindowsResponse:
    windows: List[WindowInfo] = field(default_factory=list)


@dataclass
class Recording:
    id: str
    file_name: str
    file_path: str
    start_time: str
    status: str
    end_time: Optional[str] = None
    size_bytes: Optional[int] = None
    duration_seconds: Optional[float] = None


@dataclass
class ListRecordingsResponse:
    recordings: List[Recording] = field(default_factory=list)


@dataclass
class ComputerUseStartResponse:
    message: Optional[str] = None
    status: Optional[Dict[str, Any]] = None


ComputerUseStopResponse = ComputerUseStartResponse


@dataclass
class ComputerUseStatusResponse:
    status: Optional[str] = None


DESKTOP_KEYS = {"enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape",
                "backspace": "BackSpace", "delete": "Delete", "del": "Delete", "tab": "Tab", "space": "space",
                "up": "Up", "down": "Down", "left": "Left", "right": "Right", "home": "Home", "end": "End",
                "pageup": "Prior", "pagedown": "Next", "insert": "Insert", "capslock": "Caps_Lock",
                "control": "ctrl", "ctrl": "ctrl", "shift": "shift", "alt": "alt", "cmd": "super",
                "command": "super", "meta": "super", "win": "super", "super": "super"}


def desktop_key(key: str) -> str:
    """A Daytona key name (enter, esc, ctrl, cmd, pageup, f5) as xdotool's;
    anything else, such as xdotool's own names, passes as given."""
    name = key.strip()
    lower = name.lower()
    if lower in DESKTOP_KEYS:
        return DESKTOP_KEYS[lower]
    if re.fullmatch(r"f([1-9]|1[0-2])", lower):
        return lower.upper()
    return name


def mouse_button(button: str) -> str:
    if button not in ("left", "middle", "right"):
        raise ValueError(f'button is "left", "middle" or "right", not {button!r}.')
    return button


_RECORDING_STATUS = {"starting": "recording", "installing": "recording", "recording": "recording",
                     "finished": "completed", "failed": "failed"}


def recording_of(recording: Dict[str, Any]) -> Recording:
    from datetime import datetime, timezone
    start = recording.get("startedAt")
    seconds = recording.get("seconds")
    status = _RECORDING_STATUS.get(recording.get("state", ""), recording.get("state", ""))

    def iso(ms: float) -> str:
        stamp = datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds")
        return stamp.replace("+00:00", "Z")
    path = str(recording.get("path") or "")
    return Recording(id=recording["id"], file_name=path.rsplit("/", 1)[-1], file_path=path,
                     start_time=iso(start) if start else "", status=status,
                     end_time=iso(start + seconds * 1000) if start and seconds is not None and status != "recording"
                     else None,
                     size_bytes=recording.get("bytes"), duration_seconds=seconds)


def region_refused() -> "NotSupportedError":
    return NotSupportedError("Screenshots of part of the screen",
                             "Take the whole screen with take_full_screen() or take_compressed() and crop it yourself.")


def screenshot_format(options: Optional[ScreenshotOptions]) -> tuple:
    """The desktop's screenshot format and quality for Daytona's options."""
    options = options or ScreenshotOptions()
    if options.show_cursor:
        raise NotSupportedError("Drawing the cursor into a screenshot (show_cursor)",
                                "Take it without; sandbox.computer_use.mouse.get_position() says where the cursor is.")
    if options.scale is not None and options.scale != 1:
        raise NotSupportedError("Scaling a screenshot", "Take it at full size and scale it yourself, or start the "
                                "desktop smaller: sandbox.withruntime.desktop.start(width=..., height=...).")
    fmt = (options.fmt or "png").lower()
    if fmt not in ("png", "jpeg", "jpg"):
        raise NotSupportedError(f"Screenshots as {fmt}", 'Use fmt "png" or "jpeg".')
    return ("png", None) if fmt == "png" else ("jpeg", options.quality)


def save_local(local_path: str, data: bytes) -> None:
    folder = os.path.dirname(os.path.abspath(local_path))
    os.makedirs(folder, exist_ok=True)
    with open(local_path, "wb") as out:
        out.write(data)


def png_size(png: bytes) -> tuple:
    """Width and height from a PNG's header."""
    import struct
    if len(png) < 24 or png[12:16] != b"IHDR":
        raise ValueError("The desktop's screenshot was not a PNG.")
    return struct.unpack(">II", png[16:24])


# ---- list filters and sorting, applied here: Runtime filters by labels and state

LIST_REFUSED = {"snapshots": "Filter by a label you set at create.",
                "is_public": "Runtime previews are public or private per port: filter by a label you set at create.",
                "auto_destroy_at_after": "Filter by a label you set at create, or narrow the result yourself.",
                "auto_destroy_at_before": "Filter by a label you set at create, or narrow the result yourself."}
LIST_SORTS = {
    "name": lambda one: str(one.info.get("name") or one.id),
    "cpu": lambda one: int(one.info.get("vcpu") or 0),
    "memoryGib": lambda one: int(one.info.get("memoryMiB") or 0) / 1024,
    "diskGib": lambda one: int(one.info.get("diskMiB") or 0) / 1024,
    "lastActivityAt": lambda one: _date_seconds(one.info.get("lastActiveAt") or one.info.get("readyAt")
                                                or one.info.get("createdAt")),
    "createdAt": lambda one: _date_seconds(one.info.get("createdAt")),
}


def check_list(query: "ListSandboxesQuery") -> None:
    if query.limit is not None and query.limit < 1:
        raise DaytonaValidationError("limit must be a positive integer", 400)
    for name, alternative in LIST_REFUSED.items():
        if getattr(query, name) is not None:
            raise NotSupportedError(f"Listing sandboxes by {name}", alternative)
    sort = getattr(query.sort, "value", query.sort)
    if sort is not None and sort not in LIST_SORTS:
        raise ValueError(f"sort is one of {', '.join(LIST_SORTS)}, not {sort!r}.")
    order = getattr(query.order, "value", query.order)
    if order is not None and order not in ("asc", "desc"):
        raise ValueError(f'order is "asc" or "desc", not {order!r}.')


def arrange(found: List[Any], query: "ListSandboxesQuery") -> List[Any]:
    """Daytona's filters past labels and state, then its sort: descending
    unless ``order`` says; unsorted lists keep Runtime's order, oldest first."""
    def stamp(value: Any) -> Optional[float]:
        if value is None:
            return None
        return value.timestamp() if hasattr(value, "timestamp") else _date_seconds(str(value))

    def within(value: float, low: Any, high: Any) -> bool:
        return (low is None or value >= low) and (high is None or value <= high)

    kept = [one for one in found
            if (query.id is None or one.id.lower().startswith(query.id.lower()))
            and (query.name is None or str(one.info.get("name") or one.id).lower().startswith(query.name.lower()))
            and (query.targets is None or "us" in query.targets)
            and (query.is_recoverable is None or query.is_recoverable is False)
            and within(int(one.info.get("vcpu") or 0), query.min_cpu, query.max_cpu)
            and within(int(one.info.get("memoryMiB") or 0) / 1024, query.min_memory_gib, query.max_memory_gib)
            and within(int(one.info.get("diskMiB") or 0) / 1024, query.min_disk_gib, query.max_disk_gib)
            and within(_date_seconds(one.info.get("createdAt")), stamp(query.created_at_after),
                       stamp(query.created_at_before))
            and within(LIST_SORTS["lastActivityAt"](one), stamp(query.last_activity_after),
                       stamp(query.last_activity_before))]
    sort = getattr(query.sort, "value", query.sort)
    order = getattr(query.order, "value", query.order)
    if sort is None:
        return list(reversed(kept)) if order == "desc" else kept
    return sorted(kept, key=LIST_SORTS[sort], reverse=order != "asc")
MARK = "\x1e"
TAG = "daytona-session:"
PRELUDE = ("__rt_run() { eval \"$(printf %s \"$1\" | base64 -d)\"; __rt_c=$?; "
           "printf '\\036RT%s:%s\\036' \"$2\" \"$__rt_c\"; printf '\\036RT%s\\036' \"$2\" >&2; return $__rt_c; }\n")
"""Each session command is one line to the session's bash, which bash reads
whole before running it, so input sent later reaches the command. The command
travels base64-encoded through eval, keeping the shell's directory and
variables; the markers say where its output ends and what it exited with."""
GIT_HELPER = 'credential.helper=!f() { echo "username=$GIT_USER"; echo "password=$GIT_PASS"; }; f'


def _date_seconds(value: Any) -> float:
    """An ISO 8601 time as epoch seconds; 0 when there is none."""
    if not isinstance(value, str) or not value:
        return 0.0
    from datetime import datetime
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def pick_key(explicit: Optional[str]) -> Optional[str]:
    """A Runtime key given, then RUNTIME_API_KEY, then DAYTONA_API_KEY when
    it holds a Runtime key. A Daytona key is never sent anywhere."""
    if explicit and explicit.startswith("rtcloud_"):
        return explicit
    runtime_key = os.environ.get("RUNTIME_API_KEY")
    if runtime_key:
        return runtime_key
    if explicit:
        raise DaytonaAuthenticationError(
            "The api_key passed is a Daytona API key, and it was not sent. Set RUNTIME_API_KEY to a Runtime key "
            "(https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the Runtime key "
            "as api_key.")
    variable = os.environ.get("DAYTONA_API_KEY")
    return variable if variable and variable.startswith("rtcloud_") else None


def check_config(config: Optional[DaytonaConfig]) -> None:
    config = config or DaytonaConfig()
    if config.jwt_token is not None:
        raise NotSupportedError("Daytona JWT sign-in (jwt_token)",
                                "Use a Runtime key: set RUNTIME_API_KEY, or run `npx withruntime login` once.")
    target = config.target or os.environ.get("DAYTONA_TARGET")
    if target and target != "us":
        raise NotSupportedError(f'The Daytona target "{target}"',
                                'Runtime runs in one US region; remove target or use "us".')


def resolve_path(path: str) -> str:
    """Relative paths (and ~) resolve from the working directory, /workspace."""
    if path in ("", "~"):
        return HOME
    if path.startswith("~/"):
        return f"{HOME}/{path[2:]}"
    if path.startswith("/"):
        return path
    rest = path[2:] if path.startswith("./") else ("" if path == "." else path)
    return f"{HOME}/{rest}".rstrip("/") or HOME


def window_seconds(auto_stop_minutes: Optional[float]) -> int:
    """Daytona's autoStopInterval (minutes; 0 is off) as the lease each call
    renews: Runtime's longest lease is an hour."""
    if not auto_stop_minutes or auto_stop_minutes <= 0:
        return 3600
    return int(min(3600, max(60, round(auto_stop_minutes * 60))))


def idle_pause_of(auto_stop_minutes: Optional[float]) -> int:
    """Daytona's autoStopInterval (minutes; 0 is never) as the idle pause of a
    sandbox with no time limit: seconds with nothing happening in it, counted
    by the sandbox itself (idle_pause_seconds, 0 never, at most a day)."""
    if not auto_stop_minutes or auto_stop_minutes <= 0:
        return 0
    return int(min(86_400, max(60, round(auto_stop_minutes * 60))))


def idle_seconds(auto_stop_minutes: Optional[float]) -> float:
    """Daytona's autoStopInterval (minutes; 0 is never) as seconds without a
    call before the sandbox pauses. Past an hour the lease is renewed while
    the sandbox object lives."""
    if not auto_stop_minutes or auto_stop_minutes <= 0:
        return math.inf
    return float(max(60, round(auto_stop_minutes * 60)))


def retention_days(minutes: float) -> int:
    return int(min(365, max(1, math.ceil(minutes / 1440))))


@dataclass
class Lifecycle:
    window_seconds: int
    ephemeral: bool
    auto_stop_interval: int
    auto_archive_interval: int
    auto_delete_interval: int
    deadline: Optional[float] = None
    """Epoch seconds past which the lease is never extended (ttl_minutes)."""
    idle_seconds: Optional[float] = None
    """Seconds without a call before the sandbox pauses; the window when None."""


def lifecycle_of(params: CreateSandboxBaseParams) -> Lifecycle:
    auto_stop = params.auto_pause_interval or (
        DEFAULT_AUTO_STOP_MINUTES if params.auto_stop_interval is None else params.auto_stop_interval)
    auto_delete = 0 if params.ephemeral else (-1 if params.auto_delete_interval is None else params.auto_delete_interval)
    return Lifecycle(window_seconds=window_seconds(auto_stop), ephemeral=auto_delete == 0,
                     auto_stop_interval=auto_stop, auto_archive_interval=params.auto_archive_interval or 10_080,
                     auto_delete_interval=auto_delete,
                     deadline=time.time() + params.ttl_minutes * 60 if params.ttl_minutes else None,
                     idle_seconds=idle_seconds(auto_stop))


REFUSED_CREATE = {
    "spot": ("Spot GPU sandboxes (spot)", "Remove it: Runtime runs sandboxes on CPUs."),
    "linked_sandbox": ("Linked sandboxes (linked_sandbox)",
                       "Run both programs in one sandbox, or connect them through a preview address."),
    "secrets": ("Daytona secrets", "Use a Runtime secret: `npx withruntime secrets set NAME --host api.example.com`. The sandbox sees a placeholder, and the egress proxy adds the value on HTTPS to that host."),
    "otel_endpoint_override": ("Sending sandbox telemetry elsewhere (otel_endpoint_override)",
                               "Remove it: runtime.otel.create() exports every sandbox's events and CPU and memory metrics over OTLP/HTTP."),
}


def refuse_create(params: CreateSandboxBaseParams) -> None:
    for name, (feature, alternative) in REFUSED_CREATE.items():
        if getattr(params, name) is not None:
            raise NotSupportedError(feature, alternative)
    user = params.os_user or params.user
    if user is not None and not USER_NAME.match(user):
        raise DaytonaValidationError(f"Invalid user name {user!r}.", 400)
    if params.language is not None and str(getattr(params.language, "value", params.language)) not in (
            "python", "javascript", "typescript"):
        raise NotSupportedError(f"The language {params.language}",
                                "Use python, javascript or typescript; run anything else with process.exec.")
    if params.auto_stop_interval and params.auto_pause_interval:
        raise DaytonaValidationError("At most one of auto_stop_interval and auto_pause_interval may be non-zero.")
    resources = getattr(params, "resources", None)
    if resources is not None and resources.gpu:
        raise NotSupportedError("GPUs", "Runtime runs sandboxes on CPUs; remove gpu from resources.")


def network_rules(block_all: Optional[bool], cidrs: Optional[str], domains: Optional[str]) -> Optional[Dict[str, Any]]:
    if block_all:
        return {"internet": False}
    allow = [one.strip() for text in (cidrs, domains) for one in (text or "").split(",") if one.strip()]
    return {"internet": True, "allow": allow} if allow else None


def image_name(reference: str) -> str:
    """An image name Runtime accepts: letters, digits, dot, dash and underscore."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", reference)[:128]


def state_of(runtime_state: str, paused_by_pause: bool) -> SandboxState:
    return {
        "running": SandboxState.STARTED, "starting": SandboxState.STARTING, "resuming": SandboxState.STARTING,
        "pausing": SandboxState.STOPPING,
        "paused": SandboxState.PAUSED if paused_by_pause else SandboxState.STOPPED,
        "stopping": SandboxState.DESTROYING,
    }.get(runtime_state, SandboxState.DESTROYED)


RUNTIME_STATES = {"started": ["running"], "starting": ["starting", "resuming"], "stopping": ["pausing"],
                  "stopped": ["paused"], "paused": ["paused"]}

_PERMS = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"]


def file_info(entry: Dict[str, Any]) -> FileInfo:
    try:
        bits = int(str(entry.get("mode", "0")), 8) & 0o777
    except ValueError:
        bits = 0
    kind = {"directory": "d", "symlink": "l"}.get(entry.get("type", ""), "-")
    return FileInfo(name=entry.get("name", ""), is_dir=entry.get("type") == "directory", size=int(entry.get("size", 0)),
                    mod_time=entry.get("modifiedAt", ""),
                    mode=kind + _PERMS[(bits >> 6) & 7] + _PERMS[(bits >> 3) & 7] + _PERMS[bits & 7],
                    permissions=f"0{bits:03o}")


def parse_matches(stdout: str) -> List[Match]:
    out = []
    for line in stdout.splitlines():
        found = re.match(r"^(.*?):(\d+):(.*)$", line)
        out.append(Match(file=found.group(1), line=int(found.group(2)), content=found.group(3)) if found
                   else Match(file=line, line=0, content=""))
    return out


def git_failure(stderr: str, fallback: str) -> DaytonaError:
    message = stderr.strip() or fallback
    if re.search(r"Authentication failed|could not read Username|403", message):
        return DaytonaGitAuthFailedError(message, 401)
    if re.search(r"Repository not found|not found|does not appear to be a git repository", message, re.I):
        return DaytonaGitRepoNotFoundError(message, 404)
    if "already exists" in message:
        return DaytonaGitBranchExistsError(message, 409)
    if re.search(r"did not match any|not a valid|unknown revision", message, re.I):
        return DaytonaGitBranchNotFoundError(message, 404)
    if re.search(r"rejected|non-fast-forward", message):
        return DaytonaGitPushRejectedError(message, 409)
    if re.search(r"CONFLICT|Merge conflict", message):
        return DaytonaGitMergeConflictError(message, 409)
    return DaytonaError(message, 400)


def git_status(stdout: str) -> GitStatus:
    lines = stdout.split("\n")
    head = lines[0] if lines else ""
    branch = re.match(r"^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?", head)
    counts = (branch.group(3) if branch else None) or ""
    ahead = re.search(r"ahead (\d+)", counts)
    behind = re.search(r"behind (\d+)", counts)
    return GitStatus(current_branch=branch.group(1) if branch else "", ahead=int(ahead.group(1)) if ahead else 0,
                     behind=int(behind.group(1)) if behind else 0, branch_published=bool(branch and branch.group(2)),
                     file_status=[{"name": line[3:], "staging": line[:1], "worktree": line[1:2], "extra": ""}
                                  for line in lines[1:] if line])


class SessionCommand:
    """A command sent to a session: its output so far and its exit code."""

    def __init__(self, command_id: str, command: str) -> None:
        self.id, self.command = command_id, command
        self.exit_code: Optional[int] = None
        self.stdout = self.stderr = self.output = ""
        self.listeners: List[Any] = []
        self.task: Any = None

    def emit(self, stream: str, text: str) -> List[Any]:
        """Records ``text``; returns the (callback, text) pairs to call."""
        if not text:
            return []
        setattr(self, stream, getattr(self, stream) + text)
        self.output += text
        return [(listener[0 if stream == "stdout" else 1], text) for listener in self.listeners]

    def describe(self) -> Command:
        return Command(id=self.id, command=self.command, exit_code=self.exit_code)


class MarkerReader:
    """Splits a session's output at one command's end markers."""

    def __init__(self, command_id: str) -> None:
        self.out_mark = f"{MARK}RT{command_id}:"
        self.err_mark = f"{MARK}RT{command_id}{MARK}"
        self.buffer = {"stdout": "", "stderr": ""}
        self.sent = {"stdout": 0, "stderr": 0}
        self.out_done = self.err_done = False
        self.exit_code: Optional[int] = None

    def feed(self, stream: str, data: str) -> str:
        """Takes a chunk; returns the part certainly the command's output."""
        self.buffer[stream] += data
        text = self.buffer[stream]
        if stream == "stdout" and not self.out_done:
            at = text.find(self.out_mark)
            end = -1 if at < 0 else text.find(MARK, at + len(self.out_mark))
            if end >= 0:
                self.exit_code = int(text[at + len(self.out_mark):end])
                self.out_done = True
                return self._take(stream, at)
        elif stream == "stderr" and not self.err_done:
            at = text.find(self.err_mark)
            if at >= 0:
                self.err_done = True
                return self._take(stream, at)
        else:
            return ""
        pending = text.rfind(MARK)
        return self._take(stream, len(text) if pending < 0 else pending)

    def flush(self, stream: str) -> str:
        return self._take(stream, len(self.buffer[stream]))

    def _take(self, stream: str, end: int) -> str:
        start = self.sent[stream]
        self.sent[stream] = max(start, end)
        return self.buffer[stream][start:end]

    @property
    def done(self) -> bool:
        return self.out_done and self.err_done


class Image:
    """Daytona's declarative image, kept as the Dockerfile it stands for and
    built as a Runtime image when a sandbox or snapshot is created from it."""

    def __init__(self, lines: Optional[List[str]] = None) -> None:
        self._lines = list(lines or [])
        self._files: List[tuple] = []
        self._dockerfile_path: Optional[str] = None

    @property
    def dockerfile(self) -> str:
        return "\n".join(self._lines) + "\n"

    @staticmethod
    def base(image: str) -> "Image":
        return Image([f"FROM {image}"])

    @staticmethod
    def debian_slim(python_version: Optional[str] = None) -> "Image":
        version = python_version or "3.12"
        if version not in ("3.9", "3.10", "3.11", "3.12", "3.13"):
            raise NotSupportedError(f"Python {version}", "Use 3.9, 3.10, 3.11, 3.12 or 3.13.")
        return Image([f"FROM python:{version}-slim-bookworm",
                      "RUN apt-get update && apt-get install -y --no-install-recommends gcc gfortran build-essential "
                      "&& rm -rf /var/lib/apt/lists/*",
                      "RUN pip install --upgrade pip"])

    @staticmethod
    def from_dockerfile(path: str) -> "Image":
        image = Image()
        image._dockerfile_path = str(path)
        return image

    def pip_install(self, *packages: Union[str, List[str]], find_links: Optional[List[str]] = None,
                    index_url: Optional[str] = None, extra_index_urls: Optional[List[str]] = None,
                    pre: bool = False, extra_options: str = "") -> "Image":
        names = [one for group in packages for one in ([group] if isinstance(group, str) else group)]
        if not names:
            return self
        flags = ([f"--index-url {index_url}"] if index_url else []) + \
            [f"--extra-index-url {url}" for url in extra_index_urls or []] + \
            [f"--find-links {url}" for url in find_links or []] + (["--pre"] if pre else []) + \
            ([extra_options] if extra_options else [])
        self._lines.append(f"RUN python -m pip install {' '.join(json.dumps(n) for n in names)}"
                           + (f" {' '.join(flags)}" if flags else ""))
        return self

    def pip_install_from_requirements(self, requirements_txt: str, **_: Any) -> "Image":
        remote = f"/.requirements/{hashlib.sha256(str(requirements_txt).encode()).hexdigest()[:12]}.txt"
        self._files.append((str(requirements_txt), remote.lstrip("/")))
        self._lines += [f"COPY {remote.lstrip('/')} {remote}", f"RUN python -m pip install -r {remote}"]
        return self

    def pip_install_from_pyproject(self, *_: Any, **__: Any) -> "Image":
        raise NotSupportedError("Installing from pyproject.toml (pip_install_from_pyproject)",
                                "Export requirements (`uv export > requirements.txt`) and use "
                                "pip_install_from_requirements.")

    def add_local_file(self, local_path: str, remote_path: str) -> "Image":
        source = f"ctx/{len(self._files)}"
        self._files.append((str(local_path), source))
        self._lines.append(f"COPY {source} {remote_path}")
        return self

    def add_local_dir(self, local_path: str, remote_path: str) -> "Image":
        return self.add_local_file(local_path, remote_path)

    def run_commands(self, *commands: Union[str, List[str]]) -> "Image":
        for command in commands:
            self._lines.append(f"RUN {command if isinstance(command, str) else json.dumps(command)}")
        return self

    def env(self, env_vars: Dict[str, str]) -> "Image":
        self._lines += [f"ENV {key}={json.dumps(value)}" for key, value in env_vars.items()]
        return self

    def workdir(self, path: str) -> "Image":
        self._lines.append(f"WORKDIR {path}")
        return self

    def entrypoint(self, commands: List[str]) -> "Image":
        self._lines.append(f"ENTRYPOINT {json.dumps(commands)}")
        return self

    def cmd(self, cmd: List[str]) -> "Image":
        self._lines.append(f"CMD {json.dumps(cmd)}")
        return self

    def dockerfile_commands(self, commands: List[str], *_: Any, **__: Any) -> "Image":
        self._lines += list(commands)
        return self

    def build(self) -> Dict[str, Any]:
        """The Dockerfile, its context files read from the local disk, and a
        name made from both, so the same image is built once."""
        import base64
        from pathlib import Path
        files: List[Dict[str, Any]] = []

        def add(local: str, remote: str) -> None:
            path = Path(local)
            if path.is_dir():
                for child in sorted(p for p in path.rglob("*") if p.is_file()):
                    files.append({"path": f"{remote}/{child.relative_to(path).as_posix()}",
                                  "content": base64.b64encode(child.read_bytes()).decode(), "encoding": "base64"})
            else:
                files.append({"path": remote, "content": base64.b64encode(path.read_bytes()).decode(),
                              "encoding": "base64", "mode": path.stat().st_mode & 0o777})
        dockerfile = self.dockerfile
        if self._dockerfile_path:
            dockerfile = Path(self._dockerfile_path).read_text()
            context = Path(self._dockerfile_path).parent
            for found in re.finditer(r"^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*(.+?)\s+\S+\s*$", dockerfile, re.I | re.M):
                for source in found.group(1).split():
                    if not re.match(r"^[a-z]+://", source):
                        add(str(context / source), source[2:] if source.startswith("./") else source)
        for local, remote in self._files:
            add(local, remote)
        digest = hashlib.sha256(dockerfile.encode())
        for item in files:
            digest.update(item["path"].encode())
            digest.update(item["content"].encode())
        return {"dockerfile": dockerfile, "files": files, "name": f"daytona-image-{digest.hexdigest()[:16]}"}
