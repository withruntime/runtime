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
from typing import IO, Any, Callable, Dict, List, Literal, Optional, TypedDict, Union

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


class GitAuthException(AuthenticationException):
    pass


class GitUpstreamException(SandboxException):
    pass


class BuildException(Exception):
    pass


class FileUploadException(BuildException):
    pass


class VolumeException(Exception):
    pass


class VolumeNotFoundException(NotFoundException):
    """As E2B's: a NotFoundException, not a VolumeException."""


class VolumePathNotFoundException(NotFoundException):
    pass


class SecretException(Exception):
    pass


class SecretNotFoundException(SecretException):
    pass


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
    """Runtime's addition, for ``get_host`` and ``get_public_host``: a sandbox without credit shares a port only privately, so a request needs the port's token,
    and a host name alone cannot carry one. The message says what works."""

    def __init__(self, sandbox_id: str, port: Optional[int], message: Optional[str] = None):
        where = "<port>" if port is None else str(port)
        alternative = (
            f"For an address that works without credit, use sandbox.runtime.previews.create({where})['urlWithToken']: "
            "it carries the token, in a browser, fetch or curl. For other paths on it, send the token as the "
            "x-runtime-preview-token header or the runtime_preview_token query parameter. A public host needs a "
            "paid sandbox, which is the account owner's decision.")
        super().__init__("A public address on a sandbox without credit", alternative, message or (
            f"Sandbox {sandbox_id} runs without credit, where a shared port is private: every request needs the "
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


class WriteEntry(TypedDict):
    """A file for ``files.write_files``: its path and its data, as E2B types it."""

    path: str
    data: Union[str, bytes, IO]


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
"""E2B's default sandbox timeout, in seconds, sent when none is given. It ends
in a pause, which keeps memory and files, since nobody asked for the sandbox to
end; a pilot account's sandbox is kept running by the server instead."""
MIN_TIMEOUT = 60
"""Runtime's shortest time limit, in seconds."""
LONGEST_TIMEOUT = 86_400
"""E2B's longest sandbox timeout, 24 hours (its Pro plan), in seconds; Runtime's
server keeps a time limit up to the same (0381)."""
TEMPLATE_LABEL = "e2b-template"
"""The label a sandbox carries its E2B template name in, for get_info's
template_id and list's template filter; metadata never shows it."""
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
# Makes E2B's home lead to Runtime's unless the image has its own, and prints
# "same" when /home/user is then /workspace.
HOME_LINK = ("[ -e /home/user ] || sudo ln -s /workspace /home/user || exit 1; "
             "if [ /home/user -ef /workspace ]; then echo same; fi")
RUNNING = ["starting", "running", "resuming"]
PAUSED = ["pausing", "paused"]
_warned_short = False


E2B_MAX_CONNECTIONS = 4096
"""Connections the adapter's own client may hold at once: E2B's SDK has no cap
of its own, so an orchestrator that drives a thousand sandboxes from one
process runs every command at once. 4,096 is the widest room Runtime's edge
gives an address that has used a valid key (api.md, "Limits"); the edge and the
API answer anything past an account's room with a retry, which the client
waits out. Runtime's own SDK keeps 48."""

_warned_queued = False


def warn_queued(max_connections: int) -> None:
    """Said once per process, the first time a call has to wait for a
    connection: E2B never holds a call back, so a caller should hear it."""
    global _warned_queued
    if _warned_queued:
        return
    _warned_queued = True
    import warnings
    warnings.warn(
        f"More than {max_connections} calls and command streams are open at once from this process, so the rest "
        "wait their turn. Pass client=Runtime(max_connections=...) for more.", RuntimeWarning, stacklevel=3)


def pick_key(explicit: Optional[str]) -> Optional[str]:
    """Explicit key, then RUNTIME_API_KEY, then E2B_API_KEY when it holds a
    Runtime key. An E2B key (``e2b_...``) is never sent anywhere."""
    runtime_key = os.environ.get("RUNTIME_API_KEY")
    if explicit is not None and not explicit.startswith("e2b_"):
        return explicit
    if runtime_key:
        _warn_two_keys(runtime_key, os.environ.get("E2B_API_KEY"))
        return runtime_key
    if explicit is not None:
        raise AuthenticationException(
            "The api_key passed is an E2B API key (e2b_...), and it was not sent. Set RUNTIME_API_KEY to a "
            "Runtime key (https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the "
            "Runtime key as api_key.")
    e2b = os.environ.get("E2B_API_KEY")
    if e2b and e2b.startswith("e2b_"):
        # Never a quiet fall back to a saved login, which may be another account.
        raise AuthenticationException(
            "E2B_API_KEY holds an E2B API key (e2b_...), and it was not sent. Set RUNTIME_API_KEY to a Runtime "
            "key (https://withruntime.com/account/keys, or run `npx withruntime login`), or put the Runtime key "
            "in E2B_API_KEY.")
    return e2b or None


_warned_two_keys = False


def _warn_two_keys(runtime_key: str, e2b: Optional[str]) -> None:
    """Said once per process: RUNTIME_API_KEY wins, as in Runtime's own SDK,
    but code written for E2B means E2B_API_KEY, so two different Runtime keys
    are likely two accounts, and the wrong one fails later as a missing image
    (5 October 2026)."""
    global _warned_two_keys
    if not e2b or e2b.startswith("e2b_") or e2b == runtime_key or _warned_two_keys:
        return
    _warned_two_keys = True
    warnings.warn(
        "RUNTIME_API_KEY and E2B_API_KEY hold different Runtime keys, which may be different accounts; this "
        "package uses RUNTIME_API_KEY. Unset one, or set both to the same key.", RuntimeWarning, stacklevel=5)


def key_source(explicit: Optional[str]) -> str:
    """Where the key in use came from, as an error names it."""
    if explicit is not None and not explicit.startswith("e2b_"):
        return "api_key"
    if os.environ.get("RUNTIME_API_KEY"):
        return "RUNTIME_API_KEY"
    if os.environ.get("E2B_API_KEY"):
        return "E2B_API_KEY"
    return "the saved login"


def account_of(me: Optional[Dict[str, Any]], source: Optional[str]) -> str:
    """" in the account …" for a missing image: the account's name and where
    its key came from, which a key of another account explains."""
    if not me:
        return ""
    name = me.get("orgName") or me.get("orgId")
    return f' in the account "{name}"' + (f" (key: {source})" if source else "")


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


def timeout_seconds(timeout: Union[int, float]) -> int:
    """Runtime's time limit for ``timeout``, in whole seconds: at least a
    minute (with a warning once), at most 24 hours. The server keeps it."""
    global _warned_short
    check_timeout(timeout)
    seconds = math.ceil(timeout)
    if seconds < MIN_TIMEOUT:
        if not _warned_short:
            _warned_short = True
            warnings.warn(f"timeout {timeout} is under Runtime's shortest time limit; the sandbox gets 60 s. "
                          "Call kill() when done.", stacklevel=3)
        return MIN_TIMEOUT
    return seconds


def on_timeout(lifecycle: Optional[Dict[str, Any]], timeout_asked: bool) -> str:
    """What the server does when the time limit runs out. E2B kills: a caller
    that asked for an end (a timeout, or on_timeout "kill") gets a delete, as
    E2B's kill destroys the sandbox. One that asked for nothing gets E2B's 300 s
    default as a pause, which keeps everything, since a sandbox nobody asked to
    end is never ended."""
    if not lifecycle:
        return "delete" if timeout_asked else "pause"
    action = lifecycle.get("on_timeout", "kill")
    if isinstance(action, dict):
        if action.get("keep_memory") is False:
            raise NotSupportedException("A files-only pause (keep_memory=False)",
                                        "Runtime's pause keeps memory and files; leave keep_memory out.")
        action = action.get("action", "kill")
    return "pause" if action == "pause" else "delete"


def image_name_for(template: str) -> str:
    """The Runtime image name an E2B template name stands for: E2B's
    ``team/name:tag`` without the team, since a Runtime account's images are its
    own. ``name``, ``name:tag`` and ``name@version`` are Runtime image names too."""
    return template.rsplit("/", 1)[-1]


def labels_for(metadata: Optional[Dict[str, str]], template: str) -> Dict[str, str]:
    """The labels a create sends: E2B's metadata, and the template it was made
    from, while there is room for it among Runtime's 32 labels."""
    labels = dict(metadata or {})
    if template not in STOCK_TEMPLATES and len(labels) < 32 and len(template) <= 256:
        labels[TEMPLATE_LABEL] = template
    return labels


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


def template_missing(template: str, cause: Optional[BaseException] = None, account: str = "") -> TemplateException:
    """The create's refusal of a template no Runtime image answers to, as E2B's
    TemplateException, saying how to build it and in which account."""
    image = image_name_for(template)
    name = re.sub(r"[:@].*$", "", image)
    error = TemplateException(
        f'No Runtime image is named "{image}"{account}. E2B templates do not run on Runtime; build the same '
        f"environment as a Runtime image with that name and this call starts from it: "
        f"`npx withruntime image build --dockerfile e2b.Dockerfile --name {name}`, or "
        f'runtime.images.build(name="{name}", dockerfile=...).')
    error.code = "template_not_found"
    error.__cause__ = cause
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
    cmd, args = listed_as(info.get("command", ""))
    return ProcessInfo(pid=pid_of(info["id"]), tag=None, cmd=cmd, args=args, envs={}, cwd=info.get("cwd"))


_AS_USER = re.compile(r"^sudo -n -E -H -u [^ ]+ -- /bin/bash -c (?:cd ~ 2>/dev/null\n)?")


def listed_as(command: str) -> tuple:
    """A running command as E2B lists it, from the command line Runtime keeps
    (its words joined by spaces, at most 256 characters): ``/bin/bash -l -c
    <script>`` for a command, ``/bin/bash -i -l`` for a PTY, as E2B starts
    them, whether it runs as the sandbox user or through ``command_as``.
    Anything else, started outside this package, is its first word and the
    rest. (5 October 2026: args were ["-c", "bash -c <script>"].)"""
    wrapped = _AS_USER.match(command)
    if wrapped:
        inner = command[wrapped.end():]
        if inner == "exec /bin/bash -i -l":
            return "/bin/bash", ["-i", "-l"]
        return "/bin/bash", ["-l", "-c", inner]
    if command.startswith("bash -c "):
        return "/bin/bash", ["-l", "-c", command[len("bash -c "):]]
    if command == "/bin/bash -i -l":
        return "/bin/bash", ["-i", "-l"]
    words = command.split(" ")
    return words[0], words[1:]


def absolute(path: str) -> str:
    if path.startswith("/"):
        return path
    return f"{HOME}/{path[2:] if path.startswith('./') else path}"


E2B_HOME = "/home/user"


def shown(path: str, asked: str, linked: bool) -> str:
    """A path as E2B gives it back: one the caller asked for relative to the
    home is shown under /home/user, as E2B shows it, when /home/user leads to
    /workspace (``linked``), so it names the same file. A path the caller gave
    in full comes back as given."""
    if asked.startswith("/") or not linked:
        return path
    if path == HOME:
        return E2B_HOME
    return E2B_HOME + path[len(HOME):] if path.startswith(HOME + "/") else path


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


def command_failure(error: BaseException) -> BaseException:
    """A command's failure as E2B says it: its sandbox going away under it is
    a TimeoutException, which code written for E2B catches (5 October 2026:
    it was a SandboxNotFoundException)."""
    if isinstance(error, SandboxNotFoundException):
        ended = TimeoutException("The command ended before the stream completed: the sandbox was killed or "
                                 "reached its end of life.")
        ended.__cause__ = error
        return ended
    return error


_KIND_LETTER = {"directory": "d", "symlink": "L"}


def e2b_user(name: Optional[str]) -> str:
    """The sandbox user as E2B names it: Runtime's is ``runtime``, E2B's ``user``."""
    return "user" if name == "runtime" else (name or "")


def link_target(path: str, target: str) -> str:
    """A link's target as envd gives it: absolute, a relative one taken from
    the link's own directory."""
    if target.startswith("/"):
        return target
    parts = path.split("/")[:-1]
    for part in target.split("/"):
        if part == "..":
            if parts:
                parts.pop()
        elif part and part != ".":
            parts.append(part)
    return "/" + "/".join(p for p in parts if p)


def written_whole(event: Dict[str, Any]) -> bool:
    """Runtime writes a file whole, by a rename into place, which the watch
    sees as a create; envd writes in place, which is a write. Code written for
    E2B waits for the write (5 October 2026), so a file's create brings one."""
    return event.get("type") == "create" and not event.get("isDir")


def only_directory(target: str, stat: Dict[str, Any]) -> None:
    """envd watches only a directory; Runtime's watch also takes a file."""
    if stat.get("exists") and stat.get("type") != "directory":
        raise InvalidArgumentException(f"{target} is not a directory; watch_dir watches a directory.")


def check_depth(depth: Optional[int]) -> None:
    if depth is not None and depth < 1:
        raise InvalidArgumentException("depth should be at least one")


def entry_info(entry: Dict[str, Any], asked: str, linked: bool = False) -> EntryInfo:
    try:
        raw_mode = entry.get("mode", 0)
        mode = int(raw_mode, 8) if isinstance(raw_mode, str) else int(raw_mode)
    except (ValueError, TypeError):
        mode = 0
    bits = mode & 0o777
    return EntryInfo(name=entry.get("name", ""), type=_TYPES.get(entry.get("type", "")),
                     path=shown(entry["path"], asked, linked),
                     size=int(entry.get("size", 0)), mode=mode,
                     permissions=(_KIND_LETTER.get(entry.get("type", ""), "-") + _PERMS[(bits >> 6) & 7]
                                  + _PERMS[(bits >> 3) & 7] + _PERMS[bits & 7]),
                     owner=e2b_user(entry.get("owner")), group=e2b_user(entry.get("group")),
                     modified_time=(datetime.fromtimestamp(entry["mtimeMs"] / 1000, tz=timezone.utc)
                                    if "mtimeMs" in entry else _date(entry.get("modifiedAt"))),
                     symlink_target=(shown(link_target(entry["path"], entry["symlinkTarget"]), asked, linked)
                                     if entry.get("symlinkTarget") else None))


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


def idle_asleep(info: Dict[str, Any]) -> bool:
    """Whether a paused sandbox is, to code written for E2B, still running:
    Runtime paused it itself for being idle (E2B never does) and the next call
    wakes it, so every E2B call on it works as on a running one."""
    return (simple_state(info.get("state", "")) == "paused" and info.get("stopReason") == "idle"
            and info.get("autoWake") is not False)


def e2b_state(info: Dict[str, Any]) -> str:
    """The sandbox's state as E2B would say it."""
    return "running" if simple_state(info.get("state", "")) == "running" or idle_asleep(info) else "paused"


def end_of(info: Dict[str, Any]) -> datetime:
    """E2B's end_at: when the sandbox ends by itself. One that never will (no
    time limit, as a persistent or a pilot's sandbox) reads 24 hours ahead,
    the furthest an E2B sandbox's end may be, so code that waits until the
    end, or extends near it, behaves as for the longest E2B sandbox.
    (5 October 2026: it read where the sandbox was paid up to, minutes ahead,
    so a pilot's looked about to end.)"""
    if info.get("endsAt"):
        return _date(info["endsAt"])
    if "endsAt" in info and info["endsAt"] is None and e2b_state(info) == "running":
        return datetime.fromtimestamp(time.time() + LONGEST_TIMEOUT, tz=timezone.utc)
    return _date(info.get("expiresAt"))


def sandbox_info(info: Dict[str, Any]) -> SandboxInfo:
    metadata = dict(info.get("labels") or {})
    template = metadata.pop(TEMPLATE_LABEL, None) or info.get("image") or info.get("snapshot") or "base"
    action = info.get("onTimeout") or info.get("onLeaseEnd")
    return SandboxInfo(
        sandbox_id=info["id"], sandbox_domain=None, template_id=template, name=info.get("name"),
        metadata=metadata, started_at=_date(info.get("createdAt")),
        end_at=end_of(info), state=e2b_state(info),
        cpu_count=int(info.get("vcpu", 0)), memory_mb=int(info.get("memoryMiB", 0)), envd_version="runtime",
        lifecycle=SandboxInfoLifecycle(on_timeout="pause" if action == "pause" else "kill",
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
    # Runtime's states are read together and sorted here, since a sandbox
    # Runtime paused for being idle is running to E2B.
    asked = set(query.state or ["running", "paused"])
    server: Dict[str, Any] = {"state": RUNNING + PAUSED}
    if query.metadata:
        server["labels"] = dict(query.metadata)
    local = (query.template is not None or query.started_after is not None or order == "desc"
             or next_token is not None)
    server["limit"] = 100 if local else min(limit or 100, 100)
    return {"server": server, "local": local, "page_size": limit or 100, "offset": token_offset(next_token),
            "template": query.template, "started_after": query.started_after, "order": order,
            "only": next(iter(asked)) if len(asked) == 1 else None}


def token_offset(token: Optional[str]) -> int:
    if token is None:
        return 0
    match = re.match(r"^runtime:(\d+)$", token)
    if not match:
        raise InvalidArgumentException(
            f'"{token}" is not a next_token this package gave; pass the paginator\'s own next_token.')
    return int(match.group(1))


def wanted(info: SandboxInfo, filters: Dict[str, Any]) -> bool:
    """Whether a sandbox is in the one E2B state asked for, if one was."""
    return filters["only"] is None or info.state == filters["only"]


def matching(infos: List[SandboxInfo], filters: Dict[str, Any]) -> List[SandboxInfo]:
    """The sandboxes a local list serves: E2B's state, template and start time,
    in the order asked for."""
    template = filters["template"]
    templates = None if template is None else (
        {"base", *STOCK_TEMPLATES} if template in STOCK_TEMPLATES else {template})
    after = filters["started_after"]
    if after is not None and after.tzinfo is None:
        after = after.replace(tzinfo=timezone.utc)
    kept = [info for info in infos if wanted(info, filters)
            and (templates is None or info.template_id in templates)
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
