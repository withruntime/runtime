"""End to end, against the real API: programs written for Daytona's and
Vercel Sandbox's Python SDKs (tests/fixtures), copied unmodified, with their
one import changed to withruntime.daytona or withruntime.vercel.

    python3 scripts/dropin_e2e.py          # run both
    python3 scripts/dropin_e2e.py --dry    # set up and show the changes only

They use RUNTIME_API_KEY or the key `npx withruntime login` saved, on the
account's default funding, so this refuses to start unless the free trial has
an hour left: then every sandbox runs on the trial. Each program makes one
sandbox and ends it; afterwards the script checks that every sandbox made since
it started has ended and ran on the trial (another client of the same account
can make that check fail). Not part of the unit tests."""
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

PROGRAMS = [
    ("daytona_quickstart.py", "from daytona import", "from withruntime.daytona import",
     ["Hello from Python", "0 Hello, World!", "step one\nstep two"]),
    ("vercel_quickstart.py", "from vercel import sandbox", "from withruntime.vercel import sandbox",
     ["Hello from Vercel Sandbox!", "hello", "1\n2\n3\nexit 0"]),
]


def prepare(name: str, before: str, after: str) -> Path:
    source = (ROOT / "tests" / "fixtures" / name).read_text()
    changed = source.replace(before, after, 1)
    lines = [(a, b) for a, b in zip(source.splitlines(), changed.splitlines()) if a != b]
    if len(lines) != 1:
        raise SystemExit(f"Expected one changed line in {name}, found {len(lines)}.")
    target = Path(tempfile.mkdtemp(prefix="runtime-dropin-e2e-")) / name
    target.write_text(changed)
    print(f"{name} in {target.parent}; the only change:\n- {lines[0][0]}\n+ {lines[0][1]}")
    return target


def main() -> int:
    prepared = [(prepare(name, before, after), expected) for name, before, after, expected in PROGRAMS]
    if "--dry" in sys.argv:
        print("Dry run: not creating sandboxes.")
        return 0
    from withruntime import Runtime
    runtime = Runtime()
    trial = runtime.usage().get("trial") or {}
    if (trial.get("availableMs") or 0) < 3_600_000:
        print("The trial has less than an hour left, so sandboxes could fall to paid credit. Not running.")
        return 2
    started = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    failed = False
    env = {**os.environ, "PYTHONPATH": str(ROOT), "DAYTONA_API_KEY": "", "VERCEL_TOKEN": ""}
    for path, expected in prepared:
        print(f"\n== {path.name}")
        result = subprocess.run([sys.executable, str(path)], env=env, capture_output=True, text=True)
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        if result.returncode != 0:
            failed = True
        for text in expected:
            if text not in result.stdout:
                print(f"Missing from the output: {text!r}")
                failed = True
    made = [one for one in runtime.sandboxes.list(include_stopped=True).to_list()
            if one.info.get("createdAt", "") >= started]
    live = [one for one in made if one.state not in ("stopped", "stopping")]
    fundings = sorted({one.info.get("funding") for one in made})
    print(f"\n{len(made)} sandboxes made, funding {', '.join(fundings)}; {len(live)} still live.")
    for one in live:  # the account may be shared, so nothing here stops a sandbox
        print(f"Still live (this run's, or another client's): {one.id}")
    return 1 if failed or live or fundings != ["trial"] else 0


if __name__ == "__main__":
    sys.exit(main())
