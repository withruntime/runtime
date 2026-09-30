"""Runloop sandbox APIs pinned to runloop-api-client 1.32.0."""
from __future__ import annotations
import json
import asyncio
import time
import math
from pathlib import Path
from .. import AsyncRuntime
from .._compat import runtime_key, named_shell, CompatibilityError, ENV_PATH, Model, environment, positive, reject
from .._errors import RuntimeError as SDKError
from .._compat_shell import SHELL_BROKER
from .._compat_lifecycle import AsyncLifecycleLock
from ._exceptions import RunloopError
from .lib.polling import PollingConfig, PollingTimeout
from . import _snapshots
from .._request_scope import request_scope

_SUSPENDED = "compat.runloop.suspended"


class AsyncExecutionResult:
    def __init__(self, client=None, devbox_id=None, result=None):
        # Native command paths pass (devbox_id, native_result); callers may
        # also construct the official (client, devbox_id, result) wrapper.
        if result is None:
            client, devbox_id, result = None, client, devbox_id
        self._client, self.devbox_id, self._result = client, devbox_id, result
        self._upstream = hasattr(result, "exit_status")
        if client is None and (getattr(result, "stdout_truncated", False) or getattr(result, "stderr_truncated", False)):
            raise IOError("Runloop command output was truncated")
        self.execution_id = getattr(result, "execution_id", None) or getattr(result, "process_id", None)
        self.exit_code = result.exit_status if self._upstream else result.exit_code
        self.success = self.exit_code == 0
        self.failed = self.exit_code is not None and self.exit_code != 0

    async def _output(self, channel, num_lines):
        value = getattr(self._result, channel, None) or ""
        truncated = getattr(self._result, channel + "_truncated", False)
        if truncated and (num_lines is None or sum(bool(line) for line in value.rstrip("\n").split("\n")) < num_lines):
            stream = await getattr(self._client.devboxes.executions, "stream_" + channel + "_updates")(
                self.execution_id, devbox_id=self.devbox_id)
            value = "".join([chunk.output async for chunk in stream])
        return self._lines(value, num_lines)

    async def stdout(self, num_lines=None):
        return await self._output("stdout", num_lines)

    async def stderr(self, num_lines=None):
        return await self._output("stderr", num_lines)

    @staticmethod
    def _lines(text, count):
        if count is None:
            return text
        return "\n".join(text.rstrip("\n").split("\n")[-count:]) if count > 0 else ""

    @property
    def result(self):
        if self._upstream:
            return self._result
        return Model(devbox_id=self.devbox_id, execution_id=self.execution_id, exit_status=self.exit_code,
                     status="completed", stdout=self._result.stdout, stderr=self._result.stderr, shell_name=None,
                     stdout_truncated=False, stderr_truncated=False)


class AsyncExecution:
    def __init__(self, devbox_id, process):
        self.devbox_id, self._process, self.execution_id = devbox_id, process, process.id
        self._result = None

    async def result(self):
        if self._result is None:
            self._result = AsyncExecutionResult(self.devbox_id, await self._process.wait())
        return self._result

    async def get_state(self):
        info = await self._process.refresh()
        return Model(devbox_id=self.devbox_id, execution_id=self.execution_id,
                     status="completed" if info.get("state") == "exited" else "running",
                     exit_status=info.get("exitCode"))

    async def kill(self):
        await self._process.kill("SIGKILL")


class AsyncCommandInterface:
    def __init__(self, devbox):
        self._devbox = devbox

    async def _command(self, sb, command, shell_name):
        if not shell_name:
            return command
        folder, _ = named_shell(command, shell_name)
        await sb.files.mkdir(folder, parents=True)
        script = "/workspace/.runtime-compat/shell.py"
        await sb.files.write(script, SHELL_BROKER, mode=0o600)
        return ["python3", script, "client", folder, json.dumps({"command": command, "env": {},
            "baseEnv": await self._devbox._env(sb)})]

    async def exec(self, command, *, stdout=None, stderr=None, output=None, shell_name=None, idempotency_key=None, **options):
        reject(options, "Runloop command")
        sb = await self._devbox._sandbox()
        command = await self._command(sb, command, shell_name)
        def on_stdout(chunk):
            if stdout:
                stdout(chunk)
            if output:
                output(chunk)
        def on_stderr(chunk):
            if stderr:
                stderr(chunk)
            if output:
                output(chunk)
        result = await sb.exec(command, env=await self._devbox._env(sb), on_stdout=on_stdout, on_stderr=on_stderr,
                               idempotency_key=idempotency_key)
        return AsyncExecutionResult(sb.id, result)

    async def exec_async(self, command, *, shell_name=None, attach_stdin=False, **options):
        reject(options, "Runloop background command")
        if attach_stdin and shell_name:
            raise CompatibilityError("Interactive stdin for named shells requires a shell broker stdin channel")
        sb = await self._devbox._sandbox()
        command = await self._command(sb, command, shell_name)
        return AsyncExecution(sb.id, await sb.spawn(command, env=await self._devbox._env(sb),
                                                    stdin="pipe" if attach_stdin else None))


