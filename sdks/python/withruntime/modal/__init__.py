"""Modal CPU sandbox subset pinned to modal 1.6.0.

Uses Runtime credentials. Image recipes preserve the requested registry base.
The server enforces Runtime's actual resource limits; no GPU is substituted.
"""
from __future__ import annotations
import json
import math
import threading
import codecs
import time
from .. import Runtime
from .._compat import CompatibilityError, ENV_PATH, environment, positive, reject
from ._dual import Dual, install, local
from ._object import CONSOLE
from .app import App
from .cloud_bucket_mount import CloudBucketMount
from .exception import ClientClosed, Error, InvalidError, TimeoutError as _ProbeTimeout
from .file_pattern_matcher import FilePatternMatcher
from .image import Image
from .proxy import Proxy
from .secret import Secret
from .snapshot import SandboxSnapshot
from .volume import Volume
from ._probe import Probe, from_label as _probe_from_label
from ._tunnel import Tunnel, from_preview as _tunnel_from_preview

UPSTREAM_VERSION = "1.6.0"

__all__ = ["App", "CloudBucketMount", "ContainerProcess", "Error", "FilePatternMatcher", "Image", "Probe", "Proxy",
           "Sandbox", "SandboxSnapshot", "Secret", "Tunnel", "Volume"]


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
                        # modal 1.6.0's exec wait/poll return -1 and end stdio
                        # on an execution deadline, rather than raising.
                        self.returncode = -1 if event.get("timedOut") else event.get("exitCode")
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



class _NoStream:
    """A commandless sandbox's stdout and stderr: already at their end."""

    def __init__(self, text=True):
        self._text = text

    def read(self):
        return "" if self._text else b""

    def __iter__(self):
        return iter(())

    def __aiter__(self):
        return self._none()

    async def _none(self):
        return
        yield


_NoStream.read = Dual(_NoStream.read, local(_NoStream.read))


class _NoStdin:
    def write(self, data):
        raise InvalidError("This sandbox was created without a command: its stdin reaches no process")

    def write_eof(self):
        raise InvalidError("This sandbox was created without a command: its stdin reaches no process")

    def drain(self):
        raise InvalidError("This sandbox was created without a command: its stdin reaches no process")


_NoStdin.drain = Dual(_NoStdin.drain, _NoStdin.drain)


# Each refused create option, and what to use on Runtime instead.
_REFUSED = {
    "network_file_systems": "Runtime has no network file systems: mount a Volume or a CloudBucketMount",
    "idle_timeout": "Runtime pauses idle sandboxes by itself; set the native idle_pause_seconds",
    "cloud": "Runtime runs on its own servers; there is no cloud to choose",
    "region": "Runtime places sandboxes itself; the native create takes Runtime's region names",
    "h2_ports": "Runtime previews are HTTPS: list the port in encrypted_ports",
    "unencrypted_ports": "Runtime previews are HTTPS: list the port in encrypted_ports",
    "custom_domain": "Runtime previews are HTTPS on Runtime's preview domain: list the port in encrypted_ports",
    "proxy": "Runtime dedicated egress IPs: runtime.ips gives sandboxes a fixed outbound address",
    "include_oidc_identity_token": "Runtime identity tokens are the native SDK's: see withruntime.com/docs/identity-tokens",
    "verbose": "Runtime streams no create logs: read sandbox.stdout and sandbox.stderr",
    "experimental_options": "Runtime takes no experimental create options",
    "_experimental_enable_snapshot": "Runtime sandboxes need no flag to be snapshotted: snapshot_filesystem()",
    "_experimental_outbound_policy": "Set network rules with outbound_domain_allowlist or block_network",
    "inbound_cidr_allowlist": "Runtime previews take a token, not an address list: the native previews.create(port)",
    "outbound_cidr_allowlist": "Runtime network rules name domains: use outbound_domain_allowlist",
    "cidr_allowlist": "Runtime network rules name domains: use outbound_domain_allowlist",
    "pty_info": "Runtime takes pty=True with a 24x80 terminal",
    "environment_name": "Modal environment namespaces are not Runtime account namespaces",
}


