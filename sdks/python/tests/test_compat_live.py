"""Opt-in trial-only Python adapter acceptance, never part of routine CI.

RUNTIME_COMPAT_LIVE=1 PYTHONPATH=sdks/python python3 -m unittest discover \
    -s sdks/python/tests -p test_compat_live.py

Creates exactly one explicitly trial-funded native sandbox for at most 120 seconds.
No image builds, persistent sandboxes, paid fallback, competitor calls, or existing
customer resources. This proves commands/files/streams/reconnection, not each
provider's create policy or image equivalence. Always stops the owned sandbox.
"""
import asyncio
import hashlib
import json
import os
import unittest
import uuid
from withruntime import Runtime, AsyncRuntime
from withruntime._compat import ENV_PATH
from withruntime.runloop import RunloopSDK, Runloop, AsyncRunloop
from withruntime.prime import SandboxClient, AsyncSandboxClient
from withruntime.sprites import SpritesClient, AsyncSpritesClient
from withruntime.modal import Sandbox


@unittest.skipUnless(os.environ.get("RUNTIME_COMPAT_LIVE") == "1", "Opt-in live trial acceptance only")
class LiveTrial(unittest.TestCase):
    def test_existing_sandbox_consumers(self):
        api_key = os.environ.get("RUNTIME_API_KEY", "")
        if not api_key.startswith("rtcloud_"):
            raise ValueError("An explicit Runtime test API key is required; login fallback is disabled")
        runtime = Runtime(api_key=api_key, wait_for_capacity=0)
        usage = runtime.usage()
        if (usage.get("trial") or {}).get("availableMs", 0) < 3_600_000:
            runtime.close()
            raise ValueError("At least one trial hour is required; no paid fallback")
        name = "compat-python-" + uuid.uuid4().hex[:12]
        sb = runtime.sandboxes.create(name=name, funding="trial", timeout_seconds=120,
            idle_pause_seconds=0, on_lease_end="stop", labels={"compat.provider": "sprites"})
        owned_id = sb.id
        try:
            self.assertEqual(sb.info.get("funding"), "trial", "Created sandbox must be trial-funded")
            sb.files.write(ENV_PATH, json.dumps({"COMPAT_ENV": "persisted"}), mode=0o600)
            runloop = RunloopSDK(runtime=runtime).devbox.from_id(sb.id)
            result = runloop.cmd.exec("printf '%s' \"$COMPAT_ENV\"")
            self.assertEqual((result.exit_code, result.stdout()), (0, "persisted"))
            shell = runloop.shell("live-session")
            shell.exec("mkdir -p /workspace/named && cd /workspace/named && export HELLO=world")
            self.assertEqual(shell.exec('printf "%s:%s" "$PWD" "$HELLO"').stdout(), "/workspace/named:world")
            reconnected = RunloopSDK(runtime=runtime).devbox.from_id(sb.id).shell("live-session")
            self.assertEqual(reconnected.exec('printf "%s" "$HELLO"').stdout(), "world")
            low = Runloop(runtime=runtime)
            self.assertEqual(low.devboxes.execute_sync(sb.id, command="exit 7").exit_status, 7)
            data = bytes(range(256)) * 4097
            runloop.file.upload(path="/workspace/roundtrip", file=data)
            self.assertEqual(hashlib.sha256(runloop.file.download(path="/workspace/roundtrip")).digest(), hashlib.sha256(data).digest())
            prime = SandboxClient(runtime)
            self.assertEqual(prime.execute_command(sb.id, 'printf "%s" "$COMPAT_ENV"').stdout, "persisted")
            self.assertEqual(prime.execute_command(sb.id, "python3 -c 'print(\"x\"*100000,end=\"\")'").stdout, "x" * 100000)
            prime.upload_bytes(sb.id, "/workspace/prime-text", "こんにちは".encode(), "prime-text")
            self.assertEqual(prime.read_file(sb.id, "/workspace/prime-text").content, "こんにちは")
            sprite = SpritesClient(runtime=runtime).get_sprite(name)
            self.assertEqual(sprite.id, owned_id, "Only the sandbox created by this test may be used")
            self.assertEqual(sprite.run("printf", "%s", "literal; data", capture_output=True).stdout, b"literal; data")
            self.assertEqual(sprite.command("printf", "hello").output(), b"hello")
            binary = sprite.command("python3", "-c", "import sys; sys.stdout.buffer.write(bytes(range(256)))").output()
            self.assertEqual(binary, bytes(range(256)))
            path = sprite.filesystem("/workspace") / "sprites-binary"
            path.write_bytes(data)
            self.assertEqual(path.read_bytes(), data)
            modal = Sandbox.from_id(sb.id, client=runtime)
            process = modal.exec("bash", "-c", "printf 'out'; printf 'err' >&2; exit 3")
            self.assertEqual((process.stdout.read(), process.stderr.read(), process.wait()), ("out", "err", 3))
            self._async_consumers(sb.id, name)
        finally:
            self.assertEqual(sb.id, owned_id)
            sb.stop()
            runtime.close()

    def _async_consumers(self, sandbox_id, name):
        async def run():
            runtime = AsyncRuntime(api_key=os.environ["RUNTIME_API_KEY"], wait_for_capacity=0)
            try:
                low = AsyncRunloop(runtime=runtime)
                self.assertEqual((await low.devboxes.execute_sync(sandbox_id, command="printf async")).stdout, "async")
                prime = AsyncSandboxClient(runtime=runtime)
                self.assertEqual((await prime.execute_command(sandbox_id, "printf prime")).stdout, "prime")
                sprite = await AsyncSpritesClient(runtime=runtime).get_sprite(name)
                self.assertEqual(sprite.id, sandbox_id)
                self.assertEqual(await sprite.command("printf", "sprite").output(), b"sprite")
                binary = await sprite.command("python3", "-c", "import sys; sys.stdout.buffer.write(bytes(range(256)))").output()
                self.assertEqual(binary, bytes(range(256)))
                modal = await Sandbox.from_id.aio(sandbox_id, client=runtime)
                process = await modal.exec.aio("bash", "-c", "read line; printf '%s' \"$line\"")
                process.stdin.write(b"input\n")
                process.stdin.write_eof()
                await process.stdin.drain.aio()
                self.assertEqual(await process.stdout.read.aio(), "input")
                self.assertEqual(await process.wait.aio(), 0)
            finally:
                await runtime.close()
        asyncio.run(run())
