"""GENERATED from _async_products/jobs.py by scripts/generate_sync.py. Do not edit."""
# ``runtime.jobs``: a command run in a fresh sandbox, once or on a cron schedule.
#
#     job = runtime.jobs.create("nightly-report", cron="0 3 * * *", timezone="Europe/Berlin",
#                                     command=["python3", "/workspace/report.py"])
#
# Each run is a sandbox, paid for as one: from the free usage first while the run fits the limits without credit, then from credit at the sandbox rates,
# through the same holds and spending limits. When jobs are switched
# off where you call, every method raises ServiceUnavailableError (code
# ``unavailable``) at once, and retrying does not change it.
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, Optional, Union
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
# system image and no larger than 400 GiB, and paid for at most an hour.
JOB_LIMITS: dict[str, int] = {
    "maxVcpu": 16,
    "maxMemoryMiB": 65536,
    "minDiskMiB": 3072,
    "maxDiskMiB": 409600,
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


def job_schedule(*, at: Any = None, cron: Optional[str] = None,
                 timezone: Optional[str] = None) -> dict[str, Any]:
    """The API's schedule from ``at=`` or ``cron=`` (with ``timezone=``), as
    ``create`` and ``reschedule`` take it."""
    if (at is None) == (cron is None):
        raise _invalid("Give at= for one run or cron= for a schedule.", "schedule")
    if at is not None:
        if timezone is not None:
            raise _invalid("timezone goes with cron; at takes a time with its own offset.", "schedule.timezone")
        return {"kind": "once", "at": job_time(at)}
    expression = str(cron).strip()
    if len(expression.split()) != 5:
        raise _invalid(f'A cron schedule has five fields, minute hour day-of-month month day-of-week, '
                       f'such as "0 3 * * *"; got "{expression}".', "schedule.cron")
    schedule: dict[str, Any] = {"kind": "cron", "expression": expression}
    if timezone is not None:
        schedule["timezone"] = timezone
    return schedule


def job_body(name: str, *, command: Union[list[str], dict[str, Any]], at: Any = None,
             cron: Optional[str] = None, timezone: Optional[str] = None,
             timeout_seconds: Optional[int] = None, compute: Optional[dict[str, Any]] = None,
             retry: Optional[dict[str, int]] = None, secrets: Optional[list[dict[str, str]]] = None,
             max_total_cost_micros: Optional[int] = None, image: Optional[str] = None,
             alert: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """The API's job body, every default filled in and the size checked before sending."""
    schedule = job_schedule(at=at, cron=cron, timezone=timezone)
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
    if "volumes" in given:
        # Each run attaches them: [{"volumeId": ..., "path": "/data", "mode": "rw" or "snapshot"}].
        size["volumes"] = given["volumes"]
    if size["vcpu"] > JOB_LIMITS["maxVcpu"] or size["memoryMiB"] > JOB_LIMITS["maxMemoryMiB"]:
        raise _invalid(f"A run's sandbox is at most {JOB_LIMITS['maxVcpu']} vCPU and "
                       f"{JOB_LIMITS['maxMemoryMiB'] // 1024} GiB of memory; asked for {size['vcpu']} vCPU "
                       f"and {size['memoryMiB']} MiB.",
                       "compute.vcpu" if size["vcpu"] > JOB_LIMITS["maxVcpu"] else "compute.memoryMiB")
    if size["diskMiB"] < JOB_LIMITS["minDiskMiB"]:
        raise _invalid(f"A run's disk is at least {JOB_LIMITS['minDiskMiB']} MiB, the size of the system image; "
                       f"asked for {size['diskMiB']}.", "compute.diskMiB")
    if size["diskMiB"] > JOB_LIMITS["maxDiskMiB"]:
        raise _invalid(f"A run's disk is at most {JOB_LIMITS['maxDiskMiB']} MiB "
                       f"({JOB_LIMITS['maxDiskMiB'] // 1024} GiB); asked for {size['diskMiB']}.", "compute.diskMiB")
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
    if image is not None:
        body["image"] = image
    if alert is not None:
        body["alert"] = alert
    return body


class _Keep:
    """An argument left out of ``update``: that field stays as it is."""

    def __repr__(self) -> str:
        return "KEEP"


KEEP: Any = _Keep()


def job_update_body(*, command: Any = KEEP, image: Any = KEEP, compute: Any = KEEP, secrets: Any = KEEP,
                    alert: Any = KEEP, timeout_seconds: Any = KEEP, retry: Any = KEEP,
                    max_total_cost_micros: Any = KEEP) -> dict[str, Any]:
    """The API's update body: each field given, ``None`` where it may be
    removed (``image``, ``alert``, ``max_total_cost_micros``)."""
    body: dict[str, Any] = {}
    for field, value in (("command", command), ("image", image), ("compute", compute), ("secrets", secrets),
                         ("alert", alert), ("timeoutSeconds", timeout_seconds), ("retry", retry),
                         ("maxTotalCostMicros", max_total_cost_micros)):
        if value is KEEP:
            continue
        if value is None and field not in ("image", "alert", "maxTotalCostMicros"):
            raise _invalid(f"{field} cannot be removed; leave it out to keep it.", field)
        body[field] = value
    if isinstance(body.get("command"), list):
        body["command"] = {"argv": list(body["command"])}
    if not body:
        raise _invalid("update takes at least one of command, image, compute, secrets, alert, "
                       "timeout_seconds, retry or max_total_cost_micros.", "update")
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


class Jobs:
    """``runtime.jobs``. Times are Unix milliseconds."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def _json(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self._t.json(*args, **kwargs)
        except RuntimeError as error:
            raise switched_off("Jobs", error) from error

    def create(self, name: str, *, command: Union[list[str], dict[str, Any]], at: Any = None,
                     cron: Optional[str] = None, timezone: Optional[str] = None,
                     timeout_seconds: Optional[int] = None, compute: Optional[dict[str, Any]] = None,
                     retry: Optional[dict[str, int]] = None, secrets: Optional[list[dict[str, str]]] = None,
                     max_total_cost_micros: Optional[int] = None, image: Optional[str] = None,
                     alert: Optional[dict[str, Any]] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Schedule a job: ``at=`` (a datetime, ISO time or Unix ms; a time
        already past runs at once) or ``cron="0 3 * * *"`` with an optional IANA
        ``timezone`` (UTC by default). ``command`` is an argv list, run without a
        shell, or ``{"argv": [...], "cwd": "/workspace/dir"}``. ``compute``
        overrides the 2 vCPU, 4 GiB default (``vcpu``, ``memoryMiB``,
        ``diskMiB``, ``cpuMode``, ``cpuFloorMillis``, ``region``,
        ``durationSeconds``, ``maxCostMicros``, and ``volumes``: up to four
        ``{"volumeId", "path", "mode"}`` each run attaches, ``"rw"`` one run at a
        time so the next run reads what the last wrote, or ``"snapshot"``, a
        read-only copy); ``timeout_seconds`` defaults to
        1800. ``retry={"maxAttempts": 3, "backoffSeconds": 30}`` retries a run
        that exits non-zero, up to 5 attempts. ``secrets=[{"name": "ENV_NAME",
        "secretId": ...}]`` puts jobs copies of secrets (``runtime.secrets.set(...,
        jobs=True)``) into the run's environment. ``image`` is an image of the
        account each run starts from (its id, name, ``name:tag`` or
        ``name@version``, resolved to its id now); the standard image by default.
        ``alert={"afterFailures": 3, "webhook": {"url": ..., "secretId": ...}}``
        (or ``"email": True``) tells a webhook, signed with that jobs secret as
        the account's webhooks are (one the key may reveal, not only use), or
        the job's person, once that many runs in a row fail, and once more when
        one succeeds again."""
        body = job_body(name, command=command, at=at, cron=cron, timezone=timezone,
                        timeout_seconds=timeout_seconds, compute=compute, retry=retry, secrets=secrets,
                        max_total_cost_micros=max_total_cost_micros, image=image, alert=alert)
        return self._json("POST", "/v1/jobs", body=body, idempotency_key=idempotency_key)

    def list(self, *, limit: Optional[int] = None) -> Page:
        """Your jobs, oldest first. ``for`` walks every page."""
        from .._sync_client import Page

        def fetch(cursor: Optional[str]) -> Page:
            body = self._json("GET", "/v1/jobs", query={"limit": limit, "cursor": cursor})
            return Page(body["items"], body.get("nextCursor"), fetch)
        return fetch(None)

    def get(self, job_id: str) -> dict[str, Any]:
        return self._json("GET", f"/v1/jobs/{_enc(job_id)}")

    def import_plan(self, files: list[dict[str, str]], *, from_: Optional[str] = None,
                          parameters: Optional[dict[str, str]] = None) -> dict[str, Any]:
        """Read a Google Cloud Run job's YAML (with the Cloud Scheduler job
        that runs it) or an AWS Batch job definition (with the EventBridge
        schedule or rule that submits it) into the Runtime jobs that run the
        same container, and what could not be carried over. ``files`` is
        ``[{"path": "job.yaml", "text": ...}]``; ``from_`` is ``"cloud-run"`` or
        ``"aws-batch"`` (found from the files when omitted); ``parameters``
        are a CloudFormation template's values, such as
        ``{"AWS::Region": "us-east-1"}``. Changes nothing: ``runtime jobs
        import`` builds and creates the plan."""
        body: dict[str, Any] = {"files": files}
        if from_ is not None:
            body["from"] = from_
        if parameters:
            body["parameters"] = parameters
        return self._json("POST", "/v1/job-imports", body=body)

    def runs(self, job_id: str, *, limit: Optional[int] = None,
                   order: Optional[Literal["oldest", "newest"]] = None) -> Page:
        """A job's runs, oldest first: each attempt of each occurrence.
        ``order="newest"``: newest first, so the last run is one call."""
        from .._sync_client import Page

        def fetch(cursor: Optional[str]) -> Page:
            body = self._json("GET", f"/v1/jobs/{_enc(job_id)}/runs",
                                    query={"limit": limit, "cursor": cursor, "order": order})
            return Page(body["items"], body.get("nextCursor"), fetch)
        return fetch(None)

    def run(self, run_id: str) -> dict[str, Any]:
        """One run by its id. ``state`` ``unknown`` means the outcome could not
        be observed; it is never retried by itself."""
        return self._json("GET", f"/v1/job-runs/{_enc(run_id)}")

    def logs(self, run_id: str, *, cursor: Optional[int] = None,
                   limit_bytes: Optional[int] = None) -> dict[str, Any]:
        """A run's output from ``cursor`` (a byte offset), at most ``limit_bytes``
        (4 to 65536, default 16384). Call again with ``nextCursor`` until
        ``complete``. A run keeps its last 256 KiB."""
        return self._json("GET", f"/v1/job-runs/{_enc(run_id)}/logs",
                                query={"cursor": cursor, "limitBytes": limit_bytes})

    def pause(self, job_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Stop scheduling new runs; a run already going finishes."""
        return self._json("POST", f"/v1/jobs/{_enc(job_id)}:pause", body={}, idempotency_key=idempotency_key)

    def resume(self, job_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        return self._json("POST", f"/v1/jobs/{_enc(job_id)}:resume", body={}, idempotency_key=idempotency_key)

    def trigger(self, job_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Run it now, once, beside its schedule, which does not move. A paused
        job runs once and stays paused. While a run is starting or going it is
        refused with ``run_in_progress``; a cancelled or finished job with
        ``invalid_state``. The run is in ``runs`` with ``trigger`` ``manual``."""
        return self._json("POST", f"/v1/jobs/{_enc(job_id)}:trigger", body={}, idempotency_key=idempotency_key)

    def reschedule(self, job_id: str, *, at: Any = None, cron: Optional[str] = None,
                     timezone: Optional[str] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """A new schedule: ``cron=`` with an optional ``timezone``, or ``at=``
        for one run. The next run is the new schedule's next time; a run going
        finishes as it began, and a paused job stays paused."""
        body = {"schedule": job_schedule(at=at, cron=cron, timezone=timezone)}
        return self._json("POST", f"/v1/jobs/{_enc(job_id)}:reschedule", body=body,
                                idempotency_key=idempotency_key)

    def update(self, job_id: str, *, command: Any = KEEP, image: Any = KEEP, compute: Any = KEEP,
                     secrets: Any = KEEP, alert: Any = KEEP, timeout_seconds: Any = KEEP, retry: Any = KEEP,
                     max_total_cost_micros: Any = KEEP,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Change a job in place: what is given changes, the rest stays. Its id,
        history and schedule stay (``reschedule`` moves the schedule); a run
        already started finishes as it began, and the next run is the new job.
        ``compute`` and ``retry`` change the fields given; ``secrets`` and
        ``compute["volumes"]`` replace the list. ``image=None`` goes back to the standard image, ``alert=None``
        removes the alert and ``max_total_cost_micros=None`` the cap."""
        body = job_update_body(command=command, image=image, compute=compute, secrets=secrets, alert=alert,
                               timeout_seconds=timeout_seconds, retry=retry,
                               max_total_cost_micros=max_total_cost_micros)
        return self._json("POST", f"/v1/jobs/{_enc(job_id)}:update", body=body,
                                idempotency_key=idempotency_key)

    def cancel(self, job_id: str, *, idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """End the job for good and stop any run in progress. A run that already
        finished keeps its result."""
        return self._json("POST", f"/v1/jobs/{_enc(job_id)}:cancel", body={}, idempotency_key=idempotency_key)
