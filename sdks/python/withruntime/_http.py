"""HTTP/1.1 with kept-alive connections, standard library only.

``SyncHTTP`` pools ``http.client`` connections; ``AsyncHTTP`` speaks HTTP/1.1
over asyncio streams. Both reuse a connection for the next call once a
response is read to its end, so a client pays TLS once, not per call (0.1.0
opened a new connection for every request)."""
from __future__ import annotations

import os
import queue
import threading
import time
from contextlib import contextmanager
from typing import TYPE_CHECKING, AsyncIterator, Iterator, Optional

if TYPE_CHECKING:
    import asyncio
    import http.client
    import ssl
from urllib.parse import urlsplit

MAX_BODY = 64 * 1024 * 1024
DEFAULT_BASE_URL = "https://api.withruntime.com"
#: Runtime's API as code inside a Runtime sandbox reaches it: the sandbox's own
#: host sends each request on to DEFAULT_BASE_URL over HTTPS. The API runs on
#: that host, whose addresses a sandbox cannot reach directly. Plain HTTP
#: because the hop never leaves the machine: from the program to the guest's own
#: proxy, then over the sandbox's private channel to its host.
SANDBOX_BASE_URL = "http://runtime.internal"
#: Every Runtime sandbox has this file; the guest keeps it current.
SANDBOX_MARKER = "/run/runtime/environment.json"


def in_runtime_sandbox(marker: str = SANDBOX_MARKER) -> bool:
    return os.path.exists(marker)


def default_base_url(env=None, in_sandbox=in_runtime_sandbox) -> str:
    """Where calls go when no base URL is given: RUNTIME_API_URL, then Runtime's
    public API, which ``reachable`` turns into runtime.internal in a sandbox."""
    env = os.environ if env is None else env
    return reachable(env.get("RUNTIME_API_URL") or DEFAULT_BASE_URL, in_sandbox)


def reachable(origin: str, in_sandbox=in_runtime_sandbox) -> str:
    """The origin calls for ``origin`` are sent to from here. In a sandbox the
    public API is its own host, which it cannot reach directly, so calls for it
    go to runtime.internal; every other origin is left as it is."""
    return SANDBOX_BASE_URL if origin.rstrip("/") == DEFAULT_BASE_URL and in_sandbox() else origin
_CONTEXT: "Optional[ssl.SSLContext]" = None


def _context() -> "ssl.SSLContext":
    global _CONTEXT
    if _CONTEXT is None:
        import ssl
        _CONTEXT = ssl.create_default_context()
    return _CONTEXT


async def within(awaitable, timeout: float):
    """``asyncio.wait_for``, without its defect before Python 3.12: a cancel that
    arrives in the same loop turn as the awaited operation completes is
    swallowed (CPython gh-86296), so a cancelled stream read carries on and
    only fails when the next read times out. ``asyncio.timeout`` (3.11) has no
    inner future to lose the cancel to; 3.10 waits on a task it can cancel."""
    import asyncio
    if hasattr(asyncio, "timeout"):
        async with asyncio.timeout(timeout):
            return await awaitable
    task = asyncio.ensure_future(awaitable)
    try:
        done, _ = await asyncio.wait({task}, timeout=timeout)
    except BaseException:
        task.cancel()
        # Do not return cancellation while a child still owns the checked-out
        # stream. Its finally block must close the socket before reuse/shutdown.
        await asyncio.wait({task})
        raise
    if task not in done:
        task.cancel()
        await asyncio.wait({task})
        raise asyncio.TimeoutError()
    return task.result()


async def open_stream(origin: "Origin", timeout: float) -> "tuple[asyncio.StreamReader, asyncio.StreamWriter]":
    """A stream to the origin, through the environment's proxy when one applies."""
    import asyncio
    from ._proxy import route_for, tunnel
    route = route_for(origin.tls, origin.host, origin.port)
    tls = {"ssl": _context(), "server_hostname": origin.host} if origin.tls else {}
    if not route.proxy_host:
        return await within(asyncio.open_connection(origin.host, origin.port, **tls), timeout)
    sock = await within(asyncio.to_thread(tunnel, route, origin.host, origin.port, timeout), timeout)
    try:
        return await within(asyncio.open_connection(sock=sock, **tls), timeout)
    except BaseException:
        sock.close()
        raise


