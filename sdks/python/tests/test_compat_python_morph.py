"""withruntime.morph against a fake Runtime client: the calls Morph's
``morphcloud`` 0.1.115 makes, what each sends to Runtime, and what each
answers. The live run is packages/cloud-sdk/scripts/compatibility-morph-python-live.py."""
import asyncio
import builtins
import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))
from withruntime._compat import CompatibilityError  # noqa: E402
from withruntime._errors import NotFoundError  # noqa: E402
from withruntime.morph import MorphCloudClient  # noqa: E402
from withruntime.morph import api as morph  # noqa: E402
from withruntime.morph.api import (ApiError, Instance, InstanceStatus, Snapshot, SnapshotStatus,  # noqa: E402
                                   UserAPI)


class Result:
    def __init__(self, exit_code, stdout="", stderr="", timed_out=False):
        self.exit_code, self.stdout, self.stderr, self.timed_out = exit_code, stdout, stderr, timed_out


class World:
    def __init__(self):
        self.calls, self.sandboxes, self.snapshots, self.files = [], {}, {}, {}
        self.count = 0

    def record(self, *call):
        self.calls.append(call)

    def called(self, name):
        return [call[1:] for call in self.calls if call[0] == name]

    def new_id(self, prefix):
        self.count += 1
        return f"{prefix}{self.count}"

    def add_snapshot(self, sandbox, name=None, labels=None, mode="memory", retention_days=None):
        record = {"id": self.new_id("snap"), "name": name, "labels": dict(labels or {}), "state": "ready",
                  "mode": mode, "shape": {"vcpu": sandbox.info["vcpu"], "memoryMiB": sandbox.info["memoryMiB"],
                                          "diskMiB": sandbox.info["diskMiB"]},
                  "retentionDays": retention_days, "expiresAt": None, "createdAt": "2026-10-15T12:00:00Z",
                  "sourceSandboxId": sandbox.id}
        self.snapshots[record["id"]] = record
        return record


class Transport:
    base_url = "https://api.withruntime.com"

    def __init__(self, world):
        self.world = world

    def json(self, method, path, body=None, wait=None):
        self.world.record("fork", path, body)
        source = self.world.sandboxes[path.split("/")[-1].split(":")[0]]
        snapshot = self.world.add_snapshot(source, labels=source.info["labels"])
        copies = []
        for _ in range(body["count"]):
            copy = FakeSandbox(self.world, {**source.info, "snapshotId": snapshot["id"]})
            copies.append(copy.info)
        return {"sandboxes": copies, "snapshot": snapshot}


class Files:
    def __init__(self, world, sandbox):
        self.world, self.sandbox = world, sandbox

    def upload(self, local, remote):
        self.world.record("files.upload", local, remote)
        self.world.files[remote] = Path(local).read_bytes() if os.path.isfile(local) else "dir"

    def stat(self, path):
        value = self.world.files.get(path)
        return {"exists": value is not None, "type": "directory" if value == "dir" else "file"}

    def download(self, remote, local):
        self.world.record("files.download", remote, local)
        Path(local).write_bytes(self.world.files[remote])


class Previews:
    def __init__(self, world, sandbox):
        self.world, self.sandbox, self.shared = world, sandbox, {}

    def create(self, port, visibility=None):
        self.world.record("previews.create", port, visibility)
        self.shared[port] = {"port": port, "url": f"https://{port}-{self.sandbox.id}.run.withruntime.com",
                             "visibility": visibility}
        return self.shared[port]

    def list(self):
        return list(self.shared.values())

    def delete(self, port):
        self.world.record("previews.delete", port)
        return self.shared.pop(port)


