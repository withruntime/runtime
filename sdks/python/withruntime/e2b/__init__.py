"""Code written for E2B's Python SDK, on Runtime Cloud. Change the import:

    from withruntime.e2b import Sandbox  # was: from e2b import Sandbox

and set RUNTIME_API_KEY (or put a Runtime key in E2B_API_KEY). What Runtime
cannot do the way E2B does raises NotSupportedException, naming what to use."""
from ._async_sandbox import (AsyncCommandHandle, AsyncCommands, AsyncFilesystem, AsyncPty, AsyncSandbox,
                             AsyncSandboxPaginator)
from ._core import (AuthenticationException, BuildException, CommandExitException, CommandResult, EntryInfo,
                    FileNotFoundException, FileType, FileUploadException, FilesystemEvent, FilesystemEventType,
                    GitAuthException, GitUpstreamException, InvalidArgumentException, NotEnoughSpaceException,
                    NotFoundException, NotSupportedException, PublicPreviewNotAllowedException, ProcessInfo, PtySize, RateLimitException, SandboxException,
                    SandboxInfo, SandboxInfoLifecycle, SandboxNotFoundException, SandboxQuery, SecretException,
                    SecretNotFoundException, ServiceBusyException, SnapshotInfo, TemplateException, TimeoutException,
                    VolumeException, VolumeNotFoundException, VolumePathNotFoundException, WriteInfo, HttpVersion)
from ._core import unsupported as _unsupported
from ._sync_sandbox import CommandHandle, Commands, Filesystem, Pty, Sandbox, SandboxPaginator, SandboxMetrics

__version__ = "0.1.0"

_TEMPLATES = ("Build a Runtime image instead: `npx withruntime image build --dockerfile e2b.Dockerfile --name "
              "<template>`, then Sandbox.create('<template>').")


class _Unsupported:
    """An E2B export Runtime has no counterpart for: importing it works; using it
    raises NotSupportedException naming the alternative."""

    def __init__(self, name: str, alternative: str) -> None:
        self._refuse = _unsupported(f"E2B's {name}", alternative)

    def __call__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return self._refuse()

    def __getattr__(self, name: str):  # type: ignore[no-untyped-def]
        if name.startswith("__"):
            raise AttributeError(name)
        return self._refuse()


Template = _Unsupported("Template builder", _TEMPLATES)
AsyncTemplate = _Unsupported("Template builder", _TEMPLATES)
Volume = _Unsupported("Volume", "Use Runtime volumes: runtime_create={'volumes': [{'volume_id': ..., 'path': ...}]}.")
AsyncVolume = Volume
Secret = _Unsupported("Secret", "Use a Runtime secret: `npx withruntime secrets set NAME --host api.example.com`. The sandbox sees a placeholder, and the egress proxy adds the value on HTTPS to that host.")
AsyncSecret = Secret
wait_for_port = wait_for_url = wait_for_process = wait_for_file = wait_for_timeout = _Unsupported(
    "template ready checks", _TEMPLATES)

# The rest of what e2b 2.52.1 exports (its __all__, read 5 October 2026), so
# that every import written for E2B resolves. Types and values are E2B's own;
# anything that would act raises NotSupportedException when used.
from enum import Enum as _Enum
from typing import Any as _Any, Callable as _Callable, Dict as _Dict, List as _List, Literal as _Literal, Union as _Union

ALL_TRAFFIC = "0.0.0.0/0"


class SandboxState(str, _Enum):
    PAUSED = "paused"
    RUNNING = "running"


class TemplateBuildStatus(str, _Enum):
    BUILDING = "building"
    WAITING = "waiting"
    READY = "ready"
    ERROR = "error"


class VolumeFileType(str, _Enum):
    DIRECTORY = "directory"
    FILE = "file"
    SYMLINK = "symlink"
    UNKNOWN = "unknown"


SandboxListOrder = _Literal["asc", "desc"]
SandboxOnResume = _Literal["restore", "reboot"]
SandboxOnTimeout = _Union[_Literal["pause", "kill"], _Dict[str, _Any]]
GitResetMode = _Literal["soft", "mixed", "hard", "merge", "keep"]
LogEntryLevel = _Literal["debug", "info", "warn", "error"]
SandboxIamTokenType = _Union[_Literal["JWT-SVID"], str]
Username = Stdout = Stderr = str
PtyOutput = bytes
ProxyTypes = _Any
OutputHandler = _Callable[..., _Any]
SandboxNetworkSelector = _Union[_List[str], _Callable[..., _Any]]
SandboxNetworkRules = _Dict[str, _Any]
SandboxNetworkTransformResolver = _Callable[..., _Any]
McpServer = GitHubMcpServer = TemplateClass = _Dict[str, _Any]
# E2B's TypedDicts: option shapes, read only by a type checker.
(E2BClientParams, ApiParams, VolumeApiParams, SandboxEgressProxyOpts, SandboxEgressProxyInfo, SandboxNetworkOpts,
 SandboxNetworkInfo, SandboxNetworkRule, SandboxNetworkRuleInfo, SandboxNetworkTransform, SandboxNetworkUpdate,
 SandboxLifecycle, SandboxIamOpts, SandboxIamToken, CopyItem, GitHubMcpServerConfig) = (_Dict[str, _Any],) * 16