class Origin:
    def __init__(self, base_url: str) -> None:
        url = urlsplit(base_url)
        # runtime.internal is reserved and never resolves outside a sandbox, so
        # a key sent there in plain HTTP never leaves the sandbox's host.
        internal = url.hostname == "runtime.internal"
        local = url.hostname in ("localhost", "127.0.0.1", "::1") or internal
        if ((url.scheme != "https" and not (local and url.scheme == "http")) or not url.hostname
                or (internal and (url.scheme != "http" or url.port not in (None, 80)))
                or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")):
            raise ValueError("Use an HTTPS API origin (or http://runtime.internal inside a sandbox, "
                             "http://localhost for tests)")
        self.tls = url.scheme == "https"
        self.host = url.hostname
        self.port = url.port or (443 if self.tls else 80)
        self.base = f"{url.scheme}://{url.netloc}"
        self.netloc = url.netloc


@contextmanager
def _socket_deadline(stream, deadline):
    """Bound a blocking read, joining its timer before socket ownership moves."""
    if deadline is None:
        yield
        return
    import socket
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("The request deadline expired")
    expired = threading.Event()
    def expire():
        expired.set()
        if stream is not None:
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    timer = threading.Timer(remaining, expire)
    timer.daemon = True
    timer.start()
    try:
        try:
            yield
        except Exception as error:
            if expired.is_set():
                raise TimeoutError("The request deadline expired") from error
            raise
        if expired.is_set() or time.monotonic() >= deadline:
            raise TimeoutError("The request deadline expired")
    finally:
        timer.cancel()
        timer.join()


class SyncResponse:
    def __init__(self, pool: "SyncHTTP", connection: "http.client.HTTPConnection",
                 response: "http.client.HTTPResponse", socket=None) -> None:
        self._socket = socket
        self._pool, self._connection, self._response = pool, connection, response
        self.status = response.status
        self.headers = {k.lower(): v for k, v in response.getheaders()}
        from ._request_scope import current
        self._deadline = current().deadline

    def read(self, limit: Optional[int] = MAX_BODY) -> bytes:
        """The whole body; ``limit=None`` for a file's bytes, which have no cap."""
        try:
            with _socket_deadline(self._socket, self._deadline):
                data = self._response.read() if limit is None else self._response.read(limit + 1)
            if limit is not None and len(data) > limit:
                raise ValueError("Response exceeds 64 MiB")
            return data
        except TimeoutError:
            self._response.will_close = True
            raise
        finally:
            self.close()

    def chunks(self) -> Iterator[bytes]:
        """The body in pieces as it arrives, for a file too big to hold."""
        try:
            while True:
                with _socket_deadline(self._socket, self._deadline):
                    data = self._response.read1(65536)
                if not data:
                    return
                yield data
        except TimeoutError:
            self._response.will_close = True
            raise
        finally:
            self.close()

    def lines(self, deadline: Optional[float] = None) -> Iterator[bytes]:
        # Socket timeouts reset on each received fragment. Bound the complete
        # subscription even when one line arrives byte by byte. The lock keeps
        # the timer from shutting down a connection returned to the pool.
        timer = None
        lock = threading.Lock()
        finished = False
        expired = False
        def expire():
            nonlocal expired
            import socket
            with lock:
                if finished:
                    return
                expired = True
                self._response.will_close = True
                if self._socket is not None:
                    try:
                        self._socket.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
        try:
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Process output deadline exceeded")
                timer = threading.Timer(remaining, expire)
                timer.daemon = True
                timer.start()
            while True:
                line = self._response.readline(4 * 1024 * 1024)
                if expired or (deadline is not None and time.monotonic() >= deadline):
                    raise TimeoutError("Process output deadline exceeded")
                if not line:
                    return
                if line.strip():
                    yield line.strip()
        finally:
            with lock:
                finished = True
            if timer is not None:
                timer.cancel()
                timer.join()
            self.close()

    def close(self) -> None:
        if self._connection is None:
            return
        connection, self._connection = self._connection, None
        if self._response.isclosed() and not self._response.will_close:
            self._pool.release(connection)
        else:
            # HTTPResponse owns a separate buffered socket file. In particular,
            # Connection: close detaches connection.sock before returning its
            # headers, so connection.close() alone cannot release that file.
            try:
                self._response.close()
            finally:
                connection.close()


class SyncHTTP:
    def __init__(self, origin: Origin, idle: int = 8) -> None:
        self.origin = origin
        self._idle: "queue.LifoQueue[http.client.HTTPConnection]" = queue.LifoQueue(maxsize=idle)
        self._closed = False
        self._lock = threading.Lock()

    def _new(self, timeout: float) -> "http.client.HTTPConnection":
        import http.client
        from ._proxy import route_for
        route = route_for(self.origin.tls, self.origin.host, self.origin.port)
        host, port = (route.proxy_host, route.proxy_port) if route.proxy_host else (self.origin.host, self.origin.port)
        connection = (http.client.HTTPSConnection(host, port, timeout=timeout, context=_context()) if self.origin.tls
                      else http.client.HTTPConnection(host, port, timeout=timeout))
        if route.proxy_host:
            # A CONNECT tunnel through the proxy; TLS, when the API is HTTPS,
            # is end to end with the API's own name.
            connection.set_tunnel(self.origin.host, self.origin.port, headers=(
                {"Proxy-Authorization": route.authorization} if route.authorization else None))
        return connection

    def release(self, connection: "http.client.HTTPConnection") -> None:
        with self._lock:
            if not self._closed:
                try:
                    self._idle.put_nowait(connection)
                    return
                except queue.Full:
                    pass
        connection.close()

    def send(self, method: str, target: str, headers: dict[str, str], body: Optional[bytes],
             timeout: float, *, deadline: Optional[float] = None) -> SyncResponse:
        import http.client
        reused = True
        with self._lock:
            if self._closed:
                raise RuntimeError("HTTP pool is closed")
            try:
                connection = self._idle.get_nowait()
            except queue.Empty:
                connection, reused = self._new(timeout), False
        for attempt in (0, 1):
            try:
                remaining = timeout if deadline is None else (deadline - time.monotonic() if timeout is None else min(timeout, deadline - time.monotonic()))
                if remaining is not None and remaining <= 0:
                    raise TimeoutError("Process output deadline exceeded")
                if connection.sock is None:
                    from ._request_scope import connection_timeout
                    connection.timeout = connection_timeout(remaining)
                    connection.connect()
                connection.timeout = remaining
                if connection.sock is not None:
                    connection.sock.settimeout(remaining)
                connection.request(method, target, body=body, headers=headers)
                socket = connection.sock
                response = self._response(connection, socket, deadline)
                return SyncResponse(self, connection, response, socket)
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError):
                connection.close()
                # A kept-alive connection the server had already closed: one
                # fresh try, which cannot have reached the server twice.
                if attempt == 0 and reused:
                    connection, reused = self._new(timeout), False
                    continue
                raise
            except BaseException:
                connection.close()
                raise
        raise OSError("unreachable")

    @staticmethod
    def _response(connection, stream, deadline):
        if deadline is None:
            return connection.getresponse()
        # http.client parses headers through repeated socket reads, whose
        # individual timeouts reset for every fragment. Interrupt only this
        # checked-out socket, and join the timer before ownership can move to
        # a response or another pooled request.
        import socket
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Process output deadline exceeded")
        lock = threading.Lock()
        finished = False
        expired = False
        def expire():
            nonlocal expired
            with lock:
                if finished:
                    return
                expired = True
                if stream is not None:
                    try:
                        stream.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
        timer = threading.Timer(remaining, expire)
        timer.daemon = True
        timer.start()
        try:
            try:
                response = connection.getresponse()
            except BaseException as error:
                if expired or time.monotonic() >= deadline:
                    raise TimeoutError("Process output deadline exceeded") from error
                raise
            if expired or time.monotonic() >= deadline:
                response.close()
                raise TimeoutError("Process output deadline exceeded")
            return response
        finally:
            with lock:
                finished = True
            timer.cancel()
            timer.join()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            while True:
                try:
                    self._idle.get_nowait().close()
                except queue.Empty:
                    return

    def __del__(self) -> None:
        self.close()


