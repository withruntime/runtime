"""Modal Functions with a schedule, run as Runtime jobs.

``@app.function(schedule=modal.Cron(...) or modal.Period(...))`` declares
one; ``python -m withruntime.modal deploy app.py`` (Modal's ``modal deploy
app.py``) or ``app.deploy()`` makes each scheduled function a Runtime job on
that schedule. Every function of the app runs from one image that holds every
function's packages, so a scheduled function's ``.remote()``, ``.local()``,
``.map()``, ``.for_each()`` and ``.spawn()`` calls run in the same sandbox, as
plain calls. A function's ``cpu``, ``memory``, ``timeout`` and ``retries``
size its job; ``secrets=[modal.Secret.from_name(name, required_keys=[...])]``
binds each key from the Runtime jobs secret of that name.

A Period under a minute (Modal's own example has ``Period(seconds=5)``) runs
as a job each minute that calls the function every that many seconds through
the minute. GPUs, volumes, web endpoints and classes are refused by name.
"""
from __future__ import annotations
import math
import os
import re
import sys
import time
from .._compat import CompatibilityError

MAX_RUN_SECONDS = 3600
MAX_ATTEMPTS = 5


class Cron:
    """``modal.Cron("0 9 * * 1-5", timezone="America/New_York")``."""

    def __init__(self, cron_string, timezone="UTC"):
        if not isinstance(cron_string, str) or len(cron_string.split()) != 5:
            raise ValueError(f"{cron_string!r} is not five cron fields")
        self.cron_string, self.timezone = cron_string, timezone

    def _job(self):
        return {"cron": _numeric(self.cron_string), "timezone": self.timezone, "every": None}

    def __repr__(self):
        return f"Cron({self.cron_string!r}, timezone={self.timezone!r})"


class Period:
    """``modal.Period(days=1)``, ``Period(hours=2)``, ``Period(seconds=5)``."""

    def __init__(self, *, years=0, months=0, weeks=0, days=0, hours=0, minutes=0, seconds=0):
        if years or months:
            raise CompatibilityError("A Period of months or years has no fixed length: use "
                                     "modal.Cron('0 0 1 * *') for monthly")
        self.seconds = int(((weeks * 7 + days) * 24 + hours) * 3600 + minutes * 60 + seconds)
        if self.seconds < 1:
            raise ValueError("A Period is at least one second")

    def _job(self):
        s = self.seconds
        if s < 60:
            if 60 % s:
                raise CompatibilityError(f"Period(seconds={s}) does not divide a minute: use 1, 2, 3, 4, 5, 6, "
                                         "10, 12, 15, 20 or 30 seconds, or whole minutes")
            return {"cron": "* * * * *", "timezone": "UTC", "every": s}
        if s == 7 * 86400:
            return {"cron": "0 0 * * 0", "timezone": "UTC", "every": None}
        for unit, size, cron, limit in (("minute", 60, "*/{n} * * * *", 60), ("hour", 3600, "0 */{n} * * *", 24),
                                        ("day", 86400, "0 0 */{n} * *", 31)):
            n = s // size
            if s % size == 0 and n < limit and (limit % n == 0 or unit == "day"):
                if n == 1:
                    return {"cron": cron.replace("*/{n}", "*"), "timezone": "UTC", "every": None}
                return {"cron": cron.format(n=n), "timezone": "UTC", "every": None}
        raise CompatibilityError(f"A Period of {s} seconds has no cron that runs as often: use modal.Cron")

    def __repr__(self):
        return f"Period(seconds={self.seconds})"


class Retries:
    def __init__(self, *, max_retries, backoff_coefficient=2.0, initial_delay=1.0, max_delay=60.0):
        self.max_retries, self.initial_delay = max_retries, initial_delay


_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def _numeric(cron):
    fields = cron.split()

    def names(field, table, first):
        return re.sub(r"[A-Za-z]{3}", lambda m: str(table.index(m.group(0).upper()) + first), field)
    try:
        fields[3], fields[4] = names(fields[3], _MONTHS, 1), names(fields[4], _DAYS, 0)
    except ValueError:
        raise ValueError(f"{cron!r} uses a name cron does not know") from None
    return " ".join(fields)


_REFUSED = {
    "gpu": "Runtime's machines have no GPU",
    "volumes": "attach a Runtime volume to the job instead (runtime jobs update <id> --volume <volumeId>:/data)",
    "network_file_systems": "attach a Runtime volume to the job instead",
    "cloud_bucket_mounts": "read the bucket over the network in the function",
    "web_endpoint": "a scheduled function serves no web requests: run a web app on Runtime Apps",
    "clustered": "a job runs on one machine",
}


