"""The Daytona adapter against a fake of the withruntime SDK (tests/dropin_fake.py):
the mappings and the refusals, sync and async."""
import asyncio
import base64
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dropin_fake import DropInWorld  # noqa: E402

import withruntime  # noqa: E402
from withruntime.daytona import (AsyncDaytona, CodeRunParams, CreateSandboxFromImageParams,  # noqa: E402
                                 CreateSandboxFromSnapshotParams, CreateSnapshotParams, Daytona,
                                 DaytonaAuthenticationError, DaytonaCommandAlreadyCompletedError, DaytonaConfig,
                                 DaytonaConflictError, DaytonaFileNotFoundError, DaytonaNotFoundError,
                                 DaytonaProcessExecutionTimeoutError, DaytonaRateLimitError, FileDownloadRequest, Image,
                                 NotSupportedError, Resources, SandboxState, SessionExecuteRequest, VolumeMount)
from withruntime.daytona._core import lifecycle_of, pick_key, resolve_path  # noqa: E402
from e2b_fake import Result  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.world = DropInWorld()
        self.daytona = Daytona(client=self.world.client())

    def last_create(self):
        return self.world.called("sandboxes.create")[-1][0]

    def execs(self):
        return self.world.called("sandbox.exec")


class Create(Base):
    def test_daytona_defaults(self):
        sandbox = self.daytona.create()
        # No time limit: autoStopInterval is its idle pause (0300).
        self.assertEqual(self.last_create(), {"vcpu": 1, "memory_mib": 1024, "disk_mib": 3072,
                                              "idle_pause_seconds": 900, "on_lease_end": "pause"})
        self.assertEqual(sandbox.state, SandboxState.STARTED)
        self.assertEqual((sandbox.cpu, sandbox.user, sandbox.auto_stop_interval), (1, "daytona", 15))

    def test_maps_resources_labels_network_volumes_and_lifecycle(self):
        self.world.volumes.append({"id": "11111111-2222-4333-8444-555555555555", "name": "data", "state": "ready"})
        self.daytona.create(CreateSandboxFromSnapshotParams(
            name="agent", labels={"team": "x"}, resources=Resources(cpu=2, memory=4, disk=10), auto_stop_interval=30,
            network_allow_list="10.0.0.0/8", domain_allow_list="pypi.org",
            volumes=[VolumeMount(volume_id="data", mount_path="/data")]))
        self.assertEqual(self.last_create(), {
            "vcpu": 2, "memory_mib": 4096, "disk_mib": 10240, "idle_pause_seconds": 1800, "on_lease_end": "pause",
            "name": "agent", "labels": {"team": "x"}, "network": {"internet": True, "allow": ["10.0.0.0/8", "pypi.org"]},
            "volumes": [{"volume_id": "11111111-2222-4333-8444-555555555555", "path": "/data"}]})

    def test_ephemeral_and_retention(self):
        self.daytona.create(CreateSandboxFromSnapshotParams(ephemeral=True, network_block_all=True))
        self.assertEqual(self.last_create()["on_lease_end"], "stop")
        self.assertEqual(self.last_create()["network"], {"internet": False})
        self.daytona.create(CreateSandboxFromSnapshotParams(auto_delete_interval=60 * 24 * 3))
        self.assertEqual(self.world.called("sandbox.retention")[-1][1], 3)

    def test_lifecycle(self):
        self.assertEqual(lifecycle_of(CreateSandboxFromSnapshotParams(auto_stop_interval=0)).window_seconds, 3600)
        self.assertEqual(lifecycle_of(CreateSandboxFromSnapshotParams(auto_pause_interval=5)).window_seconds, 300)
        self.assertTrue(lifecycle_of(CreateSandboxFromSnapshotParams(auto_delete_interval=0)).ephemeral)

    def test_snapshot_names(self):
        self.daytona.create(CreateSandboxFromSnapshotParams(snapshot="daytona-medium"))
        self.assertNotIn("image", self.last_create())
        self.world.images.append({"id": "img-1", "name": "my-env", "state": "ready"})
        self.daytona.create(CreateSandboxFromSnapshotParams(snapshot="my-env"))
        self.assertEqual(self.last_create()["image"], "img-1")
        self.world.named_snapshots.append({"id": "snap-9", "name": "saved", "state": "ready"})
        self.daytona.create(CreateSandboxFromSnapshotParams(snapshot="saved"))
        self.assertEqual(self.last_create(), {"snapshot": "snap-9", "idle_pause_seconds": 900, "on_lease_end": "pause"})
        with self.assertRaises(DaytonaNotFoundError) as caught:
            self.daytona.create(CreateSandboxFromSnapshotParams(snapshot="unknown"))
        self.assertIn("daytona.snapshot.create", str(caught.exception))

    def test_images_build_once(self):
        self.daytona.create(CreateSandboxFromImageParams(image="python:3.12-slim"))
        self.assertEqual(self.world.called("images.build")[0][0], {"name": "python-3.12-slim",
                                                                   "image": "python:3.12-slim"})
        self.daytona.create(CreateSandboxFromImageParams(image="python:3.12-slim"))
        self.assertEqual(len(self.world.called("images.build")), 1)
        with tempfile.TemporaryDirectory() as directory:
            requirements = Path(directory, "requirements.txt")
            requirements.write_text("requests\n")
            image = (Image.debian_slim("3.12").pip_install("numpy", "pandas")
                     .pip_install_from_requirements(str(requirements)).env({"A": "1"}).workdir("/app"))
            self.daytona.create(CreateSandboxFromImageParams(image=image))
        built = self.world.called("images.build")[1][0]
        self.assertIn("FROM python:3.12-slim-bookworm", built["dockerfile"])
        self.assertIn('RUN python -m pip install "numpy" "pandas"', built["dockerfile"])
        self.assertEqual(len(built["files"]), 1)
        self.assertRegex(built["name"], r"^daytona-image-[0-9a-f]{16}$")

    def test_refusals_before_anything_happens(self):
        cases = [(CreateSandboxFromSnapshotParams(resources=Resources(gpu=1)), "GPUs"),
                 (CreateSandboxFromSnapshotParams(spot=True), "Spot"),
                 (CreateSandboxFromSnapshotParams(secrets={"A": "s"}), "secrets"),
                 (CreateSandboxFromSnapshotParams(language="rust"), "language rust")]
        for params, text in cases:
            with self.assertRaises(NotSupportedError) as caught:
                self.daytona.create(params)
            self.assertIn(text, str(caught.exception))
            self.assertTrue(caught.exception.alternative)
        with self.assertRaises(NotSupportedError):
            Image.base("x").pip_install_from_pyproject("pyproject.toml")
        self.assertEqual(self.world.called("sandboxes.create"), [])


