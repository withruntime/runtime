"""Proxies named by the environment, by the same rule as the JavaScript SDK.

HTTPS_PROXY for https:// and wss:// addresses, HTTP_PROXY for http:// ones,
and NO_PROXY for hosts that connect directly; lower case wins over upper case
when both are set. HTTP_PROXY is never used for HTTPS. A NO_PROXY name covers
its subdomains, a leading dot is allowed, host:port limits it to one port and
``*`` alone means every host. A proxy without a scheme is http://. Connections
through a proxy are CONNECT tunnels; the proxy itself is spoken to over plain
HTTP, so an https:// proxy address is refused by name."""
from __future__ import annotations

import base64
import os
import re
import socket
import time
from typing import Callable, Mapping, NamedTuple, Optional, Tuple
from urllib.parse import unquote, urlsplit

from ._errors import RuntimeError


class Route(NamedTuple):
    """How a connection to an address leaves this machine."""
    proxy_host: Optional[str] = None
    proxy_port: Optional[int] = None
    #: The Proxy-Authorization header, when the proxy address carries credentials.
    authorization: Optional[str] = None
    #: The proxy as it may be shown: no user name or password.
    shown: Optional[str] = None
    #: The variable the proxy or the exemption came from.
    variable: Optional[str] = None
    #: The NO_PROXY entry that exempts the host.
    exempt: Optional[str] = None
    #: HTTP_PROXY was set but HTTPS_PROXY was not, for an HTTPS address.
    http_only: Optional[str] = None


def _variable(env: Mapping[str, str], name: str) -> Optional[Tuple[str, str]]:
    for candidate in (name.lower(), name.upper()):
        value = (env.get(candidate) or "").strip()
        if value:
            return value, candidate
    return None


def exemption(entries: str, hostname: str, port: int) -> Optional[str]:
    """The NO_PROXY entry that names this host (and port), if any."""
    host = hostname.lower().strip("[]").rstrip(".")
    for raw in re.split(r"[\s,]+", entries):
        entry = raw.strip().lower()
        if not entry:
            continue
        if entry == "*":
            return entry
        match = re.match(r"^\[?(.*?)\]?(?::(\d+))?$", entry)
        name = (match.group(1) if match else entry).lstrip(".").rstrip(".")
        if not name or (match and match.group(2) and int(match.group(2)) != port):
            continue
        if host == name or host.endswith("." + name):
            return entry
    return None


def route_for(secure: bool, hostname: str, port: int, env: Optional[Mapping[str, str]] = None) -> Route:
    """The route to host:port, read from the environment now."""
    env = os.environ if env is None else env
    found = _variable(env, "https_proxy" if secure else "http_proxy")
    if found is None:
        http = _variable(env, "http_proxy") if secure else None
        return Route(http_only=http[1]) if http else Route()
    value, name = found
    skip = _variable(env, "no_proxy")
    exempt = exemption(skip[0], hostname, port) if skip else None
    if skip and exempt:
        return Route(exempt=exempt, variable=skip[1])
    address = value if re.match(r"^[a-z][a-z0-9+.-]*://", value, re.I) else "http://" + value
    try:
        url = urlsplit(address)
        proxy_port = url.port or 80
    except ValueError:
        raise _invalid(name, value, "is not an address") from None
    if url.scheme.lower() != "http" or not url.hostname:
        shown = f"{url.scheme}://{url.hostname or ''}" + (f":{url.port}" if url.port else "")
        raise _invalid(name, shown, "is not an http:// proxy")
    authorization = None
    if url.username is not None:
        pair = f"{unquote(url.username)}:{unquote(url.password or '')}".encode()
        authorization = "Basic " + base64.b64encode(pair).decode()
    shown = f"http://{url.hostname}:{proxy_port}" if ":" not in url.hostname else f"http://[{url.hostname}]:{proxy_port}"
    return Route(proxy_host=url.hostname, proxy_port=proxy_port, authorization=authorization, shown=shown,
                 variable=name)


def _invalid(name: str, shown: str, problem: str) -> RuntimeError:
    return RuntimeError(f"{name} ({shown}) {problem}; the Python SDK connects through http:// proxies.",
                        code="invalid_proxy",
                        hint=f"Set {name} to the proxy's address, for example http://proxy.example.com:3128, or unset it.")


def describe(secure: bool, hostname: str, port: int, error: BaseException,
             env: Optional[Mapping[str, str]] = None) -> Tuple[str, Optional[str]]:
    """Words for a failed connection: the route it took, and what to check."""
    try:
        route = route_for(secure, hostname, port, env)
    except RuntimeError:
        return "", None
    if route.proxy_host:
        status = refused_status(error)
        via = f" through the proxy {route.shown} ({route.variable})"
        if status:
            via += f", which answered HTTP {status} to the tunnel request"
        if status == 407:
            return via, f"The proxy wants credentials: put them in {route.variable}, as http://user:password@host:port."
        return via, (f"Check that the proxy is running and allows CONNECT to {hostname}:{port}, "
                     f"or list {hostname} in NO_PROXY to connect directly.")
    if route.exempt:
        return (f" (directly: {route.variable} lists {route.exempt})",
                f"Check the network, or remove {route.exempt} from {route.variable} to go through the proxy.")
    if route.http_only:
        return (" (directly: no HTTPS proxy is set)",
                f"{route.http_only} is set but HTTPS_PROXY is not, and {hostname} is HTTPS. "
                "Set HTTPS_PROXY to the proxy to use it.")
    return "", None


class TunnelRefused(OSError):
    """The proxy answered the CONNECT with something other than 200."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(f"Tunnel connection failed: {status} {reason}")
        self.status = status


def refused_status(error: BaseException) -> Optional[int]:
    """The status a proxy refused a tunnel with, from ours or http.client's error."""
    seen: Optional[BaseException] = error
    for _ in range(5):
        if seen is None:
            return None
        if isinstance(seen, TunnelRefused):
            return seen.status
        match = re.search(r"Tunnel connection failed: (\d{3})", str(seen))
        if match:
            return int(match.group(1))
        seen = seen.__cause__ or seen.__context__
    return None


def tunnel(route: Route, host: str, port: int, timeout: float, *,
           on_socket: Optional[Callable[[socket.socket], None]] = None) -> socket.socket:
    """A plain socket to host:port through the route's proxy (CONNECT)."""
    deadline = None if timeout is None else time.monotonic() + timeout
    def remaining():
        if deadline is None:
            return None
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("The CONNECT deadline expired")
        return left
    sock = socket.create_connection((route.proxy_host, route.proxy_port), timeout=remaining())
    try:
        if on_socket is not None:
            on_socket(sock)
        authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
        lines = [f"CONNECT {authority} HTTP/1.1", f"Host: {authority}"]
        if route.authorization:
            lines.append(f"Proxy-Authorization: {route.authorization}")
        sock.settimeout(remaining())
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        head = b""
        while b"\r\n\r\n" not in head:
            sock.settimeout(remaining())
            chunk = sock.recv(1)
            if not chunk:
                raise ConnectionResetError("The proxy closed the connection during CONNECT")
            head += chunk
            if len(head) > 65536:
                raise TunnelRefused(502, "response head too long")
        status_line = head.split(b"\r\n", 1)[0].decode("latin-1")
        parts = status_line.split(" ", 2)
        if len(parts) < 2 or not parts[1].isdigit():
            raise TunnelRefused(502, "malformed response")
        if not 200 <= int(parts[1]) < 300:
            raise TunnelRefused(int(parts[1]), parts[2] if len(parts) > 2 else "")
        return sock
    except BaseException:
        sock.close()
        raise
