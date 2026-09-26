"""A fake of the withruntime SDK: the calls the adapter makes, recorded, with
answers the tests choose. ``world.client()`` stands in for Runtime and
``world.async_client()`` for AsyncRuntime. It fakes the SDK, not the API."""
from __future__ import annotations

import inspect
from typing import Any, Callable, Dict, List, Optional

import withruntime


def not_found(code: str, message: str) -> withruntime.NotFoundError:
    return withruntime.NotFoundError(message, code=code, status=404, request_id="req_1", hint="Check the id.")


def unavailable() -> withruntime.ServiceUnavailableError:
    return withruntime.ServiceUnavailableError(
        "Forks are paused while we fix an issue; your sandbox is unaffected.", code="fork_unavailable",
        status=503, hint="Build a custom image (runtime image build) and create each sandbox from it.")


EXEC_RESULT_BYTES = 65_536
"""The most of each stream an exec result holds when it is not streamed."""


class Result:
    def __init__(self, exit_code: Optional[int], stdout: str = "", stderr: str = "", timed_out: bool = False,
                 lost: bool = False):
        self.exit_code, self.stdout, self.stderr, self.timed_out = exit_code, stdout, stderr, timed_out
        # Output the stream dropped before it was read, which the SDK marks on both streams.
        self.stdout_truncated = self.stderr_truncated = lost


class Page:
    def __init__(self, items: List[Any], size: int, start: int = 0) -> None:
        self._items, self._size, self._start = items, size, start
        self.data = items[start:start + size]
        self.has_more = start + size < len(items)
        self.next_cursor = str(start + size) if self.has_more else None

    def next_page(self) -> Optional["Page"]:
        return Page(self._items, self._size, self._start + self._size) if self.has_more else None


class World:
    def __init__(self) -> None:
        self.calls: List[tuple] = []
        self.sandboxes: Dict[str, FakeSandbox] = {}
        self.images: List[Dict[str, Any]] = []
        self.snapshots: set = set()
        self.forks_enabled = True
        self.exec: Callable[[str, Dict[str, Any]], Result] = lambda command, _: Result(0, f"ran {command}\n")
        self.output: Callable[[str], List[Dict[str, Any]]] = lambda command: [
            {"type": "stdout", "data": f"ran {command}\n", "offset": 0},
            {"type": "exit", "exitCode": 0, "state": "exited", "timedOut": False}]
        self.interpreter: Callable[[str, Dict[str, Any]], Dict[str, Any]] = lambda code, _: {
            "status": "ok", "stdout": f"out {code}\n", "stderr": "", "executionCount": 1, "error": None,
            "results": [{"main": True, "data": {"text/plain": "2"}, "refs": {}}]}
        self._next = 1

    def record(self, *call: Any) -> None:
        self.calls.append(call)

    def called(self, method: str) -> List[tuple]:
        return [call[1:] for call in self.calls if call[0] == method]

    def new_id(self) -> str:
        n, self._next = self._next, self._next + 1
        return f"00000000-0000-4000-8000-{n:012d}"

    def client(self) -> "FakeClient":
        return FakeClient(self)

    def async_client(self) -> Any:
        return Asyncified(FakeClient(self))


class FakeClient:
    def __init__(self, world: World) -> None:
        self.sandboxes = FakeSandboxes(world)
        self.images = FakeImages(world)
        self.snapshots = FakeSnapshots(world)


class FakeSandboxes:
    def __init__(self, world: World) -> None:
        self._w = world

    def create(self, **fields: Any) -> "FakeSandbox":
        self._w.record("sandboxes.create", fields)
        if fields.get("snapshot") and not self._w.forks_enabled:
            raise unavailable()
        sandbox = FakeSandbox(self._w, self._w.new_id(), fields)
        self._w.sandboxes[sandbox.id] = sandbox
        return sandbox

    def get(self, sandbox_id: str) -> "FakeSandbox":
        self._w.record("sandboxes.get", sandbox_id)
        if sandbox_id not in self._w.sandboxes:
            raise not_found("not_found", f"Sandbox {sandbox_id} was not found.")
        return self._w.sandboxes[sandbox_id]

    def list(self, state: Optional[List[str]] = None, labels: Optional[Dict[str, str]] = None,
             limit: Optional[int] = None) -> Page:
        self._w.record("sandboxes.list", {"state": state, "labels": labels, "limit": limit})
        items = [one for one in self._w.sandboxes.values()
                 if (not state or one.state in state)
                 and all(one.info["labels"].get(k) == v for k, v in (labels or {}).items())]
        return Page(items, limit or 50)


