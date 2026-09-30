# ``runtime.jobs``: a command run in a fresh sandbox, once or on a cron schedule.
#
#     job = await runtime.jobs.create("nightly-report", cron="0 3 * * *", timezone="Europe/Berlin",
#                                     command=["python3", "/workspace/report.py"])
#
# Each run is a paid sandbox, billed at the sandbox rates through the same holds
# and spending limits; the trial's hours do not fund jobs. When jobs are switched
# off where you call, every method raises ServiceUnavailableError (code
# ``unavailable``) at once, and retrying does not change it.
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional, Union
from urllib.parse import quote

from .._api_defaults import JOB_START_SECONDS, JOB_TIMEOUT_SECONDS
from .._errors import InvalidRequestError, RuntimeError, ServiceUnavailableError

if TYPE_CHECKING:
    from datetime import datetime

# The size a run gets when ``compute`` leaves a field out: the sandbox
# defaults, in the region us-east.
JOB_DEFAULTS: dict[str, Any] = {
    "region": "us-east",
    "vcpu": 2,
    "cpuMode": "shared",
    "cpuFloorMillis": 50,
    "memoryMiB": 4096,
    "diskMiB": 4096,
    "timeoutSeconds": JOB_TIMEOUT_SECONDS,
    # Added to the timeout for the sandbox to start, within the hour.
    "startSeconds": JOB_START_SECONDS,
}
# A run is one sandbox: at most 16 vCPU and 64 GiB, a disk no smaller than the
# system image, and paid for at most an hour.
JOB_LIMITS: dict[str, int] = {
    "maxVcpu": 16,
    "maxMemoryMiB": 65536,
    "minDiskMiB": 3072,
    "maxDurationSeconds": 3600,
    "maxAttempts": 5,
    "maxSecrets": 16,
}


def _enc(value: str) -> str:
    return quote(value, safe="")


def _invalid(message: str, field: str) -> InvalidRequestError:
    return InvalidRequestError(message, code="invalid_request", details={"field": field},
                               hint="Nothing was sent. Fix the field and call again.")


def job_time(at: Union["datetime", str, int, float]) -> int:
    """Unix milliseconds from a datetime (naive means UTC), an ISO time or a number."""
    from datetime import datetime, timezone  # here: importing it costs every import of the SDK
    try:
        if isinstance(at, datetime):
            if at.tzinfo is None:
                at = at.replace(tzinfo=timezone.utc)
            return int(at.timestamp() * 1000)
        if isinstance(at, (int, float)) and not isinstance(at, bool):
            return int(at)
        if isinstance(at, str) and at.isdigit():
            return int(at)
        if isinstance(at, str):
            return job_time(datetime.fromisoformat(at.replace("Z", "+00:00")))
    except ValueError:
        pass
    raise _invalid(f"at must be a time: a datetime, an ISO time such as 2026-10-01T03:00:00Z, or Unix "
                   f"milliseconds; got {at!r}.", "schedule.at")


