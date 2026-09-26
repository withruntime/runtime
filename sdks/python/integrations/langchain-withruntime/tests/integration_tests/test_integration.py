"""LangChain's standard sandbox suite against a real Runtime sandbox.

    RUNTIME_API_KEY=... pytest tests/integration_tests

One sandbox on the account's default funding (the free trial while it lasts),
with a ten minute lease, stopped when the suite ends. Skipped without a key.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

from langchain_withruntime import RuntimeSandbox
from tests.standard import RuntimeSandboxSuite

if TYPE_CHECKING:
    from collections.abc import Iterator

    from deepagents.backends.protocol import SandboxBackendProtocol

pytestmark = pytest.mark.skipif(not os.environ.get("RUNTIME_API_KEY"), reason="RUNTIME_API_KEY is not set")


class TestRuntimeSandboxLive(RuntimeSandboxSuite):
    @pytest.fixture(scope="class")
    def sandbox(self) -> Iterator[SandboxBackendProtocol]:
        from withruntime import Sandbox

        sbx = Sandbox.create(timeout_seconds=600, labels={"purpose": "langchain-withruntime-tests"})
        try:
            yield RuntimeSandbox(sbx)
        finally:
            sbx.stop()
