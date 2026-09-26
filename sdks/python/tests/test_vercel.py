"""The Vercel Sandbox adapter against a fake of the withruntime SDK
(tests/dropin_fake.py): the mappings and the refusals, sync and async."""
import asyncio
import io
import os
import subprocess
import sys
import unittest
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dropin_fake import DropInWorld  # noqa: E402
from e2b_fake import Result  # noqa: E402

import withruntime  # noqa: E402
from withruntime.vercel import sandbox as async_sandbox  # noqa: E402
from withruntime.vercel.api import session  # noqa: E402
from withruntime.vercel.sandbox import sync as sandbox  # noqa: E402
from withruntime.vercel.sandbox import (GitSource, NetworkPolicy, NetworkPolicySubnets,  # noqa: E402
                                        NotSupportedError, SandboxApiError, SandboxCredentialsError,
                                        SandboxPathNotFoundError, SandboxQueryByName, SandboxResources,
                                        SandboxStatus, SnapshotSource)
from withruntime.vercel._core import network_rules, pick_key, to_runtime_path  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.world = DropInWorld()
        self.client = self.world.client()

    def create(self, **kwargs):
        return sandbox.create_sandbox(client=self.client, **kwargs)

    def last_create(self):
        return self.world.called("sandboxes.create")[-1][0]

    def execs(self):
        return self.world.called("sandbox.exec")


class Create(Base):
    def test_vercel_defaults(self):
        box = self.create()
        self.assertEqual(self.last_create(), {"vcpu": 2, "memory_mib": 4096, "timeout_seconds": 300,
                                              "on_lease_end": "pause"})
        self.assertTrue(box.persistent)
        self.assertEqual((box.status, box.cwd), (SandboxStatus.RUNNING, "/vercel/sandbox"))

    def test_maps_every_field(self):
        self.create(name="agent", resources=SandboxResources(vcpus=4), execution_time_limit=timedelta(minutes=10),
                    tags={"env": "ci"}, persistent=False,
                    network_policy=NetworkPolicy.custom(allow={"pypi.org": ()},
                                                        subnets=NetworkPolicySubnets(deny=["10.0.0.0/8"])))
        self.assertEqual(self.last_create(), {"vcpu": 4, "memory_mib": 8192, "timeout_seconds": 600,
                                              "on_lease_end": "stop", "name": "agent", "labels": {"env": "ci"},
                                              "network": {"internet": True, "allow": ["pypi.org"],
                                                          "deny": ["10.0.0.0/8"]}})

    def test_ports_git_snapshot_sources_and_expiration(self):
        box = self.create(ports=[3000], source=GitSource(url="https://github.com/a/b.git", depth=1, username="u",
                                                         password="p"), snapshot_expiration=timedelta(days=3))
        self.assertEqual(self.world.called("previews.create"), [(3000, {"visibility": "public"})])
        self.assertTrue(box.routes[0].url.startswith("https://3000-"))
        self.assertEqual(self.world.called("sandbox.retention")[0][1], 3)
        argv, options = self.execs()[-1]
        self.assertEqual(argv[-3:], ["--", "https://github.com/a/b.git", "/workspace"])
        self.assertNotIn("p", argv[-3:])
        self.assertEqual(options["env"], {"GIT_USER": "u", "GIT_PASS": "p"})
        self.create(source=SnapshotSource(snapshot_id="snap-1"))
        self.assertEqual(self.last_create(), {"snapshot": "snap-1", "timeout_seconds": 300, "on_lease_end": "pause"})

    def test_images(self):
        self.create(image="vercel/sandbox/universal")
        self.assertNotIn("image", self.last_create())
        self.world.images.append({"id": "img-1", "name": "my-repo", "state": "ready"})
        self.create(image="my-repo")
        self.assertEqual(self.last_create()["image"], "img-1")
        with self.assertRaises(NotSupportedError):
            self.create(image="other")

    def test_refusals_before_anything_happens(self):
        cases = [({"execution_time_limit": 7200}, "over one hour"), ({"mounts": {"/d": "drive"}}, "Drives"),
                 ({"network_id": "n"}, "Secure Compute"), ({"region": "fra1"}, "fra1"),
                 ({"failover_regions": ["sfo1"]}, "Failover")]
        for kwargs, text in cases:
            with self.assertRaises(NotSupportedError) as caught:
                self.create(**kwargs)
            self.assertIn(text, str(caught.exception))
            self.assertTrue(caught.exception.alternative)
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_network_rules(self):
        self.assertEqual(network_rules(NetworkPolicy.deny_all()), {"internet": False})
        self.assertEqual(network_rules(NetworkPolicy.allow_all()), {"internet": True})
        self.assertEqual(network_rules(NetworkPolicy.custom()), {"internet": False})
        with self.assertRaises(NotSupportedError):
            network_rules(NetworkPolicy.custom(allow={"api.github.com": ["rule"]}))


