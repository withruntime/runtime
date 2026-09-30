"""Sprites Python sandbox APIs, pinned to sprites-py 0.7.1.

Change ``from sprites import SpritesClient`` to
``from withruntime.sprites import SpritesClient``; use Runtime credentials.
"""
from __future__ import annotations
import json
import posixpath
import subprocess
import sys
from dataclasses import dataclass
from .exceptions import SpriteError, ExecError, ExitError, TimeoutError
from .. import Runtime
from .._compat import runtime_key, positive, CompatibilityError, Model, reject

UPSTREAM_VERSION = "0.7.1"


@dataclass
class URLSettings:
    auth: str | None = None
    private_access: str | None = None


@dataclass
class SpriteConfig:
    ram_mb: int | None = None
    cpus: int | None = None
    region: str | None = None
    storage_gb: int | None = None


def _resources(config):
    if config is None:
        return {}
    fields = {}
    for old, new, scale in (("ram_mb", "memory_mib", 1), ("cpus", "vcpu", 1), ("storage_gb", "disk_mib", 1024)):
        value = getattr(config, old)
        if value is not None:
            fields[new] = positive(value * scale, old, integral=True)
    if config.region is not None:
        fields["region"] = config.region
    return fields


@dataclass
class ListOptions:
    prefix: str | None = None
    max_results: int | None = None
    continuation_token: str | None = None
    bulk_load: bool = False


class SpritePath:
    def __init__(self, fs, path):
        self._fs = fs
        self._path = posixpath.normpath(posixpath.join(fs._working_dir, str(path)))

    def __str__(self):
        return self._path

    def __truediv__(self, part):
        return SpritePath(self._fs, posixpath.join(self._path, str(part)))

    @property
    def name(self):
        return posixpath.basename(self._path)

    @property
    def parent(self):
        return SpritePath(self._fs, posixpath.dirname(self._path))

    def _files(self):
        return self._fs._sprite._sandbox().files

    def read_bytes(self):
        return self._files().read(self._path)

    def read_text(self, encoding="utf-8"):
        return self.read_bytes().decode(encoding)

    def write_bytes(self, data, mode=0o644, mkdir_parents=True):
        files = self._files()
        if not mkdir_parents and not files.exists(posixpath.dirname(self._path)):
            raise FileNotFoundError(posixpath.dirname(self._path))
        files.write(self._path, data, mode=mode)

    def write_text(self, data, encoding="utf-8", mode=0o644, mkdir_parents=True):
        self.write_bytes(data.encode(encoding), mode, mkdir_parents)

    def exists(self):
        return self._files().exists(self._path)

    def is_file(self):
        info = self._files().stat(self._path)
        return info.get("exists", True) and info.get("type") == "file"

    def is_dir(self):
        info = self._files().stat(self._path)
        return info.get("exists", True) and info.get("type") == "directory"

    def stat(self):
        info = self._files().stat(self._path)
        if not info.get("exists", True):
            raise FileNotFoundError(self._path)
        return Model(info)

    def iterdir(self):
        for entry in self._files().list(self._path, depth=1, hidden=True):
            yield self / entry["name"]

    def listdir(self):
        return [item.name for item in self.iterdir()]

    def mkdir(self, mode=0o755, parents=False, exist_ok=False):
        if self.exists():
            if exist_ok and self.is_dir():
                return
            raise FileExistsError(self._path)
        self._files().mkdir(self._path, parents=parents)
        self.chmod(mode)

    def unlink(self, missing_ok=False):
        if self.is_dir():
            raise IsADirectoryError(self._path)
        if not self._files().remove(self._path) and not missing_ok:
            raise FileNotFoundError(self._path)

    def rmdir(self):
        self._fs._sprite.run("rmdir", "--", self._path, check=True, capture_output=True)

    def rmtree(self):
        self._files().remove(self._path, recursive=True)

    def rename(self, target):
        path = SpritePath(self._fs, str(target))
        self._files().rename(self._path, str(path), overwrite=True)
        return path

    replace = rename

    def chmod(self, mode, recursive=False):
        args = ["chmod", *( ["-R"] if recursive else []), format(mode, "o"), "--", self._path]
        self._fs._sprite.run(*args, check=True, capture_output=True)

    def touch(self, mode=0o644, exist_ok=True):
        if self.exists() and not exist_ok:
            raise FileExistsError(self._path)
        created = not self.exists()
        self._fs._sprite.run("touch", "--", self._path, check=True, capture_output=True)
        if created:
            self.chmod(mode)


class SpriteFilesystem:
    def __init__(self, sprite, working_dir="/"):
        self._sprite, self._working_dir = sprite, working_dir

    def __truediv__(self, path):
        return self.path(str(path))

    def path(self, *parts):
        return SpritePath(self, posixpath.join(*parts) if parts else self._working_dir)

    @property
    def root(self):
        return self.path("/")

    @property
    def cwd(self):
        return self.path(self._working_dir)


