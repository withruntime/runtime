"""What prime-sandboxes 0.4.7 changed in the calls withruntime.prime
implements, read from its published wheel and sdist on 19 October 2026,
nothing installed or run (compatibility-lock.json): CreateSandboxRequest takes
arch, "amd64" or "arm64" (None is amd64; a checkpoint restore omits it), and
create_lan_network takes rules. Runtime runs amd64 only, so arm64 is refused
before any sandbox is made; amd64 creates as before. LAN networks stay refused
with Runtime's private network as the way, now with rules too, rather than a
TypeError. The rest is image builds for arm64 (Prime's image registry, refused
whole) and LAN join internals. Sync and async."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_prime_0_4_5 import Async, Runtime  # noqa: E402
from withruntime._compat import CompatibilityError  # noqa: E402
from withruntime.prime import APIError, AsyncSandboxClient, CreateSandboxRequest, SandboxClient  # noqa: E402


def both(test, request, error, pattern):
    runtime = Runtime()
    with test.assertRaisesRegex(error, pattern):
        SandboxClient(runtime).create(request)

    async def run():
        with test.assertRaisesRegex(error, pattern):
            await AsyncSandboxClient(runtime=Async(runtime)).create(request)
    asyncio.run(run())
    test.assertEqual(runtime.calls, [])


class Arch(unittest.TestCase):
    def test_arch_is_amd64_or_arm64(self):
        self.assertIsNone(CreateSandboxRequest(name="box", docker_image="python:3.12-slim").arch)
        with self.assertRaisesRegex(ValueError, "arch"):
            CreateSandboxRequest(name="box", docker_image="python:3.12-slim", arch="x86")

    def test_arm64_refuses_before_anything_is_made(self):
        both(self, CreateSandboxRequest(name="box", docker_image="python:3.12-slim", arch="arm64"),
             CompatibilityError, "amd64")

    def test_a_checkpoint_restore_omits_arch(self):
        both(self, CreateSandboxRequest(name="box", checkpoint_id="snap", arch="amd64"),
             APIError, "omit arch")

    def test_amd64_creates_as_without_it(self):
        runtime = Runtime()
        SandboxClient(runtime).create(CreateSandboxRequest(name="box", docker_image="python:3.12-slim", arch="amd64"))
        with_arch = runtime.calls
        runtime = Runtime()
        SandboxClient(runtime).create(CreateSandboxRequest(name="box", docker_image="python:3.12-slim"))
        self.assertEqual(with_arch, runtime.calls)


class LanRules(unittest.TestCase):
    def test_create_lan_network_with_rules_names_the_private_network(self):
        runtime = Runtime()
        with self.assertRaisesRegex(CompatibilityError, "networks.private"):
            SandboxClient(runtime).create_lan_network("net", rules=[])

        async def run():
            with self.assertRaisesRegex(CompatibilityError, "networks.private"):
                await AsyncSandboxClient(runtime=Async(runtime)).create_lan_network("net", None, [])
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
