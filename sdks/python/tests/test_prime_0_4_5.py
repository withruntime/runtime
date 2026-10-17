"""What prime-sandboxes 0.4.2 to 0.4.5 changed in the calls withruntime.prime
implements, read from their published wheels and sdists on 15 October 2026,
nothing installed or run (compatibility-lock.json):

- 0.4.2 and 0.4.3: filesystem checkpoints. checkpoint, get_checkpoint,
  get_checkpoints, wait_for_checkpoint, list_checkpoints, delete_checkpoint,
  delete_sandbox_checkpoints, and create(CreateSandboxRequest(checkpoint_id=...)).
  On Runtime a checkpoint is a disk-only snapshot.
- 0.4.4: a background job that cannot start fails its launch, and one that
  died without an exit code is an APIError, not "still running" forever.
- 0.4.5: LAN networks, refused with Runtime's private network as the way.

Sync and async; the background jobs run in real local shells."""
import asyncio
import os
import shlex
import signal
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from withruntime import NotFoundError  # noqa: E402
from withruntime._compat import CompatibilityError  # noqa: E402
from withruntime._errors import ConflictError  # noqa: E402
import withruntime.prime as prime  # noqa: E402
from withruntime.prime import (APIError, AsyncSandboxClient, CreateSandboxRequest, SandboxCheckpoint,  # noqa: E402
                               SandboxClient)


def snapshot(snapshot_id, source="box", state="ready", mode="disk", created="2026-10-15T10:00:00.000Z", **extra):
    """A snapshot as Runtime's API answers it."""
    return {"id": snapshot_id, "kind": "snapshot", "mode": mode, "state": state, "sourceSandboxId": source,
            "shape": {"vcpu": 2, "memoryMiB": 2048, "diskMiB": 8192}, "storedBytes": 4096, "error": None,
            "labels": {"compat.provider": "prime", "compat.image": "python:3.12-slim"},
            "createdAt": created, "readyAt": None if state == "capturing" else created, "expiresAt": None, **extra}


class Runtime:
    """The withruntime calls the checkpoint methods make, recorded."""

    def __init__(self):
        self.calls, self.store = [], {}
        runtime = self
        self.box = SimpleNamespace(id="box", state="running",
                                   info={"labels": {"compat.provider": "prime", "compat.image": "python:3.12-slim"}})

        def take(**options):
            runtime.calls.append(("sandbox.snapshot", options))
            value = snapshot("snap-new", labels=options["labels"])
            runtime.store[value["id"]] = value
            return value
        self.box.snapshot = take

        def get(sandbox_id):
            runtime.calls.append(("sandboxes.get", sandbox_id))
            if sandbox_id != "box":
                raise NotFoundError("No such sandbox.", code="not_found", status=404)
            return self.box

        def create(**fields):
            runtime.calls.append(("sandboxes.create", fields))
            return SimpleNamespace(id="restored", state="running", info={"labels": fields["labels"], "vcpu": fields["vcpu"],
                                   "memoryMiB": fields["memory_mib"], "diskMiB": 8192, "name": fields["name"]},
                                   files=SimpleNamespace(write=lambda *args, **kwargs: None))

        def build(**fields):
            runtime.calls.append(("images.build", fields))
            return {"id": "image"}
        self.sandboxes = SimpleNamespace(get=get, create=create)
        self.images = SimpleNamespace(build=build)
        self.snapshots = SimpleNamespace(get=self._get, list=self._list, delete=self._delete)
        self.conflicts = set()

    def _get(self, snapshot_id):
        self.calls.append(("snapshots.get", snapshot_id))
        if snapshot_id not in self.store:
            raise NotFoundError("No such snapshot.", code="not_found", status=404)
        return self.store[snapshot_id]

    def _list(self, **query):
        self.calls.append(("snapshots.list", query))
        return [one for one in self.store.values() if one["sourceSandboxId"] == query.get("sandbox_id")]

    def _delete(self, snapshot_id):
        self.calls.append(("snapshots.delete", snapshot_id))
        if snapshot_id in self.conflicts:
            raise ConflictError("The snapshot is being captured.", code="snapshot_busy", status=409)
        if snapshot_id not in self.store:
            raise NotFoundError("No such snapshot.", code="not_found", status=404)
        self.store.pop(snapshot_id)

    def made(self, name):
        return [call[1] for call in self.calls if call[0] == name]