class FakeImages:
    def __init__(self, world: World) -> None:
        self._w = world

    def get(self, image_id: str) -> Dict[str, Any]:
        self._w.record("images.get", image_id)
        for image in self._w.images:
            if image["id"] == image_id:
                return image
        raise not_found("not_found", "No such image.")

    def list(self, state: Optional[str] = None, name: Optional[str] = None, limit: Optional[int] = None) -> Page:
        self._w.record("images.list", {"state": state, "name": name, "limit": limit})
        return Page([one for one in self._w.images if (not name or one["name"] == name)
                     and (not state or one["state"] == state)], 50)


class FakeSnapshots:
    def __init__(self, world: World) -> None:
        self._w = world

    def delete(self, snapshot_id: str) -> None:
        self._w.record("snapshots.delete", snapshot_id)
        if snapshot_id not in self._w.snapshots:
            raise not_found("not_found", "No such snapshot.")
        self._w.snapshots.discard(snapshot_id)


class FakeProcess:
    def __init__(self, world: World, process_id: str, command: str, stdin_open: bool,
                 events: List[Dict[str, Any]]) -> None:
        self._w, self.id, self._events = world, process_id, events
        self.killed: Optional[str] = None
        self.info = {"id": process_id, "state": "running", "command": command, "cwd": "/workspace",
                     "stdinOpen": stdin_open, "outputBytes": 0}

    def output(self, cursor: int = 0) -> Any:
        self._w.record("process.output", self.id, cursor)
        for event in self._events:
            yield event
            if event["type"] == "exit":
                self.info["state"] = "exited"

    def write(self, data: Any, eof: bool = False) -> None:
        self._w.record("process.write", self.id, data, eof)

    def kill(self, signal: str = "SIGTERM") -> None:
        self._w.record("process.kill", self.id, signal)
        self.killed = signal
        self.info["state"] = "killed"


class FakeFiles:
    def __init__(self, world: World, sandbox: "FakeSandbox") -> None:
        self._w, self._s = world, sandbox

    def read(self, path: str) -> bytes:
        self._w.record("files.read", path)
        if path not in self._s.file_map:
            raise not_found("file_not_found", f"{path} does not exist.")
        return self._s.file_map[path]

    def write(self, path: str, data: Any) -> Dict[str, Any]:
        self._w.record("files.write", path)
        self._s.file_map[path] = data.encode() if isinstance(data, str) else bytes(data)
        return {"path": path, "size": len(data)}

    def list(self, path: str, **options: Any) -> List[Dict[str, Any]]:
        self._w.record("files.list", path, options)
        return [{"name": file[len(path) + 1:], "path": file, "type": "file", "size": len(content), "mode": "0644",
                 "modifiedAt": "2026-09-23T00:00:00.000Z"}
                for file, content in self._s.file_map.items() if file.startswith(path + "/")]

    def stat(self, path: str) -> Dict[str, Any]:
        self._w.record("files.stat", path)
        if path in self._s.file_map:
            return {"exists": True, "name": path.rsplit("/", 1)[-1], "path": path, "type": "file",
                    "size": len(self._s.file_map[path]), "mode": "0755", "modifiedAt": "2026-09-23T00:00:00.000Z"}
        if any(file.startswith(path + "/") for file in self._s.file_map):
            return {"exists": True, "name": path.rsplit("/", 1)[-1], "path": path, "type": "directory", "size": 0,
                    "mode": "0755", "modifiedAt": "2026-09-23T00:00:00.000Z"}
        return {"exists": False, "path": path}

    def exists(self, path: str) -> bool:
        self._w.record("files.exists", path)
        return path in self._s.file_map or any(file.startswith(path + "/") for file in self._s.file_map)

    def mkdir(self, path: str, parents: bool = True) -> None:
        self._w.record("files.mkdir", path, parents)
        self._s.file_map[path + "/.keep"] = b""

    def remove(self, path: str, recursive: bool = False) -> bool:
        self._w.record("files.remove", path, recursive)
        gone = [file for file in self._s.file_map if file == path or file.startswith(path + "/")]
        for file in gone:
            del self._s.file_map[file]
        return bool(gone)

    def rename(self, source: str, target: str, overwrite: bool = False) -> None:
        self._w.record("files.rename", source, target, overwrite)
        self._s.file_map[target] = self._s.file_map.pop(source)


