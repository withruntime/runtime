"""Internal per-call limits, isolated by thread/task and never stored on clients."""
from contextlib import contextmanager
from contextvars import ContextVar
import math
import time

_UNSET = object()


class Limits:
    """Immutable, and a plain class: dataclasses costs every ``import withruntime``
    inspect and tokenize."""
    __slots__ = ("deadline", "override_timeout", "idle_timeout", "connect_timeout")

    def __init__(self, deadline=None, override_timeout=False, idle_timeout=_UNSET, connect_timeout=_UNSET):
        for name, value in zip(self.__slots__, (deadline, override_timeout, idle_timeout, connect_timeout)):
            object.__setattr__(self, name, value)

    def __setattr__(self, name, value):
        raise AttributeError("Limits are immutable")

    @property
    def configured(self):
        return self.override_timeout or self.idle_timeout is not _UNSET

    def remaining(self):
        if self.deadline is None:
            return None
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("The request deadline expired")
        return remaining

    def timeout(self, default):
        value = None if self.override_timeout else default
        if self.idle_timeout is not _UNSET:
            value = self.idle_timeout or None
        remaining = self.remaining()
        return value if remaining is None else remaining if value is None else min(value, remaining)


_limits = ContextVar("runtime_request_limits", default=Limits())


def current():
    return _limits.get()


def _validate(value, name):
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                              or not math.isfinite(value) or value < 0):
        raise ValueError(f"{name} must be a nonnegative finite number")


def limits(timeout=None, idle_timeout=_UNSET, connect_timeout=_UNSET):
    _validate(timeout, "request_timeout")
    if idle_timeout is not _UNSET:
        _validate(idle_timeout, "stream_idle_timeout")
    if connect_timeout is not _UNSET:
        _validate(connect_timeout, "connect_timeout")
    parent = current()
    deadline = time.monotonic() + timeout if timeout else None
    if parent.deadline is not None:
        deadline = parent.deadline if deadline is None else min(deadline, parent.deadline)
    return Limits(deadline, timeout is not None or parent.override_timeout,
                  parent.idle_timeout if idle_timeout is _UNSET else idle_timeout,
                  parent.connect_timeout if connect_timeout is _UNSET else connect_timeout)


@contextmanager
def request_scope(timeout=None, idle_timeout=_UNSET, *, connect_timeout=_UNSET, captured=None):
    token = _limits.set(captured if captured is not None else limits(timeout, idle_timeout, connect_timeout))
    try:
        yield current()
    finally:
        _limits.reset(token)


def connection_timeout(default):
    value = current().connect_timeout
    if value is _UNSET or value is None:
        return default
    value = value or None
    return value if default is None else default if value is None else min(default, value)
