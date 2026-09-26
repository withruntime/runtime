"""End to end, against the real API: withruntime.harbor.RuntimeEnvironment
through Harbor's own BaseEnvironment, then optionally one real Terminal-Bench
task through the `harbor run` CLI.

    pip install "withruntime[harbor]"          # Harbor needs Python 3.12 or newer
    RUNTIME_API_KEY=... python3 sdks/python/scripts/harbor_e2e.py
    RUNTIME_API_KEY=... python3 sdks/python/scripts/harbor_e2e.py --task path/to/terminal-bench-2/fix-git

Two environments, one after the other, each a trial sandbox (1 vCPU, 2 GiB,
10 GiB of disk) stopped when its case ends:

- "runtime base": a task whose Dockerfile is `FROM runtime` (Runtime's base
  image, which has passwordless sudo) with `WORKDIR /app`.
- "public image": a task with `docker_image = "python:3.13-slim"`, as every
  Terminal-Bench 2.0 task has. Root commands there need the image builder to
  give uid 1000 passwordless sudo; until it does, this case reports the
  adapter's refusal instead of passing.

Each builds a Runtime image once (kept as harbor-e2e-<case>:<hash>, stored
under the account's image quota; `runtime image rm` removes it). `--task`
then runs `harbor run -p <task> -a oracle -e withruntime.harbor:RuntimeEnvironment
--ek funding=trial`, the oracle solution against the task's own tests.

Prints PASS or FAIL for each check, then checks that no sandbox it created
is still running. RUNTIME_API_URL points it elsewhere. Not part of the tests."""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

if not os.environ.get("RUNTIME_API_KEY"):
    sys.exit("Set RUNTIME_API_KEY to a Runtime key (a test key).")

try:
    from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
    from harbor.models.trial.paths import TrialPaths
except ImportError:
    sys.exit('Install Harbor first: pip install "withruntime[harbor]" (Python 3.12 or newer).')

from withruntime import AsyncRuntime  # noqa: E402
from withruntime.harbor import MissingSudoError, RuntimeEnvironment  # noqa: E402

results: list[tuple[str, bool, str]] = []
created: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail and not ok else ''}", flush=True)


def environment(work: Path, case: str, dockerfile: str | None, docker_image: str | None) -> RuntimeEnvironment:
    env_dir = work / case / "environment"
    env_dir.mkdir(parents=True)
    if dockerfile is not None:
        (env_dir / "Dockerfile").write_text(dockerfile)
    trial = work / case / "trial"
    trial.mkdir()
    paths = TrialPaths(trial_dir=trial)
    paths.mkdir()
    config = EnvironmentConfig(docker_image=docker_image, cpus=1, memory_mb=2048, storage_mb=10240,
                               env={"TASK_VAR": "from-task"})
    return RuntimeEnvironment(environment_dir=env_dir, environment_name=f"e2e-{case}", session_id=f"e2e-{case}__env",
                              trial_paths=paths, task_env_config=config, funding="trial")