class Keys(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = dict(os.environ)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self.saved)

    def test_daytona_keys_are_never_sent(self):
        os.environ.pop("RUNTIME_API_KEY", None)
        os.environ["DAYTONA_API_KEY"] = "dtn_abc"
        self.assertIsNone(pick_key(None))
        with self.assertRaises(DaytonaAuthenticationError):
            pick_key("dtn_abc")

    def test_order(self):
        os.environ["RUNTIME_API_KEY"] = "rtcloud_env"
        os.environ["DAYTONA_API_KEY"] = "rtcloud_other"
        self.assertEqual(pick_key("rtcloud_given"), "rtcloud_given")
        self.assertEqual(pick_key("dtn_abc"), "rtcloud_env")
        del os.environ["RUNTIME_API_KEY"]
        self.assertEqual(pick_key(None), "rtcloud_other")

    def test_target_and_jwt(self):
        world = DropInWorld()
        Daytona(DaytonaConfig(target="us", api_url="https://app.daytona.io/api"), client=world.client())
        with self.assertRaises(NotSupportedError):
            Daytona(DaytonaConfig(target="eu"), client=world.client())
        with self.assertRaises(NotSupportedError):
            Daytona(DaytonaConfig(jwt_token="j"), client=world.client())


class Process(Base):
    def test_exec_is_combined_and_a_non_zero_exit_is_a_result(self):
        self.world.exec = lambda command, _: Result(2, "out\nerr\n")
        sandbox = self.daytona.create(CreateSandboxFromSnapshotParams(env_vars={"A": "1"}))
        response = sandbox.process.exec("ls", cwd="src", env={"B": "2"}, timeout=5)
        self.assertEqual((response.exit_code, response.result), (2, "out\nerr\n"))
        command, options = self.execs()[-1]
        self.assertEqual(command, "{ ls\n} 2>&1")
        self.assertEqual(options, {"cwd": "/workspace/src", "env": {"A": "1", "B": "2"}, "timeout_ms": 5000})

    def test_whole_output_past_the_64_kib_an_exec_result_holds(self):
        big = "x" * 70_000 + "\n"
        self.world.exec = lambda command, _: (Result(0, "/workspace/a.py:1:x\n" * 4_000)
                                              if str(command).startswith("['grep'") else Result(0, big))
        sandbox = self.daytona.create()
        # A timeout of a minute or less is an exec that is not otherwise streamed.
        self.assertEqual(sandbox.process.exec("cat big", timeout=30).result, big)
        self.assertEqual(sandbox.process.code_run("print('x'*70000)", timeout=30).result, big)
        self.assertEqual(len(sandbox.fs.find_files(".", "x")), 4_000)

    def test_timeout(self):
        self.world.exec = lambda command, _: Result(None, timed_out=True)
        sandbox = self.daytona.create()
        with self.assertRaises(DaytonaProcessExecutionTimeoutError):
            sandbox.process.exec("sleep 9", timeout=1)

    def test_code_run(self):
        sandbox = self.daytona.create()
        sandbox.process.code_run("print(1)", CodeRunParams(argv=["a"]))
        self.assertEqual(self.execs()[-1][0], ["sh", "-c", 'exec "$@" 2>&1', "sh", "python3", "-c", "print(1)", "a"])
        typescript = self.daytona.create(CreateSandboxFromSnapshotParams(language="typescript"))
        self.assertEqual(self.last_create()["labels"], {"code-toolbox-language": "typescript"})
        self.daytona.get(typescript.id).process.code_run("console.log(1)")
        self.assertEqual(self.execs()[-1][0][4:6], ["bun", "-e"])

    def test_home_link_once(self):
        sandbox = self.daytona.create()
        sandbox.process.exec("ls /home/daytona")
        sandbox.fs.upload_file(b"x", "/home/daytona/a.txt")
        links = [call for call in self.execs() if "ln -s" in str(call[0])]
        self.assertEqual(len(links), 1)

    def test_sessions(self):
        sandbox = self.daytona.create()
        sandbox.process.create_session("s1")
        spawned = self.world.called("sandbox.spawn")[0]
        self.assertEqual(spawned[0], ["bash", "--noprofile", "--norc", "-s", "daytona-session:s1"])
        shell = self.world.sandboxes[sandbox.id].process_list[0]
        events = []
        written = shell.write

        def write(data, eof=False):
            written(data, eof)
            found = re.match(r"^__rt_run (\S+) (\S+)\n$", str(data))
            if found:
                command = base64.b64decode(found.group(1)).decode()
                code = 1 if command == "false" else 0
                events.extend([{"type": "stdout", "data": f"ran {command}\n\x1eRT{found.group(2)}:{code}", "offset": 0},
                               {"type": "stdout", "data": "\x1e", "offset": 0},
                               {"type": "stderr", "data": f"\x1eRT{found.group(2)}\x1e", "offset": 0}])
        shell.write = write

        def output(cursor=0):
            while events:
                yield events.pop(0)
        shell.output = output
        result = sandbox.process.execute_session_command("s1", SessionExecuteRequest(command="cd /tmp && pwd"))
        self.assertEqual((result.stdout, result.stderr, result.exit_code), ("ran cd /tmp && pwd\n", "", 0))
        self.assertEqual(sandbox.process.execute_session_command("s1", SessionExecuteRequest(command="false"))
                         .exit_code, 1)
        started = sandbox.process.execute_session_command("s1", SessionExecuteRequest(command="npm run dev",
                                                                                          run_async=True))
        logs = sandbox.process.get_session_command_logs("s1", started.cmd_id)
        self.assertEqual(logs.stdout, "ran npm run dev\n")
        with self.assertRaises(DaytonaCommandAlreadyCompletedError):
            sandbox.process.send_session_command_input("s1", started.cmd_id, "y\n")
        with self.assertRaises(DaytonaConflictError):
            sandbox.process.create_session("s1")
        self.assertEqual(len(sandbox.process.get_session("s1").commands), 3)
        sandbox.process.delete_session("s1")
        self.assertEqual(self.world.called("process.kill")[-1], (shell.id, "SIGKILL"))
        with self.assertRaises(DaytonaNotFoundError):
            sandbox.process.get_session("s1")

    def test_refusals_point_at_what_runtime_has(self):
        sandbox = self.daytona.create()
        for call, text in ((sandbox.update_secrets, "withruntime secrets set"),
                           (sandbox.get_metrics, "sandbox.withruntime.metrics("),
                           (sandbox.create_ssh_access, "withruntime sandbox ssh"),
                           (lambda: self.daytona.create(CreateSandboxFromSnapshotParams(secrets={"A": "s"})),
                            "withruntime secrets set")):
            with self.assertRaises(NotSupportedError) as caught:
                call()
            self.assertIn(text, caught.exception.alternative)


