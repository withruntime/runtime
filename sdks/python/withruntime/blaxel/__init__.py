"""Code written for Blaxel's Python SDK, on Runtime Cloud. Change the import:

    from withruntime.blaxel import SandboxInstance  # was: from blaxel.core import SandboxInstance
    from withruntime.blaxel import SyncSandboxInstance  # was: from blaxel.core import SyncSandboxInstance

(``withruntime.blaxel.core`` is the same module, for a search-and-replace of
``blaxel.``), and set RUNTIME_API_KEY (or put a Runtime key in BL_API_KEY),
or run `npx withruntime login` once. A Blaxel key is never sent anywhere.
What Runtime cannot do the way Blaxel does raises NotSupportedError, naming
what to use."""
from typing import Any

from . import _async_sandbox, _sync_sandbox
from ._async_sandbox import (AsyncCodeInterpreter, AsyncPaginatedList, AsyncSandboxFileSystem, AsyncSandboxInstance,
                             AsyncSandboxPreview, AsyncSandboxPreviews, AsyncSandboxPreviewToken,
                             AsyncSandboxPreviewTokens, AsyncSandboxProcess, AsyncSandboxSessions, AsyncSandboxSnapshots,
                             AsyncSnapshot)
from ._core import (ApplicationAPIError, AsyncStreamHandle, AsyncWatchHandle, ContentSearchMatch,
                    ContentSearchResponse, Context, CopyResponse, Directory, DriveAPIError, Env, Execution,
                    ExecutionError, ExpirationPolicy, File, FindMatch, FindResponse, Logs, Metadata, NotSupportedError,
                    OutputMessage, PaginationMeta, Port, Preview, PreviewMetadata, PreviewSpec, PreviewToken, PreviewTokenMetadata,
                    PreviewTokenSpec, ProcessRequest, ProcessRequestWithLog, ProcessResponse, ProcessResponseStatus,
                    ProcessResponseWithLog, ResponseError, Result, Sandbox, SandboxAPIError, SandboxConfiguration,
                    SandboxCreateConfiguration, SandboxFilesystemFile, SandboxForkResponse, SandboxLifecycle,
                    SandboxNetwork, SandboxRuntime, SandboxSnapshot, SandboxSnapshotRequest, SandboxSpec, SandboxState,
                    SandboxUpdateMetadata, SandboxUpdateNetwork, SessionCreateOptions, SessionWithToken,
                    SnapshotAPIError, Status, StreamHandle, Subdirectory, SuccessResponse, VolumeAttachment,
                    VolumeBinding, WatchEvent, WatchHandle)
from ._core import unsupported_export as _unsupported_export

SandboxInstance = AsyncSandboxInstance
CodeInterpreter = AsyncCodeInterpreter
SandboxProcess = AsyncSandboxProcess
SandboxFileSystem = AsyncSandboxFileSystem
SandboxPreviews = AsyncSandboxPreviews
SandboxPreview = AsyncSandboxPreview
SandboxPreviewToken = AsyncSandboxPreviewToken
SandboxPreviewTokens = AsyncSandboxPreviewTokens
SandboxSnapshots = AsyncSandboxSnapshots
SandboxSessions = AsyncSandboxSessions
SyncSandboxSessions = _sync_sandbox.SandboxSessions
Snapshot = AsyncSnapshot
SyncSandboxInstance = _sync_sandbox.SandboxInstance
SyncCodeInterpreter = _sync_sandbox.CodeInterpreter
SyncSandboxProcess = _sync_sandbox.SandboxProcess
SyncSandboxFileSystem = _sync_sandbox.SandboxFileSystem
SyncSandboxPreviews = _sync_sandbox.SandboxPreviews
SyncSandboxSnapshots = _sync_sandbox.SandboxSnapshots
SyncSnapshot = _sync_sandbox.Snapshot
PaginatedList = _sync_sandbox.PaginatedList


def use_client(client: Any) -> None:
    """Sends Blaxel's calls through your own Runtime client: an AsyncRuntime
    for the async API, a Runtime for the sync one. None goes back to
    RUNTIME_API_KEY or the saved login for both."""
    import inspect
    if client is None:
        _async_sandbox.use_client(None)
        _sync_sandbox.use_client(None)
    elif inspect.iscoroutinefunction(client.sandboxes.create):
        _async_sandbox.use_client(client)
    else:
        _sync_sandbox.use_client(client)


def autoload() -> None:
    """Blaxel sets up its auth and telemetry here; Runtime needs neither."""


def _Unsupported(name: str, alternative: str) -> Any:  # noqa: N802 - reads as the class it makes
    return _unsupported_export(name, alternative)


_MODELS = "Call your model provider's SDK directly; run the agent's tools in a Runtime sandbox."
_AUTH = "Runtime uses RUNTIME_API_KEY, or the key `npx withruntime login` saved."
_VOLUMES = ("Use a Runtime volume: runtime.volumes.create(10240, name=...), mounted at create with the Runtime "
            "SDK's create(volumes=[{'volume_id': ..., 'path': ...}]).")
