"""Native asyncio Modal CPU sandboxes, exposed through each method's `.aio`."""
from __future__ import annotations
import asyncio
import codecs
import json
from .. import AsyncRuntime
from .._compat import CompatibilityError, ENV_PATH, environment, positive, reject
from ._dual import Dual, async_only
from . import Sandbox, Image, App, _Writer, _create_plan, _entrypoint_ms, _limit


class _AsyncReader:
    def __init__(self, process, channel, text, bufsize=-1):
        self._process, self._channel, self._text, self._cursor = process, channel, text, 0
        self._bufsize, self._eof = bufsize, False
        self._decoder = codecs.getincrementaldecoder("utf-8")() if text else None

    async def _read(self):
        return ("" if self._text else b"").join([chunk async for chunk in self])

    read = Dual(async_only, _read)

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        while not self._eof:
            async with self._process._condition:
                output = self._process._output[self._channel]
                boundary = output.find(b"\n", self._cursor) if self._bufsize == 1 else len(output) - 1
                if boundary >= self._cursor:
                    chunk = output[self._cursor:boundary + 1]
                    self._cursor = boundary + 1
                elif self._process._done:
                    chunk = output[self._cursor:]
                    self._cursor = len(output)
                    self._eof = True
                    if self._process._error:
                        raise self._process._error
                else:
                    await self._process._condition.wait()
                    continue
            value = self._decoder.decode(chunk, final=self._eof) if self._decoder else chunk
            if value:
                yield value


class _AsyncWriter(_Writer):
    def __init__(self, process):
        super().__init__(process)
        self._lock, self._eof, self._eof_sent = asyncio.Lock(), False, False

    async def _drain(self):
        async with self._lock:
            while self._pending:
                data = self._pending[0]
                if not data:
                    self._pending.pop(0)
                    continue
                chunk = data[:1048576]
                final = self._eof and len(self._pending) == 1 and len(data) <= 1048576
                await self._process.write(chunk, eof=final)
                # write() may append while the transport is suspended. Consume
                # only the acknowledged head, never clear newer queued writes.
                if len(data) <= 1048576:
                    self._pending.pop(0)
                else:
                    self._pending[0] = data[len(chunk):]
                if final:
                    self._eof_sent = True
            if self._eof and not self._eof_sent:
                try:
                    await self._process.write(b"", eof=True)
                except Exception as error:
                    if getattr(error, "code", None) != "stdin_closed":
                        raise
                self._eof_sent = True

    drain = Dual(async_only, _drain)

    def write_eof(self):
        self._eof, self._closed = True, True


class AsyncContainerProcess:
    def __init__(self, process, text=True, on_exit=None, bufsize=-1, binary_transport=False):
        self._process, self._on_exit = process, on_exit
        self._condition = asyncio.Condition()
        self._output = {"stdout": b"", "stderr": b""}
        self._binary_transport = binary_transport
        self._done, self._error, self.returncode = False, None, None
        self.stdout, self.stderr = _AsyncReader(self, "stdout", text, bufsize), _AsyncReader(self, "stderr", text, bufsize)
        self.stdin = _AsyncWriter(process)
        self._task = asyncio.create_task(self._pump())

    async def _pump(self):
        exited = False
        try:
            async for event in (self._process.output_bytes() if self._binary_transport else self._process.output()):
                async with self._condition:
                    if event["type"] in self._output:
                        self._output[event["type"]] += event["data"] if self._binary_transport else event["data"].encode()
                    elif event["type"] == "truncated":
                        raise IOError("Process output was truncated")
                    elif event["type"] == "exit":
                        exited = True
                        # Match the pinned SDK's deadline sentinel and stdio EOF.
                        self.returncode = -1 if event.get("timedOut") else event.get("exitCode")
                    self._condition.notify_all()
            if not exited:
                raise IOError("Process output ended before an exit status")
        except BaseException as error:
            self._error = error
        finally:
            if exited and self._on_exit:
                try:
                    await self._on_exit()
                except BaseException as error:
                    self._error = self._error or error
            async with self._condition:
                self._done = True
                self._condition.notify_all()

    async def _wait(self):
        try:
            await asyncio.shield(self._task)
        except asyncio.CancelledError:
            await self._process.kill("SIGKILL")
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            raise
        if self._error:
            raise self._error
        return self.returncode

    wait = Dual(async_only, _wait)

    async def _poll(self):
        return self.returncode

    poll = Dual(async_only, _poll)

    async def _kill(self):
        await self._process.kill("SIGKILL")

    kill = Dual(async_only, _kill)


