"""A large upload shares its caller's one absolute deadline, and a failed one
still cleans up inside a scope of its own (10 October 2026).

The sync client's chunk workers ran in a thread pool whose threads did not
inherit the caller's request scope, so the deadline was dropped from every
chunk; and an expired deadline made the abort of the partial upload fail
with a timeout that replaced the original error."""
import asyncio
import time
import unittest

from withruntime._async_client import AsyncFiles
from withruntime._clock import sync_parallel
from withruntime._request_scope import current, request_scope
from withruntime._sync_client import Files

MIB = 1048576


class Transport:
    """Records what scope each call ran in; the chunk calls fail."""

    def __init__(self):
        self.deadlines, self.aborts = [], []

    def json(self, method, path, body=None, **kwargs):
        if path.endswith("/uploads"):
            return {"uploadId": "u", "chunkBytes": MIB}
        if path.endswith(":abort"):
            self.aborts.append(current().remaining())
        return {}

    def send(self, method, path, **kwargs):
        self.deadlines.append(current().deadline)
        raise RuntimeError("chunk failed")


class AsyncTransport(Transport):
    async def json(self, *args, **kwargs):
        return Transport.json(self, *args, **kwargs)

    async def send(self, method, path, **kwargs):
        return Transport.send(self, method, path, **kwargs)


class UploadDeadline(unittest.TestCase):
    def test_pool_workers_see_the_callers_deadline(self):
        seen = []
        with request_scope(30):
            expected = current().deadline
            sync_parallel(lambda _: seen.append(current().deadline), range(6), 3)
        self.assertEqual(seen, [expected] * 6)

    def test_a_failed_sync_upload_aborts_in_a_fresh_bounded_scope(self):
        transport = Transport()
        with request_scope(captured=None, timeout=30):
            with self.assertRaisesRegex(RuntimeError, "chunk failed"):
                Files(transport, "sandbox").write("/workspace/big", b"x" * (2 * MIB))
        self.assertGreaterEqual(len(transport.deadlines), 1)
        self.assertTrue(all(d is not None for d in transport.deadlines))
        self.assertEqual(len(transport.aborts), 1)
        self.assertTrue(0 < transport.aborts[0] <= 10)

    def test_an_expired_deadline_does_not_skip_the_abort_or_hide_the_error(self):
        transport = Transport()
        with request_scope(0.01):
            time.sleep(0.05)
            with self.assertRaisesRegex(RuntimeError, "chunk failed"):
                Files(transport, "sandbox").write("/workspace/big", b"x" * (2 * MIB))
        self.assertEqual(len(transport.aborts), 1)

    def test_async_abort_runs_in_a_fresh_bounded_scope_too(self):
        transport = AsyncTransport()

        async def run():
            with request_scope(0.01):
                await asyncio.sleep(0.05)
                with self.assertRaisesRegex(RuntimeError, "chunk failed"):
                    await AsyncFiles(transport, "sandbox").write("/workspace/big", b"x" * (2 * MIB))
        asyncio.run(run())
        self.assertEqual(len(transport.aborts), 1)
        self.assertTrue(0 < transport.aborts[0] <= 10)


if __name__ == "__main__":
    unittest.main()