class AsyncNamedShell:
    def __init__(self, devbox, name):
        self._devbox, self._name = devbox, name

    async def exec(self, command, **params):
        params["shell_name"] = self._name
        return await self._devbox.cmd.exec(command, **params)

    async def exec_async(self, command, **params):
        params["shell_name"] = self._name
        return await self._devbox.cmd.exec_async(command, **params)


class AsyncFileInterface:
    def __init__(self, devbox):
        self._devbox = devbox

    async def read(self, *, file_path):
        sb = await self._devbox._sandbox()
        return (await sb.files.read(file_path)).decode()

    async def write(self, *, file_path, contents):
        sb = await self._devbox._sandbox()
        await sb.files.write(file_path, contents)
        return Model(devbox_id=sb.id, exit_status=0, stdout="", stderr="")

    async def download(self, *, path):
        sb = await self._devbox._sandbox()
        return await sb.files.read(path)

    async def upload(self, *, path, file):
        sb = await self._devbox._sandbox()
        if isinstance(file, (str, Path)):
            data = Path(file).read_bytes()
        elif hasattr(file, "read"):
            data = file.read()
        elif isinstance(file, tuple):
            data = file[1]
            if hasattr(data, "read"):
                data = data.read()
        else:
            data = file
        await sb.files.write(path, data)
        return {}


class AsyncSnapshot:
    def __init__(self, runtime, snapshot_id):
        self._runtime, self.id = runtime, snapshot_id

    async def get_info(self, *, timeout=None):
        with request_scope(timeout):
            return _snapshots.status(await self._runtime.snapshots.get(self.id))

    async def delete(self, *, timeout=None):
        with request_scope(timeout):
            _snapshots.view(await self._runtime.snapshots.get(self.id))
            await self._runtime.snapshots.delete(self.id)
        return {}

    async def update(self, *, timeout=None, idempotency_key=None, **fields):
        reject({k: v for k, v in fields.items() if k not in ('name', 'metadata', 'commit_message')}, 'Runloop snapshot update')
        # Validate before reading or mutating anything; null clears a supplied field.
        _snapshots.options(**fields)
        with request_scope(timeout):
            for attempt in range(3):
                source = await self._runtime.snapshots.get(self.id)
                previous = _snapshots.view(source)
                body = {key: fields.get(key, previous.get(key)) for key in ('name', 'metadata', 'commit_message')}
                try:
                    updated = await self._runtime.snapshots.update(self.id, labels=_snapshots.options(**body)['labels'],
                        if_labels=source.get('labels') or {}, idempotency_key=idempotency_key)
                    return _snapshots.view(updated)
                except SDKError as error:
                    if error.code != 'snapshot_metadata_changed' or attempt == 2:
                        raise

    async def await_completed(self, *, polling_config=None, timeout=None):
        config, last = polling_config or PollingConfig(), None
        start, attempts = time.monotonic(), 0
        while True:
            last = await self.get_info(timeout=timeout)
            if last.status == 'complete': return last
            if last.status == 'error':
                raise RunloopError(f'Snapshot {self.id} failed: {last.error_message or "Unknown error"}')
            attempts += 1
            if attempts >= config.max_attempts:
                raise PollingTimeout(f'Exceeded maximum attempts ({config.max_attempts})', last)
            if config.timeout_seconds is not None and time.monotonic() - start >= config.timeout_seconds:
                raise PollingTimeout(f'Exceeded timeout of {config.timeout_seconds} seconds', last)
            await asyncio.sleep(config.interval_seconds)

    async def create_devbox(self, **params):
        return await AsyncDevboxOps(self._runtime).create(snapshot_id=self.id, **params)


