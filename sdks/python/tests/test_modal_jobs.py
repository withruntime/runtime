"""Modal scheduled functions as Runtime jobs (withruntime/modal/_functions.py),
with Modal's own examples: modal-labs/modal-examples 05_scheduling
schedule_simple.py and hackernews_alerts.py, fetched 26 October 2026, with
only ``import modal`` changed to ``from withruntime import modal``."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest

from withruntime import modal
from withruntime._compat import CompatibilityError
from withruntime.modal._functions import app_image, deploy

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures", "modal_jobs")
PACKAGE = os.path.dirname(HERE)


def load(name):
    text = open(os.path.join(FIXTURES, name)).read().replace("\nimport modal\n", "\nfrom withruntime import modal\n")
    folder = tempfile.mkdtemp()
    path = os.path.join(folder, name)
    with open(path, "w") as handle:
        handle.write(text)
    spec = importlib.util.spec_from_file_location(name[:-3], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, path


class _Jobs:
    def __init__(self, existing=()):
        self.calls, self.existing = [], list(existing)

    def list(self, limit=None):
        return iter(self.existing)

    def create(self, name, **fields):
        self.calls.append(("create", name, fields))
        return {"id": f"job-{name}"}

    def update(self, job_id, **fields):
        self.calls.append(("update", job_id, fields))

    def reschedule(self, job_id, **fields):
        self.calls.append(("reschedule", job_id, fields))


class _Images:
    def __init__(self):
        self.built = []

    def build(self, on_log=None, **fields):
        self.built.append(fields)
        return {"id": "img-1"}


class _Secrets:
    def all(self):
        return [{"name": "SLACK_BOT_TOKEN", "jobs": {"id": "sec-1", "version": 1}}]


class _Runtime:
    def __init__(self, existing=()):
        self.jobs, self.images, self.secrets = _Jobs(existing), _Images(), _Secrets()


class ModalJobsTest(unittest.TestCase):
    def test_schedule_simple_becomes_two_jobs(self):
        module, path = load("schedule_simple.py")
        runtime = _Runtime()
        made = deploy(module.app, path, runtime=runtime, out=lambda _: None)
        self.assertEqual([m["job"] for m in made],
                         ["example-schedule-simple-print_time_1", "example-schedule-simple-print_time_2"])
        first, second = runtime.jobs.calls
        # Period(seconds=5): a job each minute that calls it every 5 seconds.
        self.assertEqual(first[2]["cron"], "* * * * *")
        self.assertEqual(first[2]["command"][-1], "--every=5")
        self.assertEqual(second[2]["cron"], "* * * * *")
        self.assertEqual(second[2]["command"], ["python", "/opt/runtime-jobs/withruntime/modal/_job_runner.py",
                                                "/workspace/app/schedule_simple.py", "print_time_2"])
        self.assertEqual(second[2]["timeout_seconds"], 300)
        self.assertEqual(second[2]["image"], "img-1")
        dockerfile = runtime.images.built[0]["dockerfile"]
        self.assertTrue(dockerfile.startswith("FROM python:3.12-slim-bookworm\n"), dockerfile)
        self.assertIn("/opt/runtime-jobs/withruntime/", dockerfile)
        self.assertIn("/workspace/app/", dockerfile)

    def test_hackernews_alerts_runs_daily_with_every_functions_packages_and_its_secret(self):
        module, path = load("hackernews_alerts.py")
        runtime = _Runtime()
        made = deploy(module.app, path, runtime=runtime, out=lambda _: None)
        self.assertEqual([m["job"] for m in made], ["example-hackernews-alerts-run_daily"])
        (_, _, fields), = runtime.jobs.calls
        self.assertEqual(fields["cron"], "0 0 * * *")
        # run_daily calls search_hackernews.remote(), which calls
        # post_to_slack.for_each(): one image holds requests and slack-sdk.
        dockerfile = runtime.images.built[0]["dockerfile"]
        self.assertIn("slack-sdk", dockerfile)
        self.assertIn("requests", dockerfile)
        image = app_image(module.app)
        self.assertIn("requests", image._dockerfile)
        # post_to_slack reads SLACK_BOT_TOKEN in run_daily's sandbox: the
        # secret of every function the app holds is bound to the job, from
        # the jobs secret of that name.
        self.assertEqual(module.post_to_slack._secret_keys(), ["SLACK_BOT_TOKEN"])
        self.assertEqual(fields["secrets"], [{"name": "SLACK_BOT_TOKEN", "secretId": "sec-1"}])

    def test_a_job_of_the_same_name_is_updated_in_place(self):
        module, path = load("schedule_simple.py")
        runtime = _Runtime([{"id": "j1", "name": "example-schedule-simple-print_time_2", "state": "active"}])
        deploy(module.app, path, runtime=runtime, out=lambda _: None)
        kinds = [(c[0], c[1]) for c in runtime.jobs.calls]
        self.assertIn(("update", "j1"), kinds)
        self.assertIn(("reschedule", "j1"), kinds)

    def test_what_a_job_cannot_be_is_refused_by_name(self):
        app = modal.App("x")
        with self.assertRaisesRegex(CompatibilityError, "no GPU"):
            app.function(gpu="A100", schedule=modal.Cron("* * * * *"))(lambda: None)
        with self.assertRaisesRegex(CompatibilityError, "does not divide a minute"):
            modal.Period(seconds=7)._job()
        with self.assertRaisesRegex(CompatibilityError, "required_keys"):
            modal.Secret.from_name("x")
        missing = modal.App("y")
        def tick():
            pass

        def helper():
            pass

        missing.function(schedule=modal.Cron("* * * * *"))(tick)
        missing.function(secrets=[modal.Secret.from_name("s", required_keys=["NOT_STORED"])])(helper)
        with self.assertRaisesRegex(CompatibilityError, "needs the jobs secret NOT_STORED"):
            deploy(missing, __file__, runtime=_Runtime(), out=lambda _: None)
        with self.assertRaisesRegex(CompatibilityError, "no function with a schedule"):
            deploy(app, __file__, runtime=_Runtime(), out=lambda _: None)

    def test_schedules(self):
        self.assertEqual(modal.Cron("0 9 * * MON-FRI", timezone="America/New_York")._job(),
                         {"cron": "0 9 * * 1-5", "timezone": "America/New_York", "every": None})
        self.assertEqual(modal.Period(hours=1)._job()["cron"], "0 * * * *")
        self.assertEqual(modal.Period(minutes=15)._job()["cron"], "*/15 * * * *")
        self.assertEqual(modal.Period(weeks=1)._job()["cron"], "0 0 * * 0")

    def test_the_job_command_runs_the_function(self):
        _, path = load("schedule_simple.py")
        out = subprocess.run([sys.executable, os.path.join(PACKAGE, "withruntime", "modal", "_job_runner.py"),
                              path, "print_time_2"], capture_output=True, text=True,
                             env={**os.environ, "PYTHONPATH": PACKAGE}, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("Printing with cron every minute", out.stdout)


if __name__ == "__main__":
    unittest.main()
