"""modal.stream_type: where a process's stdout or stderr goes."""
from __future__ import annotations
import subprocess
from enum import Enum


class StreamType(Enum):
    # Discard all output from the stream.
    DEVNULL = subprocess.DEVNULL
    # Keep it to be read from the process's stream (the default).
    PIPE = subprocess.PIPE
    # Print it to this program's stdout as it arrives.
    STDOUT = subprocess.STDOUT

    def __repr__(self):
        return f"modal.stream_type.{self.__class__.__name__}.{self.name}"


def checked(value, name):
    if not isinstance(value, StreamType):
        raise TypeError(f"{name} must be a modal.stream_type.StreamType, got {value!r}")
    return value
