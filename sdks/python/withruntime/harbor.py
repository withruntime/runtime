"""Runtime Cloud as an environment for Harbor, the Terminal-Bench harness.

``RuntimeEnvironment`` implements Harbor's ``BaseEnvironment``: each trial runs
in its own Runtime Cloud microVM, built from the task's ``environment/Dockerfile``
or its ``docker_image``, with no Harbor change::

    harbor run -d terminal-bench@2.0 -a oracle -e withruntime.harbor:RuntimeEnvironment

Install with ``pip install "withruntime[harbor]"``. The key comes from
RUNTIME_API_KEY or the machine's ``runtime login``, as for ``AsyncRuntime``.
Options arrive as ``--ek name=value``: ``funding`` ("trial" or "paid"),
``region``, ``image`` (an existing Runtime image to use as it is), ``build``
(build limits such as ``{"disk_mib": 16384}``), ``labels`` and ``base_url``.

How it maps Harbor onto Runtime:

- The task's image is built once with Runtime's images API and kept under the
  name ``harbor-<task>`` with a tag from a hash of the environment, so a rerun
  starts from the built image at once. ``--force-build`` builds it again.
- Commands run as the sandbox user, uid 1000. Harbor's default user is root,
  so a command for root or any named user runs through passwordless ``sudo``;
  an image without it is refused with a message that says what to add.
- Every command streams, so no output is cut, and a sandbox is kept alive past
  the hour-long lease while the trial runs.
- ``cpus``, ``memory_mb`` and ``storage_mb`` become ``vcpu``, ``memory_mib`` and
  ``disk_mib``. A trial sandbox is at most 2 vCPU, 4 GiB and 10 GiB of disk; a
  larger request on the trial is cut to that, with a warning.
- Network policies: no network, allow-lists of hostnames, ``*.domain``
  wildcards, IPv4 addresses and IPv4 CIDR ranges, changed while the sandbox runs.
- Docker Compose tasks with more than the main container are not supported.
"""
from __future__ import annotations

import io
import logging
import os
import tarfile
from pathlib import Path
from typing import Any, Optional

try:
    from harbor.environments.base import BaseEnvironment, ExecResult
    from harbor.environments.capabilities import EnvironmentCapabilities, EnvironmentResourceCapabilities
    from harbor.environments.definition import require_agent_environment_definition, should_use_prebuilt_docker_image
    from harbor.models.task.config import NetworkMode, NetworkPolicy
    from harbor.models.trial.config import ResourceMode
except ImportError as error:  # pragma: no cover - depends on the optional extra
    raise ImportError('withruntime.harbor needs Harbor: pip install "withruntime[harbor]"') from error

try:
    from harbor.environments.base import SandboxBuildFailedError
except ImportError:  # pragma: no cover - older Harbor
    SandboxBuildFailedError = RuntimeError  # type: ignore[misc,assignment]

from ._async_client import AsyncRuntime, AsyncSandbox
from ._errors import NotFoundError
from ._errors import RuntimeError as RuntimeCloudError
from ._eval_sandbox import (_TRANSFER_TIMEOUT_S, MissingSudoError, _file_error, _missing_sudo, _Shell, _sizes,
                            dockerfile_workdir, ensure_image, image_name, image_tag)

logger = logging.getLogger("withruntime.harbor")

ENVIRONMENT_TYPE = "runtime"
_STAGING = "/workspace/.runtime-harbor"



