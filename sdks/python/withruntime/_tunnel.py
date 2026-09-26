"""Port forwarding into a sandbox over the API's tunnel WebSocket.

One WebSocket carries every connection of a forward. Frames both ways are a
kind byte, a 32-bit stream number and a payload; the server end, and the rules
below, are documented in packages/cloud/src/api/tunnels.ts. This side may send
at most WINDOW data bytes past the last ``a`` (credit) frame, and waits beyond it.
Standard library only: asyncio for the async client, threads for the sync one.
"""
from __future__ import annotations

import json
import queue
import socket
import struct
import threading
from typing import Any, Callable, Optional

from ._errors import RuntimeError

OPEN, DATA, END, CLOSE, ACK = b"o", b"d", b"e", b"c", b"a"
WINDOW = 1_048_576
CHUNK = 65_536


def _frame(kind: bytes, stream: int, payload: bytes = b"") -> bytes:
    return kind + struct.pack("!I", stream) + payload


def _error(message: str) -> RuntimeError:
    event = json.loads(message)
    error = event.get("error") or {}
    return RuntimeError(error.get("message", "The tunnel failed."), code=error.get("code", "tunnel_failed"),
                        hint=error.get("hint"), request_id=error.get("requestId"))


class _Mux:
    """What both clients share: stream numbers, the credit window, and routing
    one received frame to its stream."""

    def __init__(self) -> None:
        self.next = 1
        self.sent = 0
        self.credited = 0
        self.over: Optional[str] = None

    def parse(self, message: bytes) -> tuple[bytes, int, bytes]:
        return message[:1], struct.unpack("!I", message[1:5])[0], message[5:]


class AsyncPortForward:
    """A local port forwarded to ``port`` inside the sandbox, until close()."""

    def __init__(self, socket: Any, port: int) -> None:
        import asyncio
        self._socket, self.port = socket, port
        self._mux = _Mux()
        self._streams: dict[int, Any] = {}
        self._opening: dict[int, Any] = {}
        self._credit = asyncio.Event()
        self._server: Any = None
        self._reader: Any = None
        self.host = "127.0.0.1"
        self.local_port = 0

    async def _start(self, local_port: Optional[int], host: str) -> "AsyncPortForward":
        import asyncio
        ready = await self._socket.recv()
        if not isinstance(ready, str) or json.loads(ready).get("type") != "ready":
            await self._socket.close()
            raise _error(ready) if isinstance(ready, str) else RuntimeError(
                "The tunnel could not be opened: check the key and that the sandbox is running.",
                code="tunnel_refused")
        self._reader = asyncio.ensure_future(self._read())
        self._server = await asyncio.start_server(self._accept, host, self.port if local_port is None else local_port)
        self.host, self.local_port = host, self._server.sockets[0].getsockname()[1]
        return self

    async def _read(self) -> None:
        while True:
            message = await self._socket.recv()
            if message is None:
                break
            if isinstance(message, str):
                if json.loads(message).get("type") == "error":
                    self._mux.over = _error(message).message
                continue
            kind, stream, payload = self._mux.parse(message)
            if kind == ACK:
                self._mux.credited = max(self._mux.credited, struct.unpack("!Q", payload)[0])
                self._credit.set()
                continue
            opening = self._opening.pop(stream, None)
            if opening is not None:
                opening.set_result(payload.decode() if kind != OPEN else None)
                continue
            writer = self._streams.get(stream)
            if writer is None:
                continue
            # Buffered, never awaited here: waiting on one slow local socket
            # would hold up every other connection and the credit frames.
            if kind == DATA:
                writer.write(payload)
            elif kind == END:
                if writer.can_write_eof():
                    writer.write_eof()
            elif kind == CLOSE:
                self._streams.pop(stream, None)
                writer.close()
        self._mux.over = self._mux.over or "The tunnel closed."
        self._credit.set()
        for future in self._opening.values():
            future.set_result(self._mux.over)
        for writer in self._streams.values():
            writer.close()
        self._streams.clear()

    async def _accept(self, reader: Any, writer: Any) -> None:
        import asyncio
        if self._mux.over:
            writer.close()
            return
        stream = self._mux.next
        self._mux.next += 1
        opened = asyncio.get_running_loop().create_future()
        self._opening[stream] = opened
        await self._socket.send(_frame(OPEN, stream, f"tcp {self.port}".encode()))
        if await opened is not None:
            writer.close()
            return
        self._streams[stream] = writer
        try:
            while True:
                data = await reader.read(CHUNK)
                if not data:
                    await self._socket.send(_frame(END, stream))
                    return
                while self._mux.sent + len(data) - self._mux.credited > WINDOW and not self._mux.over:
                    self._credit.clear()
                    await self._credit.wait()
                if self._mux.over:
                    return
                self._mux.sent += len(data)
                await self._socket.send(_frame(DATA, stream, data))
        except (ConnectionError, OSError):
            if stream in self._streams:
                self._streams.pop(stream, None)
                await self._socket.send(_frame(CLOSE, stream))

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
        for writer in list(self._streams.values()):
            writer.close()
        await self._socket.close()
        if self._reader is not None:
            self._reader.cancel()

    async def __aenter__(self) -> "AsyncPortForward":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()