class Files(Base):
    def test_files(self):
        sandbox = self.daytona.create()
        sandbox.fs.upload_file(b"hello world", "docs/a.txt")
        self.assertEqual(sandbox.fs.download_file("docs/a.txt"), b"hello world")
        self.assertEqual([one.name for one in sandbox.fs.list_files("docs")], ["a.txt"])
        self.assertFalse(sandbox.fs.get_file_info("docs/a.txt").is_dir)
        sandbox.fs.replace_in_files(["docs/a.txt"], "world", "there")
        self.assertEqual(sandbox.fs.download_file("docs/a.txt"), b"hello there")
        sandbox.fs.move_files("docs/a.txt", "docs/c.txt")
        with self.assertRaises(DaytonaFileNotFoundError):
            sandbox.fs.download_file("docs/a.txt")
        results = sandbox.fs.download_files([FileDownloadRequest(source="docs/c.txt"), FileDownloadRequest(source="x")])
        self.assertEqual(results[0].result, b"hello there")
        self.assertTrue(results[1].error)
        self.assertEqual(resolve_path("~/a"), "/workspace/a")

    def test_git_credentials_stay_out_of_the_command(self):
        sandbox = self.daytona.create()
        sandbox.git.clone("https://github.com/a/b.git", "repo", branch="main", username="u", password="secret")
        argv, options = self.execs()[-1]
        self.assertIn("/workspace/repo", argv)
        self.assertNotIn("secret", " ".join(argv))
        self.assertEqual(options["env"]["GIT_PASS"], "secret")


