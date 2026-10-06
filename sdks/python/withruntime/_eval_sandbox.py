"""What withruntime.harbor and withruntime.inspect_ai share: commands and files in
a sandbox as any user, through the sandbox user's passwordless sudo; sizes; and
images built once and found again by a tag.

Private: the two adapters are its only callers."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import re
import shlex
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, Awaitable, Callable, NamedTuple, Optional

from ._async_client import AsyncRuntime, AsyncSandbox
from ._errors import NotFoundError
from ._errors import RuntimeError as RuntimeCloudError

logger = logging.getLogger("withruntime")

# Part of every image tag the adapters build. Change it whenever the image
# builder's version changes (VERSION in
# packages/cloud/deploy/image-build/builder/build-agent.py), so an image built
# by an older builder is not reused. runtime-builder/3 gives uid 1000 sudo in
# images built from a public image (ARCHITECTURE.md section 10, "Root in images
# built from a public image"); images tagged before it may have none.
# runtime-builder/4 (26 September 2026) fixed that sudo's -s, -i and VAR=value.
# runtime-builder/5 (30 September 2026): an image's own /etc/resolv.conf no
# longer shadows the guest's resolver, so Debian and Ubuntu images look up names.
IMAGE_RECIPE = "runtime-builder/5"


def image_tag(key: str) -> str:
    """The tag of the image built from ``key`` (what it is built from) by this recipe."""
    return hashlib.sha256(f"{IMAGE_RECIPE}|{key}".encode()).hexdigest()[:24]



_TRIAL_VCPU, _TRIAL_MEMORY_MIB, _TRIAL_DISK_MIB = 2, 4096, 10_240
_MIN_MEMORY_MIB, _MIN_DISK_MIB = 128, 3072
_TRANSFER_TIMEOUT_S = 600

# Runs as the sandbox user. Arguments: sudo path (empty to run directly), target user,
# working directory, env file, stdin file, stdout file, script file; then the command.
# The redirections belong to the sandbox user, so staged files stay theirs to read and delete.
_LAUNCH = r'''s=$1 u=$2 d=$3 e=$4 i=$5 o=$6 c=$7 t=
shift 7
if [ -n "$e" ]; then set -a; . "$e" || exit 125; set +a; rm -f -- "$e"; fi
if [ -n "$i" ]; then exec < "$i" || exit 125; rm -f -- "$i"; fi
if [ -n "$o" ]; then mkdir -p -- "$(dirname -- "$o")" && exec > "$o" || exit 125; fi
if [ -n "$c" ]; then
  t=$(mktemp) && cat -- "$c" > "$t" && chmod 644 -- "$t" || exit 125
  rm -f -- "$c"; set -- "$@" "$t"
fi
if [ -n "$s" ]; then
  set -- "$s" -n -E -H -u "$u" -- /usr/bin/env "PATH=$PATH" /bin/sh -c 'if [ -n "$1" ]; then cd -- "$1" || exit 1; fi; shift; exec "$@"' sh "$d" "$@"
elif [ -n "$d" ]; then
  cd -- "$d" || exit 1
fi
if [ -n "$t" ]; then "$@"; r=$?; rm -f -- "$t"; exit $r; fi
exec "$@"
'''

_PROBE = r'''u=$(id -u); n=$(id -un 2>/dev/null); s=-
for p in /usr/bin/sudo /bin/sudo; do if [ -x "$p" ]; then s=$p; break; fi; done
if [ "$s" != - ] && ! "$s" -n -E true >/dev/null 2>&1; then s="!$s"; fi
if command -v bash >/dev/null 2>&1; then b=bash; else b=sh; fi
printf '%s\n%s\n%s\n%s\n' "$u" "$n" "$s" "$b"
'''

_READ = r'''if [ -d "$1" ]; then echo "$1: Is a directory" >&2; exit 21; fi
if [ -n "$2" ] && [ -f "$1" ]; then
  n=$(wc -c < "$1") || exit 1
  if [ "$n" -gt "$2" ]; then echo "$1: larger than $2 bytes" >&2; exit 27; fi
fi
exec cat -- "$1"'''

_WRITE = r'''if [ -d "$1" ]; then echo "$1: Is a directory" >&2; exit 21; fi
mkdir -p -- "$(dirname -- "$1")" && cat > "$1" || exit 1
if [ -n "$2" ]; then chmod "$2" -- "$1"; fi'''

_API_ENV_ENTRIES, _API_ENV_VALUE, _API_ENV_BYTES = 60, 32_000, 120_000
_INLINE_STDIN = 768 * 1024
_ARGV_ITEMS, _ARGV_ITEM_BYTES = 100, 16_000
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

OutputHandler = Callable[[str, str], Awaitable[None]]


def shell_exit_code(code: Optional[int], timed_out: bool) -> int:
    """The exit code a shell would report, which Harbor and Inspect expect.

    Runtime's API gives a command killed by a signal as the negative signal number
    (a command past its limit is killed with SIGKILL and reads -9); a shell says 128
    plus the signal, so -15 is 143. A command past its limit is 124, as timeout(1)
    reports it, and one that ended without a code is -1."""
    if timed_out:
        return 124
    if code is None:
        return -1
    code = int(code)
    return 128 - code if code < 0 else code


class _Result(NamedTuple):
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool
    overflow: bool


class MissingSudoError(RuntimeError):
    """The image has no passwordless sudo for the sandbox user."""


def _missing_sudo(sandbox_id: str, user: str, found: str, uid: int = 1000) -> MissingSudoError:
    why = f"{found[1:]} asks for a password" if found.startswith("!") else "the image has no sudo"
    return MissingSudoError(
        f"Runtime sandbox {sandbox_id}: this command must run as {user}, but commands run as the "
        f"sandbox user (uid {uid}) and {why}. Give uid 1000 passwordless sudo in the image, for "
        "example in its Dockerfile: RUN apt-get update && apt-get install -y sudo && "
        "echo '#1000 ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/runtime; then build the image "
        "again (Harbor: --force-build). Runtime's own base image already has it.")


class _Shell:
    """Commands and files in one sandbox, as any user, through the sandbox user's sudo."""

    def __init__(self, sandbox: AsyncSandbox, staging: str) -> None:
        self.sandbox = sandbox
        self.staging = staging
        self.uid = -1
        self.user = ""
        self.sudo = "-"
        self.bash = False

    async def probe(self) -> None:
        result = await self._stream(["/bin/sh", "-c", _PROBE], None, None, 60_000, None, None)
        lines = (result.stdout.splitlines() + ["", "", "", ""])[:4]
        self.uid = int(lines[0]) if lines[0].strip().isdigit() else -1
        self.user, self.sudo, self.bash = lines[1].strip(), lines[2].strip() or "-", lines[3].strip() == "bash"

    @property
    def can_sudo(self) -> bool:
        return self.sudo.startswith("/")

    def target(self, user: Optional[str | int]) -> tuple[str, str]:
        """(sudo path, user for sudo -u), both empty when the sandbox user runs it."""
        if user is None or user == "":
            return "", ""
        text = str(user)
        if isinstance(user, int) or text.isdigit():
            if int(text) == self.uid:
                return "", ""
            name = f"#{int(text)}"
        else:
            if text == self.user or (text == "root" and self.uid == 0):
                return "", ""
            name = text
        if not self.can_sudo:
            raise _missing_sudo(self.sandbox.id, text, self.sudo, self.uid)
        return self.sudo, name

    def _path(self) -> str:
        return f"{self.staging}/{uuid.uuid4().hex}"

    async def _stage(self, data: bytes, staged: list[str]) -> str:
        path = self._path()
        staged.append(path)
        await self.sandbox.files.write(path, data)
        return path

    async def remove(self, path: str) -> None:
        try:
            await self.sandbox.files.remove(path)
        except RuntimeCloudError:
            pass

    async def run(self, argv: list[str], *, user: Optional[str | int] = None, cwd: Optional[str] = None,
                  env: Optional[dict[str, str]] = None, stdin: Optional[bytes] = None,
                  stdin_path: Optional[str] = None, stdout_path: Optional[str] = None,
                  timeout_s: Optional[float] = None, on_output: Optional[OutputHandler] = None,
                  max_output: Optional[int] = None) -> _Result:
        sudo, name = self.target(user)
        staged: list[str] = []
        try:
            api_env: Optional[dict[str, str]] = None
            env_path = ""
            if env:
                sizes = [len(k) + len(v) for k, v in env.items()]
                if len(env) <= _API_ENV_ENTRIES and sum(sizes) <= _API_ENV_BYTES and \
                        all(len(v) <= _API_ENV_VALUE for v in env.values()):
                    api_env = dict(env)
                else:
                    lines = [f"{k}={shlex.quote(v)}" for k, v in env.items() if _NAME.match(k)]
                    skipped = [k for k in env if not _NAME.match(k)]
                    if skipped:
                        logger.warning("Runtime: these variables are not valid shell names and were left out: %s",
                                       ", ".join(skipped))
                    env_path = await self._stage(("\n".join(lines) + "\n").encode(), staged)
            api_stdin: Optional[bytes] = None
            in_path = stdin_path or ""
            if stdin is not None and not in_path:
                if len(stdin) <= _INLINE_STDIN:
                    api_stdin = stdin
                else:
                    in_path = await self._stage(stdin, staged)
            script_path = ""
            if len(argv) > _ARGV_ITEMS or any(len(a.encode()) > _ARGV_ITEM_BYTES for a in argv):
                if len(argv) == 3 and argv[1] == "-c" and argv[0] in ("bash", "sh", "/bin/sh", "/bin/bash"):
                    body, argv = argv[2], [argv[0]]
                else:
                    body, argv = "exec " + " ".join(shlex.quote(a) for a in argv) + "\n", ["/bin/sh"]
                script_path = await self._stage(body.encode(), staged)
            launch = ["/bin/sh", "-c", _LAUNCH, "runtime", sudo, name, cwd or "", env_path, in_path,
                      stdout_path or "", script_path, *argv]
            timeout_ms = None if timeout_s is None else max(1000, min(86_400_000, int(timeout_s * 1000)))
            return await self._stream(launch, api_env, api_stdin, timeout_ms, on_output, max_output)
        finally:
            for path in staged:
                await self.remove(path)

    async def _stream(self, argv: list[str], env: Optional[dict[str, str]], stdin: Optional[bytes],
                      timeout_ms: Optional[int], on_output: Optional[OutputHandler],
                      max_output: Optional[int]) -> _Result:
        """Streams, whatever the timeout: a command that is not streamed keeps only 64 KiB of each stream."""
        for attempt in (0, 1):
            chunks: dict[str, list[str]] = {"stdout": [], "stderr": []}
            sizes = {"stdout": 0, "stderr": 0}
            overflow, started, exit_event = False, False, {}
            try:
                async for event in self.sandbox.exec_stream(argv, env=env, stdin=stdin, timeout_ms=timeout_ms):
                    started = True
                    kind = event.get("type")
                    if kind in ("stdout", "stderr"):
                        data = event.get("data", "")
                        if on_output is not None:
                            await on_output(data, kind)
                        if max_output is not None and sizes[kind] + len(data) > max_output:
                            overflow = True
                            data = data[:max(0, max_output - sizes[kind])]
                        sizes[kind] += len(data)
                        chunks[kind].append(data)
                    elif kind == "truncated":
                        overflow = True
                    elif kind == "exit":
                        exit_event = event
                timed_out = bool(exit_event.get("timedOut"))
                return _Result(shell_exit_code(exit_event.get("exitCode"), timed_out), "".join(chunks["stdout"]),
                               "".join(chunks["stderr"]), timed_out, overflow)
            except RuntimeCloudError as error:
                if attempt == 0 and not started and error.code == "sandbox_paused":
                    await self.sandbox.wake()
                    continue
                raise
        raise AssertionError("unreachable")

    async def read(self, path: str, *, user: Optional[str | int], max_bytes: Optional[int] = None) -> bytes:
        staging = self._path()
        try:
            result = await self.run(["/bin/sh", "-c", _READ, "sh", path, "" if max_bytes is None else str(max_bytes)],
                                    user=user, stdout_path=staging, timeout_s=_TRANSFER_TIMEOUT_S)
            if result.exit_code != 0:
                raise _file_error(path, result)
            return await self.sandbox.files.read(staging)
        finally:
            await self.remove(staging)

    async def write(self, path: str, data: bytes, *, user: Optional[str | int], mode: Optional[int] = None) -> None:
        staging = self._path()
        try:
            await self.sandbox.files.write(staging, data)
            result = await self.run(["/bin/sh", "-c", _WRITE, "sh", path, "" if mode is None else format(mode, "o")],
                                    user=user, stdin_path=staging, timeout_s=_TRANSFER_TIMEOUT_S)
            if result.exit_code != 0:
                raise _file_error(path, result)
        finally:
            await self.remove(staging)