class AsyncDevbox:
    def __init__(self, runtime, devbox_id):
        self._runtime, self.id = runtime, devbox_id
        self.cmd, self.file = AsyncCommandInterface(self), AsyncFileInterface(self)
        self._lifecycle_lock = AsyncLifecycleLock(runtime, devbox_id)

    def shell(self, shell_name=None):
        import uuid
        return AsyncNamedShell(self, shell_name if shell_name is not None else str(uuid.uuid4()))

    async def _sandbox(self):
        return await self._runtime.sandboxes.get(self.id)

    async def _env(self, sb):
        try:
            data = await sb.files.read(ENV_PATH)
        except SDKError as error:
            if error.status != 404:
                raise
            data = b"{}"
        return environment(data)

    async def get_info(self):
        sb = await self._sandbox()
        suspended = sb.info.get("labels", {}).get(_SUSPENDED) == "true"
        return Model(id=sb.id, name=sb.info.get("name"),
                     status=("suspended" if sb.state == "stopped" and suspended else
                             "resuming" if sb.state == "starting" and suspended else
                             "suspending" if sb.state == "stopping" and suspended else
                             {"running": "running", "stopped": "shutdown", "starting": "initializing", "failed": "failure"}.get(sb.state, sb.state)),
                     metadata={k: v for k, v in sb.info.get("labels", {}).items() if not k.startswith("compat.")})

    async def shutdown(self):
        await self._lifecycle_lock.acquire()
        try:
            sb = await self._sandbox()
            await sb.stop()
            if sb.state != "stopped":
                await sb.wait_for("stopped")
            if sb.info.get("persistent") or _SUSPENDED in sb.info.get("labels", {}):
                await sb.update(persistent=False, labels={k: v for k, v in sb.info.get("labels", {}).items() if k != _SUSPENDED})
            return await self.get_info()
        finally:
            self._lifecycle_lock.release()

    close = shutdown

    async def suspend(self):
        await self._lifecycle_lock.acquire()
        try:
            sb = await self._sandbox()
            if sb.state == "stopped" and sb.info.get("labels", {}).get(_SUSPENDED) == "true":
                return await self.get_info()
            if sb.state != "running":
                raise CompatibilityError(f"Cannot suspend a devbox in native state {sb.state!r}")
            # ARCHITECTURE.md section 10: retention must be admitted before stop.
            # A failed stop leaves the retained disk recoverable; never roll it
            # back to ephemeral storage while the stop result is uncertain.
            await sb.update(persistent=True, labels={**sb.info.get("labels", {}), _SUSPENDED: "true"})
            await sb.stop()
            if sb.state != "stopped":
                await sb.wait_for("stopped")
            return await self.get_info()
        finally:
            self._lifecycle_lock.release()

    async def resume(self):
        return await self._resume(True)

    async def resume_async(self):
        return await self._resume(False)

    async def _resume(self, wait):
        await self._lifecycle_lock.acquire()
        try:
            sb = await self._sandbox()
            marked = sb.info.get("labels", {}).get(_SUSPENDED) == "true"
            if sb.state != "running" and not marked:
                raise CompatibilityError("This devbox does not have a retained Runloop suspension")
            if sb.state == "stopped":
                await sb.restart(wait=wait)
            elif sb.state not in ("running", "starting"):
                raise CompatibilityError(f"Cannot resume a devbox in native state {sb.state!r}")
            if wait and sb.state != "running":
                await sb.wait_for("running")
            if sb.state == "running" and marked:
                await sb.update(labels={k: v for k, v in sb.info.get("labels", {}).items() if k != _SUSPENDED})
            return await self.get_info()
        finally:
            self._lifecycle_lock.release()

    async def _await_status(self, target, polling_config):
        config = polling_config or PollingConfig()
        total = config.interval_seconds * config.max_attempts
        if config.timeout_seconds is not None and config.timeout_seconds > 0:
            total = min(total, config.timeout_seconds)
        if not math.isfinite(total):
            raise ValueError("Polling timeout must be finite")
        deadline, last = time.monotonic() + total, None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PollingTimeout(f"Exceeded timeout of {total} seconds", last)
            last = await self.get_info()
            if last.status == target:
                return last
            if last.status in ("failure", "shutdown", "suspended", "paused"):
                raise RunloopError(f"Devbox entered non-{target} terminal state: {last.status}")
            await asyncio.sleep(min(max(config.interval_seconds, 0.01), remaining))

    async def await_running(self, *, polling_config=None):
        return await self._await_status("running", polling_config)

    async def await_suspended(self, *, polling_config=None):
        return await self._await_status("suspended", polling_config)

    async def snapshot_disk(self, *, name=None, metadata=None, commit_message=None, polling_config=None,
                            timeout=None, idempotency_key=None):
        options = _snapshots.options(name, metadata, commit_message)
        if polling_config is not None:
            budget = polling_config.interval_seconds * polling_config.max_attempts
            if polling_config.timeout_seconds is not None:
                budget = min(budget, polling_config.timeout_seconds)
            positive(budget, "snapshot polling timeout")
            timeout = budget if timeout is None else min(timeout, budget)
        with request_scope(timeout):
            sb = await self._sandbox()
            snapshot = await sb.snapshot(**options, idempotency_key=idempotency_key)
        _snapshots.view(snapshot)
        return AsyncSnapshot(self._runtime, snapshot['id'])

    async def snapshot_disk_async(self, **params):
        _snapshots.options(**params)
        raise CompatibilityError('Asynchronous Runloop disk capture requires durable server-owned source resume coordination')

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.shutdown()