async def create(*args, app=None, name=None, tags=None, image=None, env=None, secrets=None,
                 timeout=None, workdir=None, gpu=None, cpu=None, memory=None, block_network=False,
                 outbound_domain_allowlist=None, client=None, **options):
    image, variables, lifetime, fields = _create_plan(image, env, secrets, timeout, gpu, cpu, memory, options)
    runtime = client or AsyncRuntime()
    source = {"snapshot": image._snapshot_id} if image._snapshot_id else {
        "image": (await runtime.images.build(dockerfile=image._dockerfile))["id"]}
    sb = await runtime.sandboxes.create(name=name, **source, **_limit(lifetime), on_lease_end="stop", labels={"modal.tags": json.dumps(tags or {}), "compat.provider": "modal",
        "modal.app": app.name or "" if app else "", "modal.name": name or ""},
        network={"internet": not block_network, **({"allow": list(outbound_domain_allowlist)} if outbound_domain_allowlist is not None else {})}, **fields)
    try:
        if not image._snapshot_id or env is not None or secrets is not None:
            await sb.files.write(ENV_PATH, json.dumps(variables), mode=0o600)
        entry = None
        if args:
            process = await sb.spawn(list(args), cwd=workdir, env=variables, stdin="pipe", timeout_ms=_entrypoint_ms(lifetime))
            await sb.update(labels={**sb.info.get("labels", {}), "modal.entrypoint": process.id})
            entry = AsyncContainerProcess(process, on_exit=sb.stop)
    except BaseException as original:
        try:
            await sb.stop()
        except BaseException as cleanup:
            raise original from cleanup
        raise
    box = Sandbox(runtime, sb, entry)
    box._async_mode = True
    return box


async def from_id(sandbox_id, client=None):
    runtime = client or AsyncRuntime()
    sb = await runtime.sandboxes.get(sandbox_id)
    entrypoint = sb.info.get("labels", {}).get("modal.entrypoint")
    entry = AsyncContainerProcess(await sb.process(entrypoint), on_exit=sb.stop) if entrypoint else None
    box = Sandbox(runtime, sb, entry)
    box._async_mode = True
    return box


def _native_async(box):
    if getattr(box, "_async_mode", False):
        return box._sandbox
    # Sync handles support `.aio` without routing I/O through executor threads.
    from .._async_client import AsyncSandbox
    transport = box._runtime._t
    if not hasattr(box, "_async_runtime"):
        box._async_runtime = AsyncRuntime(api_key=transport._api_key(), base_url=transport.base_url)
    return AsyncSandbox(box._async_runtime._t, dict(box._sandbox.info))


async def execute(self, *args, timeout=None, workdir=None, env=None, secrets=None, text=True, bufsize=-1, pty=False, **options):
    reject(options, "Modal Sandbox.exec")
    if bufsize not in (-1, 1) or (bufsize == 1 and not text):
        raise ValueError("bufsize must be -1 or 1; line buffering requires text=True")
    sb = _native_async(self)
    variables = environment(await sb.files.read(ENV_PATH))
    for secret in secrets or []:
        variables.update(secret._values)
    variables.update(env or {})
    process = await sb.spawn(list(args), cwd=workdir, env=variables, stdin="pipe",
        timeout_ms=None if timeout is None else int(positive(timeout, "timeout") * 1000),
        pty={"rows": 24, "cols": 80} if pty else None, **({"output_encoding": "base64"} if not text else {}))
    return AsyncContainerProcess(process, text=text, bufsize=bufsize, binary_transport=not text)


