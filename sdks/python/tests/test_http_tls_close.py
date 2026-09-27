"""Throwing away a TLS connection mid-response, as a stream read to its
``exit`` event and closed does: the server's last bytes arrive after our
close_notify, and OpenSSL reports APPLICATION_DATA_AFTER_CLOSE_NOTIFY while
the connection shuts down. That is a closure outcome on a connection being
discarded, not an error of the call, which already has its answer (half of all
streamed async execs failed with it against the real API on 27 September
2026). An error on a connection still being read must still raise."""
import asyncio
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest

from withruntime import _http as http_module
from withruntime._http import AsyncHTTP, Origin

HEAD = (b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n"
        b"10\r\n{\"type\":\"exit\"}\n\r\n")


class Server:
    """Answers each connection with the head and a first chunk, then after a
    pause does ``then`` to it: send the rest, or send bytes that are not TLS."""

    def __init__(self, context: ssl.SSLContext, then: str) -> None:
        self.context, self.then = context, then
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.port = self.listener.getsockname()[1]
        self.closed_by_client = threading.Event()
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self) -> None:
        raw, _ = self.listener.accept()
        self.listener.close()
        with self.context.wrap_socket(raw, server_side=True) as conn:
            request = b""
            while b"\r\n\r\n" not in request:
                request += conn.recv(4096)
            conn.sendall(HEAD)
            time.sleep(0.3)
            if self.then == "rest":
                conn.sendall(b"0\r\n\r\n")
            else:
                socket.socket.send(conn, b"this is not a TLS record\r\n" * 4)
            conn.settimeout(5)
            try:
                while conn.recv(4096):
                    pass
            except (OSError, ssl.SSLError):
                pass
            self.closed_by_client.set()


class DiscardingATlsConnection(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not shutil.which("openssl"):
            raise unittest.SkipTest("openssl makes the test certificate")
        cls.dir = tempfile.mkdtemp()
        cert, key = os.path.join(cls.dir, "cert.pem"), os.path.join(cls.dir, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                        "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:TRUE"],
                       check=True, capture_output=True)
        cls.served = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.served.load_cert_chain(cert, key)
        cls.saved = http_module._CONTEXT
        http_module._CONTEXT = ssl.create_default_context(cafile=cert)

    @classmethod
    def tearDownClass(cls) -> None:
        http_module._CONTEXT = cls.saved
        shutil.rmtree(cls.dir, ignore_errors=True)

    def first_line_then_close(self, server: Server) -> bytes:
        async def main() -> bytes:
            pool = AsyncHTTP(Origin(f"https://localhost:{server.port}"))
            response = await pool.send("GET", "/v1/stream", {}, None, 10)
            lines = response.lines()
            first = await lines.__anext__()
            await lines.aclose()
            await response.close()
            await pool.close()
            return first
        return asyncio.run(main())

    def test_a_goodbye_the_server_talks_over_is_not_an_error(self):
        # Each run discards the connection while the last chunk is on its way;
        # before the fix most of them raised ssl.SSLError here.
        for _ in range(5):
            server = Server(self.served, "rest")
            self.assertEqual(self.first_line_then_close(server), b'{"type":"exit"}')
            self.assertTrue(server.closed_by_client.wait(5), "the discarded connection was left open")

    def test_an_error_on_a_connection_still_being_read_is_raised(self):
        server = Server(self.served, "garbage")

        async def main() -> None:
            pool = AsyncHTTP(Origin(f"https://localhost:{server.port}"))
            response = await pool.send("GET", "/v1/stream", {}, None, 10)
            try:
                async for _ in response.lines():
                    pass
            finally:
                await pool.close()
        with self.assertRaises(ssl.SSLError):
            asyncio.run(main())


if __name__ == "__main__":
    unittest.main()
