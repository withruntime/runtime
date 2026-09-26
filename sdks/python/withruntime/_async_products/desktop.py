# ``sbx.desktop``: a Linux desktop in the sandbox, driven like a person would.
#
#     started = await sbx.desktop.start()     # started["streamUrl"] opens it live
#     await sbx.desktop.open("https://example.com")
#     await sbx.desktop.click(640, 400)
#     await sbx.desktop.type("hello")
#     png = await sbx.desktop.screenshot()
#
# Coordinates are pixels from the top left of the screen.
from __future__ import annotations

import time
from typing import Any, Optional

from .._errors import RuntimeError


async def _sleep(seconds: float) -> None:
    from .._async_client import sleep  # here, not at the top: that module imports this one
    await sleep(seconds)


class AsyncDesktopRecordings:
    """``sbx.desktop.recordings``: the screen to MP4. One at a time; the file
    never exceeds ``max_mib`` and recording stops before the disk fills."""

    def __init__(self, t: Any, base: Any) -> None:
        self._t = t
        self._base = base

    async def start(self, *, fps: Optional[int] = None, max_seconds: Optional[int] = None,
                    max_mib: Optional[int] = None, crf: Optional[int] = None) -> dict[str, Any]:
        body = {k: v for k, v in {"fps": fps, "maxSeconds": max_seconds, "maxMiB": max_mib,
                                  "crf": crf}.items() if v is not None}
        return await self._t.json("POST", f"{self._base()}/recordings", body=body)

    async def stop(self, recording_id: str) -> dict[str, Any]:
        """Answers once the file is complete."""
        return await self._t.json("POST", f"{self._base()}/recordings/{recording_id}:stop", body={})

    async def get(self, recording_id: str) -> dict[str, Any]:
        return await self._t.json("GET", f"{self._base()}/recordings/{recording_id}")

    async def list(self) -> list[dict[str, Any]]:
        return (await self._t.json("GET", f"{self._base()}/recordings"))["data"]

    async def download(self, recording_id: str) -> bytes:
        """The MP4 bytes."""
        return await self._t.bytes("GET", f"{self._base()}/recordings/{recording_id}/video")

    async def delete(self, recording_id: str) -> bool:
        return bool((await self._t.json("DELETE", f"{self._base()}/recordings/{recording_id}"))["deleted"])


class AsyncDesktop:
    def __init__(self, t: Any, sandbox: Any) -> None:
        self._t = t
        self._sandbox = sandbox
        self.recordings = AsyncDesktopRecordings(t, self._base)

    def _base(self) -> str:
        return f"/v1/sandboxes/{self._sandbox.id}/desktop"

    async def _act(self, body: dict[str, Any]) -> Any:
        return await self._t.json("POST", f"{self._base()}:act", body=body)

    async def start(self, *, width: Optional[int] = None, height: Optional[int] = None) -> dict[str, Any]:
        """Starts the desktop. The first start in a sandbox installs it (a
        minute or two); this waits for that, up to 10 minutes."""
        body = {k: v for k, v in {"width": width, "height": height}.items() if v is not None}
        deadline = time.monotonic() + 600
        while True:
            try:
                return await self._t.json("POST", f"{self._base()}:start", body=body)
            except RuntimeError as error:
                if error.code != "desktop_installing" or time.monotonic() > deadline:
                    raise
                await _sleep((error.retry_after_ms or 10_000) / 1000)

    async def stop(self) -> dict[str, Any]:
        return await self._t.json("POST", f"{self._base()}:stop", body={})

    async def screenshot(self, *, format: str = "png", quality: Optional[int] = None) -> bytes:  # noqa: A002
        """PNG bytes, or JPEG with ``format="jpeg"``."""
        query: dict[str, Any] = {"format": format}
        if quality is not None:
            query["quality"] = quality
        return await self._t.bytes("GET", f"{self._base()}/screenshot", query=query)

    async def move(self, x: int, y: int) -> Any:
        return await self._act({"action": "move", "x": x, "y": y})

    async def click(self, x: Optional[int] = None, y: Optional[int] = None, *,
                    button: str = "left", double: bool = False) -> Any:
        body: dict[str, Any] = {"action": "click", "button": button}
        if x is not None and y is not None:
            body.update(x=x, y=y)
        if double:
            body["double"] = True
        return await self._act(body)

    async def double_click(self, x: Optional[int] = None, y: Optional[int] = None) -> Any:
        return await self.click(x, y, double=True)

    async def right_click(self, x: Optional[int] = None, y: Optional[int] = None) -> Any:
        return await self.click(x, y, button="right")

    async def mouse_down(self, button: str = "left") -> Any:
        return await self._act({"action": "mouseDown", "button": button})

    async def mouse_up(self, button: str = "left") -> Any:
        return await self._act({"action": "mouseUp", "button": button})

    async def drag(self, start: tuple[int, int], end: tuple[int, int]) -> Any:
        return await self._act({"action": "drag", "from": list(start), "to": list(end)})

    async def scroll(self, dy: int, *, dx: int = 0, x: Optional[int] = None, y: Optional[int] = None) -> Any:
        """Wheel clicks: positive ``dy`` scrolls down, positive ``dx`` right."""
        body: dict[str, Any] = {"action": "scroll", "dy": dy}
        if dx:
            body["dx"] = dx
        if x is not None and y is not None:
            body.update(x=x, y=y)
        return await self._act(body)

    async def type(self, text: str, *, delay_ms: Optional[int] = None) -> Any:  # noqa: A003
        body: dict[str, Any] = {"action": "type", "text": text}
        if delay_ms is not None:
            body["delayMs"] = delay_ms
        return await self._act(body)

    async def press(self, keys: str) -> Any:
        """xdotool key names, space separated: "ctrl+l", "Return", "alt+Tab"."""
        return await self._act({"action": "key", "keys": keys})

    async def cursor(self) -> dict[str, int]:
        return await self._act({"action": "cursor"})

    async def windows(self) -> list[dict[str, Any]]:
        return (await self._act({"action": "windows"}))["windows"]

    async def focus(self, window_id: str) -> Any:
        return await self._act({"action": "focus", "windowId": window_id})

    async def open(self, url: str) -> Any:
        """Opens ``url`` in Firefox on the desktop. Right after a sandbox's first
        start, Firefox may still be installing; this waits for it."""
        deadline = time.monotonic() + 600
        while True:
            try:
                return await self._act({"action": "open", "url": url})
            except RuntimeError as error:
                if error.code != "desktop_installing" or time.monotonic() > deadline:
                    raise
                await _sleep((error.retry_after_ms or 10_000) / 1000)

    async def launch(self, argv: list[str]) -> Any:
        """Starts a program on the desktop, detached."""
        return await self._act({"action": "launch", "argv": argv})
