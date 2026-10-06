"""The E2B tests' fake of the withruntime SDK (e2b_fake.py), with what the
Daytona and Vercel adapters also call: network rules, retention, previews that
can be removed, forks by name, image builds, snapshots and volumes by name,
and sandboxes by name. It adds to that fake; nothing the E2B tests rely on
changes."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2b_fake  # noqa: E402
from e2b_fake import FakeClient, FakeSandbox, FakeSandboxes, Page, World, not_found  # noqa: E402

Page.to_list = lambda self, limit=10_000: self._items[self._start:][:limit]  # type: ignore[attr-defined]


class FakeNetwork:
    def __init__(self, world: World, sandbox_id: str) -> None:
        self._w, self._id = world, sandbox_id

    def set(self, **rules: Any) -> Dict[str, Any]:
        self._w.record("network.set", self._id, rules)
        return rules


def _previews_delete(self: Any, port: int) -> Dict[str, Any]:
    self._w.record("previews.delete", port)
    return {"deleted": True}


e2b_fake.FakePreviews.delete = _previews_delete  # type: ignore[attr-defined]


class DropInSandbox(FakeSandbox):
    def __init__(self, world: World, sandbox_id: str, fields: Dict[str, Any]) -> None:
        super().__init__(world, sandbox_id, fields)
        self.info.update(name=fields.get("name"), diskMiB=fields.get("disk_mib", 4096))
        self.network = FakeNetwork(world, sandbox_id)

    def set_retention(self, days: int) -> "DropInSandbox":
        self._w.record("sandbox.retention", self.id, days)
        return self

    def wait_for(self, state: str, timeout_seconds: int = 60) -> "DropInSandbox":
        self._w.record("sandbox.wait_for", self.id, state)
        return self

    def fork(self, count: Optional[int] = None, *, name: Optional[str] = None, **_: Any) -> Any:
        self._w.record("sandbox.fork", self.id, {"count": count, "name": name})
        copies = []
        for _index in range(count or 1):
            copy = DropInSandbox(self._w, self._w.new_id(), {"name": name})
            self._w.sandboxes[copy.id] = copy
            copies.append(copy)
        return copies if count is not None else copies[0]

    def snapshot(self, name: Optional[str] = None, **options: Any) -> Dict[str, Any]:
        self._w.record("sandbox.snapshot", self.id, {"name": name, **options})
        snapshot_id = self._w.new_id()
        self._w.snapshots.add(snapshot_id)
        return {"id": snapshot_id, "name": name, "state": "ready", "sourceSandboxId": self.id}


class DropInSandboxes(FakeSandboxes):
    def create(self, **fields: Any) -> DropInSandbox:
        self._w.record("sandboxes.create", fields)
        sandbox = DropInSandbox(self._w, self._w.new_id(), fields)
        self._w.sandboxes[sandbox.id] = sandbox
        return sandbox

    def list(self, state: Optional[List[str]] = None, labels: Optional[Dict[str, str]] = None,
             limit: Optional[int] = None, name: Optional[str] = None, include_stopped: bool = False) -> Page:
        self._w.record("sandboxes.list", {"state": state, "labels": labels, "limit": limit, "name": name})
        items = [one for one in self._w.sandboxes.values()
                 if (not state or one.state in state) and (name is None or one.info.get("name") == name)
                 and all(one.info["labels"].get(k) == v for k, v in (labels or {}).items())]
        return Page(items, limit or 50)


class DropInImages:
    def __init__(self, world: "DropInWorld") -> None:
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

    def build(self, on_log: Any = None, **fields: Any) -> Dict[str, Any]:
        self._w.record("images.build", fields)
        image = {"id": self._w.new_id(), "name": fields.get("name"), "state": "ready"}
        self._w.images.append(image)
        return image

    def delete(self, image_id: str) -> Dict[str, Any]:
        self._w.record("images.delete", image_id)
        return {}


class DropInSnapshots(e2b_fake.FakeSnapshots):
    def get(self, snapshot_id: str) -> Dict[str, Any]:
        self._w.record("snapshots.get", snapshot_id)
        if snapshot_id not in self._w.snapshots:
            raise not_found("not_found", "No such snapshot.")
        return {"id": snapshot_id, "state": "ready", "sourceSandboxId": "source", "storedBytes": 1024,
                "createdAt": "2026-09-23T00:00:00.000Z", "expiresAt": "2026-09-30T00:00:00.000Z"}

    def list(self, **query: Any) -> Page:
        self._w.record("snapshots.list", query)
        if query.get("name") is not None:
            return Page([one for one in self._w.named_snapshots if one["name"] == query["name"]], 50)
        return Page([self.get(one) for one in sorted(self._w.snapshots)], 50)


class DropInVolumes:
    def __init__(self, world: "DropInWorld") -> None:
        self._w = world

    def list(self, name: Optional[str] = None, **_: Any) -> Page:
        self._w.record("volumes.list", {"name": name})
        return Page([one for one in self._w.volumes if name is None or one["name"] == name], 50)

    def delete(self, volume_id: str) -> Dict[str, Any]:
        self._w.record("volumes.delete", volume_id)
        return {}


class DropInClient(FakeClient):
    def __init__(self, world: "DropInWorld") -> None:
        super().__init__(world)
        self.sandboxes = DropInSandboxes(world)
        self.images = DropInImages(world)
        self.snapshots = DropInSnapshots(world)
        self.volumes = DropInVolumes(world)


class DropInWorld(World):
    def __init__(self) -> None:
        super().__init__()
        self.named_snapshots: List[Dict[str, Any]] = []
        self.volumes: List[Dict[str, Any]] = []

    def client(self) -> DropInClient:  # type: ignore[override]
        return DropInClient(self)

    def async_client(self) -> Any:
        return e2b_fake.Asyncified(DropInClient(self))


e2b_fake._WRAPPED = e2b_fake._WRAPPED + (DropInClient, DropInSandboxes, DropInSandbox, DropInImages,  # type: ignore
                                         DropInSnapshots, DropInVolumes, FakeNetwork)


# ---- Blaxel: processes by record, raw output reads, labels, previews by port ----------

import withruntime  # noqa: E402
from e2b_fake import Result  # noqa: E402


class BlaxelProcess:
    """A process as Runtime records it: its command cut at 256 characters,
    output kept in chunks with byte offsets, a state and an exit code."""

    def __init__(self, world: "BlaxelWorld", sandbox: "BlaxelSandbox", argv: Any, options: Dict[str, Any]) -> None:
        self._w, self._s = world, sandbox
        self.id = f"proc{len(sandbox.process_list) + 1:04d}"
        command = " ".join(argv) if isinstance(argv, list) else f"bash -c {argv}"
        self.argv, self.options = argv, options
        self.chunks: List[Dict[str, Any]] = []
        self.written: List[Any] = []
        self.info: Dict[str, Any] = {
            "id": self.id, "state": "running", "exitCode": None, "command": command[:256],
            "cwd": options.get("cwd") or "/workspace", "startedAt": f"2026-09-27T00:00:{len(sandbox.process_list):02d}.000Z",
            "endedAt": None, "outputBytes": 0, "stdinOpen": options.get("stdin") == "pipe",
            "timeoutMs": options.get("timeout_ms")}

    def emit(self, stream: str, text: str) -> None:
        self.chunks.append({"stream": stream, "text": text, "offset": self.info["outputBytes"]})
        self.info["outputBytes"] += len(text.encode())

    def end(self, code: int) -> None:
        self.info.update(state="exited" if code >= 0 else "killed", exitCode=code, endedAt="2026-09-27T00:01:00.000Z")

    def refresh(self) -> Dict[str, Any]:
        return self.info

    def write(self, data: Any, eof: bool = False) -> None:
        self._w.record("process.write", self.id, data, eof)
        self.written.append((data, eof))


class BlaxelFiles(e2b_fake.FakeFiles):
    def download(self, remote: str, local: str) -> None:
        self._w.record("files.download", remote, local)
        if remote not in self._s.file_map:
            raise not_found("file_not_found", f"{remote} does not exist.")
        Path(local).write_bytes(self._s.file_map[remote])

    def list(self, path: str, **options: Any) -> List[Dict[str, Any]]:
        self._w.record("files.list", path, options)
        seen: Dict[str, Dict[str, Any]] = {}
        for file, content in self._s.file_map.items():
            if not file.startswith(path.rstrip("/") + "/"):
                continue
            head, _, rest = file[len(path.rstrip("/")) + 1:].partition("/")
            if head == ".keep":
                continue
            full = f"{path.rstrip('/')}/{head}"
            seen[head] = {"name": head, "path": full, "type": "directory" if rest else "file",
                          "size": 0 if rest else len(content), "mode": "0755" if rest else "0644",
                          "modifiedAt": "2026-09-27T00:00:00.000Z"}
        return list(seen.values())

    def stat(self, path: str) -> Dict[str, Any]:
        found = super().stat(path)
        if path == "/":
            return {"exists": True, "path": "/", "type": "directory"}
        return found

    def watch(self, path: str, **options: Any) -> "BlaxelWatch":
        self._w.record("files.watch", path, options)
        return BlaxelWatch(self._w)


class BlaxelWatch:
    def __init__(self, world: "BlaxelWorld") -> None:
        self._w = world
        self.exit_reason: Optional[str] = None
        self.reads = 0

    def get_new_events(self, wait_ms: int = 0) -> List[Dict[str, Any]]:
        self.reads += 1
        if self._w.watch_events:
            return [self._w.watch_events.pop(0)]
        if self.reads > 3:
            self.exit_reason = "stopped"
        return []


class BlaxelPreviews:
    def __init__(self, world: "BlaxelWorld", sandbox: "BlaxelSandbox") -> None:
        self._w, self._s = world, sandbox

    def _view(self, port: int) -> Dict[str, Any]:
        visibility = self._s.previews_by_port[port]
        return {"port": port, "visibility": visibility, "url": f"https://{port}-{self._s.id[-6:]}.runtimehost.com/",
                "token": "tok-1" if visibility == "private" else None,
                "tokenExpiresAt": "2026-09-28T00:00:00.000Z" if visibility == "private" else None}

    def create(self, port: int, visibility: Optional[str] = None, **_: Any) -> Dict[str, Any]:
        self._w.record("previews.create", port, visibility)
        self._s.previews_by_port[port] = visibility or "private"
        return self._view(port)

    def get(self, port: int, ttl_seconds: Optional[int] = None,
            expires_at: Optional[str] = None) -> Dict[str, Any]:
        if expires_at is not None:
            self._w.record("previews.get", port, ttl_seconds, expires_at)
        else:
            self._w.record("previews.get", port, ttl_seconds)
        if port not in self._s.previews_by_port:
            raise not_found("not_found", f"Port {port} is not shared.")
        result = self._view(port)
        if expires_at is not None and result["token"]:
            result["tokenExpiresAt"] = expires_at
        return result

    def list(self) -> List[Dict[str, Any]]:
        return [self._view(port) for port in self._s.previews_by_port]

    def delete(self, port: int) -> Dict[str, Any]:
        self._w.record("previews.delete", port)
        self._s.previews_by_port.pop(port, None)
        return {"deleted": True}


class BlaxelSandbox(DropInSandbox):
    def __init__(self, world: "BlaxelWorld", sandbox_id: str, fields: Dict[str, Any]) -> None:
        super().__init__(world, sandbox_id, fields)
        self.info.update(idlePauseSeconds=fields.get("idle_pause_seconds", 0), autoWake=fields.get("auto_wake", True),
                         lastActiveAt="2026-09-27T00:00:00.000Z")
        self.files = BlaxelFiles(world, self)
        self.previews = BlaxelPreviews(world, self)
        self.previews_by_port: Dict[int, str] = {}
        self.process_list: List[Any] = []

    def exec(self, command: Any, **options: Any) -> Any:
        """The env file's command writes the file (or adds to it) from stdin;
        the adapter's sudo moves and copies move and copy."""
        if isinstance(command, list) and command[:3] == ["sudo", "sh", "-c"]:
            self._w.record("sandbox.sudo", command[3], command[5:])
            if "mv -f" in command[3]:
                self.file_map[command[6]] = self.file_map.pop(command[5])
            elif "install -m 0600" in command[3]:
                self.file_map[command[6]] = self.file_map[command[5]]
            return Result(0)
        result = super().exec(command, **options)
        if isinstance(command, list) and "/etc/runtime-blaxel/env" in command[-1] and result.exit_code == 0:
            before = self.file_map.get("/etc/runtime-blaxel/env", b"") if "cat >>" in command[-1] else b""
            self.file_map["/etc/runtime-blaxel/env"] = before + str(options["stdin"]).encode()
        return result

    def spawn(self, argv: Any, **options: Any) -> BlaxelProcess:
        self._w.record("sandbox.spawn", argv, {k: v for k, v in options.items()})
        if self._w.pause_next_spawn:
            self._w.pause_next_spawn = False
            self.info["state"] = "paused"
            raise withruntime.ConflictError("Sandbox is paused.", code="sandbox_paused", status=409)
        process = BlaxelProcess(self._w, self, argv, options)
        self.process_list.append(process)
        self._w.program(process)
        return process

    def processes(self) -> List[Dict[str, Any]]:
        self._w.record("processes.list")
        return [dict(one.info) for one in self.process_list]

    def process(self, process_id: str) -> Any:
        self._w.record("processes.get", process_id)
        for one in self.process_list:
            if one.id == process_id:
                return one
        raise not_found("not_found", "No such process.")

    def update(self, **settings: Any) -> "BlaxelSandbox":
        self._w.record("sandbox.update", self.id, settings)
        for key, value in settings.items():
            self.info[{"idle_pause_seconds": "idlePauseSeconds", "auto_wake": "autoWake"}.get(key, key)] = value
        return self

    def fork(self, count: Optional[int] = None, *, name: Optional[str] = None, **options: Any) -> Any:
        self._w.record("sandbox.fork", self.id, {"count": count, "name": name, **options})
        copy = BlaxelSandbox(self._w, self._w.new_id(), {"name": name, "labels": options.get("labels")})
        copy.file_map = dict(self.file_map)
        copy.info.update(idlePauseSeconds=self.info["idlePauseSeconds"], autoWake=self.info["autoWake"])
        self._w.sandboxes[copy.id] = copy
        return copy

    def snapshot(self, name: Optional[str] = None, **options: Any) -> Dict[str, Any]:
        self._w.record("sandbox.snapshot", self.id, name)
        snapshot_id = self._w.new_id()
        self._w.snapshots.add(snapshot_id)
        info = {"id": snapshot_id, "name": name, "state": "ready", "sourceSandboxId": self.id,
                "createdAt": "2026-09-27T00:00:00.000Z"}
        self._w.snapshot_infos[snapshot_id] = info
        return info

    def pause(self, wait: bool = True) -> "BlaxelSandbox":
        return super().pause()

    def wake(self, wait: bool = True, timeout_seconds: Optional[int] = None) -> "BlaxelSandbox":
        return super().wake(timeout_seconds)


