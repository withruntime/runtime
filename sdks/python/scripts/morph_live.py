"""Morph Cloud's Python calls (morphcloud 0.1.115) through withruntime.morph
against the real Runtime API, timed: the quickstart's snapshot, setup and
build, an instance's commands, files, metadata, HTTP service, pause, branch,
time limit and snapshot, and the async twins. Creates its own sandboxes (each
capped at 5 cents and five minutes) and snapshots, and deletes every one it
made; never touches anything else.

    RUNTIME_API_KEY=rtcloud_... python3 scripts/morph_live.py --run

Not part of the unit tests (tests/test_compat_python_morph.py)."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from withruntime import Runtime  # noqa: E402
from withruntime._compat import CompatibilityError  # noqa: E402
from withruntime.morph import MorphCloudClient  # noqa: E402
from withruntime.morph.api import ApiError, InstanceStatus, SnapshotStatus  # noqa: E402

if "--run" not in sys.argv:
    print("Pass --run to create up to eight sandboxes, each capped at $0.05 and five minutes.")
    sys.exit(0)
if not os.environ.get("RUNTIME_API_KEY"):
    sys.exit("A dedicated RUNTIME_API_KEY test key is required.")

RUN = uuid.uuid4().hex[:8]
native = Runtime()
sandboxes: set = set()
snapshots: set = set()
create = native.sandboxes.create


def capped(**fields):
    sandbox = create(**{**fields, "timeout_seconds": fields.get("timeout_seconds") or 300,
                        "max_total_cost_micros": 50_000,
                        "labels": {**(fields.get("labels") or {}), "compat-run": RUN}})
    sandboxes.add(sandbox.id)
    return sandbox


native.sandboxes.create = capped
morph = MorphCloudClient(runtime=native)
timings = {}


def timed(name, step):
    started = time.perf_counter()
    value = step()
    timings[name] = round((time.perf_counter() - started) * 1000)
    return value


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"ok  {message}", flush=True)


def keep(snapshot):
    snapshots.add(snapshot.id)
    return snapshot


failed = False
try:
    # The quickstart: a snapshot of the base image, set up once, then started.
    base = keep(timed("snapshots.create", lambda: morph.snapshots.create(
        image_id="morphvm-minimal", vcpus=1, memory=2048, disk_size=4096, digest=f"compat-{RUN}")))
    check(base.status == SnapshotStatus.READY and base.spec.vcpus == 1, "snapshots.create makes a ready 1 vCPU snapshot")
    check(morph.snapshots.create(digest=f"compat-{RUN}").id == base.id,
          "snapshots.create with the same digest answers the same snapshot")
    base.set_ttl(86_400)
    check(morph.snapshots.get(base.id).ttl.ttl_seconds == 86_400, "snapshot set_ttl keeps it a day")

    command = "echo set-up > /workspace/setup.txt"
    ready = keep(timed("snapshot.setup", lambda: base.setup(command)))
    check(ready.digest == base.compute_chain_hash(
        base.digest, "_run_command_effect(){'command': '" + command + "', 'background': False, 'get_pty': True}"),
        "setup's digest is Morph's own chain hash")
    check(timed("snapshot.setup (cached)", lambda: base.setup(command)).id == ready.id,
          "setup of the same command answers the cached snapshot")

    def mark(instance):
        instance.exec("echo built > /workspace/built.txt")
    built = keep(timed("snapshot.build", lambda: base.build([command, mark])))
    check(built.id != ready.id, "build runs the steps after its cached prefix")

    instance = timed("instances.start", lambda: morph.instances.start(
        built.id, metadata={"run": RUN}, ttl_seconds=300))
    check(instance.status == InstanceStatus.READY, "instances.start answers a ready instance")
    check(instance.ttl.ttl_seconds == 300 and instance.ttl.ttl_action == "stop", "the TTL is the sandbox's time limit")

    result = timed("exec", lambda: instance.exec("cat /workspace/setup.txt /workspace/built.txt"))
    check(result.exit_code == 0 and result.stdout.split() == ["set-up", "built"],
          "setup's and build's files are in the started instance")
    check(instance.exec(["python3", "-c", "print(6 * 7)"]).stdout.strip() == "42", "exec of an argument list runs it")
    streamed = []
    instance.exec("for i in 1 2 3; do echo $i; sleep 0.2; done", on_stdout=streamed.append)
    check("".join(streamed).split() == ["1", "2", "3"], "on_stdout streams output")
    check(instance.exec("exit 3").exit_code == 3, "a failing command answers its exit code")
    try:
        instance.exec("sleep 30", timeout=1)
        check(False, "a timeout raises")
    except TimeoutError:
        check(True, "a command past its timeout raises TimeoutError")

    with tempfile.TemporaryDirectory() as folder:
        Path(folder, "in.txt").write_text("from laptop")
        instance.upload(str(Path(folder, "in.txt")), "/workspace/in.txt")
        instance.download("/workspace/in.txt", str(Path(folder, "out.txt")))
        check(Path(folder, "out.txt").read_text() == "from laptop", "upload and download round-trip a file")
        Path(folder, "tree").mkdir()
        Path(folder, "tree", "a.txt").write_text("a")
        instance.upload(str(Path(folder, "tree")), "/workspace/tree", recursive=True)
        check(instance.exec("cat /workspace/tree/a.txt").stdout == "a", "a recursive upload copies a folder")

    instance.set_metadata({"stage": "checked"})
    listed = morph.instances.list(metadata={"run": RUN, "stage": "checked"})
    check([i.id for i in listed] == [instance.id], "instances.list filters by metadata")
    check(listed[0].metadata["stage"] == "checked", "metadata reads back")
    page = morph.instances.list_paginated(limit=1, metadata={"run": RUN})
    check(page.total == 1 and page.instances[0].id == instance.id, "list_paginated pages the same list")

    before = instance.ttl.ttl_expire_at
    instance.set_ttl(600)
    check(instance.ttl.ttl_expire_at >= before + 250, "set_ttl moves the time limit's end later")
    try:
        instance.set_ttl(None)
        check(False, "set_ttl(None) raises")
    except CompatibilityError:
        check(True, "set_ttl(None) is refused, naming the alternative")

    # A server kept across pause and resume, and shared over HTTP.
    instance.native.spawn("cd /workspace && python3 -m http.server 8000")
    instance.exec("for i in $(seq 50); do curl -s localhost:8000 >/dev/null && break; sleep 0.1; done")
    url = instance.expose_http_service("web", 8000, auth_mode="api_key")
    check(url.startswith("https://"), "expose_http_service answers an HTTPS address")
    token = instance.native.previews.get(8000)["token"]
    request = urllib.request.Request(url.rstrip("/") + "/setup.txt", headers={"x-runtime-preview-token": token})
    with urllib.request.urlopen(request, timeout=30) as response:
        check(response.status == 200 and response.read().decode().strip() == "set-up",
              "the service answers through its address")
    check([s.name for s in morph.instances.get(instance.id).networking.http_services] == ["web"],
          "networking.http_services names the service")

    timed("pause", instance.pause)
    check(instance.status == InstanceStatus.PAUSED, "pause leaves it paused")
    timed("resume", instance.resume)
    check(instance.status == InstanceStatus.READY, "resume makes it ready")
    check(instance.exec("curl -s localhost:8000/setup.txt").stdout.strip() == "set-up",
          "the server kept running through pause and resume")

    branched, copies = timed("branch(2)", lambda: instance.branch(2))
    keep(branched)
    sandboxes.update(c.id for c in copies)
    check(len(copies) == 2, "branch(2) answers two instances")
    for copy in copies:
        check(copy.exec("curl -s localhost:8000/setup.txt").stdout.strip() == "set-up",
              f"branch {copy.id[:8]} has the running server")
        copy.stop()

    instance.hide_http_service("web")
    check(instance.networking.http_services == [], "hide_http_service removes it")
    kept = keep(timed("instance.snapshot", lambda: instance.snapshot(metadata={"kind": f"kept-{RUN}"})))
    check(kept.metadata == {"kind": f"kept-{RUN}"}, "instance.snapshot keeps its metadata")
    check([s.id for s in morph.snapshots.list(metadata={"kind": f"kept-{RUN}"})] == [kept.id],
          "snapshots.list filters by metadata")
    kept.set_metadata({"kind": "replaced"})
    check(morph.snapshots.get(kept.id).metadata == {"kind": "replaced"}, "snapshot set_metadata replaces it")

    # A copy of the base disk at another size boots fresh at that size.
    with timed("instances.boot", lambda: morph.instances.boot(base.id, vcpus=2, memory=4096)) as booted:
        sandboxes.add(booted.id)
        check((booted.spec.vcpus, booted.spec.memory) == (2, 4096), "boot starts a disk snapshot at another size")
    check(booted.id not in [i.id for i in morph.instances.list()], "the with block stops (deletes) it")

    try:
        instance.ssh_key()
        check(False, "ssh_key raises")
    except CompatibilityError as error:
        check("runtime sandboxes ssh" in str(error), "ssh_key is refused, naming Runtime's SSH")
    try:
        morph.instances.get("00000000-0000-4000-8000-000000000000")
        check(False, "a missing instance raises")
    except ApiError as error:
        check(error.status_code == 404, "a Runtime refusal is Morph's ApiError (404)")

    async def twins():
        copy = await morph.instances.astart(ready.id)
        sandboxes.add(copy.id)
        async with copy:
            answer = await copy.aexec("cat /workspace/setup.txt")
            await copy.apause()
            await copy.aresume()
        return answer
    check(timed("async start, exec, pause, resume, stop", lambda: asyncio.run(twins())).stdout.strip() == "set-up",
          "the async twins run the same calls")

    timed("stop", instance.stop)
    check(morph.instances.list(metadata={"run": RUN}) == [], "stopped instances leave the list")
except BaseException as error:  # noqa: BLE001 - every failure is reported, then the cleanup runs
    failed = True
    print(f"FAIL {type(error).__name__}: {error}", file=sys.stderr, flush=True)
finally:
    for sandbox_id in sandboxes:
        try:
            native.sandboxes.delete(sandbox_id)
        except Exception as error:  # noqa: BLE001
            failed = True
            print(f"Cleanup of sandbox {sandbox_id} failed: {error}", file=sys.stderr)
    for snapshot_id in snapshots:
        try:
            native.snapshots.delete(snapshot_id)
        except Exception as error:  # noqa: BLE001
            failed = True
            print(f"Cleanup of snapshot {snapshot_id} failed: {error}", file=sys.stderr)
print(json.dumps({"timingsMs": timings}, indent=2))
sys.exit(1 if failed else 0)
