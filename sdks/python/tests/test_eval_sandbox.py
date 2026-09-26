"""Exit codes in withruntime._eval_sandbox, which Harbor and Inspect share, as the
live API reports them (read on 25 September 2026): a command past its limit ends
with -9 and timedOut, and a command a signal ended with the negative signal
number. Harbor and Inspect expect what a shell reports. Needs neither."""
import asyncio
import unittest

from withruntime._eval_sandbox import _Shell, shell_exit_code


class _Sandbox:
    id = "sbx_exit"

    def __init__(self, exit_event):
        self.exit_event = exit_event

    async def exec_stream(self, argv, *, env=None, stdin=None, timeout_ms=None):
        yield {"type": "start", "processId": "p1"}
        yield self.exit_event


def _run(exit_event):
    shell = _Shell(_Sandbox(exit_event), "/tmp")
    return asyncio.run(shell._stream(["sh", "-c", "x"], None, None, 1000, None, None))


class ShellExitCodeTest(unittest.TestCase):
    def test_a_timed_out_command_is_124(self):
        result = _run({"type": "exit", "exitCode": -9, "state": "timed_out", "timedOut": True})
        self.assertEqual((result.exit_code, result.timed_out), (124, True))

    def test_a_command_a_signal_ended_is_128_plus_the_signal(self):
        self.assertEqual(_run({"type": "exit", "exitCode": -15, "timedOut": False}).exit_code, 143)
        self.assertEqual(_run({"type": "exit", "exitCode": -9, "timedOut": False}).exit_code, 137)

    def test_ordinary_codes_are_kept(self):
        self.assertEqual(_run({"type": "exit", "exitCode": 3, "timedOut": False}).exit_code, 3)
        self.assertEqual(shell_exit_code(0, False), 0)
        self.assertEqual(shell_exit_code(None, False), -1)


if __name__ == "__main__":
    unittest.main()