class Async:
    """The same fake as AsyncRuntime's shape: coroutines, async pages."""

    def __init__(self, target):
        self._target = target

    def __getattr__(self, name):
        value = getattr(self._target, name)
        if isinstance(value, SimpleNamespace):
            return Async(value)
        if not callable(value):
            return value

        async def call(*args, **kwargs):
            result = value(*args, **kwargs)
            if isinstance(result, list):
                return Page(result)
            return Async(result) if isinstance(result, SimpleNamespace) else result
        return call


class Page:
    def __init__(self, items):
        self._items = items

    async def __aiter__(self):
        for item in self._items:
            yield item


class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.runtime = Runtime()
        self.sdk = SandboxClient(self.runtime)

    def test_checkpoint_is_a_durable_disk_snapshot_of_the_sandbox(self):
        checkpoint = self.sdk.checkpoint("box")
        self.assertEqual(self.runtime.made("sandbox.snapshot"), [{"mode": "disk", "labels": {
            "compat.provider": "prime", "compat.image": "python:3.12-slim"}}])
        self.assertIsInstance(checkpoint, SandboxCheckpoint)
        self.assertEqual((checkpoint.id, checkpoint.sandbox_id, checkpoint.state, checkpoint.docker_image,
                          checkpoint.parent_id, checkpoint.depth, checkpoint.disk_size_bytes, checkpoint.stored_bytes),
                         ("snap-new", "box", "DURABLE", "python:3.12-slim", None, 1, 8192 * 1024 * 1024, 4096))
        self.assertEqual(self.sdk.get_checkpoint("snap-new").id, "snap-new")
        self.assertEqual(self.sdk.wait_for_checkpoint("snap-new").state, "DURABLE")

    def test_checkpoint_refuses_a_whole_machine_snapshot(self):
        self.runtime.box.snapshot = lambda **options: snapshot("memory", mode="memory")
        with self.assertRaises(CompatibilityError):
            self.sdk.checkpoint("box")

    def test_states_batches_and_waits(self):
        self.runtime.store.update(a=snapshot("a", state="capturing"), b=snapshot("b", state="failed", error="disk full"))
        self.assertEqual(self.sdk.get_checkpoint("a").state, "PENDING")
        batch = self.sdk.get_checkpoints(["a", "missing"])
        self.assertEqual([one.id for one in batch.checkpoints], ["a"])
        self.assertEqual([(one.checkpoint_id, one.code) for one in batch.errors], [("missing", "NOT_FOUND")])
        for ids in ([], ["a", "a"], [str(n) for n in range(101)], ["x" * 65], [""]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                self.sdk.get_checkpoints(ids)
        with self.assertRaisesRegex(RuntimeError, "state=FAILED.*disk full"):
            self.sdk.wait_for_checkpoint("b")
        with patch("withruntime.prime._sync.time.sleep"), self.assertRaises(TimeoutError):
            self.sdk.wait_for_checkpoint("a", timeout_seconds=0.01)
        for timeout in (0, -1, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                self.sdk.wait_for_checkpoint("a", timeout_seconds=timeout)
        with self.assertRaises(APIError):
            self.sdk.get_checkpoint("missing")

    def test_list_is_the_sandboxs_disk_checkpoints_oldest_first(self):
        self.runtime.store.update(
            late=snapshot("late", created="2026-10-15T12:00:00.000Z"),
            early=snapshot("early", created="2026-10-15T09:00:00.000Z"),
            memory=snapshot("memory", mode="memory"),
            other=snapshot("other", source="elsewhere"))
        self.assertEqual([one.id for one in self.sdk.list_checkpoints("box")], ["early", "late"])
        self.assertEqual([one.id for one in self.sdk.list_checkpoints("box", "late")], ["late"])
        with self.assertRaises(APIError):
            self.sdk.list_checkpoints("missing")

    def test_delete_one_and_all_with_per_checkpoint_conflicts(self):
        self.runtime.store.update(a=snapshot("a"), b=snapshot("b"), c=snapshot("c"))
        self.assertIsNone(self.sdk.delete_checkpoint("a"))
        self.assertNotIn("a", self.runtime.store)
        self.runtime.conflicts.add("c")
        result = self.sdk.delete_sandbox_checkpoints("box")
        self.assertEqual(result.deleted, ["b"])
        self.assertEqual([(one.checkpoint_id, one.code) for one in result.errors], [("c", "CONFLICT")])
        with self.assertRaises(APIError):
            self.sdk.delete_checkpoint("a")

    def test_create_restores_a_checkpoint_without_building_an_image(self):
        self.runtime.store["snap"] = snapshot("snap")
        box = self.sdk.create(CreateSandboxRequest(name="restored", checkpoint_id="snap", cpu_cores=2, memory_gb=2))
        fields = self.runtime.made("sandboxes.create")[0]
        self.assertEqual(fields["snapshot"], "snap")
        self.assertEqual((fields["vcpu"], fields["memory_mib"]), (2, 2048))
        self.assertNotIn("image", fields)
        self.assertNotIn("disk_mib", fields)
        self.assertEqual(fields["labels"]["compat.image"], "python:3.12-slim")
        self.assertEqual(self.runtime.made("images.build"), [])
        self.assertEqual(box.docker_image, "python:3.12-slim")
        self.runtime.store["memory"] = snapshot("memory", mode="memory")
        with self.assertRaises(CompatibilityError):
            self.sdk.create(CreateSandboxRequest(name="m", checkpoint_id="memory"))
        self.assertEqual(len(self.runtime.made("sandboxes.create")), 1)

    def test_restore_request_validation(self):
        self.assertEqual(CreateSandboxRequest(name="n", docker_image="python:3.12").disk_size_gb, 5.0)
        self.assertIsNone(CreateSandboxRequest(name="n", checkpoint_id="c").disk_size_gb)
        for fields in ({"checkpoint_id": "c", "docker_image": "python:3.12"}, {"checkpoint_id": "c", "disk_size_gb": 10}):
            with self.subTest(fields=fields), self.assertRaisesRegex(ValueError, "omit docker_image"):
                CreateSandboxRequest(name="n", **fields)
        with self.assertRaisesRegex(ValueError, "docker_image is required"):
            CreateSandboxRequest(name="n")
        with self.assertRaises(ValueError):
            CreateSandboxRequest(name="n", checkpoint_id="x" * 65)

    def test_async_client_follows_the_same_calls(self):
        self.runtime.store.update(old=snapshot("old", created="2026-10-15T09:00:00.000Z"))

        async def run():
            sdk = AsyncSandboxClient(runtime=Async(self.runtime))
            made = await sdk.checkpoint("box")
            self.assertEqual(made.state, "DURABLE")
            self.assertEqual((await sdk.wait_for_checkpoint(made.id)).id, made.id)
            self.assertEqual([one.id for one in await sdk.list_checkpoints("box")], ["old", "snap-new"])
            self.assertEqual((await sdk.get_checkpoints(["old"])).checkpoints[0].id, "old")
            restored = await sdk.create(CreateSandboxRequest(name="r", checkpoint_id="snap-new"))
            self.assertEqual((restored.id, self.runtime.made("sandboxes.create")[0]["snapshot"]), ("restored", "snap-new"))
            await sdk.delete_checkpoint("old")
            self.assertEqual((await sdk.delete_sandbox_checkpoints("box")).deleted, ["snap-new"])
        asyncio.run(run())


class LanNetworks(unittest.TestCase):
    def test_every_lan_call_refuses_before_any_request(self):
        runtime = Runtime()
        sdk = SandboxClient(runtime)
        calls = (("create_lan_network", ("lan",)), ("list_lan_networks", ()), ("get_lan_network", ("n",)),
                 ("delete_lan_network", ("n",)), ("set_lan_rules", ("n", [])), ("add_lan_member", ("n", "box")),
                 ("remove_lan_member", ("n", "box")))
        for name, args in calls:
            with self.subTest(name=name), self.assertRaisesRegex(CompatibilityError, "networks.private"):
                getattr(sdk, name)(*args)

        async def run():
            client = AsyncSandboxClient(runtime=Async(runtime))
            for name, args in calls:
                with self.subTest(mode="async", name=name), self.assertRaises(CompatibilityError):
                    await getattr(client, name)(*args)
        asyncio.run(run())
        self.assertEqual(runtime.calls, [])
        for name in ("LanNetwork", "LanNetworkMember", "LanRule"):
            with self.subTest(model=name), self.assertRaisesRegex(Exception, "networks.private"):
                getattr(prime, name)(name="lan")


class BackgroundJobs(unittest.TestCase):
    """Real shells: the job script, its launch check and its status check."""

    def setUp(self):
        from test_compat_python_processes import LocalFiles, LocalSandbox
        self.box = LocalSandbox()
        self.box.files = LocalFiles()
        native = SimpleNamespace(sandboxes=SimpleNamespace(get=lambda _: self.box))
        self.sdk = SandboxClient(native)
        self.sdk._environment = lambda box, extra=None: {**os.environ, **(extra or {})}
        self.paths = []

    def tearDown(self):
        for path in self.paths:
            if os.path.isdir(path):
                os.rmdir(path)
            elif os.path.lexists(path):
                os.unlink(path)

    def job(self, command, **options):
        job = self.sdk.start_background_job(self.box.id, command, **options)
        root = "/tmp/job_" + job.job_id
        self.paths += [job.stdout_log_file, job.stderr_log_file, job.exit_file, root + ".pid"]
        return job

    def finished(self, job):
        deadline = time.monotonic() + 5
        while not (status := self.sdk.get_background_job_status(self.box.id, job)).completed:
            if time.monotonic() > deadline:
                self.fail("background job did not finish")
            time.sleep(.02)
        return status

    def test_a_running_job_reads_as_running_and_a_finished_one_as_its_code(self):
        job = self.job(shlex.join([sys.executable, "-c", "import time; time.sleep(.3)"]))
        self.assertFalse(self.sdk.get_background_job_status(self.box.id, job).completed)
        self.assertEqual(self.finished(job).exit_code, 0)
        # 0.4.2: a working directory that cannot be entered ends the job with 1.
        self.assertEqual(self.finished(self.job("true", working_dir="/no/such/dir")).exit_code, 1)

    def test_a_job_that_died_without_an_exit_code_is_an_error(self):
        job = self.job("sleep 30")
        pid = int(Path("/tmp/job_" + job.job_id + ".pid").read_text())
        os.killpg(pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while Path(f"/proc/{pid}/cmdline").exists() and Path(f"/proc/{pid}/cmdline").read_bytes():
            if time.monotonic() > deadline:
                self.fail("the job's shell did not die")
            time.sleep(.02)
        with self.assertRaisesRegex(APIError, "exited without recording an exit code"):
            self.sdk.get_background_job_status(self.box.id, job)
        with self.assertRaises(APIError):
            self.sdk.get_background_job(self.box.id, job)

    def test_an_empty_exit_file_is_not_an_exit_code(self):
        job = self.job("sleep 30")
        Path(job.exit_file).write_text("")
        try:
            self.assertFalse(self.sdk.get_background_job_status(self.box.id, job).completed)
        finally:
            os.killpg(int(Path("/tmp/job_" + job.job_id + ".pid").read_text()), signal.SIGKILL)

    def test_a_job_that_cannot_start_fails_its_launch(self):
        job_id = os.urandom(4).hex()
        os.mkdir(f"/tmp/job_{job_id}.pid")
        self.paths += [f"/tmp/job_{job_id}.pid", f"/tmp/job_{job_id}.exit"]
        with patch("withruntime.prime._sync.uuid.uuid4", return_value=SimpleNamespace(hex=job_id + "0" * 24)):
            with self.assertRaisesRegex(APIError, f"Failed to launch background job {job_id}"):
                self.sdk.start_background_job(self.box.id, "touch /tmp/job_" + job_id + ".ran")
        time.sleep(.1)
        self.assertFalse(os.path.exists(f"/tmp/job_{job_id}.ran"))


if __name__ == "__main__":
    unittest.main()
