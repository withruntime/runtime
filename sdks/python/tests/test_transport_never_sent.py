"""A request whose connection never opened is sent again at once; one that
may have reached a server keeps the backoff (11 October 2026). Real loopback
sockets: a closed port, a server that resets after reading the request, and
one that never answers."""
import asyncio
import socket
import threading
import unittest
from unittest.mock import patch

from withruntime import ConnectionError, RuntimeError
from withruntime import _async_client, _sync_client

BACKOFF = 9.0


def closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Server:
    """Accepts, reads the request, then resets or holds the connection."""

    def __init__(self, mode: str) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.held: list[socket.socket] = []
        self.mode = mode
        threading.Thread(target=self.run, daemon=True).start()

    def run(self) -> None:
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            conn.recv(65536)
            if self.mode == "reset":
                conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b"\x01\x00\x00\x00\x00\x00\x00\x00")
                conn.close()
            else:
                self.held.append(conn)

    def close(self) -> None:
        self.sock.close()
        for conn in self.held:
            conn.close()


def delays(url: str, sync: bool, timeout: float = 5.0) -> list[float]:
    """The pauses a failing write asks for, with the backoff at BACKOFF."""
    seen: list[float] = []

    async def record_async(delay: float) -> None:
        seen.append(delay)

    def record(delay: float) -> None:
        seen.append(delay)

    module = _sync_client if sync else _async_client
    with patch.object(module, "_backoff", return_value=BACKOFF), \
            patch.object(module, "_request_sleep", record if sync else record_async):
        transport = module._Transport("rk_test", url, timeout, 2)
        try:
            if sync:
                transport.send("POST", "/v1/sandboxes", body={}, idempotency_key="k-never-sent")
            else:
                asyncio.run(transport.send("POST", "/v1/sandboxes", body={}, idempotency_key="k-never-sent"))
        except (ConnectionError, RuntimeError):
            pass
    return seen


class NeverSent(unittest.TestCase):
    def test_a_refused_connection_is_sent_again_at_once_then_waits(self) -> None:
        for sync in (True, False):
            with self.subTest(sync=sync):
                seen = delays(f"http://127.0.0.1:{closed_port()}", sync)
                # Before 11 October 2026 the first pause was the backoff.
                self.assertEqual(len(seen), 2)
                self.assertLess(seen[0], 0.05)
                self.assertEqual(seen[1], BACKOFF)

    def test_a_reset_after_the_request_was_sent_keeps_the_backoff(self) -> None:
        for sync in (True, False):
            with self.subTest(sync=sync):
                server = Server("reset")
                try:
                    self.assertEqual(delays(f"http://127.0.0.1:{server.port}", sync), [BACKOFF, BACKOFF])
                finally:
                    server.close()

    def test_a_timeout_keeps_the_backoff(self) -> None:
        for sync in (True, False):
            with self.subTest(sync=sync):
                server = Server("hold")
                try:
                    seen = delays(f"http://127.0.0.1:{server.port}", sync, timeout=0.05)
                    self.assertTrue(seen)
                    self.assertTrue(all(delay == BACKOFF for delay in seen), seen)
                finally:
                    server.close()


if __name__ == "__main__":
    unittest.main()
