"""A minimal RFC 6455 WebSocket client (client frames masked), for terminals.
Standard library only; sync over sockets, async over asyncio streams."""
from __future__ import annotations

import base64
import os
import socket
import struct
from typing import Optional, Tuple

from ._http import Origin, _context, open_stream, within
from ._proxy import route_for, tunnel


def _handshake(origin: Origin, target: str, headers: dict[str, str]) -> Tuple[bytes, str]:
    key = base64.b64encode(os.urandom(16)).decode()
    lines = [f"GET {target} HTTP/1.1", f"Host: {origin.netloc}", "Upgrade: websocket", "Connection: Upgrade",
             f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
    lines += [f"{k}: {v}" for k, v in headers.items()]
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"), key


def _frame(opcode: int, payload: bytes) -> bytes:
    mask = os.urandom(4)
    length = len(payload)
    if length < 126:
        head = struct.pack("!BB", 0x80 | opcode, 0x80 | length)
    elif length < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, length)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, length)
    return head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


class SyncWebSocket:
    def __init__(self, origin: Origin, target: str, headers: dict[str, str], timeout: float = 30) -> None:
        route = route_for(origin.tls, origin.host, origin.port)
        raw = (tunnel(route, origin.host, origin.port, timeout) if route.proxy_host
               else socket.create_connection((origin.host, origin.port), timeout=timeout))
        self._sock: socket.socket = _context().wrap_socket(raw, server_hostname=origin.host) if origin.tls else raw
        request, _ = _handshake(origin, target, headers)
        self._sock.sendall(request)
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket handshake closed")
            response += chunk
        head, self._buffer = response.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0]
        if b" 101 " not in status + b" ":
            raise ConnectionRefusedError(head.decode("latin-1", "replace").split("\r\n", 1)[0])
        self._sock.settimeout(None)
        self.closed = False

    def _read(self, n: int) -> bytes:
        while len(self._buffer) < n:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise ConnectionResetError("WebSocket closed")
            self._buffer += chunk
        data, self._buffer = self._buffer[:n], self._buffer[n:]
        return data

    def send(self, data: bytes | str) -> None:
        self._sock.sendall(_frame(0x1, data.encode()) if isinstance(data, str) else _frame(0x2, data))

    def recv(self) -> Optional[bytes | str]:
        """The next message: bytes, str, or None once the socket closed."""
        while True:
            try:
                first, second = self._read(2)
            except (ConnectionResetError, OSError):
                self.closed = True
                return None
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            payload = self._read(length)
            opcode = first & 0x0F
            if opcode == 0x8:
                self.closed = True
                try:
                    self._sock.sendall(_frame(0x8, payload[:2]))
                except OSError:
                    pass
                return None
            if opcode == 0x9:
                self._sock.sendall(_frame(0xA, payload))
                continue
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode in (0x0, 0x2):
                return payload

    def close(self) -> None:
        if not self.closed:
            try:
                self._sock.sendall(_frame(0x8, struct.pack("!H", 1000)))
            except OSError:
                pass
        self.closed = True
        self._sock.close()


class AsyncWebSocket:
    def __init__(self, origin: Origin, target: str, headers: dict[str, str], timeout: float = 30) -> None:
        self._origin, self._target, self._headers, self._timeout = origin, target, headers, timeout
        self.closed = False

    async def connect(self) -> "AsyncWebSocket":
        self._reader, self._writer = await open_stream(self._origin, self._timeout)
        request, _ = _handshake(self._origin, self._target, self._headers)
        self._writer.write(request)
        await self._writer.drain()
        head = await within(self._reader.readuntil(b"\r\n\r\n"), self._timeout)
        if b" 101 " not in head.split(b"\r\n", 1)[0] + b" ":
            raise ConnectionRefusedError(head.decode("latin-1", "replace").split("\r\n", 1)[0])
        return self

    async def send(self, data: bytes | str) -> None:
        self._writer.write(_frame(0x1, data.encode()) if isinstance(data, str) else _frame(0x2, data))
        await self._writer.drain()

    async def recv(self) -> Optional[bytes | str]:
        import asyncio
        while True:
            try:
                first, second = await self._reader.readexactly(2)
            except (asyncio.IncompleteReadError, ConnectionError):
                self.closed = True
                return None
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", await self._reader.readexactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await self._reader.readexactly(8))[0]
            payload = await self._reader.readexactly(length)
            opcode = first & 0x0F
            if opcode == 0x8:
                self.closed = True
                return None
            if opcode == 0x9:
                self._writer.write(_frame(0xA, payload))
                continue
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode in (0x0, 0x2):
                return payload

    async def close(self) -> None:
        if not self.closed:
            try:
                self._writer.write(_frame(0x8, struct.pack("!H", 1000)))
                await self._writer.drain()
            except OSError:
                pass
        self.closed = True
        self._writer.close()
