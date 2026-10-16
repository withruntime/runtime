"""A command the sandbox's out-of-memory killer ended says so (9 October
2026: a program killed for memory in a 512 MiB sandbox read as a bare exit -9
with empty output). The API gives ``outOfMemory``; the SDK carries it on the
result, the process and the error, in the API's own words."""

import unittest

from withruntime import CommandError
from withruntime._async_client import AsyncProcess
from withruntime._async_client import CommandResult as AsyncCommandResult
from withruntime._sync_client import CommandResult, Process

MEMORY = {"code": "out_of_memory", "processesKilled": 1, "memoryMiB": 512,
          "message": "The sandbox ran out of its 512 MiB of memory, and Linux's out-of-memory killer "
                     "ended 1 process of this command.",
          "hint": "Give the program more memory: create the sandbox with memoryMiB 1024 or more."}


class OutOfMemory(unittest.TestCase):
    def test_the_result_carries_it_both_ways(self) -> None:
        for kind in (CommandResult, AsyncCommandResult):
            result = kind.from_json({"exitCode": -9, "stdout": "", "stderr": "", "timedOut": False,
                                     "outOfMemory": MEMORY})
            self.assertEqual(result.out_of_memory, MEMORY)
            self.assertEqual(result.to_dict()["outOfMemory"], MEMORY)
            quiet = kind.from_json({"exitCode": 0, "stdout": "", "stderr": "", "timedOut": False})
            self.assertIsNone(quiet.out_of_memory)
            self.assertNotIn("outOfMemory", quiet.to_dict())

    def test_check_raises_out_of_memory_with_the_hint_and_no_retry(self) -> None:
        error = CommandError({"exitCode": -9, "stdout": "", "stderr": "", "outOfMemory": MEMORY})
        self.assertEqual(error.code, "out_of_memory")
        self.assertIn("512 MiB", error.message)
        self.assertEqual(error.hint, MEMORY["hint"])
        self.assertFalse(error.retryable)
        plain = CommandError({"exitCode": 1, "stdout": "", "stderr": "boom"})
        self.assertEqual(plain.code, "command_failed")

    def test_a_process_says_it(self) -> None:
        for kind in (Process, AsyncProcess):
            process = kind(None, "s", {"id": "p1", "state": "exited", "exitCode": -9, "outOfMemory": MEMORY})
            self.assertEqual(process.out_of_memory, MEMORY)
            self.assertIsNone(kind(None, "s", {"id": "p2"}).out_of_memory)


if __name__ == "__main__":
    unittest.main()
