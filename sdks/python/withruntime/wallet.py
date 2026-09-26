"""An account opened with a wallet alone: no key, no sign-in, no browser.

    from withruntime.wallet import open_wallet_account, claim_wallet_account
    opened = open_wallet_account(20, accept_terms=True)
    # send exactly opened["amount"] to one of opened["networks"], then, once paid:
    key = claim_wallet_account(opened["claimCode"])["apiKey"]

Opening one means agreeing to https://withruntime.com/legal/terms, so ask the
person you work for first. The claim code is shown once and is the only way to
the account's key: keep it secret. These two calls go to the website; every
call after the key goes to the API as usual.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

from ._errors import RuntimeError


def _origin(auth_url: Optional[str]) -> str:
    return (auth_url or os.environ.get("RUNTIME_AUTH_URL") or "https://withruntime.com").rstrip("/")


def _post(auth_url: Optional[str], path: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{_origin(auth_url)}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return json.load(answer)
    except urllib.error.HTTPError as error:
        try:
            said = json.load(error)
        except ValueError:
            said = {}
        raise RuntimeError(said.get("error") or f"The request failed (HTTP {error.code}).",
                           code=said.get("code") or ("rate_limited" if error.code == 429 else "request_failed"),
                           status=error.code) from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"No answer from {_origin(auth_url)}.", code="network", hint="Retry in a minute.") from error


def open_wallet_account(usd: float, *, accept_terms: bool, auth_url: Optional[str] = None,
                        timeout: float = 30.0) -> dict[str, Any]:
    """Opens an account and a stablecoin top-up of ``usd`` dollars ($10 to
    $10,000). Returns ``claimCode``, ``amount`` (the exact token amount, to six
    decimals), ``networks`` (an ``address`` on each and its ``tokens``) and
    ``payBy``."""
    return _post(auth_url, "/api/wallet/topups", {"usd": usd, "acceptTerms": accept_terms}, timeout)


def claim_wallet_account(claim_code: str, *, auth_url: Optional[str] = None, timeout: float = 30.0) -> dict[str, Any]:
    """Once the top-up is paid, ``{"status": "paid", "apiKey": ...}``, once.
    Before that, the top-up's ``status``; call again."""
    return _post(auth_url, "/api/wallet/claim", {"claimCode": claim_code}, timeout)
