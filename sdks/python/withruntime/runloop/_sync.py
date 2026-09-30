"""Runloop sandbox APIs pinned to runloop-api-client 1.32.0."""
from __future__ import annotations
import json
import asyncio
import time
import math
from pathlib import Path
from .. import Runtime
from .._compat import runtime_key, named_shell, CompatibilityError, ENV_PATH, Model, environment, positive, reject
from .._errors import RuntimeError as SDKError
from .._compat_shell import SHELL_BROKER
from .._compat_lifecycle import LifecycleLock
from ._exceptions import RunloopError
from .lib.polling import PollingConfig, PollingTimeout
from . import _snapshots
from .._request_scope import request_scope

_SUSPENDED = "compat.runloop.suspended"


class ExecutionResult:
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

    def _output(self, channel, num_lines):
        value = getattr(self._result, channel, None) or ""
        truncated = getattr(self._result, channel + "_truncated", False)
        if truncated and (num_lines is None or sum(bool(line) for line in value.rstrip("\n").split("\n")) < num_lines):
            stream = getattr(self._client.devboxes.executions, "stream_" + channel + "_updates")(
                self.execution_id, devbox_id=self.devbox_id)
            value = "".join([chunk.output for chunk in stream])
        return self._lines(value, num_lines)

    def stdout(self, num_lines=None):
        return self._output("stdout", num_lines)

    def stderr(self, num_lines=None):
        return self._output("stderr", num_lines)

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


class Execution:
    def __init__(self, devbox_id, process):
        self.devbox_id, self._process, self.execution_id = devbox_id, process, process.id
        self._result = None

    def result(self):
        if self._result is None:
            self._result = ExecutionResult(self.devbox_id, self._process.wait())
        return self._result

    def get_state(self):
        info = self._process.refresh()
        return Model(devbox_id=self.devbox_id, execution_id=self.execution_id,
                     status="completed" if info.get("state") == "exited" else "running",
                     exit_status=info.get("exitCode"))

    def kill(self):
        self._process.kill("SIGKILL")


class CommandInterface:
    def __init__(self, devbox):
        self._devbox = devbox

    def _command(self, sb, command, shell_name):
        if not shell_name:
            return command
        folder, _ = named_shell(command, shell_name)
        sb.files.mkdir(folder, parents=True)
        script = "/workspace/.runtime-compat/shell.py"
        sb.files.write(script, SHELL_BROKER, mode=0o600)
        return ["python3", script, "client", folder, json.dumps({"command": command, "env": {},
            "baseEnv": self._devbox._env(sb)})]

    def exec(self, command, *, stdout=None, stderr=None, output=None, shell_name=None, idempotency_key=None, **options):
        reject(options, "Runloop command")
        sb = self._devbox._sandbox()
        command = self._command(sb, command, shell_name)
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
        result = sb.exec(command, env=self._devbox._env(sb), on_stdout=on_stdout, on_stderr=on_stderr,
                               idempotency_key=idempotency_key)
        return ExecutionResult(sb.id, result)

    def exec_async(self, command, *, shell_name=None, attach_stdin=False, **options):
        reject(options, "Runloop background command")
        if attach_stdin and shell_name:
            raise CompatibilityError("Interactive stdin for named shells requires a shell broker stdin channel")
        sb = self._devbox._sandbox()
        command = self._command(sb, command, shell_name)
        return Execution(sb.id, sb.spawn(command, env=self._devbox._env(sb),
                                                    stdin="pipe" if attach_stdin else None))


class NamedShell:
    def __init__(self, devbox, name):
        self._devbox, self._name = devbox, name

    def exec(self, command, **params):
        params["shell_name"] = self._name
        return self._devbox.cmd.exec(command, **params)

    def exec_async(self, command, **params):
        params["shell_name"] = self._name
        return self._devbox.cmd.exec_async(command, **params)


class FileInterface:
    def __init__(self, devbox):
        self._devbox = devbox

    def read(self, *, file_path):
        sb = self._devbox._sandbox()
        return (sb.files.read(file_path)).decode()

    def write(self, *, file_path, contents):
        sb = self._devbox._sandbox()
        sb.files.write(file_path, contents)
        return Model(devbox_id=sb.id, exit_status=0, stdout="", stderr="")

    def download(self, *, path):
        sb = self._devbox._sandbox()
        return sb.files.read(path)

    def upload(self, *, path, file):
        sb = self._devbox._sandbox()
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
        sb.files.write(path, data)
        return {}


