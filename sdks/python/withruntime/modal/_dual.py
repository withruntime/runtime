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
