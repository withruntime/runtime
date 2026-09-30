"""Always-on maintenance tests, independent of optional official dependencies."""
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parent))
from compatibility_pins import LOCK, REQUIREMENTS, validate_pins


class OfficialPinMaintenance(unittest.TestCase):
    def setUp(self):
        self.lock = json.loads(LOCK.read_text())
        self.requirements = REQUIREMENTS.read_text()
        self.upstream = next(item for provider in self.lock["providers"] for item in provider["upstreams"]
                             if item["registry"] == "pypi" and item["name"] == "modal")

    def test_current_primary_wheels_match_central_lock(self):
        self.assertEqual(len(validate_pins()), 6)

    def test_lock_version_change_cannot_test_old_sdk(self):
        self.upstream["version"] = "999.0.0"
        with self.assertRaisesRegex(AssertionError, "modal requirement version/wheel hashes"):
            validate_pins(self.lock, self.requirements)

    def test_changed_or_extra_wheel_hash_cannot_pass(self):
        filename = next(name for name in self.upstream["artifacts"] if name.endswith(".whl"))
        original = self.upstream["artifacts"][filename]
        self.upstream["artifacts"][filename] = "sha256-" + "0" * 64
        with self.assertRaisesRegex(AssertionError, "wheel hashes"):
            validate_pins(self.lock, self.requirements)
        self.upstream["artifacts"][filename] = original
        widened = self.requirements.replace(
            "--hash=sha256:" + original.removeprefix("sha256-"),
            "--hash=sha256:" + original.removeprefix("sha256-") + " --hash=sha256:" + "0" * 64)
        with self.assertRaisesRegex(AssertionError, "wheel hashes"):
            validate_pins(self.lock, widened)

    def test_installed_sdk_version_must_match_lock(self):
        with self.assertRaisesRegex(AssertionError, "found old"):
            validate_pins(installed_version=lambda _: "old")

    def test_missing_primary_package_cannot_reduce_coverage(self):
        for provider in self.lock["providers"]:
            provider["upstreams"] = [item for item in provider["upstreams"] if item is not self.upstream]
        with self.assertRaisesRegex(AssertionError, "missing primary packages"):
            validate_pins(self.lock, self.requirements)

    def test_reusing_environment_reinstalls_and_checks_pinned_artifacts(self):
        import prepare_compatibility
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "pyvenv.cfg").write_text("home = fixture\n")
            with patch("sys.argv", ["prepare_compatibility.py", folder]), \
                    patch.object(prepare_compatibility.venv, "EnvBuilder"), \
                    patch.object(prepare_compatibility.subprocess, "run") as install, \
                    patch("builtins.print"):
                prepare_compatibility.main()
            args = install.call_args.args[0]
            self.assertIn("--force-reinstall", args)
            self.assertIn("--require-hashes", args)
            self.assertIn("--only-binary=:all:", args)
            self.assertTrue(install.call_args.kwargs["check"])
