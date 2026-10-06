"""withruntime.harbor: Harbor's own BaseEnvironment machinery driven against a
fake Runtime whose sandbox is a temporary directory on this machine.

Commands really run, through the adapter's launcher script, with /workspace
mapped to that directory, so staging, streaming, the env and script files for
oversized commands, tar transfers and timeouts are exercised for real. When
this machine has passwordless sudo, the fake reports the sandbox user as
uid 1000 and root commands go through the real sudo, as in a sandbox; when it
runs as root without sudo they run directly. What the fake cannot show: a
microVM, the images API's builds, network rules being enforced, and the API
itself. The live run is scripts/harbor_e2e.py.

Skipped when Harbor is not installed (pip install "withruntime[harbor]"). The
fake is shared with tests/test_inspect_ai.py."""
import asyncio
import os
import shutil
import signal
import subprocess
import tempfile
import types
import unittest
import uuid
from pathlib import Path

try:
    import harbor  # noqa: F401
    HAVE_HARBOR = True
except ImportError:
    HAVE_HARBOR = False

from withruntime._errors import InvalidRequestError, NotFoundError
from withruntime._errors import RuntimeError as RuntimeCloudError


def local_mode():
    """How this machine can play the sandbox: "sudo" (real passwordless sudo, sandbox user uid 1000),
    "root" (running as root, no sudo needed) or None (root commands cannot run here)."""
    if os.path.exists("/usr/bin/sudo"):
        try:
            if subprocess.run(["/usr/bin/sudo", "-n", "-E", "true"], capture_output=True).returncode == 0:
                return "sudo"
        except OSError:
            # A filesystem sandbox can forbid sudo itself, without forbidding
            # the adapter's ordinary non-root contract tests.
            pass
    return "root" if os.geteuid() == 0 else None


@unittest.skipUnless(HAVE_HARBOR, "Harbor is not installed")
class FolderRouteContract(unittest.IsolatedAsyncioTestCase):
    async def test_upload_directory_uses_the_native_root_folder_route(self):
        from withruntime.harbor import RuntimeEnvironment

        calls = []

        async def upload(local_path, remote_path, *, user):
            calls.append((local_path, remote_path, user))

        sandbox = types.SimpleNamespace(files=types.SimpleNamespace(upload=upload))
        environment = types.SimpleNamespace(_require=lambda: (sandbox, object()))
        with tempfile.TemporaryDirectory(prefix="harbor-route-") as source:
            (Path(source) / "test.txt").write_text("folder contents")
            await RuntimeEnvironment.upload_dir(environment, Path(source), "/root/data")
            self.assertEqual(calls, [(source, "/root/data", "root")])

    async def test_download_directory_uses_the_native_root_folder_route(self):
        from withruntime.harbor import RuntimeEnvironment

        calls = []

        async def download(remote_path, local_path, *, user):
            calls.append((remote_path, local_path, user))

        sandbox = types.SimpleNamespace(files=types.SimpleNamespace(download=download))
        environment = types.SimpleNamespace(_require=lambda: (sandbox, object()))
        await RuntimeEnvironment.download_dir(environment, "/root/data", Path("local-dir"))
        self.assertEqual(calls, [("/root/data", "local-dir", "root")])


class FakeFiles:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def _local(self, path):
        if not (path == "/workspace" or path.startswith("/workspace/")):
            raise InvalidRequestError("Large writes go only to /workspace.", code="invalid_request", status=400)
        return self.sandbox.local(path)

    async def read(self, path):
        local = self._local(path)
        if not os.path.isfile(local):
            raise NotFoundError("No such file or directory.", code="file_not_found", status=404)
        with open(local, "rb") as handle:
            return handle.read()

    async def write(self, path, data, mode=None):
        local = self._local(path)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        with open(local, "wb") as handle:
            handle.write(data if isinstance(data, bytes) else data.encode())
        self.sandbox.world.calls.append(("write", path, len(data)))
        return {"path": path, "size": len(data)}

    async def remove(self, path, recursive=False):
        local = self._local(path)
        if os.path.isdir(local):
            shutil.rmtree(local)
        elif os.path.exists(local):
            os.remove(local)
        else:
            raise NotFoundError("gone", code="file_not_found", status=404)
        return True

    async def upload(self, local_path, remote_path, *, user="sandbox"):
        if user != "root":
            raise AssertionError("Harbor directories must travel as root")
        target = self.sandbox.local(remote_path) if remote_path.startswith("/workspace/") else remote_path
        shutil.copytree(local_path, target, symlinks=True, dirs_exist_ok=True)
        self.sandbox.world.calls.append(("upload_dir", remote_path, user))

    async def download(self, remote_path, local_path, *, user="sandbox"):
        if user != "root":
            raise AssertionError("Harbor directories must travel as root")
        source = self.sandbox.local(remote_path) if remote_path.startswith("/workspace/") else remote_path
        shutil.copytree(source, local_path, symlinks=True, dirs_exist_ok=True)
        self.sandbox.world.calls.append(("download_dir", remote_path, user))


