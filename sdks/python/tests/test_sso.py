"""runtime.sso reads single sign-on and directory sync, as the JavaScript SDK's does."""
import unittest
from withruntime._sync_products.sso import Sso


class Transport:
    def __init__(self):
        self.calls = []

    def json(self, method, path, **kwargs):
        self.calls.append((method, path))
        return {"connections": [], "scim": {"tokens": 0, "users": 0, "activeUsers": 0, "groups": []},
                "manage": "https://withruntime.com/account/sso"}


class SsoTest(unittest.TestCase):
    def test_get(self):
        transport = Transport()
        self.assertEqual(Sso(transport).get()["connections"], [])
        self.assertEqual(transport.calls, [("GET", "/v1/sso")])

    def test_installed_on_the_client(self):
        from withruntime import AsyncRuntime, Runtime
        self.assertTrue(hasattr(Runtime(api_key="rt_x", base_url="http://localhost"), "sso"))
        self.assertTrue(hasattr(AsyncRuntime(api_key="rt_x", base_url="http://localhost"), "sso"))


if __name__ == "__main__":
    unittest.main()
