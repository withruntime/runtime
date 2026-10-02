"""A full process-input buffer must yield before resending unaccepted bytes."""
import asyncio
import base64
import unittest
from unittest.mock import patch

from withruntime._async_client import AsyncProcess
from withruntime._sync_client import Process


class Pipe:
    def __init__(self, asynchronous=False):
        self.calls = []
        self.asynchronous = asynchronous

    def json(self, method, path, body):
        self.calls.append(body)
        # Refuse the first nonempty write, then accept half, then the rest.
        data = base64.b64decode(body["base64"])
        accepted = 0 if len(self.calls) == 1 and data else max(1, len(data) // 2) if data else 0
        answer = {"offset": body["offset"] + accepted}
        if self.asynchronous:
            async def done():
                return answer
            return done()
        return answer


class ProcessBackpressure(unittest.TestCase):
    def test_partial_acceptance_sends_binary_input_with_bounded_amplification(self):
        data = bytes(range(256)) * 32_768  # 8 MiB, every byte value represented.

        class PartialPipe:
            def __init__(self, asynchronous=False):
                self.data = bytearray()
                self.sent = 0
                self.calls = []
                self.closed = False
                self.asynchronous = asynchronous

            def json(self, method, path, body):
                chunk = base64.b64decode(body["base64"])
                self.calls.append((body["offset"], len(chunk), body["eof"]))
                assert body["offset"] == len(self.data)
                self.sent += len(chunk)
                accepted = min(65_536, len(chunk))
                self.data.extend(chunk[:accepted])
                self.closed = body["eof"] and accepted == len(chunk)
                reply = {"offset": len(self.data)}
                if self.asynchronous:
                    async def done():
                        return reply
                    return done()
                return reply

        def check(pipe):
            self.assertEqual(bytes(pipe.data), data)
            self.assertEqual(len(pipe.calls), 128)
            self.assertEqual(pipe.sent, len(data) + 983_040)
            self.assertEqual(pipe.calls[0], (0, 1_048_576, False))
            self.assertTrue(all(length == 65_536 for _, length, _ in pipe.calls[1:]))
            self.assertTrue(all(not eof for _, _, eof in pipe.calls[:-1]))
            self.assertTrue(pipe.closed)

        pipe = PartialPipe()
        process = Process(pipe, "s", {"id": "p"})
        process.write(data, eof=True)
        check(pipe)

        async def run():
            pipe = PartialPipe(asynchronous=True)
            process = AsyncProcess(pipe, "s", {"id": "p"})
            await process.write(data, eof=True)
            check(pipe)
        asyncio.run(run())

    def test_each_logical_write_starts_with_a_fresh_chunk_size(self):
        class ReadyPipe:
            def __init__(self):
                self.calls = []

            def json(self, method, path, body):
                chunk = base64.b64decode(body["base64"])
                self.calls.append(len(chunk))
                accepted = min(len(chunk), 65_536) if len(self.calls) == 1 else len(chunk)
                return {"offset": body["offset"] + accepted}

        pipe = ReadyPipe()
        process = Process(pipe, "s", {"id": "p"})
        process.write(b"a" * 1_048_576)
        first_end = len(pipe.calls)
        process.write(b"b" * 1_048_576)
        self.assertEqual(pipe.calls[first_end], 1_048_576)

    def test_zero_acceptance_retries_a_bounded_probe(self):
        pipe = Pipe()
        process = Process(pipe, "s", {"id": "p"})
        with patch("withruntime._sync_client.sleep"):
            process.write(b"a" * 131_072, eof=True)
        self.assertEqual(len(base64.b64decode(pipe.calls[0]["base64"])), 131_072)
        self.assertEqual(len(base64.b64decode(pipe.calls[1]["base64"])), 65_536)
        self.assertEqual(pipe.calls[1]["offset"], 0)

    def test_sync_waits_on_zero_acceptance_preserving_bytes_offsets_and_eof(self):
        pipe = Pipe()
        process = Process(pipe, "s", {"id": "p"})
        with patch("withruntime._sync_client.sleep") as pause:
            process.write("abcd", eof=True)
        pause.assert_called_once_with(0.1)
        self.assertEqual([body["offset"] for body in pipe.calls], [0, 0, 2, 3])
        self.assertEqual([base64.b64decode(body["base64"]) for body in pipe.calls],
                         [b"abcd", b"abcd", b"cd", b"d"])
        self.assertTrue(all(body["eof"] for body in pipe.calls))
        self.assertEqual(process._input_offset, 4)

    def test_async_wait_yields_to_other_tasks_before_retrying(self):
        async def run():
            pipe = Pipe(asynchronous=True)
            process = AsyncProcess(pipe, "s", {"id": "p"})
            heartbeat = []

            async def other_task():
                heartbeat.append("ran")

            async def pause(delay):
                self.assertEqual(delay, 0.1)
                self.assertEqual(len(pipe.calls), 1)
                await asyncio.sleep(0)
                self.assertEqual(heartbeat, ["ran"])

            task = asyncio.create_task(other_task())
            with patch("withruntime._async_client.sleep", side_effect=pause) as waited:
                await process.write("abcd", eof=True)
            await task
            waited.assert_awaited_once_with(0.1)
            self.assertEqual([body["offset"] for body in pipe.calls], [0, 0, 2, 3])
            self.assertEqual(process._input_offset, 4)
        asyncio.run(run())

    def test_empty_eof_finishes_without_backpressure_wait(self):
        pipe = Pipe()
        process = Process(pipe, "s", {"id": "p"})
        with patch("withruntime._sync_client.sleep") as pause:
            process.write(b"", eof=True)
        pause.assert_not_called()
        self.assertEqual(pipe.calls, [{"base64": "", "offset": 0, "eof": True}])

        async def run():
            pipe = Pipe(asynchronous=True)
            process = AsyncProcess(pipe, "s", {"id": "p"})
            with patch("withruntime._async_client.sleep") as pause:
                await process.write(b"", eof=True)
            pause.assert_not_called()
            self.assertEqual(pipe.calls, [{"base64": "", "offset": 0, "eof": True}])
        asyncio.run(run())

    def test_cancellation_while_waiting_keeps_the_unaccepted_offset(self):
        async def run():
            pipe = Pipe(asynchronous=True)
            process = AsyncProcess(pipe, "s", {"id": "p"})

            async def cancel(_):
                raise asyncio.CancelledError()

            with patch("withruntime._async_client.sleep", side_effect=cancel):
                with self.assertRaises(asyncio.CancelledError):
                    await process.write("abcd")
            self.assertEqual(len(pipe.calls), 1)
            self.assertEqual(process._input_offset, 0)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
