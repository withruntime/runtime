"""A large write keeps eight chunks in flight, in both client forms.

Each chunk's reply waits on the API and the guest, so the link idles while
every chunk in flight waits: four in flight took 100 MB 17-18 s from a
12.6 MB/s home link, eight took 11 s (27 September 2026)."""
import asyncio
import threading
import time
import unittest
from withruntime._async_client import AsyncFiles
from withruntime._sync_client import Files

MIB = 1048576


class Counter:
    def __init__(self):
        self.now = self.most = self.chunks = 0
        self.lock = threading.Lock()

    def enter(self):
        with self.lock:
            self.now += 1
            self.chunks += 1
            self.most = max(self.most, self.now)

    def leave(self):
        with self.lock:
            self.now -= 1


class Transport:
    def __init__(self):
        self.count = Counter()

    def json(self, method, path, body):
        return {'uploadId': 'upload', 'chunkBytes': MIB} if path.endswith('/uploads') else {}

    def send(self, method, path, **kwargs):
        # Each chunk is held until eight are in flight (or a second passes), so a
        # loaded machine that starts the workers slowly cannot hide the eighth.
        self.count.enter()
        until = time.monotonic() + 1
        while self.count.now < 8 and time.monotonic() < until:
            time.sleep(0.001)
        time.sleep(0.02)
        self.count.leave()
        return self

    def read(self):
        return b''


class AsyncTransport(Transport):
    async def json(self, *args, **kwargs):
        return super().json(*args, **kwargs)

    async def send(self, method, path, **kwargs):
        self.count.enter()
        until = time.monotonic() + 1
        while self.count.now < 8 and time.monotonic() < until:
            await asyncio.sleep(0.001)
        await asyncio.sleep(0.02)
        self.count.leave()
        return self

    async def read(self):
        return b''


class UploadParallel(unittest.TestCase):
    def test_sync_keeps_eight_chunks_in_flight(self):
        transport = Transport()
        Files(transport, 'sandbox').write('/workspace/big.bin', b'x' * (16 * MIB))
        self.assertEqual((transport.count.chunks, transport.count.most), (16, 8))

    def test_async_keeps_eight_chunks_in_flight(self):
        transport = AsyncTransport()
        asyncio.run(AsyncFiles(transport, 'sandbox').write('/workspace/big.bin', b'x' * (16 * MIB)))
        self.assertEqual((transport.count.chunks, transport.count.most), (16, 8))


if __name__ == '__main__':
    unittest.main()
