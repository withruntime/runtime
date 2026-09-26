"""Both client forms preserve mode on current and legacy guests."""
import asyncio
import unittest
from withruntime._async_client import AsyncFiles
from withruntime._sync_client import Files
from withruntime._errors import RuntimeError


class Transport:
    def __init__(self, kind):
        self.kind, self.calls = kind, []

    def json(self, method, path, body):
        self.calls.append((path, body))
        if path.endswith('/uploads'):
            if self.kind == 'denied' or self.kind == 'legacy' and body.get('mode'):
                raise RuntimeError('fixture', code='forbidden' if self.kind == 'denied' else 'guest_upgrade_required')
            return {'uploadId': 'upload', 'chunkBytes': 1048576, **({'mode': body.get('mode')} if self.kind == 'modern' else {})}
        return {}

    def send(self, method, path, **kwargs):
        self.calls.append((path, kwargs))
        return self

    def read(self):
        return b''


class AsyncTransport(Transport):
    async def json(self, *args, **kwargs):
        return super().json(*args, **kwargs)

    async def send(self, *args, **kwargs):
        return super().send(*args, **kwargs)

    async def read(self):
        return b''


class FileModes(unittest.TestCase):
    def check_calls(self, kind, calls):
        begins = [body for path, body in calls if path.endswith('/uploads')]
        self.assertEqual(len(begins), 2 if kind == 'legacy' else 1)
        self.assertEqual(len([path for path, _ in calls if path.endswith('/files:chmod')]), 0 if kind == 'modern' else 1)
        if kind == 'legacy':
            self.assertNotIn('mode', begins[1])

    def test_sync_current_legacy_old_api(self):
        for kind in ('modern', 'legacy', 'old-api'):
            with self.subTest(kind=kind):
                transport = Transport(kind)
                Files(transport, 'sandbox').write('/workspace/run', b'x' * 1048577, mode=0o755)
                self.check_calls(kind, transport.calls)

    def test_async_current_legacy_old_api(self):
        async def run():
            for kind in ('modern', 'legacy', 'old-api'):
                with self.subTest(kind=kind):
                    transport = AsyncTransport(kind)
                    await AsyncFiles(transport, 'sandbox').write('/workspace/run', b'x' * 1048577, mode=0o755)
                    self.check_calls(kind, transport.calls)
        asyncio.run(run())

    def test_other_refusals_do_not_retry(self):
        transport = Transport('denied')
        with self.assertRaises(RuntimeError):
            Files(transport, 'sandbox').write('/workspace/run', b'x' * 1048577, mode=0o755)
        self.assertEqual(len(transport.calls), 1)
        async def run():
            transport = AsyncTransport('denied')
            with self.assertRaises(RuntimeError):
                await AsyncFiles(transport, 'sandbox').write('/workspace/run', b'x' * 1048577, mode=0o755)
            self.assertEqual(len(transport.calls), 1)
        asyncio.run(run())