class RuntimeEnvironment(BaseEnvironment):
    """A Harbor environment on Runtime Cloud. Options come as ``--ek`` keyword arguments."""

    def __init__(self, environment_dir: Path, environment_name: str, session_id: str, trial_paths: Any,
                 task_env_config: Any, *args: Any, funding: Optional[str] = None, region: Optional[str] = None,
                 image: Optional[str] = None, build: Optional[dict[str, Any]] = None,
                 labels: Optional[dict[str, str]] = None, base_url: Optional[str] = None,
                 runtime: Optional[AsyncRuntime] = None, **kwargs: Any) -> None:
        if funding not in (None, "trial", "paid"):
            raise ValueError(f'funding must be "trial" or "paid", not {funding!r}')
        self._funding = funding
        self._region = region
        self._image = image
        self._build = build
        self._labels = dict(labels or {})
        self._base_url = base_url
        self._runtime = runtime
        self._owns_runtime = runtime is None
        self._sandbox: Optional[AsyncSandbox] = None
        self._shell: Optional[_Shell] = None
        super().__init__(environment_dir=environment_dir, environment_name=environment_name, session_id=session_id,
                         trial_paths=trial_paths, task_env_config=task_env_config, **kwargs)
        self._workdir = dockerfile_workdir(self.environment_dir / "Dockerfile")

    @staticmethod
    def type() -> str:
        return ENVIRONMENT_TYPE

    @classmethod
    def preflight(cls) -> None:
        if os.environ.get("RUNTIME_API_KEY"):
            return
        from ._connection import saved_key
        if saved_key(os.environ.get("RUNTIME_API_URL", "https://api.withruntime.com")) is None:
            raise SystemExit("Runtime needs a key: set RUNTIME_API_KEY to a key from "
                             "https://withruntime.com/account/keys, or run `npx -y withruntime login`.")

    @classmethod
    def resource_capabilities(cls) -> EnvironmentResourceCapabilities:
        # vcpu is a ceiling the sandbox may burst to; reserved CPU guarantees it. Memory is reserved.
        return EnvironmentResourceCapabilities(cpu_limit=True, cpu_request=True, memory_limit=True,
                                               memory_request=True)

    @property
    def capabilities(self) -> EnvironmentCapabilities:
        return EnvironmentCapabilities(
            disable_internet=True, network_allowlist=True, network_allowlist_hostnames=True,
            network_allowlist_wildcard_hostnames=True, network_allowlist_ipv4_addresses=True,
            network_allowlist_ipv4_cidrs=True, dynamic_network_policy=True)

    def _validate_definition(self) -> None:
        require_agent_environment_definition(self.environment_dir, docker_image=self.task_env_config.docker_image)
        if not self.task_env_config.docker_image and not (self.environment_dir / "Dockerfile").exists():
            raise ValueError(
                f"Runtime runs one machine per trial and cannot run the Docker Compose file in "
                f"{self.environment_dir}. Give the task an environment/Dockerfile or a docker_image.")

    # The machine.

    def _client(self) -> AsyncRuntime:
        if self._runtime is None:
            self._runtime = AsyncRuntime(base_url=self._base_url)
        return self._runtime

    def _require(self) -> tuple[AsyncSandbox, _Shell]:
        if self._sandbox is None or self._shell is None:
            raise RuntimeError("The Runtime sandbox is not running. Start the environment first.")
        return self._sandbox, self._shell

    def _image_source(self, force_build: bool) -> tuple[dict[str, Any], str]:
        docker_image = self.task_env_config.docker_image
        if should_use_prebuilt_docker_image(self.environment_dir, docker_image=docker_image, force_build=force_build):
            return {"image": docker_image}, f"image|{docker_image}"
        dockerfile = self.environment_dir / "Dockerfile"
        return ({"dockerfile": dockerfile.read_text(), "context_dir": str(self.environment_dir)},
                f"dockerfile|{self.environment_id}")

    async def _resolve_image(self, force_build: bool) -> str:
        if self._image:
            return self._image
        source, key = self._image_source(force_build)
        tag = image_tag(key)
        build = dict(self._build or {})
        build.setdefault("timeout_seconds", max(60, min(3600, int(self.task_env_config.build_timeout_sec))))
        try:
            return await ensure_image(
                self._client(), image_name("harbor", self.environment_name), tag, source, rebuild=force_build,
                build=build, labels={"created_by": "harbor", **self._labels},
                on_log=lambda line: self.logger.debug("build: %s", line.get("text", "")))
        except RuntimeCloudError as error:
            if error.code == "image_build_failed":
                raise SandboxBuildFailedError(f"Runtime could not build {self.environment_name}: {error}") from error
            raise

    def _network(self, policy: NetworkPolicy) -> dict[str, Any]:
        if policy.network_mode == NetworkMode.NO_NETWORK:
            return {"internet": False}
        if policy.network_mode == NetworkMode.ALLOWLIST:
            hosts = list(policy.allowed_hosts)
            return {"internet": True, "allow": hosts} if hosts else {"internet": False}
        return {"internet": True}

    def _create_fields(self, image: str) -> dict[str, Any]:
        sizes, notes = _sizes(self._effective_cpus, self._effective_memory_mb, self._effective_storage_mb,
                              self._funding == "trial")
        for note in notes:
            self.logger.warning("Runtime: %s.", note)
        fields: dict[str, Any] = {"image": image, "idle_pause_seconds": 0, **sizes,
                                  "labels": {"created_by": "harbor", "harbor_task": self.environment_name[:256],
                                             "harbor_session": self.session_id[:256], **self._labels}}
        if self._cpu_resource_mode in (ResourceMode.REQUEST, ResourceMode.GUARANTEE) and self._funding != "trial":
            fields["cpu"] = "reserved"  # A trial sandbox's CPU is always shared.
        if self.network_policy.network_mode != NetworkMode.PUBLIC:
            fields["network"] = self._network(self.network_policy)
        if self._funding:
            fields["funding"] = self._funding
        if self._region:
            fields["region"] = self._region
        return fields

    async def _create(self, image: str) -> AsyncSandbox:
        fields = self._create_fields(image)
        try:
            return await self._client().sandboxes.create(**fields)
        except RuntimeCloudError as error:
            if error.code != "invalid_trial" or self._funding is not None:
                raise
            # No funding named, and the account is on its trial: run at the trial's largest size.
            sizes, notes = _sizes(self._effective_cpus, self._effective_memory_mb, self._effective_storage_mb, True)
            self.logger.warning("Runtime: this account runs on its trial, so %s. Pass --ek funding=paid for "
                                "the size the task asks.", "; ".join(notes) or "the size was cut")
            fields.update(sizes)
            fields.pop("cpu", None)
            return await self._client().sandboxes.create(**fields)

    async def start(self, force_build: bool) -> None:
        image = await self._resolve_image(force_build)
        sandbox = await self._create(image)
        self._sandbox = sandbox
        try:
            sandbox.keep_alive()
            shell = _Shell(sandbox, _STAGING)
            await shell.probe()
            self._shell = shell
            if shell.uid != 0 and not shell.can_sudo:
                raise _missing_sudo(sandbox.id, "root", shell.sudo, shell.uid)
            workdir = self.task_env_config.workdir or self._workdir
            if workdir:
                # Docker makes a missing working directory; every command would fail to start without it.
                made = await shell.run(["mkdir", "-p", "--", workdir], user="root", timeout_s=60)
                if made.exit_code != 0:
                    raise RuntimeError(f"Could not make the working directory {workdir}: {made.stderr}")
            await self.ensure_dirs(self._mount_targets(writable_only=True))
            await self._upload_environment_dir_after_start()
        except BaseException:
            await self.stop(delete=True)
            raise

    async def stop(self, delete: bool) -> None:
        sandbox, self._sandbox, self._shell = self._sandbox, None, None
        try:
            if sandbox is not None:
                sandbox.stop_keep_alive()
                try:
                    await sandbox.stop()
                except NotFoundError:
                    pass
                except RuntimeCloudError as error:
                    self.logger.error("Could not stop Runtime sandbox %s: %s", sandbox.id, error)
        finally:
            if self._owns_runtime and self._runtime is not None:
                runtime, self._runtime = self._runtime, None
                await runtime.close()

    async def _apply_network_policy(self, network_policy: NetworkPolicy) -> None:
        sandbox, _ = self._require()
        rules = self._network(network_policy)
        await sandbox.network.set(internet=rules["internet"], allow=rules.get("allow"))

    # Commands.

    async def exec(self, command: str, cwd: Optional[str] = None, env: Optional[dict[str, str]] = None,
                   timeout_sec: Optional[int] = None, user: Optional[str | int] = None) -> ExecResult:
        _, shell = self._require()
        user = self._resolve_user(user)
        merged = self._merge_env(env)
        callback = self._output_callback()
        result = await shell.run(
            ["bash" if shell.bash else "sh", "-c", command], user="root" if user is None else user,
            cwd=cwd or self.task_env_config.workdir or self._workdir, env=merged, timeout_s=timeout_sec,
            on_output=callback)
        if result.timed_out:
            raise RuntimeError(f"Command timed out after {timeout_sec} seconds")
        return ExecResult(stdout=result.stdout, stderr=result.stderr, return_code=result.exit_code)

    # Files. Harbor moves them as root, like docker cp.

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        _, shell = self._require()
        source = Path(source_path)
        await shell.write(target_path, source.read_bytes(), user="root", mode=source.stat().st_mode & 0o777)

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        sandbox, shell = self._require()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            archive.add(str(source_dir), arcname=".")
        staging = shell._path()
        try:
            await sandbox.files.write(staging, buffer.getvalue())
            result = await shell.run(["/bin/sh", "-c", 'mkdir -p -- "$1" && tar -x -z -o -f "$2" -C "$1"', "sh",
                                      target_dir, staging], user="root", timeout_s=_TRANSFER_TIMEOUT_S)
            if result.exit_code != 0:
                raise RuntimeError(f"Could not unpack into {target_dir}: {result.stderr or result.stdout}")
        finally:
            await shell.remove(staging)

    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        _, shell = self._require()
        data = await shell.read(source_path, user="root")
        target = Path(target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        sandbox, shell = self._require()
        staging = shell._path()
        try:
            result = await shell.run(["tar", "-c", "-z", "-f", "-", "-C", source_dir, "."], user="root",
                                     stdout_path=staging, timeout_s=_TRANSFER_TIMEOUT_S)
            if result.exit_code != 0:
                raise _file_error(source_dir, result)
            data = await sandbox.files.read(staging)
        finally:
            await shell.remove(staging)
        target = Path(target_dir)
        target.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            archive.extractall(target, filter="data")


__all__ = ["ENVIRONMENT_TYPE", "MissingSudoError", "RuntimeEnvironment"]
