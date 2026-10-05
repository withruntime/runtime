"""Execute consumer workflows through real local pipes, PTYs and files.

These test adapter behavior; native network/reconnect and guest isolation are
covered separately by the API harness. No remote resources are used.
"""
import asyncio
import errno
import io
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from withruntime._compat import ENV_PATH
from withruntime.modal import Sandbox, ContainerProcess
from withruntime.prime import AsyncSandboxClient, SandboxClient
from withruntime.sprites import Sprite
from withruntime.sprites.async_client import AsyncSprite


class LocalFiles:
    def read(self, path): return Path(path).read_bytes()
    def write(self, path, data, mode=None):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(data.encode() if isinstance(data, str) else data)
        if mode is not None: os.chmod(path, mode)
    def mkdir(self, path, parents=True): Path(path).mkdir(parents=parents, exist_ok=parents)
    def remove(self, path, recursive=False):
        import shutil
        if not os.path.lexists(path): return False
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path) if recursive else os.rmdir(path)
        else: os.unlink(path)
        return True
    def download(self, source, target): Path(target).write_bytes(Path(source).read_bytes())
    def stat(self, path):
        import stat, pwd, grp
        if not os.path.lexists(path): return {"exists": False}
        value = os.lstat(path)
        return {"exists": True, "name": os.path.basename(path), "path": path,
            "type": "symlink" if stat.S_ISLNK(value.st_mode) else "directory" if stat.S_ISDIR(value.st_mode) else "file",
            "size": value.st_size, "mode": stat.S_IMODE(value.st_mode), "mtimeMs": value.st_mtime * 1000,
            "owner": pwd.getpwuid(value.st_uid).pw_name, "group": grp.getgrgid(value.st_gid).gr_name,
            **({"symlinkTarget": os.readlink(path)} if os.path.islink(path) else {})}
    def list(self, path, **kwargs): return [self.stat(str(value)) for value in Path(path).iterdir()]


class LocalProcess:
    def __init__(self, command, *, env=None, cwd=None, stdin=None, pty=None, **kwargs):
        self._master = None
        if pty:
            import pty as tty
            master, slave = tty.openpty()
            self._master = os.fdopen(master, "r+b", buffering=0)
            self._p = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd,
                                       start_new_session=True)
            os.close(slave)
        else:
            self._p = subprocess.Popen(command, stdin=subprocess.PIPE if stdin == "pipe" else subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=cwd, start_new_session=True)
        self.id = str(self._p.pid)
        self.info = {"id": self.id, "pid": self._p.pid, "outputEncoding": kwargs.get("output_encoding", "utf8")}
    def write(self, data, eof=False):
        if self._master:
            # The terminal is unbuffered, so the bytes are in once written, and
            # nothing may touch the file after: the shell can act on them and
            # exit, and the reader close the terminal, before the next line runs
            # (a flush here failed on Linux in 6 of 80 runs).
            view = memoryview(data)
            while view: view = view[self._master.write(view):]
            return
        file = self._p.stdin
        file.write(data)
        file.flush()
        if eof: file.close()
    def kill(self, name="SIGTERM"):
        if self._p.poll() is None: os.killpg(self._p.pid, getattr(signal, name))
    def output_bytes(self):
        selector = selectors.DefaultSelector()
        for source, channel in ((self._master, "stdout"),) if self._master else ((self._p.stdout, "stdout"), (self._p.stderr, "stderr")):
            selector.register(source, selectors.EVENT_READ, channel)
        try:
            while selector.get_map():
                events = selector.select(5)
                if not events:
                    self.kill("SIGKILL")
                    raise TimeoutError("local test process stalled")
                for key, _ in events:
                    try: data = os.read(key.fileobj.fileno(), 65536)
                    except OSError as error:
                        if self._master and error.errno == errno.EIO: data = b""
                        else: raise
                    if data: yield {"type": key.data, "data": data}
                    else:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
            code = self._p.wait(timeout=5)
            if self._p.stdin and not self._p.stdin.closed: self._p.stdin.close()
            yield {"type": "exit", "exitCode": code, "timedOut": False}
        finally:
            selector.close()
    def output(self):
        import codecs
        decoders = {key: codecs.getincrementaldecoder("utf8")() for key in ("stdout", "stderr")}
        for event in self.output_bytes():
            if event["type"] in decoders:
                data = decoders[event["type"]].decode(event["data"])
                if data: yield {**event, "data": data}
            else: yield event
    def wait(self):
        out = {"stdout": "", "stderr": ""}
        for event in self.output():
            if event["type"] in out: out[event["type"]] += event["data"]
        return SimpleNamespace(**out, exit_code=self._p.returncode, timed_out=False)


