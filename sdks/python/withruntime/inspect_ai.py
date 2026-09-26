"""Runtime Cloud as a sandbox for Inspect AI.

``sandbox="runtime"`` runs each sample's tools in its own Runtime Cloud
microVM. It takes what the Docker sandbox takes, a Dockerfile or a
single-service ``compose.yaml``, and builds it with Runtime's images API::

    from inspect_ai import Task, task
    from inspect_ai.dataset import Sample
    from inspect_ai.solver import generate, use_tools
    from inspect_ai.tool import bash

    @task
    def hello():
        return Task(dataset=[Sample(input="Print the kernel version.")],
                    solver=[use_tools(bash()), generate()], sandbox="runtime")

Install with ``pip install "withruntime[inspect-ai]"``; the package registers
``runtime`` with Inspect, so nothing needs importing. The key comes from
RUNTIME_API_KEY or the machine's ``runtime login``, as for ``AsyncRuntime``.

- ``sandbox="runtime"`` alone runs Runtime's base image (Ubuntu with Python,
  Node.js and the usual tools). ``("runtime", "Dockerfile")`` or
  ``("runtime", "compose.yaml")`` builds that image once and reuses it while
  its files are unchanged. ``RuntimeSandboxEnvironmentConfig`` sets the rest.
- Commands run as root unless a user is named, through the sandbox user's
  passwordless ``sudo`` (commands in a Runtime sandbox run as uid 1000).
- Every command streams, so Inspect's 10 MiB output limit applies and nothing
  is cut at 64 KiB, and sandboxes are kept alive past the hour-long lease.
- A compose file with more than one service is refused.
"""
from __future__ import annotations

import contextvars
import hashlib
import logging
import math
import os
import re
import sys
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, Literal, NamedTuple, Optional, Union, overload

try:
    from inspect_ai.util import (
        ComposeConfig,
        ExecResult,
        OutputLimitExceededError,
        SandboxEnvironment,
        SandboxEnvironmentConfigType,
        SandboxEnvironmentLimits,
        is_compose_yaml,
        is_dockerfile,
        parse_compose_yaml,
        sandboxenv,
    )
    from inspect_ai.util._sandbox.environment import SandboxConnection
    from pydantic import BaseModel
except ImportError as error:  # pragma: no cover - depends on the optional extra
    raise ImportError('withruntime.inspect_ai needs Inspect AI: pip install "withruntime[inspect-ai]"') from error

try:
    from inspect_ai.util._sandbox.environment import SandboxUnavailableError
except ImportError:  # pragma: no cover - older Inspect
    SandboxUnavailableError = RuntimeError  # type: ignore[misc,assignment]

from ._async_client import AsyncRuntime, AsyncSandbox
from ._async_products.images import pack_context
from ._errors import NotFoundError
from ._errors import RuntimeError as RuntimeCloudError
from ._eval_sandbox import (FileTooLargeError, MissingSudoError, _Shell, _sizes, dockerfile_workdir, ensure_image,
                            image_name, image_tag)

logger = logging.getLogger("withruntime.inspect_ai")

SANDBOX_TYPE = "runtime"
_STAGING = "/workspace/.runtime-inspect"
_HOME = "/workspace"




# --- Inspect ------------------------------------------------------------------------------

class RuntimeSandboxEnvironmentConfig(BaseModel, frozen=True):
    """How to start a Runtime sandbox for Inspect. Every field is optional.

    Give at most one image source: ``image`` (a container image such as
    ``"python:3.12-slim"``, built once as a Runtime image), ``dockerfile`` (a
    path; its folder is the build context) or ``runtime_image`` (a Runtime
    image by id, name or ``name:tag``, used as it is). None of them: Runtime's
    base image.
    """

    image: Optional[str] = None
    dockerfile: Optional[str] = None
    runtime_image: Optional[str] = None
    funding: Optional[Literal["trial", "paid"]] = None
    region: Optional[str] = None
    vcpu: Optional[int] = None
    memory_mib: Optional[int] = None
    disk_mib: Optional[int] = None
    user: Optional[str] = "root"
    """Who commands and file operations run as when Inspect names no user: root by default."""
    workdir: Optional[str] = None
    """The sample's working directory: relative paths resolve here. /workspace when left out."""
    env: Optional[dict[str, str]] = None
    network: Optional[dict[str, Any]] = None
    """Network rules from the start, as ``sandboxes.create`` takes them: ``{"internet": False}``."""
    labels: Optional[dict[str, str]] = None
    build: Optional[dict[str, Any]] = None
    """Build limits, such as ``{"disk_mib": 16384, "timeout_seconds": 3600}``."""

    def __hash__(self) -> int:
        return hash(self.model_dump_json())