_IMAGES = "Build a Runtime image: `npx withruntime image build --dockerfile Dockerfile --name <name>`."
BlAgent = bl_agent = _Unsupported("agents", _MODELS)
BLModel = bl_model = _Unsupported("models", _MODELS)
BlTools = bl_tools = convert_mcp_tool_to_blaxel_tool = _Unsupported("tools", _MODELS)
BlaxelMcpServerTransport = websocket_client = _Unsupported(
    "MCP transport", "Runtime's own MCP server is at https://withruntime.com/mcp; run your MCP server in a sandbox and "
    "share its port with sandbox.previews.create(...).")
BlJobWrapper = _Unsupported("jobs", "Run the job as a process in a Runtime sandbox.")
BlaxelAuth = auth = get_credentials = client = _Unsupported("auth and API client", _AUTH)
settings = env = _Unsupported("settings", _AUTH)
find_from_cache = _Unsupported("cache", "Remove it: the adapter keeps no Blaxel cache.")
verify_webhook_signature = verify_webhook_from_request = _Unsupported(
    "webhook verification", "Runtime signs its own webhooks: use withruntime.webhooks.verify_webhook.")
VolumeInstance = SyncVolumeInstance = VolumeCreateConfiguration = _Unsupported("volumes", _VOLUMES)
DriveInstance = SyncDriveInstance = DriveCreateConfiguration = _Unsupported("drives", _VOLUMES)
ApplicationInstance = SyncApplicationInstance = ApplicationCreateConfiguration = _Unsupported(
    "applications", "Run the app in a sandbox and share its port with sandbox.previews.create(...).")
ImageInstance = ImageBuildContext = LocalFile = _Unsupported("image builder", _IMAGES)
_SANDBOX_PARTS = ("codegen, system, drives and schedules",
                  "See NotSupportedError's alternative for each call on sandbox.codegen and the rest.")
SandboxCodegen = SyncSandboxCodegen = SandboxSystem = SyncSandboxSystem = SandboxDrive = SyncSandboxDrive = \
    SandboxSchedules = SyncSandboxSchedules = _Unsupported(*_SANDBOX_PARTS)

__all__ = [
    "SandboxInstance", "SyncSandboxInstance", "CodeInterpreter", "SyncCodeInterpreter", "SandboxProcess",
    "SyncSandboxProcess", "SandboxFileSystem", "SyncSandboxFileSystem", "SandboxPreviews", "SyncSandboxPreviews",
    "SandboxPreview", "SandboxPreviewToken", "SandboxPreviewTokens", "SandboxSnapshots", "SyncSandboxSnapshots",
    "SandboxSessions", "SyncSandboxSessions",
    "PaginationMeta", "Snapshot", "SyncSnapshot", "PaginatedList", "AsyncPaginatedList", "Sandbox", "Metadata", "SandboxSpec",
    "SandboxRuntime", "SandboxLifecycle", "ExpirationPolicy", "SandboxNetwork", "Port", "Env", "VolumeAttachment",
    "VolumeBinding", "Status", "SandboxState", "SandboxConfiguration", "SandboxCreateConfiguration",
    "SandboxUpdateMetadata", "SandboxUpdateNetwork", "SessionCreateOptions", "SessionWithToken", "ProcessRequest",
    "ProcessRequestWithLog", "ProcessResponse", "ProcessResponseStatus", "ProcessResponseWithLog", "SuccessResponse",
    "Directory", "File", "Subdirectory", "FindResponse", "FindMatch", "ContentSearchResponse", "ContentSearchMatch",
    "SandboxFilesystemFile", "CopyResponse", "WatchEvent", "StreamHandle", "AsyncStreamHandle", "WatchHandle",
    "AsyncWatchHandle", "Preview", "PreviewMetadata", "PreviewSpec", "PreviewToken", "PreviewTokenMetadata",
    "PreviewTokenSpec", "SandboxSnapshot", "SandboxSnapshotRequest", "SandboxForkResponse", "OutputMessage", "Result",
    "ExecutionError", "Logs", "Execution", "Context", "SandboxAPIError", "SnapshotAPIError", "ResponseError",
    "DriveAPIError", "ApplicationAPIError", "NotSupportedError", "use_client", "autoload", "BlAgent", "bl_agent",
    "BLModel", "bl_model", "BlTools", "bl_tools", "convert_mcp_tool_to_blaxel_tool", "BlaxelMcpServerTransport",
    "websocket_client", "BlJobWrapper", "BlaxelAuth", "auth", "get_credentials", "client", "settings", "env",
    "find_from_cache", "verify_webhook_signature", "verify_webhook_from_request", "VolumeInstance",
    "SyncVolumeInstance", "VolumeCreateConfiguration", "DriveInstance", "SyncDriveInstance",
    "DriveCreateConfiguration", "ApplicationInstance", "SyncApplicationInstance", "ApplicationCreateConfiguration",
    "ImageInstance", "ImageBuildContext", "LocalFile", "SandboxCodegen", "SyncSandboxCodegen", "SandboxSystem",
    "SyncSandboxSystem", "SandboxDrive", "SyncSandboxDrive", "SandboxSchedules", "SyncSandboxSchedules",
]