class BlaxelSandboxes(DropInSandboxes):
    def create(self, **fields: Any) -> BlaxelSandbox:
        self._w.record("sandboxes.create", fields)
        if self._w.trial and fields.get("memory_mib", 0) > 4096:
            raise withruntime.InvalidRequestError(
                "A trial sandbox is at most 2 vCPU and 4 GiB: vcpu must be at most 2; memoryMiB must be at most 4096.",
                code="no_credit_size_limit", status=400, hint="Omit vcpu, memoryMiB, diskMiB and cpu for the default.")
        if fields.get("get_or_create"):
            for one in self._w.sandboxes.values():
                if one.info.get("name") == fields.get("name") and one.state != "stopped":
                    one.info["reused"] = True
                    return one
        sandbox = BlaxelSandbox(self._w, self._w.new_id(), fields)
        if fields.get("snapshot"):
            source = self._w.sandboxes[self._w.snapshot_infos[fields["snapshot"]]["sourceSandboxId"]]
            sandbox.file_map = dict(source.file_map)
        self._w.sandboxes[sandbox.id] = sandbox
        return sandbox

    def list(self, state: Optional[List[str]] = None, labels: Optional[Dict[str, str]] = None,
             limit: Optional[int] = None, name: Optional[str] = None, include_stopped: bool = False) -> Page:
        self._w.record("sandboxes.list", {"labels": labels, "limit": limit, "name": name})
        items = [one for one in self._w.sandboxes.values()
                 if (include_stopped or one.state != "stopped") and (name is None or one.info.get("name") == name)
                 and all(one.info["labels"].get(k) == v for k, v in (labels or {}).items())]
        return Page(items, limit or 50)


