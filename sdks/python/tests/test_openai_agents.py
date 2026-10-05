"""withruntime.openai_agents: the OpenAI Agents SDK's own session machinery
(manifest application, path validation, PTY collection, snapshots) driven
against a fake Runtime whose sandbox is a temporary directory on this machine.

Commands really run, with /workspace mapped to that directory, so the SDK's
helper scripts, tar persistence and the PTY pump are exercised for real. What
the fake cannot show: a microVM, sudo, other users, previews, and the API. The
live run against the trial is in packages/cloud-guide/docs/openai-agents-sdk.md.

Skipped when the Agents SDK is not installed (pip install "withruntime[openai-agents]")."""
import asyncio
import io
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

try:
    import agents  # noqa: F401
    HAVE_AGENTS = True
except ImportError:
    HAVE_AGENTS = False

from withruntime import CommandResult
from withruntime._errors import NotFoundError, RuntimeError as RuntimeCloudError


class FakeProcess:
    def __init__(self, proc, sandbox_id):
        self.proc, self.sandbox_id, self.info = proc, sandbox_id, {"id": uuid.uuid4().hex, "state": "running"}
        self.written = []

    @property
    def id(self):
        return self.info["id"]

    async def output(self, cursor=0):
        offset = 0
        while True:
            chunk = await self.proc.stdout.read(4096)
            if not chunk:
                break
            text = chunk.decode()
            yield {"type": "stdout", "offset": offset, "data": text}
            offset += len(chunk)
        code = await self.proc.wait()
        self.info = {**self.info, "state": "exited", "exitCode": code}
        yield {"type": "exit", "exitCode": code}

    async def write(self, data, eof=False):
        self.written.append(data)
        self.proc.stdin.write(data.encode())
        await self.proc.stdin.drain()

    async def kill(self, signal="SIGTERM"):
        if self.proc.returncode is None:
            self.proc.kill()

    async def refresh(self):
        return self.info


class FakeFiles:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def _local(self, path):
        if not (path == "/workspace" or path.startswith("/workspace/")):
            raise RuntimeCloudError("Guest path must be in workspace", code="invalid_request", status=400)
        return self.sandbox.local(path)

    async def read(self, path):
        local = self._local(path)
        if not os.path.isfile(local):
            raise NotFoundError("No such file or directory.", code="file_not_found", status=404)
        with open(local, "rb") as handle:
            return handle.read()

    async def write(self, path, data):
        local = self._local(path)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        with open(local, "wb") as handle:
            handle.write(data if isinstance(data, bytes) else data.encode())
        return {"path": path, "size": len(data)}

    async def remove(self, path, recursive=False):
        local = self._local(path)
        if os.path.isdir(local):
            shutil.rmtree(local)
        elif os.path.exists(local):
            os.remove(local)
        return True


class FakePreviews:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    async def create(self, port, *, visibility=None, ttl_seconds=None, idempotency_key=None):
        self.sandbox.world.calls.append(("preview", port, visibility))
        return {"url": f"https://{port}-{self.sandbox.id}.runtimehost.test/",
                "token": None if visibility == "public" else "tok"}


