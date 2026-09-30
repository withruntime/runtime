"""Prime Intellect sandbox compatibility, pinned to prime-sandboxes 0.4.0.

Change ``from prime_sandboxes import ...`` to ``from withruntime.prime import ...``.
Authentication uses RUNTIME_API_KEY or ``runtime login``.
"""
from .models import (CreateSandboxRequest, StartCommand, Sandbox, CommandResponse,
    FileUploadResponse, ReadFileResponse, SandboxListResponse, BackgroundJob, BackgroundJobStatus)
from ._async import AsyncSandboxClient as _AsyncSandboxClient
from ._sync import SandboxClient, CommandTimeoutError

UPSTREAM_VERSION = "0.4.0"

from .. import Runtime as _Runtime, AsyncRuntime as _AsyncRuntime
from .._compat import CompatibilityError as _CompatibilityError, runtime_key as _runtime_key


class APIClient(_Runtime):
    def __init__(self, api_key=None, require_auth=True, user_agent=None):
        if not require_auth or user_agent is not None:
            raise _CompatibilityError("Custom authentication and user-agent behavior is not implemented")
        super().__init__(api_key=_runtime_key(api_key))


class AsyncAPIClient(_AsyncRuntime):
    def __init__(self, api_key=None, require_auth=True, user_agent=None):
        if not require_auth or user_agent is not None:
            raise _CompatibilityError("Custom authentication and user-agent behavior is not implemented")
        super().__init__(api_key=_runtime_key(api_key))


class AsyncSandboxClient(_AsyncSandboxClient):
    def __init__(self, api_key=None, max_connections=1000, max_keepalive_connections=200, *, runtime=None,
                 background_job_output_concurrency=20, background_job_output_queue_size=200,
                 background_job_output_cache_bytes=64 * 1024 * 1024):
        if (background_job_output_concurrency, background_job_output_queue_size, background_job_output_cache_bytes) != (20, 200, 64 * 1024 * 1024):
            raise _CompatibilityError("Custom background output limits require the background-job adapter")
        if max_keepalive_connections != 200:
            raise _CompatibilityError("Runtime uses one bounded connection pool; separate keepalive limits cannot be preserved")
        # Runtime pools HTTP connections centrally. There is no separate keepalive pool.
        if max_connections <= 0 or max_keepalive_connections < 0:
            raise ValueError("Connection limits must be positive (keepalive may be zero)")
        super().__init__(runtime or _AsyncRuntime(api_key=_runtime_key(api_key), max_connections=max_connections))

from .process import AsyncSandboxProcess
from .exceptions import (APIError, UnauthorizedError, SandboxFileNotFoundError, SandboxFileTooLargeError,
    SandboxNotRunningError, SandboxOOMError, SandboxTimeoutError, SandboxImagePullError,
    UploadTimeoutError, DownloadTimeoutError, BatchStatusUnsupportedError)


async def _open_process(self, sandbox_id, command, working_dir=None, env=None, user=None):
    if user is not None:
        raise ValueError("The 'user' parameter is not supported for VM sandbox processes.")
    sb = await self._runtime.sandboxes.get(sandbox_id)
    process = await sb.spawn(command, cwd=working_dir, env=await self._environment(sb, env),
                             stdin="pipe", output_encoding="base64")
    return AsyncSandboxProcess(process)


from .exceptions import translate as _translate
AsyncSandboxClient.open_process = _translate(_open_process)

from .models import (SandboxStatus, SandboxStatusSnapshot, SandboxStatusLookupError, BatchSandboxStatusResponse,
    BackgroundJobStatusSnapshot, BackgroundJobStatusLookupError, BatchBackgroundJobStatusResponse,
    BulkDeleteSandboxRequest, BulkDeleteSandboxResponse, SandboxEgressPolicy, EgressPolicyStatus,
    SSHSession, AdvancedConfigs, SandboxLogsResponse)

from .exceptions import PaymentRequiredError, APITimeoutError
