"""Synchronous binary process streaming; stdin drains concurrently with output."""
import threading
from ._capture import Captured
from .exceptions import NetworkError


def stream(command, sb, *, collect=True):
    options = {"env": command.env, "cwd": command.dir,
               "timeout_ms": int(command.timeout * 1000) if command.timeout and command.timeout > 0 else None,
               "output_encoding": "base64"}
    process = sb.process(command.session_id) if command.session_id else sb.spawn(
        command.args, stdin="pipe" if command.stdin is not None else None,
        pty={"rows": command.tty_rows, "cols": command.tty_cols} if command.tty else None, **options)
    command._process = process
    output = {"stdout": bytearray(), "stderr": bytearray()}
    status, failures = None, []
    done = threading.Event()

    def write_input():
        try:
            while not done.is_set():
                data = command.stdin.read(65536)
                if not data:
                    process.write(b"", eof=True)
                    return
                process.write(data)
        except Exception as error:
            if not done.is_set() and getattr(error, "code", None) != "stdin_closed":
                failures.append(error)
                try:
                    process.kill("SIGKILL")
                except Exception:
                    pass

    writer = threading.Thread(target=write_input, daemon=True) if command.stdin is not None else None
    if writer:
        writer.start()
    try:
        for event in process.output_bytes():
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
        if failures:
            raise failures[0]
        return Captured(bytes(output["stdout"]), bytes(output["stderr"]), status.get("exitCode"), bool(status.get("timedOut")))
    except BaseException:
        try:
            process.kill("SIGKILL")
        except Exception:
            pass
        raise
    finally:
        done.set()
        if writer:
            writer.join(timeout=0.1)
