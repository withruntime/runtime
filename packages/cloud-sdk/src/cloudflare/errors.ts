/** Cloudflare's exported error classes, with its fields, so a caller's
 * `instanceof` and `error.code` keep working. The adapter throws them where
 * Cloudflare would: a process that never becomes ready, a bucket that will
 * not mount or unmount. */
export type ErrorResponse<TContext = Record<string, unknown>> = {
  code: string;
  message: string;
  operation?: string;
  context: TContext;
  httpStatus: number;
  timestamp: string;
  suggestion?: string;
  documentation?: string;
};

class SandboxError<TContext = Record<string, unknown>> extends Error {
  readonly errorResponse: ErrorResponse<TContext>;
  constructor(errorResponse: ErrorResponse<TContext>, options?: { cause?: unknown }) {
    super(errorResponse.message, options);
    this.name = new.target.name;
    this.errorResponse = errorResponse;
  }
  get code() {
    return this.errorResponse.code;
  }
  get context() {
    return this.errorResponse.context;
  }
  get httpStatus() {
    return this.errorResponse.httpStatus;
  }
  get operation() {
    return this.errorResponse.operation;
  }
  get suggestion() {
    return this.errorResponse.suggestion;
  }
  get timestamp() {
    return this.errorResponse.timestamp;
  }
  get documentation() {
    return this.errorResponse.documentation;
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      httpStatus: this.httpStatus,
      operation: this.operation,
      suggestion: this.suggestion,
      timestamp: this.timestamp,
      documentation: this.documentation,
      stack: this.stack,
    };
  }
}
export { SandboxError };

export class SessionTerminatedError extends SandboxError<{
  sessionId: string;
  exitCode: number | null;
}> {
  get sessionId() {
    return this.context.sessionId;
  }
  get exitCode() {
    return this.context.exitCode;
  }
}
type ReadyContext = { processId: string; command: string; condition: string };
export class ProcessReadyTimeoutError extends SandboxError<ReadyContext & { timeout: number }> {
  get processId() {
    return this.context.processId;
  }
  get command() {
    return this.context.command;
  }
  get condition() {
    return this.context.condition;
  }
  get timeout() {
    return this.context.timeout;
  }
}
export class ProcessExitedBeforeReadyError extends SandboxError<
  ReadyContext & { exitCode: number }
> {
  get processId() {
    return this.context.processId;
  }
  get command() {
    return this.context.command;
  }
  get condition() {
    return this.context.condition;
  }
  get exitCode() {
    return this.context.exitCode;
  }
}
export class BackupNotFoundError extends SandboxError<{ backupId: string }> {
  get backupId() {
    return this.context.backupId;
  }
}
export class BackupExpiredError extends SandboxError<{ backupId: string; expiredAt?: string }> {
  get backupId() {
    return this.context.backupId;
  }
  get expiredAt() {
    return this.context.expiredAt;
  }
}
export class InvalidBackupConfigError extends SandboxError<{ reason: string }> {
  get reason() {
    return this.context.reason;
  }
}
export class BackupCreateError extends SandboxError<{
  dir: string;
  backupId?: string;
  stderr?: string;
  exitCode?: number;
}> {
  get dir() {
    return this.context.dir;
  }
  get backupId() {
    return this.context.backupId;
  }
}
export class BackupRestoreError extends SandboxError<{
  dir: string;
  backupId: string;
  stderr?: string;
  exitCode?: number;
}> {
  get dir() {
    return this.context.dir;
  }
  get backupId() {
    return this.context.backupId;
  }
}
export class ContainerUnavailableError extends SandboxError<{
  reason: string;
  retryable: true;
  retryAfterMs?: number;
  originalMessage?: string;
}> {
  get reason() {
    return this.context.reason;
  }
  get retryAfterMs() {
    return this.context.retryAfterMs;
  }
}
export class OperationInterruptedError extends SandboxError<{
  reason: string;
  operation: string;
  phase: string;
  admitted: boolean | "unknown";
  retryable: boolean;
}> {
  get reason() {
    return this.context.reason;
  }
}

/** Cloudflare's transport error for its WebSocket sessions; Runtime's API
 * has no such session, so the adapter never throws it. */
export class RPCTransportError extends SandboxError<{ kind: string; originalMessage: string }> {
  get kind() {
    return this.context.kind;
  }
  get originalMessage() {
    return this.context.originalMessage;
  }
}
/** Input the container refuses, such as content that is not base64. */
export class ValidationFailedError extends SandboxError<{
  validationErrors: { field: string; message: string; code: string }[];
}> {
  get validationErrors() {
    return this.context.validationErrors;
  }
}

export class BucketMountError extends Error {
  readonly code: string;
  constructor(message: string, code = "BUCKET_MOUNT_ERROR") {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
export class S3FSMountError extends BucketMountError {
  constructor(message: string) {
    super(message, "S3FS_MOUNT_ERROR");
  }
}
export class BucketUnmountError extends BucketMountError {
  constructor(message: string) {
    super(message, "BUCKET_UNMOUNT_ERROR");
  }
}
export class MissingCredentialsError extends BucketMountError {
  constructor(message: string) {
    super(message, "MISSING_CREDENTIALS");
  }
}
export class InvalidMountConfigError extends BucketMountError {
  constructor(message: string) {
    super(message, "INVALID_MOUNT_CONFIG");
  }
}

/** An ErrorResponse as the container would send it. */
export function response<TContext>(
  code: string,
  message: string,
  context: TContext,
  extra: { httpStatus?: number; operation?: string; suggestion?: string } = {},
): ErrorResponse<TContext> {
  return {
    code,
    message,
    context,
    httpStatus: extra.httpStatus ?? 500,
    timestamp: new Date().toISOString(),
    ...(extra.operation ? { operation: extra.operation } : {}),
    ...(extra.suggestion ? { suggestion: extra.suggestion } : {}),
  };
}