_GIT = "Run git with sandbox.commands.run('git ...')."
_CLIENT = "Use sandbox.runtime, or withruntime.Runtime, for Runtime's own API."
E2B = _Unsupported("E2B client", _CLIENT)
ApiClient = _Unsupported("ApiClient", _CLIENT)
client = _Unsupported("client module", _CLIENT)
ConnectionConfig = _Unsupported("ConnectionConfig", "Pass api_key, or set RUNTIME_API_KEY.")
VolumeConnectionConfig = _Unsupported(
    "VolumeConnectionConfig", "Use Runtime volumes: runtime_create={'volumes': [{'volume_id': ..., 'path': ...}]}.")
Git = GitStatus = GitBranches = GitFileStatus = _Unsupported("git module", _GIT)
SecretInfo = SecretPaginator = AsyncSecretPaginator = Secret
SnapshotPaginator = AsyncSnapshotPaginator = _Unsupported(
    "snapshot list", "Use sandbox.runtime's client: Runtime().snapshots.list().")
VolumeInfo = VolumeAndToken = VolumeEntryStat = Volume
get_signature = _Unsupported("get_signature (signed file URLs)", "Use sandbox.files.read and sandbox.files.write.")
SandboxNetworkSelectorContext = SandboxNetworkTransformContext = _Unsupported(
    "network rules", "Use sandbox.runtime.network.set(internet=..., allow=[...]).")
(TemplateBase, BuildInfo, BuildStatusReason, TemplateBuildStatusResponse, TemplateTag, TemplateTagInfo, ReadyCmd,
 LogEntry, LogEntryStart, LogEntryEnd, default_build_logger) = (_Unsupported("Template builder", _TEMPLATES),) * 11

__all__ = [
    "Sandbox", "AsyncSandbox", "PtySize", "Pty", "AsyncPty", "Commands", "AsyncCommands", "CommandHandle", "AsyncCommandHandle", "Filesystem",
    "AsyncFilesystem", "SandboxPaginator", "AsyncSandboxPaginator", "CommandResult", "CommandExitException",
    "EntryInfo", "WriteInfo", "FileType", "FilesystemEvent", "FilesystemEventType", "ProcessInfo", "SandboxInfo", "SandboxInfoLifecycle", "SandboxQuery",
    "SnapshotInfo", "SandboxException", "TimeoutException", "InvalidArgumentException", "NotEnoughSpaceException",
    "NotFoundException", "FileNotFoundException", "SandboxNotFoundException", "AuthenticationException",
    "TemplateException", "RateLimitException", "ServiceBusyException", "NotSupportedException", "PublicPreviewNotAllowedException", "HttpVersion", "Template",
    "AsyncTemplate", "Volume", "AsyncVolume", "Secret", "AsyncSecret", "wait_for_port", "wait_for_url",
    "wait_for_process", "wait_for_file", "wait_for_timeout",
]

from ._async_io import AsyncWatchHandle
from ._sync_io import WatchHandle
__all__ += ["WatchHandle", "AsyncWatchHandle"]
__all__ += [
    "GitAuthException", "GitUpstreamException", "BuildException", "FileUploadException", "VolumeException",
    "VolumeNotFoundException", "VolumePathNotFoundException", "SecretException", "SecretNotFoundException",
    "SandboxMetrics", "ALL_TRAFFIC", "SandboxState", "TemplateBuildStatus", "VolumeFileType", "SandboxListOrder",
    "SandboxOnResume", "SandboxOnTimeout", "GitResetMode", "LogEntryLevel", "SandboxIamTokenType", "Username",
    "Stdout", "Stderr", "PtyOutput", "ProxyTypes", "OutputHandler", "SandboxNetworkSelector", "SandboxNetworkRules",
    "SandboxNetworkTransformResolver", "McpServer", "GitHubMcpServer", "TemplateClass", "E2BClientParams",
    "ApiParams", "VolumeApiParams", "SandboxEgressProxyOpts", "SandboxEgressProxyInfo", "SandboxNetworkOpts",
    "SandboxNetworkInfo", "SandboxNetworkRule", "SandboxNetworkRuleInfo", "SandboxNetworkTransform",
    "SandboxNetworkUpdate", "SandboxLifecycle", "SandboxIamOpts", "SandboxIamToken", "CopyItem",
    "GitHubMcpServerConfig", "E2B", "ApiClient", "client", "ConnectionConfig", "VolumeConnectionConfig", "Git",
    "GitStatus", "GitBranches", "GitFileStatus", "SecretInfo", "SecretPaginator", "AsyncSecretPaginator",
    "SnapshotPaginator", "AsyncSnapshotPaginator", "VolumeInfo", "VolumeAndToken", "VolumeEntryStat",
    "get_signature", "SandboxNetworkSelectorContext", "SandboxNetworkTransformContext", "TemplateBase", "BuildInfo",
    "BuildStatusReason", "TemplateBuildStatusResponse", "TemplateTag", "TemplateTagInfo", "ReadyCmd", "LogEntry",
    "LogEntryStart", "LogEntryEnd", "default_build_logger",
]
