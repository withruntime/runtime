"""An orchestrator moved from E2B runs one agent per sandbox, a thousand at
once, each in commands.run. One address may hold 64 connections to the API,
and each running command's output is a stream that holds one. Streams and
calls share the client's cap: the rest wait their turn and then run, rather
than having their connections reset. Driven over a fake wire."""
import asyncio
import json
import threading
import time
import unittest

from withruntime import AsyncRuntime, Runtime
from withruntime.e2b import AsyncSandbox

SANDBOX = {"id": "sbx", "kind": "sandbox", "state": "running", "status": "active", "labels": {},
           "vcpu": 2, "memoryMiB": 512, "expiresAt": "2099-01-01T00:00:00Z", "createdAt": "2026-10-03T00:00:00Z"}


class Wire:
    """Counts connections open at once. A stream stays open ``hold`` seconds."""

    def __init__(self, is_async, hold=0.015):
        self.is_async, self.hold, self.open, self.peak, self.lock = is_async, hold, 0, 0, threading.Lock()
        self.count = 0

    def _opened(self):
        with self.lock:
            self.open += 1
            self.count += 1
            self.peak = max(self.peak, self.open)

    def _closed(self):
        with self.lock:
            self.open -= 1

    def send(self, method, target, headers, data, timeout, **_):
        self._opened()
        path = target.split("?")[0]
        streaming = headers.get("Accept") == "application/x-ndjson"
        if streaming:
            pid = f"p{self.count}"
            body = [json.dumps({"type": "start", "processId": pid}),
                    json.dumps({"type": "stdout", "data": "ok\n", "offset": 0}),
                    json.dumps({"type": "exit", "exitCode": 0, "state": "exited", "timedOut": False})]
        else:
            body = []
        answer_body = json.dumps(SANDBOX if path == "/v1/sandboxes" or path.startswith("/v1/sandboxes/sbx")
                                 and method == "GET" else {}).encode()
        wire, is_async = self, self.is_async

        class Answer:
            status, headers = 200, {}

            if is_async:
                async def read(self, limit=None):
                    wire._closed()
                    return answer_body

                async def lines(self, deadline=None):
                    yield body[0]
                    await asyncio.sleep(wire.hold)
                    for line in body[1:]:
                        yield line

                async def close(self):
                    if streaming:
                        wire._closed()
            else:
                def read(self, limit=None):
                    wire._closed()
                    return answer_body

                def lines(self, deadline=None):
                    yield body[0]
                    time.sleep(wire.hold)
                    yield from body[1:]

                def close(self):
                    if streaming:
                        wire._closed()
        answer = Answer()
        if is_async:
            async def later():
                return answer
            return later()
        return answer


class ConnectionCap(unittest.TestCase):
    def test_sixty_e2b_commands_at_once_stay_under_the_cap_and_all_finish(self):
        wire = Wire(True)
        client = AsyncRuntime(api_key="rk", base_url="https://api.example.test", max_connections=12)
        client._t._http = wire

        async def main():
            sbx = await AsyncSandbox.create(client=client)
            return await asyncio.gather(*(sbx.commands.run(f"echo {i}") for i in range(60)))
        results = asyncio.run(main())
        self.assertTrue(all(r.exit_code == 0 and r.stdout == "ok\n" for r in results))
        self.assertLessEqual(wire.peak, 12)

    def test_streams_keep_connections_for_calls_sync_and_async(self):
        # Twenty streams at once on a cap of twelve: at most four are open
        # (eight are kept for calls), and calls beside them never wait long.
        wire = Wire(True, hold=0.05)
        client = AsyncRuntime(api_key="rk", base_url="https://api.example.test", max_connections=12)
        client._t._http = wire

        async def stream():
            return [e async for e in client._t.events("GET", "/v1/stream")]

        async def main():
            readers = asyncio.gather(*(stream() for _ in range(20)))
            await asyncio.sleep(0.01)
            started = time.monotonic()
            await asyncio.gather(*(client._t.json("GET", "/v1/me") for _ in range(8)))
            calls = time.monotonic() - started
            return await readers, calls
        streams, calls = asyncio.run(main())
        self.assertEqual(len(streams), 20)
        self.assertLess(calls, 0.04)
        self.assertLessEqual(wire.peak, 12)

        wire = Wire(False, hold=0.05)
        client = Runtime(api_key="rk", base_url="https://api.example.test", max_connections=12)
        client._t._http = wire
        done = []
        threads = [threading.Thread(target=lambda: done.append(list(client._t.events("GET", "/v1/stream"))))
                   for _ in range(20)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(done), 20)
        self.assertLessEqual(wire.peak, 12 - 8)


if __name__ == "__main__":
    unittest.main()
