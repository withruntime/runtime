"""Vercel Sandbox's async API on Runtime: ``from withruntime.vercel import
sandbox`` then ``async with sandbox.create_sandbox() as box``. The sync API is
``withruntime.vercel.sandbox.sync``."""
from .._async_sandbox import (AsyncBatch, AsyncFileHandle, AsyncProcess, AsyncSandbox, AsyncSandboxFilesystem,
                              AsyncSnapshot, AsyncTextReader, create_sandbox, delete_drive, fork_sandbox, get_drive,
                              get_or_create_drive, get_or_create_sandbox, get_sandbox, get_snapshot, query_drives,
                              query_sandboxes, query_sessions, query_snapshots, resume_sandbox)
from .._core import (INTERACTIVE, CompletedProcess, DirectoryEntry, GitSource, NetworkPolicy,
                     NetworkPolicyForwardRuleSummary, NetworkPolicyInjectionRuleSummary, NetworkPolicyReadback,
                     NetworkPolicyResponse, NetworkPolicyResponseRuleSummary, NetworkPolicyRule,
                     NetworkPolicySubnets, NetworkPolicyTransform, NotSupportedError, ProcessStatus, SandboxApiError,
                     SandboxCredentialsError, SandboxError, SandboxFilesystemError, SandboxInteractiveError,
                     SandboxInvalidHandleError,
                     SandboxPathNotFoundError, SandboxQueryByCreatedAt, SandboxQueryByCurrentSnapshotId,
                     SandboxQueryByStatusUpdatedAt, SandboxQueryByName, SandboxResources,
                     SandboxRoute, SandboxStatus, SandboxStreamError, SandboxTerminalStateError, SandboxTimeoutError,
                     SnapshotRetention, SnapshotSource, TagFilter, TarballSource)
from .._core import UnsupportedName as _Unsupported
from . import sync

Sandbox = AsyncSandbox
Process = AsyncProcess
Snapshot = AsyncSnapshot
SandboxFilesystem = AsyncSandboxFilesystem
TextReader = AsyncTextReader


_DRIVES = "Use a Runtime volume: runtime_create={'volumes': [{'volume_id': ..., 'path': ...}]}."
Drive = DriveMount = _Unsupported("Drives", _DRIVES)
SandboxClient = _Unsupported("standalone SandboxClient", "Call the module's functions: sandbox.create_sandbox(...).")
SandboxServiceOptions = _Unsupported("SandboxServiceOptions", "Remove it: Runtime needs no service options.")
InteractiveSession = InteractiveSessionOperation = InteractiveStream = _Unsupported(*INTERACTIVE)

__all__ = [
    "create_sandbox", "get_sandbox", "resume_sandbox", "get_or_create_sandbox", "fork_sandbox", "query_sandboxes",
    "get_snapshot", "query_snapshots", "query_sessions", "get_drive", "get_or_create_drive", "delete_drive",
    "query_drives",
    "Sandbox", "Process", "Snapshot", "SandboxFilesystem", "TextReader", "AsyncSandbox", "AsyncProcess",
    "AsyncSnapshot", "AsyncSandboxFilesystem", "AsyncTextReader", "AsyncFileHandle", "AsyncBatch",
    "CompletedProcess", "DirectoryEntry", "GitSource", "TarballSource", "SnapshotSource", "SnapshotRetention",
    "NetworkPolicy", "NetworkPolicyRule", "NetworkPolicySubnets", "NetworkPolicyTransform", "NetworkPolicyResponse",
    "NetworkPolicyReadback", "NetworkPolicyInjectionRuleSummary", "NetworkPolicyForwardRuleSummary",
    "NetworkPolicyResponseRuleSummary", "SandboxResources",
    "SandboxRoute", "SandboxStatus", "ProcessStatus", "SandboxQueryByName", "SandboxQueryByCreatedAt", "SandboxQueryByStatusUpdatedAt",
    "SandboxQueryByCurrentSnapshotId", "TagFilter",
    "SandboxError", "SandboxApiError", "SandboxCredentialsError", "SandboxPathNotFoundError", "SandboxTimeoutError",
    "SandboxStreamError", "SandboxTerminalStateError", "SandboxInvalidHandleError", "SandboxFilesystemError",
    "SandboxInteractiveError", "InteractiveSession", "InteractiveSessionOperation", "InteractiveStream",
    "NotSupportedError", "Drive", "DriveMount", "SandboxClient", "SandboxServiceOptions", "sync",
]
