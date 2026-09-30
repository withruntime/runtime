"""A watch that sends to the account's webhooks, and a preview that names the
sites that may embed it: the bodies both clients send."""
import asyncio
import unittest

from withruntime._async_products.previews import AsyncPreviews
from withruntime._async_products.watch import AsyncWatches
from withruntime._sync_products.previews import Previews
from withruntime._sync_products.watch import Watches

SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"


class Sandbox:
    id = SANDBOX


class Transport:
    def __init__(self):
        self.calls = []

    def json(self, method, path, body=None, idempotency_key=None, **kwargs):
        self.calls.append((method, path, body))
        return {"id": "sync", "path": "/workspace/app", "processId": "p1", "state": "running",
                "startedAt": 0, "cursor": 0, "webhook": True}


class AsyncTransport(Transport):
    async def json(self, *args, **kwargs):
        return super().json(*args, **kwargs)


class Bodies(unittest.TestCase):
    WATCH = {"path": "/workspace/app", "recursive": True, "timeoutMs": 0, "id": "sync", "webhook": True}
    PREVIEW = {"port": 3000, "embedOrigins": ["https://app.example.com"]}

    def test_sync(self):
        t = Transport()
        Watches(t, SANDBOX).start("/workspace/app", recursive=True, timeout_ms=0, id="sync", webhook=True)
        Previews(t, Sandbox()).create(3000, embed_origins=["https://app.example.com"])
        self.assertEqual(t.calls[0], ("POST", f"/v1/sandboxes/{SANDBOX}/files/watches", self.WATCH))
        self.assertEqual(t.calls[1][2], self.PREVIEW)

    def test_async(self):
        t = AsyncTransport()

        async def run():
            await AsyncWatches(t, SANDBOX).start("/workspace/app", recursive=True, timeout_ms=0, id="sync",
                                                 webhook=True)
            await AsyncPreviews(t, Sandbox()).create(3000, embed_origins=["https://app.example.com"])
        asyncio.run(run())
        self.assertEqual(t.calls[0][2], self.WATCH)
        self.assertEqual(t.calls[1][2], self.PREVIEW)


if __name__ == "__main__":
    unittest.main()
