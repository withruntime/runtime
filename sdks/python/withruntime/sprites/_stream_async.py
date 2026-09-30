"""Binary process streams for Sprites commands, including PTYs and stdin."""
import asyncio
from ._capture_async import Captured
from .exceptions import NetworkError


async def stream(command, sb, *, collect=True):
    options = {"env": command.env, "cwd": command.dir,
               "timeout_ms": int(command.timeout * 1000) if command.timeout and command.timeout > 0 else None,
               "output_encoding": "base64"}
    process = (await sb.process(command.session_id)) if command.session_id else await sb.spawn(
        command.args, stdin="pipe" if command.stdin is not None else None,
        pty={"rows": command.tty_rows, "cols": command.tty_cols} if command.tty else None, **options)
    command._process = process
    output = {"stdout": bytearray(), "stderr": bytearray()}
    status = None

    async def write_input():
        try:
            while True:
                data = await asyncio.to_thread(command.stdin.read, 65536)
                if not data:
                    await process.write(b"", eof=True)
                    return
                await process.write(data)
        except Exception as error:
            if getattr(error, "code", None) != "stdin_closed":
                try:
                    await process.kill("SIGKILL")
                except Exception:
                    pass
                raise

    writer = asyncio.create_task(write_input()) if command.stdin is not None else None
    try:
        async for event in process.output_bytes():
            kind = event["type"]
            if kind in output:
                data = event["data"]
                if collect:
                    output[kind].extend(data)
                sink = command.stdout if kind == "stdout" else command.stderr
                if sink is not None:
                    sink.write(data)
                    if hasattr(sink, "flush"):
                        sink.flush()
            elif kind == "truncated":
                raise NetworkError("Command output was lost while reconnecting")
            elif kind == "exit":
                status = event
        if status is None:
            raise NetworkError("Command stream ended before exit status")
        if writer and writer.done() and not writer.cancelled():
            error = writer.exception()
            if error is not None and getattr(error, "code", None) != "stdin_closed":
                raise error
        return Captured(bytes(output["stdout"]), bytes(output["stderr"]), status.get("exitCode"), bool(status.get("timedOut")))
    except BaseException:
        try:
            await process.kill("SIGKILL")
        except Exception:
            pass
        raise
    finally:
        if writer:
            writer.cancel()
            await asyncio.gather(writer, return_exceptions=True)