class Sprite:
    def __init__(self, name, client, sandbox_id=None):
        self.name, self.client, self._id = name, client, sandbox_id
        self.id = sandbox_id
        for key in ("organization_name", "status", "config", "environment", "created_at", "updated_at",
                    "bucket_name", "primary_region", "url", "url_settings", "version", "environment_version",
                    "last_running_at", "last_warming_at"):
            setattr(self, key, None)
        self.labels = []

    def _sandbox(self):
        if self._id:
            return self.client._runtime.sandboxes.get(self._id)
        found = list(self.client._runtime.sandboxes.list(name=self.name, labels={"compat.provider": "sprites"}))
        if len(found) != 1:
            raise LookupError(f"Expected one sprite named {self.name}; found {len(found)}")
        self._id = self.id = found[0].id
        return found[0]

    def run(self, *args, capture_output=False, timeout=None, check=False, env=None, cwd=None,
            tty=False, tty_rows=24, tty_cols=80):
        if not args:
            raise ValueError("A command is required")
        command = self.command(*args, timeout=timeout, env=env, cwd=cwd, tty=tty, tty_rows=tty_rows, tty_cols=tty_cols)
        try:
            result = command._execute()
            stdout, stderr, code = result.stdout, result.stderr, result.exit_code
        except ExitError as error:
            if check:
                if not capture_output:
                    raise ExitError(str(error), error.exit_code(), b"", b"") from error
                raise
            stdout, stderr, code = error.stdout, error.stderr, error.exit_code()
        from .exec import CompletedProcess
        return CompletedProcess(list(args), code, stdout if capture_output else None, stderr if capture_output else None)

    def filesystem(self, working_dir="/"):
        return SpriteFilesystem(self, working_dir)

    def command(self, *args, **options):
        from .exec import Cmd
        return Cmd(self, list(args), **options)

    def attach_session(self, session_id, timeout=None):
        return self.command(session_id=session_id, timeout=timeout)

    def update(self, *, url_settings=None, labels=None):
        return self.client.update_sprite(self.name, url_settings=url_settings, labels=labels)

    def destroy(self):
        sb = self._sandbox()
        sb.stop()
        sb.update(persistent=False)

    delete = destroy

    def list_checkpoints(self, **options):
        raise CompatibilityError("Sprites checkpoints require disk-only snapshots; native memory snapshots are not checkpoints")

    def get_checkpoint(self, checkpoint_id):
        raise CompatibilityError("Sprites checkpoints require disk-only snapshots; native memory snapshots are not checkpoints")


class SpritesClient:
    def __init__(self, token=None, base_url=None, timeout=30.0, control_mode=False, *, runtime=None):
        if control_mode:
            raise CompatibilityError("Sprites multiplexed control transport is not implemented")
        self._runtime = runtime or Runtime(api_key=runtime_key(token), timeout=timeout)

    def sprite(self, name):
        return Sprite(name, self)

    def create_sprite(self, name, config=None, url_settings=None, labels=None, wait_for_capacity=False, runtime=None):
        if url_settings is not None or runtime is not None:
            raise CompatibilityError("Sprites URL authentication and runtime selection require a migration")
        # Sprites keeps disk state; a lease-only sandbox would silently lose it.
        sb = self._runtime.sandboxes.create(name=name, persistent=True, pausable=True, auto_wake=True,
            labels={"compat.provider": "sprites", "compat.labels": json.dumps(labels or [])},
            wait_for_capacity=None if wait_for_capacity else 0, **_resources(config))
        from ._metadata import populate
        return populate(Sprite(name, self, sb.id), sb)

    def get_sprite(self, name):
        from ._metadata import populate
        sprite = self.sprite(name)
        return populate(sprite, sprite._sandbox())

    def update_sprite(self, name, *, url_settings=None, labels=None):
        from ._metadata import populate, labels as encode_labels
        if url_settings is None and labels is None:
            raise ValueError("url_settings or labels is required")
        if url_settings is not None:
            raise CompatibilityError("Sprites URL authentication requires a verified public URL mapping")
        encoded = encode_labels(labels)
        sprite = self.sprite(name)
        sb = sprite._sandbox()
        sb.update(labels={**sb.info.get("labels", {}), "compat.labels": encoded})
        return populate(sprite, sb)

    def list_sprites(self, options=None):
        from ._metadata import page
        options = options or ListOptions()
        sandboxes = list(self._runtime.sandboxes.list(labels={"compat.provider": "sprites"}))
        return page(sandboxes, options)

    def list_all_sprites(self, prefix=None):
        return [Sprite(item.name, self, item.id) for item in self.list_sprites(ListOptions(prefix=prefix)).sprites]

    def destroy_sprite(self, name):
        self.sprite(name).destroy()

    delete_sprite = destroy_sprite

    def close(self):
        self._runtime.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

from .async_client import AsyncSpritesClient, AsyncSprite, AsyncSpriteFilesystem, AsyncSpritePath
from .exec import Cmd
from .async_exec import AsyncCmd