class Function:
    """A function an ``App`` declares. Called in the run it is in."""

    def __init__(self, app, fn, options):
        self._app, self._fn, self._options = app, fn, options
        self.__name__ = getattr(fn, "__name__", "function")
        self.__doc__ = getattr(fn, "__doc__", None)
        self.tag = options.get("name") or self.__name__
        for key, why in _REFUSED.items():
            if options.get(key):
                raise CompatibilityError(f"{self.tag}'s {key}: {why}")
        schedule = options.get("schedule")
        if schedule is not None and not isinstance(schedule, (Cron, Period)):
            raise TypeError("schedule is a modal.Cron or a modal.Period")
        self.schedule = schedule

    def __call__(self, *args, **kwargs):
        return self._fn(*args, **kwargs)

    def local(self, *args, **kwargs):
        return self._fn(*args, **kwargs)

    def remote(self, *args, **kwargs):
        return self._call(self._fn(*args, **kwargs))

    async def _await(self, value):
        return await value

    def _call(self, value):
        # An async function's coroutine runs to its end here, as .remote() returns its result.
        if hasattr(value, "__await__"):
            import asyncio
            return asyncio.run(self._await(value))
        return value

    def map(self, *iterables, order_outputs=True, return_exceptions=False):
        for args in zip(*iterables):
            try:
                yield self._call(self._fn(*args))
            except Exception as error:  # noqa: BLE001 - returned in its place, as Modal's map does
                if not return_exceptions:
                    raise
                yield error

    def starmap(self, args_list, *, order_outputs=True, return_exceptions=False):
        for args in args_list:
            yield self._call(self._fn(*args))

    def for_each(self, *iterables, ignore_exceptions=False):
        for args in zip(*iterables):
            try:
                self._call(self._fn(*args))
            except Exception:  # noqa: BLE001
                if not ignore_exceptions:
                    raise

    def spawn(self, *args, **kwargs):
        result = self._call(self._fn(*args, **kwargs))

        class _Call:
            object_id = None

            def get(self, timeout=None):
                return result
        return _Call()

    # What its job is made of.

    def _compute(self):
        cpu = self._options.get("cpu")
        memory = self._options.get("memory")
        cpu = cpu[1] if isinstance(cpu, tuple) else cpu
        memory = memory[1] if isinstance(memory, tuple) else memory
        compute = {}
        if cpu is not None:
            compute["vcpu"] = max(1, math.ceil(float(cpu)))
        if memory is not None:
            mib = max(128, int(memory))
            compute["memoryMiB"] = mib + (mib % 2)
        return compute

    def _timeout(self):
        return min(MAX_RUN_SECONDS, int(self._options.get("timeout") or 300))

    def _attempts(self):
        retries = self._options.get("retries")
        if isinstance(retries, Retries):
            retries = retries.max_retries
        return min(MAX_ATTEMPTS, int(retries or 0) + 1)

    def _secret_keys(self):
        keys = []
        for secret in self._options.get("secrets") or []:
            names = getattr(secret, "_job_keys", None)
            if names is None:
                raise CompatibilityError(
                    f"{self.tag}'s secrets: a job reads Runtime jobs secrets by name. Store each variable "
                    "(runtime secrets set NAME --jobs) and pass modal.Secret.from_name(<any name>, "
                    "required_keys=[\"NAME\", ...])")
            keys.extend(names)
        return keys


def app_image(app):
    """One image for every function of the app: the first function's image,
    with every other function's steps after it."""
    from .image import Image
    images = []
    for fn in app._functions.values():
        image = fn._options.get("image") or app._image
        if image is not None and all(image is not other for other in images):
            images.append(image)
    if not images:
        return Image.debian_slim()
    base, lines = images[0], []
    first_line = base._dockerfile.split("\n", 1)[0]
    for image in images[1:]:
        head, _, rest = image._dockerfile.partition("\n")
        if head != first_line:
            raise CompatibilityError(
                f"The app's functions start from different images ({first_line[5:]} and {head[5:]}): a "
                "scheduled function's calls run in its own sandbox, so give every function one image")
        for line in rest.splitlines():
            if line and line not in base._dockerfile and line not in lines:
                lines.append(line)
    context = {}
    for image in images[1:]:
        context.update(image._context)
    return base._append(lines, context=context) if lines or context else base


