"""Modal CPU sandbox subset pinned to modal 1.6.0.

Uses Runtime credentials. Image recipes preserve the requested registry base.
The server enforces Runtime's actual resource limits; no GPU is substituted.
"""
from __future__ import annotations
import json
import shlex
import re
import threading
import codecs
from dataclasses import dataclass
from .. import Runtime
from .._compat import CompatibilityError, Model, ENV_PATH, dockerfile, environment, positive, reject
from .._errors import RuntimeError as SDKError

UPSTREAM_VERSION = "1.6.0"


class Image:
    def __init__(self, source, snapshot_id=None):
        self._dockerfile = source
        self._snapshot_id = snapshot_id

    @property
    def object_id(self):
        if self._snapshot_id is None:
            raise AttributeError("Attempting to get object_id of unhydrated Image")
        return self._snapshot_id

    @staticmethod
    def from_registry(tag, *, add_python=None, **options):
        reject(options, "Modal Image.from_registry")
        if add_python is not None:
            raise CompatibilityError("Installing a specific Python into arbitrary images is not yet supported")
        return Image(dockerfile(tag))

    @staticmethod
    def debian_slim(python_version=None, force_build=False):
        if force_build:
            raise CompatibilityError("Forced image cache invalidation is not yet supported")
        version = python_version or "3.12"
        return Image.from_registry(f"python:{version}-slim-bookworm")

    def _append(self, text):
        if self._snapshot_id:
            raise CompatibilityError("An image from a filesystem snapshot cannot yet be extended")
        return Image(self._dockerfile + text + "\n")

    def pip_install(self, *packages, **options):
        reject(options, "Modal Image.pip_install")
        packages = [part for value in packages for part in (value if isinstance(value, list) else [value])]
        return self._append("RUN python -m pip install -- " + shlex.join(packages)) if packages else self

    def apt_install(self, *packages, **options):
        reject(options, "Modal Image.apt_install")
        packages = [part for value in packages for part in (value if isinstance(value, list) else [value])]
        return self._append("RUN apt-get update && apt-get install -y -- " + shlex.join(packages)) if packages else self

    def run_commands(self, *commands, **options):
        reject(options, "Modal Image.run_commands")
        flat = [part for value in commands for part in (value if isinstance(value, list) else [value])]
        return self._append("\n".join("RUN " + line for line in flat))

    def env(self, variables):
        if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) or not isinstance(v, str) or "\n" in v or "\r" in v for k, v in variables.items()):
            raise ValueError("Image environment needs valid names and single-line string values")
        return self._append("\n".join(f"ENV {key}={json.dumps(value)}" for key, value in variables.items()))

    def workdir(self, path):
        if "\n" in path or "\r" in path:
            raise ValueError("workdir must be one path")
        return self._append("WORKDIR " + path)


@dataclass
class Secret:
    _values: dict[str, str]

    @staticmethod
    def from_dict(env_dict, required_keys=None):
        for key in required_keys or []:
            if key not in env_dict:
                raise ValueError(f"Required secret {key} is missing")
        return Secret(dict(env_dict))


class App:
    def __init__(self, name=None):
        self.name = name
        self.app_id = name

    @staticmethod
    def lookup(name, *, create_if_missing=False, **options):
        reject(options, "Modal App.lookup")
        return App(name)


class _Reader:
    def __init__(self, process, channel, text, bufsize=-1):
        self._process, self._channel, self._text, self._cursor = process, channel, text, 0
        self._bufsize, self._eof = bufsize, False
        self._decoder = codecs.getincrementaldecoder("utf-8")() if text else None

    def read(self):
        return ("" if self._text else b"").join(self)

    def __iter__(self):
        while not self._eof:
            with self._process._condition:
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
                    self._process._condition.wait()
                    continue
            value = self._decoder.decode(chunk, final=self._eof) if self._decoder else chunk
            if value:
                yield value


class _Writer:
    def __init__(self, process):
        self._process = process
        self._pending = []
        self._closed = False

    def write(self, data):
        if self._closed:
            raise ValueError("stdin is closed")
        self._pending.append(data.encode() if isinstance(data, str) else data)

    def drain(self):
        if self._pending:
            data = b"".join(self._pending)
            self._pending = [data]
            while self._pending[0]:
                chunk = self._pending[0][:1048576]
                self._process.write(chunk)
                self._pending[0] = self._pending[0][len(chunk):]
            self._pending.clear()

    def write_eof(self):
        data = b"".join(self._pending)
        self._pending = [data]
        while len(self._pending[0]) > 1048576:
            self._process.write(self._pending[0][:1048576])
            self._pending[0] = self._pending[0][1048576:]
        try:
            self._process.write(self._pending[0], eof=True)
        except Exception as error:
            if self._pending[0] or getattr(error, "code", None) != "stdin_closed":
                raise
        self._pending.clear()
        self._closed = True


