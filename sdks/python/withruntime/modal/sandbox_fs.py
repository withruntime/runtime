"""Sync and .aio forms of the pinned Modal SandboxFilesystem API."""
import functools
from ._dual import Dual, async_only
from ._fs_sync import Filesystem
from ._fs_async import AsyncFilesystem


class SandboxFilesystem:
    def __init__(self, container):
        self._container = container

    def _sync(self):
        if getattr(self._container, "_async_mode", False):
            async_only()
        return Filesystem(self._container._sandbox)

    def _async(self):
        from ._async import _native_async
        return AsyncFilesystem(_native_async(self._container))


def _method(name):
    @functools.wraps(getattr(Filesystem, name))
    def sync(self, *args, **kwargs):
        return getattr(self._sync(), name)(*args, **kwargs)
    @functools.wraps(getattr(AsyncFilesystem, name))
    async def asynchronous(self, *args, **kwargs):
        return await getattr(self._async(), name)(*args, **kwargs)
    return Dual(sync, asynchronous)


for _name in ("read_bytes", "read_text", "write_bytes", "write_text", "copy_from_local", "copy_to_local",
              "make_directory", "remove", "stat", "list_files"):
    setattr(SandboxFilesystem, _name, _method(_name))


def _watch(self, *args, **kwargs):
    yield from self._sync().watch(*args, **kwargs)


async def _watch_async(self, *args, **kwargs):
    async for event in self._async().watch(*args, **kwargs):
        yield event


SandboxFilesystem.watch = Dual(_watch, _watch_async)