class FakeContexts:
    def __init__(self, world: World, sandbox: "FakeSandbox") -> None:
        self._w, self._s = world, sandbox

    def create(self, **fields: Any) -> Dict[str, Any]:
        self._w.record("contexts.create", {k: v for k, v in fields.items() if v is not None})
        context_id = fields.get("id") or f"ctx-{len(self._s.contexts) + 1}"
        if context_id in self._s.contexts:
            raise withruntime.ConflictError("exists", code="conflict", status=409)
        made = {"id": context_id, "language": fields.get("language") or "python", "cwd": fields.get("cwd") or "/workspace"}
        self._s.contexts[context_id] = made
        return made

    def list(self) -> List[Dict[str, Any]]:
        self._w.record("contexts.list")
        return list(self._s.contexts.values())

    def remove(self, context_id: str) -> bool:
        self._w.record("contexts.remove", context_id)
        return self._s.contexts.pop(context_id, None) is not None

    def restart(self, context_id: str) -> Dict[str, Any]:
        self._w.record("contexts.restart", context_id)
        return self._s.contexts[context_id]


class FakeInterpreter:
    def __init__(self, world: World, sandbox: "FakeSandbox") -> None:
        self._w = world
        self.contexts = FakeContexts(world, sandbox)

    def run(self, code: str, **options: Any) -> Dict[str, Any]:
        self._w.record("interpreter.run", code, {k: v for k, v in options.items() if not k.startswith("on_")})
        execution = self._w.interpreter(code, options)
        if options.get("on_stdout"):
            options["on_stdout"](execution["stdout"])
        return execution

    def result(self, ref: Dict[str, Any]) -> bytes:
        self._w.record("interpreter.result", ref["path"])
        return f"bytes of {ref['path']}".encode()


class FakePreviews:
    def __init__(self, world: World, sandbox: "FakeSandbox") -> None:
        self._w, self._s = world, sandbox

    def create(self, port: int, **options: Any) -> Dict[str, Any]:
        self._w.record("previews.create", port, options)
        return {"url": f"https://{port}-{self._s.id.replace('-', '')}.runtimehost.com/"}  # as the API names it


