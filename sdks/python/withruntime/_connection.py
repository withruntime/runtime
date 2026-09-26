"""The key `runtime login` saved for this machine, read the way the CLI reads
it: only from a private file in a private directory, bound to the API origin.
Used when no key is passed and RUNTIME_API_KEY is not set."""
from __future__ import annotations

import os
import re
import stat
from typing import Optional

_KEY = re.compile(r"rtcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}")


def _origin(value: str) -> str:
    from urllib.parse import urlsplit
    url = urlsplit(value)
    return f"{url.scheme}://{url.netloc}"


def _private(info: os.stat_result) -> bool:
    return os.name == "nt" or (info.st_mode & 0o077 == 0 and info.st_uid == os.getuid())


def saved_key(base_url: str) -> Optional[str]:
    """The saved key for this API origin, or None when there is none."""
    import hashlib
    import json

    api = _origin(base_url)
    auth = _origin(os.environ.get("RUNTIME_AUTH_URL", "https://withruntime.com"))
    root = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    directory = os.path.join(root, "runtime-cloud")
    name = hashlib.sha256(f"{auth}\n{api}".encode()).hexdigest() + ".json"
    try:
        folder = os.lstat(directory)
        if not stat.S_ISDIR(folder.st_mode) or not _private(folder):
            return None
        descriptor = os.open(os.path.join(directory, name), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096 or not _private(info):
            return None
        saved = json.loads(os.read(descriptor, 4096).decode("utf-8"))
    except (OSError, ValueError):
        return None
    finally:
        os.close(descriptor)
    key = saved.get("key") if isinstance(saved, dict) else None
    if saved.get("apiOrigin") != api or not isinstance(key, str) or not _KEY.fullmatch(key):
        return None
    return key