class FakeSandbox:
    def __init__(self, world, fields):
        self.world = world
        self.id = world.new_id("sbx")
        self.info = {"vcpu": 1, "memoryMiB": 1024, "diskMiB": 4096, "labels": {}, "timeoutSeconds": 0,
                     "endsAt": None, "onLeaseEnd": "pause", "autoWake": True,
                     "createdAt": "2026-10-15T12:00:00Z", **fields, "id": self.id, "state": "running"}
        self._t = Transport(world)
        self.files = Files(world, self)
        self.previews = Previews(world, self)
        world.sandboxes[self.id] = self

    def exec(self, command, timeout_ms=None, on_stdout=None, on_stderr=None):
        self.world.record("exec", self.id, command, timeout_ms)
        script = command if isinstance(command, str) else " ".join(command)
        if "sleep" in script:
            return Result(None, timed_out=True)
        if on_stdout:
            on_stdout("hi\n")
        if on_stderr:
            on_stderr("warn\n")
        return Result(3 if "false" in script else 0, "hi\n", "warn\n")

    def spawn(self, command):
        self.world.record("spawn", self.id, command)

    def pause(self):
        self.world.record("pause", self.id)
        self.info["state"] = "paused"

    def wake(self):
        self.world.record("wake", self.id)
        self.info["state"] = "running"

    def update(self, **settings):
        self.world.record("update", self.id, settings)
        self.info.update({"autoWake" if k == "auto_wake" else k: v for k, v in settings.items()})
        return self

    def snapshot(self, name=None, labels=None, retention_days=None, mode=None):
        self.world.record("snapshot", self.id, name, labels, retention_days, mode)
        return self.world.add_snapshot(self, name, labels, mode or "memory", retention_days)

    def extend(self, seconds):
        self.world.record("extend", self.id, seconds)
        return self

    def resize(self, **sizes):
        self.world.record("resize", self.id, sizes)
        self.info.update({"vcpu" if k == "vcpu" else "memoryMiB": v for k, v in sizes.items()})
        return self

    def delete(self):
        self.world.record("sandboxes.delete", self.id)
        self.world.sandboxes.pop(self.id, None)


class FakeSandboxes:
    def __init__(self, world):
        self.world = world

    def create(self, wait=True, **fields):
        self.world.record("sandboxes.create", fields)
        return FakeSandbox(self.world, {k: v for k, v in fields.items() if k in ("labels",)} | {
            "vcpu": fields.get("vcpu", 1), "memoryMiB": fields.get("memory_mib", 1024),
            "diskMiB": fields.get("disk_mib", 4096), "snapshotId": fields.get("snapshot"),
            "timeoutSeconds": fields.get("timeout_seconds", 0),
            "endsAt": "2026-10-15T12:10:00Z" if fields.get("timeout_seconds") else None,
            "onLeaseEnd": fields.get("on_lease_end", "pause")})

    def get(self, sandbox_id):
        if sandbox_id not in self.world.sandboxes:
            raise NotFoundError("No such sandbox.", code="not_found", status=404)
        return self.world.sandboxes[sandbox_id]

    def list(self, labels=None):
        self.world.record("sandboxes.list", labels)
        return [s for s in self.world.sandboxes.values()
                if all(s.info["labels"].get(k) == v for k, v in (labels or {}).items())]

    def delete(self, sandbox_id):
        self.world.record("sandboxes.delete", sandbox_id)
        self.world.sandboxes.pop(sandbox_id, None)


class FakeSnapshots:
    def __init__(self, world):
        self.world = world

    def get(self, snapshot_id):
        if snapshot_id not in self.world.snapshots:
            raise NotFoundError("No such snapshot.", code="not_found", status=404)
        return self.world.snapshots[snapshot_id]

    def list(self, name=None):
        self.world.record("snapshots.list", name)
        return [s for s in self.world.snapshots.values() if name in (None, s["name"])]

    def update(self, snapshot_id, labels=None):
        self.world.record("snapshots.update", snapshot_id, labels)
        self.world.snapshots[snapshot_id]["labels"] = labels
        return self.world.snapshots[snapshot_id]

    def extend(self, snapshot_id, retention_days):
        self.world.record("snapshots.extend", snapshot_id, retention_days)
        self.world.snapshots[snapshot_id]["retentionDays"] = retention_days
        return self.world.snapshots[snapshot_id]

    def delete(self, snapshot_id):
        self.world.record("snapshots.delete", snapshot_id)
        self.world.snapshots.pop(snapshot_id)


class FakeRuntime:
    def __init__(self, world):
        self._t = Transport(world)
        self.sandboxes, self.snapshots = FakeSandboxes(world), FakeSnapshots(world)


def setup_digest(parent, command):
    """Morph 0.1.115's own: _cache_effect over _run_command_effect."""
    effect = "_run_command_effect" + str(()) + str({"command": command, "background": False, "get_pty": True})
    return hashlib.sha256(parent.encode() + b"\n" + effect.encode()).hexdigest()


class MorphTest(unittest.TestCase):
    def setUp(self):
        self.world = World()
        self.morph = MorphCloudClient(runtime=FakeRuntime(self.world))
        # Setup's progress and its commands' output go to the terminal; not here.
        for name, quiet in (("_print", lambda text: None),
                            ("sys", SimpleNamespace(stdout=io.StringIO(), stderr=io.StringIO()))):
            patcher = patch.object(morph, name, quiet)
            patcher.start()
            self.addCleanup(patcher.stop)

    def base(self, **options):
        return self.morph.snapshots.create(vcpus=1, memory=1024, disk_size=4096, **options)