class AsyncDevboxOps:
    def __init__(self, runtime):
        self._runtime = runtime

    async def create(self, *, name=None, environment_variables=None, metadata=None, file_mounts=None,
                     snapshot_id=None, blueprint_id=None, blueprint_name=None, launch_parameters=None, **options):
        reject(options, "Runloop create")
        if sum(bool(v) for v in (snapshot_id, blueprint_id, blueprint_name)) > 1:
            raise ValueError("Only one snapshot or blueprint may be supplied")
        p = dict(launch_parameters or {})
        allowed = {"custom_cpu_cores", "custom_gb_memory", "custom_disk_size", "keep_alive_time_seconds", "launch_commands", "architecture"}
        reject({k: v for k, v in p.items() if k not in allowed}, "Runloop launch_parameters")
        if p.get("architecture", "x86_64") != "x86_64":
            raise CompatibilityError("Runtime currently supports x86_64 images")
        fields = {"timeout_seconds": 3600}
        for old, new, scale in (("custom_cpu_cores", "vcpu", 1), ("custom_gb_memory", "memory_mib", 1024),
                                ("custom_disk_size", "disk_mib", 1024), ("keep_alive_time_seconds", "timeout_seconds", 1)):
            if p.get(old) is not None:
                fields[new] = positive(p[old] * scale, old, integral=True)
        env = environment(json.dumps(environment_variables or {}).encode())
        if snapshot_id:
            _snapshots.view(await self._runtime.snapshots.get(snapshot_id))
        sb = await self._runtime.sandboxes.create(name=name, labels={**(metadata or {}), "compat.provider": "runloop"},
            snapshot=snapshot_id, image=blueprint_id or blueprint_name, pausable=True, idle_pause_seconds=0, on_lease_end="stop", **fields)
        try:
            # A clone inherits the saved environment unless a caller replaces it.
            if not snapshot_id or environment_variables is not None:
                await sb.files.write(ENV_PATH, json.dumps(env), mode=0o600)
            for path, content in (file_mounts or {}).items():
                await sb.files.write(path, content)
            for command in p.get("launch_commands") or []:
                result = await sb.exec(command, env=await AsyncDevbox(self._runtime, sb.id)._env(sb))
                if result.exit_code != 0 or result.timed_out:
                    raise CompatibilityError(f"Launch command failed: {result.stderr}")
        except BaseException as original:
            try:
                await sb.stop()
            except BaseException as cleanup:
                raise original from cleanup
            raise
        return AsyncDevbox(self._runtime, sb.id)

    async def create_from_blueprint_id(self, blueprint_id, **params):
        return await self.create(blueprint_id=blueprint_id, **params)

    async def create_from_blueprint_name(self, blueprint_name, **params):
        return await self.create(blueprint_name=blueprint_name, **params)

    async def create_from_snapshot(self, snapshot_id, **params):
        return await self.create(snapshot_id=snapshot_id, **params)

    def from_id(self, devbox_id):
        return AsyncDevbox(self._runtime, devbox_id)

    async def list(self, *, name=None, limit=None):
        return [AsyncDevbox(self._runtime, sb.id) async for sb in await self._runtime.sandboxes.list(
            name=name, limit=limit, labels={"compat.provider": "runloop"})]