def _refusal(options):
    for name, alternative in _REFUSED.items():
        value = options.get(name)
        if value is not None and value is not False and value != [] and value != {} and value != ():
            return CompatibilityError(f"Modal Sandbox.create({name}=...) cannot keep its meaning on Runtime: {alternative}")
    return None


def _check_runtime(value):
    if value == "gvisor":
        raise CompatibilityError("Runtime sandboxes are Firecracker VMs: pass runtime='vm' or leave it out")
    if value not in (None, "vm"):
        raise InvalidError(f"Invalid sandbox runtime {value!r}; expected 'gvisor' or 'vm'")


def _ports(values):
    ports = list(values or [])
    if any(isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535 for port in ports):
        raise InvalidError("encrypted_ports must be ports from 1 to 65535")
    return ports


def _mounts(volumes):
    """Volumes and buckets by absolute path, checked before any request."""
    disks, buckets = {}, {}
    for path, value in (volumes or {}).items():
        path = str(path)
        if not path.startswith("/"):
            raise InvalidError(f"Volume mount path {path!r} must be absolute")
        if isinstance(value, Volume):
            disks[path] = value
        elif isinstance(value, CloudBucketMount):
            buckets[path] = value
        else:
            raise InvalidError("volumes takes withruntime.modal.Volume and CloudBucketMount values")
    return disks, buckets


def _plan(args, options):
    """Everything Sandbox.create checks before its first request."""
    refused = _refusal(options)
    if refused:
        raise refused
    if options["gpu"] is not None:
        raise CompatibilityError("Modal GPU sandboxes need GPU compute; Runtime CPU cannot substitute")
    cpu, memory = options["cpu"], options["memory"]
    if isinstance(cpu, tuple) or isinstance(memory, tuple):
        raise CompatibilityError("Separate minimum and maximum resource reservations are not yet supported")
    _check_runtime(options["runtime"])
    if any(not isinstance(arg, str) for arg in args):
        raise InvalidError("All entrypoint arguments must be strings")
    timeout = options["timeout"]
    lifetime = None if timeout is None else positive(timeout, "timeout", integral=True)
    fields = {}
    if cpu is not None:
        fields["vcpu"] = positive(cpu, "cpu", integral=True)
    if memory is not None:
        fields["memory_mib"] = positive(memory, "memory", integral=True)
    image = options["image"]
    if image is not None and not isinstance(image, Image):
        raise TypeError("Use withruntime.modal.Image so its recipe can be built on Runtime")
    probe = options["readiness_probe"]
    if probe is not None and not isinstance(probe, Probe):
        raise InvalidError("readiness_probe must be a modal.Probe")
    variables = {}
    for secret in options["secrets"] or []:
        variables.update(secret._values)
    variables.update({key: value for key, value in (options["env"] or {}).items() if value is not None})
    environment(json.dumps(variables).encode())
    disks, buckets = _mounts(options["volumes"])
    ports = _ports(options["encrypted_ports"])
    app, name, tags = options["app"], options["name"], options["tags"]
    labels = {"modal.tags": json.dumps(tags or {}), "compat.provider": "modal",
              "modal.app": app.name or "" if app else "", "modal.name": name or ""}
    if probe is not None:
        labels["modal.probe"] = probe._label()
    if ports:
        labels["modal.ports"] = json.dumps(ports)
    # Never wider than Modal's: an empty list blocks all egress, which the
    # native rules would read as the public web; "*" allows everything.
    allow = options["outbound_domain_allowlist"]
    if options["block_network"] and allow is not None:
        raise InvalidError("block_network cannot be combined with outbound_domain_allowlist")
    if options["block_network"] or allow is not None and not list(allow):
        network = {"internet": False}
    elif allow is None or "*" in allow:
        network = {"internet": True}
    else:
        network = {"internet": True, "allow": list(allow)}
    write_env = (image is None or not image._snapshot_id or options["env"] is not None
                 or options["secrets"] is not None)
    return {"image": image or Image.debian_slim(), "variables": variables, "lifetime": lifetime, "fields": fields,
            "disks": disks, "buckets": buckets, "ports": ports, "labels": labels, "network": network,
            "write_env": write_env, "probe": probe, "pty": options["pty"]}


