"""PEP 561 declaration and optional built-artifact checks, without SDK imports."""
import ast
from contextlib import contextmanager
from email import message_from_bytes
import gzip
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.10.0"
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_METADATA_BYTES = 256 * 1024
MAX_MEMBERS = 1024


@contextmanager
def expanded_tar(path):
    """Cap gzip output before tarfile parses PAX or GNU extension records."""
    with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as expanded:
        size = 0
        with gzip.open(path, "rb") as compressed:
            while True:
                chunk = compressed.read(64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ARTIFACT_BYTES:
                    raise AssertionError("Expanded source artifact exceeds 16 MiB")
                expanded.write(chunk)
        expanded.seek(0)
        yield expanded


class PackageTyping(unittest.TestCase):
    def test_inline_typing_marker_exists_and_is_not_partial(self):
        marker = ROOT / "withruntime" / "py.typed"
        self.assertTrue(marker.is_file(), "Installed typing needs a PEP 561 marker")
        self.assertEqual(marker.read_bytes(), b"")

    def test_setuptools_explicitly_packages_typing_marker(self):
        project = (ROOT / "pyproject.toml").read_text()
        section = re.search(
            r"(?ms)^\[tool\.setuptools\.package-data\]\s*\n(.*?)(?=^\[|\Z)", project
        )
        self.assertIsNotNone(section, "A source marker alone is not a packaged marker")
        if section is None:
            return
        declaration = re.search(r"(?m)^withruntime\s*=\s*(\[[^\n]*\])", section.group(1))
        self.assertIsNotNone(declaration)
        if declaration is None:
            return
        self.assertIn("py.typed", ast.literal_eval(declaration.group(1)))

    def test_package_metadata_and_runtime_version_agree(self):
        project = (ROOT / "pyproject.toml").read_text()
        self.assertRegex(project, rf'(?m)^version = "{re.escape(VERSION)}"$')
        self.assertRegex(project, r'(?m)^requires-python = ">=3\.10"$')
        values = [
            ast.literal_eval(node.value)
            for node in ast.parse((ROOT / "withruntime" / "_version.py").read_text()).body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "VERSION" for target in node.targets)
        ]
        self.assertEqual(values, [VERSION])

    def test_built_wheel_and_sdist_retain_typing_marker(self):
        wheel_path = os.environ.get("RUNTIME_SDK_WHEEL")
        sdist_path = os.environ.get("RUNTIME_SDK_SDIST")
        if not wheel_path and not sdist_path:
            self.skipTest("Provide both built artifact paths for packaging qualification")
        self.assertTrue(wheel_path and sdist_path, "Both artifacts must be qualified together")
        if not wheel_path or not sdist_path:
            return
        for path in (wheel_path, sdist_path):
            self.assertLessEqual(Path(path).stat().st_size, MAX_ARTIFACT_BYTES)
        with zipfile.ZipFile(wheel_path) as wheel:
            entries = wheel.infolist()
            self.assertLessEqual(len(entries), MAX_MEMBERS)
            names = [entry.filename for entry in entries]
            self.assertEqual(len(names), len(set(names)), "Duplicate wheel member")
            self.assertLessEqual(sum(entry.file_size for entry in entries), MAX_ARTIFACT_BYTES)
            for entry in entries:
                path = PurePosixPath(entry.filename)
                self.assertFalse(path.is_absolute() or ".." in path.parts)
                self.assertLessEqual(entry.file_size, MAX_FILE_BYTES)
                self.assertNotEqual(entry.external_attr >> 16 & 0o170000, 0o120000)
            marker = wheel.getinfo("withruntime/py.typed")
            self.assertEqual(marker.file_size, 0)
            metadata_name = f"withruntime-{VERSION}.dist-info/METADATA"
            self.assertLessEqual(wheel.getinfo(metadata_name).file_size, MAX_METADATA_BYTES)
            self.assertEqual(wheel.read("withruntime/py.typed"), b"")
            metadata = message_from_bytes(wheel.read(metadata_name))
            self.assertEqual((metadata["Name"], metadata["Version"]), ("withruntime", VERSION))
        with expanded_tar(sdist_path) as expanded, tarfile.open(fileobj=expanded, mode="r|") as source:
            names = set()
            size = 0
            marker_seen = False
            metadata_seen = False
            for member in source:
                self.assertLess(len(names), MAX_MEMBERS)
                self.assertNotIn(member.name, names, "Duplicate source member")
                names.add(member.name)
                path = PurePosixPath(member.name)
                self.assertFalse(path.is_absolute() or ".." in path.parts)
                self.assertTrue(path.parts and path.parts[0] == f"withruntime-{VERSION}")
                self.assertTrue(member.isdir() or member.isfile(), "Source links are not allowed")
                self.assertGreaterEqual(member.size, 0)
                self.assertLessEqual(member.size, MAX_FILE_BYTES)
                size += member.size
                self.assertLessEqual(size, MAX_ARTIFACT_BYTES)
                if member.isdir():
                    self.assertEqual(member.size, 0)
                    continue
                if member.name == f"withruntime-{VERSION}/withruntime/py.typed":
                    self.assertEqual(member.size, 0)
                    marker_seen = True
                elif member.name == f"withruntime-{VERSION}/PKG-INFO":
                    self.assertLessEqual(member.size, MAX_METADATA_BYTES)
                    contents = source.extractfile(member)
                    self.assertIsNotNone(contents)
                    if contents is not None:
                        with contents:
                            data = contents.read(MAX_METADATA_BYTES + 1)
                        self.assertLessEqual(len(data), MAX_METADATA_BYTES)
                        metadata = message_from_bytes(data)
                        self.assertEqual(
                            (metadata["Name"], metadata["Version"]), ("withruntime", VERSION)
                        )
                        metadata_seen = True
            self.assertTrue(marker_seen, "Source artifact must include py.typed")
            self.assertTrue(metadata_seen, "Source artifact must include version metadata")


if __name__ == "__main__":
    unittest.main()
