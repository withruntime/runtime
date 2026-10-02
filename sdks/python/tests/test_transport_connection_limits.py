"""Connection setup, discarded TLS and malformed heads obey call ownership."""
import asyncio
import hashlib
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from withruntime import AsyncRuntime, Runtime, RuntimeError
from withruntime import _http
from withruntime._async_client import _check_key
from withruntime._connection import saved_key
from withruntime._http import AsyncHTTP, Origin, open_stream
from withruntime._proxy import Route
from withruntime._request_scope import request_scope


def clean_proxy(**values):
    names = {"http_proxy", "https_proxy", "no_proxy", "all_proxy"}
    clean = {k: v for k, v in os.environ.items() if k.lower() not in names}
    return patch.dict(os.environ, {**clean, **values}, clear=True)


class ConnectionLimits(unittest.TestCase):
    def test_cancel_closes_connect_socket_while_proxy_is_still_waiting(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        connected, closed = threading.Event(), threading.Event()
        def serve():
            connection, _ = listener.accept()
            try:
                connection.settimeout(1)
                head = b""
                while b"\r\n\r\n" not in head:
                    data = connection.recv(4096)
                    if not data:
                        return
                    head += data
                connected.set()
                if not connection.recv(1):
                    closed.set()
            except OSError:
                pass
            finally:
                connection.close()
        worker = threading.Thread(target=serve)
        worker.start()
        async def run():
            with clean_proxy(http_proxy=f"http://127.0.0.1:{listener.getsockname()[1]}"):
                task = asyncio.create_task(open_stream(Origin("http://localhost:1"), 1))
                while not connected.is_set():
                    await asyncio.sleep(0)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(await asyncio.to_thread(closed.wait, .2), "cancelled CONNECT still keeps its peer connected")
        try:
            asyncio.run(run())
        finally:
            worker.join(2)
            listener.close()
            self.assertFalse(worker.is_alive())

    def test_abandoned_proxy_worker_closes_its_late_socket(self):
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled):
                left, right = socket.socketpair()
                started, finish, returned = threading.Event(), threading.Event(), threading.Event()
                def tunnel(*_, **__):
                    started.set()
                    finish.wait(1)
                    returned.set()
                    return left
                async def run():
                    with patch("withruntime._proxy.route_for", return_value=Route(proxy_host="localhost", proxy_port=80)), \
                            patch("withruntime._proxy.tunnel", side_effect=tunnel):
                        task = asyncio.create_task(open_stream(Origin("http://localhost"), .01 if not cancelled else 1))
                        while not started.is_set():
                            await asyncio.sleep(0)
                        if cancelled:
                            task.cancel()
                        with self.assertRaises(asyncio.CancelledError if cancelled else asyncio.TimeoutError):
                            await task
                        finish.set()
                        while not returned.is_set():
                            await asyncio.sleep(0)
                        await asyncio.sleep(.01)
                        self.assertEqual(left.fileno(), -1, "an abandoned CONNECT result still owns a socket")
                try:
                    asyncio.run(run())
                finally:
                    finish.set()
                    left.close()
                    right.close()

    def test_sync_connect_header_drips_stop_at_overall_deadline(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        stopped = threading.Event()
        def serve():
            connection, _ = listener.accept()
            try:
                connection.settimeout(1)
                head = b""
                while b"\r\n\r\n" not in head:
                    data = connection.recv(4096)
                    if not data:
                        return
                    head += data
                connection.sendall(b"HTTP/1.1 200 Connection established\r\nX-Drip: ")
                for _ in range(40):
                    if stopped.wait(.01):
                        break
                    connection.sendall(b"a")
                connection.sendall(b"\r\n\r\n")
            except OSError:
                pass
            finally:
                connection.close()
        worker = threading.Thread(target=serve)
        worker.start()
        try:
            with clean_proxy(http_proxy=f"http://127.0.0.1:{listener.getsockname()[1]}"):
                with Runtime(api_key="rk_test", base_url="http://localhost:1", max_retries=0) as runtime:
                    start = time.monotonic()
                    with request_scope(.05), self.assertRaises(RuntimeError) as caught:
                        runtime._t.json("GET", "/v1/me")
                    self.assertEqual(caught.exception.code, "request_timeout")
                    self.assertLess(time.monotonic() - start, .25, "CONNECT ignored the whole-call deadline")
        finally:
            stopped.set()
            worker.join(2)
            listener.close()
            self.assertFalse(worker.is_alive())

    def test_async_status_only_head_is_not_a_success(self):
        async def run():
            pool = AsyncHTTP(Origin("http://localhost"))
            reader = asyncio.StreamReader()
            reader.feed_data(b"HTTP/1.1 200 OK\r\n")
            reader.feed_eof()
            writer = Mock()
            async def finished():
                pass
            writer.drain = finished
            writer.wait_closed = finished
            async def opened(_):
                return reader, writer
            with patch.object(pool, "_open", side_effect=opened):
                try:
                    with self.assertRaises(ConnectionResetError):
                        await pool.send("POST", "/v1/example", {}, b"{}", 1)
                    self.assertFalse(pool._writers)
                finally:
                    await pool.close()
        asyncio.run(run())

    def test_non_ascii_idempotency_keys_are_rejected_before_sending(self):
        for value in ("Ω", "É", "AΩ", "AÉ"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                _check_key(value)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX named pipes")
    def test_nonregular_saved_login_does_not_block(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root, "runtime-cloud")
            directory.mkdir(mode=0o700)
            origin, auth = "https://api.withruntime.com", "https://withruntime.com"
            name = hashlib.sha256(f"{auth}\n{origin}".encode()).hexdigest() + ".json"
            target = directory / name
            os.mkfifo(target, 0o600)
            result = []
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": root, "RUNTIME_AUTH_URL": auth}):
                worker = threading.Thread(target=lambda: result.append(saved_key(origin)))
                worker.start()
                worker.join(.1)
                blocked = worker.is_alive()
                if blocked:
                    descriptor = os.open(target, os.O_WRONLY | os.O_NONBLOCK)
                    os.close(descriptor)
                    worker.join(1)
                self.assertFalse(blocked, "a saved login named pipe blocks the caller before validation")
                self.assertEqual(result, [None])


class DiscardedTlsDeadline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("openssl"):
            raise unittest.SkipTest("openssl makes the test certificate")
        cls.directory = tempfile.TemporaryDirectory()
        cert = os.path.join(cls.directory.name, "cert.pem")
        key = os.path.join(cls.directory.name, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                        "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost"], check=True, capture_output=True)
        cls.served = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.served.load_cert_chain(cert, key)
        cls.trusted = ssl.create_default_context(cafile=cert)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_discarding_tls_does_not_wait_for_unresponsive_peer(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        stopped = threading.Event()
        def serve():
            connection, _ = listener.accept()
            try:
                with self.served.wrap_socket(connection, server_side=True) as connection:
                    connection.settimeout(1)
                    head = b""
                    while b"\r\n\r\n" not in head:
                        data = connection.recv(4096)
                        if not data:
                            return
                        head += data
                    connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
                    stopped.wait(.5)
            except OSError:
                pass
        worker = threading.Thread(target=serve)
        worker.start()
        async def run():
            with patch.object(_http, "_CONTEXT", self.trusted), clean_proxy(no_proxy="*"):
                async with AsyncRuntime(api_key="rk_test", base_url=f"https://localhost:{listener.getsockname()[1]}",
                                        max_retries=0) as runtime:
                    start = time.monotonic()
                    with request_scope(.05), self.assertRaises(RuntimeError) as caught:
                        await runtime._t.json("GET", "/v1/me")
                    self.assertEqual(caught.exception.code, "request_timeout")
                    self.assertLess(time.monotonic() - start, .25, "TLS goodbye outlived the request deadline")
                    self.assertFalse(runtime._t._http._writers)
        try:
            asyncio.run(run())
        finally:
            stopped.set()
            worker.join(2)
            listener.close()
            self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
