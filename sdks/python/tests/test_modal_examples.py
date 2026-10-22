"""What running Modal's own documented sandbox examples (modal.com/docs/guide/
sandbox*, modal-examples' 13_sandboxes) against real Runtime sandboxes found,
18 October 2026: each test here failed on the drop-in before.
packages/cloud-sdk/scripts/compatibility-modal-examples-live.ts runs the
examples themselves (tests/fixtures/modal)."""
import asyncio
import io
from pathlib import Path
import sys
import time
import traceback
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from test_modal_dropin import World  # noqa: E402
from dropin_fake import DropInImages  # noqa: E402
import withruntime  # noqa: E402
from withruntime._compat import CompatibilityError  # noqa: E402
import withruntime.modal as modal  # noqa: E402
from withruntime.modal import Image, Probe, Sandbox  # noqa: E402
from withruntime.modal._fs_common import entry  # noqa: E402
from withruntime.modal.exception import AlreadyExistsError  # noqa: E402


class ModalExamples(World):
    def test_processes_run_as_root_as_in_a_modal_container(self):
        # guide/sandbox-snapshots: `echo 'test' > /test`; guide/sandboxes: dockerd.
        box = Sandbox.create("sleep", "100", readiness_probe=Probe.with_exec("true"), client=self.client)
        box.exec("bash", "-c", "echo 'test' > /test")
        box.wait_until_ready()
        self.assertEqual([call[1]["user"] for call in self.world.called("sandbox.spawn")], ["root", "root"])
        probes = [call for call in self.world.called("sandbox.exec") if call[0] == ["true"]]
        self.assertEqual([call[1]["user"] for call in probes], ["root"])
        asyncio.run(self._async_root())

    async def _async_root(self):
        before = len(self.world.called("sandbox.spawn"))
        box = await Sandbox.create.aio("sleep", "100", client=self.world.async_client())
        await box.exec.aio("ls")
        self.assertEqual([call[1]["user"] for call in self.world.called("sandbox.spawn")[before:]],
                         ["root", "root"])

    def test_idle_timeout_pauses_the_idle_sandbox(self):
        Sandbox.create(idle_timeout=30, client=self.client)
        Sandbox.create(idle_timeout=5, timeout=600, client=self.client)
        made = [call[0] for call in self.world.called("sandboxes.create")]
        self.assertEqual(made[0]["idle_pause_seconds"], 30)
        self.assertNotIn("timeout_seconds", made[0])
        self.assertEqual((made[1]["timeout_seconds"], made[1]["idle_pause_seconds"]), (600, 10))

    def test_a_timeout_under_a_minute_ends_the_sandbox_on_time(self):
        # guide/sandboxes "Running a Sandbox with an entrypoint": timeout=10.
        box = Sandbox.create("python", "-m", "http.server", "8080", timeout=1, client=self.client)
        self.assertEqual(self.world.called("sandboxes.create")[0][0]["timeout_seconds"], 60)
        stops = len(self.world.called("sandbox.stop"))
        time.sleep(1.3)
        self.assertGreater(len(self.world.called("sandbox.stop")), stops)
        self.assertTrue(box._terminated)

    def test_a_taken_name_is_already_exists_error(self):
        taken = withruntime.ConflictError("Sandbox x is already named 'my-name'.", code="name_taken", status=409)
        with patch.object(type(self.client.sandboxes), "create", side_effect=taken):
            with self.assertRaises(AlreadyExistsError):
                Sandbox.create(name="my-name", client=self.client)

    def test_cidr_allowlists_are_rules_and_the_policy_can_be_replaced(self):
        box = Sandbox.create("sleep", "infinity", outbound_cidr_allowlist=["52.0.0.0/8", "10.0.1.0/24"],
                             client=self.client)
        self.assertEqual(self.world.called("sandboxes.create")[0][0]["network"],
                         {"internet": True, "allow": ["52.0.0.0/8", "10.0.1.0/24"]})
        box._experimental_set_outbound_network_policy(outbound_domain_allowlist=["api.openai.com", "*.github.com"])
        box._experimental_set_outbound_network_policy(outbound_domain_allowlist=[], outbound_cidr_allowlist=[])
        box._experimental_set_outbound_network_policy(outbound_domain_allowlist=["*"],
                                                      outbound_cidr_allowlist=["0.0.0.0/0"])
        self.assertEqual([call[1] for call in self.world.called("network.set")], [
            {"internet": True, "allow": ["api.openai.com", "*.github.com", "github.com"]},
            {"internet": False}, {"internet": True, "allow": ["0.0.0.0/0"]}])

    def test_a_listing_entry_has_its_modified_time(self):
        # guide/sandbox-files: list_files read mtimeMs, which listings never send.
        listed = entry({"name": "answer.txt", "path": "/tmp/project/results/answer.txt", "type": "file", "size": 3,
                        "mode": "644", "modifiedAt": "2026-10-18T19:00:00.000Z", "owner": "root", "group": "root"})
        self.assertEqual(listed.modified_time, 1792350000.0)
        self.assertEqual(entry({"name": "a", "path": "/a", "type": "file", "size": 0, "mode": 0o644,
                                "mtimeMs": 1500, "owner": "u", "group": "g"}).modified_time, 1.5)

    def test_stream_types_pipe_print_or_drop_output(self):
        from withruntime.modal.stream_type import StreamType
        box = Sandbox.create(client=self.client)
        self.assertEqual(box.exec("echo", "foo", stdout=StreamType.PIPE).stdout.read(), "ran ['echo', 'foo']\n")
        dropped = box.exec("echo", "foo", stdout=StreamType.DEVNULL)
        dropped.wait()
        self.assertEqual(dropped.stdout.read(), "")
        shown = io.TextIOWrapper(io.BytesIO(), write_through=True)
        with patch.object(sys, "stdout", shown):
            box.exec("echo", "foo", stdout=StreamType.STDOUT).wait()
        self.assertEqual(shown.buffer.getvalue(), b"ran ['echo', 'foo']\n")

    def test_modals_modules_and_enable_output(self):
        # modal-examples: `from modal.container_process import ContainerProcess`,
        # `modal.io_streams.StreamWriter`, `with modal.enable_output():`.
        from withruntime.modal.container_process import ContainerProcess
        self.assertIs(ContainerProcess, modal.ContainerProcess)
        self.assertTrue(modal.io_streams.StreamWriter and modal.io_streams.StreamReader)
        original = DropInImages.build

        def build(images, on_log=None, **fields):
            if on_log:
                on_log({"seq": 1, "text": "Step 1/2 : FROM python:3.12-slim"})
            return original(images, **fields)
        printed = io.StringIO()
        with patch.object(DropInImages, "build", build), patch.object(sys, "stdout", printed):
            Sandbox.create(image=Image.debian_slim().pip_install("pandas"), client=self.client)
            with modal.enable_output():
                Sandbox.create(image=Image.debian_slim().pip_install("numpy"), client=self.client)
        self.assertEqual(printed.getvalue(), "Step 1/2 : FROM python:3.12-slim\n")

    def test_memory_snapshots_restore_the_running_entrypoint(self):
        # guide/sandbox-snapshots "Memory Snapshots": refused before as an unknown flag.
        box = Sandbox.create("python3", "-m", "http.server", "8000", _experimental_enable_snapshot=True,
                             client=self.client)
        snapshot = box._experimental_snapshot()
        taken = self.world.called("sandbox.snapshot")[-1][1]
        self.assertEqual(taken["mode"], "memory")
        self.assertEqual(taken["labels"]["modal.entrypoint"], box._entrypoint._process.id)
        saved = {"id": snapshot.object_id, "mode": "memory", "labels": taken["labels"]}
        running = box._sandbox.process(box._entrypoint._process.id)
        with patch.object(type(self.client.snapshots), "get", return_value=saved), \
                patch.object(type(box._sandbox), "process", lambda _, process_id: running):
            restored = Sandbox._experimental_from_snapshot(snapshot, client=self.client)
        made = self.world.called("sandboxes.create")[-1][0]
        with patch.object(type(self.client.snapshots), "get", return_value={**saved, "mode": "disk"}):
            with self.assertRaises(modal.exception.InvalidError):
                Sandbox._experimental_from_snapshot(snapshot, client=self.client)
        self.assertEqual(made["snapshot"], snapshot.object_id)
        self.assertEqual(made["labels"]["modal.app"], taken["labels"]["modal.app"])
        self.assertIsNotNone(restored._entrypoint)

    def test_a_published_image_is_a_runtime_image_name(self):
        # guide/sandboxes "Building and publishing images":
        # image.build(app=app).publish("sandbox-runtime"), then Image.from_name.
        image = Image.debian_slim().pip_install("pandas")
        image.publish("sandbox-runtime", client=self.client)
        image.publish("sandbox-runtime:v2", client=self.client)
        asyncio.run(image.publish.aio("sandbox-runtime:v3", client=self.world.async_client()))
        builds = [call[0] for call in self.world.called("images.build")]
        self.assertEqual([(b.get("name"), b.get("tags")) for b in builds],
                         [("sandbox-runtime", ["latest"]), ("sandbox-runtime", ["v2"]), ("sandbox-runtime", ["v3"])])
        self.assertTrue(all(b["dockerfile"] == builds[0]["dockerfile"] for b in builds))
        for bad in (lambda: image.publish("x", environment_name="dev", client=self.client),
                    lambda: Image.from_name("other").publish("x", client=self.client)):
            with self.assertRaises(CompatibilityError):
                bad()

    def test_sidecars_refuse_naming_runtimes_alternative(self):
        # modal-examples sidecar_redis: `sandbox._experimental_sidecars.create(...)`
        # was an AttributeError naming nothing to do instead.
        box = Sandbox.create("sleep", "infinity", client=self.client)
        with self.assertRaises(CompatibilityError) as raised:
            box._experimental_sidecars.create(modal.Image.from_registry("redis:7"), "redis-server")
        self.assertIn("private network", str(raised.exception))

    def test_modals_other_objects_refuse_by_name(self):
        # guide/sandbox-snapshots: modal.Dict; modal-examples: modal.Server.
        for name in ("Dict", "Queue", "Function", "Server", "fastapi_endpoint"):
            with self.assertRaises(CompatibilityError) as raised:
                getattr(modal, name)
            self.assertIn("Runtime", str(raised.exception))
            # A traceback names it as every other refusal is named.
            shown = traceback.format_exception_only(type(raised.exception), raised.exception)[-1]
            self.assertTrue(shown.startswith(f"withruntime._compat.CompatibilityError: modal.{name} is not"), shown)
            self.assertFalse(hasattr(modal, name))
        with self.assertRaises(AttributeError):
            modal.not_a_modal_name


if __name__ == "__main__":
    unittest.main()
