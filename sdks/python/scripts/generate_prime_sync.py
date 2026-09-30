"""Generate the synchronous Prime adapter from its async counterpart.
Run: python3 scripts/generate_prime_sync.py (--check fails when the file is stale)."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1] / 'withruntime' / 'prime'


def generate():
    source = (ROOT / '_async.py').read_text()
    for before, after in [('Native asynchronous', 'Generated synchronous'), ('Async', ''), ('async def ', 'def '),
                          ('async for ', 'for '), ('await ', ''), ('aclose', 'close'), ('__aenter__', '__enter__'),
                          ('__aexit__', '__exit__'), ('__aiter__', '__iter__'), ('asyncio.sleep(', 'time.sleep(')]:
        source = source.replace(before, after)
    return source


if __name__ == '__main__':
    target = ROOT / '_sync.py'
    if '--check' in sys.argv:
        if target.read_text() != generate(): sys.exit('Run generate_prime_sync.py')
    else: target.write_text(generate())
