"""Execute the shared resident shell protocol locally, with owned cleanup."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from withruntime._compat_shell import SHELL_BROKER


class ResidentShell(unittest.TestCase):
    def test_same_broker_source_in_both_sdks(self):
        root = Path(__file__).resolve().parents[3]
        source = (root / "packages/cloud-sdk/src/compat/shell.ts").read_text()
        self.assertEqual(SHELL_BROKER, source.split("String.raw`", 1)[1].rsplit("`;", 1)[0])

    def test_state_functions_aliases_failures_and_disconnect(self):
        with tempfile.TemporaryDirectory(prefix="runtime-shell-") as directory:
            script = Path(directory, "broker.py")
            script.write_text(SHELL_BROKER)
            root = str(Path(directory, "shell"))
            def argv(command=None, action=None):
                request = {"command": command, "env": {}, "baseEnv": {}}
                if action:
                    request["action"] = action
                return [sys.executable, str(script), "client", root, json.dumps(request)]
            def run(command):
                result = subprocess.run(argv(command), capture_output=True, text=True, timeout=10, cwd=directory)
                self.assertNotIn("Traceback", result.stderr)
                return result
            try:
                self.assertEqual(run("mkdir child; cd child; greet() { printf 'hello:%s' \"$1\"; }; alias hi='greet friend'; export VALUE=saved; false").returncode, 1)
                self.assertEqual(run("hi; printf ':%s:%s' \"$VALUE\" \"$PWD\"").stdout,
                                 "hello:friend:saved:" + str(Path(directory, "child").resolve()))
                self.assertEqual(run("set -o noclobber; set -o | grep noclobber").returncode, 0)
                self.assertIn("on", run("set -o | grep noclobber").stdout)
                self.assertEqual(run("return 7").returncode, 7)
                self.assertEqual(run("printf healthy").stdout, "healthy")
                client = subprocess.Popen(argv("printf ready; sleep 30"), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    self.assertEqual(client.stdout.read(5), b"ready")
                    client.kill()
                    client.communicate(timeout=5)
                finally:
                    if client.poll() is None:
                        client.kill()
                        client.communicate(timeout=5)
                self.assertEqual(run("printf recovered").stdout, "recovered")
                self.assertEqual(run("printf() { builtin printf custom; }; printf").stdout, "custom")
                self.assertEqual(run("builtin printf intact").stdout, "intact")
                changed_path = run("export PATH=/nonexistent; builtin printf changed")
                self.assertEqual((changed_path.stdout, changed_path.stderr), ("changed", ""))
                self.assertEqual(run("builtin printf '%s' \"$PATH\"").stdout, "/nonexistent")
            finally:
                subprocess.run(argv(action="destroy"), capture_output=True, timeout=10)


if __name__ == "__main__":
    unittest.main()
