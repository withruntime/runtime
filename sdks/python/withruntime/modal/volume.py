"""modal.Volume as a native Runtime volume, mounted when a sandbox is created."""
from __future__ import annotations
from .._compat import CompatibilityError
from .._errors import NotFoundError as NativeNotFound
from ._dual import classproperty, install
from ._object import _Object
from .exception import NotFoundError

FIXED_SIZE = "Runtime volumes have a fixed size: create one with runtime.volumes.create(size_mib, name=...)"
IN_SANDBOX = "mount the volume in a sandbox (Sandbox.create(volumes={path: volume})) and use its filesystem"


class Volume(_Object):
    def __init__(self, *, name=None, volume_id=None, create_if_missing=False, read_only=False, client=None):
        self._name, self._lookup_id = name, volume_id
        self._create_if_missing, self._read_only, self._client = create_if_missing, read_only, client

    def _copy(self, read_only):
        copy = Volume(name=self._name, volume_id=self._lookup_id, create_if_missing=self._create_if_missing,
                      read_only=read_only, client=self._client)
        copy._object_id = self._object_id
        return copy

    def _found(self, volumes):
        live = [one for one in volumes if one.get("name") == self._name and one.get("state") not in ("deleted", "deleting")]
        if not live:
            if self._create_if_missing:
                raise CompatibilityError(FIXED_SIZE)
            raise NotFoundError(f"Volume '{self._name}' not found")
        self._object_id = live[0]["id"]

    def _load(self, runtime):
        if self._object_id is not None:
            return
        if self._lookup_id is not None:
            try:
                self._object_id = runtime.volumes.get(self._lookup_id)["id"]
            except NativeNotFound as error:
                raise NotFoundError(f"Volume '{self._lookup_id}' not found") from error
            return
        self._found(list(runtime.volumes.list(name=self._name)))

    async def _load_aio(self, runtime):
        if self._object_id is not None:
            return
        if self._lookup_id is not None:
            try:
                self._object_id = (await runtime.volumes.get(self._lookup_id))["id"]
            except NativeNotFound as error:
                raise NotFoundError(f"Volume '{self._lookup_id}' not found") from error
            return
        self._found([one async for one in await runtime.volumes.list(name=self._name)])

    def _mount(self, path):
        """The native create's `volumes` entry, once loaded."""
        return {"volume_id": self._object_id, "path": path, **({"mode": "snapshot"} if self._read_only else {})}

    @property
    def name(self):
        return self._name

    @classproperty
    def objects(cls):
        raise CompatibilityError("Manage volumes with the native runtime.volumes (create, list, delete)")

    @staticmethod
    def from_name(name, *, environment_name=None, create_if_missing=False, version=None, create_options=None,
                  client=None):
        if environment_name is not None:
            raise CompatibilityError("Modal environment namespaces are not Runtime account namespaces")
        if version is not None or create_options is not None:
            raise CompatibilityError(FIXED_SIZE)
        return Volume(name=name, create_if_missing=create_if_missing, client=client)

    @staticmethod
    def from_id(volume_id, client=None):
        return Volume(volume_id=volume_id, client=client)

    @staticmethod
    def ephemeral(client=None, environment_name=None, version=None, create_options=None, _heartbeat_sleep=300):
        raise CompatibilityError(FIXED_SIZE)

    def read_only(self):
        return self._copy(True)

    def with_mount_options(self, *, read_only=None, sub_path=None):
        if sub_path is not None:
            raise CompatibilityError("Runtime mounts a whole volume: mount it and use the subfolder's path")
        return self._copy(self._read_only if read_only is None else bool(read_only))

    def info(self):
        raise CompatibilityError("Read a volume with the native runtime.volumes.get(volume_id)")

    def commit(self):
        raise CompatibilityError("Runtime volumes are live disks: a write is on the volume at once, " + IN_SANDBOX)

    def reload(self):
        raise CompatibilityError("Runtime volumes are live disks: " + IN_SANDBOX)

    def iterdir(self, path, *, recursive=True):
        raise CompatibilityError(IN_SANDBOX)

    def listdir(self, path, *, recursive=False):
        raise CompatibilityError(IN_SANDBOX)

    def read_file(self, path):
        raise CompatibilityError(IN_SANDBOX)

    def read_file_into_fileobj(self, path, fileobj, progress_cb=None):
        raise CompatibilityError(IN_SANDBOX)

    def remove_file(self, path, recursive=False):
        raise CompatibilityError(IN_SANDBOX)

    def copy_files(self, src_paths, dst_path, recursive=False):
        raise CompatibilityError(IN_SANDBOX)

    def batch_upload(self, force=False):
        raise CompatibilityError(IN_SANDBOX)

    @staticmethod
    def rename(old_name, new_name, *, client=None, environment_name=None):
        raise CompatibilityError("Runtime volume names are set when created: runtime.volumes.create(size_mib, name=...)")


install(Volume, ("info", "commit", "reload", "iterdir", "listdir", "read_file", "read_file_into_fileobj",
                 "remove_file", "copy_files", "batch_upload", "ephemeral", "rename"),
        static=("ephemeral", "rename"), refused=True)
