"""Native asyncio Sprites client and filesystem."""
from __future__ import annotations
import json
import posixpath
import subprocess
from .. import AsyncRuntime
from .._compat import CompatibilityError, Model, runtime_key, reject
from . import Sprite, SpriteFilesystem, SpritePath, SpritesClient, ListOptions, _resources
from .async_exec import AsyncCmd
from .exceptions import ExitError, TimeoutError


class AsyncSpritePath(SpritePath):
    def __truediv__(self, part):
        return AsyncSpritePath(self._fs, posixpath.join(self._path, str(part)))

    @property
    def parent(self):
        return AsyncSpritePath(self._fs, posixpath.dirname(self._path))

    async def _files(self):
        return (await self._fs._sprite._sandbox()).files

    async def read_bytes(self):
        return await (await self._files()).read(self._path)

    async def read_text(self, encoding="utf-8"):
        return (await self.read_bytes()).decode(encoding)

    async def write_bytes(self, data, mode=0o644, mkdir_parents=True):
        files = await self._files()
        if not mkdir_parents and not await files.exists(posixpath.dirname(self._path)):
            raise FileNotFoundError(posixpath.dirname(self._path))
        await files.write(self._path, data, mode=mode)

    async def write_text(self, data, encoding="utf-8", mode=0o644, mkdir_parents=True):
        await self.write_bytes(data.encode(encoding), mode, mkdir_parents)

    async def exists(self):
        return await (await self._files()).exists(self._path)

    async def stat(self):
        info = await (await self._files()).stat(self._path)
        if not info.get("exists", True):
            raise FileNotFoundError(self._path)
        return Model(info)

    async def is_file(self):
        info = await (await self._files()).stat(self._path)
        return info.get("exists", True) and info.get("type") == "file"

    async def is_dir(self):
        info = await (await self._files()).stat(self._path)
        return info.get("exists", True) and info.get("type") == "directory"

    async def iterdir(self):
        for entry in await (await self._files()).list(self._path, depth=1, hidden=True):
            yield self / entry["name"]

    async def listdir(self):
        return [item.name async for item in self.iterdir()]

    async def mkdir(self, mode=0o755, parents=False, exist_ok=False):
        if await self.exists():
            if exist_ok and await self.is_dir():
                return
            raise FileExistsError(self._path)
        await (await self._files()).mkdir(self._path, parents=parents)
        await self.chmod(mode)

    async def unlink(self, missing_ok=False):
        if await self.is_dir():
            raise IsADirectoryError(self._path)
        if not await (await self._files()).remove(self._path) and not missing_ok:
            raise FileNotFoundError(self._path)

    async def rmdir(self):
        await self._fs._sprite.run("rmdir", "--", self._path, check=True, capture_output=True)

    async def rmtree(self):
        await (await self._files()).remove(self._path, recursive=True)

    async def rename(self, target):
        path = AsyncSpritePath(self._fs, str(target))
        await (await self._files()).rename(self._path, str(path), overwrite=True)
        return path

    replace = rename

    async def chmod(self, mode, recursive=False):
        await self._fs._sprite.run("chmod", *(["-R"] if recursive else []), format(mode, "o"), "--", self._path,
                                  check=True, capture_output=True)

    async def touch(self, mode=0o644, exist_ok=True):
        exists = await self.exists()
        if exists and not exist_ok:
            raise FileExistsError(self._path)
        await self._fs._sprite.run("touch", "--", self._path, check=True, capture_output=True)
        if not exists:
            await self.chmod(mode)


class AsyncSpriteFilesystem(SpriteFilesystem):
    def path(self, *parts):
        return AsyncSpritePath(self, posixpath.join(*parts) if parts else self._working_dir)


class AsyncSprite(Sprite):
    async def _sandbox(self):
        if self._id:
            return await self.client._runtime.sandboxes.get(self._id)
        found = [sb async for sb in await self.client._runtime.sandboxes.list(
            name=self.name, labels={"compat.provider": "sprites"})]
        if len(found) != 1:
            raise LookupError(f"Expected one sprite named {self.name}; found {len(found)}")
        self._id = self.id = found[0].id
        return found[0]

    def filesystem(self, working_dir="/"):
        return AsyncSpriteFilesystem(self, working_dir)

    def command(self, *args, **options):
        return AsyncCmd(self, list(args), **options)

    def attach_session(self, session_id, timeout=None):
        return self.command(session_id=session_id, timeout=timeout)

    async def run(self, *args, capture_output=False, timeout=None, check=False, env=None, cwd=None,
                  tty=False, tty_rows=24, tty_cols=80):
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

    async def destroy(self):
        sb = await self._sandbox()
        await sb.stop()
        await sb.update(persistent=False)

    delete = destroy

    async def list_checkpoints(self, **options):
        raise CompatibilityError("Sprites checkpoints require disk-only snapshots; native memory snapshots are not checkpoints")

    async def get_checkpoint(self, checkpoint_id):
        raise CompatibilityError("Sprites checkpoints require disk-only snapshots; native memory snapshots are not checkpoints")


class AsyncSpritesClient(SpritesClient):
    def __init__(self, token=None, base_url=None, timeout=30.0, control_mode=False, *, runtime=None):
        if control_mode:
            raise CompatibilityError("Sprites multiplexed control transport is not implemented")
        self._runtime = runtime or AsyncRuntime(api_key=runtime_key(token), timeout=timeout)

    def sprite(self, name):
        return AsyncSprite(name, self)

    async def create_sprite(self, name, config=None, url_settings=None, labels=None, wait_for_capacity=False, runtime=None):
        if url_settings is not None or runtime is not None:
            raise CompatibilityError("Sprites URL authentication and runtime selection require a migration")
        sb = await self._runtime.sandboxes.create(name=name, persistent=True, pausable=True, auto_wake=True,
            labels={"compat.provider": "sprites", "compat.labels": json.dumps(labels or [])},
            wait_for_capacity=None if wait_for_capacity else 0, **_resources(config))
        from ._metadata import populate
        return populate(AsyncSprite(name, self, sb.id), sb)

    async def get_sprite(self, name):
        from ._metadata import populate
        sprite = self.sprite(name)
        return populate(sprite, await sprite._sandbox())

    async def update_sprite(self, name, *, url_settings=None, labels=None):
        from ._metadata import populate, labels as encode_labels
        if url_settings is None and labels is None:
            raise ValueError("url_settings or labels is required")
        if url_settings is not None:
            raise CompatibilityError("Sprites URL authentication requires a verified public URL mapping")
        encoded = encode_labels(labels)
        sprite = self.sprite(name)
        sb = await sprite._sandbox()
        await sb.update(labels={**sb.info.get("labels", {}), "compat.labels": encoded})
        return populate(sprite, sb)

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

    delete_sprite = destroy_sprite

    async def aclose(self):
        await self._runtime.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()
