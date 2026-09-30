import asyncio
import base64
import unittest
from withruntime._sync_client import Process
from withruntime._async_client import AsyncProcess

PAYLOAD = bytes(range(256))
class Wire:
    def __init__(self):
        self.cursors = []
    def events(self, method, path, query, timeout):
        self.cursors.append(query['cursor'])
        if query['cursor'] == 0:
            yield {'type': 'stdout', 'data': 'replacement', 'base64': base64.b64encode(PAYLOAD).decode(), 'offset': 0}
        else:
            yield {'type': 'exit', 'exitCode': 0, 'state': 'exited', 'timedOut': False}
class AsyncWire(Wire):
    async def events(self, *args, **kwargs):
        for event in super().events(*args, **kwargs):
            yield event
class OutputTests(unittest.TestCase):
    def test_sync_bytes_and_reconnect_cursor(self):
        wire = Wire()
        events = list(Process(wire, 's', {'id': 'p', 'outputEncoding': 'base64'}).output_bytes())
        self.assertEqual(events[0]['data'], PAYLOAD)
        self.assertEqual(wire.cursors, [0, 256])
        self.assertFalse(any(e['type'] == 'truncated' for e in events))
    def test_async_bytes_and_reconnect_cursor(self):
        async def run():
            wire = AsyncWire()
            events = [e async for e in AsyncProcess(wire, 's', {'id': 'p', 'outputEncoding': 'base64'}).output_bytes()]
            self.assertEqual(events[0]['data'], PAYLOAD)
            self.assertEqual(wire.cursors, [0, 256])
        asyncio.run(run())
    def test_old_process_refused_before_read(self):
        wire = Wire()
        with self.assertRaisesRegex(Exception, 'output_encoding'):
            list(Process(wire, 's', {'id': 'p'}).output_bytes())
        self.assertEqual(wire.cursors, [])

    def test_malformed_binary_output_is_not_retried(self):
        class BadWire(Wire):
            def events(self, method, path, query, timeout):
                self.cursors.append(query['cursor'])
                yield {'type': 'stdout', 'data': '', 'base64': '!invalid!', 'offset': 0}
        wire = BadWire()
        with self.assertRaises(Exception) as failure:
            list(Process(wire, 's', {'id': 'p', 'outputEncoding': 'base64'}).output_bytes())
        self.assertEqual(failure.exception.code, 'invalid_process_output')
        self.assertEqual(wire.cursors, [0])
