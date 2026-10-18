"""What prime-sandboxes 0.4.6 changed in the calls withruntime.prime
implements, read from its published wheel and sdist on 18 October 2026,
nothing installed or run (compatibility-lock.json): CreateSandboxRequest takes
lan_network_id and lan_tags, and create then joins the sandbox to that LAN
network once it runs. LAN networks are refused with Runtime's private network
as the way, so create refuses them before any sandbox is made, rather than
making one and failing at the join (or dropping it). lan_tags without
lan_network_id is upstream's ValueError. The rest of the release is an HTTP/2
pool for upstream's own command transport. Sync and async."""
import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_prime_0_4_5 import Async, Runtime  # noqa: E402
from withruntime._compat import CompatibilityError  # noqa: E402
from withruntime.prime import AsyncSandboxClient, CreateSandboxRequest, SandboxClient  # noqa: E402


class CreateJoinsLan(unittest.TestCase):
    def test_lan_tags_need_a_network(self):
        with self.assertRaisesRegex(ValueError, "lan_tags requires lan_network_id"):
            CreateSandboxRequest(name="box", docker_image="python:3.12-slim", lan_tags=["web"])

    def test_create_with_a_lan_refuses_before_anything_is_made(self):
        runtime = Runtime()
        request = CreateSandboxRequest(name="box", docker_image="python:3.12-slim", lan_network_id="net",
                                       lan_tags=["web"])
        with self.assertRaisesRegex(CompatibilityError, "networks.private"):
            SandboxClient(runtime).create(request)

        async def run():
            with self.assertRaisesRegex(CompatibilityError, "networks.private"):
                await AsyncSandboxClient(runtime=Async(runtime)).create(request)
        asyncio.run(run())
        self.assertEqual(runtime.calls, [])

    def test_the_lan_fields_dump_like_upstreams(self):
        request = CreateSandboxRequest(name="box", docker_image="python:3.12-slim")
        self.assertIsNone(request.lan_network_id)
        self.assertNotIn("lan_network_id", request.model_dump(exclude_none=True))


if __name__ == "__main__":
    unittest.main()