class FileTooLargeError(OSError):
    pass


def _file_error(path: str, result: _Result) -> OSError:
    message = (result.stderr or result.stdout).strip() or f"exit code {result.exit_code}"
    lowered = message.lower()
    if result.exit_code == 21 or "is a directory" in lowered:
        return IsADirectoryError(21, f"Is a directory: {path}")
    if result.exit_code == 27:
        return FileTooLargeError(27, f"File too large: {path}")
    if "no such file" in lowered or "not found" in lowered:
        return FileNotFoundError(2, f"No such file or directory: {path}")
    if "permission denied" in lowered or "operation not permitted" in lowered or "read-only" in lowered:
        return PermissionError(13, f"Permission denied: {path} ({message})")
    return OSError(f"{path}: {message}")


def _sizes(cpus: Optional[int], memory_mb: Optional[int], storage_mb: Optional[int],
           trial: bool) -> tuple[dict[str, int], list[str]]:
    """Harbor's resources as Runtime's create fields, and what had to change."""
    fields: dict[str, int] = {}
    notes: list[str] = []
    if cpus is not None:
        fields["vcpu"] = max(1, int(math.ceil(cpus)))
    if memory_mb is not None:
        fields["memory_mib"] = max(_MIN_MEMORY_MIB, int(memory_mb))
    if storage_mb is not None:
        disk = int(storage_mb)
        if disk < _MIN_DISK_MIB:
            notes.append(f"disk {disk} MiB raised to the smallest, {_MIN_DISK_MIB} MiB")
            disk = _MIN_DISK_MIB
        fields["disk_mib"] = disk
    if trial:
        for key, most, unit in (("vcpu", _TRIAL_VCPU, "vCPU"), ("memory_mib", _TRIAL_MEMORY_MIB, "MiB of memory"),
                                ("disk_mib", _TRIAL_DISK_MIB, "MiB of disk")):
            if fields.get(key, 0) > most:
                notes.append(f"{fields[key]} {unit} cut to {most}, the most without credit")
                fields[key] = most
    return fields, notes


