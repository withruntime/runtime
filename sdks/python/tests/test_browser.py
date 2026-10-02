"""sbx.browser against a fake transport: the paths and bodies it sends, and
that start waits through browser_installing. Registration on the sandbox is a
shared-file patch (_async_products/__init__.py)."""
import unittest

from withruntime._errors import RuntimeError as SdkError
from withruntime._sync_products.browser import Browser

RUNNING = {"running": True, "cdpUrl": "wss://9223-x.runtimehost.test/s/devtools/browser/b?runtime_preview_token=T"}


class FakeTransport:
    def __init__(self) -> None:
        self.calls = []
        self.installing = 1

    def json(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path.endswith("browser:start") and self.installing:
            self.installing -= 1
            raise SdkError("installing", code="browser_installing", status=409, retry_after_ms=1)
        if path.endswith(":stop"):
            return {"stopped": True}
        return RUNNING


class Sandbox:
    id = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"


class BrowserTest(unittest.TestCase):
    def test_start_waits_then_get_and_stop(self) -> None:
        t = FakeTransport()
        browser = Browser(t, Sandbox())
        self.assertEqual(browser.start(headless=False)["cdpUrl"], RUNNING["cdpUrl"])
        self.assertTrue(browser.get()["running"])
        self.assertTrue(browser.stop())
        base = f"/v1/sandboxes/{Sandbox.id}/browser"
        self.assertEqual(t.calls, [
            ("POST", f"{base}:start", {"headless": False}),
            ("POST", f"{base}:start", {"headless": False}),
            ("GET", base, None),
            ("POST", f"{base}:stop", {}),
        ])


if __name__ == "__main__":
    unittest.main()