def app_secret_keys(app):
    """Every variable any function of the app reads from its secrets, in
    order: a scheduled function's .remote(), .map() and .for_each() calls run
    in its own sandbox (as app_image gathers every function's packages), so
    the secrets of the functions it calls must reach that sandbox too."""
    keys = []
    for fn in app._functions.values():
        for key in fn._secret_keys():
            if key not in keys:
                keys.append(key)
    return keys


def deploy(app, source_path, *, runtime=None, out=print):
    """Each scheduled function of the app as a Runtime job: built, then made
    or updated by name (``<app>-<function>``)."""
    from .. import Runtime
    runtime = runtime or Runtime()
    scheduled = [fn for fn in app._functions.values() if fn.schedule is not None]
    if not scheduled:
        raise CompatibilityError(f"App {app.name!r} has no function with a schedule to run as a job: give one "
                                 "schedule=modal.Cron(...) or modal.Period(...)")
    package = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    image = (app_image(app)
             .add_local_dir(package, "/opt/runtime-jobs/withruntime", copy=True,
                            ignore=["**/__pycache__/**", "**/*.pyc"])
             .add_local_file(source_path, "/workspace/app/" + os.path.basename(source_path), copy=True))
    out(f"Building {app.name}'s image...")
    image._load(runtime)
    jobs = {job["name"]: job for job in runtime.jobs.list(limit=100)
            if job.get("state") in ("active", "paused")}
    keys = app_secret_keys(app)
    bindings = []
    if keys:
        secrets = runtime.secrets.all()
        for key in keys:
            found = next((s.get("jobs") for s in secrets if s.get("name") == key and s.get("jobs")), None)
            if not found:
                raise CompatibilityError(f"{app.name} needs the jobs secret {key}: store it first with "
                                         f"printf %s \"$VALUE\" | runtime secrets set {key} --jobs")
            bindings.append({"name": key, "secretId": found["id"]})
    made = []
    for fn in scheduled:
        name = re.sub(r"[^A-Za-z0-9_.-]", "-", f"{app.name}-{fn.tag}").lstrip("-_.")[:80]
        schedule = fn.schedule._job()
        argv = ["python", "/opt/runtime-jobs/withruntime/modal/_job_runner.py",
                "/workspace/app/" + os.path.basename(source_path), fn.tag]
        if schedule["every"]:
            argv.append(f"--every={schedule['every']}")
        timeout = fn._timeout()
        compute = {"durationSeconds": min(MAX_RUN_SECONDS, timeout + 30), **fn._compute()}
        retry = {"maxAttempts": fn._attempts(), "backoffSeconds": 10}
        same = jobs.get(name)
        if same:
            runtime.jobs.update(same["id"], command=argv, image=image._object_id, compute=compute,
                                timeout_seconds=timeout, retry=retry, secrets=bindings)
            runtime.jobs.reschedule(same["id"], cron=schedule["cron"], timezone=schedule["timezone"])
            job_id, action = same["id"], "updated"
        else:
            job_id = runtime.jobs.create(name, command=argv, image=image._object_id, cron=schedule["cron"],
                                         timezone=schedule["timezone"], compute=compute, timeout_seconds=timeout,
                                         retry=retry, secrets=bindings or None)["id"]
            action = "created"
        every = f", every {schedule['every']} s through each minute" if schedule["every"] else ""
        out(f"✓ {fn.tag} → job {name} {job_id} ({schedule['cron']} {schedule['timezone']}{every}) {action}")
        made.append({"function": fn.tag, "job": name, "id": job_id, "action": action, **schedule})
    return made


def run_in_job(path, tag, every=None):
    """The job's command: imports the app's file and calls the function, or,
    for a Period under a minute, calls it every ``every`` seconds through the
    minute."""
    import importlib.util
    os.environ["RUNTIME_MODAL_IN_JOB"] = "1"
    spec = importlib.util.spec_from_file_location("__runtime_app__", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["__runtime_app__"] = module
    spec.loader.exec_module(module)
    for value in vars(module).values():
        functions = getattr(value, "_functions", None)
        if isinstance(functions, dict) and tag in functions:
            fn = functions[tag]
            break
    else:
        raise SystemExit(f"{path} declares no function {tag!r}: deploy again")
    if not every:
        fn.remote()
        return
    start = time.time()
    for n in range(60 // every):
        time.sleep(max(0.0, start + n * every - time.time()))
        fn.remote()
