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


class AdapterClientIsWide(unittest.TestCase):
    """E2B's SDK holds no call back, so code written for it runs a hundred
    one-second commands from one process in about a second. The adapter's own
    client must not read them 40 at a time (Agentin rehearsal, 5 October 2026:
    three waves, 10.1, 20.4 and 30.7 s)."""

    def setUp(self):
        import os
        from withruntime.e2b import _async_sandbox, _sync_sandbox, _core
        self._env = os.environ.get("RUNTIME_API_KEY")
        os.environ["RUNTIME_API_KEY"] = "rtcloud_test"
        _async_sandbox._clients.clear()
        _sync_sandbox._clients.clear()
        _core._warned_queued = False

    def tearDown(self):
        import os
        from withruntime.e2b import _async_sandbox, _sync_sandbox
        if self._env is None:
            os.environ.pop("RUNTIME_API_KEY", None)
        else:
            os.environ["RUNTIME_API_KEY"] = self._env
        _async_sandbox._clients.clear()
        _sync_sandbox._clients.clear()

    def test_a_hundred_commands_at_once_async(self):
        from withruntime.e2b import _async_sandbox
        wire = Wire(True, hold=1.0)
        client = _async_sandbox._client(None, None)
        client._t._http = wire

        async def main():
            sbx = await AsyncSandbox.create()
            started = time.monotonic()
            results = await asyncio.gather(*(sbx.commands.run("sleep 1") for _ in range(100)))
            return results, time.monotonic() - started
        results, seconds = asyncio.run(main())
        self.assertTrue(all(r.exit_code == 0 for r in results))
        self.assertEqual(wire.peak, 100)
        self.assertLess(seconds, 1.8)

    def test_a_hundred_commands_at_once_sync(self):
        from concurrent.futures import ThreadPoolExecutor
        from withruntime.e2b import _sync_sandbox, Sandbox
        wire = Wire(False, hold=1.0)
        client = _sync_sandbox._client(None, None)
        client._t._http = wire
        sbx = Sandbox.create()
        started = time.monotonic()
        with ThreadPoolExecutor(100) as pool:
            results = list(pool.map(lambda _: sbx.commands.run("sleep 1"), range(100)))
        seconds = time.monotonic() - started
        self.assertTrue(all(r.exit_code == 0 for r in results))
        self.assertEqual(wire.peak, 100)
        self.assertLess(seconds, 1.8)

    def test_a_queued_call_warns_once(self):
        import warnings
        from withruntime.e2b import _core
        wire = Wire(True, hold=0.05)
        client = AsyncRuntime(api_key="rk", base_url="https://api.example.test", max_connections=9,
                              on_queued=_core.warn_queued)
        client._t._http = wire

        async def main():
            async def stream():
                return [e async for e in client._t.events("GET", "/v1/stream")]
            return await asyncio.gather(*(stream() for _ in range(5)))
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            asyncio.run(main())
        said = [str(w.message) for w in caught if "wait their turn" in str(w.message)]
        self.assertEqual(len(said), 1)
        self.assertIn("More than 9 calls", said[0])