class AsyncResponse:
    def __init__(self, pool: "AsyncHTTP", reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                 status: int, headers: dict[str, str], timeout: float) -> None:
        self._pool, self._reader, self._writer = pool, reader, writer
        self.status, self.headers, self._timeout = status, headers, timeout
        self._chunked = headers.get("transfer-encoding", "").lower() == "chunked"
        length = headers.get("content-length")
        self._remaining = int(length) if length is not None else None
        self._done = False
        self._keep = headers.get("connection", "").lower() != "close"
        self._chunk_left = 0
        from ._request_scope import current
        self._deadline = current().deadline

    async def _read_some(self) -> bytes:
        if self._deadline is None:
            return await self._read_piece()
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("The request deadline expired")
        return await within(self._read_piece(), remaining)

    async def _read_piece(self) -> bytes:
        if self._done:
            return b""
        if self._chunked:
            if self._chunk_left == 0:
                size_line = await within(self._reader.readline(), self._timeout)
                size = int(size_line.split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while (await within(self._reader.readline(), self._timeout)).strip():
                        pass
                    self._done = True
                    return b""
                self._chunk_left = size
            data = await within(self._reader.read(min(self._chunk_left, 65536)), self._timeout)
            if not data:
                raise ConnectionResetError("Connection closed mid-chunk")
            self._chunk_left -= len(data)
            if self._chunk_left == 0:
                await within(self._reader.readexactly(2), self._timeout)
            return data
        if self._remaining is not None:
            if self._remaining == 0:
                self._done = True
                return b""
            data = await within(self._reader.read(min(self._remaining, 65536)), self._timeout)
            if not data:
                raise ConnectionResetError("Connection closed early")
            self._remaining -= len(data)
            if self._remaining == 0:
                self._done = True
            return data
        data = await within(self._reader.read(65536), self._timeout)
        if not data:
            self._done, self._keep = True, False
        return data

    async def read(self, limit: Optional[int] = MAX_BODY) -> bytes:
        """The whole body; ``limit=None`` for a file's bytes, which have no cap."""
        parts, size = [], 0
        try:
            while True:
                data = await self._read_some()
                if not data:
                    return b"".join(parts)
                size += len(data)
                if limit is not None and size > limit:
                    raise ValueError("Response exceeds 64 MiB")
                parts.append(data)
        finally:
            await self.close()

    async def chunks(self) -> AsyncIterator[bytes]:
        """The body in pieces as it arrives, for a file too big to hold."""
        try:
            while True:
                data = await self._read_some()
                if not data:
                    return
                yield data
        finally:
            await self.close()

    async def lines(self, deadline: Optional[float] = None) -> AsyncIterator[bytes]:
        buffer = b""
        try:
            while True:
                if deadline is None:
                    data = await self._read_some()
                else:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Process output deadline exceeded")
                    data = await within(self._read_some(), remaining)
                if not data:
                    if buffer.strip():
                        yield buffer.strip()
                    return
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if deadline is not None and time.monotonic() >= deadline:
                        raise TimeoutError("Process output deadline exceeded")
                    if line.strip():
                        yield line.strip()
        finally:
            await self.close()

    async def close(self) -> None:
        if self._writer is None:
            return
        writer, self._writer = self._writer, None
        if self._done and self._keep:
            await self._pool.release(self._reader, writer)
        else:
            await self._pool.discard(writer)


class AsyncHTTP:
    def __init__(self, origin: Origin, idle: int = 8) -> None:
        self.origin = origin
        self._idle: list[tuple[asyncio.StreamReader, asyncio.StreamWriter]] = []
        self._max = idle
        self._lock = threading.Lock()
        self._closed = False
        self._writers: set[asyncio.StreamWriter] = set()

    async def discard(self, writer: asyncio.StreamWriter) -> None:
        import ssl
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionResetError, BrokenPipeError, ssl.SSLError):
            # The peer has already closed, or kept sending after our TLS
            # close_notify (a stream closed before its last chunk arrived):
            # closure outcomes on a connection being thrown away, which asyncio
            # has already closed, not a reason to fail a call that has its
            # answer or to replace an original read error or cancellation.
            pass
        finally:
            with self._lock:
                self._writers.discard(writer)

    async def release(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        with self._lock:
            if not self._closed and len(self._idle) < self._max and not writer.is_closing():
                self._idle.append((reader, writer))
                return
        await self.discard(writer)

    async def _open(self, timeout: float) -> "tuple[asyncio.StreamReader, asyncio.StreamWriter]":
        from ._request_scope import connection_timeout
        return await open_stream(self.origin, connection_timeout(timeout))

    async def send(self, method: str, target: str, headers: dict[str, str], body: Optional[bytes],
                   timeout: float, *, deadline: Optional[float] = None) -> AsyncResponse:
        if deadline is None:
            return await self._send(method, target, headers, body, timeout)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Process output deadline exceeded")
        # One timeout includes connection setup, request writing, status and
        # every header, including a single header received a byte at a time.
        response = None
        async def start():
            nonlocal response
            response = await self._send(method, target, headers, body, timeout)
            return response
        try:
            return await within(start(), remaining)
        except BaseException:
            # On Python 3.10 the child can finish in the same loop turn that
            # cancels its caller. The response then belongs to neither caller;
            # explicitly discard it instead of leaking a checked-out socket.
            if response is not None:
                await response.close()
            raise

    async def _send(self, method: str, target: str, headers: dict[str, str], body: Optional[bytes],
                    timeout: float) -> AsyncResponse:
        import asyncio
        with self._lock:
            if self._closed:
                raise RuntimeError("HTTP pool is closed")
            pair = self._idle.pop() if self._idle else None
        reused = pair is not None
        for attempt in (0, 1):
            if pair is None:
                pair = await self._open(timeout)
            reader, writer = pair
            with self._lock:
                closed = self._closed
                self._writers.add(writer)
            if closed:
                await self.discard(writer)
                raise RuntimeError("HTTP pool is closed")
            try:
                head = [f"{method} {target} HTTP/1.1", f"Host: {self.origin.netloc}"]
                head += [f"{k}: {v}" for k, v in headers.items()]
                if body is not None or method in ("POST", "PUT"):
                    head.append(f"Content-Length: {len(body or b'')}")
                writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + (body or b""))
                await within(writer.drain(), timeout)
                status_line = await within(reader.readline(), timeout)
                if not status_line:
                    raise ConnectionResetError("Server closed the connection")
                parts = status_line.decode("latin-1").split(" ", 2)
                if len(parts) < 2 or not parts[0].startswith("HTTP/1."):
                    raise ValueError("Malformed status line")
                status = int(parts[1])
                response_headers: dict[str, str] = {}
                while True:
                    line = await within(reader.readline(), timeout)
                    if line in (b"\r\n", b"\n", b""):
                        break
                    name, _, value = line.decode("latin-1").partition(":")
                    response_headers[name.strip().lower()] = value.strip()
                return AsyncResponse(self, reader, writer, status, response_headers, timeout)
            except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
                await self.discard(writer)
                if attempt == 0 and reused and not self._closed:
                    pair, reused = None, False
                    continue
                raise
            except BaseException:
                await self.discard(writer)
                raise
        raise OSError("unreachable")

    async def close(self) -> None:
        import asyncio
        with self._lock:
            self._closed = True
            self._idle = []
            writers = list(self._writers)
        # Close every socket before waiting for any one, including responses
        # still held by callers. A late response release cannot refill the pool.
        for writer in writers:
            writer.close()
        await asyncio.gather(*(self.discard(writer) for writer in writers))