class FakeNetwork:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    async def set(self, *, internet, allow=None, deny=None, connect=None):
        self.sandbox.world.calls.append(("network", self.sandbox.id, internet, allow))
        return {"internet": internet, "allow": allow}


class FakeSandbox:
    """A directory standing in for the disk; /workspace inside it."""

    def __init__(self, world, fields):
        self.world, self.fields = world, fields
        self.info = {"id": str(uuid.uuid4()), "state": "running"}
        self.disk = tempfile.mkdtemp(prefix="fake-runtime-")
        os.makedirs(os.path.join(self.disk, "workspace"))
        self.files = FakeFiles(self)
        self.network = FakeNetwork(self)
        self.alive = False
        self.pause_next = False

    @property
    def id(self):
        return self.info["id"]

    @property
    def state(self):
        return self.info["state"]

    def local(self, path):
        return self.disk + path

    def _map(self, text):
        return text.replace("/workspace", self.disk + "/workspace")

    async def exec_stream(self, command, *, cwd=None, env=None, stdin=None, timeout_ms=None, idempotency_key=None):
        if self.pause_next:
            self.pause_next = False
            raise RuntimeCloudError("paused", code="sandbox_paused", status=409)
        if self.state != "running":
            raise RuntimeCloudError("The sandbox is stopped.", code="sandbox_stopped", status=409)
        argv = list(command)
        self.world.calls.append(("exec", argv, cwd, dict(env) if env else None, timeout_ms))
        if len(argv) > 2 and "for p in /usr/bin/sudo /bin/sudo" in argv[2]:
            yield {"type": "start", "processId": "probe"}
            yield {"type": "stdout", "offset": 0, "data": "\n".join(self.world.probe) + "\n"}
            yield {"type": "exit", "exitCode": 0, "timedOut": False}
            return
        data = stdin.encode() if isinstance(stdin, str) else stdin
        proc = await asyncio.create_subprocess_exec(
            *[self._map(part) for part in argv], cwd=self._map(cwd or "/workspace"), env={**os.environ, **(env or {})},
            stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        yield {"type": "start", "processId": str(proc.pid)}
        timed_out = False
        try:
            out, err = await asyncio.wait_for(proc.communicate(data), (timeout_ms or 86_400_000) / 1000)
        except asyncio.TimeoutError:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            out, err = await proc.communicate()
        if out:
            yield {"type": "stdout", "offset": 0, "data": out.decode("utf-8", "replace")}
        if err:
            yield {"type": "stderr", "offset": 0, "data": err.decode("utf-8", "replace")}
        # As the live API reports it: a command past its limit is killed and reads -9,
        # and a command a signal ended reads the negative signal number (-15, -9).
        yield {"type": "exit", "exitCode": -9 if timed_out else proc.returncode, "timedOut": timed_out}

    def keep_alive(self, every_seconds=60, margin_seconds=600):
        self.alive = True
        return self.stop_keep_alive

    def stop_keep_alive(self):
        self.alive = False

    async def stop(self, wait=True, idempotency_key=None):
        self.world.calls.append(("stop", self.id))
        self.alive = False
        self.info["state"] = "stopped"
        return self

    async def wake(self, wait=True, timeout_seconds=None, idempotency_key=None):
        self.world.calls.append(("wake", self.id))
        return self

    async def refresh(self):
        return self


class FakePage:
    def __init__(self, data):
        self.data = data

    async def to_list(self, limit=10_000):
        return list(self.data)


class FakeSandboxes:
    def __init__(self, world):
        self.world = world

    async def create(self, **fields):
        self.world.calls.append(("create", fields))
        if self.world.trial and fields.get("funding") is None and (
                fields.get("vcpu", 2) > 2 or fields.get("memory_mib", 4096) > 4096 or
                fields.get("disk_mib", 4096) > 10240):
            raise InvalidRequestError("A trial sandbox is at most 2 vCPU and 4 GiB.", code="no_credit_size_limit",
                                      status=400)
        sandbox = FakeSandbox(self.world, fields)
        self.world.machines[sandbox.id] = sandbox
        return sandbox

    async def get(self, sandbox_id):
        if sandbox_id not in self.world.machines:
            raise NotFoundError("gone", code="not_found", status=404)
        return self.world.machines[sandbox_id]

    async def list(self, *, labels=None, **_):
        found = [s for s in self.world.machines.values() if s.state == "running" and
                 all((s.fields.get("labels") or {}).get(k) == v for k, v in (labels or {}).items())]
        return FakePage(found)


class FakeImages:
    def __init__(self, world):
        self.world = world
        self.tags = {}

    async def resolve(self, ref):
        self.world.calls.append(("resolve", ref))
        if ref not in self.tags:
            raise NotFoundError(f"No image {ref}.", code="not_found", status=404)
        return {"id": self.tags[ref], "state": "ready"}

    async def build(self, *, on_log=None, poll_seconds=1.0, **fields):
        self.world.calls.append(("build", fields))
        if self.world.fail_builds:
            raise RuntimeCloudError("Image x failed: RUN exited 1", code="image_build_failed")
        image_id = str(uuid.uuid4())
        for tag in fields.get("tags") or ["latest"]:
            self.tags[f"{fields['name']}:{tag}"] = image_id
        if on_log is not None:
            on_log({"seq": 1, "text": "built"})
        return {"id": image_id, "state": "ready", "name": fields["name"]}


class FakeRuntime:
    """The parts of AsyncRuntime the adapters use. ``probe`` is what the sandbox says about itself:
    uid, user name, sudo (a path, "-" for none, "!path" for one that asks a password), shell."""

    def __init__(self, mode="sudo", trial=False):
        self.calls, self.machines = [], {}
        self.trial, self.fail_builds, self.closed = trial, False, 0
        if mode == "sudo":
            self.probe = ["1000", "runtime", "/usr/bin/sudo", "bash"]
        elif mode == "root":
            self.probe = ["0", "root", "-", "bash"]
        else:
            self.probe = ["1000", "runtime", "-", "bash"]
        self.sandboxes = FakeSandboxes(self)
        self.images = FakeImages(self)

    async def close(self):
        self.closed += 1

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()

    def of(self, kind):
        return [call for call in self.calls if call[0] == kind]

    def cleanup(self):
        for sandbox in self.machines.values():
            shutil.rmtree(sandbox.disk, ignore_errors=True)


def run(coroutine):
    return asyncio.run(coroutine)


MODE = local_mode()


@unittest.skipUnless(HAVE_HARBOR, "Harbor is not installed")
class HarborEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.world = FakeRuntime(MODE or "nosudo")
        self.dir = Path(tempfile.mkdtemp(prefix="harbor-task-"))
        self.env_dir = self.dir / "environment"
        self.env_dir.mkdir()

    def tearDown(self):
        self.world.cleanup()
        shutil.rmtree(self.dir, ignore_errors=True)

    def make(self, dockerfile="FROM python:3.13-slim\nWORKDIR /workspace/app\n", **config):
        from harbor.models.task.config import EnvironmentConfig
        from harbor.models.trial.paths import TrialPaths
        from withruntime.harbor import RuntimeEnvironment
        if dockerfile is not None:
            (self.env_dir / "Dockerfile").write_text(dockerfile)
        options = {key: config.pop(key) for key in ("funding", "network_policy", "image") if key in config}
        trial = self.dir / f"trial-{uuid.uuid4().hex[:6]}"
        trial.mkdir()
        paths = TrialPaths(trial_dir=trial)
        paths.mkdir()
        return RuntimeEnvironment(environment_dir=self.env_dir, environment_name="hello-world",
                                  session_id="hello-world__abc__env", trial_paths=paths,
                                  task_env_config=EnvironmentConfig(**config), runtime=self.world, **options)

    def needs_root(self):
        if MODE is None:
            self.skipTest("root commands need passwordless sudo or root on this machine")

    def test_prebuilt_image_is_built_once_then_reused(self):
        self.needs_root()

        async def body():
            first = self.make(docker_image="alexgshaw/hello-world:20251031", cpus=1, memory_mb=2048,
                              storage_mb=10240)
            await first.start(force_build=False)
            await first.stop(delete=True)
            second = self.make(docker_image="alexgshaw/hello-world:20251031", cpus=1, memory_mb=2048,
                               storage_mb=10240)
            await second.start(force_build=False)
            await second.stop(delete=True)
        run(body())
        builds = self.world.of("build")
        self.assertEqual(len(builds), 1, "the second trial reuses the image")
        fields = builds[0][1]
        self.assertEqual(fields["image"], "alexgshaw/hello-world:20251031")
        self.assertTrue(fields["name"].startswith("harbor-hello-world"))
        self.assertTrue(fields["no_start"])
        self.assertEqual(fields["build"]["timeout_seconds"], 600)
        creates = [call[1] for call in self.world.of("create")]
        self.assertEqual(len(creates), 2)
        self.assertEqual(creates[0]["image"], creates[1]["image"])
        self.assertEqual((creates[0]["vcpu"], creates[0]["memory_mib"], creates[0]["disk_mib"]), (1, 2048, 10240))
        self.assertEqual(creates[0]["idle_pause_seconds"], 0)
        self.assertEqual(creates[0]["labels"]["created_by"], "harbor")
        self.assertNotIn("network", creates[0])
        self.assertEqual(len(self.world.of("stop")), 2)
        self.assertTrue(all(not s.alive for s in self.world.machines.values()))

    def test_force_build_builds_the_dockerfile_without_cache(self):
        self.needs_root()

        async def body():
            env = self.make(docker_image="alexgshaw/hello-world:20251031")
            await env.start(force_build=True)
            await env.stop(delete=True)
        run(body())
        fields = self.world.of("build")[0][1]
        self.assertIn("WORKDIR /workspace/app", fields["dockerfile"])
        self.assertEqual(fields["context_dir"], str(self.env_dir))
        self.assertIs(fields["cache"], False)

    def test_a_failed_build_is_harbors_build_error(self):
        from harbor.environments.base import SandboxBuildFailedError
        self.world.fail_builds = True
        with self.assertRaises(SandboxBuildFailedError):
            run(self.make().start(force_build=False))
        self.assertEqual(self.world.of("create"), [])

    def test_exec_runs_as_root_in_the_dockerfile_workdir_with_env_and_streams(self):
        self.needs_root()
        seen = []

        async def collect(text, stream):
            seen.append((stream, text))

        async def body():
            env = self.make(env={"TASK_VAR": "from-task"})
            await env.start(force_build=False)
            try:
                with env.scoped_output_callback(collect):
                    result = await env.exec('id -u; pwd; echo "$TASK_VAR $EXTRA"; echo oops >&2; exit 3',
                                            env={"EXTRA": "per-exec"})
                as_user = await env.exec("id -u", user=1000 if MODE == "sudo" else 0)
                return result, as_user
            finally:
                await env.stop(delete=True)
        result, as_user = run(body())
        lines = result.stdout.splitlines()
        self.assertEqual(lines[0], "0")
        self.assertTrue(lines[1].endswith("/workspace/app"), lines[1])
        self.assertEqual(lines[2], "from-task per-exec")
        self.assertEqual(result.stderr, "oops\n")
        self.assertEqual(result.return_code, 3)
        self.assertIn(("stderr", "oops\n"), seen)
        self.assertEqual(as_user.return_code, 0)
        if MODE == "sudo":
            launches = [call for call in self.world.of("exec") if len(call[1]) > 3 and call[1][3] == "runtime"]
            self.assertTrue(any(call[1][4] == "/usr/bin/sudo" and call[1][5] == "root" for call in launches))
            self.assertTrue(any(call[1][4] == "" for call in launches), "uid 1000 runs without sudo")

    def test_timeout_is_an_error_as_in_docker(self):
        self.needs_root()

        async def body():
            env = self.make()
            await env.start(force_build=False)
            try:
                return await env.exec("sleep 5", timeout_sec=1)
            finally:
                await env.stop(delete=True)
        with self.assertRaisesRegex(RuntimeError, "timed out after 1 seconds"):
            run(body())

    def test_oversized_command_and_environment_are_staged(self):
        self.needs_root()
        big = "x" * 40_000
        many = {f"V{i}": str(i) for i in range(80)}

        async def body():
            env = self.make()
            await env.start(force_build=False)
            try:
                return await env.exec(f'echo -n {big} | wc -c; echo "$V0 $V79"', env=many)
            finally:
                await env.stop(delete=True)
        result = run(body())
        self.assertEqual(result.stdout.split(), ["40000", "0", "79"])
        for call in self.world.of("exec"):
            argv, api_env = call[1], call[3]
            self.assertLessEqual(len(argv), 128)
            self.assertTrue(all(len(part) <= 16_384 for part in argv), "every argv item fits the API")
            self.assertTrue(api_env is None or len(api_env) <= 64)
        leftovers = [s for s in self.world.machines.values()
                     if os.path.isdir(s.local("/workspace/.runtime-harbor")) and
                     os.listdir(s.local("/workspace/.runtime-harbor"))]
        self.assertEqual(leftovers, [], "staged files are removed")

    def test_files_round_trip_as_root(self):
        self.needs_root()
        source = self.dir / "tests"
        (source / "sub").mkdir(parents=True)
        (source / "test.sh").write_text("#!/bin/sh\necho ok\n")
        (source / "test.sh").chmod(0o755)
        (source / "sub" / "data.bin").write_bytes(bytes(range(256)) * 4096)
        target = tempfile.mkdtemp(prefix="harbor-target-")
        back = self.dir / "back"

        async def body():
            env = self.make()
            await env.start(force_build=False)
            try:
                await env.upload_dir(source, target + "/tests")
                await env.upload_file(source / "test.sh", target + "/single/run.sh")
                run_result = await env.exec(f"{target}/single/run.sh")
                await env.download_dir(target + "/tests", back)
                await env.download_file(target + "/single/run.sh", self.dir / "run.sh")
                with self.assertRaises(FileNotFoundError):
                    await env.download_file(target + "/missing", self.dir / "missing")
                return run_result, await env.is_dir(target + "/tests"), await env.is_file(target + "/tests/test.sh")
            finally:
                await env.stop(delete=True)
                shutil.rmtree(target, ignore_errors=True)
        run_result, is_dir, is_file = run(body())
        self.assertEqual(run_result.stdout, "ok\n", "an uploaded script keeps its mode")
        self.assertTrue(is_dir and is_file)
        self.assertIn(("upload_dir", target + "/tests", "root"), self.world.calls)
        self.assertIn(("download_dir", target + "/tests", "root"), self.world.calls)
        self.assertEqual((back / "sub" / "data.bin").read_bytes(), bytes(range(256)) * 4096)
        self.assertEqual((back / "test.sh").read_text(), "#!/bin/sh\necho ok\n")
        self.assertEqual((self.dir / "run.sh").read_text(), "#!/bin/sh\necho ok\n")

    def test_missing_sudo_is_refused_at_start_and_the_sandbox_stopped(self):
        from withruntime.harbor import MissingSudoError
        self.world.probe = ["1000", "runtime", "-", "bash"]
        with self.assertRaisesRegex(MissingSudoError, "NOPASSWD"):
            run(self.make().start(force_build=False))
        self.assertEqual(len(self.world.of("stop")), 1)
        self.assertEqual(self.world.closed, 0, "a runtime the caller passed is not closed")

    def test_trial_sizes_are_cut_to_the_trial(self):
        self.needs_root()

        async def body():
            env = self.make(funding="trial", cpus=4, memory_mb=8192, storage_mb=20480)
            await env.start(force_build=False)
            await env.stop(delete=True)
        run(body())
        fields = self.world.of("create")[0][1]
        self.assertEqual((fields["vcpu"], fields["memory_mib"], fields["disk_mib"], fields["funding"]),
                         (2, 4096, 10240, "trial"))

    def test_no_funding_on_a_trial_account_retries_at_the_trial_size(self):
        self.needs_root()
        self.world.trial = True

        async def body():
            env = self.make(cpus=4, memory_mb=8192)
            await env.start(force_build=False)
            await env.stop(delete=True)
        run(body())
        creates = [call[1] for call in self.world.of("create")]
        self.assertEqual(len(creates), 2)
        self.assertEqual((creates[1]["vcpu"], creates[1]["memory_mib"]), (2, 4096))
        self.assertNotIn("funding", creates[1])

    def test_network_policies_map_to_rules(self):
        self.needs_root()
        from harbor.models.task.config import NetworkMode, NetworkPolicy

        async def body():
            env = self.make(network_policy=NetworkPolicy(network_mode=NetworkMode.ALLOWLIST,
                                                         allowed_hosts=["pypi.org", "*.pythonhosted.org"]))
            await env.start(force_build=False)
            try:
                await env.set_network_policy(NetworkPolicy(network_mode=NetworkMode.NO_NETWORK))
            finally:
                await env.stop(delete=True)
        run(body())
        self.assertEqual(self.world.of("create")[0][1]["network"],
                         {"internet": True, "allow": ["pypi.org", "*.pythonhosted.org"]})
        self.assertEqual(self.world.of("network")[0][2:], (False, None))

    def test_ipv6_allowlists_are_refused(self):
        from harbor.models.task.config import NetworkMode, NetworkPolicy
        with self.assertRaisesRegex(ValueError, "IPv6"):
            self.make(network_policy=NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=["2001:db8::1"]))

    def test_a_compose_only_task_is_refused(self):
        (self.env_dir / "docker-compose.yaml").write_text("services:\n  main:\n    image: ubuntu\n")
        with self.assertRaisesRegex(ValueError, "Docker Compose"):
            self.make(dockerfile=None)

    def test_a_paused_sandbox_is_woken_once(self):
        self.needs_root()

        async def body():
            env = self.make()
            await env.start(force_build=False)
            try:
                env._sandbox.pause_next = True
                return await env.exec("echo awake")
            finally:
                await env.stop(delete=True)
        self.assertEqual(run(body()).stdout, "awake\n")
        self.assertEqual(len(self.world.of("wake")), 1)

    def test_harbor_loads_it_by_import_path(self):
        from harbor.environments.factory import EnvironmentFactory
        from harbor.models.task.config import EnvironmentConfig
        from harbor.models.trial.paths import TrialPaths
        (self.env_dir / "Dockerfile").write_text("FROM ubuntu:24.04\n")
        paths = TrialPaths(trial_dir=self.dir)
        env = EnvironmentFactory.create_environment_from_import_path(
            "withruntime.harbor:RuntimeEnvironment", environment_dir=self.env_dir, environment_name="t",
            session_id="t__x__env", trial_paths=paths, task_env_config=EnvironmentConfig(), funding="trial")
        self.assertEqual(env.type(), "runtime")
        self.assertEqual(env._funding, "trial")


class DockerfileWorkdirTest(unittest.TestCase):
    @unittest.skipUnless(HAVE_HARBOR, "Harbor is not installed")
    def test_last_stage_and_relative_workdirs(self):
        from withruntime.harbor import dockerfile_workdir
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "Dockerfile"
            path.write_text("FROM a AS build\nWORKDIR /src\nFROM b\nWORKDIR /app\nWORKDIR sub\n")
            self.assertEqual(dockerfile_workdir(path), "/app/sub")
            path.write_text("FROM a\nWORKDIR /x\nFROM b\n")
            self.assertIsNone(dockerfile_workdir(path))
            self.assertIsNone(dockerfile_workdir(Path(folder) / "missing"))


if __name__ == "__main__":
    unittest.main()
