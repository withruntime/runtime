"""RuntimeProvider against a stand-in client: what it asks the API for."""

from __future__ import annotations

import importlib.util
from typing import Any

import pytest
from withruntime import NotFoundError

from langchain_withruntime import RuntimeProvider, RuntimeSandbox


class Sandbox:
    def __init__(self, sandbox_id: str) -> None:
        self.id, self.stopped = sandbox_id, False

    def stop(self) -> None:
        self.stopped = True


class Sandboxes:
    def __init__(self) -> None:
        self.known: dict[str, Sandbox] = {"sbx-old": Sandbox("sbx-old")}
        self.created: list[dict[str, Any]] = []

    def create(self, **fields: Any) -> Sandbox:
        self.created.append(fields)
        sandbox = Sandbox(f"sbx-{len(self.created)}")
        self.known[sandbox.id] = sandbox
        return sandbox

    def get(self, sandbox_id: str) -> Sandbox:
        if sandbox_id not in self.known:
            raise NotFoundError("no such sandbox", code="sandbox_not_found", status=404)
        return self.known[sandbox_id]


class Client:
    def __init__(self) -> None:
        self.sandboxes = Sandboxes()


HAVE_DCODE = importlib.util.find_spec("deepagents_code") is not None


def test_creates_with_the_lease_and_fields_and_stops() -> None:
    client = Client()
    provider = RuntimeProvider(client=client)  # type: ignore[arg-type]
    backend = provider.get_or_create(timeout=900, command_timeout=60, image="python:3.12", labels={"a": "b"})
    assert isinstance(backend, RuntimeSandbox)
    assert backend.id == "sbx-1"
    assert backend.timeout_seconds == 60
    assert client.sandboxes.created == [{"image": "python:3.12", "labels": {"a": "b"}, "timeout_seconds": 900}]
    provider.delete(sandbox_id="sbx-1")
    assert client.sandboxes.known["sbx-1"].stopped


def test_creates_with_no_fields() -> None:
    client = Client()
    RuntimeProvider(client=client).get_or_create()  # type: ignore[arg-type]
    assert client.sandboxes.created == [{}]


def test_attaches_without_creating() -> None:
    client = Client()
    backend = RuntimeProvider(client=client).get_or_create(sandbox_id="sbx-old")  # type: ignore[arg-type]
    assert backend.id == "sbx-old"
    assert client.sandboxes.created == []
    with pytest.raises(TypeError):
        RuntimeProvider(client=client).get_or_create(sandbox_id="sbx-old", image="x")  # type: ignore[arg-type]


def test_missing_sandbox() -> None:
    provider = RuntimeProvider(client=Client())  # type: ignore[arg-type]
    expected: type[Exception] = KeyError
    if HAVE_DCODE:
        from deepagents_code.integrations.sandbox_provider import SandboxNotFoundError

        expected = SandboxNotFoundError
    with pytest.raises(expected):
        provider.get_or_create(sandbox_id="sbx-none")
    with pytest.raises(expected):
        provider.delete(sandbox_id="sbx-none")
    with pytest.raises(TypeError):
        provider.delete(sandbox_id="sbx-old", force=True)


def test_constructing_needs_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RUNTIME_API_KEY", raising=False)
    RuntimeProvider()


def test_key_from_the_prefixed_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUNTIME_API_KEY", "rt_plain")
    monkeypatch.setenv("DEEPAGENTS_CODE_RUNTIME_API_KEY", "rt_prefixed")
    assert RuntimeProvider().client._t._key == "rt_prefixed"  # noqa: SLF001


async def test_async_wrappers() -> None:
    client = Client()
    provider = RuntimeProvider(client=client)  # type: ignore[arg-type]
    backend = await provider.aget_or_create(timeout=60)
    await provider.adelete(sandbox_id=backend.id)
    assert client.sandboxes.known[backend.id].stopped


@pytest.mark.skipif(not HAVE_DCODE, reason="Deep Agents Code is not installed")
def test_deep_agents_code_finds_the_provider() -> None:
    from deepagents_code.integrations.sandbox_config import SandboxConfig
    from deepagents_code.integrations.sandbox_registry import SandboxRegistry

    registry = SandboxRegistry(config=SandboxConfig(), include_entry_points=True)
    assert "runtime" in registry.available_providers()
    metadata = registry.get_metadata("runtime")
    assert metadata is not None
    assert metadata.working_dir == "/workspace"
    assert metadata.install is not None
    assert metadata.install.command(in_app=False) == "dcode install langchain-withruntime --package"
    assert isinstance(registry.create_provider("runtime"), RuntimeProvider)
