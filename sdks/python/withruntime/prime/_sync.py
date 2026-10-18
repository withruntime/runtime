"""Generated synchronous Prime sandbox adapter. Contract: prime-sandboxes 0.4.6."""
from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
import uuid
import re
import time
import asyncio
from typing import Any
from .. import Runtime
from .._errors import RuntimeError as SDKError
from .._compat import runtime_key, CompatibilityError, Model, ENV_PATH, dockerfile, environment, positive, reject, values
from .models import (CreateSandboxRequest, Sandbox, SandboxListResponse, CommandResponse, FileUploadResponse, ReadFileResponse, BackgroundJob, BackgroundJobStatus, BackgroundJobStatusSnapshot, SandboxStatusSnapshot, SandboxStatusLookupError,
    BatchSandboxStatusResponse, BulkDeleteSandboxResponse, EgressPolicyStatus, SandboxEgressPolicy, _validate_egress_lists,
    SandboxCheckpoint, CheckpointLookupError, BatchCheckpointResponse, CheckpointDeleteError, DeleteSandboxCheckpointsResponse)

from .exceptions import APIError, CommandTimeoutError, DownloadTimeoutError, UploadTimeoutError
from contextlib import contextmanager
from .._request_scope import request_scope

def _validate_guest_user(user):
    if user == "":
        raise ValueError("user must be a non-empty guest username")
    if user is not None:
        raise CompatibilityError("Prime named guest users are not yet supported on Runtime")

#: Where the start command's output goes, for get_logs.
START_LOG = "/tmp/.prime-start.log"


@contextmanager
def _deadline(error, sandbox_id, file_path, timeout):
    """A transfer's ``timeout`` in seconds: past it the request ends and Prime's
    error is raised. An upload past it writes nothing (Runtime writes whole
    files or aborts the upload); a download leaves no partial local file."""
    if timeout is None:
        yield
        return
    positive(timeout, "timeout")
    try:
        with request_scope(timeout):
            yield
    except (TimeoutError, asyncio.TimeoutError) as cause:
        raise error(sandbox_id, file_path, timeout) from cause


def _network_rules(allow, deny):
    """Prime's set_network lists as Runtime's network rules: one list, "*" alone
    for every destination. Runtime opens the public web on ports 80 and 443."""
    if (allow is None) == (deny is None):
        raise ValueError("exactly one of allow or deny must be provided")
    entries = list(allow if allow is not None else deny)
    if not entries:
        raise ValueError("allow or deny must contain at least one destination")
    if "*" in entries:
        if entries != ["*"]:
            raise ValueError("'*' must be the only destination")
        return {"internet": allow is not None}
    _validate_egress_lists(entries if allow is not None else None, entries if deny is not None else None)
    return {"internet": True, "allow" if allow is not None else "deny": entries}


def _egress_status(policy):
    """Runtime's network rules as Prime's policy. Runtime applies a change at
    once, so the policy read is the policy applied."""
    if policy.get("connect") or (policy.get("allow") and policy.get("deny")):
        raise CompatibilityError("Prime network policies hold one list; read open ports and mixed lists "
                                 "with sandbox.network.get() on the native client")
    if not policy.get("internet"):
        rules = SandboxEgressPolicy(allowlist=[], denylist=None)
    elif policy.get("allow"):
        rules = SandboxEgressPolicy(allowlist=list(policy["allow"]), denylist=None)
    else:
        rules = SandboxEgressPolicy(allowlist=None, denylist=list(policy.get("deny") or []))
    updated = policy.get("updatedAt")
    generation = int(datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp() * 1000) if updated else 0
    return EgressPolicyStatus(policy=rules, generation=generation, applied_generation=generation, applied=True)


#: A Runtime snapshot's state as a Prime checkpoint's. Only DURABLE restores.
_CHECKPOINT_STATES = {"capturing": "PENDING", "ready": "DURABLE", "failed": "FAILED", "deleting": "DELETING",
                      "deleted": "DELETING"}

