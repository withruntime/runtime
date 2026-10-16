"""Options daytona 0.223.1 takes that withruntime.daytona accepted and then
dropped without a word: create's timeout, queue_timeout and kvm,
pip_install_from_requirements' pip options, dockerfile_commands' build
context, and wait_for_resize_complete. Each now does what Daytona's does, or
refuses before anything happens."""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from dropin_fake import DropInWorld  # noqa: E402

import withruntime  # noqa: E402
from withruntime.daytona import (CreateSandboxFromSnapshotParams, Daytona, DaytonaConnectionError,  # noqa: E402
                                 DaytonaConnectionTimeoutError, DaytonaQueueTimeoutError, DaytonaSpotEvictedError,
                                 DaytonaTimeoutError, DaytonaValidationError, Image, NotSupportedError)
from withruntime._request_scope import current  # noqa: E402
from withruntime.daytona._core import translate  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.world = DropInWorld()
        self.client = self.world.client()
        self.daytona = Daytona(client=self.client)

    def last_create(self):
        return self.world.called("sandboxes.create")[-1][0]


class CreateOptions(Base):
    def test_a_negative_timeout_is_daytonas_error_before_any_request(self):
        with self.assertRaises(DaytonaValidationError) as caught:
            self.daytona.create(timeout=-1)
        self.assertEqual(str(caught.exception), "Timeout must be a non-negative number")
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_timeout_bounds_the_create(self):
        create = self.client.sandboxes.create

        def slow(**fields):
            # As the transport does: a request checks the deadline of its scope.
            time.sleep(0.05)
            current().remaining()
            return create(**fields)
        self.client.sandboxes.create = slow
        with self.assertRaises(DaytonaTimeoutError) as caught:
            self.daytona.create(timeout=0.01)
        self.assertEqual(str(caught.exception), "Function 'create' exceeded timeout of 0.01 seconds.")
        self.client.sandboxes.create = create
        self.daytona.create(timeout=0)
        self.daytona.create()

    def test_queue_timeout_is_the_wait_for_room_in_minutes(self):
        self.daytona.create(CreateSandboxFromSnapshotParams(queue_timeout=3))
        self.assertEqual(self.last_create()["wait_for_capacity"], 180)
        self.daytona.create()
        self.assertNotIn("wait_for_capacity", self.last_create())
        for queue_timeout in (0, -2, 1.5, True):
            with self.assertRaises(DaytonaValidationError) as caught:
                self.daytona.create(CreateSandboxFromSnapshotParams(queue_timeout=queue_timeout))
            self.assertEqual(str(caught.exception), "queue_timeout must be a positive integer")

    def test_no_room_within_queue_timeout_is_a_queue_timeout_error(self):
        def full():
            return withruntime.ServiceUnavailableError("No room on any server.", code="no_capacity", status=503)

        def create(**fields):
            fields["on_capacity_wait"](full(), 1.0)
            raise full()
        self.client.sandboxes.create = create
        with self.assertRaises(DaytonaQueueTimeoutError) as caught:
            self.daytona.create(CreateSandboxFromSnapshotParams(queue_timeout=1))
        self.assertIsInstance(caught.exception, DaytonaTimeoutError)
        self.assertIn("queue_timeout of 1 minutes", str(caught.exception))
        self.assertEqual(caught.exception.code, "no_capacity")

    def test_another_refusal_passes_through_as_before(self):
        def create(**_):
            raise withruntime.InvalidRequestError("Bad.", code="invalid_request", status=400)
        self.client.sandboxes.create = create
        with self.assertRaises(Exception) as caught:
            self.daytona.create(CreateSandboxFromSnapshotParams(queue_timeout=1))
        self.assertNotIsInstance(caught.exception, DaytonaQueueTimeoutError)
        self.assertIn("Bad.", str(caught.exception))

    def test_kvm_is_refused_before_anything_is_created(self):
        with self.assertRaises(NotSupportedError) as caught:
            self.daytona.create(CreateSandboxFromSnapshotParams(kvm=True))
        self.assertIn("/dev/kvm", caught.exception.alternative)
        self.assertEqual(self.world.called("sandboxes.create"), [])
        self.daytona.create(CreateSandboxFromSnapshotParams(kvm=False))
        self.assertEqual(len(self.world.called("sandboxes.create")), 1)

    def test_wait_for_resize_complete_is_refused_like_resize(self):
        sandbox = self.daytona.create()
        with self.assertRaises(NotSupportedError):
            sandbox.wait_for_resize_complete()


class Timeouts(unittest.TestCase):
    def test_a_calls_own_deadline_is_a_connection_timeout(self):
        out = translate(withruntime.RuntimeError("Ran past its deadline.", code="timeout", status=0))
        self.assertIsInstance(out, DaytonaConnectionTimeoutError)
        self.assertIsInstance(out, DaytonaConnectionError)
        self.assertIsInstance(out, DaytonaTimeoutError)
        lost = translate(withruntime.RuntimeError("No answer.", code="connection_error", status=0))
        self.assertIsInstance(lost, DaytonaConnectionError)
        self.assertNotIsInstance(lost, DaytonaTimeoutError)

    def test_spot_evicted_exists(self):
        self.assertEqual(DaytonaSpotEvictedError("x").message, "x")


class ImageOptions(Base):
    def test_pip_install_from_requirements_takes_pips_options(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "requirements.txt"
            path.write_text("requests\n")
            image = Image.debian_slim("3.12").pip_install_from_requirements(
                str(path), find_links=["https://links.example"], index_url="https://pypi.example/simple",
                extra_index_urls=["https://extra.example/simple"], pre=True, extra_options="--no-cache-dir")
            self.assertRegex(image.dockerfile, r"RUN python -m pip install -r /\.requirements/[0-9a-f]{12}\.txt "
                                               r"--index-url https://pypi\.example/simple --extra-index-url "
                                               r"https://extra\.example/simple --find-links https://links\.example "
                                               r"--pre --no-cache-dir")

    def test_dockerfile_commands_context_and_strict_context(self):
        with self.assertRaises(NotSupportedError):
            Image.base("python:3.12").dockerfile_commands(["COPY . /app"], "./ctx")
        with self.assertRaises(DaytonaValidationError):
            Image.base("python:3.12").dockerfile_commands(["RUN true"], strict_context=True)
        self.assertIn('RUN echo "hi"', Image.base("python:3.12").dockerfile_commands(['RUN echo "hi"']).dockerfile)


if __name__ == "__main__":
    unittest.main()
