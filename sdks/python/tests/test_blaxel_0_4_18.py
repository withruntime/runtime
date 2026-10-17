"""What blaxel 0.4.18 added over 0.4.17: workspace secrets (SecretInstance,
SyncSecretInstance, SecretAPIError, blaxel.core.secret). They import and
refuse on use, naming Runtime secrets; before, the imports failed."""
import asyncio
import unittest

from withruntime.blaxel import NotSupportedError


class Secrets(unittest.TestCase):
    def test_the_import_paths_of_0_4_18_load(self):
        from withruntime.blaxel import SecretAPIError, SecretInstance, SyncSecretInstance
        from withruntime.blaxel.core import SecretAPIError as FromCore
        from withruntime.blaxel.core import BlaxelError
        from withruntime.blaxel.core.secret import SecretInstance as FromModule
        from withruntime.blaxel.core.secret import SyncSecretInstance as SyncFromModule
        self.assertIs(FromCore, SecretAPIError)
        self.assertIs(FromModule, SecretInstance)
        self.assertIs(SyncFromModule, SyncSecretInstance)
        self.assertTrue(issubclass(SecretAPIError, BlaxelError))

    def test_secret_calls_refuse_naming_runtime_secrets(self):
        from withruntime.blaxel.core import SecretInstance, SyncSecretInstance
        for call in (lambda: SyncSecretInstance.set("TOKEN", "v"), lambda: SyncSecretInstance.list(),
                     lambda: SyncSecretInstance.delete("TOKEN"), lambda: SecretInstance.set("TOKEN", "v")):
            with self.assertRaises(NotSupportedError) as caught:
                result = call()
                if asyncio.iscoroutine(result):
                    asyncio.run(result)
            self.assertIn("runtime.secrets.set", caught.exception.alternative)


if __name__ == "__main__":
    unittest.main()
