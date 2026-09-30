"""Modal filesystem, names and mutable metadata through native SDK contracts."""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from test_compat_new_providers import Base
from withruntime.modal import Sandbox, App
from withruntime.modal._fs_async import AsyncFilesystem
from withruntime.modal._fs_sync import Filesystem
from withruntime.modal.exception import ConflictError, NotFoundError, SandboxFilesystemError
from withruntime.modal.types import FileWatchEventType
from withruntime._async_products.watch import AsyncWatchHandle
from withruntime._sync_products.watch import WatchHandle


class ModalMetadata(Base):
    def test_names_are_scoped_to_app_and_tags_replace(self):
        first = Sandbox.create(app=App("first"), name="worker", client=self.client)
        second = Sandbox.create(app=App("second"), name="worker", client=self.client)
        self.assertEqual(Sandbox.from_name("first", "worker", client=self.client).object_id, first.object_id)
        self.assertEqual(Sandbox.from_name("second", "worker", client=self.client).object_id, second.object_id)
        first.set_tags({"old": "gone", "keep": "before"})
        first.set_tags({"keep": "after"})
        self.assertEqual(first.get_tags(), {"keep": "after"})
        self.assertEqual([item.object_id for item in Sandbox.list(tags={"keep": "after"}, client=self.client)], [first.object_id])
        self.assertEqual(first._sandbox.info["labels"]["modal.app"], "first")
        self.assertEqual(first._sandbox.info["labels"]["compat.provider"], "modal")
        first.terminate()
        with self.assertRaises(NotFoundError):
            Sandbox.from_name("first", "worker", client=self.client)

    def test_duplicate_existing_names_do_not_select_arbitrary_resource(self):
        Sandbox.create(app=App("app"), name="worker", client=self.client)
        Sandbox.create(app=App("app"), name="worker", client=self.client)
        with self.assertRaises(ConflictError):
            Sandbox.from_name("app", "worker", client=self.client)

    def test_async_names_and_tag_filters(self):
        async def run():
            client = self.world.async_client()
            box = await Sandbox.create.aio(app=App("app"), name="worker", client=client)
            await box.set_tags.aio({"purpose": "contract"})
            self.assertEqual(await box.get_tags.aio(), {"purpose": "contract"})
            found = await Sandbox.from_name.aio("app", "worker", client=client)
            self.assertEqual(found.object_id, box.object_id)
            self.assertEqual([item.object_id async for item in Sandbox.list.aio(tags={"purpose": "contract"}, client=client)], [box.object_id])
        asyncio.run(run())


class Transport:
    def __init__(self, batches):
        self.batches = iter(batches)
        self.stopped = False

    def json(self, method, *args, **kwargs):
        if method == "DELETE":
            self.stopped = True
            return {"stopped": True}
        return next(self.batches)


class AsyncTransport(Transport):
    async def json(self, *args, **kwargs):
        return super().json(*args, **kwargs)


class Watches(unittest.TestCase):
    def fixture(self, notices=None):
        return {"events": [{"type": "access", "path": "/watched/file"},
                           {"type": "rename", "oldPath": "/watched/old", "path": "/watched/new"}],
                "nextCursor": 4, "notices": notices or [{"k": "end", "reason": "timeout"}], "ended": True}

    def test_sync_access_rename_timeout_and_cleanup(self):
        transport = Transport([self.fixture()])
        handle = WatchHandle(transport, "/watch", {"id": "watch"})
        calls = []
        def start(path, **kwargs):
            calls.append((path, kwargs))
            return handle
        fs = Filesystem(SimpleNamespace(files=SimpleNamespace(watch=start)))
        events = list(fs.watch("/watched", timeout=5))
        self.assertEqual(events[0].type, FileWatchEventType.Access)
        self.assertEqual(events[1].paths, ["/watched/old", "/watched/new"])
        self.assertEqual(events[1].type, FileWatchEventType.Modify)
        self.assertEqual(calls[0][1]["timeout_ms"], 5000)
        self.assertTrue(transport.stopped)

    def test_async_lifetime_filter_and_lost_events(self):
        async def run():
            transport = AsyncTransport([self.fixture()])
            handle = AsyncWatchHandle(transport, "/watch", {"id": "watch"})
            calls = []
            async def start(path, **kwargs):
                calls.append(kwargs)
                return handle
            fs = AsyncFilesystem(SimpleNamespace(files=SimpleNamespace(watch=start)))
            events = [event async for event in fs.watch("/watched", filter=[FileWatchEventType.Access])]
            self.assertEqual([event.type for event in events], [FileWatchEventType.Access])
            self.assertEqual(calls[0]["timeout_ms"], 0)
            self.assertEqual(calls[0]["events"], ["access"])
            self.assertTrue(transport.stopped)
            transport = AsyncTransport([self.fixture(notices=[{"k": "overflow"}])])
            handle = AsyncWatchHandle(transport, "/watch", {"id": "watch"})
            with self.assertRaisesRegex(SandboxFilesystemError, "lost"):
                _ = [event async for event in fs.watch("/watched")]
            self.assertTrue(transport.stopped)
        asyncio.run(run())

    def test_sync_and_async_filesystem_sources_stay_equivalent(self):
        root = Path(__file__).resolve().parents[1] / "withruntime/modal"
        expected = (root / "_fs_async.py").read_text().replace("AsyncFilesystem", "Filesystem").replace("async def ", "def ").replace("async for ", "for ").replace("await ", "")
        self.assertEqual((root / "_fs_sync.py").read_text(), expected)
