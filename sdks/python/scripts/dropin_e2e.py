"""End to end, against the real API: programs written for Daytona's, Vercel
Sandbox's and Blaxel's Python SDKs (tests/fixtures), copied unmodified, with
their one import changed to withruntime.daytona, withruntime.vercel or
withruntime.blaxel.

    python3 scripts/dropin_e2e.py                 # run them all
    python3 scripts/dropin_e2e.py blaxel          # only one SDK's (daytona, vercel, blaxel)
    python3 scripts/dropin_e2e.py --dry           # set up and show the changes only

They use RUNTIME_API_KEY or the key `npx withruntime login` saved, on the
account's default funding, so this refuses to start unless the free trial has
an hour left: then every sandbox runs on the trial. Each program ends what it
makes (Blaxel's run in order on one sandbox, "my-sandbox", which the last one
deletes); afterwards the script checks that every sandbox made since it
started has ended and ran on the trial (another client of the same account
can make that check fail). Not part of the unit tests."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BLAXEL = ("from blaxel.core import", "from withruntime.blaxel import")
PROGRAMS = [
    ("daytona", "daytona_quickstart.py", "from daytona import", "from withruntime.daytona import",
     ["Hello from Python", "0 Hello, World!", "step one\nstep two"], None),
    ("vercel", "vercel_quickstart.py", "from vercel import sandbox", "from withruntime.vercel import sandbox",
     ["Hello from Vercel Sandbox!", "hello", "1\n2\n3\nexit 0"], None),
    # Blaxel's programs share "my-sandbox": made by the first, deleted by the last.
    ("blaxel", "blaxel_create.py", *BLAXEL, [], None),
    ("blaxel", "blaxel_filesystem.py", *BLAXEL, [], None),
    ("blaxel", "blaxel_process.py", *BLAXEL, [], None),
    # Public previews need a paid sandbox; on the trial the program stops at
    # create_if_not_exists, after its web server started and its port opened.
    ("blaxel", "blaxel_preview.py", *BLAXEL, [], "public previews need a paid sandbox"),
    ("blaxel", "blaxel_list.py", *BLAXEL, ["my-sandbox"], None),
    ("blaxel", "--blaxel-checks", "", "", ["private preview answered 200", "envs reach a fresh client: production",
                                             "process by name from a fresh client: ok"], None),
    ("blaxel", "blaxel_sandboxes.py", *BLAXEL, [], None),
]


def prepare(directory: Path, name: str, before: str, after: str) -> Path:
    source = (ROOT / "tests" / "fixtures" / name).read_text()
    changed = source.replace(before, after, 1)
    lines = [(a, b) for a, b in zip(source.splitlines(), changed.splitlines()) if a != b]
    if len(lines) != 1:
        raise SystemExit(f"Expected one changed line in {name}, found {len(lines)}.")
    target = directory / name
    target.write_text(changed)
    print(f"{name} in {directory}; the only change:\n- {lines[0][0]}\n+ {lines[0][1]}")
    return target


def blaxel_checks() -> None:
    """What the programs above cannot show without a paid sandbox or a second
    process, through the adapter, each part in a fresh Python process: a
    private preview with its token, envs and a process name seen from another
    client. Not one of Blaxel's programs."""
    step = sys.argv[sys.argv.index("--blaxel-checks") + 1] if len(sys.argv) > sys.argv.index("--blaxel-checks") + 1 \
        else ""
    if not step:
        for part in ("preview", "start", "reach", "end"):
            result = subprocess.run([sys.executable, __file__, "--blaxel-checks", part], capture_output=True,
                                    text=True, env=os.environ)
            print(result.stdout, end="")
            print(result.stderr, end="", file=sys.stderr)
            if result.returncode:
                raise SystemExit(result.returncode)
        return
    import urllib.error
    import urllib.request
    from datetime import timedelta
    from withruntime.blaxel import SyncSandboxInstance
    if step == "preview":
        box = SyncSandboxInstance.get("my-sandbox")
        preview = box.previews.create_if_not_exists({"metadata": {"name": "private-app-preview"},
                                                     "spec": {"port": 3000, "public": False}})
        token = preview.tokens.create(datetime.now(timezone.utc) + timedelta(minutes=10))
        request = urllib.request.Request(preview.spec.url + "/", headers={"x-runtime-preview-token": token.value})
        with urllib.request.urlopen(request, timeout=60) as reply:
            print(f"private preview answered {reply.status}")
        try:
            urllib.request.urlopen(preview.spec.url + "/", timeout=60)
            print("a private preview answered without its token")
        except urllib.error.HTTPError as error:
            print(f"without the token: {error.code}")
        print(f"fetch answered {box.fetch(3000).status_code}")
    elif step == "start":
        started = time.monotonic()
        box = SyncSandboxInstance.create({"name": "bl-e2e-env", "envs": [{"name": "NODE_ENV", "value": "production"}]})
        made = time.monotonic()
        box.process.exec({"command": "true", "wait_for_completion": True})
        first = time.monotonic()
        box.process.exec({"name": "sleeper", "command": "sleep 2; echo woke"})
        print(json.dumps({"create_s": round(made - started, 3), "first_command_s": round(first - made, 3)}))
    elif step == "reach":
        box = SyncSandboxInstance.get("bl-e2e-env")
        timings = []
        for _ in range(5):
            began = time.monotonic()
            result = box.process.exec({"command": "echo $NODE_ENV", "wait_for_completion": True})
            timings.append(time.monotonic() - began)
        print(f"envs reach a fresh client: {result.stdout.strip()}")
        print(json.dumps({"exec_wait_s": sorted(round(one, 3) for one in timings)}))
        done = box.process.wait("sleeper", max_wait=30000)
        print(f"process by name from a fresh client: {'ok' if done.stdout == 'woke' + chr(10) else done.stdout}")
    elif step == "end":
        SyncSandboxInstance.delete("bl-e2e-env")


