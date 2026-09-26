"""A blocked account gets its own error type (ARCHITECTURE.md section 11,
"A blocked account is told why")."""

import unittest
from typing import Any

import withruntime
from withruntime._errors import error_for


class AccountErrorsTest(unittest.TestCase):
    def test_account_blocked_is_its_own_type(self) -> None:
        error = error_for(402, {"error": {"code": "account_blocked",
                                          "message": "This account cannot spend: a payment on it is disputed."}}, None)
        self.assertIsInstance(error, withruntime.AccountBlockedError)
        self.assertIsInstance(error, withruntime.RuntimeError)
        self.assertEqual(error.code, "account_blocked")
        self.assertEqual(error.status, 402)
        self.assertFalse(error.retryable)

    def test_empty_balance_stays_plain(self) -> None:
        error = error_for(402, {"error": {"code": "insufficient_funds", "message": "Add credit."}}, None)
        self.assertNotIsInstance(error, withruntime.AccountBlockedError)


class AccountCloseTest(unittest.TestCase):
    """runtime.account.close (ARCHITECTURE.md section 3.1)."""

    def test_close_posts_the_typed_name_once(self) -> None:
        from withruntime._sync_client import Account

        calls: list[tuple[Any, ...]] = []

        class Transport:
            def json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
                calls.append((method, path, kwargs))
                return {"orgId": "o1", "name": "Acme", "closedAt": "2026-09-25T20:00:00Z", "released": True}

        closed = Account(Transport()).close(confirm="Acme")  # type: ignore[arg-type]
        self.assertTrue(closed["released"])
        self.assertEqual(calls, [("POST", "/v1/account:close", {"body": {"confirm": "Acme"}, "retry": False})])
        self.assertTrue(hasattr(withruntime.Runtime(api_key="rk_x"), "account"))


if __name__ == "__main__":
    unittest.main()
