"""Prime request boundaries, nested values and keyword errors."""
import asyncio
import importlib.metadata
import inspect
import os
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from withruntime._errors import RuntimeError as NativeError
from withruntime.prime import SandboxClient, AsyncSandboxClient
from withruntime._compat import CompatibilityError
from withruntime.prime.exceptions import SandboxNotRunningError, translate
from withruntime.prime import models


def sandbox_data():
    return dict(id='box', name='box', dockerImage='python:3.13', cpuCores=1., memoryGB=1., diskSizeGB=5.,
                diskMountPath='/workspace', gpuCount=0, status='RUNNING', timeoutMinutes=60,
                createdAt='2026-09-30T00:00:00Z', updatedAt='2026-09-30T00:00:00Z')


def drop(call):
    """A recorded call without its per-call output callback."""
    return call[0], call[1], {k: v for k, v in call[2].items() if k != 'on_stdout'}


class Validation(unittest.TestCase):
    class FalseyClient:
        def __bool__(self):
            return False

    def test_constructor_routes_explicit_runtime_endpoint_in_both_generated_modes(self):
        from withruntime.prime._async import AsyncSandboxClient as NativeAsyncClient
        endpoint = 'https://runtime.example.test'
        for client, native in ((SandboxClient, 'withruntime.prime._sync.Runtime'),
                               (NativeAsyncClient, 'withruntime.prime._async.AsyncRuntime')):
            with self.subTest(client=client.__name__), patch(native) as constructor:
                value = client(api_key='rtcloud_never_sent', base_url=endpoint)
                constructor.assert_called_once_with(api_key='rtcloud_never_sent', base_url=endpoint)
                self.assertIs(value._runtime, constructor.return_value)
                constructor.reset_mock()
                injected = self.FalseyClient()
                self.assertIs(client(api_client=injected, base_url=endpoint)._runtime, injected)
                constructor.assert_not_called()

    def test_background_output_default_keywords_preserve_both_clients(self):
        runtime = self.FalseyClient()
        defaults = dict(background_job_output_concurrency=20, background_job_output_queue_size=200,
                        background_job_output_cache_bytes=64 * 1024 * 1024)
        self.assertIs(SandboxClient(api_client=runtime, **defaults)._runtime, runtime)
        self.assertIs(AsyncSandboxClient(runtime=runtime, **defaults)._runtime, runtime)

    def test_background_output_custom_and_invalid_limits_refuse_before_client_creation(self):
        cases = (("background_job_output_concurrency", 1, CompatibilityError),
                 ("background_job_output_queue_size", 1, CompatibilityError),
                 ("background_job_output_cache_bytes", 0, CompatibilityError),
                 ("background_job_output_concurrency", 0, ValueError),
                 ("background_job_output_queue_size", 0, ValueError),
                 ("background_job_output_cache_bytes", -1, ValueError))
        with patch('withruntime.prime._sync.Runtime') as sync_runtime, patch('withruntime.prime._AsyncRuntime') as async_runtime:
            for client in (SandboxClient, AsyncSandboxClient):
                for keyword, value, error in cases:
                    with self.subTest(client=client.__name__, keyword=keyword, value=value), self.assertRaises(error):
                        client(api_key='never-sent', **{keyword: value})
            sync_runtime.assert_not_called()
            async_runtime.assert_not_called()

    def test_named_guest_user_fails_before_native_effects_in_both_modes(self):
        class NoLookup:
            def get(self, sandbox_id):
                self.fail_lookup(sandbox_id)
            @staticmethod
            def fail_lookup(sandbox_id):
                raise AssertionError('User refusal must precede sandbox lookup: ' + sandbox_id)
        runtime = SimpleNamespace(sandboxes=NoLookup())
        synchronous = SandboxClient(api_client=runtime)
        asynchronous = AsyncSandboxClient(runtime=runtime)
        for name in ('execute_command', 'start_background_job'):
            method = getattr(synchronous, name)
            for user in ('root', 'runner', ''):
                error = ValueError if user == '' else CompatibilityError
                with self.subTest(mode='sync', method=name, user=user), self.assertRaisesRegex(error, 'guest user'):
                    method('box', 'echo hello', user=user)
                args = ('box', 'echo hello', None, None, None, user) if name == 'execute_command' else ('box', 'echo hello', None, None, user)
                with self.assertRaisesRegex(error, 'guest user'):
                    method(*args)
        async def run():
            for name in ('execute_command', 'start_background_job', 'open_process'):
                method = getattr(asynchronous, name)
                for user in ('root', 'runner', ''):
                    error = ValueError if user == '' else CompatibilityError
                    with self.subTest(mode='async', method=name, user=user), self.assertRaisesRegex(error, 'guest user'):
                        await method('box', 'echo hello', user=user)
                    args = ('box', 'echo hello', None, None, None, user) if name == 'execute_command' else ('box', 'echo hello', None, None, user)
                    with self.assertRaisesRegex(error, 'guest user'):
                        await method(*args)
        asyncio.run(run())

    def test_omitted_and_none_user_preserve_command_and_process_consumers(self):
        result = SimpleNamespace(stdout='hello', stderr='', exit_code=0, timed_out=False,
            stdout_truncated=False, stderr_truncated=False)
        class Files:
            def read(self, path):
                return b'{}'
        class Box:
            files = Files()
            def exec(self, command, **options):
                calls.append(('exec', command, options))
                return result
            def spawn(self, command, **options):
                calls.append(('spawn', command, options))
                return object()
        calls = []
        box = Box()
        client = SandboxClient(api_client=SimpleNamespace(sandboxes=SimpleNamespace(get=lambda sandbox_id: box)))
        for kwargs in ({}, {'user': None}):
            value = client.execute_command('box', 'echo hello', working_dir='/workspace', env={'A': 'B'}, **kwargs)
            self.assertEqual((value.stdout, value.stderr, value.exit_code), ('hello', '', 0))
            job = client.start_background_job('box', 'echo hello', working_dir='/workspace', env={'A': 'B'}, **kwargs)
            self.assertEqual(calls[-1][1][4:8], [job.stdout_log_file, job.stderr_log_file, job.exit_file, 'echo hello'])
        # Each call drains output through its own fresh callback; compare the rest.
        self.assertTrue(callable(calls[0][2]['on_stdout']) and callable(calls[2][2]['on_stdout']))
        self.assertEqual(drop(calls[0]), drop(calls[2]))
        self.assertEqual(calls[1][2], calls[3][2])
        self.assertEqual(calls[0][2]['env'], {'A': 'B'})
        class Process:
            async def output_bytes(self):
                yield {'type': 'exit', 'exitCode': 0}
        class AsyncFiles:
            async def read(self, path):
                return b'{}'
        class AsyncBox:
            files = AsyncFiles()
            async def exec(self, command, **options):
                return box.exec(command, **options)
            async def spawn(self, command, **options):
                box.spawn(command, **options)
                return Process()
        async def get(sandbox_id):
            return AsyncBox()
        async def run():
            calls.clear()
            client = AsyncSandboxClient(runtime=SimpleNamespace(sandboxes=SimpleNamespace(get=get)))
            for kwargs in ({}, {'user': None}):
                value = await client.execute_command('box', 'echo hello', working_dir='/workspace', env={'A': 'B'}, **kwargs)
                self.assertEqual((value.stdout, value.stderr, value.exit_code), ('hello', '', 0))
                job = await client.start_background_job('box', 'echo hello', working_dir='/workspace', env={'A': 'B'}, **kwargs)
                self.assertEqual(calls[-1][1][4:8], [job.stdout_log_file, job.stderr_log_file, job.exit_file, 'echo hello'])
                process = await client.open_process('box', 'echo hello', working_dir='/workspace', env={'A': 'B'}, **kwargs)
                self.assertEqual(await process.wait(), 0)
                await process.aclose()
            self.assertEqual(drop(calls[0]), drop(calls[3]))
            self.assertEqual(calls[1][2], calls[4][2])
            self.assertEqual(calls[2], calls[5])
            self.assertEqual(calls[2][2], {'cwd': '/workspace', 'env': {'A': 'B'}, 'stdin': 'pipe', 'output_encoding': 'base64'})
        asyncio.run(run())

    @unittest.skipUnless(os.environ.get('RUNTIME_COMPAT_OFFICIAL') == '1', 'Pinned official SDK opt-in')
    def test_pinned_official_user_signatures_and_rpc_validation_match_review(self):
        self.assertEqual(importlib.metadata.version('prime-sandboxes'), '0.4.1')
        from prime_sandboxes import SandboxClient as OfficialSync, AsyncSandboxClient as OfficialAsync
        from prime_sandboxes.rpc_command_session import build_command_session_start_request
        for runtime, official in ((SandboxClient, OfficialSync), (AsyncSandboxClient, OfficialAsync)):
            ours = inspect.signature(runtime)
            theirs = inspect.signature(official)
            for name in ('background_job_output_concurrency', 'background_job_output_queue_size', 'background_job_output_cache_bytes'):
                self.assertEqual(ours.parameters[name].default, theirs.parameters[name].default)
                self.assertEqual(ours.parameters[name].kind, theirs.parameters[name].kind)
        for runtime, official in ((SandboxClient, OfficialSync), (AsyncSandboxClient, OfficialAsync)):
            for name in ('execute_command', 'start_background_job'):
                ours = inspect.signature(getattr(runtime, name))
                theirs = inspect.signature(getattr(official, name))
                self.assertEqual(list(ours.parameters), list(theirs.parameters))
                self.assertIsNone(ours.parameters['user'].default)
                self.assertIsNone(theirs.parameters['user'].default)
        self.assertEqual(list(inspect.signature(AsyncSandboxClient.open_process).parameters),
            list(inspect.signature(OfficialAsync.open_process).parameters))
        omitted = build_command_session_start_request(command='echo hello', working_dir=None, env=None)
        explicit_none = build_command_session_start_request(command='echo hello', working_dir=None, env=None, user=None)
        self.assertEqual(omitted, explicit_none)
        self.assertFalse(omitted.command.HasField('user'))
        named = build_command_session_start_request(command='echo hello', working_dir=None, env=None, user='runner')
        self.assertEqual(named.command.user, 'runner')
        with self.assertRaisesRegex(ValueError, 'user must be a non-empty guest username'):
            build_command_session_start_request(command='echo hello', working_dir=None, env=None, user='')

    def test_invalid_network_rules_are_rejected_by_request_before_allocation(self):
        for entry in ('', '*', 'a..example', 'https://example.com', 'user@example.com',
                      'example.com:443', 'example.com/path', 'example.com?q=x',
                      '2001:db8::1', '2001:db8::/64', 'bad.*.example'):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                models.CreateSandboxRequest(name='box', docker_image='python:3.13', network_allowlist=[entry])
        for entry in ('example.com', '*.example.com', '192.0.2.1', '192.0.2.11/24', ' example.com. '):
            request = models.CreateSandboxRequest(name='box', docker_image='python:3.13', network_denylist=[entry])
            self.assertEqual(request.network_denylist, [entry])

    def test_nested_start_command_validates_and_exposes_attributes(self):
        request = models.CreateSandboxRequest(name='box', docker_image='python:3.13',
            start_command={'executable': 'echo', 'args': ['hello']})
        self.assertEqual(request.start_command.executable, 'echo')
        self.assertEqual(request.model_dump()['start_command'], {'executable': 'echo', 'args': ['hello']})
        for value in ({'executable': ''}, {'executable': 'bad\0'}, {'executable': 'echo', 'args': ['bad\0']}):
            with self.assertRaises(ValueError):
                models.CreateSandboxRequest(name='box', docker_image='python:3.13', start_command=value)

    def test_list_and_batch_nested_values_support_unchanged_attribute_consumers(self):
        response = models.SandboxListResponse(sandboxes=[sandbox_data()], total=1, page=1, perPage=50, hasNext=False)
        self.assertEqual(response.sandboxes[0].id, 'box')
        batch = models.BatchSandboxStatusResponse(statuses=[{'sandbox_id': 'box', 'status': 'PAUSED'}],
            errors=[{'sandbox_id': 'missing', 'code': 'NOT_FOUND', 'message': 'missing'}])
        self.assertEqual(batch.statuses[0].status, models.SandboxStatus.PAUSED)
        self.assertEqual(batch.errors[0].code, 'NOT_FOUND')
        policy = models.EgressPolicyStatus(policy={'allowlist': ['example.com']}, generation=1, applied_generation=1, applied=True)
        self.assertEqual(policy.policy.allowlist, ['example.com'])
        jobs = models.BatchBackgroundJobStatusResponse(statuses=[{'sandbox_id': 'box', 'job_id': 'a', 'completed': False}],
            errors=[{'sandbox_id': 'box', 'job_id': 'b', 'code': 'NOT_RUNNING', 'message': 'paused'}])
        self.assertEqual(jobs.statuses[0].job_id, 'a')
        self.assertEqual(jobs.errors[0].code, 'NOT_RUNNING')

    def test_invalid_status_and_lookup_code_are_rejected(self):
        with self.assertRaises(ValueError):
            models.SandboxStatusSnapshot(sandbox_id='box', status='STOPPED')
        with self.assertRaises(ValueError):
            models.SandboxStatusLookupError(sandbox_id='box', code='BOGUS', message='error')
        with self.assertRaises(ValueError):
            models.BackgroundJobStatusLookupError(sandbox_id='box', job_id='a', code='BOGUS', message='error')

    def test_advanced_config_extra_fields_survive_nested_roundtrip(self):
        value = models.Sandbox(**sandbox_data(), advancedConfigs={'vendor_option': 'retained'})
        self.assertEqual(value.advanced_configs.vendor_option, 'retained')
        self.assertEqual(value.model_dump(by_alias=True)['advancedConfigs'], {'vendor_option': 'retained'})

    def test_paused_native_state_matches_official_enum(self):
        view = SandboxClient(api_client=object())._view(SimpleNamespace(id='box', state='paused', info={
            'name': 'box', 'image': 'python:3.13', 'vcpu': 1, 'memoryMiB': 1024, 'diskMiB': 5120,
            'createdAt': '2026-09-30T00:00:00Z', 'updatedAt': '2026-09-30T00:00:00Z'}))
        self.assertEqual(models.SandboxStatus(view.status), models.SandboxStatus.PAUSED)

    def test_keyword_errors_retain_sandbox_identity_and_native_cause(self):
        class Client:
            @translate
            def get(self, sandbox_id):
                raise NativeError('paused', code='sandbox_not_running', status=409)
            @translate
            async def async_get(self, sandbox_id):
                raise NativeError('paused', code='sandbox_not_running', status=409)
        with self.assertRaises(SandboxNotRunningError) as caught:
            Client().get(sandbox_id='box')
        self.assertEqual(caught.exception.sandbox_id, 'box')
        self.assertIsInstance(caught.exception.__cause__, NativeError)
        async def run():
            with self.assertRaises(SandboxNotRunningError) as caught:
                await Client().async_get(sandbox_id='box')
            self.assertEqual(caught.exception.sandbox_id, 'box')
        asyncio.run(run())

    @unittest.skipUnless(os.environ.get('RUNTIME_COMPAT_OFFICIAL') == '1', 'Pinned official SDK opt-in')
    def test_pinned_official_nested_request_response_and_validation_match(self):
        self.assertEqual(importlib.metadata.version('prime-sandboxes'), '0.4.1')
        from prime_sandboxes import models as official
        for provider in (models, official):
            request = provider.CreateSandboxRequest(name='box', docker_image='python:3.13',
                start_command={'executable': 'echo', 'args': ['hello']})
            self.assertEqual(request.start_command.executable, 'echo')
            response = provider.SandboxListResponse(sandboxes=[sandbox_data()], total=1, page=1, perPage=50, hasNext=False)
            self.assertEqual(response.sandboxes[0].id, 'box')
            with self.assertRaises(ValueError):
                provider.SandboxStatusSnapshot(sandbox_id='box', status='STOPPED')
            for entry in ('https://example.com/path', '*.bad.*.example', '2001:db8::1'):
                with self.assertRaises(ValueError):
                    provider.CreateSandboxRequest(name='box', docker_image='python:3.13', network_allowlist=[entry])
        self.assertEqual(models.SandboxListResponse(sandboxes=[sandbox_data()], total=1, page=1, perPage=50, hasNext=False).model_dump(by_alias=True),
                         official.SandboxListResponse(sandboxes=[sandbox_data()], total=1, page=1, perPage=50, hasNext=False).model_dump(by_alias=True))