class Keys(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = dict(os.environ)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self.saved)

    def test_vercel_tokens_are_never_sent(self):
        os.environ.pop("RUNTIME_API_KEY", None)
        self.assertIsNone(pick_key(None))
        with self.assertRaises(SandboxCredentialsError):
            pick_key("vercel_token")
        with self.assertRaises(SandboxCredentialsError):
            session(token="vercel_token")
        os.environ["RUNTIME_API_KEY"] = "rtcloud_env"
        self.assertEqual(pick_key("vercel_token"), "rtcloud_env")
        self.assertEqual(pick_key("rtcloud_given"), "rtcloud_given")
        with session():
            pass


class Processes(Base):
    def test_run_process_captures_checks_and_maps_arguments(self):
        box = self.create(env={"A": "1"})
        result = box.run_process("python", ["-c", "print(1)"], cwd="app", env={"B": "2"}, sudo=True, kill_after=5,
                                 capture_output=True)
        self.assertEqual((result.returncode, result.stdout), (0, "ran ['sudo', '--preserve-env', 'python', '-c', "
                                                                 "'print(1)']\n"))
        argv, options = self.execs()[-1]
        self.assertEqual(argv, ["sudo", "--preserve-env", "python", "-c", "print(1)"])
        self.assertEqual(options, {"cwd": "/workspace/app", "env": {"A": "1", "B": "2"}, "timeout_ms": 5000})
        self.world.exec = lambda command, _: Result(3, "", "boom")
        with self.assertRaises(subprocess.CalledProcessError):
            box.run_process("false", check=True)
        self.world.exec = lambda command, _: Result(None, timed_out=True)
        self.assertEqual(box.run_process("sleep", ["9"], kill_after=1).returncode, 137)

    def test_run_process_streams_to_a_writer(self):
        box = self.create()
        out = io.StringIO()
        result = box.run_process("echo", ["hi"], stdout=out)
        self.assertIsNone(result.stdout)
        self.assertIn("ran", out.getvalue())

    def test_create_process_reads_lines_and_waits(self):
        self.world.output = lambda command: [{"type": "stdout", "data": "1\n2\n", "offset": 0},
                                             {"type": "stderr", "data": "e\n", "offset": 4},
                                             {"type": "exit", "exitCode": 0, "state": "exited", "timedOut": False}]
        box = self.create()
        process = box.create_process("sh", ["-c", "seq 2"])
        self.assertEqual(list(process.stdout), ["1\n", "2\n"])
        self.assertEqual(process.wait(), 0)
        self.assertEqual(process.stderr.read(), "e\n")
        process.kill()
        self.assertEqual(self.world.called("process.kill")[-1][1], "SIGKILL")

    def test_links_vercel_sandbox_once(self):
        box = self.create()
        box.run_process("cat", ["/vercel/sandbox/a"], capture_output=True)
        box.run_process("cat", ["/vercel/sandbox/b"], capture_output=True)
        self.assertEqual(len([call for call in self.execs() if "ln -s" in str(call[0])]), 1)

    def test_a_paused_sandbox_wakes_and_the_call_runs_once_more(self):
        box = self.create()
        runtime = self.world.sandboxes[box.withruntime.id]
        runtime.info["state"] = "paused"
        box.run_process("true", capture_output=True)
        self.assertEqual(len(self.world.called("sandbox.wake")), 1)


class Files(Base):
    def test_fs(self):
        box = self.create()
        box.fs.mkdir("workspace")
        box.fs.write_text("workspace/input.txt", "hello\n", mode=0o600)
        self.assertEqual(box.fs.read_text("/vercel/sandbox/workspace/input.txt"), "hello\n")
        self.assertTrue(box.fs.exists("workspace/input.txt"))
        self.assertTrue(box.fs.is_file("workspace/input.txt"))
        self.assertIn("input.txt", [entry.path for entry in box.fs.listdir("workspace")])
        box.fs.rename("workspace/input.txt", "workspace/app.txt")
        box.fs.remove("workspace/nope", missing_ok=True)
        with self.assertRaises(SandboxPathNotFoundError):
            box.fs.read_bytes("workspace/input.txt")
        with box.fs.batch(cwd="workspace") as batch:
            batch.write_text("main.py", "print(1)\n")
        self.assertEqual(box.fs.read_text("workspace/main.py"), "print(1)\n")
        with box.fs.open("big.bin", "wb") as target:
            target.write(b"ab")
            target.write(b"cd")
        self.assertEqual(box.fs.read_bytes("big.bin"), b"abcd")
        self.assertEqual(to_runtime_path("a", "sub"), "/workspace/sub/a")