def job_body(name: str, *, command: Union[list[str], dict[str, Any]], at: Any = None,
             cron: Optional[str] = None, timezone: Optional[str] = None,
             timeout_seconds: Optional[int] = None, compute: Optional[dict[str, Any]] = None,
             retry: Optional[dict[str, int]] = None, secrets: Optional[list[dict[str, str]]] = None,
             max_total_cost_micros: Optional[int] = None) -> dict[str, Any]:
    """The API's job body, every default filled in and the size checked before sending."""
    if (at is None) == (cron is None):
        raise _invalid("Give at= for one run or cron= for a schedule.", "schedule")
    if at is not None:
        if timezone is not None:
            raise _invalid("timezone goes with cron; at takes a time with its own offset.", "schedule.timezone")
        schedule: dict[str, Any] = {"kind": "once", "at": job_time(at)}
    else:
        expression = str(cron).strip()
        if len(expression.split()) != 5:
            raise _invalid(f'A cron schedule has five fields, minute hour day-of-month month day-of-week, '
                           f'such as "0 3 * * *"; got "{expression}".', "schedule.cron")
        schedule = {"kind": "cron", "expression": expression}
        if timezone is not None:
            schedule["timezone"] = timezone
    argv = command if isinstance(command, list) else command.get("argv")
    if not argv:
        raise _invalid('command is an argv list such as ["python3", "job.py"].', "command")
    cmd = {"argv": list(argv)} if isinstance(command, list) else dict(command)
    timeout = timeout_seconds if timeout_seconds is not None else JOB_DEFAULTS["timeoutSeconds"]
    given = dict(compute or {})
    vcpu = given.get("vcpu", JOB_DEFAULTS["vcpu"])
    mode = given.get("cpuMode", JOB_DEFAULTS["cpuMode"])
    size: dict[str, Any] = {
        "region": given.get("region", JOB_DEFAULTS["region"]),
        "vcpu": vcpu,
        "cpuMode": mode,
        "cpuFloorMillis": given.get("cpuFloorMillis",
                                    vcpu * 1000 if mode == "reserved"
                                    else min(JOB_DEFAULTS["cpuFloorMillis"], vcpu * 1000)),
        "memoryMiB": given.get("memoryMiB", JOB_DEFAULTS["memoryMiB"]),
        "diskMiB": given.get("diskMiB", JOB_DEFAULTS["diskMiB"]),
        "durationSeconds": given.get("durationSeconds",
                                     min(JOB_LIMITS["maxDurationSeconds"], timeout + JOB_DEFAULTS["startSeconds"])),
    }
    if "maxCostMicros" in given:
        size["maxCostMicros"] = given["maxCostMicros"]
    if size["vcpu"] > JOB_LIMITS["maxVcpu"] or size["memoryMiB"] > JOB_LIMITS["maxMemoryMiB"]:
        raise _invalid(f"A run's sandbox is at most {JOB_LIMITS['maxVcpu']} vCPU and "
                       f"{JOB_LIMITS['maxMemoryMiB'] // 1024} GiB of memory; asked for {size['vcpu']} vCPU "
                       f"and {size['memoryMiB']} MiB.",
                       "compute.vcpu" if size["vcpu"] > JOB_LIMITS["maxVcpu"] else "compute.memoryMiB")
    if size["diskMiB"] < JOB_LIMITS["minDiskMiB"]:
        raise _invalid(f"A run's disk is at least {JOB_LIMITS['minDiskMiB']} MiB, the size of the system image; "
                       f"asked for {size['diskMiB']}.", "compute.diskMiB")
    if timeout > size["durationSeconds"] or size["durationSeconds"] > JOB_LIMITS["maxDurationSeconds"]:
        raise _invalid(f"timeout_seconds ({timeout}) must fit in the time a run is paid for "
                       f"(compute durationSeconds {size['durationSeconds']}), which is at most "
                       f"{JOB_LIMITS['maxDurationSeconds']} seconds.", "timeoutSeconds")
    body: dict[str, Any] = {"name": name, "schedule": schedule, "compute": size, "command": cmd,
                            "timeoutSeconds": timeout}
    if retry is not None:
        body["retry"] = retry
    if secrets is not None:
        body["secrets"] = secrets
    if max_total_cost_micros is not None:
        body["maxTotalCostMicros"] = max_total_cost_micros
    return body


def switched_off(product: str, error: Exception) -> Exception:
    """The API answers a product switched off where it runs with 503
    ``unavailable`` and words that do not name it. This names it and says no
    retry will change it."""
    if isinstance(error, RuntimeError) and error.code == "unavailable":
        return ServiceUnavailableError(
            f"{product} are not enabled on this Runtime API yet.", code=error.code, status=error.status,
            request_id=error.request_id, details=error.details,
            hint=f"{product} are switched off here for now, so retrying will not help. Tell us you need them: "
                 f'runtime feedback "need {product.lower()}".')
    return error


