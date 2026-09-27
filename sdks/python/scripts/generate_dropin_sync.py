"""Writes the sync modules of withruntime.daytona, withruntime.vercel and
withruntime.blaxel from their async sources, as generate_e2b_sync.py does for
withruntime.e2b: each sync adapter is its async one with the awaits taken out,
so the two cannot drift. tests/test_daytona.py fails when a committed file
differs from what this produces. Run: python3 scripts/generate_dropin_sync.py"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "withruntime"
PAIRS = {
    ROOT / "daytona" / "_async_daytona.py": ROOT / "daytona" / "_sync_daytona.py",
    ROOT / "vercel" / "_async_sandbox.py": ROOT / "vercel" / "_sync_sandbox.py",
    ROOT / "blaxel" / "_async_sandbox.py": ROOT / "blaxel" / "_sync_sandbox.py",
}
REPLACEMENTS = [
    ("from ._async_io import", "from ._sync_io import"),
    ("from .._async_client import", "from .._sync_client import"),
    ("async def __aenter__", "def __enter__"),
    ("async def __aexit__", "def __exit__"),
    ("async def __anext__", "def __next__"),
    ("async def ", "def "),
    ("__anext__", "__next__"),
    ("__aiter__", "__iter__"),
    ("StopAsyncIteration", "StopIteration"),
    ("async for ", "for "),
    ("async with ", "with "),
    ("await ", ""),
    ("AsyncIterator", "Iterator"),
]


def transform(source: str, origin: str) -> str:
    body = source.split('"""', 2)[2].lstrip("\n")
    for old, new in REPLACEMENTS:
        body = body.replace(old, new)
    body = re.sub(r"\bAsync([A-Z]\w*)", r"\1", body)
    return f'"""GENERATED from {origin} by scripts/generate_dropin_sync.py. Do not edit."""\n' + body


def outputs() -> dict:
    return {target: transform(source.read_text(), source.relative_to(ROOT).as_posix())
            for source, target in PAIRS.items()}


if __name__ == "__main__":
    files = outputs()
    if "--check" in sys.argv:
        stale = [str(path) for path, text in files.items() if not path.exists() or path.read_text() != text]
        if stale:
            sys.exit("Stale generated files (run python3 scripts/generate_dropin_sync.py): " + ", ".join(stale))
    else:
        for path, text in files.items():
            if path.parent.exists():
                path.write_text(text)
