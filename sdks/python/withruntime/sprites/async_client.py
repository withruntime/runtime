"""Native asyncio Sprites client and filesystem."""
from __future__ import annotations
import json
import posixpath
from .. import AsyncRuntime
from .._compat import CompatibilityError, runtime_key
from . import (Sprite, SpriteFilesystem, SpritePath, SpritesClient, ListOptions, URLSettings, CHECKPOINT_TIMEOUT,
               _changes, _resources, features)
from ._translate import api, filesystem
from .async_exec import AsyncCmd
from .exceptions import FileExistsError_, FileNotFoundError_, IsADirectoryError_, NotFoundError, SpriteError


class AsyncSpritePath(SpritePath):
    def __truediv__(self, part):
        return AsyncSpritePath(self._fs, posixpath.join(self._path, str(part)))

    @property
    def parent(self):
        return AsyncSpritePath(self._fs, posixpath.dirname(self._path))

    async def _files(self):
        return (await self._fs._sprite._sandbox()).files

    @filesystem("read")
    async def read_bytes(self):
        return await (await self._files()).read(self._path)

    async def read_text(self, encoding="utf-8"):
        return (await self.read_bytes()).decode(encoding)

    @filesystem("write")
    async def write_bytes(self, data, mode=0o644, mkdir_parents=True):
        files = await self._files()
        if not mkdir_parents and not await files.exists(posixpath.dirname(self._path)):
            raise FileNotFoundError_("write", self._path)
        await files.write(self._path, data, mode=mode)

    async def write_text(self, data, encoding="utf-8", mode=0o644, mkdir_parents=True):
        await self.write_bytes(data.encode(encoding), mode, mkdir_parents)

    @filesystem("stat")
    async def exists(self):
        return await (await self._files()).exists(self._path)

    @filesystem("stat")
    async def stat(self):
        info = await (await self._files()).stat(self._path)
        if not info.get("exists", True):
            raise FileNotFoundError_("stat", self._path)
        return features.file_stat(info, self._path)

    @filesystem("stat")
    async def is_file(self):
        info = await (await self._files()).stat(self._path)
        return info.get("exists", True) and info.get("type") == "file"

    @filesystem("stat")
    async def is_dir(self):
        info = await (await self._files()).stat(self._path)
        return info.get("exists", True) and info.get("type") == "directory"

    @filesystem("iterdir")
    async def iterdir(self):
        for entry in await (await self._files()).list(self._path, depth=1, hidden=True):
            yield self / entry["name"]

    async def listdir(self):
        return [item.name async for item in self.iterdir()]

    @filesystem("mkdir")
    async def mkdir(self, mode=0o755, parents=False, exist_ok=False):
        if await self.exists():
            if exist_ok and await self.is_dir():
                return
            raise FileExistsError_("mkdir", self._path)
        await (await self._files()).mkdir(self._path, parents=parents)
        await self.chmod(mode)

    @filesystem("unlink")
    async def unlink(self, missing_ok=False):
        if await self.is_dir():
            raise IsADirectoryError_("unlink", self._path)
        if not await (await self._files()).remove(self._path) and not missing_ok:
            raise FileNotFoundError_("unlink", self._path)

    @filesystem("rmdir")
    async def rmdir(self):
        await self._fs._sprite.run("rmdir", "--", self._path, check=True, capture_output=True)

    @filesystem("rmtree")
    async def rmtree(self):
        await (await self._files()).remove(self._path, recursive=True)

    @filesystem("rename")
    async def rename(self, target):
        path = self._target(target)
        await (await self._files()).rename(self._path, str(path), overwrite=True)
        return path

    async def replace(self, target):
        """Runtime's rename replaces an existing target, as sprites-py's server does."""
        return await self.rename(target)

    @filesystem("copy")
    async def copy_to(self, target, recursive=True):
        path = self._target(target)
        await self._fs._sprite.run(*features.copy_args(self._path, str(path), recursive), check=True,
                                   capture_output=True)
        return path

    @filesystem("chmod")
    async def chmod(self, mode, recursive=False):
        await self._fs._sprite.run("chmod", *(["-R"] if recursive else []), format(mode, "o"), "--", self._path,
                                  check=True, capture_output=True)

    @filesystem("touch")
    async def touch(self, mode=0o644, exist_ok=True):
        exists = await self.exists()
        if exists and not exist_ok:
            raise FileExistsError_("touch", self._path)
        await self._fs._sprite.run("touch", "--", self._path, check=True, capture_output=True)
        if not exists:
            await self.chmod(mode)


