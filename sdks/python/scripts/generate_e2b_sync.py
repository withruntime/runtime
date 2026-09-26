"""Writes withruntime.e2b's sync modules from their async sources, as
generate_sync.py does for the SDK itself: the sync adapter is the async one with the awaits taken out,
so the two cannot drift. tests/test_e2b_sandbox.py fails when a committed file
differs from what this produces. Run: python3 scripts/generate_e2b_sync.py"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "withruntime" / "e2b"
PAIRS = {
    ROOT / "_async_sandbox.py": ROOT / "_sync_sandbox.py",
    ROOT / "code_interpreter" / "_async_ci.py": ROOT / "code_interpreter" / "_sync_ci.py",
}
REPLACEMENTS = [
    ("from ._async_io import", "from ._sync_io import"),
    ("from .._async_client import", "from .._sync_client import"),
    ("from .._async_io import", "from .._sync_io import"),
    ("from .._async_sandbox import", "from .._sync_sandbox import"),
    ("async def __aenter__", "def __enter__"),
    ("async def __aexit__", "def __exit__"),
    ("async def ", "def "),
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
    return f'"""GENERATED from {origin} by scripts/generate_e2b_sync.py. Do not edit."""\n' + body


def outputs() -> dict:
    return {target: transform(source.read_text(), source.relative_to(ROOT).as_posix())
            for source, target in PAIRS.items()}


if __name__ == "__main__":
    files = outputs()
    if "--check" in sys.argv:
        stale = [str(path) for path, text in files.items() if not path.exists() or path.read_text() != text]
        if stale:
            sys.exit("Stale generated files (run python3 scripts/generate_e2b_sync.py): " + ", ".join(stale))
    else:
        for path, text in files.items():
            path.write_text(text)
