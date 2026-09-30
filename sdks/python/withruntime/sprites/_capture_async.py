"""Preserve byte output through files, bypassing the native text event protocol.

Each command owns one random directory; cleanup only removes that directory.
Output is buffered until exit. TTY requires a binary native stream and is rejected.
"""
from dataclasses import dataclass
import uuid
import sys
from .._compat import CompatibilityError


@dataclass
class Captured:
    stdout: bytes
    stderr: bytes
    exit_code: int
    timed_out: bool


# Arguments remain argv entries throughout; none become shell source.
SCRIPT = '''if [ "$2" = 1 ]; then
  (shift 2; exec "$@") < "$1/stdin" > "$1/stdout" 2> "$1/stderr"
else
  (shift 2; exec "$@") < /dev/null > "$1/stdout" 2> "$1/stderr"
fi'''


async def capture(sb, args, *, env=None, cwd=None, timeout_ms=None, stdin=None, tty=False):
    if tty:
        raise CompatibilityError("Sprites TTY requires a binary output transport; use non-TTY buffered commands")
    directory = "/tmp/runtime-sprites-" + uuid.uuid4().hex
    await sb.files.mkdir(directory)
    try:
        # Output files exist even if starting the command or its cwd fails.
        for channel in ("stdout", "stderr"):
            await sb.files.write(directory + "/" + channel, b"", mode=0o600)
        if stdin is not None:
            await sb.files.write(directory + "/stdin", stdin, mode=0o600)
        result = await sb.exec(["bash", "-c", SCRIPT, "runtime-sprites", directory,
                               "1" if stdin is not None else "0", *args],
                              env=env, cwd=cwd, timeout_ms=timeout_ms, on_stdout=lambda part: None)
        stdout = await sb.files.read(directory + "/stdout")
        stderr = await sb.files.read(directory + "/stderr")
        # Wrapper diagnostics (for example a missing executable) belong to stderr.
        if result.stderr:
            stderr += result.stderr.encode()
        return Captured(stdout, stderr, result.exit_code, result.timed_out)
    finally:
        primary = sys.exc_info()[1]
        try:
            await sb.files.remove(directory, recursive=True)
        except Exception as cleanup:
            if primary is None:
                raise
            if hasattr(primary, "add_note"):
                primary.add_note(f"Could not remove command output directory {directory}: {cleanup}")