class BlaxelSnapshots(DropInSnapshots):
    def get(self, snapshot_id: str) -> Dict[str, Any]:
        self._w.record("snapshots.get", snapshot_id)
        if snapshot_id not in self._w.snapshot_infos:
            raise not_found("not_found", "No such snapshot.")
        return self._w.snapshot_infos[snapshot_id]

    def list(self, sandbox_id: Optional[str] = None, limit: Optional[int] = None, **_: Any) -> Page:
        self._w.record("snapshots.list", sandbox_id)
        return Page([one for one in self._w.snapshot_infos.values()
                     if sandbox_id is None or one["sourceSandboxId"] == sandbox_id], limit or 50)

    def delete(self, snapshot_id: str) -> None:
        super().delete(snapshot_id)
        self._w.snapshot_infos.pop(snapshot_id, None)


class BlaxelImages(DropInImages):
    def resolve(self, ref: str) -> Dict[str, Any]:
        """By name:tag, as Runtime's /v1/images/resolve; a name with a "/" is
        refused, as Runtime's name rule does."""
        self._w.record("images.resolve", ref)
        name, _, tag = ref.partition(":")
        if "/" in name:
            raise withruntime.InvalidRequestError("query.name must match ^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,299}$",
                                                  code="invalid_request", status=400)
        for image in self._w.images:
            if image["name"] == name and image.get("tag", "latest") == tag:
                return image
        raise not_found("not_found", f"No image {ref}.")


