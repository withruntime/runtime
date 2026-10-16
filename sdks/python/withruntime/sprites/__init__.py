"""Sprites Python sandbox APIs, pinned to sprites-py 0.7.2.

Change ``from sprites import SpritesClient`` to
``from withruntime.sprites import SpritesClient``; use Runtime credentials.
"""
from __future__ import annotations
import json
import posixpath
from dataclasses import dataclass
from .exceptions import (SpriteError, ExecError, ExitError, TimeoutError, NetworkError, AuthenticationError,
                         NotFoundError, FilesystemError, FileNotFoundError_, IsADirectoryError_, NotADirectoryError_,
                         PermissionError_, FileExistsError_, DirectoryNotEmptyError)
from .. import Runtime
from .._compat import runtime_key, positive, CompatibilityError
from ._translate import api, filesystem

UPSTREAM_VERSION = "0.7.2"


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


def _changes(url_settings, labels):
    """sprites-py's update needs one of the two."""
    if url_settings is None and labels is None:
        raise ValueError("url_settings or labels is required")
    if url_settings is not None:
        from ._features import visibility
        visibility(url_settings)


@dataclass
class ListOptions:
    prefix: str | None = None
    max_results: int | None = None
    continuation_token: str | None = None
    bulk_load: bool = False


from .types import (ClientOptions, SpawnOptions, ExecOptions, ExecResult, SpriteInfo, SpriteList, Session,  # noqa: E402
                    Checkpoint, StreamMessage, PortMapping, Service, ServiceState, ServiceWithState, ServiceRequest,
                    ServiceLogEvent, PolicyRule, NetworkPolicy, FileStat, DirEntry)
from . import _features as features  # noqa: E402
from ._features import CHECKPOINT_TIMEOUT  # noqa: E402


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

    def _target(self, target):
        """As sprites-py: a path handle as it is, a relative string beside this path."""
        path = target._path if hasattr(target, "_path") else str(target)
        return type(self)(self._fs, path if path.startswith("/") else posixpath.join(posixpath.dirname(self._path), path))

    @filesystem("read")
    def read_bytes(self):
        return self._files().read(self._path)

    def read_text(self, encoding="utf-8"):
        return self.read_bytes().decode(encoding)

    @filesystem("write")
    def write_bytes(self, data, mode=0o644, mkdir_parents=True):
        files = self._files()
        if not mkdir_parents and not files.exists(posixpath.dirname(self._path)):
            raise FileNotFoundError_("write", self._path)
        files.write(self._path, data, mode=mode)

    def write_text(self, data, encoding="utf-8", mode=0o644, mkdir_parents=True):
        self.write_bytes(data.encode(encoding), mode, mkdir_parents)

    @filesystem("stat")
    def exists(self):
        return self._files().exists(self._path)

    @filesystem("stat")
    def is_file(self):
        info = self._files().stat(self._path)
        return info.get("exists", True) and info.get("type") == "file"

    @filesystem("stat")
    def is_dir(self):
        info = self._files().stat(self._path)
        return info.get("exists", True) and info.get("type") == "directory"

    @filesystem("stat")
    def stat(self):
        info = self._files().stat(self._path)
        if not info.get("exists", True):
            raise FileNotFoundError_("stat", self._path)
        return features.file_stat(info, self._path)

    @filesystem("iterdir")
    def iterdir(self):
        for entry in self._files().list(self._path, depth=1, hidden=True):
            yield self / entry["name"]

    def listdir(self):
        return [item.name for item in self.iterdir()]

    @filesystem("mkdir")
    def mkdir(self, mode=0o755, parents=False, exist_ok=False):
        if self.exists():
            if exist_ok and self.is_dir():
                return
            raise FileExistsError_("mkdir", self._path)
        self._files().mkdir(self._path, parents=parents)
        self.chmod(mode)

    @filesystem("unlink")
    def unlink(self, missing_ok=False):
        if self.is_dir():
            raise IsADirectoryError_("unlink", self._path)
        if not self._files().remove(self._path) and not missing_ok:
            raise FileNotFoundError_("unlink", self._path)

    @filesystem("rmdir")
    def rmdir(self):
        self._fs._sprite.run("rmdir", "--", self._path, check=True, capture_output=True)

    @filesystem("rmtree")
    def rmtree(self):
        self._files().remove(self._path, recursive=True)

    @filesystem("rename")
    def rename(self, target):
        path = self._target(target)
        self._files().rename(self._path, str(path), overwrite=True)
        return path

    def replace(self, target):
        """Runtime's rename replaces an existing target, as sprites-py's server does."""
        return self.rename(target)

    @filesystem("copy")
    def copy_to(self, target, recursive=True):
        path = self._target(target)
        self._fs._sprite.run(*features.copy_args(self._path, str(path), recursive), check=True, capture_output=True)
        return path

    @filesystem("chmod")
    def chmod(self, mode, recursive=False):
        args = ["chmod", *( ["-R"] if recursive else []), format(mode, "o"), "--", self._path]
        self._fs._sprite.run(*args, check=True, capture_output=True)

    @filesystem("touch")
    def touch(self, mode=0o644, exist_ok=True):
        if self.exists() and not exist_ok:
            raise FileExistsError_("touch", self._path)
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