_LAN = ("Prime LAN networks are not supported: Runtime cannot limit which of your sandboxes reach each other "
        "by network, tag or port. runtime.networks.private.set(enabled=True) lets all of your sandboxes reach "
        "each other at <id>.sandbox.internal; leave it off to keep them apart")


def _checkpoint(snapshot):
    """A Runtime disk-only snapshot as Prime's filesystem checkpoint. Each one
    stands alone, needing no other to restore: no parent, depth 1."""
    labels = snapshot.get("labels") or {}
    disk = (snapshot.get("shape") or {}).get("diskMiB")
    created = snapshot.get("createdAt")
    return SandboxCheckpoint(id=snapshot["id"], sandbox_id=snapshot["sourceSandboxId"], parent_id=None, team_id=None,
        state=_CHECKPOINT_STATES.get(snapshot["state"], str(snapshot["state"]).upper()), depth=1,
        docker_image=labels.get("compat.image", ""), disk_size_bytes=disk * 1024 * 1024 if disk else None,
        stored_bytes=snapshot.get("storedBytes"), error=snapshot.get("error"), created_at=created,
        updated_at=snapshot.get("readyAt") or created)


def _validate_ids(values, name):
    if not isinstance(values, list) or not values or len(values) > 100:
        raise ValueError(f"{name} must contain between 1 and 100 entries")
    if len(set(values)) != len(values):
        raise ValueError(f"{name} must be unique")
    if any(not isinstance(value, str) or not value or len(value) > 64 for value in values):
        raise ValueError(f"{name} must contain IDs between 1 and 64 characters")


#: The job's shell writes its PID first: a job that cannot (a full disk) never
#: runs, and the launch says so. The subshell captures an explicit `exit`; the
#: outer shell writes the status. Positional arguments keep paths and the user
#: command apart from the source.
_JOB = ('printf "%s\\n" "$$" > "$6" || exit 1; '
        '(if [ -n "$5" ]; then cd -- "$5" || exit; fi; bash -c "$4") > "$1" 2> "$2"; printf "%s\\n" "$?" > "$3"')
#: Waits up to 10 s for the job's PID file. 1: the job's process (gone or a
#: zombie) ended without writing one. 2: none in time.
_LAUNCH = ('i=0; while [ "$i" -lt 200 ]; do grep -qs . "$1" && exit 0; '
           'if [ -n "$2" ] && { [ ! -d "/proc/$2" ] || grep -qs "^State:[[:space:]]*Z" "/proc/$2/status"; }; then '
           'grep -qs . "$1" && exit 0; '
           'echo "the job exited before it started" >&2; exit 1; fi; sleep 0.05; i=$((i + 1)); done; '
           'echo "the job did not start within 10 s" >&2; exit 2')
#: Prints the exit code, nothing while the job runs, or "lost" when it died
#: without one. An exit file counts only once it has content (a full disk can
#: leave it empty). The job is alive while its PID's cmdline still names its
#: exit file, which rules out zombies and reused PIDs; the exit file is read
#: again after, as the job writes it just before it exits. A job with no PID
#: file, started by an older adapter, reads as running, as it did then.
_STATUS = ('grep -s . "$1" && exit; [ -s "$2" ] || exit 0; '
           'grep -qF -- "$1" "/proc/$(cat "$2")/cmdline" 2>/dev/null && exit; grep -s . "$1" || echo lost')


def _validate_background_output_limits(concurrency, queue_size, cache_bytes):
    if concurrency <= 0:
        raise ValueError("background_job_output_concurrency must be positive")
    if queue_size <= 0:
        raise ValueError("background_job_output_queue_size must be positive")
    if cache_bytes < 0:
        raise ValueError("background_job_output_cache_bytes must be non-negative")
    if (concurrency, queue_size, cache_bytes) != (20, 200, 64 * 1024 * 1024):
        raise CompatibilityError("Custom background output limits require the background-job adapter")


