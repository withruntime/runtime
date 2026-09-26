"""LangChain's standard sandbox tests, offline, against a stand-in sandbox.

`SandboxIntegrationTests` is the suite a Deep Agents sandbox backend is held
to (see `tests/standard.py` for the seven cases it has not caught up on). Here it drives `RuntimeSandbox` over `LocalSandbox`, which runs commands on
this machine and serves `/workspace` from a temporary directory, so the suite
checks every protocol method and the commands `BaseSandbox` sends, with no
account and no network. `tests/integration_tests` runs the same suite against
the real API.
"""

from __future__ import annotations

import shutil
import sys
from typing import TYPE_CHECKING

import pytest

from langchain_withruntime import RuntimeSandbox
from tests.local_sandbox import LocalSandbox, scratch_root
from tests.standard import RuntimeSandboxSuite

if TYPE_CHECKING:
    from collections.abc import Iterator

    from deepagents.backends.protocol import SandboxBackendProtocol

pytestmark = pytest.mark.skipif(
    not sys.platform.startswith("linux") or not shutil.which("bash") or not shutil.which("python3"),
    reason="the stand-in runs BaseSandbox's GNU shell and python3 commands on this machine",
)


class TestRuntimeSandboxStandard(RuntimeSandboxSuite):
    _root = scratch_root()

    @property
    def sandbox_root_dir(self) -> str:
        return self._root

    @pytest.fixture(scope="class")
    def sandbox(self) -> Iterator[SandboxBackendProtocol]:
        local = LocalSandbox()
        try:
            yield RuntimeSandbox(local)
        finally:
            local.close()
            shutil.rmtree(self._root, ignore_errors=True)