class ClientCalls(MorphTest):
    def test_a_morph_key_and_endpoint_never_reach_runtime(self):
        with patch.dict(os.environ, {"RUNTIME_API_KEY": "rtcloud_test"}):
            client = MorphCloudClient(api_key="morph_secret")
        self.assertEqual(client.api_key, "")
        self.assertEqual(client.runtime._t._api_key(), "rtcloud_test")
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(CompatibilityError):
            MorphCloudClient(api_key="morph_secret")
        with self.assertRaisesRegex(CompatibilityError, "endpoint"):
            MorphCloudClient(api_key="rtcloud_x", base_url="https://cloud.morph.so/api")
        with self.assertRaisesRegex(CompatibilityError, "SSH gateway"):
            MorphCloudClient(api_key="rtcloud_x", ssh_hostname="ssh.cloud.morph.so")
        self.assertTrue(MorphCloudClient(api_key="rtcloud_x", base_url="https://api.withruntime.com").base_url)

    def test_what_runtime_lacks_is_refused_naming_its_way(self):
        for name in ("devbox", "devbox_async", "user", "volumes", "simple_index"):
            with self.assertRaises(CompatibilityError, msg=name):
                getattr(self.morph, name)
        with self.assertRaises(CompatibilityError):
            UserAPI(self.morph)
        instance = self.morph.instances.start(self.base().id)
        for call in (instance.ssh, instance.ssh_connect, instance.ssh_key, instance.ssh_key_rotate, instance.reboot,
                     instance.as_container, lambda: self.morph.instances.reboot(instance.id)):
            with self.assertRaisesRegex(CompatibilityError, r"^Morph: \w+; \w"):
                call()
        with self.assertRaisesRegex(CompatibilityError, "Dockerfile"):
            self.base().as_container(image="nginx")

    def test_images_are_the_default_image(self):
        [image] = self.morph.images.list()
        self.assertEqual(image.id, "morphvm-minimal")
        with self.assertRaisesRegex(CompatibilityError, "Runtime image"):
            self.morph.snapshots.create(image_id="morphvm-ubuntu")


