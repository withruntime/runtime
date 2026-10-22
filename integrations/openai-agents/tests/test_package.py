"""The package names the SDK's client and the Agents SDK can resolve its
options and state by type, so a serialized RunState resumes on Runtime."""
import unittest

import openai_agents_withruntime as pkg
import withruntime.openai_agents as source
from agents.sandbox.session.sandbox_client import (
    BaseSandboxClient,
    BaseSandboxClientOptions,
)


class Package(unittest.TestCase):
    def test_exports_are_the_sdks_own_classes(self):
        for name in pkg.__all__:
            self.assertIs(getattr(pkg, name), getattr(source, name))

    def test_the_client_is_an_agents_sdk_sandbox_client(self):
        self.assertTrue(issubclass(pkg.RuntimeCloudSandboxClient, BaseSandboxClient))
        self.assertEqual(pkg.RuntimeCloudSandboxClient.backend_id, "runtime_cloud")

    def test_options_round_trip_through_the_sdks_registry(self):
        options = pkg.RuntimeCloudSandboxClientOptions(funding="trial", vcpu=2, labels={"team": "evals"})
        parsed = BaseSandboxClientOptions.parse(options.model_dump(mode="json"))
        self.assertIsInstance(parsed, pkg.RuntimeCloudSandboxClientOptions)
        self.assertEqual(parsed, options)


if __name__ == "__main__":
    unittest.main()
