"""The Python SDK behind an egress proxy, sync and async.

A real HTTPS API (a throwaway certificate made with openssl) and a real CONNECT
proxy that records every tunnel it is asked for. The API is addressed as
api.runtime.test, a name that resolves nowhere, so only the proxy can reach
it: a call that succeeds went through the proxy. Every case sets the proxy
variables itself and clears the rest, so a proxy on the machine running the
tests changes nothing."""
import asyncio
import base64
import hashlib
import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import BaseRequestHandler, ThreadingTCPServer
from unittest import mock

import withruntime._http as http_module
from withruntime import AsyncRuntime, ConnectionError, Runtime, RuntimeError
from withruntime._proxy import describe, route_for

HOST = "api.runtime.test"
PROXY_VARIABLES = ("http_proxy", "https_proxy", "no_proxy", "all_proxy")


class Api(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/v1/echo" and self.headers.get("Upgrade", "").lower() == "websocket":
            accept = base64.b64encode(hashlib.sha1(
                (self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            self.wfile.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                             b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            self.wfile.flush()
            first, second = self.rfile.read(2)
            length = second & 0x7F
            mask = self.rfile.read(4)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self.rfile.read(length)))
            reply = b"echo " + payload
            self.wfile.write(struct.pack("!BB", 0x81, len(reply)) + reply)
            self.wfile.flush()
            self.close_connection = True
            return
        body = json.dumps({"orgId": "org-proxy", "principalId": "agent-proxy", "credentialId": None,
                           "apiVersion": "test", "host": self.headers.get("Host")}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Proxy(BaseRequestHandler):
    tunnels: list = []
    refuse = False
    api_port = 0

    def handle(self):
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.request.recv(1)
            if not chunk:
                return
            head += chunk
        lines = head.decode("latin-1").split("\r\n")
        method, target = lines[0].split(" ")[:2]
        auth = next((line.split(":", 1)[1].strip() for line in lines[1:]
                     if line.lower().startswith("proxy-authorization:")), None)
        Proxy.tunnels.append((f"{method} {target}", auth))
        if Proxy.refuse:
            self.request.sendall(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            return
        host, port = target.rsplit(":", 1)
        upstream = socket.create_connection(("127.0.0.1" if host == HOST else host, int(port)))
        self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")

        def pump(source, sink):
            try:
                while True:
                    data = source.recv(65536)
                    if not data:
                        break
                    sink.sendall(data)
            except OSError:
                pass
            finally:
                for side in (source, sink):
                    try:
                        side.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        other = threading.Thread(target=pump, args=(upstream, self.request), daemon=True)
        other.start()
        pump(self.request, upstream)
        other.join(5)
        upstream.close()


def environment(**values):
    """os.environ with no proxy variable but the ones given."""
    clean = {k: v for k, v in os.environ.items() if k.lower() not in PROXY_VARIABLES}
    return mock.patch.dict(os.environ, {**clean, **values}, clear=True)


class BehindAProxy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("openssl"):
            raise unittest.SkipTest("openssl makes the test certificate")
        cls.dir = tempfile.mkdtemp()
        cert, key = os.path.join(cls.dir, "cert.pem"), os.path.join(cls.dir, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                        "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", f"/CN={HOST}",
                        "-addext", f"subjectAltName=DNS:{HOST},DNS:localhost",
                        "-addext", "basicConstraints=critical,CA:TRUE"], check=True, capture_output=True)
        served = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        served.load_cert_chain(cert, key)
        cls.api = ThreadingHTTPServer(("127.0.0.1", 0), Api)
        cls.api.daemon_threads = True
        cls.api.socket = served.wrap_socket(cls.api.socket, server_side=True)
        cls.api_port = cls.api.server_address[1]
        ThreadingTCPServer.allow_reuse_address = True
        cls.proxy = ThreadingTCPServer(("127.0.0.1", 0), Proxy)
        cls.proxy.daemon_threads = True
        cls.proxy_port = cls.proxy.server_address[1]
        spare = socket.socket()
        spare.bind(("127.0.0.1", 0))
        cls.closed_port = spare.getsockname()[1]
        spare.close()
        for server in (cls.api, cls.proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        # Trust the throwaway certificate, as NODE_EXTRA_CA_CERTS does for Node.
        cls.saved_context = http_module._CONTEXT
        http_module._CONTEXT = ssl.create_default_context(cafile=cert)

    @classmethod
    def tearDownClass(cls):
        http_module._CONTEXT = cls.saved_context
        for server in (cls.api, cls.proxy):
            server.shutdown()
            server.server_close()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        Proxy.tunnels.clear()
        Proxy.refuse = False

    def url(self, host=HOST):
        return f"https://{host}:{self.api_port}"

    def sync_call(self, host=HOST, socket_too=False):
        with Runtime(api_key="rk_test", base_url=self.url(host), max_retries=0) as runtime:
            me = runtime.me()
            echoed = None
            if socket_too:
                ws = runtime._t.websocket("/v1/echo", {})
                ws.send("hi")
                echoed = ws.recv()
                ws.close()
            return me, echoed

    def async_call(self, host=HOST, socket_too=False):
        async def main():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url(host), max_retries=0) as runtime:
                me = await runtime.me()
                echoed = None
                if socket_too:
                    ws = await runtime._t.websocket("/v1/echo", {})
                    await ws.send("hi")
                    echoed = await ws.recv()
                    await ws.close()
                return me, echoed
        return asyncio.run(main())

    def test_calls_and_websockets_go_through_https_proxy_with_credentials(self):
        for call in (self.sync_call, self.async_call):
            Proxy.tunnels.clear()
            with environment(HTTPS_PROXY=f"http://agent:pa%40ss@127.0.0.1:{self.proxy_port}"):
                me, echoed = call(socket_too=True)
            self.assertEqual(me["orgId"], "org-proxy")
            self.assertEqual(me["host"], f"{HOST}:{self.api_port}")
            self.assertEqual(echoed, "echo hi")
            self.assertGreaterEqual(len(Proxy.tunnels), 2)
            expected = "Basic " + base64.b64encode(b"agent:pa@ss").decode()
            for tunnel in Proxy.tunnels:
                self.assertEqual(tunnel, (f"CONNECT {HOST}:{self.api_port}", expected))

    def test_a_host_no_proxy_lists_connects_directly(self):
        for call in (self.sync_call, self.async_call):
            Proxy.tunnels.clear()
            with environment(https_proxy=f"http://127.0.0.1:{self.proxy_port}", NO_PROXY="example.com, localhost"):
                me, echoed = call(host="localhost", socket_too=True)
            self.assertEqual((me["orgId"], echoed), ("org-proxy", "echo hi"))
            self.assertEqual(Proxy.tunnels, [])
            # Without the exemption the same address goes through the proxy.
            with environment(https_proxy=f"http://127.0.0.1:{self.proxy_port}"):
                call(host="localhost")
            self.assertEqual([t[0] for t in Proxy.tunnels], [f"CONNECT localhost:{self.api_port}"])

    def test_a_proxy_that_does_not_answer_is_named_without_its_password(self):
        for call in (self.sync_call, self.async_call):
            with environment(HTTPS_PROXY=f"http://agent:secret@127.0.0.1:{self.closed_port}"):
                with self.assertRaises(ConnectionError) as caught:
                    call()
            error = caught.exception
            self.assertEqual(error.message, f"No answer from Runtime at {self.url()} through the proxy "
                                            f"http://127.0.0.1:{self.closed_port} (HTTPS_PROXY).")
            self.assertEqual(error.hint, f"Check that the proxy is running and allows CONNECT to {HOST}:"
                                         f"{self.api_port}, or list {HOST} in NO_PROXY to connect directly.")
            self.assertNotIn("secret", str(error))

    def test_a_proxy_that_refuses_the_tunnel_for_credentials_says_so(self):
        Proxy.refuse = True
        for call in (self.sync_call, self.async_call):
            with environment(HTTPS_PROXY=f"http://127.0.0.1:{self.proxy_port}"):
                with self.assertRaises(ConnectionError) as caught:
                    call()
            self.assertEqual(caught.exception.message,
                             f"No answer from Runtime at {self.url()} through the proxy "
                             f"http://127.0.0.1:{self.proxy_port} (HTTPS_PROXY), which answered HTTP 407 to the "
                             "tunnel request.")
            self.assertIn("The proxy wants credentials", caught.exception.hint)


class WhichProxy(unittest.TestCase):
    def test_lower_case_wins_and_http_proxy_is_for_http_only(self):
        both = {"https_proxy": "http://lower:1", "HTTPS_PROXY": "http://upper:2"}
        self.assertEqual(route_for(True, "api.withruntime.com", 443, both).shown, "http://lower:1")
        self.assertEqual(route_for(False, "localhost", 80, {"HTTP_PROXY": "proxy:3128"}).shown, "http://proxy:3128")
        only_http = {"HTTP_PROXY": "http://proxy:3128"}
        self.assertEqual(route_for(True, "api.withruntime.com", 443, only_http).http_only, "HTTP_PROXY")
        self.assertEqual(describe(True, "api.withruntime.com", 443, OSError("x"), only_http),
                         (" (directly: no HTTPS proxy is set)",
                          "HTTP_PROXY is set but HTTPS_PROXY is not, and api.withruntime.com is HTTPS. "
                          "Set HTTPS_PROXY to the proxy to use it."))

    def test_no_proxy_names_cover_subdomains_ports_and_star(self):
        def exempt(entries, port=443):
            return route_for(True, "api.withruntime.com", port, {"HTTPS_PROXY": "http://p:1", "NO_PROXY": entries})
        self.assertEqual(exempt("withruntime.com").exempt, "withruntime.com")
        self.assertEqual(exempt(".withruntime.com").exempt, ".withruntime.com")
        self.assertEqual(exempt("localhost api.withruntime.com:443").exempt, "api.withruntime.com:443")
        self.assertEqual(exempt("*").exempt, "*")
        self.assertEqual(exempt("api.withruntime.com:8443").shown, "http://p:1")
        self.assertEqual(exempt("otherwithruntime.com").shown, "http://p:1")

    def test_a_proxy_the_sdk_cannot_speak_to_is_refused_by_name(self):
        with self.assertRaises(RuntimeError) as caught:
            route_for(True, "api.withruntime.com", 443, {"HTTPS_PROXY": "socks5://user:pw@proxy:1080"})
        self.assertEqual(caught.exception.code, "invalid_proxy")
        self.assertEqual(caught.exception.message, "HTTPS_PROXY (socks5://proxy:1080) is not an http:// proxy; "
                                                   "the Python SDK connects through http:// proxies.")


if __name__ == "__main__":
    unittest.main()