class Snapshot:
    def __init__(self, runtime, snapshot_id):
        self._runtime, self.id = runtime, snapshot_id

    def get_info(self, *, timeout=None):
        with request_scope(timeout):
            return _snapshots.status(self._runtime.snapshots.get(self.id))

    def delete(self, *, timeout=None):
        with request_scope(timeout):
            _snapshots.view(self._runtime.snapshots.get(self.id))
            self._runtime.snapshots.delete(self.id)
        return {}

    def update(self, *, timeout=None, idempotency_key=None, **fields):
        reject({k: v for k, v in fields.items() if k not in ('name', 'metadata', 'commit_message')}, 'Runloop snapshot update')
        # Validate before reading or mutating anything; null clears a supplied field.
        _snapshots.options(**fields)
        with request_scope(timeout):
            for attempt in range(3):
                source = self._runtime.snapshots.get(self.id)
                previous = _snapshots.view(source)
                body = {key: fields.get(key, previous.get(key)) for key in ('name', 'metadata', 'commit_message')}
                try:
                    updated = self._runtime.snapshots.update(self.id, labels=_snapshots.options(**body)['labels'],
                        if_labels=source.get('labels') or {}, idempotency_key=idempotency_key)
                    return _snapshots.view(updated)
                except SDKError as error:
                    if error.code != 'snapshot_metadata_changed' or attempt == 2:
                        raise

    def await_completed(self, *, polling_config=None, timeout=None):
        config, last = polling_config or PollingConfig(), None
        start, attempts = time.monotonic(), 0
        while True:
            last = self.get_info(timeout=timeout)
            if last.status == 'complete': return last
            if last.status == 'error':
                raise RunloopError(f'Snapshot {self.id} failed: {last.error_message or "Unknown error"}')
            attempts += 1
            if attempts >= config.max_attempts:
                raise PollingTimeout(f'Exceeded maximum attempts ({config.max_attempts})', last)
            if config.timeout_seconds is not None and time.monotonic() - start >= config.timeout_seconds:
                raise PollingTimeout(f'Exceeded timeout of {config.timeout_seconds} seconds', last)
            time.sleep(config.interval_seconds)

    def create_devbox(self, **params):
        return DevboxOps(self._runtime).create(snapshot_id=self.id, **params)


