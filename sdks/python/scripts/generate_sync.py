"""Writes withruntime/_sync_client.py from _async_client.py.

The sync client is the async one with the awaits taken out, so the two can
never drift: tests/test_parity.py fails when the committed file differs from
what this produces. Run: python3 scripts/generate_sync.py
"""
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "withruntime"
HEADER = '"""GENERATED from _async_client.py by scripts/generate_sync.py. Do not edit."""\n'

REPLACEMENTS = [
    ("from ._clock import async_background as background", "from ._clock import sync_background as background"),
    ("from ._clock import async_interrupts as interrupts", "from ._clock import sync_interrupts as interrupts"),
    ("from ._clock import async_open_ws as open_ws", "from ._clock import sync_open_ws as open_ws"),
    ("from ._clock import async_parallel as parallel", "from ._clock import sync_parallel as parallel"),
    ("from ._clock import async_sleep as sleep", "from ._clock import sync_sleep as sleep"),
    ("from ._clock import async_slots as slots", "from ._clock import sync_slots as slots"),
    ("from ._clock import async_timeouts as timeouts", "from ._clock import sync_timeouts as timeouts"),
    ("from ._http import AsyncHTTP as HTTP", "from ._http import SyncHTTP as HTTP"),
    ("from ._ws import AsyncWebSocket as WebSocket", "from ._ws import SyncWebSocket as WebSocket"),
    ("from ._tunnel import async_open_forward as open_forward",
     "from ._tunnel import sync_open_forward as open_forward"),
    ("AsyncIterator", "Iterator"),
    ("async def __aenter__", "def __enter__"),
    ("async def __aexit__", "def __exit__"),
    ("async def __aiter__", "def __iter__"),
    ("async def ", "def "),
    ("async for ", "for "),
    ("async with ", "with "),
    ("await ", ""),
    ("``async with AsyncRuntime() as runtime:``", "``with Runtime() as runtime:``"),
    ("``async for`` walks every page", "``for`` walks every page"),
    ("``async for item in page``", "``for item in page``"),
    ("The Runtime Client client, async.", "The Runtime Cloud client, sync."),
]


def generate() -> str:
    source = (ROOT / "_async_client.py").read_text()
    body = source.split("\n", 2)
    # Drop the async file's own module docstring (its first two lines).
    text = source[source.index('from __future__'):]
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    text = text.replace("from ._async_products", "from ._sync_products")
    text = re.sub(r"\bAsync([A-Z]\w*)", r"\1", text)
    del body
    return HEADER + text


def without_docstring(source: str) -> str:
    """The module minus its own docstring: the GENERATED line replaces it, and
    a second string ahead of ``from __future__`` would be a SyntaxError."""
    body = ast.parse(source).body
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
            and isinstance(body[0].value.value, str):
        return "\n".join(source.split("\n")[body[0].end_lineno:]).lstrip("\n")
    return source


def transform(source: str, origin: str) -> str:
    text = without_docstring(source)
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    text = text.replace("from ._async_products", "from ._sync_products").replace("from .._async", "from .._sync")
    text = re.sub(r"\bAsync([A-Z]\w*)", r"\1", text)
    return f'"""GENERATED from {origin} by scripts/generate_sync.py. Do not edit."""\n' + text


def outputs() -> dict[Path, str]:
    files = {ROOT / "_sync_client.py": generate()}
    products = ROOT / "_async_products"
    for source in sorted(products.glob("*.py")):
        files[ROOT / "_sync_products" / source.name] = transform(source.read_text(), f"_async_products/{source.name}")
    return files


if __name__ == "__main__":
    files = outputs()
    if "--check" in sys.argv:
        stale = [path for path, text in files.items() if not path.exists() or path.read_text() != text]
        sys.exit(1 if stale else 0)
    (ROOT / "_sync_products").mkdir(exist_ok=True)
    for path, text in files.items():
        path.write_text(text)
        print(f"wrote {path}")