class AsyncSnapshotOps:
    def __init__(self, runtime): self._runtime = runtime
    def from_id(self, snapshot_id): return AsyncSnapshot(self._runtime, snapshot_id)
    async def list(self, **params):
        page = await AsyncDiskSnapshotsAPI(self._runtime).list(**params)
        return [self.from_id(item.id) for item in page.snapshots]


class AsyncRunloopSDK:
    def __init__(self, *, bearer_token=None, base_url=None, timeout=300, max_retries=5, runtime=None, **options):
        reject(options, "Runloop client")
        self._runtime = runtime or AsyncRuntime(api_key=runtime_key(bearer_token), timeout=timeout, max_retries=max_retries)
        self.devbox = AsyncDevboxOps(self._runtime)
        self.snapshot = AsyncSnapshotOps(self._runtime)
        self.api = AsyncRunloop(runtime=self._runtime)

    async def close(self):
        await self._runtime.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()


class AsyncBinaryResponse:
    def __init__(self, data):
        self.content = data

    async def read(self):
        return self.content

    async def write_to_file(self, path):
        Path(path).write_bytes(self.content)


class AsyncDevboxesPage:
    def __init__(self, items):
        self.devboxes = items
        self.data = items

    def has_next_page(self):
        return False

    def __aiter__(self):
        async def iterate():
            for item in self.devboxes:
                yield item
        return iterate()


class AsyncExecutionsAPI:
    def __init__(self, runtime):
        self._runtime = runtime

    async def _process(self, execution_id, devbox_id):
        sb = await self._runtime.sandboxes.get(devbox_id)
        return await sb.process(execution_id)

    async def retrieve(self, execution_id, *, devbox_id):
        process = await self._process(execution_id, devbox_id)
        return await AsyncExecution(devbox_id, process).get_state()

    async def await_completed(self, execution_id, *, devbox_id):
        process = await self._process(execution_id, devbox_id)
        return (await AsyncExecution(devbox_id, process).result()).result

    async def kill(self, execution_id, *, devbox_id):
        process = await self._process(execution_id, devbox_id)
        await process.kill("SIGKILL")
        return await self.retrieve(execution_id, devbox_id=devbox_id)

    async def _stream(self, execution_id, devbox_id, channel, offset):
        process = await self._process(execution_id, devbox_id)
        async def events():
            async for event in process.output(cursor=int(offset or 0)):
                if event["type"] == channel:
                    yield Model(output=event["data"], offset=event.get("offset"))
                elif event["type"] == "truncated":
                    raise IOError("Runloop execution output was truncated")
        return events()

    async def stream_stdout_updates(self, execution_id, *, devbox_id, offset=None):
        return await self._stream(execution_id, devbox_id, "stdout", offset)

    async def stream_stderr_updates(self, execution_id, *, devbox_id, offset=None):
        return await self._stream(execution_id, devbox_id, "stderr", offset)


class AsyncSnapshotsPage:
    def __init__(self, items, remaining, total, fetch):
        self.snapshots, self.data = items, items
        self.has_more, self.total_count, self._fetch = remaining, total, fetch
    def has_next_page(self): return self.has_more
    async def get_next_page(self):
        if not self.has_more: raise RuntimeError('No more pages')
        return await self._fetch(self.snapshots[-1].id)
    def __aiter__(self):
        async def iterate():
            page = self
            while True:
                for item in page.snapshots: yield item
                if not page.has_next_page(): break
                page = await page.get_next_page()
        return iterate()


