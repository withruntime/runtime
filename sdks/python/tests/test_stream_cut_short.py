"""A stream of events whose connection closed before its body ended is an
error, not a stream that ended: the synchronous reader returned as if it had
read everything when a Content-Length body stopped short or a chunked one
lost its last chunk, so a watch or a log follow ended quietly part way. The
asynchronous reader already raised."""
import asyncio
import socket
import threading
import time
import unittest

from withruntime._http import AsyncHTTP, Origin, SyncHTTP

LINES = b'{"a":1}\n{"b":2}\n'
CUTS = {
    "length": b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: 100\r\n\r\n" + LINES,
    "chunked": (b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n"
                + b"%x\r\n" % len(LINES) + LINES + b"\r\n"),
}
WHOLE = {
    "length": b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: %d\r\n\r\n" % len(LINES) + LINES,
    "chunked": CUTS["chunked"] + b"0\r\n\r\n",
}


def serve(answer: bytes) -> int:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()

    def run() -> None:
        conn, _ = listener.accept()
        listener.close()
        request = b""
        while b"\r\n\r\n" not in request:
            request += conn.recv(4096)
        conn.sendall(answer)
        time.sleep(0.1)
        conn.close()

    threading.Thread(target=run, daemon=True).start()
    return listener.getsockname()[1]


def read_sync(answer: bytes) -> list[bytes]:
    pool = SyncHTTP(Origin(f"http://127.0.0.1:{serve(answer)}"))
    try:
        return list(pool.send("GET", "/events", {}, None, 5).lines())
    finally:
        pool.close()


async def read_async(answer: bytes) -> list[bytes]:
    pool = AsyncHTTP(Origin(f"http://127.0.0.1:{serve(answer)}"))
    try:
        response = await pool.send("GET", "/events", {}, None, 5)
        return [line async for line in response.lines()]
    finally:
        await pool.close()


class StreamCutShort(unittest.TestCase):
    def test_a_sync_stream_cut_short_raises(self) -> None:
        for kind, answer in CUTS.items():
            with self.subTest(kind), self.assertRaises(ConnectionResetError):
                read_sync(answer)

    def test_an_async_stream_cut_short_raises(self) -> None:
        for kind, answer in CUTS.items():
            with self.subTest(kind), self.assertRaises(ConnectionResetError):
                asyncio.run(read_async(answer))

    def test_a_whole_stream_reads_every_line(self) -> None:
        for kind, answer in WHOLE.items():
            with self.subTest(kind):
                self.assertEqual([b'{"a":1}', b'{"b":2}'], read_sync(answer))
                self.assertEqual([b'{"a":1}', b'{"b":2}'], asyncio.run(read_async(answer)))


if __name__ == "__main__":
    unittest.main()