class Lifecycle(Base):
    def test_stop_start_delete(self):
        sandbox = self.daytona.create()
        sandbox.stop()
        self.assertEqual(sandbox.state, SandboxState.STOPPED)
        sandbox.start()
        self.assertIsNone(self.world.called("sandbox.wake")[-1][1])  # no time limit, none on waking
        sandbox.delete()
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)
        ephemeral = self.daytona.create(CreateSandboxFromSnapshotParams(ephemeral=True))
        ephemeral.stop()
        self.assertEqual(len(self.world.called("sandbox.stop")), 2)

    def test_activity_moves_the_lease(self):
        import time
        from e2b_fake import _iso
        sandbox = self.daytona.create(CreateSandboxFromSnapshotParams(ttl_minutes=120))
        self.world.sandboxes[sandbox.id].info["expiresAt"] = _iso(time.time() + 60)
        sandbox.process.exec("true")
        self.assertGreaterEqual(self.world.called("sandbox.extend")[-1][1], 839)

    def test_get_list_preview_fork_snapshot(self):
        made = self.daytona.create(CreateSandboxFromSnapshotParams(name="one", labels={"a": "b"}, public=True))
        self.daytona.create(CreateSandboxFromSnapshotParams(name="two"))
        self.assertEqual(self.daytona.get("one").id, made.id)
        self.assertEqual(self.daytona.get(made.id).id, made.id)
        with self.assertRaises(DaytonaNotFoundError):
            self.daytona.get("none")
        from withruntime.daytona import ListSandboxesQuery
        self.assertEqual([one.id for one in self.daytona.list(ListSandboxesQuery(labels={"a": "b"}))], [made.id])
        link = made.get_preview_link(3000)
        self.assertEqual(self.world.called("previews.create")[-1], (3000, {"visibility": "public"}))
        self.assertTrue(link.url.startswith("https://3000-"))
        self.assertNotEqual(made.fork(name="copy").id, made.id)
        made.create_snapshot("saved")
        self.assertEqual(self.world.called("sandbox.snapshot")[-1][1]["name"], "saved")

    def test_snapshot_service(self):
        made = self.daytona.snapshot.create(CreateSnapshotParams(name="my env", image="node:22"))
        self.assertEqual(self.world.called("images.build")[0][0], {"name": "my-env", "image": "node:22"})
        self.assertEqual(self.daytona.snapshot.get("my env").id, made.id)
        self.daytona.snapshot.delete("my env")
        self.assertEqual(self.world.called("images.delete"), [(made.id,)])
        with self.assertRaises(NotSupportedError):
            self.daytona.snapshot.create(CreateSnapshotParams(name="x", image="y", resources=Resources(cpu=2)))


