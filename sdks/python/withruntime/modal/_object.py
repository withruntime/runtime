"""What every modal object has: its id once hydrated, its client, hydrate()."""
from .._compat import CompatibilityError
from ._dual import Dual

CONSOLE = "https://withruntime.com/account"


class _Object:
    _object_id = None
    _client = None

    @property
    def object_id(self):
        if self._object_id is None:
            raise AttributeError(f"Attempting to get object_id of unhydrated {type(self).__name__}")
        return self._object_id

    @property
    def client(self):
        if self._client is None:
            raise AttributeError(f"Attempting to get client of unhydrated {type(self).__name__}")
        return self._client

    def get_dashboard_url(self):
        raise CompatibilityError(f"Runtime has no console page for a {type(self).__name__}; "
                                 f"sandboxes and images have theirs at {CONSOLE}")

    def hydrate(self, client=None):
        from .. import Runtime
        runtime = client or self._client or Runtime()
        self._load(runtime)
        self._client = runtime
        return self

    def _load(self, runtime):
        """Resolves the object on Runtime; nothing to do for a local value."""

    async def _load_aio(self, runtime):
        """The async form of `_load`."""


async def _hydrate_aio(self, client=None):
    from .. import AsyncRuntime
    runtime = client or self._client or AsyncRuntime()
    await self._load_aio(runtime)
    self._client = runtime
    return self


async def _dashboard_aio(self):
    return self.get_dashboard_url()


_Object.hydrate = Dual(_Object.hydrate, _hydrate_aio)
_Object.get_dashboard_url = Dual(_Object.get_dashboard_url, _dashboard_aio)
