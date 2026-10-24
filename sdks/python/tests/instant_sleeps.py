"""The SDK's own waits (a retry's back-off, a Retry-After, a poll's pause)
recorded instead of slept, for tests of what is retried and under which key:
the clients' ``sleep`` (withruntime._clock) is the one they all go through, so
a test reads each wait the SDK asked for and asserts its size, and spends no
time in it. Real sockets and deadlines stay real: a test of a deadline that
expires during a wait sleeps for real, without this.

    with instant_sleeps() as slept:
        ...
        self.assertGreaterEqual(slept[0], 0.125)
"""
from __future__ import annotations

import asyncio
import contextlib
from typing import Iterator
from unittest import mock


@contextlib.contextmanager
def instant_sleeps() -> Iterator[list[float]]:
    slept: list[float] = []

    def sync_sleep(seconds: float) -> None:
        slept.append(seconds)

    async def async_sleep(seconds: float) -> None:
        slept.append(seconds)
        # Still a turn of the loop, as a wait is: other tasks run.
        await asyncio.sleep(0)

    with mock.patch("withruntime._sync_client.sleep", sync_sleep), mock.patch(
        "withruntime._async_client.sleep", async_sleep
    ):
        yield slept
