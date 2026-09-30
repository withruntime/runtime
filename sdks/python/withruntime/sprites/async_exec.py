"""Native async Sprites command handles; cancellation reaches native exec."""
from .exec import Cmd
from .exceptions import ExitError, TimeoutError


class AsyncCmd(Cmd):
    async def _execute(self):
        if self._started:
            raise RuntimeError("command already started")
        if not self.args and not self.session_id:
            raise ValueError("A command is required")
        self._started = True
        try:
            sb = await self.sprite._sandbox()
            if self.tty or self.session_id or self.stdout is not None or self.stderr is not None:
                from ._stream_async import stream
                result = await stream(self, sb)
            else:
                from ._capture_async import capture
                data = self.stdin.read() if self.stdin is not None else None
                result = await capture(sb, self.args, env=self.env, cwd=self.dir, stdin=data,
                    timeout_ms=int(self.timeout * 1000) if self.timeout and self.timeout > 0 else None)
        finally:
            self._finished = True
        self._exit_code = result.exit_code
        if result.timed_out:
            raise TimeoutError(f"command timed out after {self.timeout}s")
        if self._exit_code != 0:
            raise ExitError(f"exit status {self._exit_code}", self._exit_code, result.stdout, result.stderr)
        return result

    async def run(self):
        try:
            await self._execute()
        except ExitError as error:
            raise ExitError(str(error), error.exit_code(), b"", error.stderr) from error

    async def output(self):
        if self.stdout is not None:
            raise RuntimeError("stdout already set")
        return (await self._execute()).stdout

    async def combined_output(self):
        if self.stdout is not None or self.stderr is not None:
            raise RuntimeError("stdout or stderr already set")
        try:
            result = await self._execute()
        except ExitError as error:
            raise ExitError(str(error), error.exit_code(), error.stdout + error.stderr, b"") from error
        return result.stdout + result.stderr