class SnapshotCalls(MorphTest):
    def test_create_boots_the_image_keeps_its_disk_and_deletes_the_sandbox(self):
        snapshot = self.morph.snapshots.create(image_id="python:3.12", vcpus=2, memory=2048, disk_size=8192,
                                               digest="base-1", metadata={"team": "a"}, ttl_seconds=7 * 86400)
        [created] = self.world.called("sandboxes.create")
        self.assertEqual(created[0], {"labels": {"compat.provider": "morph"}, "image": "python:3.12", "vcpu": 2,
                                      "memory_mib": 2048, "disk_mib": 8192})
        [(_, name, labels, days, mode)] = self.world.called("snapshot")
        self.assertEqual((name, days, mode), ("morph-" + hashlib.sha256(b"base-1").hexdigest(), 7, "disk"))
        self.assertEqual(labels, {"team": "a", "morph.image": "python:3.12", "morph.digest": "base-1"})
        self.assertEqual(len(self.world.called("sandboxes.delete")), 1)
        self.assertEqual((snapshot.digest, snapshot.metadata, snapshot.refs.image_id), ("base-1", {"team": "a"},
                                                                                       "python:3.12"))
        self.assertEqual((snapshot.spec.vcpus, snapshot.spec.memory, snapshot.status), (2, 2048, SnapshotStatus.READY))
        self.assertEqual(snapshot.ttl.ttl_seconds, 7 * 86400)
        # The same digest answers the same snapshot, creating nothing.
        self.assertEqual(self.morph.snapshots.create(digest="base-1").id, snapshot.id)
        self.assertEqual(len(self.world.called("sandboxes.create")), 1)

    def test_retention_is_whole_days(self):
        with self.assertRaisesRegex(CompatibilityError, "whole days"):
            self.base(ttl_seconds=3600)
        with self.assertRaises(ValueError):
            self.base(ttl_seconds=0)
        snapshot = self.base()
        snapshot.set_ttl(2 * 86400)
        snapshot.set_ttl(None)
        self.assertEqual([c[1] for c in self.world.called("snapshots.extend")], [2, None])
        self.assertIsNone(snapshot.ttl.ttl_seconds)

    def test_list_filters_by_digest_and_metadata_and_pages(self):
        a = self.base(digest="a", metadata={"k": "1"})
        self.base(metadata={"k": "2"})
        self.assertEqual([s.id for s in self.morph.snapshots.list(digest="a")], [a.id])
        self.assertEqual([s.id for s in self.morph.snapshots.list(metadata={"k": "1"})], [a.id])
        page = self.morph.snapshots.list_paginated(page=2, limit=1)
        self.assertEqual((page.total, page.size, page.total_pages, page.has_prev, page.has_next), (2, 1, 2, True, False))

    def test_set_metadata_replaces_it_and_keeps_the_adapters_labels(self):
        snapshot = self.base(digest="d", metadata={"a": "1"})
        snapshot.set_metadata({"b": "2"})
        self.assertEqual(snapshot.metadata, {"b": "2"})
        self.assertEqual(snapshot.digest, "d")
        with self.assertRaisesRegex(CompatibilityError, "own label"):
            snapshot.set_metadata({"morph.digest": "x"})

    def test_setup_runs_once_per_chain_hash_as_morphs_own(self):
        base = self.base()
        built = base.setup("pip install requests")
        self.assertEqual(built.digest, setup_digest(base.id, "pip install requests"))
        self.assertEqual(len(self.world.called("sandboxes.create")), 2)
        # The copy ran it in a shell, was snapshotted and deleted.
        self.assertIn("pip install requests", [c[1] for c in self.world.called("exec")])
        self.assertEqual(self.world.sandboxes.keys(), set())
        # A repeat answers the cached snapshot and starts nothing; exec is setup.
        self.assertEqual(base.exec("pip install requests").id, built.id)
        self.assertEqual(len(self.world.called("sandboxes.create")), 2)
        # The chain goes on from the digest.
        self.assertEqual(built.setup("ls").digest, setup_digest(built.digest, "ls"))

    def test_a_failing_setup_raises_and_still_stops_its_copy(self):
        with self.assertRaisesRegex(builtins.RuntimeError, "failed with exit code 3"):
            self.base().setup("false")
        self.assertEqual(self.world.sandboxes.keys(), set())

    def test_build_reuses_the_longest_built_prefix_and_shares_setups_cache(self):
        base = self.base()
        first = base.setup("apt-get update")
        seen = []
        steps = ["apt-get update", "make", lambda instance: seen.append(instance.id)]
        final = base.build(steps)
        # Step one was setup's snapshot: the build started from it.
        self.assertEqual(self.world.called("sandboxes.create")[-1][0]["snapshot"], first.id)
        self.assertEqual(len(seen), 1)
        digest = base.id
        for step in steps:
            digest = Snapshot.compute_chain_hash(digest, base._effect_identifier_for_step(step))
        self.assertEqual(final.digest, digest)
        again = base.build(["apt-get update", "make"])
        self.assertEqual(again.digest, Snapshot.compute_chain_hash(first.digest, base._effect_identifier_for_step("make")))
        self.assertIs(base.build([]), base)

    def test_upload_effect_is_cached(self):
        with tempfile.NamedTemporaryFile(suffix=".txt") as local:
            local.write(b"data")
            local.flush()
            base = self.base()
            one = base.upload(local.name, "/workspace/data.txt")
            self.assertEqual(base.upload(local.name, "/workspace/data.txt").id, one.id)
        self.assertEqual(len(self.world.called("files.upload")), 1)

    def test_delete_and_errors_become_api_errors(self):
        snapshot = self.base()
        snapshot.delete()
        with self.assertRaises(ApiError) as caught:
            self.morph.snapshots.get(snapshot.id)
        self.assertEqual((caught.exception.status_code, caught.exception.error_code), (404, "not_found"))
        self.assertIsInstance(caught.exception.__cause__, NotFoundError)