def dockerfile_workdir(dockerfile: Path) -> Optional[str]:
    """The last stage's WORKDIR, resolved like Docker's (variables are left as written)."""
    try:
        text = dockerfile.read_text(errors="replace")
    except OSError:
        return None
    text = re.sub(r"\\\r?\n", " ", text)
    workdir: Optional[str] = None
    for raw in text.splitlines():
        parts = raw.strip().split(None, 1)
        if not parts or parts[0].startswith("#"):
            continue
        instruction = parts[0].upper()
        if instruction == "FROM":
            workdir = None
        elif instruction == "WORKDIR" and len(parts) > 1:
            value = parts[1].strip().strip('"').strip("'")
            if value.startswith("[") and value.endswith("]"):
                value = value[1:-1].strip().strip('"')
            workdir = value if value.startswith("/") else str(PurePosixPath(workdir or "/") / value)
    return workdir


def image_name(prefix: str, label: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", label).strip("-._") or "task"
    return f"{prefix}-{cleaned}"[:100].rstrip("-._")


_IMAGE_LOCKS: dict[str, asyncio.Lock] = {}


async def ensure_image(runtime: AsyncRuntime, name: str, tag: str, source: dict[str, Any], *, rebuild: bool,
                       build: Optional[dict[str, Any]] = None, labels: Optional[dict[str, str]] = None,
                       on_log: Optional[Callable[[dict[str, Any]], Any]] = None) -> str:
    """The id of the ready image ``name:tag``, built from ``source`` when there is none or ``rebuild``."""
    ref = f"{name}:{tag}"
    lock = _IMAGE_LOCKS.setdefault(ref, asyncio.Lock())
    async with lock:
        if not rebuild:
            try:
                image = await runtime.images.resolve(ref)
                if image.get("state") == "ready":
                    return image["id"]
            except NotFoundError:
                pass
        image = await runtime.images.build(name=name, tags=[tag], no_start=True, labels=labels, build=build,
                                           cache=False if rebuild else None, on_log=on_log, **source)
        return image["id"]
