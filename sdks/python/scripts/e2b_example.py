"""An E2B program as E2B's docs write one: the judge panel's agent-eval cases,
each in a fresh sandbox, checking stdout and the exit code. It imports e2b;
e2b_e2e.py runs a copy with that one import changed."""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from e2b import CommandExitException, Sandbox

CASES = json.loads((Path(__file__).parent / "cases.json").read_text())


def run_case(case):
    started = time.monotonic()
    sbx = Sandbox.create(timeout=300)
    try:
        try:
            result = sbx.commands.run(case["cmd"], timeout=60)
        except CommandExitException as error:
            result = error
        stdout = result.stdout.strip()
        sbx.files.write("/home/user/result.txt", stdout)
        kept = sbx.files.read("/home/user/result.txt")
        passed = result.exit_code == case["expectExit"] and stdout == case["expectStdout"] and kept == stdout
        return {"id": case["id"], "pass": passed, "exitCode": result.exit_code, "stdout": stdout,
                "totalMs": round((time.monotonic() - started) * 1000)}
    finally:
        sbx.kill()


with ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(run_case, CASES))
for r in results:
    print(f"{'PASS' if r['pass'] else 'FAIL'} {r['id']} {r['totalMs']} ms")
failed = [r for r in results if not r["pass"]]
print(json.dumps({"passed": len(results) - len(failed), "failed": len(failed), "results": results}, indent=2))
sys.exit(1 if failed else 0)