class AsyncJobs:
    """``runtime.jobs``. Times are Unix milliseconds."""

    def __init__(self, t: Any) -> None:
        self._t = t

    async def _json(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return await self._t.json(*args, **kwargs)
        except RuntimeError as error:
            raise switched_off("Jobs", error) from error

    async def create(self, name: str, *, command: Union[list[str], dict[str, Any]], at: Any = None,
                     cron: Optional[str] = None, timezone: Optional[str] = None,
                     timeout_seconds: Optional[int] = None, compute: Optional[dict[str, Any]] = None,
                     retry: Optional[dict[str, int]] = None, secrets: Optional[list[dict[str, str]]] = None,
                     max_total_cost_micros: Optional[int] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Schedule a job: ``at=`` (a datetime, ISO time or Unix ms; a time
        already past runs at once) or ``cron="0 3 * * *"`` with an optional IANA
        ``timezone`` (UTC by default). ``command`` is an argv list, run without a
        shell, or ``{"argv": [...], "cwd": "/workspace/dir"}``. ``compute``
        overrides the 2 vCPU, 4 GiB default (``vcpu``, ``memoryMiB``,
        ``diskMiB``, ``cpuMode``, ``cpuFloorMillis``, ``region``,
        ``durationSeconds``, ``maxCostMicros``); ``timeout_seconds`` defaults to
        1800. ``retry={"maxAttempts": 3, "backoffSeconds": 30}`` retries a run
        that exits non-zero, up to 5 attempts. ``secrets=[{"name": "ENV_NAME",
        "secretId": ...}]`` puts jobs copies of secrets (``runtime.secrets.set(...,
        jobs=True)``) into the run's environment."""
        body = job_body(name, command=command, at=at, cron=cron, timezone=timezone,
                        timeout_seconds=timeout_seconds, compute=compute, retry=retry, secrets=secrets,
                        max_total_cost_micros=max_total_cost_micros)
        return await self._json("POST", "/v1/jobs", body=body, idempotency_key=idempotency_key)

    async def list(self, *, limit: Optional[int] = None) -> AsyncPage:
        """Your jobs, oldest first. ``async for`` walks every page."""
        from .._async_client import AsyncPage

        async def fetch(cursor: Optional[str]) -> AsyncPage:
            body = await self._json("GET", "/v1/jobs", query={"limit": limit, "cursor": cursor})
            return AsyncPage(body["items"], body.get("nextCursor"), fetch)
        return await fetch(None)

    async def get(self, job_id: str) -> dict[str, Any]:
        return await self._json("GET", f"/v1/jobs/{_enc(job_id)}")

    async def runs(self, job_id: str, *, limit: Optional[int] = None) -> AsyncPage:
        """A job's runs, oldest first: each attempt of each occurrence."""
        from .._async_client import AsyncPage

        async def fetch(cursor: Optional[str]) -> AsyncPage:
            body = await self._json("GET", f"/v1/jobs/{_enc(job_id)}/runs", query={"limit": limit, "cursor": cursor})
            return AsyncPage(body["items"], body.get("nextCursor"), fetch)
        return await fetch(None)

    async def run(self, run_id: str) -> dict[str, Any]:
        """One run by its id. ``state`` ``unknown`` means the outcome could not
        be observed; it is never retried by itself."""
        return await self._json("GET", f"/v1/job-runs/{_enc(run_id)}")

    async def logs(self, run_id: str, *, cursor: Optional[int] = None,
                   limit_bytes: Optional[int] = None) -> dict[str, Any]:
        """A run's output from ``cursor`` (a byte offset), at most ``limit_bytes``
        (4 to 65536, default 16384). Call again with ``nextCursor`` until
        ``complete``. A run keeps its last 256 KiB."""
        return await self._json("GET", f"/v1/job-runs/{_enc(run_id)}/logs",
                                query={"cursor": cursor, "limitBytes": limit_bytes})

    async def pause(self, job_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Stop scheduling new runs; a run already going finishes."""
        return await self._json("POST", f"/v1/jobs/{_enc(job_id)}:pause", body={}, idempotency_key=idempotency_key)

    async def resume(self, job_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        return await self._json("POST", f"/v1/jobs/{_enc(job_id)}:resume", body={}, idempotency_key=idempotency_key)

    async def cancel(self, job_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """End the job for good and stop any run in progress. A run that already
        finished keeps its result."""
        return await self._json("POST", f"/v1/jobs/{_enc(job_id)}:cancel", body={}, idempotency_key=idempotency_key)
