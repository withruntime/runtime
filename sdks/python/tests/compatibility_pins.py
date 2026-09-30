"""Bind official Python contracts and their installer to the shared upstream lock."""
import importlib.metadata
import json
from pathlib import Path
import re

PRIMARY_PACKAGES = frozenset(("runloop-api-client", "prime-sandboxes", "modal", "sprites-py",
                              "e2b", "e2b-code-interpreter"))
ROOT = Path(__file__).resolve().parents[3]
LOCK = ROOT / "packages/cloud-sdk/compatibility-lock.json"
REQUIREMENTS = Path(__file__).with_name("compatibility-requirements.txt")


def validate_pins(lock=None, requirements=None, installed_version=None):
    """Reject stale versions or permissive primary artifact hashes before testing."""
    lock = json.loads(LOCK.read_text()) if lock is None else lock
    requirements = REQUIREMENTS.read_text() if requirements is None else requirements
    entries = {}
    for line in requirements.replace("\\\n", " ").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([\w.-]+)==([^\s]+)((?:\s+--hash=sha256:[a-f0-9]{64})+)", line)
        if not match:
            raise AssertionError(f"Invalid pinned requirement: {line}")
        name, version, hashes = match.groups()
        name = re.sub(r"[-_.]+", "-", name).lower()
        if name in entries:
            raise AssertionError(f"Duplicate pinned requirement: {name}")
        entries[name] = (version, set(re.findall(r"sha256:([a-f0-9]{64})", hashes)))
    pins = {}
    for provider in lock["providers"]:
        for upstream in provider["upstreams"]:
            name = upstream["name"]
            if upstream["registry"] != "pypi" or name not in PRIMARY_PACKAGES:
                continue
            if name in pins:
                raise AssertionError(f"Duplicate primary package in central lock: {name}")
            version = upstream["version"]
            hashes = {digest.removeprefix("sha256-") for filename, digest in upstream["artifacts"].items()
                      if filename.endswith(".whl") and digest.startswith("sha256-")}
            if not hashes or entries.get(name) != (version, hashes):
                raise AssertionError(f"{name} requirement version/wheel hashes differ from compatibility-lock.json")
            if installed_version is not None:
                try:
                    actual = installed_version(name)
                except importlib.metadata.PackageNotFoundError:
                    actual = "not installed"
                if actual != version:
                    raise AssertionError(f"Expected {name}=={version}; found {actual}. Run "
                                         "python3 sdks/python/tests/prepare_compatibility.py /tmp/runtime-official-contracts")
            pins[name] = version
    if set(pins) != PRIMARY_PACKAGES:
        raise AssertionError(f"Central lock missing primary packages: {sorted(PRIMARY_PACKAGES - set(pins))}")
    return pins
