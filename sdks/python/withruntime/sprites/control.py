"""sprites-py's control mode (one WebSocket multiplexing many commands) is not
available on Runtime: each command runs directly. Every member refuses."""
from .._compat import CompatibilityError
from ._features import CONTROL


class OpConn:
    def __init__(self, cc, tty=False):
        raise CompatibilityError(CONTROL)

    async def write(self, data):
        raise CompatibilityError(CONTROL)

    async def send_eof(self):
        raise CompatibilityError(CONTROL)

    async def resize(self, cols, rows):
        raise CompatibilityError(CONTROL)

    async def signal(self, sig):
        raise CompatibilityError(CONTROL)

    def handle_data(self, data):
        raise CompatibilityError(CONTROL)

    def handle_text(self, data):
        raise CompatibilityError(CONTROL)

    def complete(self, exit_code=None):
        raise CompatibilityError(CONTROL)

    def close(self):
        raise CompatibilityError(CONTROL)

    def is_closed(self):
        raise CompatibilityError(CONTROL)

    def get_exit_code(self):
        raise CompatibilityError(CONTROL)

    async def wait(self):
        raise CompatibilityError(CONTROL)

    def get_stdout(self):
        raise CompatibilityError(CONTROL)

    def get_stderr(self):
        raise CompatibilityError(CONTROL)


class ControlConnection:
    def __init__(self, sprite):
        raise CompatibilityError(CONTROL)

    async def connect(self):
        raise CompatibilityError(CONTROL)

    async def start_op(self, op, cmd=None, env=None, dir=None, tty=False, rows=24, cols=80, stdin=True):
        raise CompatibilityError(CONTROL)

    async def close(self):
        raise CompatibilityError(CONTROL)

    def is_closed(self):
        raise CompatibilityError(CONTROL)
