"""End to end, against the real API: withruntime.inspect_ai with Inspect's
own portable sandbox checks, then a whole `inspect eval` through the entry
point, with no model calls.

    pip install -e "sdks/python[inspect-ai]"     # installs the entry point that registers "runtime"
    RUNTIME_API_KEY=... python3 sdks/python/scripts/inspect_e2e.py

Three trial sandboxes (the default 2 vCPU and 4 GiB), one at a time, each
stopped when its case ends:

- Inspect's self_check suite (inspect_ai.util._sandbox.self_check, about 45
  checks) in Runtime's base image. Commands run as root by default, so the
  three checks that expect a permission error from the default user are
  expected to fail and are reported as such.
- `eval()` of a one-sample task with sandbox=("runtime", "Dockerfile"), where
  the Dockerfile starts FROM python:3.12-slim, scored by a command in the
  sandbox, using Inspect's mockllm model. It builds one Runtime image (kept as
  inspect-<folder>:<hash>; `runtime image rm` removes it).
- The same task with sandbox="runtime" named only by its string, to show the
  entry point registration.

Prints PASS or FAIL for each check, then checks that no sandbox it started is
still running. RUNTIME_API_URL points it elsewhere. Not part of the tests."""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

if not os.environ.get("RUNTIME_API_KEY"):
    sys.exit("Set RUNTIME_API_KEY to a Runtime key (a test key).")

try:
    from inspect_ai import Task, eval as inspect_eval
    from inspect_ai.dataset import Sample
    from inspect_ai.scorer import CORRECT, INCORRECT, Score, Target, accuracy, scorer
    from inspect_ai.solver import Generate, TaskState, solver
    from inspect_ai.util import sandbox as current_sandbox
    from inspect_ai.util._sandbox import self_check
except ImportError:
    sys.exit('Install Inspect first: pip install -e "sdks/python[inspect-ai]".')

from withruntime import AsyncRuntime  # noqa: E402
from withruntime.inspect_ai import RuntimeSandboxEnvironment  # noqa: E402

EXPECTED_TO_FAIL = {
    "test_read_file_not_allowed": "root reads any file",
    "test_write_text_file_without_permissions": "root writes any file",
    "test_write_binary_file_without_permissions": "root writes any file",
}
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail and not ok else ''}", flush=True)


async def self_checks() -> None:
    environments = await RuntimeSandboxEnvironment.sample_init("e2e-self-check", None, {})
    sandbox = environments["default"]
    print(f"      sandbox {sandbox.sandbox.id}", flush=True)
    try:
        for name in self_check.__all__:
            try:
                await getattr(self_check, name)(sandbox)
                failure = None
            except BaseException as error:  # noqa: BLE001 - every check's outcome is reported
                failure = f"{type(error).__name__}: {str(error)[:300]}"
            if name in EXPECTED_TO_FAIL:
                check(f"self_check {name} fails as expected ({EXPECTED_TO_FAIL[name]})", failure is not None,
                      "it passed")
            else:
                check(f"self_check {name}", failure is None, failure or "")
    finally:
        await RuntimeSandboxEnvironment.sample_cleanup("e2e-self-check", None, environments, False)


@solver
def run_in_sandbox():
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        result = await current_sandbox().exec(["sh", "-c", "python3 --version; id -u; pwd"])
        state.output.completion = result.stdout
        return state
    return solve


@scorer(metrics=[accuracy()])
def ran_as_root():
    async def score(state: TaskState, target: Target) -> Score:
        lines = state.output.completion.split("\n")
        ok = len(lines) > 2 and lines[0].startswith("Python 3") and lines[1] == "0" and lines[2] == target.text
        return Score(value=CORRECT if ok else INCORRECT, explanation=state.output.completion)
    return score


def evaluate(name: str, sandbox, cwd: str) -> None:
    task = Task(dataset=[Sample(input="Run it.", target=cwd)], solver=run_in_sandbox(), scorer=ran_as_root(),
                sandbox=sandbox, name=name)
    logs = inspect_eval(task, model="mockllm/model", display="none", log_dir=tempfile.mkdtemp(prefix="inspect-logs-"))
    log = logs[0]
    value = log.results.scores[0].metrics["accuracy"].value if log.results and log.results.scores else None
    check(f"eval {name}: {log.status}, accuracy {value}", log.status == "success" and value == 1.0,
          str(log.error or "")[:500])


async def sweep() -> None:
    async with AsyncRuntime() as runtime:
        page = await runtime.sandboxes.list(labels={"created_by": "inspect-ai"})
        left = [s for s in await page.to_list()
                if (s.info.get("labels") or {}).get("inspect_task", "").startswith("e2e-")]
        check("no sandbox this script started is still running", not left, ", ".join(s.id for s in left))
        for sandbox in left:
            await sandbox.stop()


def main() -> int:
    print(f"Running against {os.environ.get('RUNTIME_API_URL', 'https://api.withruntime.com')}", flush=True)
    folder = Path(tempfile.mkdtemp(prefix="inspect-e2e-"))
    (folder / "Dockerfile").write_text("FROM python:3.12-slim\nWORKDIR /srv/task\n")
    try:
        asyncio.run(self_checks())
        evaluate("e2e-dockerfile", ("runtime", str(folder / "Dockerfile")), "/srv/task")
        evaluate("e2e-base", "runtime", "/workspace")
    finally:
        asyncio.run(sweep())
    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} of {len(results)} checks passed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
