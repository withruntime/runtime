"""modal.io_streams: a process's output streams and its stdin."""
from . import _Reader as StreamReader, _Writer as StreamWriter

__all__ = ["StreamReader", "StreamWriter"]
