"""Prime Intellect sandbox compatibility, pinned to prime-sandboxes 0.4.7.

Change ``from prime_sandboxes import ...`` to ``from withruntime.prime import ...``.
Authentication uses RUNTIME_API_KEY or ``runtime login``.
"""
from .models import (CreateSandboxRequest, StartCommand, Sandbox, CommandResponse,
    FileUploadResponse, ReadFileResponse, SandboxListResponse, BackgroundJob, BackgroundJobStatus)
from ._async import AsyncSandboxClient as _AsyncSandboxClient, _validate_guest_user, _validate_background_output_limits
from ._sync import SandboxClient, CommandTimeoutError

UPSTREAM_VERSION = "0.4.7"

from .. import Runtime as _Runtime, AsyncRuntime as _AsyncRuntime
from .._compat import CompatibilityError as _CompatibilityError, refused as _refused, runtime_key as _runtime_key

_RAW = ("Prime's raw API routes are not Runtime's; use SandboxClient's methods, or the withruntime SDK for "
        "the rest")


class APIClient(_Runtime):
    def __init__(self, api_key=None, require_auth=True, user_agent=None):
        if not require_auth or user_agent is not None:
            raise _CompatibilityError("Custom authentication and user-agent behavior is not implemented")
        super().__init__(api_key=_runtime_key(api_key))

    def request(self, method, endpoint, params=None, json=None, timeout=None, idempotent_post=False):
        raise _CompatibilityError(_RAW)

    def get(self, endpoint, params=None):
        raise _CompatibilityError(_RAW)

    def post(self, endpoint, json=None):
        raise _CompatibilityError(_RAW)

    def patch(self, endpoint, json=None):
        raise _CompatibilityError(_RAW)

    def delete(self, endpoint):
        raise _CompatibilityError(_RAW)


class AsyncAPIClient(_AsyncRuntime):
    def __init__(self, api_key=None, require_auth=True, user_agent=None):
        if not require_auth or user_agent is not None:
            raise _CompatibilityError("Custom authentication and user-agent behavior is not implemented")
        super().__init__(api_key=_runtime_key(api_key))

    async def request(self, method, endpoint, params=None, json=None, timeout=None, idempotent_post=False):
        raise _CompatibilityError(_RAW)

    async def get(self, endpoint, params=None):
        raise _CompatibilityError(_RAW)

    async def post(self, endpoint, json=None):
        raise _CompatibilityError(_RAW)

    async def patch(self, endpoint, json=None):
        raise _CompatibilityError(_RAW)

    async def delete(self, endpoint):
        raise _CompatibilityError(_RAW)

    async def aclose(self):
        await self.close()


class AsyncSandboxClient(_AsyncSandboxClient):
    def __init__(self, api_key=None, max_connections=1000, max_keepalive_connections=200, *, runtime=None,
                 background_job_output_concurrency=20, background_job_output_queue_size=200,
                 background_job_output_cache_bytes=64 * 1024 * 1024):
        _validate_background_output_limits(background_job_output_concurrency,
                                          background_job_output_queue_size, background_job_output_cache_bytes)
        if max_keepalive_connections != 200:
            raise _CompatibilityError("Runtime uses one bounded connection pool; separate keepalive limits cannot be preserved")
        # Runtime pools HTTP connections centrally. There is no separate keepalive pool.
        if max_connections <= 0 or max_keepalive_connections < 0:
            raise ValueError("Connection limits must be positive (keepalive may be zero)")
        super().__init__(runtime if runtime is not None else _AsyncRuntime(api_key=_runtime_key(api_key), max_connections=max_connections))

    async def open_process(self, sandbox_id, command, working_dir=None, env=None, user=None):
        _validate_guest_user(user)
        sb = await self._runtime.sandboxes.get(sandbox_id)
        process = await sb.spawn(command, cwd=working_dir, env=await self._environment(sb, env),
                                 stdin="pipe", output_encoding="base64")
        return AsyncSandboxProcess(process)


