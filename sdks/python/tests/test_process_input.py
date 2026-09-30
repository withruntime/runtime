import asyncio
import base64
import unittest
from withruntime._async_client import AsyncProcess
from withruntime._sync_client import Process

class Pipe:
    def __init__(self):
        self.data = bytearray()
        self.calls = []
        self.closed = False
    def json(self, method, path, body):
        assert not self.closed
        assert body['offset'] == len(self.data)
        data = base64.b64decode(body['base64'])
        assert len(data) <= 1_048_576
        self.calls.append(body)
        accepted = data[:65_536]
        self.data.extend(accepted)
        self.closed = body['eof'] and len(accepted) == len(data)
        return {'offset': len(self.data)}
class AsyncPipe(Pipe):
    async def json(self, *args, **kwargs):
        await asyncio.sleep(0)
        return super().json(*args, **kwargs)

class InputTests(unittest.TestCase):
    def test_sync_chunks_partial_acceptance_and_eof(self):
        pipe = Pipe()
        process = Process(pipe, 's', {'id': 'p'})
        data = b'\xff' * 2_500_000
        process.write(data, eof=True)
        self.assertEqual(bytes(pipe.data), data)
        self.assertFalse(pipe.calls[0]['eof'])
        self.assertTrue(pipe.closed)
    def test_async_large_and_concurrent(self):
        async def run():
            pipe = AsyncPipe()
            process = AsyncProcess(pipe, 's', {'id': 'p'})
            await asyncio.gather(process.write(b'a' * 2_000_000), process.write('second'))
            await process.write(b'', eof=True)
            self.assertEqual(bytes(pipe.data), b'a' * 2_000_000 + b'second')
            self.assertTrue(pipe.closed)
        asyncio.run(run())
    def test_malformed_offsets(self):
        for offset in (-1, 100, .5, None):
            class BadPipe:
                def json(self, *args, **kwargs): return {'offset': offset}
            with self.assertRaisesRegex(Exception, 'invalid input offset'):
                Process(BadPipe(), 's', {'id': 'p'}).write('x')