class FakeSandbox:
    def __init__(self, world: World, sandbox_id: str, fields: Dict[str, Any]) -> None:
        import time
        self._w, self.id = world, sandbox_id
        self.file_map: Dict[str, bytes] = {}
        self.process_list: List[FakeProcess] = []
        self.contexts: Dict[str, Dict[str, Any]] = {}
        timeout = fields.get("timeout_seconds", 1800)
        self.info: Dict[str, Any] = {
            "id": sandbox_id, "state": "running", "labels": dict(fields.get("labels") or {}),
            "vcpu": fields.get("vcpu", 2), "memoryMiB": fields.get("memory_mib", 4096),
            "onLeaseEnd": fields.get("on_lease_end", "pause"), "createdAt": "2026-09-23T00:00:00.000Z",
            "expiresAt": _iso(time.time() + timeout)}
        for key in ("image", "snapshot"):
            if key in fields:
                self.info[key] = fields[key]
        self.files = FakeFiles(world, self)
        self.interpreter = FakeInterpreter(world, self)
        self.previews = FakePreviews(world, self)

    @property
    def state(self) -> str:
        return self.info["state"]

    def refresh(self) -> "FakeSandbox":
        self._w.record("sandbox.refresh", self.id)
        return self

    def exec(self, command: str, **options: Any) -> Result:
        self._w.record("sandbox.exec", command, {k: v for k, v in options.items() if not k.startswith("on_")})
        result = self._w.exec(command, options)
        # As the SDK's exec: with no output callback, and at most a minute
        # long, it is one request whose result holds at most 64 KiB of each
        # stream; otherwise it streams and holds all of it.
        streamed = bool(options.get("on_stdout") or options.get("on_stderr")
                        or (options.get("timeout_ms") or 0) > 60_000)
        if not streamed:
            capped = Result(result.exit_code, result.stdout[:EXEC_RESULT_BYTES], result.stderr[:EXEC_RESULT_BYTES],
                            result.timed_out)
            capped.stdout_truncated = len(result.stdout) > EXEC_RESULT_BYTES
            capped.stderr_truncated = len(result.stderr) > EXEC_RESULT_BYTES
            result = capped
        if options.get("on_stdout") and result.stdout:
            options["on_stdout"](result.stdout)
        return result

    def spawn(self, command: str, **options: Any) -> FakeProcess:
        self._w.record("sandbox.spawn", command, options)
        process = FakeProcess(self._w, f"proc-{len(self.process_list) + 1}", command, options.get("stdin") == "pipe",
                              self._w.output(command))
        self.process_list.append(process)
        return process

    def processes(self) -> List[Dict[str, Any]]:
        self._w.record("processes.list")
        return [one.info for one in self.process_list]

    def process(self, process_id: str) -> FakeProcess:
        self._w.record("processes.get", process_id)
        for one in self.process_list:
            if one.id == process_id:
                return one
        raise not_found("not_found", "No such process.")

    def stop(self, wait: bool = True) -> "FakeSandbox":
        self._w.record("sandbox.stop", self.id, wait)
        self.info["state"] = "stopped"
        return self

    def pause(self) -> "FakeSandbox":
        self._w.record("sandbox.pause", self.id)
        self.info["state"] = "paused"
        return self

    def wake(self, timeout_seconds: Optional[int] = None) -> "FakeSandbox":
        self._w.record("sandbox.wake", self.id, timeout_seconds)
        self.info["state"] = "running"
        return self

    def extend(self, seconds: int) -> "FakeSandbox":
        import time
        from datetime import datetime
        self._w.record("sandbox.extend", self.id, seconds)
        end = datetime.fromisoformat(self.info["expiresAt"].replace("Z", "+00:00")).timestamp()
        self.info["expiresAt"] = _iso(end + seconds)
        _ = time
        return self

    def fork(self, count: Optional[int] = None) -> Any:
        self._w.record("sandbox.fork", self.id, count)
        if not self._w.forks_enabled:
            raise unavailable()
        copies = []
        for _ in range(count or 1):
            copy = FakeSandbox(self._w, self._w.new_id(), {})
            self._w.sandboxes[copy.id] = copy
            copies.append(copy)
        return copies

    def snapshot(self, name: Optional[str] = None) -> Dict[str, Any]:
        self._w.record("sandbox.snapshot", self.id, name)
        if not self._w.forks_enabled:
            raise unavailable()
        snapshot_id = self._w.new_id()
        self._w.snapshots.add(snapshot_id)
        return {"id": snapshot_id, "name": name}


def _iso(epoch: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


_WRAPPED = (FakeClient, FakeSandboxes, FakeImages, FakeSnapshots, FakeSandbox, FakeProcess, FakeFiles,
            FakeInterpreter, FakeContexts, FakePreviews, Page)


class Asyncified:
    """The same fake, as AsyncRuntime's shape: methods are coroutines, output
    streams are async iterators, nested fakes are wrapped too."""

    def __init__(self, target: Any) -> None:
        object.__setattr__(self, "_target", target)

    def __getattr__(self, name: str) -> Any:
        value = getattr(self._target, name)
        if isinstance(value, _WRAPPED):
            return Asyncified(value)
        if inspect.isgeneratorfunction(value):
            async def agen(*args: Any, **kwargs: Any) -> Any:
                for item in value(*args, **kwargs):
                    yield item
            return agen
        if callable(value) and not isinstance(value, type):
            async def call(*args: Any, **kwargs: Any) -> Any:
                result = value(*args, **kwargs)
                return Asyncified(result) if isinstance(result, _WRAPPED) else (
                    [Asyncified(one) if isinstance(one, _WRAPPED) else one for one in result]
                    if isinstance(result, list) else result)
            return call
        return value
