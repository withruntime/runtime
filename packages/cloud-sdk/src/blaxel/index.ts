/** Code written for Blaxel's sandbox SDK (`@blaxel/core`), on Runtime Cloud.
 * Change the import:
 *
 *   import { SandboxInstance } from "withruntime/blaxel"; // was: from "@blaxel/core"
 *
 * and set RUNTIME_API_KEY, or run `npx withruntime login` once. A Blaxel key
 * (BL_API_KEY) is never sent anywhere. Every name `@blaxel/core` 0.3.23
 * exports can be imported; what Runtime cannot do the way Blaxel does throws
 * NotSupportedError, naming what to use. */
import { RuntimeError } from "../errors.js";
import { initialize, type Config } from "./client.js";
import { NotSupportedError } from "./errors.js";
import { CODEGEN, DRIVES, SCHEDULES, SESSIONS, SYSTEM, unsupportedExport } from "./unsupported.js";

export {
  SandboxInstance,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY,
  MEMORY_PER_VCPU,
  durationMs,
  imageRef,
  lifetimeOf,
  networkRules,
  type SandboxListQuery,
  type SandboxForkOptions,
  type SandboxArchiveOptions,
} from "./sandbox.js";
export { CodeInterpreter } from "./interpreter.js";
export {
  SandboxFileSystem,
  retryOnTransient,
  type File,
  type FileWithContent,
  type Subdirectory,
  type Directory,
  type SuccessResponse,
  type FindMatch,
  type FindResponse,
  type FuzzySearchMatch,
  type FuzzySearchResponse,
  type ContentSearchMatch,
  type ContentSearchResponse,
  type CopyResponse,
  type WatchEvent,
  type SandboxFilesystemFile,
  type FilesystemSearchOptions,
  type FilesystemFindOptions,
  type FilesystemGrepOptions,
} from "./filesystem.js";
export {
  SandboxProcess,
  type ProcessRequest,
  type ProcessResponse,
  type ProcessRequestWithLog,
  type ProcessResponseWithLog,
  type PostProcessResponse,
  type GetProcessResponse,
  type GetProcessByIdentifierResponse,
  type DeleteProcessByIdentifierResponse,
  type DeleteProcessByIdentifierKillResponse,
  type ProcessLogs,
} from "./process.js";
export {
  SandboxPreview,
  SandboxPreviews,
  SandboxPreviewToken,
  SandboxPreviewTokens,
  type Preview,
  type PreviewMetadata,
  type PreviewSpec,
  type PreviewToken,
} from "./preview.js";
export {
  Snapshot,
  SandboxSnapshotsResource,
  type Env,
  type SandboxSnapshot,
  type SandboxSnapshotSource,
  type SandboxSnapshotSpec,
  type SandboxForkResponse,
  type SandboxRestoreResponse,
  type SnapshotCreateConfiguration,
  type SnapshotForkOptions,
  type SnapshotListQuery,
} from "./snapshot.js";
export {
  ResponseError,
  SandboxGatewayError,
  isGatewayError,
  isGatewayTimeout,
  CredentialsError,
  NotSupportedError,
} from "./errors.js";
export {
  createPaginatedList,
  unwrapListData,
  type PaginatedList,
  type PaginatedListMeta,
  type ListResponse,
  type CursorPaginationQuery,
  type AutoPagingEachCallback,
  type AutoPagingToArrayOptions,
} from "./pagination.js";
export {
  normalizePorts,
  normalizeEnvs,
  normalizeVolumes,
  type Status,
  type Port,
  type EnvVar,
  type ExpirationPolicy,
  type SandboxLifecycle,
  type SandboxNetwork,
  type VolumeBinding,
  type VolumeAttachment,
  type Metadata,
  type SandboxRuntime,
  type SandboxSpec,
  type CoreEvent,
  type Sandbox,
  type SandboxConfiguration,
  type SandboxCreateConfiguration,
  type SandboxUpdateMetadata,
  type SandboxUpdateNetwork,
  type SessionCreateOptions,
  type SessionWithToken,
} from "./types.js";
export { initialize, type Config, type WithRuntime, type RuntimeOptions } from "./client.js";

