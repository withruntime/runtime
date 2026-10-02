"""runtime.sandboxes.stop_all(labels=...) stops a labelled group.

There was no way to stop sandboxes by label (live product, 2 October 2026).
"""
import threading
import unittest

from withruntime._errors import ConflictError, RuntimeError
from withruntime._sync_client import Sandboxes

IDS = [f"11111111-2222-4333-8444-00000000000{n}" for n in (1, 2, 3)]


class FakeTransport:
    def __init__(self, failing):
        self.failing, self.seen, self.lock = failing, [], threading.Lock()

    def json(self, method, path, query=None, body=None, **_):
        with self.lock:
            self.seen.append((method, path, query))
        if method == "GET" and path == "/v1/sandboxes":
            return {"data": [{"id": i, "state": "running", "labels": {"run": "afternoon"}} for i in IDS],
                    "nextCursor": None}
        if path.endswith(":stop"):
            sandbox_id = path.split("/")[3].split(":")[0]
            if sandbox_id == self.failing:
                raise ConflictError("Busy.", code="conflict", status=409)
            return {"id": sandbox_id, "state": "stopped"}
        raise AssertionError(path)


class StopAll(unittest.TestCase):
    def test_stops_each_match_and_names_the_failure(self):
        t = FakeTransport(IDS[1])
        result = Sandboxes(t).stop_all(labels={"run": "afternoon"})
        self.assertEqual(result["stopped"], [IDS[0], IDS[2]])
        self.assertEqual([f["id"] for f in result["failed"]], [IDS[1]])
        self.assertIsInstance(result["failed"][0]["error"], ConflictError)
        self.assertEqual(t.seen[0][2]["label"], ["run:afternoon"])

    def test_no_label_stops_nothing(self):
        t = FakeTransport(None)
        with self.assertRaises(RuntimeError):
            Sandboxes(t).stop_all(labels={})
        self.assertEqual(t.seen, [])


if __name__ == "__main__":
    unittest.main()