class AsyncDiskSnapshotsAPI:
    def __init__(self, runtime): self._runtime = runtime
    async def query_status(self, id, **options): return await AsyncSnapshot(self._runtime, id).get_info(**options)
    async def update(self, id, **fields): return await AsyncSnapshot(self._runtime, id).update(**fields)
    async def delete(self, id, **options): return await AsyncSnapshot(self._runtime, id).delete(**options)
    async def await_completed(self, id, **options): return await AsyncSnapshot(self._runtime, id).await_completed(**options)

    async def list(self, *, devbox_id=None, include_total_count=True, limit=20, starting_after=None,
                   source_blueprint_id=None, metadata_key=None, metadata_key_in=None, timeout=None):
        positive(limit, 'limit', integral=True)
        if limit > 5000: raise ValueError('limit must be at most 5000')
        values = []
        with request_scope(timeout):
            async for item in await self._runtime.snapshots.list(sandbox_id=devbox_id):
                if item.get('mode') != 'disk' or (item.get('labels') or {}).get('compat.provider') != 'runloop': continue
                value = _snapshots.view(item)
                if source_blueprint_id is not None and value.source_blueprint_id != source_blueprint_id: continue
                if metadata_key is not None and value.metadata.get('key') != metadata_key: continue
                if metadata_key_in is not None and value.metadata.get('key') not in metadata_key_in.split(','): continue
                values.append(value)
        first = 0
        if starting_after is not None:
            found = next((i for i, item in enumerate(values) if item.id == starting_after), None)
            if found is None: raise ValueError('starting_after does not identify a matching snapshot')
            first = found + 1
        data = values[first:first + limit]
        async def fetch(after):
            return await self.list(devbox_id=devbox_id, include_total_count=include_total_count, limit=limit,
                starting_after=after, source_blueprint_id=source_blueprint_id, metadata_key=metadata_key,
                metadata_key_in=metadata_key_in, timeout=timeout)
        return AsyncSnapshotsPage(data, first + len(data) < len(values), len(values) if include_total_count else 0, fetch)


class AsyncDevboxesAPI:
    def __init__(self, runtime):
        self._runtime = runtime
        self._ops = AsyncDevboxOps(runtime)
        self.executions = AsyncExecutionsAPI(runtime)
        self.disk_snapshots = AsyncDiskSnapshotsAPI(runtime)

    async def create(self, **params):
        return await (await self._ops.create(**params)).get_info()

    create_and_await_running = create

    async def retrieve(self, id):
        return await self._ops.from_id(id).get_info()

    async def await_running(self, id, *, polling_config=None):
        return await self._ops.from_id(id).await_running(polling_config=polling_config)

    async def list(self, *, name=None, limit=None):
        items = await self._ops.list(name=name, limit=limit)
        return AsyncDevboxesPage([await box.get_info() for box in items])

    async def execute_sync(self, id, *, command, **params):
        return (await self._ops.from_id(id).cmd.exec(command, **params)).result

    async def execute_async(self, id, *, command, **params):
        execution = await self._ops.from_id(id).cmd.exec_async(command, **params)
        return Model(devbox_id=id, execution_id=execution.execution_id, status="running", exit_status=None)

    async def read_file_contents(self, id, *, file_path):
        return await self._ops.from_id(id).file.read(file_path=file_path)

    async def write_file_contents(self, id, *, file_path, contents):
        return await self._ops.from_id(id).file.write(file_path=file_path, contents=contents)

    async def download_file(self, id, *, path):
        return AsyncBinaryResponse(await self._ops.from_id(id).file.download(path=path))

    async def upload_file(self, id, *, path, file):
        return await self._ops.from_id(id).file.upload(path=path, file=file)

    async def shutdown(self, id):
        return await self._ops.from_id(id).shutdown()

    async def suspend(self, id):
        return await self._ops.from_id(id).suspend()

    async def resume(self, id):
        return await self._ops.from_id(id).resume()

    async def keep_alive(self, id):
        sb = await self._runtime.sandboxes.get(id)
        await sb.extend(3600)
        return await self.retrieve(id)

    async def snapshot_disk(self, id, **params):
        snapshot = await self._ops.from_id(id).snapshot_disk(**params)
        return (await snapshot.get_info()).snapshot

    async def snapshot_disk_async(self, id, **params):
        return await self._ops.from_id(id).snapshot_disk_async(**params)


class AsyncRunloop:
    """Runloop's generated REST-client sandbox namespace."""
    def __init__(self, *, bearer_token=None, base_url=None, timeout=300, max_retries=5, runtime=None, **options):
        reject(options, "Runloop client")
        self._runtime = runtime or AsyncRuntime(api_key=runtime_key(bearer_token), timeout=timeout, max_retries=max_retries)
        self.devboxes = AsyncDevboxesAPI(self._runtime)

    async def close(self):
        await self._runtime.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()
