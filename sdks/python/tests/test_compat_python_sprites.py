import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from test_compat_new_providers import Base
from withruntime.sprites import SpritesClient, ListOptions, SpriteConfig
from withruntime.sprites.async_client import AsyncSpritesClient
from withruntime.sprites.types import SpriteInfo, SpriteList
from withruntime._compat import CompatibilityError


class SpritesMetadata(Base):
    def test_native_memory_snapshots_are_not_reported_as_disk_checkpoints(self):
        sprite = SpritesClient(runtime=self.client).sprite("unresolved")
        for method, args in ((sprite.list_checkpoints, ()), (sprite.get_checkpoint, ("snapshot",))):
            with self.assertRaises(CompatibilityError):
                method(*args)
        self.assertEqual(self.world.calls, [])

    def test_labels_replace_and_roundtrip_metadata(self):
        client = SpritesClient(runtime=self.client)
        sprite = client.create_sprite("one", SpriteConfig(cpus=2, ram_mb=1024), labels=["before"])
        self.assertEqual(sprite.labels, ["before"])
        changed = sprite.update(labels=["after", "two"])
        self.assertEqual(changed.labels, ["after", "two"])
        self.assertEqual(client.get_sprite("one").labels, ["after", "two"])
        self.assertEqual(changed.config.cpus, 2)
        self.assertEqual(changed.config.ram_mb, 1024)
        self.assertIsNotNone(changed.created_at)
        self.assertEqual(sprite.update(labels=[]).labels, [])
        with self.assertRaisesRegex(ValueError, "required"):
            sprite.update()
        self.assertEqual(sprite._sandbox().info["labels"]["compat.provider"], "sprites")

    def test_pagination_cursor_filters_and_stable_position(self):
        client = SpritesClient(runtime=self.client)
        for name in ("z-last", "a-first", "m-middle", "other"):
            client.create_sprite(name)
        first = client.list_sprites(ListOptions(max_results=2))
        self.assertIsInstance(first, SpriteList)
        self.assertIsInstance(first.sprites[0], SpriteInfo)
        self.assertEqual([item.name for item in first.sprites], ["a-first", "m-middle"])
        self.assertTrue(first.has_more)
        client.create_sprite("b-added-before-cursor")
        second = client.list_sprites(ListOptions(max_results=2, continuation_token=first.next_continuation_token))
        self.assertEqual([item.name for item in second.sprites], ["other", "z-last"])
        self.assertFalse(second.has_more)
        with self.assertRaisesRegex(ValueError, "token"):
            client.list_sprites(ListOptions(prefix="a", continuation_token=first.next_continuation_token))
        for token in ("garbage", "e30=", "bnVsbA=="):
            with self.assertRaises(ValueError):
                client.list_sprites(ListOptions(continuation_token=token))

    def test_async_labels_and_pagination(self):
        async def run():
            client = AsyncSpritesClient(runtime=self.world.async_client())
            one = await client.create_sprite("a", labels=["before"])
            await client.create_sprite("b")
            self.assertEqual((await one.update(labels=["after"])).labels, ["after"])
            self.assertEqual((await client.get_sprite("a")).labels, ["after"])
            first = await client.list_sprites(ListOptions(max_results=1))
            second = await client.list_sprites(ListOptions(max_results=1, continuation_token=first.next_continuation_token))
            self.assertEqual([item.name for item in first.sprites + second.sprites], ["a", "b"])
        asyncio.run(run())