from .process import AsyncSandboxProcess
from .exceptions import (APIError, UnauthorizedError, SandboxFileNotFoundError, SandboxFileTooLargeError,
    SandboxNotRunningError, SandboxOOMError, SandboxTimeoutError, SandboxImagePullError,
    UploadTimeoutError, DownloadTimeoutError, BatchStatusUnsupportedError)
from .exceptions import translate as _translate
AsyncSandboxClient.open_process = _translate(AsyncSandboxClient.open_process)

# Prime's image registry: build, list, transfer and rename images on Prime.
_IMAGES = "build images with runtime.images.build(dockerfile=...) and list them with runtime.images.list()"
ImageClient = _refused("Prime", "ImageClient", _IMAGES)
AsyncImageClient = _refused("Prime", "AsyncImageClient", _IMAGES)
BuildImageRequest = _refused("Prime", "BuildImageRequest", _IMAGES)
BuildImageResponse = _refused("Prime", "BuildImageResponse", _IMAGES)
BulkBuildImageResponse = _refused("Prime", "BulkBuildImageResponse", _IMAGES)
SourceImageBuildResult = _refused("Prime", "SourceImageBuildResult", _IMAGES)
ImageArtifactType = _refused("Prime", "ImageArtifactType", _IMAGES)
ImageBuildStatus = _refused("Prime", "ImageBuildStatus", _IMAGES)
ImageCoordinateState = _refused("Prime", "ImageCoordinateState", _IMAGES)
ImageListItem = _refused("Prime", "ImageListItem", _IMAGES)
ImageListResponse = _refused("Prime", "ImageListResponse", _IMAGES)
ImageMutationError = _refused("Prime", "ImageMutationError", _IMAGES)
ImageOwnerType = _refused("Prime", "ImageOwnerType", _IMAGES)
ImageVisibility = _refused("Prime", "ImageVisibility", _IMAGES)
ImageUpdateItem = _refused("Prime", "ImageUpdateItem", _IMAGES)
ImageUpdatePatch = _refused("Prime", "ImageUpdatePatch", _IMAGES)
ImageUpdateResult = _refused("Prime", "ImageUpdateResult", _IMAGES)
ImageUpdateSource = _refused("Prime", "ImageUpdateSource", _IMAGES)
UpdateImagesRequest = _refused("Prime", "UpdateImagesRequest", _IMAGES)
UpdateImagesResponse = _refused("Prime", "UpdateImagesResponse", _IMAGES)
PersonalImageOwner = _refused("Prime", "PersonalImageOwner", _IMAGES)
PlatformImageOwner = _refused("Prime", "PlatformImageOwner", _IMAGES)
TeamImageOwner = _refused("Prime", "TeamImageOwner", _IMAGES)

from .models import (SandboxStatus, SandboxStatusSnapshot, SandboxStatusLookupError, BatchSandboxStatusResponse,
    BackgroundJobStatusSnapshot, BackgroundJobStatusLookupError, BatchBackgroundJobStatusResponse,
    BulkDeleteSandboxRequest, BulkDeleteSandboxResponse, SandboxEgressPolicy, EgressPolicyStatus,
    SSHSession, AdvancedConfigs, SandboxLogsResponse, SandboxCheckpoint, CheckpointLookupError,
    BatchCheckpointResponse, CheckpointDeleteError, DeleteSandboxCheckpointsResponse)

# Prime's LAN networks (0.4.5): named networks of tagged members with directed port rules.
_PRIVATE = ("Runtime cannot limit which of your sandboxes reach each other; runtime.networks.private.set(enabled=True) "
            "lets all of them reach each other at <id>.sandbox.internal")
LanNetwork = _refused("Prime", "LanNetwork", _PRIVATE)
LanNetworkMember = _refused("Prime", "LanNetworkMember", _PRIVATE)
LanRule = _refused("Prime", "LanRule", _PRIVATE)

from .exceptions import PaymentRequiredError, APITimeoutError