class LocalSandbox:
    id = "local-test"
    info = {"id": id, "labels": {}}
    files = LocalFiles()
    def spawn(self, command, **options):
        command = ["bash", "-c", command] if isinstance(command, str) else command
        return LocalProcess(command, **options)
    def exec(self, command, **options):
        result = subprocess.run(command, capture_output=True, env=options.get("env"), cwd=options.get("cwd"), timeout=5)
        return SimpleNamespace(stdout=result.stdout.decode(), stderr=result.stderr.decode(), exit_code=result.returncode,
            stdout_truncated=False, stderr_truncated=False, timed_out=False)


class AsyncFiles:
    def __init__(self, files): self.files = files
    def __getattr__(self, name):
        async def call(*args, **kwargs): return await asyncio.to_thread(getattr(self.files, name), *args, **kwargs)
        return call


class AsyncProcess:
    def __init__(self, process):
        self.process, self.id, self.info = process, process.id, process.info
    async def write(self, *args, **kwargs): return await asyncio.to_thread(self.process.write, *args, **kwargs)
    async def kill(self, *args, **kwargs): return await asyncio.to_thread(self.process.kill, *args, **kwargs)
    async def output_bytes(self):
        iterator, end = self.process.output_bytes(), object()
        while True:
            event = await asyncio.to_thread(next, iterator, end)
            if event is end: break
            yield event


class AsyncSandbox:
    id = LocalSandbox.id
    info = LocalSandbox.info
    def __init__(self): self.files = AsyncFiles(LocalFiles())
    async def spawn(self, command, **kwargs): return AsyncProcess(LocalSandbox().spawn(command, **kwargs))
    async def exec(self, *args, **kwargs): return await asyncio.to_thread(LocalSandbox().exec, *args, **kwargs)