class AsyncSpriteFilesystem(SpriteFilesystem):
    def path(self, *parts):
        return AsyncSpritePath(self, posixpath.join(*parts) if parts else self._working_dir)


async def _resuming(sb, work):
    """Runs work; when the sprite's sandbox is paused, wakes it and runs it once more."""
    try:
        return await work()
    except Exception as error:
        if not features.paused(error):
            raise
        await sb.wake()
        return await work()


class AsyncSprite(Sprite):
    @api("get sprite")
    async def _sandbox(self):
        if self._id:
            return await self.client._runtime.sandboxes.get(self._id)
        found = [sb async for sb in await self.client._runtime.sandboxes.list(
            name=self.name, labels={"compat.provider": "sprites"})]
        if not found:
            raise NotFoundError(f"Sprite not found: {self.name}")
        if len(found) > 1:
            raise SpriteError(f"Expected one sprite named {self.name}; found {len(found)}")
        self._id = self.id = found[0].id
        return found[0]

    def _command_type(self):
        return AsyncCmd

    def filesystem(self, working_dir="/"):
        return AsyncSpriteFilesystem(self, working_dir)

    async def run(self, *args, capture_output=False, timeout=None, check=False, env=None, cwd=None,
                  tty=False, tty_rows=24, tty_cols=80):
        from .exceptions import ExitError
        command = self.command(*args, timeout=timeout, env=env, cwd=cwd, tty=tty, tty_rows=tty_rows, tty_cols=tty_cols)
        try:
            result = await command._execute()
            stdout, stderr, code = result.stdout, result.stderr, result.exit_code
        except ExitError as error:
            if check:
                if not capture_output:
                    raise ExitError(str(error), error.exit_code(), b"", b"") from error
                raise
            stdout, stderr, code = error.stdout, error.stderr, error.exit_code()
        from .exec import CompletedProcess
        return CompletedProcess(list(args), code, stdout if capture_output else None, stderr if capture_output else None)

    async def update(self, *, url_settings=None, labels=None):
        return await self.client.update_sprite(self.name, url_settings=url_settings, labels=labels)

    @api("update URL settings")
    async def update_url_settings(self, settings):
        shared = features.visibility(settings)
        sb = await self._sandbox()
        preview = await _resuming(sb, lambda: sb.previews.create(features.SPRITE_PORT, visibility=shared))
        self.url, self.url_settings = features.preview_url(preview), URLSettings(auth=settings.auth)

    async def destroy(self):
        sb = await self._sandbox()
        await sb.stop()
        await sb.update(persistent=False)

    async def delete(self):
        await self.destroy()

    async def upgrade(self):
        """Runtime keeps a sandbox's runtime current itself; the sprite must exist."""
        await self._sandbox()

    @api("list sessions")
    async def list_sessions(self):
        return features.sessions(await (await self._sandbox()).processes())

    @api("list checkpoints")
    async def list_checkpoints(self, history_filter=None):
        if history_filter:
            raise CompatibilityError("Sprites checkpoint history filters have no Runtime equivalent; "
                                     "list_checkpoints() lists this sprite's checkpoints")
        sb = await self._sandbox()
        return [features.checkpoint(snapshot)
                async for snapshot in await self.client._runtime.snapshots.list(sandbox_id=sb.id)
                if features.is_checkpoint(snapshot, sb.id)]

    @api("get checkpoint")
    async def get_checkpoint(self, checkpoint_id):
        from .._errors import NotFoundError as NativeNotFound
        sb = await self._sandbox()
        try:
            snapshot = await self.client._runtime.snapshots.get(checkpoint_id)
        except NativeNotFound:
            snapshot = {}
        if not features.is_checkpoint(snapshot, sb.id):
            raise NotFoundError(f"Checkpoint not found: {checkpoint_id}")
        return features.checkpoint(snapshot)

    @api("create checkpoint")
    async def create_checkpoint(self, comment="", *, timeout=CHECKPOINT_TIMEOUT):
        from .._errors import RuntimeError as NativeError
        from ._translate import api_error
        seconds = features.checkpoint_seconds(timeout)
        sb = await self._sandbox()
        try:
            snapshot = await sb.snapshot(mode="disk", labels=features.checkpoint_labels(sb.id, comment),
                                         timeout_seconds=seconds)
        except NativeError as error:
            if api_error(error, "create checkpoint") is not error:
                raise
            return features.failed(error)
        return features.created(snapshot)

    async def restore_checkpoint(self, checkpoint_id, *, timeout=CHECKPOINT_TIMEOUT):
        raise CompatibilityError(features.RESTORE)

    @api("get network policy")
    async def get_network_policy(self):
        sb = await self._sandbox()
        return features.sprites_policy(await _resuming(sb, sb.network.get))

    @api("update network policy")
    async def update_network_policy(self, policy):
        rules = features.runtime_rules(policy)
        sb = await self._sandbox()
        current = await _resuming(sb, sb.network.get)
        await _resuming(sb, lambda: sb.network.set(**features.network_fields(rules, current)))


