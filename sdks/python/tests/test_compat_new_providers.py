"""New providers exercised against the native SDK fake, including failed setup.

These tests establish adapter mappings. They do not claim provider/platform parity.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parent))
from dropin_fake import DropInWorld
from e2b_fake import Result, FakeFiles, FakeSandbox, FakeProcess, Page, Asyncified
from withruntime._compat import CompatibilityError, ENV_PATH, dockerfile, runtime_key
from withruntime.runloop import RunloopSDK, AsyncRunloopSDK
from withruntime.prime import SandboxClient, AsyncSandboxClient, CreateSandboxRequest, StartCommand
from withruntime.sprites import SpritesClient, ListOptions, ExitError, TimeoutError as SpriteTimeoutError
from withruntime.modal import Sandbox, Image, Secret, App


class Base(unittest.TestCase):
    def setUp(self):
        self.world = DropInWorld()
        self.client = self.world.client()
        original_write = FakeFiles.write
        def write(files, path, data, mode=None):
            files._w.record("files.mode", path, mode)
            return original_write(files, path, data)
        original_exec = FakeSandbox.exec
        def execute(sb, command, **options):
            # The fake guest does not execute bash. Model just the capture
            # wrapper; a separate real subprocess test runs its actual source.
            if isinstance(command, list) and len(command) > 6 and command[3] == "runtime-sprites":
                result = original_exec(sb, command[6:], **options)
                directory = command[4]
                sb.files.write(directory + "/stdout", result.stdout.encode())
                sb.files.write(directory + "/stderr", result.stderr.encode())
                return Result(result.exit_code, "", "", result.timed_out)
            return original_exec(sb, command, **options)
        def output_bytes(process):
            for event in process.output():
                yield {**event, "data": event["data"].encode()} if isinstance(event.get("data"), str) else event
        def update(sb, **settings):
            sb._w.record("sandbox.update", settings)
            sb.info.update(settings)
            return sb
        async def iterate(page):
            for item in page._target._items:
                yield Asyncified(item)
        for obj, name, method in ((FakeFiles, "write", write), (FakeSandbox, "exec", execute), (FakeProcess, "output_bytes", output_bytes), (Page, "__iter__", lambda page: iter(page._items)),
                                  (Asyncified, "__aiter__", iterate), (FakeSandbox, "update", update)):
            patcher = patch.object(obj, name, method, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def created(self):
        return self.world.called("sandboxes.create")[-1][0]


class Credentials(unittest.TestCase):
    def test_vendor_key_refused_and_runtime_key_preferred(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(runtime_key())
            with self.assertRaises(CompatibilityError):
                runtime_key("competitor-secret")
            self.assertEqual(runtime_key("rtcloud_test"), "rtcloud_test")
        with patch.dict(os.environ, {"RUNTIME_API_KEY": "rtcloud_env"}, clear=True):
            self.assertEqual(runtime_key("competitor-secret"), "rtcloud_env")

    def test_vendor_origin_is_never_forwarded(self):
        with patch("withruntime.runloop._sync.Runtime") as runtime:
            RunloopSDK(base_url="https://api.runloop.ai")
            self.assertNotIn("base_url", runtime.call_args.kwargs)

    def test_docker_reference_cannot_add_instructions(self):
        for invalid in ("ubuntu\nRUN malicious", "ubuntu --platform=arm64", "", "ubuntu\rRUN bad"):
            with self.assertRaises(ValueError):
                dockerfile(invalid)
        self.assertEqual(dockerfile("ghcr.io/user/app@sha256:123"), "FROM ghcr.io/user/app@sha256:123\n")


class RunloopTests(Base):

    def test_reconnect_preserves_environment_and_binary_files(self):
        sdk = RunloopSDK(runtime=self.client)
        box = sdk.devbox.create(name="agent", environment_variables={"TOKEN": "secret"})
        payload = bytes(range(256)) * 5000
        box.file.upload(path="/workspace/binary", file=payload)
        self.assertEqual(box.file.download(path="/workspace/binary"), payload)
        reconnected = RunloopSDK(runtime=self.client).devbox.from_id(box.id)
        result = reconnected.cmd.exec("echo ok")
        self.assertTrue(result.success)
        self.assertEqual(self.world.called("sandbox.exec")[-1][1]["env"], {"TOKEN": "secret"})
        self.assertNotIn("secret", json.dumps(self.created()))
        self.assertEqual([entry.id for entry in sdk.devbox.list()], [box.id])

    def test_invalid_resources_and_semantics_rejected_before_create(self):
        sdk = RunloopSDK(runtime=self.client)
        for params in ({"launch_parameters": {"custom_cpu_cores": 0.5}},
                       {"launch_parameters": {"architecture": "arm64"}},
                       {"launch_parameters": {"network_policy_id": "vendor-id"}},
                       {"entrypoint": "echo hi"}):
            with self.assertRaises(CompatibilityError):
                sdk.devbox.create(**params)
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_create_failure_cleans_up(self):
        self.world.exec = lambda *args: Result(exit_code=1, stderr="broken")
        sdk = RunloopSDK(runtime=self.client)
        with self.assertRaises(CompatibilityError):
            sdk.devbox.create(launch_parameters={"launch_commands": ["false"]})
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)

    def test_nonzero_exit_is_result(self):
        box = RunloopSDK(runtime=self.client).devbox.create()
        self.world.exec = lambda *args: Result(exit_code=7, stdout="one\ntwo\n", stderr="bad")
        result = box.cmd.exec("exit 7")
        self.assertTrue(result.failed)
        self.assertEqual(result.exit_code, 7)
        self.assertEqual(result.stdout(1), "two")
        self.assertEqual(result.stderr(), "bad")

    def test_context_manager_stops_on_exception(self):
        sdk = RunloopSDK(runtime=self.client)
        with self.assertRaisesRegex(ValueError, "broken"):
            with sdk.devbox.create():
                raise ValueError("broken")
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)

    def test_async_workflow(self):
        async def run():
            sdk = AsyncRunloopSDK(runtime=self.world.async_client())
            async with await sdk.devbox.create(environment_variables={"A": "b"}) as box:
                await box.file.write(file_path="/workspace/a", contents="héllo")
                self.assertEqual(await box.file.read(file_path="/workspace/a"), "héllo")
                result = await box.cmd.exec("echo hello")
                self.assertTrue(result.success)
                await result.stdout()
        asyncio.run(run())


class PrimeTests(Base):
    def request(self, **kwargs):
        return CreateSandboxRequest(name="test", docker_image="python:3.12-slim", **kwargs)

    def test_create_uses_exact_image_and_env_survives_reconnect(self):
        sdk = SandboxClient(self.client)
        box = sdk.create(self.request(environment_vars={"KEY": "sensitive"}, labels=["test"]))
        self.assertEqual(self.world.called("images.build")[0][0]["dockerfile"], "FROM python:3.12-slim\n")
        SandboxClient(self.client).execute_command(box.id, "echo hi", env={"B": "c"})
        self.assertEqual(self.world.called("sandbox.exec")[-1][1]["env"], {"KEY": "sensitive", "B": "c"})
        self.assertNotIn("sensitive", json.dumps(self.created()))
        self.assertEqual(sdk.list(labels=["test"]).total, 1)
        self.assertEqual(sdk.list(labels=["missing"]).total, 0)

    def test_invalid_request_rejected_before_build(self):
        sdk = SandboxClient(self.client)
        for request in (self.request(gpu_count=1, gpu_type="H100"), self.request(cpu_cores=0.5),
                        self.request(start_command={"executable": "python", "unknown": True}),
                        self.request(start_command={"executable": "bad\x00"})):
            with self.assertRaises((CompatibilityError, ValueError)):
                sdk.create(request)
        self.assertEqual(self.world.called("images.build"), [])
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_binary_file_round_trip_and_window(self):
        sdk = SandboxClient(self.client)
        box = sdk.create(self.request())
        result = sdk.upload_bytes(box.id, "/workspace/a", b"0123456789", "a")
        self.assertEqual(result.size, 10)
        read = sdk.read_file(box.id, "/workspace/a", offset=3, length=4)
        self.assertEqual((read.content, read.size, read.total_size, read.truncated), ("3456", 4, 10, True))

    def test_async_workflow(self):
        async def run():
            sdk = AsyncSandboxClient(runtime=self.world.async_client())
            box = await sdk.create(self.request())
            self.assertEqual((await sdk.get(box.id)).status, "RUNNING")
            await sdk.upload_bytes(box.id, "/workspace/u", "é".encode(), "u")
            self.assertEqual((await sdk.read_file(box.id, "/workspace/u")).content, "é")
            self.assertEqual((await sdk.execute_command(box.id, "true")).exit_code, 0)
            await sdk.delete(box.id)
        asyncio.run(run())


class SpritesTests(Base):
    def test_persistence_binary_files_and_argv(self):
        client = SpritesClient(runtime=self.client)
        sprite = client.create_sprite("agent")
        self.assertTrue(self.created()["persistent"])
        path = sprite.filesystem("/workspace").path("binary")
        data = bytes(range(256)) * 4097
        path.write_bytes(data)
        self.assertEqual(path.read_bytes(), data)
        sprite.run("echo", "literal; no shell", capture_output=True)
        self.assertEqual(self.world.called("sandbox.exec")[-1][0], ["echo", "literal; no shell"])
        self.assertEqual(client.list_sprites(ListOptions(prefix="ag")).sprites[0].name, "agent")
        self.assertEqual(client.get_sprite("agent").id, sprite.id)

    def test_nonzero_exit_and_timeout(self):
        sprite = SpritesClient(runtime=self.client).create_sprite("agent")
        self.world.exec = lambda *args: Result(exit_code=4, stderr="bad")
        with self.assertRaises(ExitError) as error:
            sprite.run("false", check=True, capture_output=True)
        self.assertEqual(error.exception.exit_code(), 4)
        self.world.exec = lambda *args: Result(exit_code=None, timed_out=True)
        with self.assertRaises(SpriteTimeoutError):
            sprite.run("sleep", "10", timeout=1, capture_output=True)


class ModalTests(Base):
    def test_image_recipe_and_secret_isolation(self):
        image = Image.debian_slim("3.12").pip_install("numpy").apt_install("git").env({"LANG": "C.UTF-8"})
        box = Sandbox.create(app=App.lookup("test", create_if_missing=True), image=image,
                             secrets=[Secret.from_dict({"TOKEN": "secret"})], client=self.client)
        recipe = self.world.called("images.build")[0][0]["dockerfile"]
        self.assertIn("FROM python:3.12-slim-bookworm", recipe)
        self.assertIn("pip install -- numpy", recipe)
        self.assertNotIn("secret", recipe)
        self.assertNotIn("secret", json.dumps(self.created()))
        self.assertEqual(self.world.sandboxes[box.object_id].files.read(ENV_PATH), b'{"TOKEN": "secret"}')

    def test_rejects_gpu_and_security_options_before_effects(self):
        for options in ({"gpu": "H100"}, {"outbound_cidr_allowlist": ["10.0.0.0/8"]}, {"cpu": .5}):
            with self.assertRaises(CompatibilityError):
                Sandbox.create(client=self.client, **options)
        self.assertEqual(self.world.called("images.build"), [])

    def test_image_env_cannot_inject_instructions(self):
        for env in ({"BAD\nRUN echo x": "a"}, {"GOOD": "bad\nRUN echo x"}):
            with self.assertRaises(ValueError):
                Image.debian_slim().env(env)

    def test_filesystem_snapshot_refuses_memory_snapshot_substitution(self):
        box = Sandbox.create(client=self.client)
        with patch.object(box._sandbox, "snapshot", return_value={"id": "memory", "mode": "memory"}) as capture:
            with self.assertRaisesRegex(CompatibilityError, "filesystem-only"):
                box.snapshot_filesystem()
        self.assertEqual(capture.call_args.kwargs, {"mode": "disk", "retention_days": 30})


class StreamAndFailureTests(Base):
    def test_all_foreground_adapters_preserve_large_stdout(self):
        text = "é" * 100_000
        self.world.exec = lambda *args: Result(0, stdout=text)
        runloop = RunloopSDK(runtime=self.client).devbox.create()
        self.assertEqual(runloop.cmd.exec("large").stdout(), text)
        prime = SandboxClient(self.client)
        sb = prime.create(CreateSandboxRequest(name="p", docker_image="python:3.12"))
        self.assertEqual(prime.execute_command(sb.id, "large").stdout, text)
        sprite = SpritesClient(runtime=self.client).create_sprite("s")
        self.assertEqual(sprite.run("large", capture_output=True).stdout, text.encode())

    def test_modal_drains_stderr_while_reading_stdout(self):
        self.world.output = lambda _: [
            {"type": "stderr", "data": "e" * 100_000},
            {"type": "stdout", "data": "line one\n"},
            {"type": "stdout", "data": "line two"},
            {"type": "exit", "exitCode": 7}]
        box = Sandbox.create(client=self.client)
        process = box.exec("program", bufsize=1)
        self.assertEqual(list(process.stdout), ["line one\n", "line two"])
        self.assertEqual(process.stderr.read(), "e" * 100_000)
        self.assertEqual(process.wait(), 7)
        self.assertEqual(process.stdout.read(), "")

    def test_modal_truncation_is_error_not_partial_success(self):
        self.world.output = lambda _: [{"type": "stdout", "data": "partial"}, {"type": "truncated"}]
        box = Sandbox.create(client=self.client)
        process = box.exec("program")
        with self.assertRaisesRegex(IOError, "truncated"):
            process.stdout.read()

    def test_modal_dropped_output_does_not_stop_running_entrypoint(self):
        self.world.output = lambda _: [{"type": "stdout", "data": "partial"}]
        box = Sandbox.create("long-running", client=self.client)
        with self.assertRaisesRegex(IOError, "exit status"):
            box._entrypoint.wait()
        self.assertEqual(self.world.called("sandbox.stop"), [])

    def test_modal_entrypoint_completion_stops_sandbox(self):
        box = Sandbox.create("true", client=self.client)
        box._entrypoint.wait()
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)

    def test_modal_stdin_retry_keeps_only_unacknowledged_chunks(self):
        from withruntime.modal import _Writer
        class Process:
            calls = []
            failed = False
            def write(self, data, eof=False):
                if len(self.calls) == 1 and not self.failed:
                    self.failed = True
                    raise IOError("cut")
                self.calls.append((data, eof))
        process = Process()
        writer = _Writer(process)
        data = b"a" * (2 * 1048576 + 3)
        writer.write(data)
        with self.assertRaisesRegex(IOError, "cut"):
            writer.drain()
        writer.drain()
        writer.write_eof()
        self.assertEqual(b"".join(part for part, eof in process.calls), data)
        self.assertTrue(process.calls[-1][1])
        self.assertTrue(all(len(part) <= 1048576 for part, eof in process.calls))

    def test_setup_write_failure_stops_new_sandbox(self):
        original = FakeFiles.write
        def broken(files, path, data, **options):
            if path == ENV_PATH:
                raise IOError("write refused")
            return original(files, path, data, **options)
        with patch.object(FakeFiles, "write", broken):
            with self.assertRaisesRegex(IOError, "write refused"):
                SandboxClient(self.client).create(CreateSandboxRequest(name="p", docker_image="python:3.12"))
            with self.assertRaisesRegex(IOError, "write refused"):
                Sandbox.create(client=self.client)
        self.assertEqual(len(self.world.called("sandbox.stop")), 2)

    def test_prime_sync_source_is_generated(self):
        # Runloop is checked by its dedicated generator contract.
        check = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "scripts" / "generate_prime_sync.py"), "--check"])
        self.assertEqual(check.returncode, 0, "run python3 sdks/python/scripts/generate_prime_sync.py")


class ContractImports(unittest.TestCase):
    def test_common_nested_imports(self):
        from withruntime.runloop.sdk import RunloopSDK as NestedRunloop
        from withruntime.prime.sandbox import SandboxClient as NestedPrime
        from withruntime.sprites.client import SpritesClient as NestedSprites
        from withruntime.sprites.filesystem import SpriteFilesystem
        self.assertIs(NestedRunloop, RunloopSDK)
        self.assertIs(NestedPrime, SandboxClient)
        self.assertIs(NestedSprites, SpritesClient)
        self.assertTrue(SpriteFilesystem)

    def test_async_and_sync_timeout_use_same_exported_exception(self):
        from withruntime.prime import CommandTimeoutError
        from withruntime.prime._async import CommandTimeoutError as AsyncError
        self.assertIs(CommandTimeoutError, AsyncError)


class ExpandedConsumerTests(Base):
    def test_runloop_official_rest_snippet(self):
        from withruntime.runloop import Runloop
        client = Runloop(runtime=self.client)
        devbox = client.devboxes.create(name="rest", environment_variables={"A": "b"})
        result = client.devboxes.execute_sync(devbox.id, command="echo hi")
        self.assertEqual((result.devbox_id, result.exit_status), (devbox.id, 0))
        client.devboxes.write_file_contents(devbox.id, file_path="/workspace/hello", contents="hello")
        self.assertEqual(client.devboxes.read_file_contents(devbox.id, file_path="/workspace/hello"), "hello")
        response = client.devboxes.download_file(devbox.id, path="/workspace/hello")
        self.assertEqual(response.read(), b"hello")
        self.assertEqual([item.id for item in client.devboxes.list()], [devbox.id])
        client.devboxes.shutdown(devbox.id)

    def test_runloop_official_async_rest_snippet(self):
        from withruntime.runloop import AsyncRunloop
        async def run():
            client = AsyncRunloop(runtime=self.world.async_client())
            devbox = await client.devboxes.create(name="async-rest")
            result = await client.devboxes.execute_sync(devbox.id, command="true")
            self.assertEqual(result.exit_status, 0)
            self.assertEqual([item.id async for item in await client.devboxes.list()], [devbox.id])
            await client.devboxes.shutdown(devbox.id)
        asyncio.run(run())

    def test_sprites_official_command_handle_snippet(self):
        import io
        from withruntime.sprites import SpriteConfig
        client = SpritesClient(runtime=self.client)
        sprite = client.create_sprite("cmd", SpriteConfig(cpus=2, ram_mb=2048, storage_gb=8))
        self.assertEqual((self.created()["vcpu"], self.created()["memory_mib"], self.created()["disk_mib"]), (2, 2048, 8192))
        self.world.exec = lambda command, options: Result(0, "hello\n", "error\n")
        command = sprite.command("echo", "hello")
        self.assertEqual(command.output(), b"hello\n")
        self.assertEqual(command.exit_code, 0)
        with self.assertRaisesRegex(RuntimeError, "already started"):
            command.run()
        self.assertEqual(sprite.command("test").combined_output(), b"hello\nerror\n")
        sink = io.BytesIO()
        sprite.command("test", stdout=sink).run()
        self.assertIn(b"test", sink.getvalue())
        self.assertIsNone(sprite.run("true").stdout)

    def test_sprites_async_snippet_and_filesystem(self):
        from withruntime.sprites import AsyncSpritesClient, SpriteConfig
        async def run():
            client = AsyncSpritesClient(runtime=self.world.async_client())
            sprite = await client.create_sprite("async", SpriteConfig(cpus=2))
            path = sprite.filesystem("/workspace") / "hello"
            await path.write_text("こんにちは")
            self.assertEqual(await path.read_text(), "こんにちは")
            self.assertTrue(await path.is_file())
            self.assertIn("hello", await sprite.filesystem("/workspace").cwd.listdir())
            command = sprite.command("echo", "hello")
            self.assertIn(b"echo", await command.output())
            with self.assertRaisesRegex(RuntimeError, "already started"):
                await command.run()
            self.assertEqual((await client.get_sprite("async")).id, sprite.id)
            self.assertEqual((await client.list_sprites()).sprites[0].name, "async")
            await sprite.destroy()
        asyncio.run(run())
        self.assertEqual(self.world.called("sandbox.update")[-1][0], {"persistent": False})

    def test_modal_official_aio_snippet(self):
        async def run():
            app = await App.lookup.aio("test", create_if_missing=True)
            box = await Sandbox.create.aio(app=app, image=Image.debian_slim(), client=self.world.async_client())
            async with box:
                process = await box.exec.aio("echo", "hello")
                self.assertEqual(await process.wait.aio(), 0)
                self.assertIn("echo", await process.stdout.read.aio())
                self.assertEqual(await process.stderr.read.aio(), "")
                self.assertEqual(await process.poll.aio(), 0)
            reconnected = await Sandbox.from_id.aio(box.object_id, client=self.world.async_client())
            self.assertEqual(reconnected.object_id, box.object_id)
        asyncio.run(run())

    def test_modal_async_streams_and_stdin(self):
        self.world.output = lambda command: [{"type": "stdout", "data": "one\n"},
            {"type": "stderr", "data": "bad\n"}, {"type": "stdout", "data": "two"}, {"type": "exit", "exitCode": 0}]
        async def run():
            box = await Sandbox.create.aio(client=self.world.async_client())
            process = await box.exec.aio("cat", bufsize=1)
            process.stdin.write(b"hello\n")
            process.stdin.write_eof()
            await process.stdin.drain.aio()
            self.assertEqual([part async for part in process.stdout], ["one\n", "two"])
            self.assertEqual(await process.stderr.read.aio(), "bad\n")
            await box.terminate.aio()
        asyncio.run(run())
        self.assertEqual(self.world.called("process.write")[-1][1:], (b"hello\n", True))

    def test_modal_async_entrypoint_auto_stops(self):
        async def run():
            box = await Sandbox.create.aio("true", client=self.world.async_client())
            await box.wait.aio()
            self.assertEqual(box.returncode, 0)
            self.assertEqual(len(self.world.called("sandbox.stop")), 1)
        asyncio.run(run())

    def test_modal_async_invalid_options_have_no_effect(self):
        async def run():
            with self.assertRaises(CompatibilityError):
                await Sandbox.create.aio(gpu="H100", client=self.world.async_client())
        asyncio.run(run())
        self.assertEqual(self.world.called("images.build"), [])


class NamedShellContract(unittest.TestCase):
    def test_exported_environment_and_cwd_survive_failure_and_reconnect(self):
        import tempfile
        from withruntime._compat import named_shell
        with tempfile.TemporaryDirectory() as folder:
            def run(command):
                root, argv = named_shell(command, "session")
                # macOS has no flock. This executes the exact state protocol;
                # Linux live acceptance covers the lock and native guest.
                argv = argv[2:]
                argv = [value.replace(root, folder) for value in argv]
                return subprocess.run(argv, capture_output=True, text=True, cwd=folder,
                                      env={"PATH": os.environ["PATH"], "HOME": folder})
            first = run("mkdir child; cd child; export STATE='hello world'; false")
            self.assertEqual(first.returncode, 1)
            self.assertEqual(run('printf "%s:%s" "$PWD" "$STATE"').stdout, os.path.realpath(folder) + "/child:hello world")
            self.assertEqual(os.stat(Path(folder, "state")).st_mode & 0o777, 0o600)

    def test_shell_names_are_not_interpreted_as_commands(self):
        from withruntime._compat import named_shell
        root, argv = named_shell("true", "../../$(touch /tmp/forbidden);shell")
        self.assertRegex(root, r"^/workspace/\.runtime-compat/shells/[a-f0-9]{64}$")
        self.assertNotIn("touch /tmp/forbidden", " ".join(argv))


class ReviewedContracts(Base):
    def test_runloop_result_property(self):
        from withruntime.runloop import ExecutionResult
        value = ExecutionResult("box", Result(stdout="hello", exit_code=7))
        self.assertEqual(value.result.exit_status, 7)
        self.assertEqual(value.result.stdout, "hello")

    def test_prime_wait_options_are_not_silently_dropped(self):
        sdk = SandboxClient(self.client)
        for params in ({"image_build_timeout_seconds": 20}, {"stability_checks": 2}):
            with self.assertRaises(CompatibilityError):
                sdk.wait_for_creation("not-looked-up", **params)
        with self.assertRaises(ValueError):
            sdk.wait_for_creation("not-looked-up", max_attempts=0)

    def test_modal_image_list_arguments_and_empty_noop(self):
        image = Image.debian_slim()
        self.assertIs(image.pip_install([]), image)
        self.assertIs(image.apt_install(), image)
        self.assertIn("numpy pandas scipy", image.pip_install(["numpy", "pandas"], "scipy")._dockerfile)
        self.assertIn("git curl", image.apt_install(["git", "curl"])._dockerfile)

    def test_modal_async_stdin_payload_and_eof_are_atomic(self):
        from withruntime.modal._async import _AsyncWriter
        class ExitsAfterLine:
            closed = False
            calls = []
            async def write(self, data, eof=False):
                if self.closed:
                    raise AssertionError("request raced process exit")
                self.calls.append((data, eof))
                self.closed = b"\n" in data
        async def run():
            process = ExitsAfterLine()
            writer = _AsyncWriter(process)
            writer.write("hello\n")
            writer.write_eof()
            await writer.drain.aio()
            await writer.drain.aio()
            self.assertEqual(process.calls, [(b"hello\n", True)])
        asyncio.run(run())

    def test_modal_async_stdin_preserves_writes_during_drain(self):
        from withruntime.modal._async import _AsyncWriter
        async def run():
            entered, resume = asyncio.Event(), asyncio.Event()
            calls = []
            class SlowProcess:
                async def write(self, data, eof=False):
                    calls.append((data, eof))
                    if len(calls) == 1:
                        entered.set()
                        await resume.wait()
            writer = _AsyncWriter(SlowProcess())
            writer.write(b"A")
            task = asyncio.create_task(writer.drain.aio())
            await entered.wait()
            writer.write(b"B")
            writer.write_eof()
            resume.set()
            await task
            await writer.drain.aio()
            self.assertEqual(calls, [(b"A", False), (b"B", True)])
        asyncio.run(run())

    def test_sprites_destroy_stops_before_disabling_persistence(self):
        sprite = SpritesClient(runtime=self.client).create_sprite("cold")
        sb = sprite._sandbox()
        sb.info["state"] = "paused"
        def update(**settings):
            self.assertEqual(sb.state, "stopped")
            sb.info.update(settings)
        with patch.object(sb, "update", update):
            sprite.destroy()
        self.assertFalse(sb.info["persistent"])

    def test_modal_binary_output_preserves_bytes(self):
        self.world.output = lambda _: [{"type": "stdout", "data": b"\x00\x80\xff"}, {"type": "exit", "exitCode": 0}]
        box = Sandbox.create(client=self.client)
        process = box.exec("binary", text=False)
        self.assertEqual(process.stdout.read(), b"\x00\x80\xff")
        self.assertEqual(process.wait(), 0)
        self.assertEqual(self.world.called("sandbox.spawn")[-1][1]["output_encoding"], "base64")


class BinaryCaptureContract(unittest.TestCase):
    def test_real_wrapper_preserves_binary_argv_stdin_and_exit(self):
        import tempfile
        import shutil
        from types import SimpleNamespace
        from withruntime.sprites._capture import capture
        from withruntime.sprites._capture_async import capture as async_capture
        class Files:
            def mkdir(self, path):
                Path(path).mkdir()
            def write(self, path, data, mode=None):
                Path(path).write_bytes(data)
                if mode is not None:
                    os.chmod(path, mode)
            def read(self, path):
                return Path(path).read_bytes()
            def remove(self, path, recursive=False):
                shutil.rmtree(path)
        class Local:
            files = Files()
            def exec(self, command, **options):
                result = subprocess.run(command, capture_output=True, cwd=options.get("cwd"),
                                        env=options.get("env"), timeout=10)
                return SimpleNamespace(stdout=result.stdout.decode(), stderr=result.stderr.decode(),
                                       exit_code=result.returncode, timed_out=False)
        payload = bytes(range(256)) * 5000
        code = 'import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.buffer.write(bytes([255,128,0])); sys.exit(7)'
        result = capture(Local(), [sys.executable, "-c", code], stdin=payload)
        self.assertEqual((result.stdout, result.stderr, result.exit_code), (payload, b"\xff\x80\x00", 7))
        class AsyncFiles:
            async def mkdir(self, *args, **kwargs): return Files().mkdir(*args, **kwargs)
            async def write(self, *args, **kwargs): return Files().write(*args, **kwargs)
            async def read(self, *args, **kwargs): return Files().read(*args, **kwargs)
            async def remove(self, *args, **kwargs): return Files().remove(*args, **kwargs)
        class AsyncLocal:
            files = AsyncFiles()
            async def exec(self, *args, **kwargs): return Local().exec(*args, **kwargs)
        result = asyncio.run(async_capture(AsyncLocal(), [sys.executable, "-c", code], stdin=payload))
        self.assertEqual((result.stdout, result.stderr, result.exit_code), (payload, b"\xff\x80\x00", 7))
        result = capture(Local(), [sys.executable, "-c", "import os; print(os.environ['output'], os.environ['has_input'])"],
                         env={**os.environ, "output": "wanted", "has_input": "original"})
        self.assertEqual(result.stdout, b"wanted original\n")
        with self.assertRaises(CompatibilityError):
            capture(Local(), ["true"], tty=True)
