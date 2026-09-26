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
        self.info.update(name=fields.get("name"), timeoutSeconds=fields.get("timeout_seconds", 1800),
                         diskMiB=fields.get("disk_mib", 4096))
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