class BlaxelClient(DropInClient):
    def __init__(self, world: "BlaxelWorld") -> None:
        super().__init__(world)
        self._w = world
        self.sandboxes = BlaxelSandboxes(world)
        self.snapshots = BlaxelSnapshots(world)
        self.images = BlaxelImages(world)

    def request(self, method: str, path: str, query: Optional[Dict[str, Any]] = None,
                body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._w.record("request", method, path, query or body)
        parts = path.split("/")
        sandbox = self._w.sandboxes[parts[3]]
        process_id, _, action = parts[5].partition(":")
        process = sandbox.process(process_id)
        if action == "signal":
            process.end(-{"SIGTERM": 15, "SIGKILL": 9}[body["signal"]])
            return {}
        cursor = int((query or {}).get("cursor") or 0)
        chunks = [one for one in process.chunks if one["offset"] >= cursor][:2]
        next_cursor = (chunks[-1]["offset"] + len(chunks[-1]["text"].encode())) if chunks else cursor
        if not chunks and process.info["state"] == "running" and self._w.finish_on_wait:
            self._w.finish_on_wait(process)
        return {"chunks": chunks, "nextCursor": next_cursor, "truncated": False, "process": dict(process.info)}


class BlaxelWorld(DropInWorld):
    """``program(process)`` decides what a started process prints and whether
    it ends; by default it prints "ran <command>" and exits 0."""

    def __init__(self) -> None:
        super().__init__()
        self.snapshot_infos: Dict[str, Dict[str, Any]] = {}
        self.trial = False
        self.watch_events: List[Dict[str, Any]] = []
        self.pause_next_spawn = False
        self.finish_on_wait: Any = None

        def program(process: BlaxelProcess) -> None:
            process.emit("stdout", f"ran {process.argv if isinstance(process.argv, str) else process.argv[-1]}\n")
            process.end(0)
        self.program = program

    def client(self) -> BlaxelClient:  # type: ignore[override]
        return BlaxelClient(self)

    def async_client(self) -> Any:
        return e2b_fake.Asyncified(BlaxelClient(self))


e2b_fake._WRAPPED = e2b_fake._WRAPPED + (BlaxelClient, BlaxelImages, BlaxelSandboxes, BlaxelSandbox, BlaxelSnapshots,  # type: ignore
                                         BlaxelPreviews, BlaxelFiles, BlaxelProcess, BlaxelWatch)