def _native_create(plan, source, name):
    disks = [disk._mount(path) for path, disk in plan["disks"].items()]
    return {"name": name, **source, **_limit(plan["lifetime"]), "on_lease_end": "stop", "labels": plan["labels"],
            "network": plan["network"], **plan["fields"], **({"volumes": disks} if disks else {})}


def _limit(lifetime):
    """A timeout is the customer's limit, and the sandbox never pauses for
    idleness before it. None is no time limit (0300): it runs while it works
    and pauses when idle."""
    return {} if lifetime is None else {"timeout_seconds": lifetime, "idle_pause_seconds": 0}


def _entrypoint_ms(lifetime):
    """The entrypoint runs as long as the sandbox may: its timeout, or with
    none the longest a process runs, a day."""
    return 86_400_000 if lifetime is None else lifetime * 1000


def _buffering(text, bufsize):
    if bufsize not in (-1, 1) or (bufsize == 1 and not text):
        raise ValueError("bufsize must be -1 or 1; line buffering requires text=True")


def _ready_timeout(timeout):
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise InvalidError(f"`timeout` must be positive, got: {timeout}")
    return timeout


CONNECT_TOKEN = ("Share the port as a private preview instead: the native sandbox's previews.create(port) "
                 "returns a url and a token, sent as the x-runtime-preview-token header")
SNAPSHOT_DIRECTORY = "Runtime snapshots a whole disk: snapshot_filesystem(), then start a new sandbox from it"
DETACHED = "Unable to perform operation on a detached sandbox"


