"""Wait budgets cover reconnect lookup and output; no remote process is killed."""
import asyncio
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from withruntime._request_scope import current
from withruntime.blaxel._async_sandbox import AsyncSandboxProcess
from withruntime.blaxel._sync_sandbox import SandboxProcess


class WaitDeadline(unittest.TestCase):
    def test_sync_lookup_uses_request_deadline_and_scope_is_reset(self):
        process = SandboxProcess(None)
        seen = []
        def lookup(_):
            seen.append(current().remaining())
            raise TimeoutError("Lookup deadline")
        process._resolve = lookup
        with self.assertRaisesRegex(TimeoutError, "Lookup deadline"):
            process.wait("command", max_wait=25)
        self.assertTrue(0 < seen[0] <= 0.025)
        self.assertIsNone(current().deadline)

    def test_invalid_and_zero_waits_never_start_lookup(self):
        for process in (SandboxProcess(None), AsyncSandboxProcess(None)):
            for maximum, interval in ((math.inf, 1), (math.nan, 1), (1, math.inf), (1, math.nan), (True, 1)):
                if isinstance(process, AsyncSandboxProcess):
                    with self.assertRaises(ValueError): asyncio.run(process.wait("command", max_wait=maximum, interval=interval))
                else:
                    with self.assertRaises(ValueError): process.wait("command", max_wait=maximum, interval=interval)
            if isinstance(process, AsyncSandboxProcess):
                with self.assertRaises(TimeoutError): asyncio.run(process.wait("command", max_wait=0))
            else:
                with self.assertRaises(TimeoutError): process.wait("command", max_wait=0)

    def test_async_lookup_and_output_share_one_deadline(self):
        async def run():
            process = AsyncSandboxProcess(None)
            seen = []
            async def lookup(_):
                seen.append(current().remaining())
                return "process-id"
            async def follow(*_):
                seen.append(current().remaining())
                raise TimeoutError("Output deadline")
            process._resolve, process._follow = lookup, follow
            with self.assertRaisesRegex(TimeoutError, "Output deadline"):
                await process.wait("command", max_wait=25)
            self.assertTrue(0 < seen[1] <= seen[0] <= 0.025)
            self.assertIsNone(current().deadline)
        asyncio.run(run())


if __name__ == "__main__": unittest.main()
