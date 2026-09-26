"""withruntime.inspect_ai: Inspect's own portable sandbox checks
(inspect_ai.util._sandbox.self_check) and the adapter's lifecycle, driven
against the fake Runtime in tests/test_harbor.py, whose sandbox is a temporary
directory on this machine with commands really run.

The checks that need something the fake cannot give are listed in XFAIL and
SKIP with the reason. The live run of the same checks against a real sandbox
is scripts/inspect_e2e.py.

Skipped when Inspect AI is not installed (pip install "withruntime[inspect-ai]"),
except the checks on the source and the package metadata, which always run."""
import asyncio
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    import inspect_ai  # noqa: F401
    HAVE_INSPECT = True
except ImportError:
    HAVE_INSPECT = False

try:
    from tests.test_harbor import MODE, FakeRuntime
except ImportError:  # run from inside tests/
    from test_harbor import MODE, FakeRuntime

PACKAGE = Path(__file__).resolve().parent.parent

# Checks the fake cannot pass, and why. Commands run as root by default, as in Inspect's Docker sandbox.
XFAIL = {
    "test_read_file_not_allowed": "root reads a file whatever its mode",
    "test_write_text_file_without_permissions": "root writes a file whatever its mode",
    "test_write_binary_file_without_permissions": "root writes a file whatever its mode",
}
if MODE == "root":
    XFAIL["test_exec_as_nonexistent_user"] = "running as root with no sudo, another user is refused before it runs"
# Checks that would change this machine rather than a sandbox.
SKIP = {
    "test_exec_as_user": "adds and deletes a user account on the machine running the test",
}


class SourceTest(unittest.TestCase):
    def test_image_tags_follow_the_builder_version(self):
        """An image built by an older builder must not be reused (runtime-builder/3 added sudo)."""
        builder = PACKAGE.parent.parent / "packages" / "cloud" / "deploy" / "image-build" / "builder" / "build-agent.py"
        if not builder.exists():
            self.skipTest("the image builder is not in this checkout")
        version = re.search(r"^VERSION = '([^']+)'", builder.read_text(), re.M)
        self.assertIsNotNone(version)
        source = (PACKAGE / "withruntime" / "_eval_sandbox.py").read_text()
        self.assertIn(f'IMAGE_RECIPE = "{version.group(1)}"', source,
                      "the image builder's version changed: change IMAGE_RECIPE in withruntime/_eval_sandbox.py")

    def test_the_package_registers_the_sandbox_and_both_extras(self):
        text = (PACKAGE / "pyproject.toml").read_text()
        self.assertRegex(text, r'\[project\.entry-points\.inspect_ai\]\s*\nwithruntime = "withruntime\.inspect_ai"')
        self.assertRegex(text, r'\nharbor = \["harbor>=')
        self.assertRegex(text, r'\ninspect-ai = \["inspect-ai>=')


def run(coroutine):
    return asyncio.run(coroutine)


