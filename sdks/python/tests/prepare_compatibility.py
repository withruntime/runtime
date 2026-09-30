"""Install the pinned official SDK test tools into an explicit isolated venv.

Run from any directory: python3 prepare_compatibility.py /tmp/runtime-contracts
No competitor account or service access is used by the resulting tests.
"""
import argparse
import os
from pathlib import Path
import shlex
import subprocess
import sys
import venv
from compatibility_pins import validate_pins


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("environment", type=Path, help="New or existing isolated virtualenv directory")
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        parser.error("Python 3.10 or newer is required")
    validate_pins()
    target = args.environment.resolve()
    if target.exists() and any(target.iterdir()) and not (target / "pyvenv.cfg").is_file():
        parser.error("The target already contains files and is not a virtualenv")
    # Relocatable Python distributions on macOS resolve libpython beside the
    # interpreter. A copied executable breaks that lookup; use venv's CLI
    # default of symlinks on POSIX.
    venv.EnvBuilder(with_pip=True, symlinks=os.name != "nt").create(target)
    python = target / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    tests = Path(__file__).resolve().parent
    subprocess.run([str(python), "-m", "pip", "install", "--only-binary=:all:", "--require-hashes", "--force-reinstall",
                    "-r", str(tests / "compatibility-requirements.txt")], check=True)
    print("\nRun the official SDK differential contracts from the repository root:")
    print("RUNTIME_COMPAT_OFFICIAL=1 PYTHONPATH=sdks/python " + shlex.quote(str(python)) +
          " -m unittest discover -s sdks/python/tests -p 'test_compat_python_official.py'")


if __name__ == "__main__":
    main()