def main() -> int:
    if "--blaxel-checks" in sys.argv:
        blaxel_checks()
        return 0
    wanted = [one for one in sys.argv[1:] if not one.startswith("-")]
    directory = Path(tempfile.mkdtemp(prefix="runtime-dropin-e2e-"))
    shutil.copy(ROOT / "tests" / "fixtures" / "image.png", directory / "image.png")
    prepared = []
    for sdk, name, before, after, expected, refusal in PROGRAMS:
        if wanted and sdk not in wanted:
            continue
        argv = [__file__, name] if name.startswith("--") else [str(prepare(directory, name, before, after))]
        prepared.append((name, argv, expected, refusal))
    if "--dry" in sys.argv:
        print("Dry run: not creating sandboxes.")
        return 0
    from withruntime import Runtime
    runtime = Runtime()
    trial = runtime.usage().get("trial") or {}
    if (trial.get("availableMs") or 0) < 3_600_000:
        print("The trial has less than an hour left, so sandboxes could fall to paid credit. Not running.")
        return 2
    if any(name.startswith("blaxel") for name, *_ in prepared) and runtime.sandboxes.list(name="my-sandbox").data:
        print('A sandbox named "my-sandbox" is live; Blaxel\'s programs would reuse it. Not running.')
        return 2
    started = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    failed = False
    env = {**os.environ, "PYTHONPATH": str(ROOT), "DAYTONA_API_KEY": "", "VERCEL_TOKEN": "", "BL_API_KEY": "",
           "BL_WORKSPACE": ""}
    for name, argv, expected, refusal in prepared:
        print(f"\n== {name}")
        began = time.monotonic()
        result = subprocess.run([sys.executable, *argv], env=env, cwd=directory, capture_output=True, text=True)
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        print(f"({time.monotonic() - began:.2f} s, exit {result.returncode})")
        if refusal is not None:
            if result.returncode == 0 or refusal not in result.stderr:
                print(f"Expected the refusal {refusal!r}.")
                failed = True
        elif result.returncode != 0:
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
        print(f"Still live (this run's, or another client's): {one.id} {one.info.get('name')}")
    return 1 if failed or live or fundings != ["trial"] else 0


if __name__ == "__main__":
    sys.exit(main())
