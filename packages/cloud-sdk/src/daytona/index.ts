/** Code written for Daytona's SDK, on Runtime Cloud. Change the import:
 *
 *   import { Daytona } from "withruntime/daytona"; // was: from "@daytona/sdk" or "@daytonaio/sdk"
 *
 * and set RUNTIME_API_KEY (or put a Runtime key in DAYTONA_API_KEY), or run
 * `npx withruntime login` once. A Daytona key is never sent anywhere. What
 * Runtime cannot do the way Daytona does throws NotSupportedError, naming what
 * to use. */
import { NotSupportedError } from "./errors.js";

export {
  Daytona,
  CodeLanguage,
  SnapshotService,
  VolumeService,
  DEFAULT_RESOURCES,
  DEFAULT_AUTO_STOP_MINUTES,
  lifecycleOf,
  type CreateSandboxBaseParams,
  type CreateSandboxFromImageParams,
  type CreateSandboxFromSnapshotParams,
  type CreateSnapshotParams,
  type ForkSandboxParams,
  type ListSandboxesQuery,
  type PaginatedSnapshots,
  type Resources,
  type Snapshot,
  type Volume,
  type VolumeMount,
} from "./daytona.js";
export {
  Sandbox,
  CodeInterpreter,
  networkRules,
  windowSeconds,
  type ExecutionError,
  type ExecutionResult,
  type InterpreterContext,
  type OutputMessage,
  type PortPreviewUrl,
} from "./sandbox.js";
export {
  Process,
  CodeRunParams,
  PtyHandle,
  type PtyConnectOptions,
  type PtyCreateOptions,
  type PtyResult,
  type PtySessionInfo,
  type Command,
  type ExecuteResponse,
  type Session,
  type SessionCommandLogsResponse,
  type SessionExecuteRequest,
  type SessionExecuteResponse,
} from "./process.js";
export {
  FileSystem,
  type FileDownloadRequest,
  type FileDownloadResponse,
  type FileInfo,
  type FilePermissionsParams,
  type FileUpload,
  type Match,
  type ReplaceResult,
  type SearchFilesResponse,
  type UploadSource,
  type UploadProgress,
  type UploadStreamOptions,
} from "./filesystem.js";
export { Git, type GitStatus, type ListBranchResponse } from "./git.js";
export {
  Accessibility,
  ComputerUse,
  Display,
  Keyboard,
  Mouse,
  RecordingService,
  Screenshot,
  type ComputerUseStartResponse,
  type ComputerUseStatusResponse,
  type ComputerUseStopResponse,
  type DisplayInfo,
  type ListRecordingsResponse,
  type Recording,
  type ScreenshotOptions,
  type ScreenshotRegion,
  type ScreenshotResponse,
  type WindowInfo,
} from "./computer-use.js";
export { Image } from "./image.js";
export { resolvePath } from "./context.js";
export type { DaytonaConfig, WithRuntime } from "./client.js";
export * from "./errors.js";

/** Daytona's sandbox states, as strings. */
export const SandboxState = {
  STARTED: "started",
  STARTING: "starting",
  STOPPING: "stopping",
  STOPPED: "stopped",
  PAUSED: "paused",
  DESTROYING: "destroying",
  DESTROYED: "destroyed",
} as const;
export type SandboxState = (typeof SandboxState)[keyof typeof SandboxState];

/** A stand-in for a Daytona export Runtime has no counterpart for. Importing
 * it works; using it throws NotSupportedError naming the alternative. */
function unsupportedExport(name: string, alternative: string) {
  const fail = (): never => {
    throw new NotSupportedError(`Daytona's ${name}`, alternative);
  };
  return new Proxy(function unsupported() {}, {
    apply: fail,
    construct: fail,
    get: (_target, property) => {
      if (typeof property === "symbol" || property === "then" || property === "prototype")
        return undefined;
      return fail();
    },
  }) as unknown as {
    (...args: unknown[]): never;
    new (...args: unknown[]): never;
    readonly [key: string]: (...args: unknown[]) => never;
  };
}

export const LspLanguageId = unsupportedExport(
  "language servers",
  "Start one in a session with process.executeSessionCommand(..., { runAsync: true }).",
);
