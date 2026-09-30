"""Generate the synchronous Runloop adapter from its async counterpart."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1] / 'withruntime' / 'runloop'


def generate():
    source = (ROOT / '_async.py').read_text()
    for before, after in [('async def __aenter__', 'def __enter__'), ('async def __aexit__', 'def __exit__'),
                          ('__aiter__', '__iter__'), ('async def ', 'def '), ('async for ', 'for '),
                          ('async with ', 'with '), ('await ', ''), ('asyncio.sleep', 'time.sleep')]:
        source = source.replace(before, after)
    return re.sub(r'\bAsync([A-Z]\w*)', r'\1', source)


if __name__ == '__main__':
    target = ROOT / '_sync.py'
    if '--check' in sys.argv:
        if target.read_text() != generate(): sys.exit('Run generate_runloop_sync.py')
    else: target.write_text(generate())
