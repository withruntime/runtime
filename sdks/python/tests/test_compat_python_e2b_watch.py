import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest

from withruntime.e2b._async_io import watch_directory
from withruntime.e2b._sync_io import watch_directory as watch_sync
from withruntime.e2b._core import entry_info, TimeoutException


class WatchDeadlines(unittest.TestCase):
    def test_zero_lifetime_and_subsecond_deadline_close_only_owned_watch(self):
        async def run():
            for timeout in (0, None, 0.02):
                stopped, closed, settings, exits = [], [], [], []
                class Native:
                    notices = []
                    async def events(self):
                        try:
                            await asyncio.sleep(10)
                            yield {}
                        finally:
                            closed.append(True)
                    async def stop(self): stopped.append(True)
                async def path(value, user): return value
                async def start(path, **kwargs):
                    settings.append(kwargs)
                    return Native()
                fs = SimpleNamespace(_path=path, _files=SimpleNamespace(watch=start))
                handle = await watch_directory(fs, "/workspace", lambda _: None, exits.append, timeout=timeout)
                self.assertEqual(settings, [{"recursive": False, "timeout_ms": 0}])
                if timeout:
                    await asyncio.wait_for(handle._wait, 0.5)
                    self.assertIsInstance(exits[0], TimeoutException)
                else:
                    await asyncio.sleep(0.03)
                    self.assertFalse(handle._wait.done())
                    await handle.stop()
                    self.assertEqual(exits, [None])
                await handle.stop()
                self.assertEqual(len(exits), 1)
                self.assertEqual(stopped, [True])
                self.assertEqual(closed, [True])
        asyncio.run(run())

    def test_sync_watch_requests_native_indefinite_lifetime(self):
        settings = []
        def start(path, **kwargs):
            settings.append(kwargs)
            return SimpleNamespace(stop=lambda: None)
        fs = SimpleNamespace(_path=lambda path, user: path, _files=SimpleNamespace(watch=start))
        handle = watch_sync(fs, "/workspace")
        self.assertEqual(settings, [{"recursive": False, "timeout_ms": 0}])
        handle.stop()


class Metadata(unittest.TestCase):
    def test_new_guest_metadata_and_old_guest_fallback(self):
        basic = {"path": "/workspace/file", "name": "file", "type": "symlink", "size": 1}
        one = entry_info({**basic, "mode": 0o644, "mtimeMs": 1000,
                          "owner": "user", "group": "staff", "symlinkTarget": "../target"})
        self.assertEqual((one.mode, one.permissions, one.owner, one.group, one.symlink_target),
                         (0o644, "rw-r--r--", "user", "staff", "../target"))
        self.assertEqual(one.modified_time, datetime.fromtimestamp(1, tz=timezone.utc))
        old = entry_info({**basic, "mode": "0644", "modifiedAt": "2026-09-29T00:00:00Z"})
        self.assertEqual((old.mode, old.owner, old.group, old.symlink_target), (0o644, "", "", None))
