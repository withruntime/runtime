"""prime-sandboxes 0.4.1's network rules, bulk waits, logs, SSH and the
surfaces this adapter refuses, against the native SDK fake."""
import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
from dropin_fake import DropInWorld
from e2b_fake import FakeFiles
from withruntime._compat import CompatibilityError
from withruntime._request_scope import current
from withruntime.prime import (APIClient, AsyncAPIClient, AsyncSandboxClient, CreateSandboxRequest, ImageClient,
                               DownloadTimeoutError, SandboxClient, StartCommand, UploadTimeoutError)
from withruntime.prime._async import START_LOG
import withruntime.prime as prime


class Network:
    """A sandbox's network rules as Runtime keeps them."""

    def __init__(self, **policy):
        self.policy = {"internet": True, "allow": [], "deny": [], "connect": [], "updatedAt": None, **policy}
        self.sets = []

    def get(self):
        return dict(self.policy)

    def set(self, **rules):
        self.sets.append(rules)
        self.policy = {"internet": rules["internet"], "allow": rules.get("allow", []), "deny": rules.get("deny", []),
                       "connect": [], "updatedAt": "2026-10-10T20:00:00Z"}
        return dict(self.policy)


class PrimeContract(unittest.TestCase):
    def setUp(self):
        # Runtime's files.write takes a mode; the shared fake predates it.
        original = FakeFiles.write
        def write(files, path, data, mode=None):
            return original(files, path, data)
        FakeFiles.write = write
        self.addCleanup(setattr, FakeFiles, "write", original)
        self.world = DropInWorld()
        self.sdk = SandboxClient(self.world.client())
        self.box = self.sdk.create(CreateSandboxRequest(name="p", docker_image="python:3.12-slim"))
        self.network = Network()
        self.world.sandboxes[self.box.id].network = self.network

    def test_set_network_replaces_the_rules_with_one_list(self):
        status = self.sdk.set_network(self.box.id, allow=["pypi.org", "10.0.0.0/8"])
        self.assertEqual(self.network.sets[-1], {"internet": True, "allow": ["pypi.org", "10.0.0.0/8"]})
        self.assertEqual(status.policy.allowlist, ["pypi.org", "10.0.0.0/8"])
        self.assertIsNone(status.policy.denylist)
        self.assertTrue(status.applied)
        self.assertEqual(status.generation, status.applied_generation)
        self.assertGreater(status.generation, 0)
        self.sdk.set_network(self.box.id, deny=["example.com"])
        self.assertEqual(self.network.sets[-1], {"internet": True, "deny": ["example.com"]})
        # "*" alone: every destination allowed, or none.
        self.assertEqual(self.sdk.set_network(self.box.id, allow=["*"]).policy.denylist, [])
        self.assertEqual(self.network.sets[-1], {"internet": True})
        self.assertEqual(self.sdk.set_network(self.box.id, deny=["*"]).policy.allowlist, [])
        self.assertEqual(self.network.sets[-1], {"internet": False})

    def test_set_network_refuses_malformed_rules_before_any_change(self):
        for kwargs in ({}, {"allow": ["a.com"], "deny": ["b.com"]}, {"allow": []}, {"allow": ["*", "a.com"]},
                       {"deny": ["::1"]}, {"allow": [" "]}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.sdk.set_network(self.box.id, **kwargs)
        self.assertEqual(self.network.sets, [])

    def test_get_network_reads_the_rules_back(self):
        self.assertEqual(self.sdk.get_network(self.box.id).policy, {"allowlist": None, "denylist": []})
        self.network.policy.update(internet=False)
        self.assertEqual(self.sdk.get_network(self.box.id).policy, {"allowlist": [], "denylist": None})
        self.network.policy.update(internet=True, deny=["example.com"])
        self.assertEqual(self.sdk.get_network(self.box.id).policy, {"allowlist": None, "denylist": ["example.com"]})

    def test_get_network_refuses_rules_prime_cannot_express(self):
        # Reported as Prime's policy, open ports or a mixed list would read wider or narrower than they are.
        for policy in ({"connect": ["db.example.com:5432"]}, {"allow": ["a.com"], "deny": ["b.com"]}):
            self.network.policy.update(policy)
            with self.subTest(policy=policy), self.assertRaises(CompatibilityError):
                self.sdk.get_network(self.box.id)
            self.network.policy.update(connect=[], allow=[], deny=[])

    def test_bulk_wait_for_creation_waits_for_each(self):
        other = self.sdk.create(CreateSandboxRequest(name="q", docker_image="python:3.12-slim"))
        self.assertEqual(self.sdk.bulk_wait_for_creation([self.box.id, other.id], image_build_timeout_seconds=60),
                         {self.box.id: "RUNNING", other.id: "RUNNING"})
        for ids in ([], [self.box.id, self.box.id], [str(n) for n in range(101)]):
            with self.subTest(count=len(ids)), self.assertRaises(ValueError):
                self.sdk.bulk_wait_for_creation(ids)
        self.world.sandboxes[other.id].info["state"] = "stopped"
        with self.assertRaises(TimeoutError):
            self.sdk.bulk_wait_for_creation([self.box.id, other.id])

    def test_start_command_output_is_the_sandbox_log(self):
        self.assertEqual(self.sdk.get_logs(self.box.id), "")
        box = self.sdk.create(CreateSandboxRequest(name="s", docker_image="python:3.12-slim",
                                                   start_command=StartCommand(executable="server", args=["--port", "8"])))
        argv = self.world.called("sandbox.spawn")[-1][0]
        self.assertEqual(argv, ["bash", "-c", 'exec "$@" >> "$0" 2>&1', START_LOG, "server", "--port", "8"])
        self.world.sandboxes[box.id].file_map[START_LOG] = b"listening\n\xff"
        self.assertEqual(self.sdk.get_logs(box.id), "listening\n�")

    def test_transfer_timeouts_bound_the_request_and_raise_prime_errors(self):
        # A slow transfer: the fake waits, then asks the request scope, as the HTTP layer does.
        def slow(method):
            def call(files, *args, **kwargs):
                time.sleep(0.05)
                current().remaining()
                return method(files, *args, **kwargs)
            return call
        for name in ("write", "read"):
            original = getattr(FakeFiles, name)
            setattr(FakeFiles, name, slow(original))
            self.addCleanup(setattr, FakeFiles, name, original)
        self.assertTrue(self.sdk.upload_bytes(self.box.id, "/workspace/a", b"hi", "a", timeout=5).success)
        self.assertEqual(self.sdk.read_file(self.box.id, "/workspace/a", timeout=5).content, "hi")
        self.assertTrue(self.sdk.upload_bytes(self.box.id, "/workspace/b", b"hi", "b").success)
        with self.assertRaises(UploadTimeoutError):
            self.sdk.upload_bytes(self.box.id, "/workspace/c", b"hi", "c", timeout=0.01)
        with self.assertRaises(DownloadTimeoutError):
            self.sdk.read_file(self.box.id, "/workspace/a", timeout=0.01)
        for bad in (0, -1, float("inf"), True):
            with self.subTest(timeout=bad), self.assertRaises(ValueError):
                self.sdk.upload_bytes(self.box.id, "/workspace/d", b"hi", "d", timeout=bad)
        self.assertIsNone(current().deadline)

    def test_clear_auth_cache_has_nothing_to_clear(self):
        self.assertIsNone(self.sdk.clear_auth_cache())
        self.assertIsNone(asyncio.run(AsyncSandboxClient(runtime=self.world.async_client()).clear_auth_cache()))

    def test_ssh_sessions_refuse_with_the_alternative(self):
        for call in (lambda: self.sdk.create_ssh_session(self.box.id, "ssh-ed25519 AAAA"),
                     lambda: self.sdk.close_ssh_session(self.box.id, "session")):
            with self.assertRaisesRegex(CompatibilityError, "runtime sandboxes ssh"):
                call()


class RefusedSurfaces(unittest.TestCase):
    def test_image_clients_and_models_refuse_on_use(self):
        for name in ("ImageClient", "AsyncImageClient", "BuildImageRequest", "ImageVisibility", "ImageListItem"):
            export = getattr(prime, name)
            with self.subTest(name=name), self.assertRaisesRegex(CompatibilityError, "runtime.images"):
                export()
        with self.assertRaises(CompatibilityError):
            ImageClient.list
        with self.assertRaises(CompatibilityError):
            class Mine(ImageClient):
                pass

    def test_raw_api_calls_refuse_rather_than_reach_runtime_routes(self):
        client = APIClient.__new__(APIClient)
        for call in (lambda: client.request("GET", "/sandbox"), lambda: client.get("/sandbox"),
                     lambda: client.post("/sandbox", json={}), lambda: client.patch("/sandbox", json={}),
                     lambda: client.delete("/sandbox/x")):
            with self.assertRaises(CompatibilityError):
                call()
        async_client = AsyncAPIClient.__new__(AsyncAPIClient)
        with self.assertRaises(CompatibilityError):
            asyncio.run(async_client.get("/sandbox"))


if __name__ == "__main__":
    unittest.main()
