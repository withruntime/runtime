"""Inside a Runtime sandbox the API is reached at http://runtime.internal, which
the sandbox's host forwards to the public API (ARCHITECTURE.md section 10,
"Runtime's API from inside a sandbox"). The forward itself is tested in
packages/cloud (linux-egress-api.test.ts, which also drives both SDKs through it)."""
import os
import tempfile
import unittest

from withruntime import Runtime
from withruntime._http import (DEFAULT_BASE_URL, SANDBOX_BASE_URL, Origin, default_base_url,
                               in_runtime_sandbox, reachable)


class SandboxOrigin(unittest.TestCase):
    def test_default_is_runtime_internal_inside_a_sandbox_and_the_public_api_elsewhere(self):
        self.assertEqual(default_base_url({}, lambda: True), SANDBOX_BASE_URL)
        self.assertEqual(default_base_url({}, lambda: False), DEFAULT_BASE_URL)
        # Any other RUNTIME_API_URL wins wherever the code runs; an empty one is unset.
        self.assertEqual(default_base_url({"RUNTIME_API_URL": "https://api.example.com"}, lambda: True),
                         "https://api.example.com")
        self.assertEqual(default_base_url({"RUNTIME_API_URL": ""}, lambda: True), SANDBOX_BASE_URL)

    def test_in_a_sandbox_calls_for_the_public_api_go_to_runtime_internal(self):
        for origin in (DEFAULT_BASE_URL, DEFAULT_BASE_URL + "/"):
            self.assertEqual(reachable(origin, lambda: True), SANDBOX_BASE_URL)
            self.assertEqual(reachable(origin, lambda: False), origin)
            self.assertEqual(default_base_url({"RUNTIME_API_URL": origin}, lambda: True), SANDBOX_BASE_URL)
        self.assertEqual(reachable("https://api.example.com", lambda: True), "https://api.example.com")
        # Outside a sandbox (this machine), a client keeps the origin it was given.
        with Runtime(api_key="rt_key", base_url=DEFAULT_BASE_URL) as runtime:
            self.assertEqual(runtime.base_url, SANDBOX_BASE_URL if in_runtime_sandbox() else DEFAULT_BASE_URL)

    def test_a_sandbox_is_recognised_by_the_environment_file_every_guest_keeps(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = os.path.join(directory, "environment.json")
            self.assertFalse(in_runtime_sandbox(marker))
            with open(marker, "w") as file:
                file.write("{}")
            self.assertTrue(in_runtime_sandbox(marker))

    def test_runtime_internal_is_an_accepted_origin_and_other_plain_http_is_not(self):
        origin = Origin("http://runtime.internal")
        self.assertEqual((origin.tls, origin.host, origin.port, origin.base),
                         (False, "runtime.internal", 80, "http://runtime.internal"))
        for value in ("https://runtime.internal", "http://runtime.internal:8080", "http://runtime.internal/v1",
                      "http://user@runtime.internal", "http://api.withruntime.com",
                      "http://runtime.internal.example.com"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "HTTPS API origin"):
                Origin(value)


if __name__ == "__main__":
    unittest.main()