class Sandbox:
    def __init__(self, runtime, sb, entrypoint=None):
        self._runtime, self._sandbox, self._entrypoint = runtime, sb, entrypoint
        self._tunnels, self._terminated, self._detached = None, False, False
        self._readiness, self._read_only_disks = None, False

    @property
    def object_id(self):
        return self._sandbox.id

    @property
    def client(self):
        return self._runtime

    def _attached(self):
        if self._detached:
            raise ClientClosed(DETACHED)
        return self._sandbox

    def _labels(self):
        info = getattr(self._sandbox, "info", None) or {}
        return info.get("labels") or {}

    @staticmethod
    def create(*args, app=None, name=None, tags=None, image=None, env=None, secrets=None, network_file_systems={},
               timeout=None, idle_timeout=None, workdir=None, gpu=None, cloud=None, region=None, cpu=None, memory=None,
               runtime=None, block_network=False, outbound_cidr_allowlist=None, outbound_domain_allowlist=None,
               _experimental_outbound_policy=None, inbound_cidr_allowlist=None, volumes={}, pty=False,
               encrypted_ports=[], h2_ports=[], unencrypted_ports=[], custom_domain=None, proxy=None,
               include_oidc_identity_token=False, readiness_probe=None, verbose=False, experimental_options=None,
               _experimental_enable_snapshot=False, client=None, environment_name=None, pty_info=None,
               cidr_allowlist=None):
        options = dict(locals())
        options.pop("args")
        if any((network_file_systems, idle_timeout is not None, cloud is not None, region is not None, h2_ports,
                unencrypted_ports, custom_domain is not None, proxy is not None, include_oidc_identity_token, verbose,
                experimental_options, _experimental_enable_snapshot, _experimental_outbound_policy is not None,
                inbound_cidr_allowlist is not None, outbound_cidr_allowlist is not None, cidr_allowlist is not None,
                pty_info is not None, environment_name is not None)):
            raise _refusal(options)
        return _create(args, options)

    @staticmethod
    def from_id(sandbox_id, client=None):
        runtime = client or Runtime()
        sb = runtime.sandboxes.get(sandbox_id)
        entrypoint = sb.info.get("labels", {}).get("modal.entrypoint")
        entry = ContainerProcess(sb.process(entrypoint), on_exit=sb.stop) if entrypoint else None
        return Sandbox(runtime, sb, entry)

    @staticmethod
    def from_name(app_name, name, *, environment_name=None, client=None):
        from .exception import NotFoundError, ConflictError
        if environment_name is not None:
            raise CompatibilityError("Modal environment namespaces are not Runtime account namespaces")
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

    def hydrate(self, client=None):
        return self

    def get_dashboard_url(self):
        return f"{CONSOLE}/sandboxes/{self._sandbox.id}"

    def detach(self):
        self._detached = True

    def get_tags(self):
        from ._lookup import tags
        return tags(self._attached().refresh().info)

    def set_tags(self, tags, *, client=None):
        from ._lookup import validate_tags
        values = validate_tags(tags)
        current = self._attached().refresh().info.get("labels", {})
        labels = {k: v for k, v in current.items() if k.startswith("modal.") or k == "compat.provider"}
        self._sandbox.update(labels={**labels, "modal.tags": json.dumps(values)})

    @property
    def filesystem(self):
        from .sandbox_fs import SandboxFilesystem
        self._attached()
        return SandboxFilesystem(self)

    @property
    def stdout(self):
        self._attached()
        return self._entrypoint.stdout if self._entrypoint else _NoStream()

    @property
    def stderr(self):
        self._attached()
        return self._entrypoint.stderr if self._entrypoint else _NoStream()

    @property
    def stdin(self):
        self._attached()
        return self._entrypoint.stdin if self._entrypoint else _NoStdin()

    @property
    def logs(self):
        raise CompatibilityError("Read the sandbox's output from sandbox.stdout and sandbox.stderr")

    def exec(self, *args, timeout=None, workdir=None, env=None, secrets=None, text=True, bufsize=-1, pty=False, **options):
        reject(options, "Modal Sandbox.exec")
        _buffering(text, bufsize)
        sb = self._attached()
        variables = environment(sb.files.read(ENV_PATH))
        for secret in secrets or []:
            variables.update(secret._values)
        variables.update({key: value for key, value in (env or {}).items() if value is not None})
        process = sb.spawn(list(args), cwd=workdir, env=variables, stdin="pipe",
            timeout_ms=None if timeout is None else int(positive(timeout, "timeout") * 1000),
            pty={"rows": 24, "cols": 80} if pty else None, **({"output_encoding": "base64"} if not text else {}))
        return ContainerProcess(process, text=text, bufsize=bufsize, binary_transport=not text)

    def terminate(self, *, wait=False):
        self._attached().stop()
        self._terminated = True
        return self.returncode if wait else None

    def wait(self, raise_on_termination=True):
        if not self._entrypoint:
            raise CompatibilityError("Waiting on a reconnected or commandless Modal sandbox is not yet implemented")
        self._entrypoint.wait()
        self._sandbox.stop()

    @property
    def returncode(self):
        code = self._entrypoint.returncode if self._entrypoint else None
        return 137 if code is None and self._terminated else code

    def poll(self):
        return self.returncode

    def _probe(self):
        if self._readiness is None and "modal.probe" in self._labels():
            self._readiness = _probe_from_label(self._labels()["modal.probe"])
        if self._readiness is None:
            raise InvalidError("Sandbox.wait_until_ready() needs a sandbox created with readiness_probe=modal.Probe")
        return self._readiness

    def wait_until_ready(self, *, timeout=300):
        deadline = time.monotonic() + _ready_timeout(timeout)
        probe, sb = self._probe(), self._attached()
        while True:
            left = deadline - time.monotonic()
            result = sb.exec(probe._command(), timeout_ms=max(1, math.ceil(min(left, 10) * 1000)))
            if result.exit_code == 0:
                return
            if time.monotonic() + probe.interval_ms / 1000 >= deadline:
                raise _ProbeTimeout(f"Sandbox was not ready within {timeout} seconds")
            time.sleep(probe.interval_ms / 1000)

    def _ports(self):
        return json.loads(self._labels().get("modal.ports", "[]"))

    def tunnels(self, timeout=50):
        sb = self._attached()
        if self._tunnels is None:
            ports = self._ports()
            shared = sb.previews.list() if ports else []
            self._tunnels = {item["port"]: _tunnel_from_preview(item) for item in shared
                             if item["port"] in ports and item.get("visibility") == "public"}
        return self._tunnels

    def create_connect_token(self, user_metadata=None, port=8080):
        raise CompatibilityError(CONNECT_TOKEN)

    def _check_reload(self, timeout):
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise InvalidError("The `timeout` argument to `reload_volumes` must be positive.")
        mounted = getattr(self._sandbox, "info", None) or {}
        if self._read_only_disks or any(disk.get("mode") == "snapshot" for disk in mounted.get("volumes") or []):
            raise CompatibilityError("A read-only Runtime volume is a copy taken at mount and cannot reload: "
                                     "mount it writable, or start a new sandbox for a fresh copy")

    def reload_volumes(self, *, timeout=55):
        # A writable Runtime volume is a live disk with one writer: every
        # write is visible at once, so there is nothing to reload.
        self._attached()
        self._check_reload(timeout)

    def snapshot_directory(self, path, *, timeout=55, ttl=30 * 24 * 3600, _experimental_encryption_key=None):
        raise CompatibilityError(SNAPSHOT_DIRECTORY)

    def mount_image(self, path, image, *, _experimental_encryption_key=None):
        raise CompatibilityError(SNAPSHOT_DIRECTORY)

    def unmount_image(self, path):
        raise CompatibilityError(SNAPSHOT_DIRECTORY)

    def snapshot_filesystem(self, timeout=55, *, ttl=30 * 24 * 3600):
        from .._request_scope import request_scope
        from ._snapshot import plan, translate, checked
        options = plan(timeout, ttl)
        try:
            with request_scope(timeout):
                snapshot = self._attached().snapshot(**options)
        except Exception as error:
            raise translate(error) from error
        return Image(None, snapshot_id=checked(snapshot)['id'])

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.terminate()