class AsyncSpritesClient(SpritesClient):
    def __init__(self, token=None, base_url=None, timeout=30.0, control_mode=False, *, runtime=None):
        if control_mode:
            raise CompatibilityError("Sprites multiplexed control transport is not implemented")
        self._runtime = runtime or AsyncRuntime(api_key=runtime_key(token), timeout=timeout)

    @staticmethod
    async def create_token(fly_macaroon, org_slug, invite_code=None):
        raise CompatibilityError(features.TOKEN)

    def sprite(self, name):
        return AsyncSprite(name, self)

    @api("create sprite")
    async def create_sprite(self, name, config=None, url_settings=None, labels=None, wait_for_capacity=False, runtime=None):
        if runtime is not None:
            raise CompatibilityError("Sprites runtime selection has no Runtime equivalent")
        if url_settings is not None:
            features.visibility(url_settings)
        sb = await self._runtime.sandboxes.create(name=name, persistent=True, auto_wake=True,
            labels={"compat.provider": "sprites", "compat.labels": json.dumps(labels or [])},
            wait_for_capacity=None if wait_for_capacity else 0, **_resources(config))
        from ._metadata import populate
        sprite = populate(AsyncSprite(name, self, sb.id), sb)
        if url_settings is not None:
            try:
                await sprite.update_url_settings(url_settings)
            except BaseException:
                await sprite.destroy()
                raise
        return sprite

    @api("get sprite")
    async def get_sprite(self, name):
        from ._metadata import populate
        sprite = self.sprite(name)
        return populate(sprite, await sprite._sandbox())

    @api("update sprite")
    async def update_sprite(self, name, *, url_settings=None, labels=None):
        from ._metadata import populate, labels as encode_labels
        _changes(url_settings, labels)
        encoded = None if labels is None else encode_labels(labels)
        sprite = self.sprite(name)
        sb = await sprite._sandbox()
        if encoded is not None:
            await sb.update(labels={**sb.info.get("labels", {}), "compat.labels": encoded})
        populate(sprite, sb)
        if url_settings is not None:
            await sprite.update_url_settings(url_settings)
        return sprite

    async def update_url_settings(self, name, settings):
        await self.sprite(name).update_url_settings(settings)

    @api("list sprites")
    async def list_sprites(self, options=None):
        from ._metadata import page
        options = options or ListOptions()
        sandboxes = [sb async for sb in await self._runtime.sandboxes.list(labels={"compat.provider": "sprites"})]
        return page(sandboxes, options)

    async def list_all_sprites(self, prefix=None):
        page = await self.list_sprites(ListOptions(prefix=prefix))
        return [AsyncSprite(item.name, self, item.id) for item in page.sprites]

    async def destroy_sprite(self, name):
        await self.sprite(name).destroy()

    async def delete_sprite(self, name):
        await self.destroy_sprite(name)

    async def upgrade_sprite(self, name):
        await self.sprite(name).upgrade()

    async def aclose(self):
        await self._runtime.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()