class Lifecycle(Base):
    def test_context_manager_destroys_and_stop_pauses(self):
        with self.create() as box:
            pass
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)
        kept = self.create(destroy=False, persistent=True)
        kept.stop()
        self.assertEqual(len(self.world.called("sandbox.pause")), 1)

    def test_get_and_get_or_create(self):
        made = self.create(name="ws")
        made.stop()
        found = sandbox.get_sandbox(name="ws", client=self.client)
        self.assertEqual(found.withruntime.id, made.withruntime.id)
        self.assertEqual(self.world.called("sandbox.wake"), [])
        box, created = sandbox.get_or_create_sandbox(name="ws", client=self.client)
        self.assertFalse(created)
        self.assertEqual(len(self.world.called("sandbox.wake")), 1)
        _, created = sandbox.get_or_create_sandbox(name="new", client=self.client)
        self.assertTrue(created)
        with self.assertRaises(SandboxApiError) as caught:
            sandbox.get_sandbox(name="none", client=self.client)
        self.assertEqual(caught.exception.status_code, 404)

    def test_update_extend_snapshot_fork_and_query(self):
        box = self.create(name="src", ports=[3000])
        box.extend_execution_time_limit(timedelta(minutes=2))
        self.assertEqual(self.world.called("sandbox.extend")[-1][1], 120)
        box.update(ports=[8080], network_policy=NetworkPolicy.deny_all())
        self.assertEqual(self.world.called("previews.delete"), [(3000,)])
        with self.assertRaises(NotSupportedError):
            box.update(tags={"a": "b"})
        copy = sandbox.fork_sandbox(source_sandbox="src", name="copy", client=self.client)
        self.assertNotEqual(copy.withruntime.id, box.withruntime.id)
        with self.assertRaises(NotSupportedError):
            sandbox.fork_sandbox(source_sandbox="src", resources=SandboxResources(vcpus=4), client=self.client)
        names = [one.name for one in sandbox.query_sandboxes(SandboxQueryByName(name_prefix="co"), client=self.client)]
        self.assertEqual(names, ["copy"])
        snapshot = box.snapshot(expiration=timedelta(days=7))
        self.assertEqual(self.world.called("sandbox.snapshot")[-1][1]["retention_days"], 7)
        self.assertEqual(sandbox.get_snapshot(snapshot_id=snapshot.id, client=self.client).status, "created")
        snapshot.delete()

    def test_gaps(self):
        box = self.create()
        for refuse in (box.list_sessions, box.list_snapshots, lambda: sandbox.query_sessions(),
                       lambda: sandbox.get_or_create_drive(name="d"), lambda: async_sandbox.Drive()):
            with self.assertRaises(NotSupportedError) as caught:
                refuse()
            self.assertTrue(caught.exception.alternative)

    def test_runtime_errors_become_sandbox_api_errors(self):
        box = self.create()

        def fail(command, _):
            raise withruntime.RateLimitError("Slow down.", code="rate_limited", status=429, hint="Wait.")
        self.world.exec = fail
        with self.assertRaises(SandboxApiError) as caught:
            box.run_process("ls")
        self.assertEqual((caught.exception.status_code, caught.exception.code, caught.exception.hint),
                         (429, "rate_limited", "Wait."))


class Async(unittest.TestCase):
    def test_operations_await_and_manage_context(self):
        world = DropInWorld()
        client = world.async_client()

        async def scenario():
            async with async_sandbox.create_sandbox(client=client) as box:
                result = await box.run_process("python", ["-c", "print(1)"], capture_output=True, check=True)
                self.assertEqual(result.returncode, 0)
                await box.fs.write_text("a.txt", "x")
                self.assertEqual(await box.fs.read_text("a.txt"), "x")
                process = await box.create_process("sh", ["-c", "echo hi"])
                self.assertEqual([line async for line in process.stdout], ["ran ['sh', '-c', 'echo hi']\n"])
            kept = await async_sandbox.create_sandbox(client=client, destroy=False)
            await kept.stop()
            found = [one.name async for one in async_sandbox.query_sandboxes(client=client)]
            self.assertEqual(len(found), 2)
        asyncio.run(scenario())
        self.assertEqual(len(world.called("sandbox.stop")), 1)
        self.assertEqual(len(world.called("sandbox.pause")), 1)


if __name__ == "__main__":
    unittest.main()
