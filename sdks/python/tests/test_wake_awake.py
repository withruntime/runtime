"""Waking a sandbox that is already awake is done, not an error (25 September 2026)."""
import unittest
from withruntime._sync_client import Sandbox
from withruntime._errors import RuntimeError


class Transport:
    def __init__(self, state):
        self.state, self.calls = state, []

    def json(self, method, path, **kwargs):
        self.calls.append((method, path))
        if path.endswith(":wake"):
            raise RuntimeError("Only a paused sandbox can be woken.", code="not_paused", status=409)
        return {"id": "s", "state": self.state}


class WakeAwake(unittest.TestCase):
    def test_awake_is_done(self):
        sbx = Sandbox(Transport("running"), {"id": "s", "state": "running"})
        self.assertIs(sbx.wake(), sbx)
        self.assertEqual(sbx.state, "running")

    def test_stopped_still_refused(self):
        with self.assertRaises(RuntimeError):
            Sandbox(Transport("stopped"), {"id": "s", "state": "stopped"}).wake()

    def test_new_lease_still_refused(self):
        with self.assertRaises(RuntimeError):
            Sandbox(Transport("running"), {"id": "s", "state": "running"}).wake(timeout_seconds=600)


if __name__ == "__main__":
    unittest.main()