class ContainerProcess:
    def __init__(self, process, text=True, on_exit=None, bufsize=-1, binary_transport=False):
        self._process = process
        self._on_exit = on_exit
        self._condition = threading.Condition()
        self._output = {"stdout": b"", "stderr": b""}
        self._binary_transport = binary_transport
        self._done, self._error, self.returncode = False, None, None
        self.stdout, self.stderr = _Reader(self, "stdout", text, bufsize), _Reader(self, "stderr", text, bufsize)
        self.stdin = _Writer(process)
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def _pump(self):
        exited = False
        try:
            for event in (self._process.output_bytes() if self._binary_transport else self._process.output()):
                with self._condition:
                    if event["type"] in self._output:
                        self._output[event["type"]] += event["data"] if self._binary_transport else event["data"].encode()
                    elif event["type"] == "truncated":
                        raise IOError("Process output was truncated")
                    elif event["type"] == "exit":
                        exited = True
                        if event.get("timedOut"):
                            raise TimeoutError("Modal-compatible command timed out")
                        self.returncode = event.get("exitCode")
                    self._condition.notify_all()
            if not exited:
                raise IOError("Process output ended before an exit status")
        except BaseException as error:
            self._error = error
        finally:
            if exited and self._on_exit:
                try:
                    self._on_exit()
                except BaseException as error:
                    self._error = self._error or error
            with self._condition:
                self._done = True
                self._condition.notify_all()

    def wait(self):
        self._thread.join()
        if self._error:
            raise self._error
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self._process.kill("SIGKILL")


def _create_plan(image, env, secrets, timeout, gpu, cpu, memory, options):
    reject(options, "Modal Sandbox.create")
    if gpu is not None:
        raise CompatibilityError("Modal GPU sandboxes need GPU compute; Runtime CPU cannot substitute")
    if isinstance(cpu, tuple) or isinstance(memory, tuple):
        raise CompatibilityError("Separate minimum and maximum resource reservations are not yet supported")
    lifetime = positive(timeout, "timeout", integral=True)
    fields = {}
    if cpu is not None:
        fields["vcpu"] = positive(cpu, "cpu", integral=True)
    if memory is not None:
        fields["memory_mib"] = positive(memory, "memory", integral=True)
    if image is not None and not isinstance(image, Image):
        raise TypeError("Use withruntime.modal.Image so its recipe can be built on Runtime")
    variables = {}
    for secret in secrets or []:
        variables.update(secret._values)
    variables.update(env or {})
    environment(json.dumps(variables).encode())
    return image or Image.debian_slim(), variables, lifetime, fields


