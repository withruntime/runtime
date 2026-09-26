"""A Deep Agent's whole tool loop on RuntimeSandbox, offline.

`scripts/e2e.py` drives `create_deep_agent` with a scripted model through
`write_file`, `edit_file`, `read_file`, `execute`, `ls`, `glob` and `grep`.
Here the same run goes to the stand-in sandbox, so the script is proven before
it spends a real sandbox.
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

from langchain_withruntime import RuntimeSandbox
from tests.local_sandbox import LocalSandbox, scratch_root

pytestmark = pytest.mark.skipif(
    not sys.platform.startswith("linux") or not shutil.which("bash") or not shutil.which("python3"),
    reason="the stand-in runs BaseSandbox's GNU shell and python3 commands on this machine",
)

_spec = importlib.util.spec_from_file_location("e2e", Path(__file__).parents[2] / "scripts" / "e2e.py")
assert _spec is not None
assert _spec.loader is not None
e2e = importlib.util.module_from_spec(_spec)
sys.modules["e2e"] = e2e  # pydantic resolves the scripted model's annotations through it
_spec.loader.exec_module(e2e)


@pytest.fixture
def local() -> LocalSandbox:
    sandbox = LocalSandbox()
    yield sandbox
    sandbox.close()


def test_a_deep_agent_uses_every_sandbox_tool(local: LocalSandbox) -> None:
    root = scratch_root().rstrip("/")
    try:
        assert e2e.drive(RuntimeSandbox(local), root) == []
    finally:
        shutil.rmtree(root, ignore_errors=True)
    # Outside /workspace, each write went through a staged copy that was removed.
    staging = local.files.root / ".deepagents-staging"
    assert not staging.exists() or not any(staging.iterdir())


def test_write_overwrites_and_glob_returns_absolute_paths(local: LocalSandbox) -> None:
    """The Deep Agents 0.7 behaviour that langchain-tests 1.1.9 still expects otherwise."""
    root = scratch_root().rstrip("/")
    backend = RuntimeSandbox(local)
    try:
        assert backend.write(f"{root}/a.txt", "one").error is None
        assert backend.write(f"{root}/a.txt", "two").error is None
        assert backend.download_files([f"{root}/a.txt"])[0].content == b"two"
        found = backend.glob("*.txt", path=root)
        assert found.error is None
        assert [m["path"] for m in found.matches or []] == [f"{root}/a.txt"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_long_output_is_returned_whole(local: LocalSandbox) -> None:
    """Deep Agents' read_file parses one JSON line; a cut output broke files past about 75 KB."""
    root = scratch_root().rstrip("/")
    backend = RuntimeSandbox(local)
    try:
        text = "".join(f"line {i:06d} " + "x" * 90 + "\n" for i in range(1500))  # about 150 KB
        assert backend.write(f"{root}/big.txt", text).error is None
        read = backend.read(f"{root}/big.txt", limit=2000)
        assert read.error is None
        assert read.file_data is not None
        assert "line 001499" in read.file_data["content"]
        response = backend.execute(f"cat {root}/big.txt")
        assert response.truncated is False
        assert len(response.output) == len(text)
    finally:
        shutil.rmtree(root, ignore_errors=True)