class _Plan(NamedTuple):
    label: str
    source: Optional[dict[str, Any]]
    key: str
    config: RuntimeSandboxEnvironmentConfig


def _memory_mib(value: Any) -> Optional[int]:
    if value is None:
        return None
    match = re.fullmatch(r"\s*([0-9.]+)\s*([kmgt]?)i?b?\s*", str(value).lower())
    if not match:
        return None
    scale = {"": 1 / 1048576, "k": 1 / 1024, "m": 1, "g": 1024, "t": 1024 * 1024}[match.group(2)]
    return max(1, int(float(match.group(1)) * scale))


def _dockerfile_source(path: Path, context: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text()
    packed = pack_context(str(context))
    digest = hashlib.sha256(f"{text}\0{packed['sha256']}".encode()).hexdigest()
    return {"dockerfile": text, "context_dir": str(context)}, f"dockerfile|{digest}"


def _from_config(config: RuntimeSandboxEnvironmentConfig, label: str) -> _Plan:
    sources = [name for name in ("image", "dockerfile", "runtime_image") if getattr(config, name)]
    if len(sources) > 1:
        raise ValueError(f"Give one of image, dockerfile and runtime_image, not {' and '.join(sources)}.")
    if config.dockerfile:
        path = Path(config.dockerfile).resolve()
        source, key = _dockerfile_source(path, path.parent)
        workdir = config.workdir or dockerfile_workdir(path)
        return _Plan(path.parent.name or label, source, key, config.model_copy(update={"workdir": workdir}))
    if config.image:
        return _Plan(config.image.split("/")[-1].split(":")[0], {"image": config.image}, f"image|{config.image}",
                     config)
    return _Plan(label, None, "", config)


def _from_compose(compose: ComposeConfig, where: Optional[Path]) -> _Plan:
    base = where.parent if where is not None else Path.cwd()
    if len(compose.services) != 1:
        names = ", ".join(compose.services)
        raise ValueError(
            f"Runtime runs one machine per sample and cannot run the {len(compose.services)} services "
            f"({names}) in {where or 'this compose configuration'}. Give it one service.")
    name, service = next(iter(compose.services.items()))
    extension = {**(compose.extensions.get("x-runtime") or {}), **(service.extensions.get("x-runtime") or {})}
    fields: dict[str, Any] = {}
    cpus = service.cpus
    limits = service.deploy.resources.limits if service.deploy and service.deploy.resources else None
    if cpus is None and limits is not None and limits.cpus is not None:
        cpus = float(limits.cpus)
    if cpus is not None:
        fields["vcpu"] = max(1, math.ceil(float(cpus)))
    memory = _memory_mib(service.mem_limit or (limits.memory if limits is not None else None))
    if memory is not None:
        fields["memory_mib"] = memory
    if service.working_dir:
        fields["workdir"] = service.working_dir
    if service.user:
        fields["user"] = service.user
    if service.environment:
        if isinstance(service.environment, dict):
            fields["env"] = {k: str(v) for k, v in service.environment.items() if v is not None}
        else:
            fields["env"] = dict(item.split("=", 1) for item in service.environment if "=" in item)
    if service.network_mode == "none":
        fields["network"] = {"internet": False}
    config = RuntimeSandboxEnvironmentConfig(**{**fields, **extension})
    if service.build is not None:
        build = service.build if not isinstance(service.build, str) else None
        context = (base / (service.build if isinstance(service.build, str) else (build.context or "."))).resolve()
        dockerfile = context / (build.dockerfile if build is not None and build.dockerfile else "Dockerfile")
        source, key = _dockerfile_source(dockerfile, context)
        workdir = config.workdir or dockerfile_workdir(dockerfile)
        return _Plan(name, source, key, config.model_copy(update={"workdir": workdir}))
    if service.image:
        return _Plan(name, {"image": service.image}, f"image|{service.image}", config)
    return _Plan(name, None, "", config)


def _plan(config: SandboxEnvironmentConfigType | None) -> _Plan:
    if config is None:
        return _Plan("base", None, "", RuntimeSandboxEnvironmentConfig())
    if isinstance(config, RuntimeSandboxEnvironmentConfig):
        return _from_config(config, "sandbox")
    if isinstance(config, ComposeConfig):
        return _from_compose(config, None)
    if isinstance(config, str) and is_dockerfile(config):
        path = Path(config).resolve()
        return _from_config(RuntimeSandboxEnvironmentConfig(dockerfile=str(path)), path.parent.name)
    if isinstance(config, str) and is_compose_yaml(config):
        return _from_compose(parse_compose_yaml(config, multiple_services=True), Path(config).resolve())
    raise ValueError(f"The runtime sandbox takes a Dockerfile, a compose file, a ComposeConfig or a "
                     f"RuntimeSandboxEnvironmentConfig, not {config!r}.")


async def _image(runtime: AsyncRuntime, plan: _Plan) -> Optional[str]:
    if plan.config.runtime_image:
        return plan.config.runtime_image
    if plan.source is None:
        return None
    tag = image_tag(plan.key)
    return await ensure_image(runtime, image_name("inspect", plan.label), tag, plan.source, rebuild=False,
                              build=plan.config.build, labels={"created_by": "inspect-ai"},
                              on_log=lambda line: logger.debug("build: %s", line.get("text", "")))


def _client() -> AsyncRuntime:
    """A client for one sample or one cleanup; tests replace it."""
    return AsyncRuntime()


_run: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("withruntime_inspect_run", default=None)
_RUNNING: dict[str, str] = {}
"""Sandbox id to the run that started it, until sample_cleanup stops it."""


def _run_id() -> str:
    run = _run.get()
    if run is None:
        run = uuid.uuid4().hex
        _run.set(run)
    return run


def _unavailable(error: RuntimeCloudError) -> bool:
    return error.status in (404, 409, 410) or error.code in ("not_found", "sandbox_stopped", "not_running")


@sandboxenv(name=SANDBOX_TYPE)
class RuntimeSandboxEnvironment(SandboxEnvironment):
    """One Runtime Cloud sandbox for one Inspect sample."""

    def __init__(self, sandbox: AsyncSandbox, shell: _Shell, runtime: AsyncRuntime,
                 config: RuntimeSandboxEnvironmentConfig) -> None:
        super().__init__()
        self.sandbox = sandbox
        self._shell = shell
        self._runtime = runtime
        self._user = config.user
        self._workdir = config.workdir or _HOME
        self._env = dict(config.env or {})

    @classmethod
    def config_files(cls) -> list[str]:
        return ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", "Dockerfile"]

    @classmethod
    def is_docker_compatible(cls) -> bool:
        return True

    @classmethod
    def config_deserialize(cls, config: dict[str, Any]) -> BaseModel:
        return RuntimeSandboxEnvironmentConfig(**config)

    @classmethod
    def default_concurrency(cls) -> Optional[int]:
        # The free trial runs eight sandboxes at once; raise it with --max-sandboxes on a paid account.
        return 8

    @classmethod
    async def task_init(cls, task_name: str, config: SandboxEnvironmentConfigType | None) -> None:
        _run.set(uuid.uuid4().hex)
        plan = _plan(config)
        if plan.source is None:
            return
        async with _client() as runtime:
            await _image(runtime, plan)

    @classmethod
    async def sample_init(cls, task_name: str, config: SandboxEnvironmentConfigType | None,
                          metadata: dict[str, str]) -> dict[str, SandboxEnvironment]:
        plan = _plan(config)
        settings = plan.config
        runtime = _client()
        sandbox: Optional[AsyncSandbox] = None
        try:
            image = await _image(runtime, plan)
            fields: dict[str, Any] = {"idle_pause_seconds": 0, "labels": {
                "created_by": "inspect-ai", "inspect_run": _run_id(), "inspect_task": task_name[:256],
                **(settings.labels or {})}}
            if image is not None:
                fields["image"] = image
            for name in ("funding", "region", "network"):
                if getattr(settings, name) is not None:
                    fields[name] = getattr(settings, name)
            sizes, notes = _sizes(settings.vcpu, settings.memory_mib, settings.disk_mib, settings.funding == "trial")
            for note in notes:
                logger.warning("Runtime: %s.", note)
            fields.update(sizes)
            try:
                sandbox = await runtime.sandboxes.create(**fields)
            except RuntimeCloudError as error:
                if error.code != "invalid_trial" or settings.funding is not None:
                    raise
                sizes, notes = _sizes(settings.vcpu, settings.memory_mib, settings.disk_mib, True)
                logger.warning("Runtime: this account runs on its trial, so %s. Set funding='paid' for the size "
                               "asked.", "; ".join(notes) or "the size was cut")
                sandbox = await runtime.sandboxes.create(**{**fields, **sizes})
            _RUNNING[sandbox.id] = _run_id()
            sandbox.keep_alive()
            shell = _Shell(sandbox, _STAGING)
            await shell.probe()
            shell.target(settings.user)  # Refuses now, not at the first command, when sudo is missing.
            if settings.workdir:
                made = await shell.run(["mkdir", "-p", "--", settings.workdir], user=settings.user, timeout_s=60)
                if made.exit_code != 0:
                    raise RuntimeError(f"Could not make the working directory {settings.workdir}: {made.stderr}")
            return {"default": cls(sandbox, shell, runtime, settings)}
        except BaseException:
            if sandbox is not None:
                await _stop(sandbox)
            await runtime.close()
            raise

    @classmethod
    async def sample_cleanup(cls, task_name: str, config: SandboxEnvironmentConfigType | None,
                             environments: dict[str, SandboxEnvironment], interrupted: bool) -> None:
        for environment in environments.values():
            if isinstance(environment, RuntimeSandboxEnvironment):
                await _stop(environment.sandbox)
                await environment._runtime.close()

    @classmethod
    async def task_cleanup(cls, task_name: str, config: SandboxEnvironmentConfigType | None, cleanup: bool) -> None:
        run = _run.get()
        left = [sandbox_id for sandbox_id, owner in _RUNNING.items() if owner == run]
        if not cleanup:
            for sandbox_id in left:
                print(f"Runtime sandbox {sandbox_id} is still running; stop it with: runtime sandbox stop {sandbox_id}")
            return
        async with _client() as runtime:
            for sandbox_id in left:
                await _stop_id(runtime, sandbox_id)
            if run is not None:
                try:
                    page = await runtime.sandboxes.list(labels={"inspect_run": run})
                    for sandbox in await page.to_list():
                        await _stop(sandbox)
                except RuntimeCloudError as error:
                    logger.warning("Runtime: could not list this run's sandboxes to stop them: %s", error)

    @classmethod
    async def cli_cleanup(cls, id: Optional[str]) -> None:
        async with _client() as runtime:
            if id is not None:
                await _stop_id(runtime, id)
                print(f"Stopped Runtime sandbox {id}.")
                return
            page = await runtime.sandboxes.list(labels={"created_by": "inspect-ai"})
            sandboxes = await page.to_list()
            if not sandboxes:
                print("No Runtime sandboxes started by Inspect are running.")
                return
            for sandbox in sandboxes:
                print(sandbox.id)
            if sys.stdin.isatty() and "CI" not in os.environ:
                if input(f"Stop these {len(sandboxes)} sandboxes? [y/N] ").strip().lower() not in ("y", "yes"):
                    print("Nothing stopped.")
                    return
            for sandbox in sandboxes:
                await _stop(sandbox)
            print(f"Stopped {len(sandboxes)} Runtime sandboxes.")

    # Commands and files.

    def _absolute(self, path: str) -> str:
        return path if path.startswith("/") else str(PurePosixPath(self._workdir) / path)

    async def exec(self, cmd: list[str], input: Union[str, bytes, None] = None, cwd: Optional[str] = None,
                   env: Optional[dict[str, str]] = None, user: Optional[str] = None,
                   timeout: Optional[int] = None, timeout_retry: bool = True,
                   concurrency: bool = True) -> ExecResult[str]:
        data = input.encode() if isinstance(input, str) else input
        attempts: list[Optional[int]] = [timeout]
        if timeout_retry and timeout is not None:
            attempts += [min(timeout, 60), min(timeout, 30)]
        merged = {**self._env, **(env or {})}
        limit = SandboxEnvironmentLimits.MAX_EXEC_OUTPUT_SIZE
        for seconds in attempts:
            try:
                result = await self._shell.run(
                    list(cmd), user=self._user if user is None else user,
                    cwd=self._absolute(cwd) if cwd else self._workdir, env=merged or None, stdin=data,
                    timeout_s=seconds, max_output=limit)
            except RuntimeCloudError as error:
                if _unavailable(error):
                    raise SandboxUnavailableError(f"Runtime sandbox {self.sandbox.id} is not running: {error}") from error
                raise
            if result.timed_out:
                continue
            if result.overflow:
                raise OutputLimitExceededError(limit_str=SandboxEnvironmentLimits.MAX_EXEC_OUTPUT_SIZE_STR,
                                               truncated_output=result.stdout)
            if result.exit_code == 126 and "permission denied" in result.stderr.lower():
                raise PermissionError(f"Permission denied running {cmd[0]}: {result.stderr.strip()}")
            return ExecResult(success=result.exit_code == 0, returncode=result.exit_code, stdout=result.stdout,
                              stderr=result.stderr)
        raise TimeoutError(f"Command timed out after {timeout} seconds")

    async def write_file(self, file: str, contents: Union[str, bytes]) -> None:
        data = contents.encode("utf-8") if isinstance(contents, str) else contents
        await self._shell.write(self._absolute(file), data, user=self._user)

    @overload
    async def read_file(self, file: str, text: Literal[True] = True) -> str: ...

    @overload
    async def read_file(self, file: str, text: Literal[False]) -> bytes: ...

    async def read_file(self, file: str, text: bool = True) -> Union[str, bytes]:
        try:
            data = await self._shell.read(self._absolute(file), user=self._user,
                                          max_bytes=SandboxEnvironmentLimits.MAX_READ_FILE_SIZE)
        except FileTooLargeError as error:
            raise OutputLimitExceededError(limit_str=SandboxEnvironmentLimits.MAX_READ_FILE_SIZE_STR,
                                           truncated_output=None) from error
        return data.decode("utf-8") if text else data

    async def connection(self, *, user: Optional[str] = None) -> SandboxConnection:
        return SandboxConnection(type=SANDBOX_TYPE, command=f"runtime sandbox ssh {self.sandbox.id}",
                                 container=self.sandbox.id)


async def _stop(sandbox: AsyncSandbox) -> None:
    sandbox.stop_keep_alive()
    _RUNNING.pop(sandbox.id, None)
    try:
        await sandbox.stop()
    except NotFoundError:
        pass
    except RuntimeCloudError as error:
        logger.warning("Runtime: could not stop sandbox %s: %s", sandbox.id, error)


async def _stop_id(runtime: AsyncRuntime, sandbox_id: str) -> None:
    try:
        await _stop(await runtime.sandboxes.get(sandbox_id))
    except NotFoundError:
        _RUNNING.pop(sandbox_id, None)


__all__ = ["MissingSudoError", "RuntimeSandboxEnvironment", "RuntimeSandboxEnvironmentConfig", "SANDBOX_TYPE"]