class PortForward:
    """A local port forwarded to ``port`` inside the sandbox, until close().
    Threads: one reads the WebSocket, one accepts, one per connection sends."""

    def __init__(self, socket: Any, port: int) -> None:
        self._socket, self.port = socket, port
        self._mux = _Mux()
        self._lock = threading.Lock()
        self._credit = threading.Condition()
        self._streams: dict[int, socket.socket] = {}
        self._outboxes: dict[int, "queue.Queue[Optional[bytes]]"] = {}
        self._opening: dict[int, list[Any]] = {}
        self._listener: Optional[socket.socket] = None
        self.host = "127.0.0.1"
        self.local_port = 0

    def _send(self, data: bytes) -> None:
        with self._lock:
            self._socket.send(data)

    def _start(self, local_port: Optional[int], host: str) -> "PortForward":
        ready = self._socket.recv()
        if not isinstance(ready, str) or json.loads(ready).get("type") != "ready":
            self._socket.close()
            raise _error(ready) if isinstance(ready, str) else RuntimeError(
                "The tunnel could not be opened: check the key and that the sandbox is running.",
                code="tunnel_refused")
        self._listener = socket.create_server((host, self.port if local_port is None else local_port))
        self.host, self.local_port = host, self._listener.getsockname()[1]
        for target in (self._read, self._accept):
            threading.Thread(target=target, daemon=True).start()
        return self

    def _read(self) -> None:
        while True:
            message = self._socket.recv()
            if message is None:
                break
            if isinstance(message, str):
                if json.loads(message).get("type") == "error":
                    self._mux.over = _error(message).message
                continue
            kind, stream, payload = self._mux.parse(message)
            if kind == ACK:
                with self._credit:
                    self._mux.credited = max(self._mux.credited, struct.unpack("!Q", payload)[0])
                    self._credit.notify_all()
                continue
            opening = self._opening.pop(stream, None)
            if opening is not None:
                opening[1] = None if kind == OPEN else payload.decode()
                opening[0].set()
                continue
            outbox = self._outboxes.get(stream)
            if outbox is None:
                continue
            # Each connection has its own writer thread: a slow local socket
            # must not hold up the others, or the credit frames read here.
            if kind == DATA:
                outbox.put(payload)
            elif kind == END:
                outbox.put(b"")
            elif kind == CLOSE:
                self._streams.pop(stream, None)
                self._outboxes.pop(stream, None)
                outbox.put(None)
        with self._credit:
            self._mux.over = self._mux.over or "The tunnel closed."
            self._credit.notify_all()
        for opening in self._opening.values():
            opening[1] = self._mux.over
            opening[0].set()
        for outbox in list(self._outboxes.values()):
            outbox.put(None)

    def _deliver(self, stream: int, conn: socket.socket, outbox: "queue.Queue[Optional[bytes]]") -> None:
        while True:
            data = outbox.get()
            try:
                if data is None:
                    conn.close()
                    return
                if data == b"":
                    conn.shutdown(socket.SHUT_WR)
                    continue
                conn.sendall(data)
            except OSError:
                self._outboxes.pop(stream, None)
                if self._streams.pop(stream, None) is not None:
                    self._send(_frame(CLOSE, stream))
                conn.close()
                return

    def _accept(self) -> None:
        assert self._listener is not None
        while True:
            try:
                conn, _ = self._listener.accept()
            except OSError:
                return
            threading.Thread(target=self._carry, args=(conn,), daemon=True).start()

    def _carry(self, conn: socket.socket) -> None:
        if self._mux.over:
            conn.close()
            return
        with self._lock:
            stream = self._mux.next
            self._mux.next += 1
        opening: list[Any] = [threading.Event(), None]
        self._opening[stream] = opening
        self._send(_frame(OPEN, stream, f"tcp {self.port}".encode()))
        opening[0].wait()
        if opening[1] is not None:
            conn.close()
            return
        self._streams[stream] = conn
        outbox: "queue.Queue[Optional[bytes]]" = queue.Queue()
        self._outboxes[stream] = outbox
        threading.Thread(target=self._deliver, args=(stream, conn, outbox), daemon=True).start()
        try:
            while True:
                data = conn.recv(CHUNK)
                if not data:
                    self._send(_frame(END, stream))
                    return
                with self._credit:
                    while self._mux.sent + len(data) - self._mux.credited > WINDOW and not self._mux.over:
                        self._credit.wait()
                    if self._mux.over:
                        return
                    self._mux.sent += len(data)
                self._send(_frame(DATA, stream, data))
        except OSError:
            if self._streams.pop(stream, None) is not None:
                self._send(_frame(CLOSE, stream))

    def close(self) -> None:
        if self._listener is not None:
            self._listener.close()
        for conn in list(self._streams.values()):
            conn.close()
        self._socket.close()

    def __enter__(self) -> "PortForward":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


async def async_open_forward(websocket: Callable[..., Any], path: str, port: int,
                             local_port: Optional[int], host: str) -> AsyncPortForward:
    _check(port)
    return await AsyncPortForward(await websocket(path, {}), port)._start(local_port, host)


def sync_open_forward(websocket: Callable[..., Any], path: str, port: int,
                      local_port: Optional[int], host: str) -> PortForward:
    _check(port)
    return PortForward(websocket(path, {}), port)._start(local_port, host)


def _check(port: int) -> None:
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise RuntimeError("port must be 1 to 65535.", code="invalid_request")
