"""Client execution deadlines over real local HTTP, without interrupting a cell."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from withruntime._sync_client import _Transport, Sandbox
from withruntime._async_client import _Transport as AsyncTransport, AsyncSandbox
from withruntime.e2b.code_interpreter import Sandbox as E2B, AsyncSandbox as AsyncE2B
from withruntime.e2b import TimeoutException
from withruntime._request_scope import request_scope, current


BODY_DELAY, BUDGET = .3, .1


class InterpreterDeadline(unittest.TestCase):
    def setUp(self):
        self.requests, self.completed = [], threading.Event()
        owner = self
        class Peer(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.requests.append(body)
                self.send_response(200)
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.flush()
                # This peer represents a cell owned independently of its reader. Its
                # answer comes BODY_DELAY after the headers: three times the header
                # and detach budgets below, so a loaded machine keeps the order.
                time.sleep(BODY_DELAY)
                execution = {'status': 'succeeded', 'stdout': 'done\n', 'stderr': '',
                             'results': [], 'error': None, 'executionCount': 1}
                data = ([{'k': 'stdout', 'text': 'done\n'}, {'k': 'execution', 'execution': execution}]
                        if body.get('stream') else None)
                payload = ''.join(json.dumps(event)+'\n' for event in data).encode() if data else json.dumps(execution).encode()
                try:
                    self.wfile.write(payload)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError): pass
                finally: owner.completed.set()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Peer)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01))
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_address[1]}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def test_sync_unlimited_execution_and_finite_detach(self):
        transport = _Transport('local', self.origin, BUDGET, 0)
        sandbox = E2B(Sandbox(transport, {'id': 'owned'}), None)
        try:
            self.assertEqual(sandbox.run_code('x', timeout=0, request_timeout=BUDGET).logs.stdout, ['done\n'])
            with self.assertRaises(TimeoutException): sandbox.run_code('x', timeout=BUDGET)
            self.assertTrue(self.completed.wait(3))
            self.assertTrue(all(x['timeoutMs'] == 0 and x['interruptOnDisconnect'] is False for x in self.requests))
            with self.assertRaises(TimeoutError):
                with request_scope(BUDGET): sandbox.runtime.interpreter.run('x', timeout_ms=0)
        finally: transport.close()

    def test_async_detach_cancellation_and_awaited_callbacks_close_stream(self):
        async def run():
            transport = AsyncTransport('local', self.origin, BUDGET, 0)
            sandbox = AsyncE2B(AsyncSandbox(transport, {'id': 'owned'}), None)
            seen = []
            async def callback(message):
                await asyncio.sleep(.005)
                seen.append(message.line)
            try:
                result = await sandbox.run_code('x', timeout=0, on_stdout=callback, request_timeout=BUDGET)
                self.assertEqual(result.logs.stdout, seen)
                with self.assertRaises(TimeoutException): await sandbox.run_code('x', timeout=BUDGET)
                task = asyncio.create_task(sandbox.run_code('x', timeout=0))
                await asyncio.sleep(.01)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                self.assertEqual(len(transport._http._writers), 0)
                async def fail(message): raise ValueError('callback failed')
                with self.assertRaisesRegex(Exception, 'callback failed'):
                    await sandbox.run_code('x', timeout=0, on_stdout=fail)
                self.assertEqual(len(transport._http._writers), 0)
                self.assertIsNone(current().deadline)
            finally: await transport.close()
        asyncio.run(run())

    def test_connect_budget_does_not_become_body_deadline(self):
        from withruntime import _http
        original = _http.open_stream
        observed = []
        async def opened(origin, timeout):
            observed.append(timeout)
            return await original(origin, timeout)
        async def run():
            transport = AsyncTransport('local', self.origin, BUDGET, 0)
            try:
                with patch.object(_http, 'open_stream', opened):
                    result = await AsyncE2B(AsyncSandbox(transport, {'id': 'owned'}), None).run_code('x', timeout=0, request_timeout=BUDGET * 1.5)
                self.assertEqual(result.logs.stdout, ['done\n'])
                self.assertEqual(observed, [BUDGET * 1.5])
            finally: await transport.close()
        asyncio.run(run())