async def exercise(env: RuntimeEnvironment, case: str, work: Path, cwd: str) -> None:
    started = time.monotonic()
    try:
        await env.start(force_build=False)
    except MissingSudoError as error:
        check(f"{case}: start", False, f"refused, as it should be without sudo: {error}")
        return
    created.append(env._sandbox.id)
    check(f"{case}: start (build or reuse the image, create, probe)", True)
    print(f"      started in {time.monotonic() - started:.1f} s: sandbox {env._sandbox.id}", flush=True)
    try:
        who = await env.exec("id -u; pwd; echo $TASK_VAR")
        lines = (who.stdout or "").split()
        check(f"{case}: default user is root", lines[:1] == ["0"], repr(who))
        check(f"{case}: commands start in {cwd}", lines[1:2] == [cwd], repr(who))
        check(f"{case}: task env reaches the command", lines[-1:] == ["from-task"], repr(who))
        mine = await env.exec("id -u", user=1000)
        check(f"{case}: user=1000 runs as the sandbox user", (mine.stdout or "").strip() == "1000", repr(mine))
        apt = await env.exec("apt-get update -qq >/dev/null && apt-get install -y -qq tree >/dev/null && tree --version",
                             timeout_sec=600)
        check(f"{case}: apt-get as root, as Terminal-Bench verifiers do", apt.return_code == 0,
              (apt.stderr or "")[-500:])
        big = await env.exec("head -c 5000000 /dev/zero | tr '\\0' a")
        check(f"{case}: 5 MB of output arrives whole (past the 64 KiB non-streamed cap)",
              len(big.stdout or "") == 5_000_000, str(len(big.stdout or "")))
        long = "x" * 40_000
        staged = await env.exec(f"printf %s {long} | wc -c", env={f"V{i}": str(i) for i in range(80)})
        check(f"{case}: a 40 KB command with 80 variables", (staged.stdout or "").strip() == "40000", repr(staged))
        try:
            await env.exec("sleep 30", timeout_sec=3)
            check(f"{case}: timeout", False, "no error")
        except RuntimeError as error:
            check(f"{case}: timeout raises as in Docker", "timed out" in str(error), str(error))
        source = work / case / "upload"
        (source / "sub").mkdir(parents=True)
        (source / "test.sh").write_text("#!/bin/sh\necho verified > /logs/verifier/reward.txt\n")
        (source / "test.sh").chmod(0o755)
        (source / "sub" / "blob.bin").write_bytes(os.urandom(3_000_000))
        await env.upload_dir(source, "/tests")
        ran = await env.exec("mkdir -p /logs/verifier && /tests/test.sh && cat /logs/verifier/reward.txt")
        check(f"{case}: upload_dir to /tests keeps modes; a root script writes /logs",
              (ran.stdout or "").strip() == "verified", repr(ran))
        back = work / case / "download"
        await env.download_dir("/tests", back)
        check(f"{case}: download_dir round trip of 3 MB",
              (back / "sub" / "blob.bin").read_bytes() == (source / "sub" / "blob.bin").read_bytes())
        await env.download_file("/logs/verifier/reward.txt", back / "reward.txt")
        check(f"{case}: download_file", (back / "reward.txt").read_text().strip() == "verified")
        await env.set_network_policy(NetworkPolicy(network_mode=NetworkMode.NO_NETWORK))
        off = await env.exec("curl -sS -m 10 -o /dev/null https://pypi.org/simple/ && echo reached", timeout_sec=30)
        await env.set_network_policy(NetworkPolicy(network_mode=NetworkMode.PUBLIC))
        on = await env.exec("curl -sS -m 20 -o /dev/null https://pypi.org/simple/ && echo reached", timeout_sec=60)
        check(f"{case}: network off then on while running",
              "reached" not in (off.stdout or "") and "reached" in (on.stdout or ""), f"{off!r} {on!r}")
    finally:
        await env.stop(delete=True)


async def sweep(tasks: set[str]) -> None:
    """Every sandbox this script started is stopped: say so, and stop any that is not."""
    async with AsyncRuntime() as runtime:
        for sandbox_id in created:
            sandbox = await runtime.sandboxes.get(sandbox_id)
            check(f"sandbox {sandbox_id} is stopped", sandbox.state in ("stopped", "stopping"), sandbox.state)
        page = await runtime.sandboxes.list(labels={"created_by": "harbor"})
        for sandbox in await page.to_list():
            if (sandbox.info.get("labels") or {}).get("harbor_task") in tasks:
                check(f"no sandbox of {sorted(tasks)} left running", False, f"{sandbox.id} was; stopping it")
                await sandbox.stop()


async def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="runtime-harbor-e2e-"))
    print(f"Running against {os.environ.get('RUNTIME_API_URL', 'https://api.withruntime.com')}", flush=True)
    try:
        await exercise(environment(work, "runtime-base", "FROM runtime\nWORKDIR /app\n", None), "runtime base", work,
                       "/app")
        await exercise(environment(work, "public-image", None, "python:3.13-slim"), "public image", work,
                       "/workspace")
    finally:
        await sweep({"e2e-runtime-base", "e2e-public-image"})
        shutil.rmtree(work, ignore_errors=True)
    if "--task" in sys.argv:
        task = sys.argv[sys.argv.index("--task") + 1]
        jobs = tempfile.mkdtemp(prefix="runtime-harbor-jobs-")
        command = ["harbor", "run", "-p", task, "-a", "oracle", "-e", "withruntime.harbor:RuntimeEnvironment",
                   "--ek", "funding=trial", "--jobs-dir", jobs]
        print("$ " + " ".join(command), flush=True)
        done = subprocess.run(command, env={**os.environ, "PYTHONPATH": str(HERE.parent)})
        await sweep({Path(task).name})
        rewards = list(Path(jobs).rglob("reward.txt"))
        reward = rewards[0].read_text().strip() if rewards else "none"
        check(f"harbor run -p {Path(task).name} -a oracle: reward 1", done.returncode == 0 and reward in ("1", "1.0"),
              f"exit {done.returncode}, reward {reward}, jobs in {jobs}")
    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} of {len(results)} checks passed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