async def terminate(self):
    await _native_async(self).stop()


async def wait(self, raise_on_termination=True):
    if not self._entrypoint:
        raise CompatibilityError("Waiting on a commandless Modal sandbox is not yet implemented")
    if not isinstance(self._entrypoint, AsyncContainerProcess):
        sb = _native_async(self)
        self._entrypoint = AsyncContainerProcess(await sb.process(self._entrypoint._process.id), on_exit=sb.stop)
    await self._entrypoint.wait.aio()


async def poll(self):
    return self.returncode


async def snapshot_filesystem(self, timeout=55, *, ttl=30 * 24 * 3600):
    from .._request_scope import request_scope
    from ._snapshot import plan, translate, checked
    options = plan(timeout, ttl)
    try:
        with request_scope(timeout):
            snapshot = await _native_async(self).snapshot(**options)
    except Exception as error:
        raise translate(error) from error
    return Image(None, snapshot_id=checked(snapshot)['id'])


async def enter(self):
    return self


async def exit(self, *args):
    await terminate(self)


async def lookup(name, *, create_if_missing=False, **options):
    reject(options, "Modal App.lookup")
    return App(name)


async def from_name(app_name, name, *, environment_name=None, client=None):
    from ._lookup import validate_environment
    from .exception import NotFoundError, ConflictError
    validate_environment(environment_name)
    runtime = client or AsyncRuntime()
    found = [sb async for sb in await runtime.sandboxes.list(state=["running"], labels={"compat.provider": "modal", "modal.app": app_name, "modal.name": name})]
    if not found:
        raise NotFoundError(f"No running sandbox named {name!r} in app {app_name!r}")
    if len(found) > 1:
        raise ConflictError(f"Multiple running sandboxes named {name!r} in app {app_name!r}")
    return await from_id(found[0].id, client=runtime)


async def list_sandboxes(*, app_id=None, tags=None, client=None):
    from ._lookup import tags as read_tags
    runtime = client or AsyncRuntime()
    labels = {"compat.provider": "modal"}
    if app_id is not None:
        labels["modal.app"] = app_id
    async for sb in await runtime.sandboxes.list(state=["running"], labels=labels):
        if all(read_tags(sb.info).get(k) == v for k, v in (tags or {}).items()):
            yield await from_id(sb.id, client=runtime)


async def get_tags(self):
    from ._lookup import tags
    return tags((await _native_async(self).refresh()).info)


async def set_tags(self, tags, *, client=None):
    from ._lookup import validate_tags
    values = validate_tags(tags)
    sb = _native_async(self)
    current = (await sb.refresh()).info.get("labels", {})
    labels = {k: v for k, v in current.items() if k.startswith("modal.") or k == "compat.provider"}
    await sb.update(labels={**labels, "modal.tags": json.dumps(values)})


def install():
    Sandbox.create = Dual(Sandbox.create, create, static=True)
    Sandbox.from_id = Dual(Sandbox.from_id, from_id, static=True)
    Sandbox.from_name = Dual(Sandbox.from_name, from_name, static=True)
    Sandbox.list = Dual(Sandbox.list, list_sandboxes, static=True)
    for name, asynchronous in (("exec", execute), ("terminate", terminate), ("wait", wait),
                               ("poll", poll), ("snapshot_filesystem", snapshot_filesystem),
                               ("get_tags", get_tags), ("set_tags", set_tags)):
        setattr(Sandbox, name, Dual(getattr(Sandbox, name), asynchronous))
    Sandbox.__aenter__, Sandbox.__aexit__ = enter, exit
    App.lookup = Dual(App.lookup, lookup, static=True)
