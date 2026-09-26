from __future__ import annotations

import importlib.metadata

import withruntime.deepagents

import langchain_withruntime
from langchain_withruntime import RuntimeProvider, RuntimeSandbox


def test_exports() -> None:
    assert langchain_withruntime.__all__ == ["RuntimeProvider", "RuntimeSandbox", "__version__"]
    assert RuntimeSandbox is withruntime.deepagents.RuntimeSandbox
    assert RuntimeProvider.__module__ == "langchain_withruntime.provider"


def test_version_matches_the_distribution() -> None:
    assert langchain_withruntime.__version__ == importlib.metadata.version("langchain-withruntime")


def test_entry_point_names_the_provider() -> None:
    points = importlib.metadata.entry_points(group="deepagents_code.sandbox_providers")
    runtime = [point for point in points if point.name == "runtime"]
    assert len(runtime) == 1
    assert runtime[0].load() is RuntimeProvider
