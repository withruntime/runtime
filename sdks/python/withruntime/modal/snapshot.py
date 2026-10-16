"""modal.SandboxSnapshot as a native Runtime snapshot."""
from __future__ import annotations
from .._errors import NotFoundError as NativeNotFound
from ._dual import Dual
from ._object import _Object
from .exception import NotFoundError


class SandboxSnapshot(_Object):
    def __init__(self, snapshot_id, client=None):
        self._snapshot_id, self._client = snapshot_id, client

    def _found(self, info):
        self._object_id = info["id"]

    def _load(self, runtime):
        if self._object_id is None:
            try:
                self._found(runtime.snapshots.get(self._snapshot_id))
            except NativeNotFound as error:
                raise NotFoundError(f"Sandbox snapshot {self._snapshot_id} not found") from error

    async def _load_aio(self, runtime):
        if self._object_id is None:
            try:
                self._found(await runtime.snapshots.get(self._snapshot_id))
            except NativeNotFound as error:
                raise NotFoundError(f"Sandbox snapshot {self._snapshot_id} not found") from error

    @staticmethod
    def from_id(sandbox_snapshot_id, client=None):
        return SandboxSnapshot(sandbox_snapshot_id, client).hydrate(client)


async def _from_id_aio(sandbox_snapshot_id, client=None):
    return await SandboxSnapshot(sandbox_snapshot_id, client).hydrate.aio(client)


SandboxSnapshot.from_id = Dual(SandboxSnapshot.__dict__["from_id"].__func__, _from_id_aio, static=True)