class ErrorsAndGaps(Base):
    def test_runtime_errors_become_daytonas(self):
        sandbox = self.daytona.create()

        def fail(command, _):
            raise withruntime.RateLimitError("Slow down.", code="rate_limited", status=429, hint="Wait.")
        self.world.exec = fail
        with self.assertRaises(DaytonaRateLimitError) as caught:
            sandbox.process.exec("ls")
        self.assertEqual((caught.exception.status_code, caught.exception.code, caught.exception.hint),
                         (429, "rate_limited", "Wait."))

    def test_gaps(self):
        sandbox = self.daytona.create()
        for refuse in (sandbox.resize, sandbox.get_metrics, sandbox.create_signed_preview_url,
                       sandbox.create_ssh_access, sandbox.upload_url,
                       sandbox.computer_use.accessibility.get_tree,
                       lambda: sandbox.computer_use.screenshot.take_region(None),
                       lambda: self.daytona.volume.create("v"),
                       lambda: sandbox.code_interpreter.run_code("1", envs={"A": "1"})):
            with self.assertRaises(NotSupportedError) as caught:
                refuse()
            self.assertTrue(caught.exception.alternative)

    def test_code_interpreter(self):
        sandbox = self.daytona.create(CreateSandboxFromSnapshotParams(env_vars={"A": "1"}))
        seen = []
        result = sandbox.code_interpreter.run_code("1 + 1", on_stdout=lambda message: seen.append(message.output))
        self.assertEqual((result.stdout, result.error), ("out 1 + 1\n", None))
        self.assertEqual(self.world.called("contexts.create")[0][0],
                         {"language": "python", "cwd": "/workspace", "env": {"A": "1"}})
        self.assertEqual(seen, ["out 1 + 1\n"])


class Async(unittest.TestCase):
    def test_the_async_client_maps_the_same_calls(self):
        world = DropInWorld()

        async def scenario():
            daytona = AsyncDaytona(client=world.async_client())
            sandbox = await daytona.create(CreateSandboxFromSnapshotParams(name="a"))
            response = await sandbox.process.exec("echo hi")
            self.assertEqual(response.exit_code, 0)
            await sandbox.fs.upload_file(b"x", "a.txt")
            self.assertEqual(await sandbox.fs.download_file("a.txt"), b"x")
            listed = [one.id async for one in daytona.list()]
            self.assertEqual(listed, [sandbox.id])
            await sandbox.stop()
            await sandbox.start()
            await sandbox.delete()
        asyncio.run(scenario())
        self.assertEqual(len(world.called("sandbox.stop")), 1)

    def test_generated_sync_modules_are_current(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "generate_dropin_sync.py"), "--check"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
