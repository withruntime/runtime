# ``sbx.browser``: Chromium in the sandbox, for agents that speak CDP.
#
#     browser = await sbx.browser.start()
#     playwright_browser = await chromium.connect_over_cdp(browser["cdpUrl"])
#
# Inside the sandbox the same browser is at http://127.0.0.1:9222.
from __future__ import annotations

import time
from typing import Any, Optional

from .._errors import RuntimeError


async def _sleep(seconds: float) -> None:
    from .._async_client import sleep  # here, not at the top: that module imports this one
    await sleep(seconds)


class AsyncBrowser:
    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox

    def _base(self) -> str:
        return f"/v1/sandboxes/{self._sandbox.id}/browser"

    async def start(self, *, headless: Optional[bool] = None, width: Optional[int] = None,
                    height: Optional[int] = None) -> dict[str, Any]:
        """Starts Chromium and returns its CDP address as ``cdpUrl``, private,
        for Playwright's connect_over_cdp, browser-use or Stagehand as it is.
        ``headless=False`` shows it on the sandbox's desktop with a live view
        (``streamUrl``). The first start in a sandbox installs Chromium, about
        a minute; this waits for that, up to 10 minutes."""
        body = {k: v for k, v in {"headless": headless, "width": width,
                                  "height": height}.items() if v is not None}
        deadline = time.monotonic() + 600
        while True:
            try:
                return await self._t.json("POST", f"{self._base()}:start", body=body)
            except RuntimeError as error:
                if error.code not in ("browser_installing", "desktop_installing") \
                        or time.monotonic() > deadline:
                    raise
                await _sleep((error.retry_after_ms or 10_000) / 1000)

    async def get(self) -> dict[str, Any]:
        """Whether it runs, and a fresh ``cdpUrl`` when it does."""
        return await self._t.json("GET", self._base())

    async def stop(self) -> bool:
        return bool((await self._t.json("POST", f"{self._base()}:stop", body={}))["stopped"])