class FakeSandbox:
    """One sandbox: a directory standing in for its disk, /workspace inside it."""

    def __init__(self, world, fields):
        self.world, self.fields = world, fields
        self.info = {"id": str(uuid.uuid4()), "state": "running"}
        self.disk = tempfile.mkdtemp(prefix="fake-runtime-")
        os.makedirs(os.path.join(self.disk, "workspace"))
        if fields.get("snapshot"):
            shutil.rmtree(self.disk)
            shutil.copytree(world.snapshots[fields["snapshot"]], self.disk, symlinks=True)
        self.files = FakeFiles(self)
        self.previews = FakePreviews(self)
        self.pause_next_call = False

    @property
    def id(self):
        return self.info["id"]

    @property
    def state(self):
        return self.info["state"]

    def local(self, path):
        return self.disk + path if path.startswith("/workspace") else path

    def _map(self, text):
        return text.replace("/workspace", self.disk + "/workspace")

    def _check_running(self):
        if self.pause_next_call:
            self.pause_next_call = False
            self.info["state"] = "paused"
        if self.state == "paused":
            raise RuntimeCloudError("paused", code="sandbox_paused", status=409)
        if self.state != "running":
            raise RuntimeCloudError("not running", code="not_running", status=409)

    async def exec(self, command, *, cwd=None, env=None, stdin=None, timeout_ms=None, **_):
        self._check_running()
        self.world.calls.append(("exec", list(command), cwd, env, timeout_ms))
        argv = [self._map(part) for part in command]
        run_env = {**os.environ, **(env or {})}
        try:
            done = subprocess.run(argv, cwd=self._map(cwd or "/"), env=run_env, capture_output=True,
                                  timeout=(timeout_ms or 60_000) / 1000)
        except subprocess.TimeoutExpired as expired:
            return CommandResult(exit_code=None, stdout=(expired.stdout or b"").decode(),
                                 stderr=(expired.stderr or b"").decode(), timed_out=True)
        return CommandResult(exit_code=done.returncode, stdout=done.stdout.decode(), stderr=done.stderr.decode())

    async def spawn(self, command, *, cwd=None, env=None, stdin=None, pty=None, timeout_ms=None):
        self._check_running()
        self.world.calls.append(("spawn", list(command), pty))
        proc = await asyncio.create_subprocess_exec(
            *[self._map(part) for part in command], cwd=self._map(cwd or "/"), env={**os.environ, **(env or {})},
            stdin=asyncio.subprocess.PIPE if pty else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        return FakeProcess(proc, self.id)

    async def refresh(self):
        return self

    async def wait_for(self, state, timeout_seconds=60):
        return self

    async def stop(self, wait=True, idempotency_key=None):
        self.world.calls.append(("stop", self.id))
        self.info["state"] = "stopped"
        return self

    async def pause(self, wait=True, idempotency_key=None):
        self.world.calls.append(("pause", self.id))
        self.info["state"] = "paused"
        return self

    async def wake(self, wait=True, timeout_seconds=None, idempotency_key=None):
        self.world.calls.append(("wake", self.id))
        self.info["state"] = "running"
        return self

    async def snapshot(self, *, name=None, labels=None, retention_days=None, idempotency_key=None):
        snapshot_id = str(uuid.uuid4())
        target = tempfile.mkdtemp(prefix="fake-snapshot-")
        shutil.rmtree(target)
        shutil.copytree(self.disk, target, symlinks=True)
        self.world.snapshots[snapshot_id] = target
        self.world.calls.append(("snapshot", self.id, retention_days))
        return {"id": snapshot_id}


class FakeSandboxes:
    def __init__(self, world):
        self.world = world

    async def create(self, **fields):
        self.world.calls.append(("create", fields))
        sandbox = FakeSandbox(self.world, fields)
        self.world.machines[sandbox.id] = sandbox
        return sandbox

    async def get(self, sandbox_id):
        if sandbox_id not in self.world.machines:
            raise NotFoundError("gone", code="not_found", status=404)
        return self.world.machines[sandbox_id]


class FakeRuntime:
    def __init__(self):
        self.calls, self.machines, self.snapshots = [], {}, {}
        self.sandboxes_api = FakeSandboxes(self)

    @property
    def sandboxes(self):
        return self.sandboxes_api

    async def close(self):
        pass

    def cleanup(self):
        for sandbox in self.machines.values():
            shutil.rmtree(sandbox.disk, ignore_errors=True)
        for path in self.snapshots.values():
            shutil.rmtree(path, ignore_errors=True)


def run(coroutine):
    return asyncio.run(coroutine)


@unittest.skipUnless(HAVE_AGENTS, "the OpenAI Agents SDK is not installed")
class OpenAIAgentsTest(unittest.TestCase):
    def setUp(self):
        from withruntime.openai_agents import RuntimeCloudSandboxClient
        self.world = FakeRuntime()
        self.client = RuntimeCloudSandboxClient(runtime=self.world)

    def tearDown(self):
        self.world.cleanup()

    def options(self, **fields):
        from withruntime.openai_agents import RuntimeCloudSandboxClientOptions
        return RuntimeCloudSandboxClientOptions(**fields)

    def test_create_passes_fields_and_applies_the_manifest(self):
        from agents.sandbox import Manifest
        from agents.sandbox.entries import File

        async def body():
            session = await self.client.create(
                manifest=Manifest(entries={"notes.md": File(content=b"from the manifest\n")},
                                  environment={"value": {"FROM_MANIFEST": "m"}}),
                options=self.options(funding="trial", memory_mib=2048, snapshot_id="snap-1", env={"BASE": "b"},
                                     max_total_cost_micros=5_000_000, extra={"on_lease_end": "pause"}))
            return session

        self.world.snapshots["snap-1"] = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.world.snapshots["snap-1"], "workspace"))

        async def flow():
            session = await body()
            async with session:
                result = await session.exec("cat notes.md; echo $BASE $FROM_MANIFEST")
                return session, result
        session, result = run(flow())
        create = self.world.calls[0]
        self.assertEqual(create, ("create", {"on_lease_end": "pause", "funding": "trial", "memory_mib": 2048,
                                             "max_total_cost_micros": 5_000_000, "snapshot": "snap-1"}))
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.stdout, b"from the manifest\nb m\n")
        self.assertIn(("stop", session.state.sandbox_id), self.world.calls)

    def test_exec_timeout_nonzero_and_transport_errors(self):
        from agents.sandbox.errors import ExecTimeoutError, ExecTransportError

        async def flow():
            session = await self.client.create(options=self.options())
            async with session:
                failed = await session.exec("echo out; echo err >&2; exit 3")
                with self.assertRaises(ExecTimeoutError):
                    await session.exec("sleep 5", timeout=0.2)
                sandbox = self.world.machines[session.state.sandbox_id]
                sandbox.info["state"] = "failed"
                with self.assertRaises(ExecTransportError):
                    await session.exec("true")
                sandbox.info["state"] = "running"
                return failed
        failed = run(flow())
        self.assertEqual((failed.exit_code, failed.stdout, failed.stderr), (3, b"out\n", b"err\n"))
        timeouts = [call[4] for call in self.world.calls if call[0] == "exec" and "sleep 5" in " ".join(call[1])]
        self.assertEqual(timeouts, [200])

    def test_a_command_with_no_timeout_gets_the_session_default(self):
        async def flow():
            session = await self.client.create(options=self.options(exec_timeout_s=90))
            async with session:
                await session.exec("true")
        run(flow())
        last = [call for call in self.world.calls if call[0] == "exec" and call[1][-1] == "true"][-1]
        self.assertEqual(last[4], 90_000)

    def test_an_idle_paused_sandbox_is_woken_and_the_call_retried(self):
        async def flow():
            session = await self.client.create(options=self.options())
            async with session:
                self.world.machines[session.state.sandbox_id].pause_next_call = True
                return await session.exec("echo awake")
        result = run(flow())
        self.assertEqual(result.stdout, b"awake\n")
        self.assertTrue(any(call[0] == "wake" for call in self.world.calls))

    def test_files_inside_and_outside_the_workspace_and_missing_files(self):
        from agents.sandbox import Manifest, SandboxPathGrant
        from agents.sandbox.errors import WorkspaceReadNotFoundError
        outside = tempfile.mkdtemp(prefix="fake-outside-")
        self.addCleanup(shutil.rmtree, outside, True)

        async def flow():
            session = await self.client.create(
                manifest=Manifest(extra_path_grants=(SandboxPathGrant(path=outside),)), options=self.options())
            async with session:
                big = os.urandom(3 * 1024 * 1024)
                await session.write(Path("data/big.bin"), io.BytesIO(big))
                self.assertEqual((await session.read(Path("data/big.bin"))).read(), big)
                await session.write(Path(f"{outside}/o.txt"), io.BytesIO(b"outside\n"))
                self.assertEqual((await session.read(Path(f"{outside}/o.txt"))).read(), b"outside\n")
                with self.assertRaises(WorkspaceReadNotFoundError):
                    await session.read(Path("nope.txt"))
                with self.assertRaises(WorkspaceReadNotFoundError):
                    await session.read(Path(f"{outside}/nope.txt"))
                return [entry.path for entry in await session.ls("data")]
        listing = run(flow())
        self.assertTrue(any(path.endswith("big.bin") for path in listing))
        with open(os.path.join(outside, "o.txt"), "rb") as handle:
            self.assertEqual(handle.read(), b"outside\n")
        staging = [s.disk for s in self.world.machines.values()][0] + "/workspace/.openai-agents-staging"
        self.assertEqual(os.listdir(staging) if os.path.isdir(staging) else [], [])

    def test_pty_sessions_poll_and_take_stdin(self):
        async def flow():
            session = await self.client.create(options=self.options())
            async with session:
                self.assertTrue(session.supports_pty())
                started = await session.pty_exec_start("echo one; sleep 1; echo two", yield_time_s=0.3)
                self.assertIsNotNone(started.process_id)
                self.assertIsNone(started.exit_code)
                output = started.output
                update = started
                while update.process_id is not None:
                    update = await session.pty_write_stdin(session_id=update.process_id, chars="", yield_time_s=2)
                    output += update.output
                interactive = await session.pty_exec_start("read line; echo got $line", tty=True, yield_time_s=0.3)
                answered = await session.pty_write_stdin(session_id=interactive.process_id, chars="hello\n",
                                                         yield_time_s=2)
                return output, update.exit_code, answered
        output, code, answered = run(flow())
        self.assertEqual((output, code), (b"one\ntwo\n", 0))
        self.assertIn(b"got hello", answered.output)
        self.assertEqual(answered.exit_code, 0)

    def test_tar_persistence_round_trips_through_resume(self):
        from agents.sandbox import LocalSnapshotSpec
        snapshots = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, snapshots, True)

        async def flow():
            session = await self.client.create(snapshot=LocalSnapshotSpec(base_path=Path(snapshots)),
                                               options=self.options())
            first = session.state.sandbox_id
            async with session:
                await session.write(Path("kept.txt"), io.BytesIO(b"kept\n"))
            resumed = await self.client.resume(session.state)
            async with resumed:
                return first, resumed.state.sandbox_id, (await resumed.read(Path("kept.txt"))).read()
        first, second, kept = run(flow())
        self.assertNotEqual(first, second)
        self.assertEqual(kept, b"kept\n")

    def test_snapshot_persistence_starts_the_resumed_session_from_the_snapshot(self):
        from agents.sandbox import LocalSnapshotSpec
        snapshots = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, snapshots, True)

        async def flow():
            session = await self.client.create(snapshot=LocalSnapshotSpec(base_path=Path(snapshots)),
                                               options=self.options(workspace_persistence="snapshot",
                                                                    snapshot_retention_days=2))
            async with session:
                await session.write(Path("kept.txt"), io.BytesIO(b"in the snapshot\n"))
            resumed = await self.client.resume(session.state)
            async with resumed:
                return (await resumed.read(Path("kept.txt"))).read()
        self.assertEqual(run(flow()), b"in the snapshot\n")
        snapshot_calls = [call for call in self.world.calls if call[0] == "snapshot"]
        # Each session keeps its machine as it closes: the first, then the resumed one.
        self.assertEqual([call[2] for call in snapshot_calls], [2, 2])
        from_snapshot = [call for call in self.world.calls if call[0] == "create" and "snapshot" in call[1]]
        self.assertEqual(len(from_snapshot), 1, "one machine started from the snapshot, not two")

    def test_pause_on_exit_resumes_the_same_machine(self):
        async def flow():
            session = await self.client.create(options=self.options(pause_on_exit=True))
            async with session:
                await session.write(Path("n.txt"), io.BytesIO(b"same\n"))
            self.assertEqual(self.world.machines[session.state.sandbox_id].state, "paused")
            resumed = await self.client.resume(session.state)
            resumed._inner.state.pause_on_exit = False
            async with resumed:
                return session.state.sandbox_id, resumed.state.sandbox_id, (await resumed.read(Path("n.txt"))).read()
        first, second, data = run(flow())
        self.assertEqual((first, data), (second, b"same\n"))

    def test_exposed_ports_become_previews(self):
        async def flow():
            session = await self.client.create(options=self.options(exposed_ports=(3000,)))
            async with session:
                private = await session.resolve_exposed_port(3000)
            public_session = await self.client.create(options=self.options(exposed_ports=(3000,),
                                                                            preview_visibility="public"))
            async with public_session:
                public = await public_session.resolve_exposed_port(3000)
            return private, public
        private, public = run(flow())
        self.assertTrue(private.tls)
        self.assertEqual(private.port, 443)
        self.assertTrue(private.url_for("http").endswith("/?runtime_preview_token=tok"))
        self.assertEqual(public.query, "")

    def test_sudo_keeps_the_environment_and_account_commands_run_as_root(self):
        from withruntime.openai_agents import _with_env_through_sudo
        self.assertEqual(_with_env_through_sudo(["sudo", "-u", "alice", "--", "sh", "-lc", "x"], {"A": "1"}),
                         ["sudo", "-u", "alice", "--", "env", "A=1", "sh", "-lc", "x"])
        self.assertEqual(_with_env_through_sudo(["sh", "-lc", "x"], {"A": "1"}), ["sh", "-lc", "x"])

    def test_state_round_trips_through_serialization(self):
        async def flow():
            session = await self.client.create(options=self.options(funding="paid", pause_on_exit=True))
            payload = self.client.serialize_session_state(session.state)
            restored = self.client.deserialize_session_state(payload)
            await session.shutdown()
            return session.state, restored
        original, restored = run(flow())
        self.assertEqual(restored.sandbox_id, original.sandbox_id)
        self.assertEqual(restored.create_fields, {"funding": "paid"})
        self.assertTrue(restored.pause_on_exit)


if __name__ == "__main__":
    unittest.main()
