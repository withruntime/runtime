"""Generated synchronous Prime sandbox adapter. Contract: prime-sandboxes 0.4.1."""
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
    BatchSandboxStatusResponse, BulkDeleteSandboxResponse)

from .exceptions import CommandTimeoutError

def _validate_guest_user(user):
    if user == "":
        raise ValueError("user must be a non-empty guest username")
    if user is not None:
        raise CompatibilityError("Prime named guest users are not yet supported on Runtime")

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
        for key in ("gpu_count", "gpu_type", "team_id", "advanced_configs", "secrets", "idle_timeout_minutes"):
            if p.get(key):
                raise CompatibilityError(f"Prime {key} cannot yet retain its upstream behavior")
        cpu = positive(p["cpu_cores"], "cpu_cores", integral=True)
        memory = positive(p["memory_gb"] * 1024, "memory_gb", integral=True)
        disk = positive(p["disk_size_gb"] * 1024, "disk_size_gb", integral=True)
        lifetime = positive(p["timeout_minutes"] * 60, "timeout_minutes", integral=True)
        source = dockerfile(p["docker_image"])
        env = p.get("environment_vars") or {}
        environment(json.dumps(env).encode())
        start = values(p["start_command"]) if p.get("start_command") else None
        if start:
            reject({k: v for k, v in start.items() if k not in ("executable", "args")}, "start_command")
            if not isinstance(start.get("executable"), str) or not start["executable"] or "\x00" in start["executable"]:
                raise ValueError("start_command.executable must be a nonempty string without NUL")
            if any(not isinstance(arg, str) or "\x00" in arg for arg in start.get("args", [])):
                raise ValueError("start_command.args must contain strings without NUL")
        image = self._runtime.images.build(dockerfile=source)
        sb = self._runtime.sandboxes.create(name=p["name"], image=image["id"],
            vcpu=cpu, memory_mib=memory, disk_mib=disk, timeout_seconds=lifetime,
            idle_pause_seconds=0, on_lease_end="stop", region=p.get("region"), idempotency_key=p.get("idempotency_key"),
            labels={"compat.provider": "prime", "compat.image": p["docker_image"],
                    "compat.labels": json.dumps(p.get("labels") or [])},
            network={"internet": True, **({"allow": p["network_allowlist"]} if p.get("network_allowlist") is not None else {}),
                     **({"deny": p["network_denylist"]} if p.get("network_denylist") is not None else {})})
        try:
            sb.files.write(ENV_PATH, json.dumps(env), mode=0o600)
            if start:
                sb.spawn([start["executable"], *start.get("args", [])], env=env)
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
        if image_build_timeout_seconds != 3000:
            raise CompatibilityError("Separate image build waiting deadlines are not yet supported")
        positive(max_attempts, "max_attempts", integral=True)
        sb = self._runtime.sandboxes.get(sandbox_id)
        if sb.state != "running":
            sb.wait_for("running", min(300, int(max_attempts * 2)))
        if sb.state != "running":
            raise TimeoutError(f"Sandbox {sandbox_id} is {sb.state}")
        return None

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
        if timeout is not None:
            raise CompatibilityError("Per-file transfer deadlines are not yet supported")
        sb = self._runtime.sandboxes.get(sandbox_id)
        sb.files.write(file_path, file_bytes)
        return FileUploadResponse(success=True, path=file_path, size=len(file_bytes), timestamp=datetime.now(timezone.utc))

    def upload_file(self, sandbox_id, file_path, local_file_path, timeout=None):
        return self.upload_bytes(sandbox_id, file_path, Path(local_file_path).read_bytes(), Path(local_file_path).name, timeout)

    def download_file(self, sandbox_id, file_path, local_file_path, timeout=None):
        if timeout is not None:
            raise CompatibilityError("Per-file transfer deadlines are not yet supported")
        sb = self._runtime.sandboxes.get(sandbox_id)
        sb.files.download(file_path, local_file_path)

    def read_file(self, sandbox_id, file_path, timeout=None, offset=None, length=None):
        if timeout is not None:
            raise CompatibilityError("Per-file transfer deadlines are not yet supported")
        if length is not None and length < 0:
            raise ValueError("length must not be negative")
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
        # Positional arguments keep paths and user command separate from source.
        # A subshell captures an explicit `exit`; the outer shell writes status.
        script = '(if [ -n "$5" ]; then cd -- "$5" || exit; fi; bash -c "$4") > "$1" 2> "$2"; printf "%s\\n" "$?" > "$3"'
        sb.spawn(["bash", "-c", script, "runtime-prime-job", job.stdout_log_file,
            job.stderr_log_file, job.exit_file, command, working_dir or ""], env=self._environment(sb, env))
        return job

    def get_background_job_status(self, sandbox_id, job, timeout=None):
        if job.sandbox_id != sandbox_id:
            raise ValueError("Job does not belong to the requested sandbox")
        if timeout is not None:
            raise CompatibilityError("Per-job retrieval deadlines are not yet supported")
        sb = self._runtime.sandboxes.get(sandbox_id)
        try:
            raw = sb.files.read(job.exit_file)
        except SDKError as error:
            if error.status != 404:
                raise
            raw = b""
        try:
            code = int(raw.strip())
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
              "get_sandbox_statuses", "bulk_delete"):
    setattr(SandboxClient, _name, translate(getattr(SandboxClient, _name)))
