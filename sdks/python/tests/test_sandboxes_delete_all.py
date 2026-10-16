"""runtime.sandboxes.delete_all(labels=...) deletes a labelled group.

Stop had a label form and delete did not (outside audit, 11 October 2026):
an agent that started fifty sandboxes deleted them one by one.
"""
import asyncio
import threading
import unittest

from withruntime._async_client import AsyncSandboxes
from withruntime._errors import ConflictError, RuntimeError
from withruntime._sync_client import Sandboxes

IDS = [f"11111111-2222-4333-8444-{n:012d}" for n in range(1, 8)]


class FakeTransport:
    """``count`` matching sandboxes, ``per_page`` to a page, running, stopped
    and paused in turn; ``failing`` refuses its delete."""

    def __init__(self, failing=None, count=3, per_page=100):
        self.failing, self.count, self.per_page = failing, count, per_page
        self.seen, self.lock = [], threading.Lock()

    def answer(self, method, path, query):
        with self.lock:
            self.seen.append((method, path, query))
        if method == "GET" and path == "/v1/sandboxes":
            start = int(query.get("cursor") or 0)
            end = min(self.count, start + self.per_page)
            states = ["running", "stopped", "paused"]
            return {"data": [{"id": IDS[i], "state": states[i % 3], "labels": {"run": "afternoon"}}
                             for i in range(start, end)],
                    "nextCursor": str(end) if end < self.count else None}
        if method == "DELETE":
            sandbox_id = path.split("/")[3]
            if sandbox_id == self.failing:
                raise ConflictError("Busy.", code="conflict", status=409)
            return {"id": sandbox_id, "deleted": True}
        raise AssertionError(path)

    def json(self, method, path, query=None, body=None, **_):
        return self.answer(method, path, query or {})


class AsyncFakeTransport(FakeTransport):
    async def json(self, method, path, query=None, body=None, **_):
        return self.answer(method, path, query or {})


class DeleteAll(unittest.TestCase):
    def test_deletes_each_match_stopped_ones_too_and_names_the_failure(self):
        t = FakeTransport(IDS[1])
        result = Sandboxes(t).delete_all(labels={"run": "afternoon"})
        self.assertEqual(result["deleted"], [IDS[0], IDS[2]])
        self.assertEqual([f["id"] for f in result["failed"]], [IDS[1]])
        self.assertIsInstance(result["failed"][0]["error"], ConflictError)
        self.assertEqual(t.seen[0][2]["label"], ["run:afternoon"])
        self.assertTrue(t.seen[0][2]["includeStopped"])

    def test_no_label_deletes_nothing(self):
        t = FakeTransport()
        for labels in ({}, None):
            with self.assertRaises(RuntimeError) as caught:
                Sandboxes(t).delete_all(labels=labels)
            self.assertIn("delete_all needs at least one label", str(caught.exception))
        self.assertEqual(t.seen, [])

    def test_reads_every_page_before_it_deletes(self):
        t = FakeTransport(count=7, per_page=3)
        result = Sandboxes(t).delete_all(labels={"run": "afternoon"})
        self.assertEqual(result["deleted"], IDS[:7])
        methods = [method for method, _, _ in t.seen]
        self.assertEqual(methods[:3], ["GET"] * 3)
        self.assertEqual(methods[3:], ["DELETE"] * 7)

    def test_no_match_deletes_nothing(self):
        t = FakeTransport(count=0)
        self.assertEqual(Sandboxes(t).delete_all(labels={"run": "evening"}), {"deleted": [], "failed": []})
        self.assertEqual([m for m, _, _ in t.seen], ["GET"])

    def test_stop_all_still_lists_only_live_ones(self):
        t = FakeTransport()
        Sandboxes(t).stop_all(labels={"run": "afternoon"})
        self.assertIsNone(t.seen[0][2].get("includeStopped"))

    def test_async_deletes_each_match_and_names_the_failure(self):
        t = AsyncFakeTransport(IDS[0])
        result = asyncio.run(AsyncSandboxes(t).delete_all(labels={"run": "afternoon"}))
        self.assertEqual(result["deleted"], [IDS[1], IDS[2]])
        self.assertEqual([f["id"] for f in result["failed"]], [IDS[0]])


if __name__ == "__main__":
    unittest.main()