/** Blaxel authenticates on first use; Runtime's SDK finds its key itself. */
export async function authenticate(): Promise<void> {}
/** Runtime's SDK closes idle connections itself. */
export async function closeConnections(): Promise<void> {}
export function ensureAutoloaded(): void {}

/** A failure worth retrying once more: Runtime's SDK retries these itself. */
export function isTransientUploadError(error: unknown): boolean {
  return error instanceof RuntimeError && error.retryable;
}

/** The process environment, read-only, as Blaxel's `env`. */
export const env: { readonly [key: string]: string | undefined } = new Proxy(
  {},
  {
    get: (_target, property) =>
      typeof property === "string" && typeof process !== "undefined"
        ? process.env[property]
        : undefined,
  },
);

type LoggerInterface = {
  info: (message: string) => void;
  debug: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};
let sink: LoggerInterface = {
  info: (message) => console.info(message),
  debug: (message) => console.debug(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
const text = (parts: unknown[]) =>
  parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
/** Blaxel's logger: to the console, or to the logger given to setLogger. */
export const logger = {
  setLogger(next: LoggerInterface) {
    sink = next;
  },
  info: (...message: unknown[]) => sink.info(text(message)),
  debug: (...message: unknown[]) => sink.debug(text(message)),
  warn: (...message: unknown[]) => sink.warn(text(message)),
  error: (...message: unknown[]) => sink.error(text(message)),
};

/** Blaxel's settings, as far as they mean anything on Runtime. `setConfig`
 * takes a Runtime key as `apikey`; anything else throws NotSupportedError. */
export const settings: {
  readonly env: string;
  readonly region: string | undefined;
  readonly workspace: string;
  setConfig(config: Config): void;
  authenticate(): Promise<void>;
  readonly [key: string]: unknown;
} = new Proxy(
  {
    get env() {
      return "prod";
    },
    get region() {
      return env.BL_REGION || undefined;
    },
    get workspace() {
      return env.BL_WORKSPACE ?? "";
    },
    setConfig: (config: Config) => initialize(config),
    authenticate,
  },
  {
    get: (target, property) => {
      if (property in target || typeof property === "symbol" || property === "then")
        return Reflect.get(target, property) as unknown;
      throw new NotSupportedError(
        `Blaxel's settings.${property}`,
        "Runtime's SDK is configured by RUNTIME_API_KEY (or `npx withruntime login`) and RUNTIME_API_URL.",
      );
    },
  },
);

/* The sandbox parts Runtime has no counterpart for. On a sandbox they are
   objects whose methods reject; as exports, stand-ins. */
export const SandboxSessions = unsupportedExport("SandboxSessions", SESSIONS);
export const SandboxSchedules = unsupportedExport("SandboxSchedules", SCHEDULES);
export const SandboxCodegen = unsupportedExport("SandboxCodegen", CODEGEN);
export const SandboxSystem = unsupportedExport("SandboxSystem", SYSTEM);
export const SandboxDrive = unsupportedExport("SandboxDrive", DRIVES);

/* Blaxel's other products: agents, models, tools, MCP, jobs, applications,
   drives, volumes and images. Importable; using one throws. */
const AGENTS =
  "Runtime runs your agent's tools, not the agent: run it in your own process and give it sandboxes with SandboxInstance, or use withruntime/ai, withruntime/claude-agent-sdk or withruntime/openai-agents.";
const MODELS = "Call your model provider's SDK directly; Runtime does not proxy models.";
const TOOLS =
  "Give your agent Runtime's sandbox tools: `import { tools } from \"withruntime/tools\"`, or Runtime's MCP server (`npx withruntime mcp`).";
const MCP =
  "Serve MCP from a sandbox and share its port with sandbox.previews.create, or use Runtime's own MCP server (`npx withruntime mcp`).";
const JOBS =
  "Run the batch as processes in sandboxes: SandboxInstance.create, then sandbox.process.exec for each task.";
const IMAGES =
  "Build a Runtime image and create sandboxes from it by name: `npx withruntime image build --dockerfile Dockerfile --name <image>` or runtime.images.build({ name, dockerfile | image }).";
const VOLUMES =
  'Use Runtime volumes: runtime.volumes.create({ name }) (`import { Runtime } from "withruntime"`), then pass volumes: [{ name, mountPath }] at create.';
const HOSTING = "Serve it from a sandbox and share its port with sandbox.previews.create.";
const TELEMETRY =
  "Send your own traces; Runtime exports sandbox metrics and events with runtime.otel (OpenTelemetry).";
const INTERNALS = "It is a Blaxel SDK internal with no meaning on Runtime; remove the call.";
const NODE = (module: string) => `Import it from node:${module}.`;

export const blAgent = unsupportedExport("blAgent", AGENTS);
export const getAgentMetadata = unsupportedExport("getAgentMetadata", AGENTS);
export const ApplicationInstance = unsupportedExport("ApplicationInstance", HOSTING);
export const DriveInstance = unsupportedExport("DriveInstance", DRIVES);
export const VolumeInstance = unsupportedExport("VolumeInstance", VOLUMES);
export const ImageInstance = unsupportedExport("ImageInstance", IMAGES);
export const SANDBOX_API_IMAGE = unsupportedExport("SANDBOX_API_IMAGE", IMAGES);
export const SANDBOX_API_PATH = unsupportedExport("SANDBOX_API_PATH", IMAGES);
export const blJob = unsupportedExport("blJob", JOBS);
export const blStartJob = unsupportedExport("blStartJob", JOBS);
export const BlaxelMcpClientTransport = unsupportedExport("BlaxelMcpClientTransport", MCP);
export const BlaxelMcpServerTransport = unsupportedExport("BlaxelMcpServerTransport", MCP);
export const BLModel = unsupportedExport("BLModel", MODELS);
export const blModel = unsupportedExport("blModel", MODELS);
export const getModelMetadata = unsupportedExport("getModelMetadata", MODELS);
export const getTool = unsupportedExport("getTool", TOOLS);
export const BLTools = unsupportedExport("BLTools", TOOLS);
export const blTools = unsupportedExport("blTools", TOOLS);
export const blTool = unsupportedExport("blTool", TOOLS);
export const startSpan = unsupportedExport("startSpan", TELEMETRY);
export const withSpan = unsupportedExport("withSpan", TELEMETRY);
export const flush = unsupportedExport("flush", TELEMETRY);
export const telemetryRegistry = unsupportedExport("telemetryRegistry", TELEMETRY);
export const verifyWebhookSignature = unsupportedExport(
  "verifyWebhookSignature",
  "Runtime signs its own webhooks: verify them as runtime.webhooks describes (BLAXEL.md links it).",
);
export const verifyWebhookFromRequest = unsupportedExport(
  "verifyWebhookFromRequest",
  "Runtime signs its own webhooks: verify them as runtime.webhooks describes (BLAXEL.md links it).",
);
export const parseSemver = unsupportedExport("parseSemver", INTERNALS);
export const isBrokenBunVersion = unsupportedExport("isBrokenBunVersion", INTERNALS);
export const detectBunVersion = unsupportedExport("detectBunVersion", INTERNALS);
export const isBrokenBunH2Runtime = unsupportedExport("isBrokenBunH2Runtime", INTERNALS);
export const BUN_H2_FIXED_VERSION = unsupportedExport("BUN_H2_FIXED_VERSION", INTERNALS);
export const H2_DEFAULT_CONNECTION_WINDOW_BYTES = unsupportedExport(
  "H2_DEFAULT_CONNECTION_WINDOW_BYTES",
  INTERNALS,
);
export const getWebSocket = unsupportedExport("getWebSocket", INTERNALS);
export const handleDynamicImportError = unsupportedExport("handleDynamicImportError", INTERNALS);
export const getAlphanumericLimitedHash = unsupportedExport(
  "getAlphanumericLimitedHash",
  INTERNALS,
);
export const getGlobalUniqueHash = unsupportedExport("getGlobalUniqueHash", INTERNALS);
export const pluralize = unsupportedExport("pluralize", INTERNALS);
export const getForcedUrl = unsupportedExport("getForcedUrl", INTERNALS);
export const stringify = unsupportedExport("stringify", INTERNALS);
export const crypto = unsupportedExport("crypto", NODE("crypto"));
export const dotenv = unsupportedExport("dotenv", "Import it from the dotenv package.");
export const fs = unsupportedExport("fs", NODE("fs"));
export const os = unsupportedExport("os", NODE("os"));
export const path = unsupportedExport("path", NODE("path"));

/* Blaxel's generated API functions (control plane and sandbox API): Runtime
   has its own API, reached through SandboxInstance here or the withruntime
   SDK. Each is importable and throws NotSupportedError when called. */
const API =
  'Use SandboxInstance (create, get, list, delete, update*) and its parts here, or Runtime\'s own SDK: `import { Runtime } from "withruntime"`.';
const SANDBOX_API =
  "Use the sandbox's parts: sandbox.process, sandbox.fs, sandbox.fetch and sandbox.codegen.";
const api = (name: string) => unsupportedExport(`API function ${name}`, API);
const sandboxApi = (name: string) => unsupportedExport(`sandbox API function ${name}`, SANDBOX_API);

export const listAgents = api("listAgents");
export const createAgent = api("createAgent");
export const deleteAgent = api("deleteAgent");
export const getAgent = api("getAgent");
export const updateAgent = api("updateAgent");
export const listAgentRevisions = api("listAgentRevisions");
export const listApplications = api("listApplications");
export const createApplication = api("createApplication");
export const deleteApplication = api("deleteApplication");
export const getApplication = api("getApplication");
export const updateApplication = api("updateApplication");
export const createApplicationCustomDomain = api("createApplicationCustomDomain");
export const listApplicationRevisions = api("listApplicationRevisions");
export const getChangelog = api("getChangelog");
export const getConfiguration = api("getConfiguration");
export const listCustomDomains = api("listCustomDomains");
export const createCustomDomain = api("createCustomDomain");
export const deleteCustomDomain = api("deleteCustomDomain");
export const getCustomDomain = api("getCustomDomain");
export const updateCustomDomain = api("updateCustomDomain");
export const listCustomDomainShares = api("listCustomDomainShares");
export const shareCustomDomain = api("shareCustomDomain");
export const unshareCustomDomain = api("unshareCustomDomain");
export const verifyCustomDomain = api("verifyCustomDomain");
export const listDrives = api("listDrives");
export const createDrive = api("createDrive");
export const deleteDrive = api("deleteDrive");
export const getDrive = api("getDrive");
export const updateDrive = api("updateDrive");
export const createDriveAccessToken = api("createDriveAccessToken");
export const getDriveByExternalId = api("getDriveByExternalId");
export const getDriveJwks = api("getDriveJwks");
export const listAllEgressGateways = api("listAllEgressGateways");
export const getEgressGatewayUsage = api("getEgressGatewayUsage");
export const listAllEgressIps = api("listAllEgressIps");
export const getWorkspaceFeatures = api("getWorkspaceFeatures");
export const testFeatureFlag = api("testFeatureFlag");
export const listFunctions = api("listFunctions");
export const createFunction = api("createFunction");
export const deleteFunction = api("deleteFunction");
export const getFunction = api("getFunction");
export const updateFunction = api("updateFunction");
export const listFunctionRevisions = api("listFunctionRevisions");
export const cleanupImages = api("cleanupImages");
export const listImages = api("listImages");
export const createImage = api("createImage");
export const deleteImage = api("deleteImage");
export const getImage = api("getImage");
export const listImageShares = api("listImageShares");
export const shareImage = api("shareImage");
export const unshareImage = api("unshareImage");
export const listImageTags = api("listImageTags");
export const deleteImageTag = api("deleteImageTag");
export const getIntegration = api("getIntegration");
export const listIntegrationConnections = api("listIntegrationConnections");
export const createIntegrationConnection = api("createIntegrationConnection");
export const deleteIntegrationConnection = api("deleteIntegrationConnection");
export const getIntegrationConnection = api("getIntegrationConnection");
export const updateIntegrationConnection = api("updateIntegrationConnection");
export const getIntegrationConnectionModelEndpointConfigurations = api(
  "getIntegrationConnectionModelEndpointConfigurations",
);
export const listIntegrationConnectionModels = api("listIntegrationConnectionModels");
export const getIntegrationConnectionModel = api("getIntegrationConnectionModel");
export const listJobs = api("listJobs");
export const createJob = api("createJob");
export const deleteJob = api("deleteJob");
export const getJob = api("getJob");
export const updateJob = api("updateJob");
export const listJobExecutions = api("listJobExecutions");
export const createJobExecution = api("createJobExecution");
export const deleteJobExecution = api("deleteJobExecution");
export const getJobExecution = api("getJobExecution");
export const listJobExecutionTasks = api("listJobExecutionTasks");
export const listJobRevisions = api("listJobRevisions");
export const listLocations = api("listLocations");
export const listMcpHubDefinitions = api("listMcpHubDefinitions");
export const listModels = api("listModels");
export const createModel = api("createModel");
export const deleteModel = api("deleteModel");
export const getModel = api("getModel");
export const updateModel = api("updateModel");
export const listModelRevisions = api("listModelRevisions");
export const listPendingImageShares = api("listPendingImageShares");
export const acceptImageShare = api("acceptImageShare");
export const declineImageShare = api("declineImageShare");
export const listPolicies = api("listPolicies");
export const createPolicy = api("createPolicy");
export const deletePolicy = api("deletePolicy");
export const getPolicy = api("getPolicy");
export const updatePolicy = api("updatePolicy");
export const getPolicyUsages = api("getPolicyUsages");
export const listPublicIps = api("listPublicIps");
export const listSandboxHubDefinitions = api("listSandboxHubDefinitions");
export const listSandboxes = api("listSandboxes");
export const createSandbox = api("createSandbox");
export const deleteSandbox = api("deleteSandbox");
export const getSandbox = api("getSandbox");
export const updateSandbox = api("updateSandbox");
export const archiveSandbox = api("archiveSandbox");
export const forkSandbox = api("forkSandbox");
export const listSandboxPreviews = api("listSandboxPreviews");
export const createSandboxPreview = api("createSandboxPreview");
export const deleteSandboxPreview = api("deleteSandboxPreview");
export const getSandboxPreview = api("getSandboxPreview");
export const updateSandboxPreview = api("updateSandboxPreview");
export const listSandboxPreviewTokens = api("listSandboxPreviewTokens");
export const createSandboxPreviewToken = api("createSandboxPreviewToken");
export const deleteSandboxPreviewToken = api("deleteSandboxPreviewToken");
export const listSandboxScheduleExecutions = api("listSandboxScheduleExecutions");
export const listSandboxSchedules = api("listSandboxSchedules");
export const createSandboxSchedule = api("createSandboxSchedule");
export const deleteSandboxSchedule = api("deleteSandboxSchedule");
export const getSandboxSchedule = api("getSandboxSchedule");
export const updateSandboxSchedule = api("updateSandboxSchedule");
export const listSandboxSnapshots = api("listSandboxSnapshots");
export const createSandboxSnapshot = api("createSandboxSnapshot");
export const deleteSandboxSnapshot = api("deleteSandboxSnapshot");
export const restoreSandboxSnapshot = api("restoreSandboxSnapshot");
export const unarchiveSandbox = api("unarchiveSandbox");
export const getSandboxByExternalId = api("getSandboxByExternalId");
export const listScheduleExecutions = api("listScheduleExecutions");
export const listSchedules = api("listSchedules");
export const getSandboxScheduleMetrics = api("getSandboxScheduleMetrics");
export const getWorkspaceServiceAccounts = api("getWorkspaceServiceAccounts");
export const createWorkspaceServiceAccount = api("createWorkspaceServiceAccount");
export const deleteWorkspaceServiceAccount = api("deleteWorkspaceServiceAccount");
export const updateWorkspaceServiceAccount = api("updateWorkspaceServiceAccount");
export const listApiKeysForServiceAccount = api("listApiKeysForServiceAccount");
export const createApiKeyForServiceAccount = api("createApiKeyForServiceAccount");
export const deleteApiKeyForServiceAccount = api("deleteApiKeyForServiceAccount");
export const listSnapshots = api("listSnapshots");
export const createSnapshot = api("createSnapshot");
export const deleteSnapshot = api("deleteSnapshot");
export const getSnapshot = api("getSnapshot");
export const forkSnapshot = api("forkSnapshot");
export const listTemplates = api("listTemplates");
export const getTemplate = api("getTemplate");
export const listWorkspaceUsers = api("listWorkspaceUsers");
export const inviteWorkspaceUser = api("inviteWorkspaceUser");
export const removeWorkspaceUser = api("removeWorkspaceUser");
export const updateWorkspaceUserRole = api("updateWorkspaceUserRole");
export const listVolumeTemplates = api("listVolumeTemplates");
export const createVolumeTemplate = api("createVolumeTemplate");
export const deleteVolumeTemplate = api("deleteVolumeTemplate");
export const getVolumeTemplate = api("getVolumeTemplate");
export const updateVolumeTemplate = api("updateVolumeTemplate");
export const deleteVolumeTemplateVersion = api("deleteVolumeTemplateVersion");
export const listVolumes = api("listVolumes");
export const createVolume = api("createVolume");
export const deleteVolume = api("deleteVolume");
export const getVolume = api("getVolume");
export const updateVolume = api("updateVolume");
export const getVolumeByExternalId = api("getVolumeByExternalId");
export const listVpcs = api("listVpcs");
export const createVpc = api("createVpc");
export const deleteVpc = api("deleteVpc");
export const getVpc = api("getVpc");
export const listEgressGateways = api("listEgressGateways");
export const createEgressGateway = api("createEgressGateway");
export const deleteEgressGateway = api("deleteEgressGateway");
export const getEgressGateway = api("getEgressGateway");
export const listEgressIps = api("listEgressIps");
export const createEgressIp = api("createEgressIp");
export const deleteEgressIp = api("deleteEgressIp");
export const getEgressIp = api("getEgressIp");
export const listWorkspaces = api("listWorkspaces");
export const createWorkspace = api("createWorkspace");
export const deleteWorkspace = api("deleteWorkspace");
export const getWorkspace = api("getWorkspace");
export const updateWorkspace = api("updateWorkspace");
export const leaveWorkspace = api("leaveWorkspace");
export const checkWorkspaceAvailability = api("checkWorkspaceAvailability");
export const deleteFilesystemByPath = sandboxApi("deleteFilesystemByPath");
export const deleteNetworkProcessByPidMonitor = sandboxApi("deleteNetworkProcessByPidMonitor");
export const deleteProcessByIdentifier = sandboxApi("deleteProcessByIdentifier");
export const deleteProcessByIdentifierKill = sandboxApi("deleteProcessByIdentifierKill");
export const getFilesystemByPath = sandboxApi("getFilesystemByPath");
export const getNetworkProcessByPidPorts = sandboxApi("getNetworkProcessByPidPorts");
export const putCodegenFastapplyByPath = sandboxApi("putCodegenFastapplyByPath");
export const getCodegenRerankingByPath = sandboxApi("getCodegenRerankingByPath");
export const getProcess = sandboxApi("getProcess");
export const getProcessByIdentifier = sandboxApi("getProcessByIdentifier");
export const getProcessByIdentifierLogs = sandboxApi("getProcessByIdentifierLogs");
export const getProcessByIdentifierLogsStream = sandboxApi("getProcessByIdentifierLogsStream");
export const postNetworkProcessByPidMonitor = sandboxApi("postNetworkProcessByPidMonitor");
export const postProcess = sandboxApi("postProcess");
export const putFilesystemByPath = sandboxApi("putFilesystemByPath");
