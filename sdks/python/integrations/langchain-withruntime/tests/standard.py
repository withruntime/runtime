"""LangChain's standard sandbox suite, with the cases it has not caught up on.

langchain-tests 1.1.9, the newest on PyPI on 25 September 2026, predates two
Deep Agents 0.7 behaviours: `BaseSandbox.write` overwrites an existing file,
and `glob` returns absolute paths. Seven of its cases fail for any
`BaseSandbox` on Deep Agents 0.7.19, including one that runs straight on the
local machine with no Runtime code. They are expected failures here, strict,
so a suite that catches up shows at once; `test_sandbox.py` checks the Deep
Agents 0.7 behaviour in their place.
"""

from __future__ import annotations

import pytest
from langchain_tests.integration_tests import SandboxIntegrationTests

_SKEW = "langchain-tests 1.1.9 expects {}; Deep Agents 0.7 {}"
_GLOB = pytest.mark.xfail(strict=True, reason=_SKEW.format("relative glob paths", "returns absolute ones"))
_WRITE = pytest.mark.xfail(strict=True, reason=_SKEW.format("write to refuse an existing file", "overwrites it"))


class RuntimeSandboxSuite(SandboxIntegrationTests):
    @_WRITE
    def test_write_existing_file_fails(self, sandbox_backend, sandbox_test_root) -> None:  # noqa: ANN001
        super().test_write_existing_file_fails(sandbox_backend, sandbox_test_root)

    @_GLOB
    def test_glob(self, sandbox_backend, sandbox_test_root) -> None:  # noqa: ANN001
        super().test_glob(sandbox_backend, sandbox_test_root)

    @_GLOB
    def test_glob_basic_pattern(self, sandbox_backend, sandbox_test_root) -> None:  # noqa: ANN001
        super().test_glob_basic_pattern(sandbox_backend, sandbox_test_root)

    @_GLOB
    def test_glob_with_directories(self, sandbox_backend, sandbox_test_root) -> None:  # noqa: ANN001
        super().test_glob_with_directories(sandbox_backend, sandbox_test_root)

    @_GLOB
    def test_glob_hidden_files_explicitly(self, sandbox_backend, sandbox_test_root) -> None:  # noqa: ANN001
        super().test_glob_hidden_files_explicitly(sandbox_backend, sandbox_test_root)

    @_GLOB
    def test_glob_with_character_class(self, sandbox_backend, sandbox_test_root) -> None:  # noqa: ANN001
        super().test_glob_with_character_class(sandbox_backend, sandbox_test_root)

    @_GLOB
    def test_glob_with_question_mark(self, sandbox_backend, sandbox_test_root) -> None:  # noqa: ANN001
        super().test_glob_with_question_mark(sandbox_backend, sandbox_test_root)
