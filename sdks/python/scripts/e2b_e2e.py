"""End to end, against the real API: e2b_example.py, copied, with its one
import changed from e2b to withruntime.e2b.

    RUNTIME_API_KEY=... python3 sdks/python/scripts/e2b_e2e.py        # run it
    python3 sdks/python/scripts/e2b_e2e.py --dry                       # show the change only

Six sandboxes (four at a time, 2 vCPU / 512 MiB, five minutes at most, each
deleted when its case ends) on the account's default funding: the free trial
while it lasts. RUNTIME_API_URL points it elsewhere. Not part of the tests."""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
SDK = HERE.parent
FIXTURE_CASES = REPO / "packages" / "judge-panel" / "fixtures" / "e2b" / "evals" / "cases.json"
dry = "--dry" in sys.argv
if not dry and not os.environ.get("RUNTIME_API_KEY"):
    sys.exit("Set RUNTIME_API_KEY to a Runtime key (a test key), or pass --dry.")

work = Path(tempfile.mkdtemp(prefix="runtime-e2b-py-e2e-"))
shutil.copy(FIXTURE_CASES, work / "cases.json")
before = (HERE / "e2b_example.py").read_text()
after = before.replace("from e2b import ", "from withruntime.e2b import ", 1)
changed = [(a, b) for a, b in zip(before.splitlines(), after.splitlines()) if a != b]
assert len(changed) == 1, changed
(work / "example.py").write_text(after)
print(f"Copied the example to {work}; the only change:")
for a, b in changed:
    print(f"- {a}\n+ {b}")
if dry:
    print("Dry run: not creating sandboxes.")
    sys.exit(0)
print(f"Running against {os.environ.get('RUNTIME_API_URL', 'https://api.withruntime.com')}...")
env = {**os.environ, "E2B_API_KEY": "",
       "PYTHONPATH": str(SDK)}
sys.exit(subprocess.run([sys.executable, str(work / "example.py")], env=env).returncode)