def _resuming(sb, work):
    """Runs work; when the sprite's sandbox is paused, wakes it and runs it once more."""
    try:
        return work()
    except Exception as error:
        if not features.paused(error):
            raise
        sb.wake()
        return work()


class Sprite:
    def __init__(self, name, client, sandbox_id=None):
        self.name, self.client, self._id = name, client, sandbox_id
        self.id = sandbox_id
        for key in ("organization_name", "status", "config", "environment", "created_at", "updated_at",
                    "bucket_name", "primary_region", "url", "url_settings", "version", "environment_version",
                    "last_running_at", "last_warming_at"):
            setattr(self, key, None)
        self.labels = []

    @api("get sprite")
    def _sandbox(self):
        if self._id:
            return self.client._runtime.sandboxes.get(self._id)
        found = list(self.client._runtime.sandboxes.list(name=self.name, labels={"compat.provider": "sprites"}))
        if not found:
            raise NotFoundError(f"Sprite not found: {self.name}")
        if len(found) > 1:
            raise SpriteError(f"Expected one sprite named {self.name}; found {len(found)}")
        self._id = self.id = found[0].id
        return found[0]

    def _command_type(self):
        from .exec import Cmd
        return Cmd

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

    def command(self, *args, env=None, cwd=None, timeout=None, stdin=None, stdout=None, stderr=None,
                tty=False, tty_rows=24, tty_cols=80):
        return self._command_type()(self, list(args), env=env, cwd=cwd, timeout=timeout, stdin=stdin, stdout=stdout,
                                    stderr=stderr, tty=tty, tty_rows=tty_rows, tty_cols=tty_cols)

    def attach_session(self, session_id, timeout=None):
        return self._command_type()(self, [], session_id=session_id, timeout=timeout)

    def update(self, *, url_settings=None, labels=None):
        return self.client.update_sprite(self.name, url_settings=url_settings, labels=labels)

    @api("update URL settings")
    def update_url_settings(self, settings):
        shared = features.visibility(settings)
        sb = self._sandbox()
        preview = _resuming(sb, lambda: sb.previews.create(features.SPRITE_PORT, visibility=shared))
        self.url, self.url_settings = features.preview_url(preview), URLSettings(auth=settings.auth)

    def destroy(self):
        sb = self._sandbox()
        sb.stop()
        sb.update(persistent=False)

    def delete(self):
        self.destroy()

    def upgrade(self):
        """Runtime keeps a sandbox's runtime current itself; the sprite must exist."""
        self._sandbox()

    @api("list sessions")
    def list_sessions(self):
        return features.sessions(self._sandbox().processes())

    # ---- checkpoints: disk snapshots of this sprite's sandbox ----

    @api("list checkpoints")
    def list_checkpoints(self, history_filter=None):
        if history_filter:
            raise CompatibilityError("Sprites checkpoint history filters have no Runtime equivalent; "
                                     "list_checkpoints() lists this sprite's checkpoints")
        sb = self._sandbox()
        return [features.checkpoint(snapshot) for snapshot in self.client._runtime.snapshots.list(sandbox_id=sb.id)
                if features.is_checkpoint(snapshot, sb.id)]

    @api("get checkpoint")
    def get_checkpoint(self, checkpoint_id):
        from .._errors import NotFoundError as NativeNotFound
        sb = self._sandbox()
        try:
            snapshot = self.client._runtime.snapshots.get(checkpoint_id)
        except NativeNotFound:
            snapshot = {}
        if not features.is_checkpoint(snapshot, sb.id):
            raise NotFoundError(f"Checkpoint not found: {checkpoint_id}")
        return features.checkpoint(snapshot)

    @api("create checkpoint")
    def create_checkpoint(self, comment="", *, timeout=CHECKPOINT_TIMEOUT):
        from .._errors import RuntimeError as NativeError
        from ._translate import api_error
        seconds = features.checkpoint_seconds(timeout)
        sb = self._sandbox()
        try:
            snapshot = sb.snapshot(mode="disk", labels=features.checkpoint_labels(sb.id, comment),
                                   timeout_seconds=seconds)
        except NativeError as error:
            if api_error(error, "create checkpoint") is not error:
                raise
            return features.failed(error)
        return features.created(snapshot)

    def restore_checkpoint(self, checkpoint_id, *, timeout=CHECKPOINT_TIMEOUT):
        raise CompatibilityError(features.RESTORE)

    # ---- services: refused ----

    def list_services(self):
        raise CompatibilityError(features.SERVICES)

    def get_service(self, service_name):
        raise CompatibilityError(features.SERVICES)

    def delete_service(self, service_name):
        raise CompatibilityError(features.SERVICES)

    def create_service(self, service_name, cmd, args=None, needs=None, http_port=None, duration=None, *,
                       env=None, dir=None):
        raise CompatibilityError(features.SERVICES)

    def start_service(self, service_name, duration=None):
        raise CompatibilityError(features.SERVICES)

    def stop_service(self, service_name, timeout=None):
        raise CompatibilityError(features.SERVICES)

    def signal_service(self, service_name, signal):
        raise CompatibilityError(features.SERVICES)

    # ---- network policy ----

    @api("get network policy")
    def get_network_policy(self):
        sb = self._sandbox()
        return features.sprites_policy(_resuming(sb, sb.network.get))

    @api("update network policy")
    def update_network_policy(self, policy):
        rules = features.runtime_rules(policy)
        sb = self._sandbox()
        current = _resuming(sb, sb.network.get)
        _resuming(sb, lambda: sb.network.set(**features.network_fields(rules, current)))

    # ---- control mode: never on ----

    def use_control_mode(self):
        return False

    async def get_control_connection(self):
        raise CompatibilityError(features.CONTROL)

    async def close_control_connection(self):
        """No control connection is ever open."""

    def has_control_connection(self):
        return False


