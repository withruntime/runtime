"""Compatibility smoke workflows against the real API router and a fake guest.

Run via packages/cloud-sdk/scripts/test-python.ts. No production calls or spend.
"""
import asyncio
import os
import unittest
from urllib.parse import urlparse
from withruntime import Runtime, AsyncRuntime, ServiceUnavailableError
from withruntime.runloop import RunloopSDK, AsyncRunloopSDK
from withruntime.prime import SandboxClient, CreateSandboxRequest
from withruntime.prime.exceptions import APIError as PrimeAPIError
from withruntime.sprites import SpritesClient
from withruntime.modal import Sandbox, Image

URL = os.environ.get("RUNTIME_FIXTURE_URL")


def runtime(async_mode=False):
    if not URL or urlparse(URL).hostname not in ("127.0.0.1", "localhost"):
        raise ValueError("A localhost RUNTIME_FIXTURE_URL is required; never fall back to production")
    return (AsyncRuntime if async_mode else Runtime)(api_key="rk_test", base_url=URL, max_retries=0)


@unittest.skipUnless(URL, "Run through the local Python API router fixture")
class Router(unittest.TestCase):
    def test_runloop(self):
        sdk = RunloopSDK(runtime=runtime())
        with sdk.devbox.create(name="runloop-python", environment_variables={"NAME": "hello"}) as box:
            box.file.upload(path="/workspace/compat-runloop.bin", file=bytes(range(256)) * 4100)
            self.assertEqual(len(box.file.download(path="/workspace/compat-runloop.bin")), 256 * 4100)
            result = box.cmd.exec("echo hello")
            self.assertEqual(result.exit_code, 0)
            self.assertEqual(result.stdout(), "hello\n")
        sdk.close()

    def test_runloop_async(self):
        async def run():
            sdk = AsyncRunloopSDK(runtime=runtime(True))
            async with await sdk.devbox.create(name="runloop-async") as box:
                await box.file.write(file_path="/workspace/compat-async", contents="こんにちは")
                self.assertEqual(await box.file.read(file_path="/workspace/compat-async"), "こんにちは")
                result = await box.cmd.exec("true")
                self.assertEqual(result.exit_code, 0)
            await sdk.close()
        asyncio.run(run())

    def test_prime(self):
        client = runtime()
        sdk = SandboxClient(client)
        # This fixture deliberately disables image builds. Verify refusal, then
        # exercise the supported commands/files on a native-created sandbox.
        with self.assertRaises(PrimeAPIError) as failure:
            sdk.create(CreateSandboxRequest(name="prime-python", docker_image="python:3.12-slim"))
        self.assertEqual(failure.exception.status, 503)
        self.assertIsInstance(failure.exception.__cause__, ServiceUnavailableError)
        box = client.sandboxes.create()
        try:
            sdk.upload_bytes(box.id, "/workspace/compat-prime", b"hello", "compat-prime")
            self.assertEqual(sdk.read_file(box.id, "/workspace/compat-prime").content, "hello")
            self.assertEqual(sdk.execute_command(box.id, "echo hello").stdout, "hello\n")
        finally:
            sdk.delete(box.id)
            client.close()

    def test_sprites(self):
        client = SpritesClient(runtime=runtime())
        sprite = client.create_sprite("sprites-python")
        try:
            sprite.filesystem("/workspace").path("compat-sprites").write_text("hello")
            self.assertEqual(sprite.filesystem("/workspace").path("compat-sprites").read_text(), "hello")
            # The fixture guest returns fixed text without executing bash.
            # This checks native staging/reading routes; local subprocess and
            # opt-in live acceptance prove the actual binary capture protocol.
            self.assertIsInstance(sprite.run("echo", "hello", capture_output=True).stdout, bytes)
        finally:
            # The fixture deliberately disables persistent-settings updates.
            with self.assertRaises(ServiceUnavailableError):
                sprite.destroy()
            sprite._sandbox().stop()
            client.close()

    def test_modal(self):
        client = runtime()
        with self.assertRaises(ServiceUnavailableError):
            Sandbox.create(image=Image.debian_slim("3.12"), client=client)
        native = client.sandboxes.create()
        from withruntime._compat import ENV_PATH
        native.files.write(ENV_PATH, "{}", mode=0o600)
        with Sandbox.from_id(native.id, client=client) as box:
            process = box.exec("echo", "hello")
            self.assertEqual(process.stdout.read(), "hello\n")
            self.assertEqual(process.wait(), 0)
        client.close()


@unittest.skipUnless(URL, "Run through the local Python API router fixture")
class AsyncRouter(unittest.TestCase):
    def test_rest_and_async_consumers(self):
        from withruntime.runloop import Runloop, AsyncRunloop
        from withruntime.sprites import AsyncSpritesClient, SpriteConfig
        client = runtime()
        low = Runloop(runtime=client)
        box = low.devboxes.create(name="runloop-rest")
        try:
            self.assertEqual(low.devboxes.execute_sync(box.id, command="echo hi").stdout, "hello\n")
        finally:
            low.devboxes.shutdown(box.id)
            client.close()
        async def run():
            client = runtime(True)
            low = AsyncRunloop(runtime=client)
            box = await low.devboxes.create(name="async-rest")
            try:
                self.assertEqual((await low.devboxes.execute_sync(box.id, command="echo hi")).stdout, "hello\n")
                sprite_client = AsyncSpritesClient(runtime=client)
                sprite = await sprite_client.create_sprite("async-sprites", SpriteConfig(cpus=2, ram_mb=2048))
                self.assertIsInstance(await sprite.command("echo", "hello").output(), bytes)
                path = sprite.filesystem("/workspace") / "compat-async-binary"
                await path.write_bytes(bytes(range(256)))
                self.assertEqual(await path.read_bytes(), bytes(range(256)))
                native = await client.sandboxes.get(box.id)
                from withruntime._compat import ENV_PATH
                await native.files.write(ENV_PATH, "{}", mode=0o600)
                modal = await Sandbox.from_id.aio(box.id, client=client)
                process = await modal.exec.aio("echo", "hello")
                self.assertEqual(await process.stdout.read.aio(), "hello\n")
                self.assertEqual(await process.wait.aio(), 0)
                await modal.terminate.aio()
            finally:
                await low.devboxes.shutdown(box.id)
                await client.close()
        asyncio.run(run())
