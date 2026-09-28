"""Code written for E2B's Python SDK, on Runtime Cloud. Change the import:

    from withruntime.e2b import Sandbox  # was: from e2b import Sandbox

and set RUNTIME_API_KEY (or put a Runtime key in E2B_API_KEY). What Runtime
cannot do the way E2B does raises NotSupportedException, naming what to use."""
from ._async_sandbox import (AsyncCommandHandle, AsyncCommands, AsyncFilesystem, AsyncSandbox,
                             AsyncSandboxPaginator)
from ._core import (AuthenticationException, CommandExitException, CommandResult, EntryInfo,
                    FileNotFoundException, FileType, InvalidArgumentException, NotEnoughSpaceException,
                    NotFoundException, NotSupportedException, ProcessInfo, RateLimitException, SandboxException,
                    SandboxInfo, SandboxInfoLifecycle, SandboxNotFoundException, SandboxQuery,
                    ServiceBusyException, SnapshotInfo, TemplateException, TimeoutException, WriteInfo)
from ._core import unsupported as _unsupported
from ._sync_sandbox import CommandHandle, Commands, Filesystem, Sandbox, SandboxPaginator

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

__all__ = [
    "Sandbox", "AsyncSandbox", "Commands", "AsyncCommands", "CommandHandle", "AsyncCommandHandle", "Filesystem",
    "AsyncFilesystem", "SandboxPaginator", "AsyncSandboxPaginator", "CommandResult", "CommandExitException",
    "EntryInfo", "WriteInfo", "FileType", "ProcessInfo", "SandboxInfo", "SandboxInfoLifecycle", "SandboxQuery",
    "SnapshotInfo", "SandboxException", "TimeoutException", "InvalidArgumentException", "NotEnoughSpaceException",
    "NotFoundException", "FileNotFoundException", "SandboxNotFoundException", "AuthenticationException",
    "TemplateException", "RateLimitException", "ServiceBusyException", "NotSupportedException", "Template",
    "AsyncTemplate", "Volume", "AsyncVolume", "Secret", "AsyncSecret", "wait_for_port", "wait_for_url",
    "wait_for_process", "wait_for_file", "wait_for_timeout",
]