class InstanceCalls(MorphTest):
    def test_start_maps_metadata_and_the_time_limit(self):
        base = self.base()
        instance = self.morph.instances.start(base.id, metadata={"job": "1"}, ttl_seconds=600, ttl_action="pause")
        created = self.world.called("sandboxes.create")[-1][0]
        self.assertEqual((created["snapshot"], created["timeout_seconds"], created["on_lease_end"]),
                         (base.id, 600, "pause"))
        self.assertEqual(created["labels"], {"job": "1", "compat.provider": "morph", "morph.image": "morphvm-minimal"})
        self.assertEqual((instance.status, instance.metadata, instance.refs.snapshot_id),
                         (InstanceStatus.READY, {"job": "1"}, base.id))
        self.assertEqual((instance.ttl.ttl_seconds, instance.ttl.ttl_action), (600, "pause"))
        # Morph's stop deletes, so its ttl "stop" is Runtime's delete.
        self.morph.instances.start(base.id, ttl_seconds=600)
        self.assertEqual(self.world.called("sandboxes.create")[-1][0]["on_lease_end"], "delete")
        with self.assertRaisesRegex(CompatibilityError, "ttl_action without ttl_seconds"):
            self.morph.instances.start(base.id, ttl_action="pause")
        with self.assertRaisesRegex(CompatibilityError, "60 to 86400"):
            self.morph.instances.start(base.id, ttl_seconds=10)

    def test_exec_shell_argv_streams_and_times_out(self):
        instance = self.morph.instances.start(self.base().id)
        out = []
        result = instance.exec("echo hi", on_stdout=out.append, on_stderr=lambda _: 1 / 0)
        self.assertEqual((result.exit_code, result.stdout, result.stderr, out), (0, "hi\n", "warn\n", ["hi\n"]))
        instance.exec(["ls", "-la"], timeout=5)
        instance.exec(["echo hi"])
        commands = [(c[1], c[2]) for c in self.world.called("exec")]
        self.assertEqual(commands[-3:], [("echo hi", 86_400_000), (["ls", "-la"], 5000), ("echo hi", 86_400_000)])
        self.assertEqual(instance.exec("false").exit_code, 3)
        with self.assertRaisesRegex(builtins.TimeoutError, "timed out after 2 seconds"):
            instance.exec("sleep 9", timeout=2)

    def test_pause_resume_metadata_and_wake_on(self):
        instance = self.morph.instances.start(self.base().id, metadata={"a": "1"})
        instance.pause()
        self.assertEqual(instance.status, InstanceStatus.PAUSED)
        instance.resume()
        self.assertEqual(instance.status, InstanceStatus.READY)
        instance.set_metadata({"b": "2"})
        self.assertEqual(instance.metadata, {"a": "1", "b": "2"})
        self.assertEqual([i.id for i in self.morph.instances.list(metadata={"b": "2"})], [instance.id])
        instance.set_wake_on(wake_on_http=False)
        self.assertEqual((instance.wake_on.wake_on_ssh, instance.wake_on.wake_on_http), (False, False))
        with self.assertRaisesRegex(CompatibilityError, "auto_wake"):
            instance.set_wake_on(wake_on_ssh=True, wake_on_http=False)

    def test_wait_until_ready_wakes_a_paused_instance(self):
        instance = self.morph.instances.start(self.base().id)
        instance.native.info["state"] = "paused"
        instance.wait_until_ready(timeout=5)
        self.assertEqual(instance.status, InstanceStatus.READY)
        self.assertEqual(len(self.world.called("wake")), 1)

    def test_snapshot_branch_and_stop(self):
        instance = self.morph.instances.start(self.base().id, metadata={"m": "1"})
        snapshot = instance.snapshot(digest="step", metadata={"x": "y"})
        self.assertEqual((snapshot.digest, snapshot.metadata), ("step", {"x": "y"}))
        self.assertEqual(self.world.called("snapshot")[-1][4], None)  # memory: processes too
        branched, copies = instance.branch(2)
        self.assertEqual(self.world.called("fork")[-1][1], {"count": 2, "keepSnapshot": True})
        self.assertEqual(len(copies), 2)
        self.assertTrue(all(c.refs.snapshot_id == branched.id and c.metadata == {"m": "1"} for c in copies))
        with instance:
            pass
        self.assertNotIn(instance.id, self.world.sandboxes)

    def test_http_services_are_previews(self):
        instance = self.morph.instances.start(self.base().id)
        url = instance.expose_http_service("web", 8080)
        private = instance.expose_http_service("api", 9000, auth_mode="api_key")
        self.assertEqual(self.world.called("previews.create"), [(8080, "public"), (9000, "private")])
        self.assertEqual(url, "https://8080-%s.run.withruntime.com" % instance.id)
        self.assertTrue(private.startswith("https://9000-"))
        self.assertEqual({s.name: s.port for s in instance.networking.http_services}, {"web": 8080, "api": 9000})
        self.assertEqual({s.name for s in self.morph.instances.get(instance.id).networking.http_services},
                         {"web", "api"})
        instance.hide_http_service("web")
        self.assertEqual(self.world.called("previews.delete"), [(8080,)])
        self.assertEqual([s.name for s in instance.networking.http_services], ["api"])
        with self.assertRaises(ApiError):
            instance.hide_http_service("web")
        with self.assertRaisesRegex(CompatibilityError, "auth_mode"):
            instance.expose_http_service("x", 1, auth_mode="oauth")

    def test_set_ttl_moves_the_end_later_only(self):
        base = self.base()
        limited = self.morph.instances.start(base.id, ttl_seconds=600)
        with patch.object(morph.time, "time", lambda: morph._seconds("2026-10-15T12:05:00Z")):
            limited.set_ttl(3600)
            self.assertEqual(self.world.called("extend")[-1][1], 3600 - 300)
            with self.assertRaisesRegex(CompatibilityError, "earlier"):
                limited.set_ttl(60)
        with self.assertRaisesRegex(CompatibilityError, "removes"):
            limited.set_ttl(None)
        with self.assertRaisesRegex(CompatibilityError, "ttl_action pause"):
            limited.set_ttl(3600, ttl_action="pause")
        with self.assertRaisesRegex(CompatibilityError, "started without ttl_seconds"):
            self.morph.instances.start(base.id).set_ttl(600)

    def test_boot_sizes_a_disk_snapshot_and_resizes_a_running_machines(self):
        base = self.base()
        self.morph.instances.boot(base.id, vcpus=4, memory=8192, disk_size=16384)
        created = self.world.called("sandboxes.create")[-1][0]
        self.assertEqual((created["vcpu"], created["memory_mib"], created["disk_mib"]), (4, 8192, 16384))
        machine = self.morph.instances.start(base.id).snapshot()
        booted = self.morph.instances.boot(machine.id, vcpus=2)
        self.assertEqual(self.world.called("resize")[-1][1], {"vcpu": 2})
        self.assertEqual(booted.spec.vcpus, 2)
        with self.assertRaisesRegex(CompatibilityError, "disk_size"):
            self.morph.instances.boot(machine.id, disk_size=99999)

    def test_upload_and_download_follow_morphs_rules(self):
        instance = self.morph.instances.start(self.base().id)
        with tempfile.TemporaryDirectory() as folder:
            local = os.path.join(folder, "a.txt")
            Path(local).write_text("hello")
            instance.upload(local, "/workspace/a.txt")
            instance.download("/workspace/a.txt", os.path.join(folder, "b.txt"))
            self.assertEqual(Path(folder, "b.txt").read_text(), "hello")
            with self.assertRaisesRegex(ValueError, "Use --recursive"):
                instance.upload(folder, "/workspace/dir")
            instance.upload(folder, "/workspace/dir", recursive=True)
            with self.assertRaisesRegex(ValueError, "Use --recursive"):
                instance.download("/workspace/dir", folder)

    def test_cleanup_applies_morphs_filter(self):
        base = self.base()
        keep = self.morph.instances.start(base.id)
        keep.expose_http_service("web", 80)
        drop = self.morph.instances.start(base.id)
        paused = self.morph.instances.start(base.id)
        paused.pause()
        result = self.morph.instances.cleanup(service_exclude_pattern="we*")
        self.assertEqual((result["processed"], result["kept"], result["success"]), (1, 2, True))
        self.assertEqual(set(self.world.sandboxes), {keep.id, paused.id})
        self.assertNotIn(drop.id, self.world.sandboxes)
        with self.assertRaisesRegex(ValueError, "Invalid action"):
            self.morph.instances.cleanup(action="delete")

    def test_async_twins_answer_the_same(self):
        async def run():
            base = await self.morph.snapshots.acreate(vcpus=1)
            instance = await self.morph.instances.astart(base.id)
            result = await instance.aexec("echo hi")
            await instance.apause()
            await instance.aresume()
            async with instance:
                pass
            return base, result
        base, result = asyncio.run(run())
        self.assertIsInstance(base, Snapshot)
        self.assertEqual(result.stdout, "hi\n")
        self.assertEqual(self.world.sandboxes.keys(), set())

    def test_models_dump_as_morphs(self):
        instance = self.morph.instances.start(self.base().id)
        dumped = instance.model_dump()
        self.assertEqual(set(dumped), {"id", "object", "created", "status", "spec", "refs", "networking", "ttl",
                                       "wake_on", "metadata"})
        self.assertEqual((dumped["status"], dumped["spec"]["disk_size"]), ("ready", 4096))
        self.assertIsInstance(instance, Instance)


if __name__ == "__main__":
    unittest.main()
