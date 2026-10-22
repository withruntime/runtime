"""modal.enable_output: while it is on, image builds print their log lines as
they are written, as Modal's prints a build's progress."""
from __future__ import annotations
import contextlib
import contextvars
import sys

_ON = contextvars.ContextVar("withruntime_modal_output", default=False)


@contextlib.contextmanager
def enable_output():
    token = _ON.set(True)
    try:
        yield
    finally:
        _ON.reset(token)


def _show(line):
    text = line.get("text", "")
    sys.stdout.write(text if text.endswith("\n") else text + "\n")
    sys.stdout.flush()


def build_log():
    """The on_log for an image build: a printer under enable_output, else None."""
    return _show if _ON.get() else None
