"""The sync method and its native async `.aio` companion share one name."""
from functools import update_wrapper


class _Bound:
    def __init__(self, sync, asynchronous):
        self._sync, self.aio = sync, asynchronous
        update_wrapper(self, sync)

    def __call__(self, *args, **kwargs):
        return self._sync(*args, **kwargs)


class Dual:
    def __init__(self, sync, asynchronous, *, static=False):
        self.sync, self.asynchronous, self.static = sync, asynchronous, static

    def __get__(self, obj, cls=None):
        if self.static:
            return _Bound(self.sync, self.asynchronous)
        return _Bound(self.sync.__get__(obj, cls), self.asynchronous.__get__(obj, cls))


def async_only(*args, **kwargs):
    raise RuntimeError("This handle was created asynchronously; use the method's .aio companion")


def local(sync):
    """An `.aio` for a method that does no I/O, or refuses before any: it runs
    the sync body, so a refusal raises the same error from both forms."""
    async def asynchronous(*args, **kwargs):
        return sync(*args, **kwargs)
    return asynchronous


def install(cls, names, *, static=(), refused=False):
    """Gives each named method of `cls` an `.aio` that runs its sync body. A
    refused method's `.aio` raises when called, so `async with` and `await`
    both see the refusal."""
    for name in names:
        method = cls.__dict__[name]
        function = method.__func__ if isinstance(method, staticmethod) else method
        setattr(cls, name, Dual(function, function if refused else local(function), static=name in static))


class classproperty:
    """modal's `Secret.objects` / `Volume.objects`: read on the class."""

    def __init__(self, getter):
        self._getter = getter

    def __get__(self, obj, cls=None):
        return self._getter(cls)
