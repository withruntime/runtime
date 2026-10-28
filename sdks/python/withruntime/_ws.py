"""A minimal RFC 6455 WebSocket client (client frames masked), for terminals
and tunnels, and the socket over it that resumes across a restart of the API.
Standard library only; sync over sockets, async over asyncio streams."""
from __future__ import annotations

import base64
import json
import os
import socket
import struct
import threading
import time
from typing import Any, Awaitable, Callable, Optional, Tuple

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


def _close_code(payload: bytes) -> int:
    return struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005


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
        self.close_code: Optional[int] = None

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
                self.close_code = _close_code(payload)
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
        self.close_code: Optional[int] = None

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
                self.close_code = _close_code(payload)
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


# A terminal's or tunnel's socket that outlives a restart of the API behind it
# (packages/cloud/src/api/tunnels.ts, "Hand-off"): the API sends {"type":"restart"},
# this side stops sending, buffers what the caller writes and answers
# {"type":"restart"}; the API sends {"type":"resume","token":...,"replay":...}
# and closes with 1012 (Service Restart); this side opens the socket again with
# ?resume=<token>, sends {"type":"replay"} first when there was input the API
# had not yet written, then what it buffered. Output and streams continue from
# the exact byte they stopped at, and the caller sees no close.

#: RFC 6455 close code 1012, Service Restart.
SERVICE_RESTART = 1012
#: How long reconnecting may take before the socket reads as closed.
RESUME_SECONDS = 25.0


def _refused_for_good(error: OSError) -> bool:
    """A 4xx answer to the upgrade other than 429: the token or the sandbox
    is not good, and asking again changes nothing."""
    parts = str(error).split(" ")
    status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    return 400 <= status < 500 and status != 429


def _control(message: Any) -> dict[str, Any]:
    if not isinstance(message, str):
        return {}
    try:
        event = json.loads(message)
    except ValueError:
        return {}
    return event if isinstance(event, dict) else {}


class ResumableWebSocket:
    """send(), recv() and close() of a WebSocket, resumed across a restart of
    the API. ``open(resume)`` opens the API's socket, with the token once
    there is one. Thread-safe for one reader and any number of senders."""

    def __init__(self, open: Callable[[Optional[str]], Any]) -> None:
        self._open = open
        self._socket: Any = None
        self._lock = threading.Lock()
        self._paused = False
        self._outbox: list[bytes | str] = []
        self._token: Optional[str] = None
        self._replay: Optional[str] = None
        self._said: Optional[str] = None
        self.closed = False
        #: Times it resumed, and of those how many replayed unwritten input.
        self.resumes = 0
        self.replays = 0

    def connect(self) -> "ResumableWebSocket":
        self._socket = self._open(None)
        return self

    def send(self, data: bytes | str) -> None:
        with self._lock:
            if self.closed:
                return
            if self._paused:
                self._outbox.append(data)
            else:
                self._socket.send(data)

    def recv(self) -> Optional[bytes | str]:
        """The next message, or None once the socket closed for good."""
        while not self.closed:
            message = self._socket.recv()
            if message is None:
                if self._socket.close_code == SERVICE_RESTART and self._token and self._resume():
                    continue
                self.closed = True
                said, self._said = self._said, None
                return said
            event = _control(message)
            if event.get("type") == "restart":
                with self._lock:
                    self._paused = True
                    self._socket.send(json.dumps({"type": "restart"}))
                continue
            if event.get("type") == "resume" and isinstance(event.get("token"), str):
                self._token = event["token"]
                self._replay = event.get("replay") if isinstance(event.get("replay"), str) else None
                continue
            return message
        return None

    def _resume(self) -> bool:
        token, replay = self._token, self._replay
        self._token = self._replay = None
        deadline, wait = time.monotonic() + RESUME_SECONDS, 0.05
        while time.monotonic() < deadline and not self.closed:
            try:
                socket = self._open(token)
            except OSError as error:
                if _refused_for_good(error):
                    return False
                socket = None
            if socket is not None:
                # A server that never answers must not hold this past the deadline.
                socket._sock.settimeout(max(0.1, deadline - time.monotonic()))
                first = socket.recv()
                socket._sock.settimeout(None)
                event = _control(first)
                if event.get("type") == "ready" and event.get("resumed") is True:
                    with self._lock:
                        if self.closed:
                            socket.close()
                            return False
                        self._socket = socket
                        self.resumes += 1
                        if replay:
                            self.replays += 1
                            socket.send(json.dumps({"type": "replay", "data": replay}))
                        for data in self._outbox:
                            socket.send(data)
                        self._outbox, self._paused = [], False
                    return True
                socket.close()
                if event.get("type") == "error":
                    # Refused for good (the sandbox stopped, say): the
                    # caller reads the error, as on any socket.
                    self._said = first
                    return False
            time.sleep(wait)
            wait = min(wait * 2, 1.0)
        return False

    def close(self) -> None:
        with self._lock:
            self.closed = True
            self._outbox = []
            self._socket.close()


class AsyncResumableWebSocket:
    """ResumableWebSocket for asyncio."""

    def __init__(self, open: Callable[[Optional[str]], Awaitable[Any]]) -> None:
        self._open = open
        self._socket: Any = None
        self._paused = False
        self._outbox: list[bytes | str] = []
        self._token: Optional[str] = None
        self._replay: Optional[str] = None
        self._said: Optional[str] = None
        self.closed = False
        self.resumes = 0
        self.replays = 0

    async def connect(self) -> "AsyncResumableWebSocket":
        self._socket = await self._open(None)
        return self

    async def send(self, data: bytes | str) -> None:
        if self.closed:
            return
        if self._paused:
            self._outbox.append(data)
        else:
            await self._socket.send(data)

    async def recv(self) -> Optional[bytes | str]:
        while not self.closed:
            message = await self._socket.recv()
            if message is None:
                if self._socket.close_code == SERVICE_RESTART and self._token and await self._resume():
                    continue
                self.closed = True
                said, self._said = self._said, None
                return said
            event = _control(message)
            if event.get("type") == "restart":
                self._paused = True
                await self._socket.send(json.dumps({"type": "restart"}))
                continue
            if event.get("type") == "resume" and isinstance(event.get("token"), str):
                self._token = event["token"]
                self._replay = event.get("replay") if isinstance(event.get("replay"), str) else None
                continue
            return message
        return None

    async def _resume(self) -> bool:
        import asyncio
        token, replay = self._token, self._replay
        self._token = self._replay = None
        deadline, wait = time.monotonic() + RESUME_SECONDS, 0.05
        while time.monotonic() < deadline and not self.closed:
            try:
                socket = await self._open(token)
            except OSError as error:
                if _refused_for_good(error):
                    return False
                socket = None
            if socket is not None:
                try:
                    first = await within(socket.recv(), max(0.1, deadline - time.monotonic()))
                except (asyncio.TimeoutError, TimeoutError):
                    first = None
                event = _control(first)
                if event.get("type") == "ready" and event.get("resumed") is True:
                    if self.closed:
                        await socket.close()
                        return False
                    self._socket = socket
                    self.resumes += 1
                    if replay:
                        self.replays += 1
                        await socket.send(json.dumps({"type": "replay", "data": replay}))
                    # Senders append while these go out; the loop takes them too.
                    while self._outbox:
                        await socket.send(self._outbox.pop(0))
                    self._paused = False
                    return True
                await socket.close()
                if event.get("type") == "error":
                    self._said = first
                    return False
            await asyncio.sleep(wait)
            wait = min(wait * 2, 1.0)
        return False

    async def close(self) -> None:
        self.closed = True
        self._outbox = []
        await self._socket.close()