class Sandbox:
    def __init__(self, runtime, sb, entrypoint=None):
        self._runtime, self._sandbox, self.object_id = runtime, sb, sb.id
        self._entrypoint = entrypoint
        if entrypoint:
            self.stdout, self.stderr, self.stdin = entrypoint.stdout, entrypoint.stderr, entrypoint.stdin

    @staticmethod
    def create(*args, app=None, name=None, tags=None, image=None, env=None, secrets=None,
               timeout=300, workdir=None, gpu=None, cpu=None, memory=None, block_network=False,
               outbound_domain_allowlist=None, client=None, **options):
        image, variables, lifetime, fields = _create_plan(image, env, secrets, timeout, gpu, cpu, memory, options)
        runtime = client or Runtime()
        source = {"snapshot": image._snapshot_id} if image._snapshot_id else {"image": runtime.images.build(dockerfile=image._dockerfile)["id"]}
        sb = runtime.sandboxes.create(name=name, **source, timeout_seconds=lifetime,
            idle_pause_seconds=0, on_lease_end="stop", labels={"modal.tags": json.dumps(tags or {}), "compat.provider": "modal", "modal.app": app.name or "" if app else "", "modal.name": name or ""},
            network={"internet": not block_network, **({"allow": list(outbound_domain_allowlist)} if outbound_domain_allowlist is not None else {})}, **fields)
        try:
            if not image._snapshot_id or env is not None or secrets is not None:
                sb.files.write(ENV_PATH, json.dumps(variables), mode=0o600)
            entry = None
            if args:
                process = sb.spawn(list(args), cwd=workdir, env=variables, stdin="pipe", timeout_ms=lifetime * 1000)
                sb.update(labels={**sb.info.get("labels", {}), "modal.entrypoint": process.id})
                entry = ContainerProcess(process, on_exit=sb.stop)
        except BaseException as original:
            try:
                sb.stop()
            except BaseException as cleanup:
                raise original from cleanup
            raise
        return Sandbox(runtime, sb, entry)

    @staticmethod
    def from_id(sandbox_id, client=None):
        runtime = client or Runtime()
        sb = runtime.sandboxes.get(sandbox_id)
        entrypoint = sb.info.get("labels", {}).get("modal.entrypoint")
        entry = ContainerProcess(sb.process(entrypoint), on_exit=sb.stop) if entrypoint else None
        return Sandbox(runtime, sb, entry)

    @staticmethod
    def from_name(app_name, name, *, environment_name=None, client=None):
        from ._lookup import validate_environment
        from .exception import NotFoundError, ConflictError
        validate_environment(environment_name)
        runtime = client or Runtime()
        found = list(runtime.sandboxes.list(state=["running"], labels={"compat.provider": "modal", "modal.app": app_name, "modal.name": name}))
        if not found:
            raise NotFoundError(f"No running sandbox named {name!r} in app {app_name!r}")
        if len(found) > 1:
            raise ConflictError(f"Multiple running sandboxes named {name!r} in app {app_name!r}")
        return Sandbox.from_id(found[0].id, client=runtime)

    @staticmethod
    def list(*, app_id=None, tags=None, client=None):
        from ._lookup import tags as read_tags
        runtime = client or Runtime()
        labels = {"compat.provider": "modal"}
        if app_id is not None:
            labels["modal.app"] = app_id
        for sb in runtime.sandboxes.list(state=["running"], labels=labels):
            if all(read_tags(sb.info).get(k) == v for k, v in (tags or {}).items()):
                yield Sandbox.from_id(sb.id, client=runtime)

    def get_tags(self):
        from ._lookup import tags
        return tags(self._sandbox.refresh().info)

    def set_tags(self, tags, *, client=None):
        from ._lookup import validate_tags
        values = validate_tags(tags)
        current = self._sandbox.refresh().info.get("labels", {})
        labels = {k: v for k, v in current.items() if k.startswith("modal.") or k == "compat.provider"}
        self._sandbox.update(labels={**labels, "modal.tags": json.dumps(values)})

    @property
    def filesystem(self):
        from .sandbox_fs import SandboxFilesystem
        return SandboxFilesystem(self)

    def exec(self, *args, timeout=None, workdir=None, env=None, secrets=None, text=True, bufsize=-1, pty=False, **options):
        reject(options, "Modal Sandbox.exec")
        if bufsize not in (-1, 1) or (bufsize == 1 and not text):
            raise ValueError("bufsize must be -1 or 1; line buffering requires text=True")
        saved = self._sandbox.files.read(ENV_PATH)
        variables = environment(saved)
        for secret in secrets or []:
            variables.update(secret._values)
        variables.update(env or {})
        process = self._sandbox.spawn(list(args), cwd=workdir, env=variables, stdin="pipe",
            timeout_ms=None if timeout is None else int(positive(timeout, "timeout") * 1000),
            pty={"rows": 24, "cols": 80} if pty else None, **({"output_encoding": "base64"} if not text else {}))
        return ContainerProcess(process, text=text, bufsize=bufsize, binary_transport=not text)

    def terminate(self):
        self._sandbox.stop()

    def wait(self, raise_on_termination=True):
        if not self._entrypoint:
            raise CompatibilityError("Waiting on a reconnected or commandless Modal sandbox is not yet implemented")
        self._entrypoint.wait()
        self._sandbox.stop()

    @property
    def returncode(self):
        return self._entrypoint.returncode if self._entrypoint else None

    def poll(self):
        return self.returncode

    def snapshot_filesystem(self, timeout=55, *, ttl=30 * 24 * 3600):
        from .._request_scope import request_scope
        from ._snapshot import plan, translate, checked
        options = plan(timeout, ttl)
        try:
            with request_scope(timeout):
                snapshot = self._sandbox.snapshot(**options)
        except Exception as error:
            raise translate(error) from error
        return Image(None, snapshot_id=checked(snapshot)['id'])

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.terminate()

from ._async import install as _install_async
_install_async()
del _install_async
