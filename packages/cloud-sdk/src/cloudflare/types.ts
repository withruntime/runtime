/** The rest of @cloudflare/sandbox 0.12.10's exported types, in its shapes, so
 * TypeScript that names them still compiles after the import changes. Its
 * container clients (CommandClient and the others) are refused: Runtime's API
 * is the client. */
import { refusal } from "../compat/core.js";
import type { ExecResult, BucketProvider } from "./index.js";
import type { ExecutionError, OutputMessage, Result } from "./interpreter.js";

export interface ExecEvent {
  type: "start" | "stdout" | "stderr" | "complete" | "error";
  timestamp: string;
  data?: string;
  command?: string;
  exitCode?: number;
  result?: ExecResult;
  error?: string;
  sessionId?: string;
  pid?: number;
}
export interface LogEvent {
  type: "stdout" | "stderr" | "exit" | "error";
  timestamp: string;
  data: string;
  processId: string;
  sessionId?: string;
  exitCode?: number;
}
export interface ExecutionResult {
  code: string;
  logs: { stdout: string[]; stderr: string[] };
  error?: ExecutionError;
  executionCount?: number;
  results: {
    text?: string;
    html?: string;
    png?: string;
    jpeg?: string;
    svg?: string;
    latex?: string;
    markdown?: string;
    javascript?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cloudflare's own type
    json?: any;
    chart?: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cloudflare's own type
    data?: any;
  }[];
}
export type ProcessStatus = "starting" | "running" | "completed" | "failed" | "killed" | "error";
export interface ListFilesOptions {
  recursive?: boolean;
  includeHidden?: boolean;
  sessionId?: string;
}
export interface WaitForLogResult {
  line: string;
  match?: RegExpMatchArray;
}
export interface ExecutionCallbacks {
  onStdout?: (output: OutputMessage) => void | Promise<void>;
  onStderr?: (output: OutputMessage) => void | Promise<void>;
  onResult?: (result: Result) => void | Promise<void>;
  onError?: (error: ExecutionError) => void | Promise<void>;
}
export interface BaseExecOptions {
  timeout?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  encoding?: string;
}
export interface BucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}
export interface LocalMountBucketOptions {
  localBucket: true;
  prefix?: string;
  readOnly?: boolean;
}
export interface RemoteMountBucketOptions {
  endpoint: string;
  provider?: BucketProvider;
  credentials?: BucketCredentials;
  readOnly?: boolean;
  s3fsOptions?: string[];
  prefix?: string;
  credentialProxy?: boolean;
}
export interface PtyOptions {
  cols?: number;
  rows?: number;
  shell?: string;
}
export interface QuickTunnelInfo {
  id: string;
  port: number;
  url: string;
  hostname: string;
  createdAt: string;
  name?: never;
}
export interface NamedTunnelInfo {
  id: string;
  port: number;
  url: string;
  hostname: string;
  createdAt: string;
  name: string;
}
export type TunnelInfo = QuickTunnelInfo | NamedTunnelInfo;
export interface TunnelOptions {
  name?: string;
}
export interface DirectoryBackup {
  readonly id: string;
  readonly dir: string;
  readonly localBucket?: boolean;
}
export interface BackupOptions {
  dir: string;
  name?: string;
  ttl?: number;
  gitignore?: boolean;
  excludes?: string[];
  localBucket?: boolean;
  compression?: { format?: "gzip" | "lz4" | "zstd"; threads?: number };
  multipart?: boolean;
}
export interface RestoreBackupResult {
  success: boolean;
  dir: string;
  id: string;
}
export type FileWatchSSEEvent =
  | { type: "watching"; path: string; watchId: string }
  | {
      type: "event";
      eventType: "create" | "modify" | "delete" | "move_from" | "move_to" | "attrib";
      path: string;
      isDirectory: boolean;
      timestamp: string;
    }
  | { type: "error"; error: string }
  | { type: "stopped"; reason: string };
type ProcessRecord = {
  id: string;
  pid?: number;
  command: string;
  status: ProcessStatus;
  startTime: string;
  endTime?: string;
  exitCode?: number;
};
export interface BaseApiResponse {
  success: boolean;
  timestamp: string;
}
export interface ProcessStartResult extends BaseApiResponse {
  processId: string;
  pid?: number;
  command: string;
}
export interface ProcessListResult extends BaseApiResponse {
  processes: ProcessRecord[];
}
export interface ProcessInfoResult extends BaseApiResponse {
  process: ProcessRecord;
}
export interface ProcessKillResult extends BaseApiResponse {
  processId: string;
  signal?: string;
}
export interface ProcessLogsResult extends BaseApiResponse {
  processId: string;
  stdout: string;
  stderr: string;
}
export interface ProcessCleanupResult extends BaseApiResponse {
  message?: string;
  killedCount?: number;
  cleanedCount: number;
}
export type SandboxTransport = "http" | "websocket" | "rpc";
export type ContainerUnavailableReason =
  | "container_starting"
  | "container_unhealthy"
  | "container_replaced"
  | "rpc_upgrade_failed"
  | "no_container_instance_available"
  | "max_container_instances_exceeded"
  | "container_unreachable";
