"""Code written for Daytona's Python SDK, on Runtime Cloud. Change the import:

    from withruntime.daytona import Daytona  # was: from daytona import Daytona

and set RUNTIME_API_KEY (or put a Runtime key in DAYTONA_API_KEY), or run
`npx withruntime login` once. A Daytona key is never sent anywhere. What
Runtime cannot do the way Daytona does raises NotSupportedError, naming what
to use."""
from ._async_daytona import (AsyncAccessibility, AsyncCodeInterpreter, AsyncComputerUse, AsyncDaytona, AsyncDisplay,
                             AsyncFileSystem, AsyncGit, AsyncKeyboard, AsyncMouse, AsyncProcess,
                             AsyncRecordingService, AsyncSandbox, AsyncScreenshot, AsyncSnapshotService,
                             AsyncVolumeService)
from ._async_io import AsyncPtyHandle
from ._core import (CodeLanguage, CodeRunParams, Command, CreateSandboxBaseParams, CreateSandboxFromImageParams,
                    CreateSandboxFromSnapshotParams, CreateSnapshotParams, DaytonaAuthenticationError,
                    DaytonaAuthorizationError, DaytonaBadGatewayError, DaytonaBadRequestError,
                    DaytonaCommandAlreadyCompletedError, DaytonaConfig, DaytonaConflictError, DaytonaConnectionError,
                    DaytonaError, DaytonaFileNotFoundError, DaytonaForbiddenError, DaytonaGitAuthFailedError,
                    DaytonaGitBranchExistsError, DaytonaGitBranchNotFoundError, DaytonaGitMergeConflictError,
                    DaytonaGitPushRejectedError, DaytonaGitRepoNotFoundError, DaytonaGoneError,
                    DaytonaInternalServerError, DaytonaNotFoundError, DaytonaProcessExecutionTimeoutError,
                    DaytonaProcessNotFoundError, DaytonaRateLimitError, DaytonaServiceUnavailableError,
                    DaytonaSessionEndedError, DaytonaTimeoutError, DaytonaUnprocessableEntityError,
                    DaytonaValidationError, ExecuteResponse, ExecutionArtifacts, ExecutionError, ExecutionResult,
                    FileDownloadRequest, FileDownloadResponse, FileInfo, FileUpload, GitCommitResponse, GitStatus,
                    Image, InterpreterContext, ListBranchResponse, ListSandboxesQuery, Match, NotSupportedError,
                    OutputMessage, PaginatedSnapshots, PortPreviewUrl, PtyResult, PtySessionInfo, PtySize,
                    ReplaceResult, Resources, SandboxState, ScreenshotOptions, ScreenshotRegion,
                    SearchFilesResponse, Session, SessionCommandLogsResponse, SessionExecuteRequest,
                    SessionExecuteResponse, Snapshot, Volume, VolumeMount)
from ._core import unsupported as _unsupported
from ._sync_daytona import (Accessibility, CodeInterpreter, ComputerUse, Daytona, Display, FileSystem, Git, Keyboard,
                            Mouse, Process, RecordingService, Sandbox, Screenshot, SnapshotService, VolumeService)
from ._sync_io import PtyHandle

__version__ = "0.1.0"


class _Unsupported:
    """A Daytona export Runtime has no counterpart for: importing it works;
    using it raises NotSupportedError naming the alternative."""

    def __init__(self, name: str, alternative: str) -> None:
        self._refuse = _unsupported(f"Daytona's {name}", alternative)

    def __call__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return self._refuse()

    def __getattr__(self, name: str):  # type: ignore[no-untyped-def]
        if name.startswith("__"):
            raise AttributeError(name)
        return self._refuse()


LspLanguageId = _Unsupported("language servers", "Start one in a session with run_async=True.")

__all__ = [
    "Daytona", "AsyncDaytona", "DaytonaConfig", "Sandbox", "AsyncSandbox", "Process", "AsyncProcess", "FileSystem",
    "AsyncFileSystem", "Git", "AsyncGit", "CodeInterpreter", "AsyncCodeInterpreter", "SnapshotService",
    "AsyncSnapshotService", "VolumeService", "AsyncVolumeService", "CodeLanguage", "CodeRunParams", "Command",
    "CreateSandboxBaseParams", "CreateSandboxFromImageParams", "CreateSandboxFromSnapshotParams",
    "CreateSnapshotParams", "ExecuteResponse", "ExecutionArtifacts", "ExecutionError", "ExecutionResult",
    "FileDownloadRequest", "FileDownloadResponse", "FileInfo", "FileUpload", "GitCommitResponse", "GitStatus", "Image",
    "InterpreterContext", "ListBranchResponse", "ListSandboxesQuery", "Match", "OutputMessage", "PaginatedSnapshots",
    "PortPreviewUrl", "ReplaceResult", "Resources", "SandboxState", "SearchFilesResponse", "Session",
    "SessionCommandLogsResponse", "SessionExecuteRequest", "SessionExecuteResponse", "Snapshot", "Volume",
    "VolumeMount", "DaytonaError", "DaytonaAuthenticationError", "DaytonaAuthorizationError", "DaytonaBadGatewayError",
    "DaytonaBadRequestError", "DaytonaCommandAlreadyCompletedError", "DaytonaConflictError", "DaytonaConnectionError",
    "DaytonaFileNotFoundError", "DaytonaForbiddenError", "DaytonaGitAuthFailedError", "DaytonaGitBranchExistsError",
    "DaytonaGitBranchNotFoundError", "DaytonaGitMergeConflictError", "DaytonaGitPushRejectedError",
    "DaytonaGitRepoNotFoundError", "DaytonaGoneError", "DaytonaInternalServerError", "DaytonaNotFoundError",
    "DaytonaProcessExecutionTimeoutError", "DaytonaProcessNotFoundError", "DaytonaRateLimitError",
    "DaytonaServiceUnavailableError", "DaytonaSessionEndedError", "DaytonaTimeoutError",
    "DaytonaUnprocessableEntityError", "DaytonaValidationError", "NotSupportedError", "ComputerUse",
    "AsyncComputerUse", "Mouse", "AsyncMouse", "Keyboard", "AsyncKeyboard", "Screenshot", "AsyncScreenshot",
    "Display", "AsyncDisplay", "RecordingService", "AsyncRecordingService", "Accessibility", "AsyncAccessibility",
    "ScreenshotOptions", "ScreenshotRegion", "LspLanguageId", "PtySize", "PtyResult", "PtySessionInfo", "PtyHandle",
    "AsyncPtyHandle",
]