class Devbox:
    def __init__(self, runtime, devbox_id):
        self._runtime, self.id = runtime, devbox_id
        self.cmd, self.file = CommandInterface(self), FileInterface(self)
        self._lifecycle_lock = LifecycleLock(runtime, devbox_id)

    def shell(self, shell_name=None):
        import uuid
        return NamedShell(self, shell_name if shell_name is not None else str(uuid.uuid4()))

    def _sandbox(self):
        return self._runtime.sandboxes.get(self.id)

    def _env(self, sb):
        try:
            data = sb.files.read(ENV_PATH)
        except SDKError as error:
            if error.status != 404:
                raise
            data = b"{}"
        return environment(data)

    def get_info(self):
        sb = self._sandbox()
        suspended = sb.info.get("labels", {}).get(_SUSPENDED) == "true"
        return Model(id=sb.id, name=sb.info.get("name"),
                     status=("suspended" if sb.state == "stopped" and suspended else
                             "resuming" if sb.state == "starting" and suspended else
                             "suspending" if sb.state == "stopping" and suspended else
                             {"running": "running", "stopped": "shutdown", "starting": "initializing", "failed": "failure"}.get(sb.state, sb.state)),
                     metadata={k: v for k, v in sb.info.get("labels", {}).items() if not k.startswith("compat.")})

    def shutdown(self):
        self._lifecycle_lock.acquire()
        try:
            sb = self._sandbox()
            sb.stop()
            if sb.state != "stopped":
                sb.wait_for("stopped")
            if sb.info.get("persistent") or _SUSPENDED in sb.info.get("labels", {}):
                sb.update(persistent=False, labels={k: v for k, v in sb.info.get("labels", {}).items() if k != _SUSPENDED})
            return self.get_info()
        finally:
            self._lifecycle_lock.release()

    close = shutdown

    def suspend(self):
        self._lifecycle_lock.acquire()
        try:
            sb = self._sandbox()
            if sb.state == "stopped" and sb.info.get("labels", {}).get(_SUSPENDED) == "true":
                return self.get_info()
            if sb.state != "running":
                raise CompatibilityError(f"Cannot suspend a devbox in native state {sb.state!r}")
            # ARCHITECTURE.md section 10: retention must be admitted before stop.
            # A failed stop leaves the retained disk recoverable; never roll it
            # back to ephemeral storage while the stop result is uncertain.
            sb.update(persistent=True, labels={**sb.info.get("labels", {}), _SUSPENDED: "true"})
            sb.stop()
            if sb.state != "stopped":
                sb.wait_for("stopped")
            return self.get_info()
        finally:
            self._lifecycle_lock.release()

    def resume(self):
        return self._resume(True)

    def resume_async(self):
        return self._resume(False)

    def _resume(self, wait):
        self._lifecycle_lock.acquire()
        try:
            sb = self._sandbox()
            marked = sb.info.get("labels", {}).get(_SUSPENDED) == "true"
            if sb.state != "running" and not marked:
                raise CompatibilityError("This devbox does not have a retained Runloop suspension")
            if sb.state == "stopped":
                sb.restart(wait=wait)
            elif sb.state not in ("running", "starting"):
                raise CompatibilityError(f"Cannot resume a devbox in native state {sb.state!r}")
            if wait and sb.state != "running":
                sb.wait_for("running")
            if sb.state == "running" and marked:
                sb.update(labels={k: v for k, v in sb.info.get("labels", {}).items() if k != _SUSPENDED})
            return self.get_info()
        finally:
            self._lifecycle_lock.release()

    def _await_status(self, target, polling_config):
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
            last = self.get_info()
            if last.status == target:
                return last
            if last.status in ("failure", "shutdown", "suspended", "paused"):
                raise RunloopError(f"Devbox entered non-{target} terminal state: {last.status}")
            time.sleep(min(max(config.interval_seconds, 0.01), remaining))

    def await_running(self, *, polling_config=None):
        return self._await_status("running", polling_config)

    def await_suspended(self, *, polling_config=None):
        return self._await_status("suspended", polling_config)

    def snapshot_disk(self, *, name=None, metadata=None, commit_message=None, polling_config=None,
                            timeout=None, idempotency_key=None):
        options = _snapshots.options(name, metadata, commit_message)
        if polling_config is not None:
            budget = polling_config.interval_seconds * polling_config.max_attempts
            if polling_config.timeout_seconds is not None:
                budget = min(budget, polling_config.timeout_seconds)
            positive(budget, "snapshot polling timeout")
            timeout = budget if timeout is None else min(timeout, budget)
        with request_scope(timeout):
            sb = self._sandbox()
            snapshot = sb.snapshot(**options, idempotency_key=idempotency_key)
        _snapshots.view(snapshot)
        return Snapshot(self._runtime, snapshot['id'])

    def snapshot_disk_async(self, **params):
        _snapshots.options(**params)
        raise CompatibilityError('Asynchronous Runloop disk capture requires durable server-owned source resume coordination')

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.shutdown()


