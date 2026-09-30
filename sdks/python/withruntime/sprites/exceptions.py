"""Sprites execution exception names and attributes (sprites-py 0.7.1)."""


class SpriteError(Exception):
    pass


class ExecError(SpriteError):
    def __init__(self, message, exit_code, stdout=b"", stderr=b""):
        super().__init__(message)
        self._exit_code, self.stdout, self.stderr = exit_code, stdout, stderr

    def exit_code(self):
        return self._exit_code


ExitError = ExecError


class TimeoutError(SpriteError):
    pass


class NetworkError(SpriteError):
    pass