def _create(args, options):
    plan = _plan(args, options)
    runtime = options["client"] or Runtime()
    source = plan["image"]._source(runtime)
    for disk in plan["disks"].values():
        disk._load(runtime)
    sb = runtime.sandboxes.create(**_native_create(plan, source, options["name"]))
    try:
        if plan["write_env"]:
            sb.files.write(ENV_PATH, json.dumps(plan["variables"]), mode=0o600)
        for path, bucket in plan["buckets"].items():
            sb.mounts.add(**bucket._mount(path))
        for port in plan["ports"]:
            sb.previews.create(port, visibility="public")
        entry = None
        if args:
            process = sb.spawn(list(args), cwd=options["workdir"], env=plan["variables"], stdin="pipe",
                               timeout_ms=_entrypoint_ms(plan["lifetime"]),
                               **({"pty": {"rows": 24, "cols": 80}} if plan["pty"] else {}))
            sb.update(labels={**sb.info.get("labels", {}), "modal.entrypoint": process.id})
            entry = ContainerProcess(process, on_exit=sb.stop)
    except BaseException as original:
        try:
            sb.stop()
        except BaseException as cleanup:
            raise original from cleanup
        raise
    box = Sandbox(runtime, sb, entry)
    box._readiness, box._read_only_disks = plan["probe"], any(disk._read_only for disk in plan["disks"].values())
    return box


install(Sandbox, ("hydrate", "get_dashboard_url", "detach"))
install(Sandbox, ("create_connect_token", "snapshot_directory", "mount_image", "unmount_image"), refused=True)

from ._async import install as _install_async  # noqa: E402
_install_async()
del _install_async