class DevboxOps:
    def __init__(self, runtime):
        self._runtime = runtime

    def create(self, *, name=None, environment_variables=None, metadata=None, file_mounts=None,
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
            _snapshots.view(self._runtime.snapshots.get(snapshot_id))
        sb = self._runtime.sandboxes.create(name=name, labels={**(metadata or {}), "compat.provider": "runloop"},
            snapshot=snapshot_id, image=blueprint_id or blueprint_name, pausable=True, idle_pause_seconds=0, on_lease_end="stop", **fields)
        try:
            # A clone inherits the saved environment unless a caller replaces it.
            if not snapshot_id or environment_variables is not None:
                sb.files.write(ENV_PATH, json.dumps(env), mode=0o600)
            for path, content in (file_mounts or {}).items():
                sb.files.write(path, content)
            for command in p.get("launch_commands") or []:
                result = sb.exec(command, env=Devbox(self._runtime, sb.id)._env(sb))
                if result.exit_code != 0 or result.timed_out:
                    raise CompatibilityError(f"Launch command failed: {result.stderr}")
        except BaseException as original:
            try:
                sb.stop()
            except BaseException as cleanup:
                raise original from cleanup
            raise
        return Devbox(self._runtime, sb.id)

    def create_from_blueprint_id(self, blueprint_id, **params):
        return self.create(blueprint_id=blueprint_id, **params)

    def create_from_blueprint_name(self, blueprint_name, **params):
        return self.create(blueprint_name=blueprint_name, **params)

    def create_from_snapshot(self, snapshot_id, **params):
        return self.create(snapshot_id=snapshot_id, **params)

    def from_id(self, devbox_id):
        return Devbox(self._runtime, devbox_id)

    def list(self, *, name=None, limit=None):
        return [Devbox(self._runtime, sb.id) for sb in self._runtime.sandboxes.list(
            name=name, limit=limit, labels={"compat.provider": "runloop"})]


class SnapshotOps:
    def __init__(self, runtime): self._runtime = runtime
    def from_id(self, snapshot_id): return Snapshot(self._runtime, snapshot_id)
    def list(self, **params):
        page = DiskSnapshotsAPI(self._runtime).list(**params)
        return [self.from_id(item.id) for item in page.snapshots]


class RunloopSDK:
    def __init__(self, *, bearer_token=None, base_url=None, timeout=300, max_retries=5, runtime=None, **options):
        reject(options, "Runloop client")
        self._runtime = runtime or Runtime(api_key=runtime_key(bearer_token), timeout=timeout, max_retries=max_retries)
        self.devbox = DevboxOps(self._runtime)
        self.snapshot = SnapshotOps(self._runtime)
        self.api = Runloop(runtime=self._runtime)

    def close(self):
        self._runtime.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class BinaryResponse:
    def __init__(self, data):
        self.content = data

    def read(self):
        return self.content

    def write_to_file(self, path):
        Path(path).write_bytes(self.content)


class DevboxesPage:
    def __init__(self, items):
        self.devboxes = items
        self.data = items

    def has_next_page(self):
        return False

    def __iter__(self):
        def iterate():
            for item in self.devboxes:
                yield item
        return iterate()


class ExecutionsAPI:
    def __init__(self, runtime):
        self._runtime = runtime

    def _process(self, execution_id, devbox_id):
        sb = self._runtime.sandboxes.get(devbox_id)
        return sb.process(execution_id)

    def retrieve(self, execution_id, *, devbox_id):
        process = self._process(execution_id, devbox_id)
        return Execution(devbox_id, process).get_state()

    def await_completed(self, execution_id, *, devbox_id):
        process = self._process(execution_id, devbox_id)
        return (Execution(devbox_id, process).result()).result

    def kill(self, execution_id, *, devbox_id):
        process = self._process(execution_id, devbox_id)
        process.kill("SIGKILL")
        return self.retrieve(execution_id, devbox_id=devbox_id)

    def _stream(self, execution_id, devbox_id, channel, offset):
        process = self._process(execution_id, devbox_id)
        def events():
            for event in process.output(cursor=int(offset or 0)):
                if event["type"] == channel:
                    yield Model(output=event["data"], offset=event.get("offset"))
                elif event["type"] == "truncated":
                    raise IOError("Runloop execution output was truncated")
        return events()

    def stream_stdout_updates(self, execution_id, *, devbox_id, offset=None):
        return self._stream(execution_id, devbox_id, "stdout", offset)

    def stream_stderr_updates(self, execution_id, *, devbox_id, offset=None):
        return self._stream(execution_id, devbox_id, "stderr", offset)


class SnapshotsPage:
    def __init__(self, items, remaining, total, fetch):
        self.snapshots, self.data = items, items
        self.has_more, self.total_count, self._fetch = remaining, total, fetch
    def has_next_page(self): return self.has_more
    def get_next_page(self):
        if not self.has_more: raise RuntimeError('No more pages')
        return self._fetch(self.snapshots[-1].id)
    def __iter__(self):
        def iterate():
            page = self
            while True:
                for item in page.snapshots: yield item
                if not page.has_next_page(): break
                page = page.get_next_page()
        return iterate()


class DiskSnapshotsAPI:
    def __init__(self, runtime): self._runtime = runtime
    def query_status(self, id, **options): return Snapshot(self._runtime, id).get_info(**options)
    def update(self, id, **fields): return Snapshot(self._runtime, id).update(**fields)
    def delete(self, id, **options): return Snapshot(self._runtime, id).delete(**options)
    def await_completed(self, id, **options): return Snapshot(self._runtime, id).await_completed(**options)

    def list(self, *, devbox_id=None, include_total_count=True, limit=20, starting_after=None,
                   source_blueprint_id=None, metadata_key=None, metadata_key_in=None, timeout=None):
        positive(limit, 'limit', integral=True)
        if limit > 5000: raise ValueError('limit must be at most 5000')
        values = []
        with request_scope(timeout):
            for item in self._runtime.snapshots.list(sandbox_id=devbox_id):
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
        def fetch(after):
            return self.list(devbox_id=devbox_id, include_total_count=include_total_count, limit=limit,
                starting_after=after, source_blueprint_id=source_blueprint_id, metadata_key=metadata_key,
                metadata_key_in=metadata_key_in, timeout=timeout)
        return SnapshotsPage(data, first + len(data) < len(values), len(values) if include_total_count else 0, fetch)


class DevboxesAPI:
    def __init__(self, runtime):
        self._runtime = runtime
        self._ops = DevboxOps(runtime)
        self.executions = ExecutionsAPI(runtime)
        self.disk_snapshots = DiskSnapshotsAPI(runtime)

    def create(self, **params):
        return (self._ops.create(**params)).get_info()

    create_and_await_running = create

    def retrieve(self, id):
        return self._ops.from_id(id).get_info()

    def await_running(self, id, *, polling_config=None):
        return self._ops.from_id(id).await_running(polling_config=polling_config)

    def list(self, *, name=None, limit=None):
        items = self._ops.list(name=name, limit=limit)
        return DevboxesPage([box.get_info() for box in items])

    def execute_sync(self, id, *, command, **params):
        return (self._ops.from_id(id).cmd.exec(command, **params)).result

    def execute_async(self, id, *, command, **params):
        execution = self._ops.from_id(id).cmd.exec_async(command, **params)
        return Model(devbox_id=id, execution_id=execution.execution_id, status="running", exit_status=None)

    def read_file_contents(self, id, *, file_path):
        return self._ops.from_id(id).file.read(file_path=file_path)

    def write_file_contents(self, id, *, file_path, contents):
        return self._ops.from_id(id).file.write(file_path=file_path, contents=contents)

    def download_file(self, id, *, path):
        return BinaryResponse(self._ops.from_id(id).file.download(path=path))

    def upload_file(self, id, *, path, file):
        return self._ops.from_id(id).file.upload(path=path, file=file)

    def shutdown(self, id):
        return self._ops.from_id(id).shutdown()

    def suspend(self, id):
        return self._ops.from_id(id).suspend()

    def resume(self, id):
        return self._ops.from_id(id).resume()

    def keep_alive(self, id):
        sb = self._runtime.sandboxes.get(id)
        sb.extend(3600)
        return self.retrieve(id)

    def snapshot_disk(self, id, **params):
        snapshot = self._ops.from_id(id).snapshot_disk(**params)
        return (snapshot.get_info()).snapshot

    def snapshot_disk_async(self, id, **params):
        return self._ops.from_id(id).snapshot_disk_async(**params)


class Runloop:
    """Runloop's generated REST-client sandbox namespace."""
    def __init__(self, *, bearer_token=None, base_url=None, timeout=300, max_retries=5, runtime=None, **options):
        reject(options, "Runloop client")
        self._runtime = runtime or Runtime(api_key=runtime_key(bearer_token), timeout=timeout, max_retries=max_retries)
        self.devboxes = DevboxesAPI(self._runtime)

    def close(self):
        self._runtime.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