class SpritesClient:
    def __init__(self, token=None, base_url=None, timeout=30.0, control_mode=False, *, runtime=None):
        if control_mode:
            raise CompatibilityError("Sprites multiplexed control transport is not implemented")
        self._runtime = runtime or Runtime(api_key=runtime_key(token), timeout=timeout)

    @property
    def http_client(self):
        raise CompatibilityError(features.HTTP_CLIENT)

    @staticmethod
    def create_token(fly_macaroon, org_slug, invite_code=None):
        raise CompatibilityError(features.TOKEN)

    def sprite(self, name):
        return Sprite(name, self)

    @api("create sprite")
    def create_sprite(self, name, config=None, url_settings=None, labels=None, wait_for_capacity=False, runtime=None):
        if runtime is not None:
            raise CompatibilityError("Sprites runtime selection has no Runtime equivalent")
        if url_settings is not None:
            features.visibility(url_settings)
        # Sprites keeps disk state; a lease-only sandbox would silently lose it.
        sb = self._runtime.sandboxes.create(name=name, persistent=True, auto_wake=True,
            labels={"compat.provider": "sprites", "compat.labels": json.dumps(labels or [])},
            wait_for_capacity=None if wait_for_capacity else 0, **_resources(config))
        from ._metadata import populate
        sprite = populate(Sprite(name, self, sb.id), sb)
        if url_settings is not None:
            try:
                sprite.update_url_settings(url_settings)
            except BaseException:
                sprite.destroy()
                raise
        return sprite

    @api("get sprite")
    def get_sprite(self, name):
        from ._metadata import populate
        sprite = self.sprite(name)
        return populate(sprite, sprite._sandbox())

    @api("update sprite")
    def update_sprite(self, name, *, url_settings=None, labels=None):
        from ._metadata import populate, labels as encode_labels
        _changes(url_settings, labels)
        encoded = None if labels is None else encode_labels(labels)
        sprite = self.sprite(name)
        sb = sprite._sandbox()
        if encoded is not None:
            sb.update(labels={**sb.info.get("labels", {}), "compat.labels": encoded})
        populate(sprite, sb)
        if url_settings is not None:
            sprite.update_url_settings(url_settings)
        return sprite

    def update_url_settings(self, name, settings):
        self.sprite(name).update_url_settings(settings)

    @api("list sprites")
    def list_sprites(self, options=None):
        from ._metadata import page
        options = options or ListOptions()
        sandboxes = list(self._runtime.sandboxes.list(labels={"compat.provider": "sprites"}))
        return page(sandboxes, options)

    def list_all_sprites(self, prefix=None):
        return [Sprite(item.name, self, item.id) for item in self.list_sprites(ListOptions(prefix=prefix)).sprites]

    def destroy_sprite(self, name):
        self.sprite(name).destroy()

    def delete_sprite(self, name):
        self.destroy_sprite(name)

    def upgrade_sprite(self, name):
        self.sprite(name).upgrade()

    def close(self):
        self._runtime.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

from .async_client import AsyncSpritesClient, AsyncSprite, AsyncSpriteFilesystem, AsyncSpritePath  # noqa: E402
from .exec import Cmd  # noqa: E402
from .async_exec import AsyncCmd  # noqa: E402
from .control import ControlConnection, OpConn  # noqa: E402
