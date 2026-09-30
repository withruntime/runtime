"""Go-style command handles matching sprites-py 0.7.1."""
from __future__ import annotations
from .exceptions import ExitError, TimeoutError
from dataclasses import dataclass
from typing import Optional


@dataclass
class CompletedProcess:
    args: list[str]
    returncode: int
    stdout: Optional[bytes] = None
    stderr: Optional[bytes] = None


class Cmd:
    def __init__(self, sprite, args, *, env=None, cwd=None, stdin=None, stdout=None, stderr=None,
                 tty=False, tty_rows=24, tty_cols=80, session_id=None, timeout=None):
        self.sprite, self.args, self.path = sprite, list(args), args[0] if args else ""
        self.env, self.dir, self.stdin, self.stdout, self.stderr = env, cwd, stdin, stdout, stderr
        self.tty, self.tty_rows, self.tty_cols, self.timeout = tty, tty_rows, tty_cols, timeout
        self._started, self._finished, self._exit_code = False, False, -1
        self.session_id, self._process = session_id, None

    @property
    def exit_code(self):
        return self._exit_code

    def set_tty(self, enable):
        if self._started:
            raise RuntimeError("cannot set TTY after process started")
        self.tty = enable

    def set_tty_size(self, rows, cols):
        self.tty_rows, self.tty_cols = rows, cols

    def _execute(self):
        if self._started:
            raise RuntimeError("command already started")
        if not self.args and not self.session_id:
            raise ValueError("A command is required")
        self._started = True
        try:
            sb = self.sprite._sandbox()
            if self.tty or self.session_id or self.stdout is not None or self.stderr is not None:
                from ._stream import stream
                result = stream(self, sb)
            else:
                from ._capture import capture
                data = self.stdin.read() if self.stdin is not None else None
                result = capture(sb, self.args, env=self.env, cwd=self.dir, stdin=data,
                    timeout_ms=int(self.timeout * 1000) if self.timeout and self.timeout > 0 else None)
        finally:
            self._finished = True
        self._exit_code = result.exit_code
        if result.timed_out:
            raise TimeoutError(f"command timed out after {self.timeout}s")
        if self._exit_code != 0:
            raise ExitError(f"exit status {self._exit_code}", self._exit_code, result.stdout, result.stderr)
        return result

    def run(self):
        try:
            self._execute()
        except ExitError as error:
            raise ExitError(str(error), error.exit_code(), b"", error.stderr) from error

    def output(self):
        if self.stdout is not None:
            raise RuntimeError("stdout already set")
        return self._execute().stdout

    def combined_output(self):
        if self.stdout is not None or self.stderr is not None:
            raise RuntimeError("stdout or stderr already set")
        try:
            result = self._execute()
        except ExitError as error:
            raise ExitError(str(error), error.exit_code(), error.stdout + error.stderr, b"") from error
        return result.stdout + result.stderr