class SandboxClient:
    def __init__(self, api_client=None, *, api_key=None, base_url=None,
                 background_job_output_concurrency=20, background_job_output_queue_size=200,
                 background_job_output_cache_bytes=64 * 1024 * 1024):
        _validate_background_output_limits(background_job_output_concurrency,
                                          background_job_output_queue_size, background_job_output_cache_bytes)
        self._runtime = api_client if api_client is not None else Runtime(api_key=runtime_key(api_key), base_url=base_url)

    def create(self, request: CreateSandboxRequest):
        p = values(request)
        if p.get("lan_network_id") is not None:
            # 0.4.6 joins the LAN once the sandbox runs; refuse before making one.
            raise CompatibilityError(_LAN)
        for key in ("gpu_count", "gpu_type", "team_id", "advanced_configs", "secrets", "idle_timeout_minutes"):
            if p.get(key):
                raise CompatibilityError(f"Prime {key} cannot yet retain its upstream behavior")
        cpu = positive(p["cpu_cores"], "cpu_cores", integral=True)
        memory = positive(p["memory_gb"] * 1024, "memory_gb", integral=True)
        checkpoint = p.get("checkpoint_id")
        disk = None if checkpoint else positive(p["disk_size_gb"] * 1024, "disk_size_gb", integral=True)
        lifetime = positive(p["timeout_minutes"] * 60, "timeout_minutes", integral=True)
        source = None if checkpoint else dockerfile(p["docker_image"])
        env = p.get("environment_vars") or {}
        environment(json.dumps(env).encode())
        start = values(p["start_command"]) if p.get("start_command") else None
        if start:
            reject({k: v for k, v in start.items() if k not in ("executable", "args")}, "start_command")
            if not isinstance(start.get("executable"), str) or not start["executable"] or "\x00" in start["executable"]:
                raise ValueError("start_command.executable must be a nonempty string without NUL")
            if any(not isinstance(arg, str) or "\x00" in arg for arg in start.get("args", [])):
                raise ValueError("start_command.args must contain strings without NUL")
        if checkpoint:
            # A checkpoint is a disk-only snapshot: the copy boots fresh from its
            # files at the size asked, on a disk the size of the saved one.
            snapshot = self._runtime.snapshots.get(checkpoint)
            if snapshot.get("mode") != "disk":
                raise CompatibilityError(f"{checkpoint} is a whole-machine snapshot, not a filesystem checkpoint; "
                                         "start it with runtime.sandboxes.create(snapshot=...)")
            image_name = (snapshot.get("labels") or {}).get("compat.image", "")
            origin = {"snapshot": snapshot["id"]}
        else:
            image_name = p["docker_image"]
            origin = {"image": (self._runtime.images.build(dockerfile=source))["id"], "disk_mib": disk}
        sb = self._runtime.sandboxes.create(name=p["name"], **origin,
            vcpu=cpu, memory_mib=memory, timeout_seconds=lifetime,
            idle_pause_seconds=0, on_lease_end="stop", region=p.get("region"), idempotency_key=p.get("idempotency_key"),
            labels={"compat.provider": "prime", **({"compat.image": image_name} if image_name else {}),
                    "compat.labels": json.dumps(p.get("labels") or [])},
            network={"internet": True, **({"allow": p["network_allowlist"]} if p.get("network_allowlist") is not None else {}),
                     **({"deny": p["network_denylist"]} if p.get("network_denylist") is not None else {})})
        try:
            sb.files.write(ENV_PATH, json.dumps(env), mode=0o600)
            if start:
                # The output is kept for get_logs, as Prime keeps the container's.
                sb.spawn(["bash", "-c", 'exec "$@" >> "$0" 2>&1', START_LOG,
                                start["executable"], *start.get("args", [])], env=env)
        except BaseException as original:
            try:
                sb.stop()
            except BaseException as cleanup:
                raise original from cleanup
            raise
        return self._view(sb)

    def _view(self, sb):
        i = sb.info
        state = {"running": "RUNNING", "starting": "PENDING", "stopped": "TERMINATED", "paused": "PAUSED"}.get(sb.state, sb.state.upper())
        labels = i.get("labels") or {}
        return Sandbox(id=sb.id, name=i.get("name", ""), status=state,
            docker_image=labels.get("compat.image", i.get("image", "")),
            cpu_cores=i.get("vcpu"), memory_gb=(i.get("memoryMiB") or 0) / 1024,
            disk_size_gb=(i.get("diskMiB") or 0) / 1024, disk_mount_path="/workspace", gpu_count=0,
            gpu_type=None, vm=True, labels=json.loads(labels.get("compat.labels", "[]")),
            created_at=i.get("createdAt"), updated_at=i.get("updatedAt"), region=i.get("region"),
            timeout_minutes=int(i.get("timeoutSeconds", 3600)) // 60)

    def get(self, sandbox_id):
        return self._view(self._runtime.sandboxes.get(sandbox_id))

    def list(self, team_id=None, status=None, labels=None, page=1, per_page=50, exclude_terminated=None, user_id=None):
        reject({k: v for k, v in {"team_id": team_id, "user_id": user_id}.items() if v is not None}, "Prime list")
        positive(page, "page", integral=True)
        positive(per_page, "per_page", integral=True)
        result = []
        for sb in self._runtime.sandboxes.list(include_stopped=not exclude_terminated, labels={"compat.provider": "prime"}):
            item = self._view(sb)
            if (not status or item.status == status) and (not labels or set(labels).issubset(item.labels)):
                result.append(item)
        offset = (page - 1) * per_page
        return SandboxListResponse(sandboxes=result[offset:offset + per_page], total=len(result), page=page,
                     per_page=per_page, has_next=offset + per_page < len(result))

    def delete(self, sandbox_id):
        sb = self._runtime.sandboxes.get(sandbox_id)
        sb.stop()
        return {"message": "Sandbox deleted"}

    def wait_for_creation(self, sandbox_id, max_attempts=60, stability_checks=1, image_build_timeout_seconds=3000):
        if stability_checks != 1:
            raise CompatibilityError("Repeated reachability probes are not yet implemented")
        # create builds the image before it answers, so no build is left to wait for.
        positive(image_build_timeout_seconds, "image_build_timeout_seconds")
        positive(max_attempts, "max_attempts", integral=True)
        sb = self._runtime.sandboxes.get(sandbox_id)
        if sb.state != "running":
            sb.wait_for("running", min(300, int(max_attempts * 2)))
        if sb.state != "running":
            raise TimeoutError(f"Sandbox {sandbox_id} is {sb.state}")
        return None

    def bulk_wait_for_creation(self, sandbox_ids, max_attempts=60, image_build_timeout_seconds=3000):
        if not sandbox_ids or len(sandbox_ids) > 100 or len(set(sandbox_ids)) != len(sandbox_ids):
            raise ValueError("sandbox_ids must contain between 1 and 100 unique IDs")
        for sandbox_id in sandbox_ids:
            self.wait_for_creation(sandbox_id, max_attempts=max_attempts,
                                         image_build_timeout_seconds=image_build_timeout_seconds)
        return {sandbox_id: "RUNNING" for sandbox_id in sandbox_ids}

    def clear_auth_cache(self):
        """Runtime authenticates every call with the API key: no per-sandbox token is cached."""
        return None

    def get_network(self, sandbox_id):
        sb = self._runtime.sandboxes.get(sandbox_id)
        return _egress_status(sb.network.get())

    def set_network(self, sandbox_id, *, allow=None, deny=None):
        rules = _network_rules(allow, deny)
        sb = self._runtime.sandboxes.get(sandbox_id)
        return _egress_status(sb.network.set(**rules))

    def get_logs(self, sandbox_id):
        sb = self._runtime.sandboxes.get(sandbox_id)
        try:
            return (sb.files.read(START_LOG)).decode("utf-8", errors="replace")
        except SDKError as error:
            if error.status != 404:
                raise
            return ""

    def checkpoint(self, sandbox_id):
        """A disk-only snapshot of the sandbox's files. A running sandbox is
        paused for the capture and woken after, so the checkpoint comes back
        DURABLE (or the call fails); it is kept while the account has credit."""
        sb = self._runtime.sandboxes.get(sandbox_id)
        image = (sb.info.get("labels") or {}).get("compat.image")
        labels = {"compat.provider": "prime", **({"compat.image": image} if image else {})}
        snapshot = sb.snapshot(mode="disk", labels=labels)
        if snapshot.get("mode", "disk") != "disk":
            raise CompatibilityError("Runtime did not confirm a filesystem-only checkpoint")
        return _checkpoint({"labels": labels, **snapshot})

    def get_checkpoint(self, checkpoint_id):
        return _checkpoint(self._runtime.snapshots.get(checkpoint_id))

    def get_checkpoints(self, checkpoint_ids):
        _validate_ids(checkpoint_ids, "checkpoint_ids")
        checkpoints, errors = [], []
        for checkpoint_id in checkpoint_ids:
            try:
                checkpoints.append(_checkpoint(self._runtime.snapshots.get(checkpoint_id)))
            except SDKError as error:
                if error.status != 404:
                    raise
                errors.append(CheckpointLookupError(checkpoint_id=checkpoint_id, code="NOT_FOUND", message=str(error)))
        return BatchCheckpointResponse(checkpoints=checkpoints, errors=errors)

    def wait_for_checkpoint(self, checkpoint_id, timeout_seconds=300):
        positive(timeout_seconds, "timeout_seconds")
        deadline = time.monotonic() + timeout_seconds
        delay = 0.5
        while time.monotonic() < deadline:
            checkpoint = self.get_checkpoint(checkpoint_id)
            if checkpoint.state == "DURABLE":
                return checkpoint
            if checkpoint.state in ("FAILED", "DELETING"):
                raise RuntimeError(f"Checkpoint {checkpoint_id} cannot become durable (state={checkpoint.state}): "
                                   f"{checkpoint.error or 'no error details'}")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(delay, remaining))
            delay = min(delay * 1.5, 5.0)
        raise TimeoutError(f"Checkpoint {checkpoint_id} did not become DURABLE within {timeout_seconds:g}s")

    def list_checkpoints(self, sandbox_id, checkpoint_id=None):
        """The sandbox's filesystem checkpoints, oldest first."""
        self._runtime.sandboxes.get(sandbox_id)
        result = []
        for snapshot in self._runtime.snapshots.list(sandbox_id=sandbox_id):
            if (snapshot.get("mode") == "disk" and snapshot.get("state") != "deleted"
                    and checkpoint_id in (None, snapshot["id"])):
                result.append(_checkpoint(snapshot))
        return sorted(result, key=lambda checkpoint: checkpoint.created_at)

    def delete_checkpoint(self, checkpoint_id):
        self._runtime.snapshots.delete(checkpoint_id)
        return None

    def delete_sandbox_checkpoints(self, sandbox_id):
        deleted, errors = [], []
        for checkpoint in self.list_checkpoints(sandbox_id):
            if checkpoint.state == "DELETING":
                continue
            try:
                self._runtime.snapshots.delete(checkpoint.id)
                deleted.append(checkpoint.id)
            except SDKError as error:
                if error.status not in (404, 409):
                    raise
                errors.append(CheckpointDeleteError(checkpoint_id=checkpoint.id,
                    code="NOT_FOUND" if error.status == 404 else "CONFLICT", message=str(error)))
        return DeleteSandboxCheckpointsResponse(deleted=deleted, errors=errors)

    def create_lan_network(self, name, team_id=None):
        raise CompatibilityError(_LAN)

    def list_lan_networks(self, team_id=None):
        raise CompatibilityError(_LAN)

    def get_lan_network(self, network_id):
        raise CompatibilityError(_LAN)

    def delete_lan_network(self, network_id):
        raise CompatibilityError(_LAN)

    def set_lan_rules(self, network_id, rules):
        raise CompatibilityError(_LAN)

    def add_lan_member(self, network_id, sandbox_id, tags=None):
        raise CompatibilityError(_LAN)

    def remove_lan_member(self, network_id, sandbox_id):
        raise CompatibilityError(_LAN)

    def create_ssh_session(self, sandbox_id, public_key, ttl_seconds=None):
        raise CompatibilityError("Prime SSH sessions on a public host and port are not supported; "
                                 "open a shell with `runtime sandboxes ssh <id>`")

    def close_ssh_session(self, sandbox_id, session_id):
        raise CompatibilityError("Prime SSH sessions on a public host and port are not supported; "
                                 "open a shell with `runtime sandboxes ssh <id>`")

    def _environment(self, sb, extra=None):
        try:
            data = sb.files.read(ENV_PATH)
        except SDKError as error:
            if error.status != 404:
                raise
            data = b"{}"
        return environment(data, extra)

    def execute_command(self, sandbox_id, command, working_dir=None, env=None, timeout=None, user=None):
        _validate_guest_user(user)
        sb = self._runtime.sandboxes.get(sandbox_id)
        result = sb.exec(command, cwd=working_dir, env=self._environment(sb, env),
            timeout_ms=None if timeout is None else int(positive(timeout, "timeout") * 1000), on_stdout=lambda chunk: None)
        if result.stdout_truncated or result.stderr_truncated:
            raise IOError("Prime command output was truncated")
        if result.timed_out:
            raise CommandTimeoutError(sandbox_id, command, timeout)
        return CommandResponse(stdout=result.stdout, stderr=result.stderr, exit_code=result.exit_code)

    def upload_bytes(self, sandbox_id, file_path, file_bytes, filename, timeout=None):
        with _deadline(UploadTimeoutError, sandbox_id, file_path, timeout):
            sb = self._runtime.sandboxes.get(sandbox_id)
            sb.files.write(file_path, file_bytes)
        return FileUploadResponse(success=True, path=file_path, size=len(file_bytes), timestamp=datetime.now(timezone.utc))

    def upload_file(self, sandbox_id, file_path, local_file_path, timeout=None):
        return self.upload_bytes(sandbox_id, file_path, Path(local_file_path).read_bytes(), Path(local_file_path).name, timeout)

    def download_file(self, sandbox_id, file_path, local_file_path, timeout=None):
        with _deadline(DownloadTimeoutError, sandbox_id, file_path, timeout):
            sb = self._runtime.sandboxes.get(sandbox_id)
            sb.files.download(file_path, local_file_path)

    def read_file(self, sandbox_id, file_path, timeout=None, offset=None, length=None):
        if length is not None and length < 0:
            raise ValueError("length must not be negative")
        with _deadline(DownloadTimeoutError, sandbox_id, file_path, timeout):
            sb = self._runtime.sandboxes.get(sandbox_id)
            data = sb.files.read(file_path)
        start = max(0, len(data) + offset) if offset is not None and offset < 0 else (offset or 0)
        part = data[start:None if length is None else start + length]
        return ReadFileResponse(content=part.decode(), size=len(part), total_size=len(data), offset=start,
                     truncated=start > 0 or start + len(part) < len(data))

    def get_sandbox_statuses(self, sandbox_ids):
        if not sandbox_ids or len(sandbox_ids) > 100 or len(set(sandbox_ids)) != len(sandbox_ids):
            raise ValueError("sandbox_ids must contain between 1 and 100 unique IDs")
        statuses, errors = [], []
        for sandbox_id in sandbox_ids:
            try:
                sb = self._runtime.sandboxes.get(sandbox_id)
                value = self._view(sb)
                statuses.append(SandboxStatusSnapshot(sandbox_id=sandbox_id, status=value.status,
                    error_type=value.error_type, error_message=value.error_message,
                    pending_image_build_id=value.pending_image_build_id))
            except SDKError as error:
                if error.status not in (403, 404):
                    raise
                errors.append(SandboxStatusLookupError(sandbox_id=sandbox_id,
                    code="NOT_FOUND" if error.status == 404 else "FORBIDDEN", message=str(error)))
        return BatchSandboxStatusResponse(statuses=statuses, errors=errors)

    def bulk_delete(self, sandbox_ids=None, labels=None, team_id=None, user_id=None, all_users=False):
        if team_id is not None or user_id is not None or all_users:
            raise CompatibilityError("Cross-user and team bulk deletion cannot be mapped to one Runtime credential")
        if not sandbox_ids and not labels:
            raise ValueError("Select sandbox_ids or labels for bulk deletion")
        ids = list(sandbox_ids or [])
        if labels:
            for sb in self._runtime.sandboxes.list(labels={"compat.provider": "prime"}):
                if set(labels).issubset(self._view(sb).labels) and sb.id not in ids:
                    ids.append(sb.id)
        succeeded, failed = [], []
        for sandbox_id in ids:
            try:
                self.delete(sandbox_id)
                succeeded.append(sandbox_id)
            except Exception as error:
                failed.append({"sandbox_id": sandbox_id, "error": str(error)})
        return BulkDeleteSandboxResponse(succeeded=succeeded, failed=failed, message=f"Deleted {len(succeeded)} sandboxes")

    @staticmethod
    def _validate_jobs(jobs):
        if not jobs or len(jobs) > 100:
            raise ValueError("jobs must contain between 1 and 100 entries")
        keys = []
        for job in jobs:
            if not re.fullmatch(r"[0-9A-Fa-f]{8}", job.job_id):
                raise ValueError(f"Invalid background job ID: {job.job_id}")
            root = "/tmp/job_" + job.job_id
            if (job.stdout_log_file, job.stderr_log_file, job.exit_file) != (root + ".stdout.log", root + ".stderr.log", root + ".exit"):
                raise ValueError("Batch status requires an unmodified BackgroundJob")
            keys.append((job.sandbox_id, job.job_id))
        if len(set(keys)) != len(keys):
            raise ValueError("jobs must be unique")

    def start_background_job(self, sandbox_id, command, working_dir=None, env=None, user=None):
        _validate_guest_user(user)
        if not isinstance(command, str) or not command or "\x00" in command:
            raise ValueError("command must be a nonempty string without NUL")
        job_id = uuid.uuid4().hex[:8]
        root = "/tmp/job_" + job_id
        job = BackgroundJob(job_id=job_id, sandbox_id=sandbox_id,
            stdout_log_file=root + ".stdout.log", stderr_log_file=root + ".stderr.log", exit_file=root + ".exit")
        sb = self._runtime.sandboxes.get(sandbox_id)
        pid_file = root + ".pid"
        process = sb.spawn(["bash", "-c", _JOB, "runtime-prime-job", job.stdout_log_file,
            job.stderr_log_file, job.exit_file, command, working_dir or "", pid_file],
            env=self._environment(sb, env))
        # Answer once the job has started, as Prime does since 0.4.4.
        pid = (getattr(process, "info", None) or {}).get("pid")
        launch = sb.exec(["bash", "-c", _LAUNCH, "runtime-prime-launch", pid_file, str(pid or "")],
                               timeout_ms=30_000)
        if launch.exit_code != 0:
            if launch.exit_code == 2:
                try:
                    process.kill("SIGKILL")
                except Exception:  # noqa: BLE001 - the failed launch is what the caller hears
                    pass
            reason = (launch.stderr or "").strip() or "the job did not start"
            raise APIError(f"Failed to launch background job {job_id}: {reason}")
        return job

    def get_background_job_status(self, sandbox_id, job, timeout=None):
        if job.sandbox_id != sandbox_id:
            raise ValueError("Job does not belong to the requested sandbox")
        if timeout is not None:
            raise CompatibilityError("Per-job retrieval deadlines are not yet supported")
        sb = self._runtime.sandboxes.get(sandbox_id)
        response = sb.exec(["bash", "-c", _STATUS, "runtime-prime-status", job.exit_file,
                                  "/tmp/job_" + job.job_id + ".pid"])
        status = (response.stdout or "").strip()
        if status == "lost":
            raise APIError(f"Background job {job.job_id} exited without recording an exit code")
        try:
            code = int(status)
        except ValueError:
            code = None
        return BackgroundJobStatusSnapshot(sandbox_id=sandbox_id, job_id=job.job_id,
                                            completed=code is not None, exit_code=code)

    def get_background_job(self, sandbox_id, job, timeout=None):
        status = self.get_background_job_status(sandbox_id, job, timeout=timeout)
        if not status.completed:
            return BackgroundJobStatus(job_id=job.job_id, completed=False)
        sb = self._runtime.sandboxes.get(sandbox_id)
        data = {"job_id": job.job_id, "completed": True, "exit_code": status.exit_code}
        for channel in ("stdout", "stderr"):
            try:
                raw = sb.files.read(getattr(job, channel + "_log_file"))
                data[channel] = raw[-10 * 1024 * 1024:].decode("utf-8", errors="replace")
                data[channel + "_truncated"] = len(raw) > 10 * 1024 * 1024
            except SDKError as error:
                if error.status == 404:
                    data[channel], data[channel + "_truncated"] = "", False
                else:
                    data[channel + "_error"] = str(error)
        return BackgroundJobStatus(**data)

    def get_background_job_statuses(self, jobs, timeout=None):
        self._validate_jobs(jobs)
        return [self.get_background_job_status(job.sandbox_id, job, timeout=timeout) for job in jobs]

    def get_background_jobs(self, jobs, timeout=None):
        self._validate_jobs(jobs)
        return [self.get_background_job(job.sandbox_id, job, timeout=timeout) for job in jobs]

    def run_background_job(self, sandbox_id, command, timeout=900, working_dir=None, env=None, poll_interval=3):
        positive(timeout, "timeout")
        positive(poll_interval, "poll_interval")
        job = self.start_background_job(sandbox_id, command, working_dir=working_dir, env=env)
        deadline = time.monotonic() + timeout
        delay = min(float(poll_interval), 20.0)
        while True:
            result = self.get_background_job(sandbox_id, job)
            if result.completed:
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CommandTimeoutError(sandbox_id, command, timeout)
            time.sleep(min(delay, remaining))
            delay = min(delay * 1.5, 20.0)

    def close(self):
        self._runtime.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


from .exceptions import translate
for _name in ("create", "get", "list", "delete", "wait_for_creation", "execute_command", "upload_bytes",
              "upload_file", "download_file", "read_file", "start_background_job", "get_background_job_status",
              "get_background_job", "get_background_job_statuses", "get_background_jobs", "run_background_job",
              "get_sandbox_statuses", "bulk_delete", "bulk_wait_for_creation", "get_network", "set_network",
              "get_logs", "checkpoint", "get_checkpoint", "get_checkpoints", "wait_for_checkpoint", "list_checkpoints",
              "delete_checkpoint", "delete_sandbox_checkpoints"):
    setattr(SandboxClient, _name, translate(getattr(SandboxClient, _name)))
