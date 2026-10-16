"""E2B 2.53.1 / interpreter 2.10.3 requalification; no vendor network.

RUNTIME_COMPAT_OFFICIAL=1 compares the real wheels installed by
prepare_compatibility.py, including changed errors and unchanged teardown.
"""
import asyncio
import importlib
import importlib.metadata
import os
import socket
import unittest
from types import ModuleType
from unittest.mock import Mock, patch

import withruntime.e2b as runtime
from withruntime import RuntimeError
from withruntime.e2b import _core
from e2b_fake import World


class Availability(unittest.TestCase):
    def test_new_errors_import_from_both_packages_and_exceptions(self):
        for name in ('SandboxNotRunningException', 'SandboxUnreachableException'):
            cls = getattr(runtime, name)
            self.assertEqual(cls.__bases__, (runtime.TimeoutException,))
            for path in ('withruntime.e2b', 'withruntime.e2b.exceptions', 'withruntime.e2b.code_interpreter'):
                self.assertIs(getattr(importlib.import_module(path), name), cls)

    def test_confirmed_stopped_and_unreachable_are_distinct_and_keep_evidence(self):
        for code, status, name in (
            ('sandbox_stopped', 409, 'SandboxNotRunningException'),
            ('sandbox_paused', 409, 'SandboxNotRunningException'),
            ('sandbox_not_running', 409, 'SandboxNotRunningException'),
            ('sandbox_not_ready', 409, 'SandboxUnreachableException'),
            ('host_unavailable', 503, 'SandboxUnreachableException'),
        ):
            for subject in ('sandbox', 'file', 'file_http', 'other'):
                with self.subTest(code=code, subject=subject):
                    error = RuntimeError('Native explanation', code=code, status=status,
                                         hint='Next step', request_id='req_test')
                    result = _core.translate(error, subject)
                    self.assertEqual(type(result).__name__, name)
                    self.assertIsInstance(result, runtime.TimeoutException)
                    self.assertIs(result.__cause__, error)
                    self.assertEqual((result.code, result.status_code, result.hint, result.request_id),
                                     (code, status, 'Next step', 'req_test'))
                    self.assertEqual(str(result), 'Native explanation\nHint: Next step\nRequest: req_test')

    def test_unknown_failures_deadlines_and_feature_refusals_are_not_stopped(self):
        for code, status, expected in (
            ('connection_error', 0, 'SandboxException'),
            ('request_timeout', 0, 'TimeoutException'),
            ('command_timeout', 0, 'TimeoutException'),
            ('fork_unavailable', 503, 'NotSupportedException'),
            ('busy', 503, 'ServiceBusyException'),
            ('file_not_found', 404, 'FileNotFoundException'),
            ('not_found', 404, 'SandboxNotFoundException'),
        ):
            with self.subTest(code=code):
                self.assertEqual(type(_core.translate(RuntimeError('failure', code=code, status=status),
                                                     'sandbox')).__name__, expected)

    def test_sync_command_stream_failure_is_classified_without_restarting(self):
        for code, status, name in (('sandbox_stopped', 409, 'SandboxNotRunningException'),
                                  ('host_unavailable', 503, 'SandboxUnreachableException')):
            world = World()
            box = runtime.Sandbox.create(client=world.client())
            world.output_error = RuntimeError('Stream failed', code=code, status=status)
            with self.assertRaises(runtime.TimeoutException) as caught:
                box.commands.run('write-once')
            self.assertEqual(type(caught.exception).__name__, name)
            self.assertEqual(len(world.called('sandbox.exec_stream')), 1)

    def test_async_command_stream_failure_is_classified_without_restarting(self):
        async def run():
            for code, status, name in (('sandbox_stopped', 409, 'SandboxNotRunningException'),
                                      ('host_unavailable', 503, 'SandboxUnreachableException')):
                world = World()
                box = await runtime.AsyncSandbox.create(client=world.async_client())
                world.output_error = RuntimeError('Stream failed', code=code, status=status)
                with self.assertRaises(runtime.TimeoutException) as caught:
                    await box.commands.run('write-once')
                self.assertEqual(type(caught.exception).__name__, name)
                self.assertEqual(len(world.called('sandbox.exec_stream')), 1)
        asyncio.run(run())

    def test_sync_files_and_interpreter_keep_the_availability_error(self):
        from withruntime.e2b.code_interpreter import Sandbox
        world = World()
        box = Sandbox.create(client=world.client())
        native = world.sandboxes[box.sandbox_id]
        for code in ('sandbox_stopped', 'host_unavailable'):
            error = RuntimeError('Unavailable', code=code, status=409 if code == 'sandbox_stopped' else 503)
            with patch.object(native.files, 'write', side_effect=error) as write:
                with self.assertRaises(runtime.TimeoutException):
                    box.files.write('/tmp/result', 'write-once')
                self.assertEqual(write.call_count, 1)
            with patch.object(native.interpreter, 'run', side_effect=error) as execute:
                with self.assertRaises(runtime.TimeoutException):
                    box.run_code('write_once()')
                self.assertEqual(execute.call_count, 1)

    def test_async_files_and_interpreter_keep_the_availability_error(self):
        from withruntime.e2b.code_interpreter import AsyncSandbox
        async def run():
            world = World()
            box = await AsyncSandbox.create(client=world.async_client())
            native = world.sandboxes[box.sandbox_id]
            for code in ('sandbox_stopped', 'host_unavailable'):
                error = RuntimeError('Unavailable', code=code, status=409 if code == 'sandbox_stopped' else 503)
                with patch.object(native.files, 'write', side_effect=error) as write:
                    with self.assertRaises(runtime.TimeoutException):
                        await box.files.write('/tmp/result', 'write-once')
                    self.assertEqual(write.call_count, 1)
                with patch.object(native.interpreter, 'run', side_effect=error) as execute:
                    with self.assertRaises(runtime.TimeoutException):
                        await box.run_code('write_once()')
                    self.assertEqual(execute.call_count, 1)
        asyncio.run(run())


    def test_failed_delete_can_retry_and_successful_delete_is_not_repeated(self):
        world = World()
        box = runtime.Sandbox.create(client=world.client())
        native = world.sandboxes[box.sandbox_id]
        with patch.object(native, 'delete', side_effect=[RuntimeError('lost reply', code='connection_error'), {}]) as delete:
            with self.assertRaises(runtime.SandboxException):
                box.kill()
            self.assertTrue(box.kill())
            self.assertFalse(box.kill())
            self.assertEqual(delete.call_count, 2)

    def test_async_failed_delete_can_retry_and_success_is_not_repeated(self):
        async def run():
            world = World()
            box = await runtime.AsyncSandbox.create(client=world.async_client())
            native = world.sandboxes[box.sandbox_id]
            with patch.object(native, 'delete', side_effect=[RuntimeError('lost reply', code='connection_error'), {}]) as delete:
                with self.assertRaises(runtime.SandboxException):
                    await box.kill()
                self.assertTrue(await box.kill())
                self.assertFalse(await box.kill())
                self.assertEqual(delete.call_count, 2)
        asyncio.run(run())