@unittest.skipUnless(HAVE_INSPECT, "Inspect AI is not installed")
class InspectSandboxTest(unittest.TestCase):
    def setUp(self):
        import withruntime.inspect_ai as adapter
        self.adapter = adapter
        self.world = FakeRuntime(MODE or "nosudo")
        patcher = mock.patch.object(adapter, "_client", lambda: self.world)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.world.cleanup)
        self.dir = Path(tempfile.mkdtemp(prefix="inspect-task-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def needs_root(self):
        if MODE is None:
            self.skipTest("root commands need passwordless sudo or root on this machine")

    def sample(self, config=None):
        cls = self.adapter.RuntimeSandboxEnvironment
        return run(cls.sample_init("task", config, {}))

    def cleanup(self, environments):
        run(self.adapter.RuntimeSandboxEnvironment.sample_cleanup("task", None, environments, False))

    def test_inspects_own_sandbox_checks(self):
        self.needs_root()
        from inspect_ai.util._sandbox import self_check
        environments = self.sample()
        sandbox = environments["default"]
        try:
            for name in self_check.__all__:
                with self.subTest(check=name):
                    if name in SKIP:
                        continue
                    check = getattr(self_check, name)
                    if name in XFAIL:
                        with self.assertRaises(Exception, msg=f"{name} now passes: {XFAIL[name]}?"):
                            run(check(sandbox))
                    else:
                        run(check(sandbox))
        finally:
            self.cleanup(environments)
        self.assertEqual(len(self.world.of("stop")), 1)

    def test_the_base_image_runs_as_root_in_workspace(self):
        self.needs_root()
        environments = self.sample()
        try:
            sandbox = environments["default"]
            result = run(sandbox.exec(["sh", "-c", "id -u; pwd"]))
            connection = run(sandbox.connection())
        finally:
            self.cleanup(environments)
        uid, cwd = result.stdout.split()
        self.assertEqual(uid, "0")
        self.assertTrue(cwd.endswith("/workspace"), cwd)
        self.assertEqual(connection.command, f"runtime sandbox ssh {sandbox.sandbox.id}")
        create = self.world.of("create")[0][1]
        self.assertNotIn("image", create)
        self.assertEqual(create["labels"]["created_by"], "inspect-ai")
        self.assertEqual(create["idle_pause_seconds"], 0)
        self.assertEqual(self.world.of("build"), [])

    def test_a_dockerfile_is_built_once_and_its_workdir_used(self):
        self.needs_root()
        (self.dir / "Dockerfile").write_text("FROM python:3.12-slim\nWORKDIR /workspace/app\nCOPY . .\n")
        (self.dir / "data.txt").write_text("hello\n")
        cls = self.adapter.RuntimeSandboxEnvironment
        run(cls.task_init("task", str(self.dir / "Dockerfile")))
        environments = self.sample(str(self.dir / "Dockerfile"))
        try:
            pwd = run(environments["default"].exec(["pwd"])).stdout
        finally:
            self.cleanup(environments)
        builds = self.world.of("build")
        self.assertEqual(len(builds), 1, "sample_init reuses what task_init built")
        self.assertEqual(builds[0][1]["context_dir"], str(self.dir))
        self.assertTrue(builds[0][1]["name"].startswith("inspect-"))
        self.assertTrue(pwd.strip().endswith("/workspace/app"), pwd)
        (self.dir / "data.txt").write_text("changed\n")
        run(cls.task_init("task", str(self.dir / "Dockerfile")))
        self.assertEqual(len(self.world.of("build")), 2, "a changed build context builds again")

    def test_one_compose_service_maps_to_the_sandbox(self):
        self.needs_root()
        compose = self.dir / "compose.yaml"
        compose.write_text(
            "services:\n  default:\n    image: python:3.12-slim\n    cpus: 1.5\n    mem_limit: 2g\n"
            "    working_dir: /workspace/app\n    environment:\n      GREETING: hi\n    network_mode: none\n"
            "    x-runtime:\n      funding: trial\n")
        environments = self.sample(str(compose))
        try:
            result = run(environments["default"].exec(["sh", "-c", 'echo "$GREETING"; pwd']))
        finally:
            self.cleanup(environments)
        self.assertEqual(result.stdout.split()[0], "hi")
        self.assertTrue(result.stdout.split()[1].endswith("/workspace/app"))
        self.assertEqual(self.world.of("build")[0][1]["image"], "python:3.12-slim")
        create = self.world.of("create")[0][1]
        self.assertEqual((create["vcpu"], create["memory_mib"], create["funding"]), (2, 2048, "trial"))
        self.assertEqual(create["network"], {"internet": False})

    def test_several_compose_services_are_refused(self):
        compose = self.dir / "compose.yaml"
        compose.write_text("services:\n  default:\n    image: ubuntu\n  db:\n    image: postgres\n")
        with self.assertRaisesRegex(ValueError, "one machine per sample"):
            self.sample(str(compose))
        self.assertEqual(self.world.of("create"), [])

    def test_output_past_the_limit_raises(self):
        self.needs_root()
        from inspect_ai.util import OutputLimitExceededError
        from inspect_ai.util._sandbox.limits import override_max_exec_output_size
        environments = self.sample()
        try:
            with override_max_exec_output_size(1000):
                with self.assertRaises(OutputLimitExceededError) as caught:
                    run(environments["default"].exec(["sh", "-c", "head -c 5000 /dev/zero | tr '\\0' a"]))
        finally:
            self.cleanup(environments)
        self.assertEqual(len(caught.exception.truncated_output), 1000)

    def test_missing_sudo_is_refused_and_the_sandbox_stopped(self):
        from withruntime.inspect_ai import MissingSudoError
        self.world.probe = ["1000", "runtime", "-", "bash"]
        with self.assertRaisesRegex(MissingSudoError, "passwordless sudo"):
            self.sample()
        self.assertEqual(len(self.world.of("stop")), 1)

    def test_a_stopped_sandbox_is_unavailable(self):
        self.needs_root()
        from inspect_ai.util._sandbox.environment import SandboxUnavailableError
        environments = self.sample()
        self.cleanup(environments)
        with self.assertRaises(SandboxUnavailableError):
            run(environments["default"].exec(["true"]))

    def test_task_cleanup_stops_what_the_run_left(self):
        self.needs_root()
        cls = self.adapter.RuntimeSandboxEnvironment

        async def body():
            await cls.task_init("task", None)
            await cls.sample_init("task", None, {})
            await cls.sample_init("task", None, {})
            await cls.task_cleanup("task", None, True)
        run(body())
        self.assertEqual(len(self.world.of("stop")), 2)
        self.assertTrue(all(s.state == "stopped" for s in self.world.machines.values()))

    def test_config_round_trips_and_hashes(self):
        cls = self.adapter.RuntimeSandboxEnvironment
        config = self.adapter.RuntimeSandboxEnvironmentConfig(image="python:3.12-slim", env={"A": "1"}, vcpu=2)
        self.assertEqual(cls.config_deserialize(config.model_dump()), config)
        self.assertEqual(hash(config), hash(cls.config_deserialize(config.model_dump())))
        with self.assertRaisesRegex(ValueError, "not image and dockerfile"):
            self.sample(self.adapter.RuntimeSandboxEnvironmentConfig(image="a", dockerfile="b/Dockerfile"))

    def test_it_is_registered_as_runtime(self):
        from inspect_ai.util._sandbox.registry import registry_find_sandboxenv
        self.assertIs(registry_find_sandboxenv("runtime"), self.adapter.RuntimeSandboxEnvironment)


if __name__ == "__main__":
    unittest.main()
