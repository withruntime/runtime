"""A reader that stops at a process's ``exit`` event, as the Vercel adapter's
does, leaves no stream open: the loop's shutdown used to close the inner
event stream twice at once ("aclose(): asynchronous generator is already
running"), printed at the end of every async Vercel program."""
import asyncio
import unittest

from withruntime._async_client import AsyncProcess, AsyncSandbox


class Transport:
    """Event streams as _Transport.events gives them: the exit event, then
    the response's last bytes still to come, and a close that awaits."""

    def __init__(self) -> None:
        self.closed = 0

    async def events(self, method, path, **_):
        try:
            yield {"type": "start", "processId": "p"}
            yield {"type": "stdout", "data": "hi\n", "offset": 0}
            yield {"type": "exit", "exitCode": 0}
            await asyncio.sleep(3600)
        finally:
            await asyncio.sleep(0)
            self.closed += 1


def stop_at_exit(open_stream) -> tuple:
    errors = []
    transport = Transport()

    async def main():
        asyncio.get_running_loop().set_exception_handler(lambda _, context: errors.append(context["message"]))
        stream = open_stream(transport).__aiter__()
        while (await stream.__anext__())["type"] != "exit":
            pass
        main.kept = stream  # held, and never closed by the reader
        return transport.closed
    closed_at_exit = asyncio.run(main())
    return errors, closed_at_exit


class StoppingAtExit(unittest.TestCase):
    def test_process_output(self):
        errors, closed = stop_at_exit(lambda t: AsyncProcess(t, "s", {"id": "p"}).output())
        self.assertEqual((errors, closed), ([], 1))

    def test_exec_stream(self):
        errors, closed = stop_at_exit(lambda t: AsyncSandbox(t, {"id": "s"}).exec_stream("echo hi"))
        self.assertEqual((errors, closed), ([], 1))


if __name__ == "__main__":
    unittest.main()
