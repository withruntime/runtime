import asyncio
import unittest
from types import SimpleNamespace
from withruntime.e2b import FilesystemEventType, InvalidArgumentException, SandboxException
from withruntime.e2b._sync_io import watch_directory as watch_sync
from withruntime.e2b._async_io import watch_directory as watch_async


def directory_stat(*_):
    """The watched path, as the API's stat answers a directory."""
    return {"exists": True, "type": "directory"}


async def directory_stat_async(*_):
    return directory_stat()

class Native:
    def __init__(self):
        self.notices = []
        self.stopped = 0
    def get_new_events(self):
        return [{'type': 'create', 'path': '/workspace/.env'}]
    def stop(self): self.stopped += 1

class SyncWatch(unittest.TestCase):
    def test_poll_relative_names_and_stop(self):
        native = Native()
        def start(path, **opts):
            self.assertEqual((path, opts['recursive']), ('/workspace', True))
            return native
        fs = SimpleNamespace(_path=lambda p, u: p, _files=SimpleNamespace(stat=directory_stat, watch=start))
        handle = watch_sync(fs, '/workspace', recursive=True)
        events = handle.get_new_events()
        # A file Runtime puts in place whole is created and, as envd says,
        # written: E2B's own watch test waits for the write (5 October 2026).
        self.assertEqual([(e.name, e.type) for e in events],
                         [('.env', FilesystemEventType.CREATE), ('.env', FilesystemEventType.WRITE)])
        handle.stop()
        handle.stop()
        self.assertEqual(native.stopped, 1)
        with self.assertRaisesRegex(SandboxException, 'already stopped'): handle.get_new_events()
    def test_a_file_is_not_watched_as_envd_refuses_it(self):
        started = []
        fs = SimpleNamespace(_path=lambda p, u: p, _files=SimpleNamespace(
            stat=lambda p: {"exists": True, "type": "file"}, watch=lambda *a, **k: started.append(a)))
        with self.assertRaisesRegex(InvalidArgumentException, 'not a directory'):
            watch_sync(fs, '/workspace/a.txt')
        self.assertEqual(started, [])
    def test_loss_is_not_silently_a_complete_event_list(self):
        native = Native()
        native.notices = [{'k': 'overflow'}]
        fs = SimpleNamespace(_path=lambda p, u: p, _files=SimpleNamespace(stat=directory_stat, watch=lambda *a, **k: native))
        with self.assertRaisesRegex(SandboxException, 'lost'): watch_sync(fs, '/workspace').get_new_events()

class AsyncWatch(unittest.TestCase):
    def test_async_callbacks_and_immediate_stop(self):
        async def run():
            for immediately in (False, True):
                class AsyncNative(Native):
                    async def events(self):
                        yield {'type': 'write', 'path': '/workspace/nested/file'}
                        await asyncio.sleep(60)
                    async def stop(self): self.stopped += 1
                native = AsyncNative()
                async def path(p, u): return p
                async def start(*args, **kwargs): return native
                fs = SimpleNamespace(_path=path, _files=SimpleNamespace(stat=directory_stat_async, watch=start))
                seen, exits = [], []
                handle = await watch_async(fs, '/workspace', seen.append, exits.append)
                if not immediately: await asyncio.sleep(0)
                await handle.stop()
                await handle.stop()
                self.assertEqual(exits, [None])
                self.assertEqual(native.stopped, 1)
                if not immediately: self.assertEqual(seen[0].name, 'nested/file')
        asyncio.run(run())
    def test_async_failure_notifies_once(self):
        async def run():
            class AsyncNative(Native):
                async def events(self):
                    raise RuntimeError('connection lost')
                    yield
                async def stop(self): self.stopped += 1
            native = AsyncNative()
            async def path(p, u): return p
            async def start(*args, **kwargs): return native
            fs = SimpleNamespace(_path=path, _files=SimpleNamespace(stat=directory_stat_async, watch=start))
            errors = []
            exited = asyncio.Event()
            def on_exit(error):
                errors.append(error)
                exited.set()
            handle = await watch_async(fs, '/workspace', lambda _: None, on_exit)
            await asyncio.wait_for(exited.wait(), .5)
            await handle.stop()
            self.assertEqual(len(errors), 1)
            self.assertIn('connection lost', str(errors[0]))
        asyncio.run(run())

class ReentrantWatch(unittest.TestCase):
    def test_callback_can_await_its_own_stop_once(self):
        async def run():
            class AsyncNative(Native):
                async def events(self):
                    await asyncio.sleep(0)
                    yield {'type': 'write', 'path': '/workspace/one'}
                    yield {'type': 'write', 'path': '/workspace/two'}
                async def stop(self): self.stopped += 1
            native = AsyncNative()
            async def path(p, u): return p
            async def start(*args, **kwargs): return native
            fs = SimpleNamespace(_path=path, _files=SimpleNamespace(stat=directory_stat_async, watch=start))
            exits, seen = [], []
            async def event(e):
                seen.append(e.name)
                await handle.stop()
            handle = await watch_async(fs, '/workspace', event, exits.append)
            await asyncio.wait_for(handle._wait, .2)
            self.assertEqual(seen, ['one'])
            self.assertEqual(exits, [None])
            self.assertEqual(native.stopped, 1)
        asyncio.run(run())
