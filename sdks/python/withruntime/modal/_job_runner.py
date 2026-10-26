"""A scheduled Modal function's job command (_functions.py): run as a file,
from the copy of this package the job's image holds under /opt/runtime-jobs.

    python /opt/runtime-jobs/withruntime/modal/_job_runner.py <app file> <function> [--every=<seconds>]
"""
import os
import sys

if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    # This file's own folder is on sys.path as a script's is: take it off, so
    # the package's modules are found only as withruntime.modal.*.
    sys.path = [p for p in sys.path if os.path.abspath(p) != os.path.dirname(os.path.abspath(__file__))]
    from withruntime.modal._functions import run_in_job

    args = [a for a in sys.argv[1:] if not a.startswith("--every=")]
    every = next((int(a.split("=", 1)[1]) for a in sys.argv[1:] if a.startswith("--every=")), None)
    if len(args) != 2:
        raise SystemExit("usage: _job_runner.py <app file> <function> [--every=<seconds>]")
    run_in_job(args[0], args[1], every)