class Processes(unittest.TestCase):
    def test_modal_raw_bytes_and_eof(self):
        process = ContainerProcess(LocalProcess([sys.executable, "-c",
            "import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.buffer.write(b'\\xff')"], stdin="pipe"),
            text=False, binary_transport=True)
        data = bytes(range(256)) * 4097
        process.stdin.write(data)
        process.stdin.write_eof()
        self.assertEqual(process.stdout.read(), data)
        self.assertEqual(process.stderr.read(), b"\xff")
        self.assertEqual(process.wait(), 0)

    def test_sprites_sink_receives_bytes_before_process_exit(self):
        ready = threading.Event()
        class Sink(io.BytesIO):
            def write(self, data):
                ready.set()
                return super().write(data)
        class Input:
            done = False
            def read(self, count=-1):
                if self.done: return b""
                if not ready.wait(3): raise AssertionError("stdout was buffered until exit")
                self.done = True
                return b"answer"
        sink = Sink()
        sprite = Sprite("local", SimpleNamespace(_runtime=SimpleNamespace(sandboxes=SimpleNamespace(get=lambda _: LocalSandbox()))), "local-test")
        code = "import sys; sys.stdout.buffer.write(b'\\xffprompt'); sys.stdout.flush(); assert sys.stdin.buffer.read()==b'answer'"
        sprite.command(sys.executable, "-c", code, stdin=Input(), stdout=sink).run()
        self.assertEqual(sink.getvalue(), b"\xffprompt")

    def test_sprites_pty_is_real_terminal(self):
        sprite = Sprite("local", SimpleNamespace(_runtime=SimpleNamespace(sandboxes=SimpleNamespace(get=lambda _: LocalSandbox()))), "local-test")
        result = sprite.run(sys.executable, "-c", "import os; print(os.isatty(1))", tty=True, capture_output=True)
        self.assertEqual(result.stdout.strip(), b"True")

    def test_prime_interactive_process_streams_and_writes(self):
        async def run():
            sb = AsyncSandbox()
            async def get(_): return sb
            client = AsyncSandboxClient(runtime=SimpleNamespace(sandboxes=SimpleNamespace(get=get)))
            async def env(_sb, extra=None): return extra
            client._environment = env
            code = "import sys; sys.stdout.buffer.write(b'\\x80ready'); sys.stdout.flush(); assert sys.stdin.buffer.read(3)==b'ack'; sys.stderr.buffer.write(b'\\xff')"
            import shlex
            process = await client.open_process(sb.id, shlex.join([sys.executable, "-c", code]))
            self.assertGreater(process.pid, 0)
            self.assertEqual(await process.stdout.__anext__(), b"\x80ready")
            await process.write_stdin(b"ack")
            self.assertEqual(b"".join([part async for part in process.stderr]), b"\xff")
            self.assertEqual(await process.wait(), 0)
            with self.assertRaises(BrokenPipeError): await process.write_stdin(b"late")
            await process.aclose()
        asyncio.run(run())

    def test_prime_background_job_persists_handle_and_outputs(self):
        import shlex
        import time
        from withruntime import NotFoundError
        class Files(LocalFiles):
            def read(self, path):
                try: return super().read(path)
                except FileNotFoundError as error:
                    raise NotFoundError(str(error), code="file_not_found", status=404) from error
        class JobSandbox(LocalSandbox):
            files = Files()
            def spawn(self, *args, **kwargs):
                process = super().spawn(*args, **kwargs)
                thread = threading.Thread(target=lambda: list(process.output_bytes()))
                thread.start()
                threads.append(thread)
                return process
        threads = []
        sb = JobSandbox()
        native = SimpleNamespace(sandboxes=SimpleNamespace(get=lambda _: sb))
        first = SandboxClient(native)
        first._environment = lambda box, extra=None: {**os.environ, **(extra or {})}
        code = "import os,sys; print(os.environ['JOB']); sys.stderr.write('err'); sys.exit(7)"
        job = first.start_background_job(sb.id, shlex.join([sys.executable, "-c", code]), env={"JOB": "hello world"})
        try:
            second = SandboxClient(native)
            deadline = time.monotonic() + 3
            while not second.get_background_job_status(sb.id, job).completed:
                if time.monotonic() > deadline: self.fail("background job did not finish")
                time.sleep(.01)
            value = second.get_background_job(sb.id, job)
            self.assertEqual((value.exit_code, value.stdout, value.stderr), (7, "hello world\n", "err"))
            self.assertFalse(value.stdout_truncated)
            self.assertEqual(second.get_background_jobs([job])[0], value)
            with self.assertRaises(ValueError): second.get_background_jobs([job, job])
        finally:
            for thread in threads: thread.join(3)
            for path in (job.stdout_log_file, job.stderr_log_file, job.exit_file):
                Path(path).unlink(missing_ok=True)

    def test_modal_filesystem_real_paths_and_atomic_download(self):
        from withruntime.modal.exception import InvalidError
        box = Sandbox(SimpleNamespace(), LocalSandbox())
        with tempfile.TemporaryDirectory() as folder:
            target = str(Path(folder, "dir", "binary"))
            data = bytes(range(256)) * 4097
            box.filesystem.write_bytes(data, target)
            self.assertEqual(box.filesystem.read_bytes(target), data)
            info = box.filesystem.stat(target)
            self.assertTrue(info.is_file())
            self.assertEqual(info.size, len(data))
            link = str(Path(folder, "link"))
            os.symlink(target, link)
            self.assertEqual(box.filesystem.stat(link).symlink_target, target)
            self.assertEqual({item.name for item in box.filesystem.list_files(folder)}, {"dir", "link"})
            destination = Path(folder, "local")
            box.filesystem.copy_to_local(target, destination)
            self.assertEqual(destination.read_bytes(), data)
            with self.assertRaises(FileNotFoundError):
                box.filesystem.copy_to_local(str(Path(folder, "missing")), destination)
            self.assertEqual(destination.read_bytes(), data)
            box.filesystem.remove(target)
            with self.assertRaises(InvalidError): box.filesystem.write_text("bad", "relative")
