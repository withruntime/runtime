"""A malformed saved login is ignored so the actionable missing-key error wins."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from withruntime import Runtime, RuntimeError
from withruntime._connection import saved_key


class SavedConnection(unittest.TestCase):
    def test_wrong_json_shapes_are_ignored(self):
        origin = "https://api.withruntime.com"
        auth = "https://withruntime.com"
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root, "runtime-cloud")
            directory.mkdir(mode=0o700)
            name = hashlib.sha256(f"{auth}\n{origin}".encode()).hexdigest() + ".json"
            target = directory / name
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": root, "RUNTIME_AUTH_URL": auth}):
                for value in (None, [], "key", 123, False):
                    with self.subTest(value=value):
                        target.write_text(json.dumps(value))
                        target.chmod(0o600)
                        self.assertIsNone(saved_key(origin))
                        with patch.dict(os.environ, {"RUNTIME_API_KEY": ""}):
                            with Runtime(base_url=origin) as runtime:
                                with self.assertRaises(RuntimeError) as caught:
                                    runtime._t._api_key()
                                self.assertEqual(caught.exception.code, "missing_api_key")


if __name__ == "__main__":
    unittest.main()