@unittest.skipUnless(os.environ.get('RUNTIME_COMPAT_OFFICIAL') == '1', 'Pinned official SDK opt-in')
class Official(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from compatibility_pins import validate_pins
        validate_pins(installed_version=importlib.metadata.version)

    def setUp(self):
        blocker = patch.object(socket.socket, 'connect', side_effect=AssertionError('Vendor network forbidden'))
        blocker.start()
        self.addCleanup(blocker.stop)

    def test_all_official_exports_and_new_error_parents(self):
        for source, target in (('e2b', 'withruntime.e2b'),
                               ('e2b_code_interpreter', 'withruntime.e2b.code_interpreter')):
            official, adapter = importlib.import_module(source), importlib.import_module(target)
            names = getattr(official, '__all__', [name for name, value in vars(official).items()
                                                 if not name.startswith('_') and not isinstance(value, ModuleType)])
            self.assertEqual(set(names) - set(adapter.__all__), set())
            self.assertTrue(all(hasattr(adapter, name) for name in names))
            for name in ('SandboxNotRunningException', 'SandboxUnreachableException'):
                self.assertEqual([c.__name__ for c in getattr(official, name).__bases__],
                                 [c.__name__ for c in getattr(adapter, name).__bases__])

    def test_unavailable_message_helpers_match_official(self):
        from e2b import exceptions as official
        from withruntime.e2b import exceptions as adapter
        for message in ('sandbox abc was not found', 'port is not open', 'connection ended', '',
                        'was not found; port is not open'):
            with self.subTest(message=message):
                one = official.format_sandbox_unavailable_exception(message)
                two = adapter.format_sandbox_unavailable_exception(message)
                self.assertEqual((type(two).__name__, str(two)), (type(one).__name__, str(one)))
                for name in ('is_sandbox_not_found_message', 'is_sandbox_port_not_open_message'):
                    self.assertEqual(getattr(adapter, name)(message), getattr(official, name)(message))

    def test_interpreter_http_errors_match_official_including_empty_and_non_json(self):
        import httpx
        from e2b_code_interpreter import models as official
        from withruntime.e2b.code_interpreter import models as adapter
        for status in (200, 400, 401, 404, 429, 500, 502, 503, 599):
            for body in ('', '  \n ', '  failed\n ', '{"message":null}', '[]'):
                response = httpx.Response(status, text=body, headers={'X-E2B-Trace-ID': 'ignored'})
                for name in ('format_exception', 'extract_exception', 'aextract_exception'):
                    with self.subTest(status=status, body=body, helper=name):
                        first, second = getattr(official, name), getattr(adapter, name)
                        if name == 'aextract_exception':
                            one, two = asyncio.run(first(response)), asyncio.run(second(response))
                        else:
                            one, two = first(response), second(response)
                        self.assertEqual((type(two).__name__, str(two)), (type(one).__name__, str(one)))

    def test_sync_context_exit_kill_and_failure_propagation_match(self):
        from e2b import Sandbox
        for cls in (Sandbox, runtime.Sandbox):
            for failure in (False, True):
                box = object.__new__(cls)
                box.kill = Mock()
                try:
                    with box as entered:
                        self.assertIs(entered, box)
                        if failure:
                            raise ValueError('body failed')
                except ValueError as error:
                    self.assertTrue(failure)
                    self.assertEqual(str(error), 'body failed')
                else:
                    self.assertFalse(failure)
                box.kill.assert_called_once_with()
                box.kill.side_effect = RuntimeError('delete failed')
                with self.assertRaisesRegex(RuntimeError, 'delete failed'):
                    with box:
                        pass

    def test_async_context_exit_kill_and_failure_propagation_match(self):
        from e2b import AsyncSandbox
        from unittest.mock import AsyncMock
        async def run():
            for cls in (AsyncSandbox, runtime.AsyncSandbox):
                for failure in (False, True):
                    box = object.__new__(cls)
                    box.kill = AsyncMock()
                    try:
                        async with box as entered:
                            self.assertIs(entered, box)
                            if failure:
                                raise ValueError('body failed')
                    except ValueError as error:
                        self.assertTrue(failure)
                        self.assertEqual(str(error), 'body failed')
                    else:
                        self.assertFalse(failure)
                    box.kill.assert_awaited_once_with()
                    box.kill.side_effect = RuntimeError('delete failed')
                    with self.assertRaisesRegex(RuntimeError, 'delete failed'):
                        async with box:
                            pass
        asyncio.run(run())

    def test_connection_and_execution_defaults_match_new_wheels(self):
        import inspect
        from e2b.connection_config import ConnectionConfig
        from e2b.sandbox_sync.commands.command import Commands
        from e2b.sandbox_async.commands.command import Commands as AsyncCommands
        from e2b_code_interpreter import Sandbox, AsyncSandbox
        from withruntime.e2b.code_interpreter import Sandbox as AdapterSandbox, AsyncSandbox as AdapterAsync
        for official, adapter in ((Commands, runtime.Commands), (AsyncCommands, runtime.AsyncCommands)):
            for method in ('run', 'connect'):
                for name in ('timeout', 'request_timeout'):
                    self.assertEqual(inspect.signature(getattr(official, method)).parameters[name].default,
                                     inspect.signature(getattr(adapter, method)).parameters[name].default)
        for official, adapter in ((Sandbox, AdapterSandbox), (AsyncSandbox, AdapterAsync)):
            for name in ('timeout', 'request_timeout'):
                self.assertEqual(inspect.signature(official.run_code).parameters[name].default,
                                 inspect.signature(adapter.run_code).parameters[name].default)
        box = runtime.Sandbox.create(client=World().client())
        self.assertEqual(_core.request_seconds(box, None), ConnectionConfig().request_timeout)
        for value in (None, 0, 0.5, 12):
            self.assertEqual(_core.request_seconds(box, value) or None,
                             ConnectionConfig().get_request_timeout(value))
