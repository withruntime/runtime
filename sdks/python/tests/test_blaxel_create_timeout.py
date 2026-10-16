"""blaxel 0.4.13's creation deadline: SandboxInstance.create(config, timeout=N)
gives up after N whole seconds, releases the sandbox and raises
SandboxCreationTimeoutError. Before, withruntime.blaxel had no timeout
parameter (a TypeError), ignored ``safe``, and importing the error class
failed."""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from dropin_fake import BlaxelWorld  # noqa: E402

import withruntime.blaxel as bl  # noqa: E402
from withruntime.blaxel import (MAX_CREATION_TIMEOUT_SECONDS, SandboxAPIError,  # noqa: E402
                                SandboxCreationTimeoutError, SyncCodeInterpreter, SyncSandboxFileSystem,
                                SyncSandboxInstance, is_creation_timeout_error)
from withruntime.blaxel.core.sandbox import SandboxCreationTimeoutError as FromCore  # noqa: E402

SAVED = dict(os.environ)


class CreateTimeout(unittest.TestCase):
    def setUp(self) -> None:
        os.environ.update(RUNTIME_API_URL="http://localhost:9", RUNTIME_API_KEY="rtcloud_test_never_sent")
        self.world = BlaxelWorld()
        self.client = self.world.client()
        bl.use_client(self.client)

    def tearDown(self) -> None:
        bl.use_client(None)
        os.environ.clear()
        os.environ.update(SAVED)

    def stay(self, state: str, then: str = "") -> None:
        """New sandboxes answer the create in ``state``; the wait for running
        leaves them there, or moves them to ``then``."""
        create = self.client.sandboxes.create

        def slow(**fields):
            made = create(**fields)
            made.info["state"] = state

            def wait_for(wanted, timeout_seconds=60):
                self.world.record("sandbox.wait_for", made.id, wanted, timeout_seconds)
                if then:
                    made.info["state"] = then
                return made
            made.wait_for = wait_for
            return made
        self.client.sandboxes.create = slow

    def test_blaxel_check_and_words_before_any_request(self):
        self.assertEqual(MAX_CREATION_TIMEOUT_SECONDS, 50)
        for timeout in (0, 51, 1.5, -1, True):
            with self.assertRaises(ValueError) as caught:
                SyncSandboxInstance.create({"name": "x"}, timeout=timeout)
            self.assertEqual(str(caught.exception), "SandboxInstance.create: 'timeout' must be a whole number "
                                                    f"of seconds between 1 and 50, got {timeout!r}.")
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_ready_in_time(self):
        self.stay("starting", then="running")
        box = SyncSandboxInstance.create({"name": "quick"}, timeout=10)
        self.assertEqual(box.metadata.name, "quick")
        fields = self.world.called("sandboxes.create")[-1][0]
        self.assertEqual((fields["wait"], fields["wait_for_capacity"]), (False, 10))
        wait = self.world.called("sandbox.wait_for")[-1]
        self.assertEqual(wait[1], "running")
        self.assertTrue(1 <= wait[2] <= 10)
        self.assertEqual(self.world.called("sandbox.delete"), [])

    def test_not_ready_in_time_deletes_and_raises_blaxels_error(self):
        self.stay("starting")
        with self.assertRaises(SandboxCreationTimeoutError) as caught:
            SyncSandboxInstance.create({"name": "late"}, timeout=1)
        error = caught.exception
        self.assertIs(FromCore, SandboxCreationTimeoutError)
        self.assertIsInstance(error, SandboxAPIError)
        self.assertTrue(is_creation_timeout_error(error))
        self.assertFalse(is_creation_timeout_error(ValueError("x")))
        self.assertEqual((error.status_code, error.code, error.sandbox_name, error.timeout),
                         (408, "CREATION_TIMEOUT", "late", 1))
        self.assertEqual(str(error), "Sandbox late was not ready within 1s; the creation was cancelled. "
                                     "It was still starting after 1s.")
        self.assertEqual(len(self.world.called("sandbox.delete")), 1)

    def test_stopped_while_starting_is_a_failed_start_not_a_timeout(self):
        self.stay("starting", then="stopped")
        with self.assertRaises(SandboxAPIError) as caught:
            SyncSandboxInstance.create({"name": "broken"}, timeout=5)
        self.assertNotIsInstance(caught.exception, SandboxCreationTimeoutError)
        self.assertIn("not running", str(caught.exception))
        self.assertEqual(len(self.world.called("sandbox.delete")), 1)

    def test_create_if_not_exists_never_deletes_the_sandbox_the_name_had(self):
        SyncSandboxInstance.create({"name": "kept"})
        self.stay("paused")
        again = SyncSandboxInstance.create_if_not_exists({"name": "kept"}, timeout=1)
        self.assertEqual(again.metadata.name, "kept")
        self.assertEqual(self.world.called("sandbox.delete"), [])

    def test_create_if_not_exists_passes_timeout_on(self):
        self.stay("starting")
        with self.assertRaises(SandboxCreationTimeoutError):
            SyncSandboxInstance.create_if_not_exists({"name": "new"}, timeout=1)

    def test_without_timeout_nothing_changes(self):
        SyncSandboxInstance.create({"name": "plain"})
        self.assertNotIn("wait", self.world.called("sandboxes.create")[-1][0])

    def test_safe_lists_root_and_a_failure_stops_the_sandbox(self):
        listed = []
        original = SyncSandboxFileSystem.ls
        fail = [False]

        def ls(self, path):
            listed.append(path)
            if fail[0]:
                raise OSError("guest unreachable")
            return original(self, path)
        SyncSandboxFileSystem.ls = ls
        try:
            SyncSandboxInstance.create({"name": "a"})
            self.assertEqual(listed, [])
            SyncSandboxInstance.create({"name": "b"}, safe=True)
            self.assertEqual(listed, ["/"])
            fail[0] = True
            stops = len(self.world.called("sandbox.stop"))
            with self.assertRaises(Exception):
                SyncSandboxInstance.create({"name": "c"}, safe=True)
            self.assertEqual(len(self.world.called("sandbox.stop")), stops + 1)
            # CodeInterpreter.create is safe by default, as Blaxel's is.
            listed.clear()
            fail[0] = False
            SyncCodeInterpreter.create({"name": "d"})
            self.assertEqual(listed, ["/"])
        finally:
            SyncSandboxFileSystem.ls = original


if __name__ == "__main__":
    unittest.main()