export interface ContainerUnavailableContext {
  reason: ContainerUnavailableReason;
  retryable: true;
  retryAfterMs?: number;
  originalMessage?: string;
}
export type OperationInterruptedReason =
  "runtime_replaced" | "transport_disposed" | "sandbox_lifetime_changed" | "recovery_exhausted";
export interface OperationInterruptedContext {
  reason: OperationInterruptedReason;
  operation: string;
  phase: string;
  admitted: boolean | "unknown";
  retryable: boolean;
  recoveryAttempts?: number;
  maxRecoveryAttempts?: number;
  containerExitCode?: number;
  stopReason?: string;
}
export type RPCTransportErrorKind =
  | "peer_closed"
  | "connection_failed"
  | "upgrade_failed"
  | "invalid_frame"
  | "protocol_error"
  | "session_disposed"
  | "unknown";
export interface RPCTransportContext {
  kind: RPCTransportErrorKind;
  originalMessage: string;
  errorName: string;
  closeCode?: number;
  closeReason?: string;
}
export interface ContainerStub {
  containerFetch(url: string, options: RequestInit, port?: number): Promise<Response>;
  fetch(request: Request): Promise<Response>;
}
// The container's HTTP API, which Runtime's API replaces.
export interface SessionRequest {
  sessionId?: string;
}
export interface CommandsResponse extends BaseApiResponse {
  availableCommands: string[];
  count: number;
}
export interface CommandExecuteResponse extends BaseApiResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}
export interface CreateSessionRequest {
  id: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  commandTimeoutMs?: number;
}
export interface CreateSessionResponse extends BaseApiResponse {
  id: string;
  message: string;
  containerPlacementId?: string | null;
}
export interface DeleteSessionRequest {
  sessionId: string;
}
export interface DeleteSessionResponse extends BaseApiResponse {
  sessionId: string;
}
export interface ExecuteRequest {
  command: string;
  sessionId?: string;
  background?: boolean;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  origin?: "user" | "internal";
}
export interface FileOperationRequest extends SessionRequest {
  path: string;
  newPath?: string;
}
export interface GitCheckoutRequest extends SessionRequest {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
  depth?: number;
  timeoutMs?: number;
}
export interface MkdirRequest extends SessionRequest {
  path: string;
  recursive?: boolean;
}
export interface PingResponse extends BaseApiResponse {
  message: string;
  uptime?: number;
}
export interface ReadFileRequest extends SessionRequest {
  path: string;
  encoding?: string;
}
export interface WriteFileRequest extends SessionRequest {
  path: string;
  content: string;
  encoding?: string;
}
export interface StartProcessRequest {
  command: string;
  sessionId?: string;
  processId?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  encoding?: string;
  autoCleanup?: boolean;
  origin?: "user" | "internal";
}
export interface RequestConfig extends RequestInit {
  endpoint: string;
  data?: Record<string, unknown>;
}
export type ResponseHandler<T> = (response: Response) => Promise<T>;
export interface SandboxClientOptions {
  baseUrl?: string;
  port?: number;
  stub?: ContainerStub;
  defaultHeaders?: Record<string, string>;
  retryTimeoutMs?: number;
}

const CLIENT = "Runtime's API is the client; call the Sandbox's methods";
function client(name: string): never {
  throw refusal("Cloudflare", name, CLIENT);
}

export class SandboxClient {
  constructor(..._args: unknown[]) {
    client("SandboxClient");
  }
}
export class CommandClient {
  constructor(..._args: unknown[]) {
    client("CommandClient");
  }
}
export class FileClient {
  constructor(..._args: unknown[]) {
    client("FileClient");
  }
}
export class GitClient {
  constructor(..._args: unknown[]) {
    client("GitClient");
  }
}
export class PortClient {
  constructor(..._args: unknown[]) {
    client("PortClient");
  }
}
export class ProcessClient {
  constructor(..._args: unknown[]) {
    client("ProcessClient");
  }
}
export class UtilityClient {
  constructor(..._args: unknown[]) {
    client("UtilityClient");
  }
}
export class BackupClient {
  constructor(..._args: unknown[]) {
    client("BackupClient");
  }
}
export class InterpreterClient {
  constructor(..._args: unknown[]) {
    client("InterpreterClient");
  }
}

// Cloudflare's platform-error predicates. Runtime's API answers in its own
// errors, so these match only the messages Cloudflare's platform uses.
const causes = function* (error: unknown) {
  for (let e = error, depth = 0; e != null && depth < 8; depth++) {
    yield e;
    e = (e as { cause?: unknown }).cause;
  }
};
const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "");
const RESET = /reset because its code was updated|this script has been upgraded/i;
export function isDurableObjectCodeUpdateReset(error: unknown): boolean {
  for (const e of causes(error)) if (RESET.test(message(e))) return true;
  return false;
}
export function isPlatformTransientError(error: unknown): boolean {
  for (const e of causes(error)) {
    const text = message(e);
    if (
      RESET.test(text) ||
      /network connection lost/i.test(text) ||
      /internal error while starting up durable object storage caused object to be reset/i.test(
        text,
      )
    )
      return true;
  }
  return false;
}
