import { RuntimeError } from "../errors.js";

/* Daytona's error classes by the same names and parents, so a
   `catch (e) { if (e instanceof DaytonaNotFoundError) ... }` written for
   Daytona keeps working. One made from a Runtime answer carries Runtime's
   `code`, `hint` and `requestId`, and the original error as `cause`. */

export const SOURCE_API = "DAYTONA_API";
export const SOURCE_DAEMON = "DAYTONA_DAEMON";
export const SOURCE_PROXY = "DAYTONA_PROXY";

export class DaytonaError extends Error {
  statusCode?: number;
  code?: string;
  readonly source?: string;
  headers?: unknown;
  hint?: string;
  requestId?: string;
  constructor(
    message: string,
    statusCode?: number,
    headers?: unknown,
    code?: string,
    source?: string,
  ) {
    super(message);
    this.name = new.target.name;
    if (statusCode !== undefined) this.statusCode = statusCode;
    if (headers !== undefined) this.headers = headers;
    if (code !== undefined) this.code = code;
    if (source !== undefined) this.source = source;
  }
  /** Daytona's older name for `code`. */
  get errorCode(): string | undefined {
    return this.code;
  }
}
export class DaytonaBadRequestError extends DaytonaError {}
export class DaytonaAuthenticationError extends DaytonaError {}
export class DaytonaForbiddenError extends DaytonaError {}
export class DaytonaNotFoundError extends DaytonaError {}
export class DaytonaTimeoutError extends DaytonaError {}
export class DaytonaConflictError extends DaytonaError {}
export class DaytonaGoneError extends DaytonaError {}
export class DaytonaUnprocessableEntityError extends DaytonaError {}
export class DaytonaRateLimitError extends DaytonaError {}
export class DaytonaInternalServerError extends DaytonaError {}
export class DaytonaBadGatewayError extends DaytonaError {}
export class DaytonaServiceUnavailableError extends DaytonaError {}
export class DaytonaValidationError extends DaytonaBadRequestError {}
export class DaytonaAuthorizationError extends DaytonaForbiddenError {}
export class DaytonaInvalidArgumentError extends DaytonaValidationError {}
export class DaytonaConnectionError extends DaytonaError {}
export class DaytonaConnectionTimeoutError extends DaytonaConnectionError {}
export class DaytonaGitAuthFailedError extends DaytonaAuthenticationError {}
export class DaytonaGitRepoNotFoundError extends DaytonaNotFoundError {}
export class DaytonaGitBranchNotFoundError extends DaytonaNotFoundError {}
export class DaytonaGitBranchExistsError extends DaytonaConflictError {}
export class DaytonaGitPushRejectedError extends DaytonaConflictError {}
export class DaytonaGitDirtyWorktreeError extends DaytonaConflictError {}
export class DaytonaGitMergeConflictError extends DaytonaConflictError {}
export class DaytonaGitTransportFailedError extends DaytonaBadGatewayError {}
export class DaytonaGitRemoteRejectedError extends DaytonaUnprocessableEntityError {}
export class DaytonaFileNotFoundError extends DaytonaNotFoundError {}
export class DaytonaFileAccessDeniedError extends DaytonaForbiddenError {}
export class DaytonaInvalidFilePathError extends DaytonaBadRequestError {}
export class DaytonaFileReadFailedError extends DaytonaInternalServerError {}
export class DaytonaLspServerNotInitializedError extends DaytonaBadRequestError {}
export class DaytonaProcessExecutionTimeoutError extends DaytonaTimeoutError {}
export class DaytonaProcessNotFoundError extends DaytonaNotFoundError {}
export class DaytonaSessionEndedError extends DaytonaGoneError {}
export class DaytonaCommandAlreadyCompletedError extends DaytonaGoneError {}
export class DaytonaA11yUnavailableError extends DaytonaServiceUnavailableError {}
export class DaytonaRecordingStillActiveError extends DaytonaConflictError {}
export class DaytonaRecordingFfmpegNotFoundError extends DaytonaServiceUnavailableError {}

/** A call that Daytona supports and Runtime does not, or not in the same
 * way. Thrown before anything is done, never after doing something
 * different. `feature` names what was asked for; `alternative` says what to
 * use on Runtime instead. */
export class NotSupportedError extends DaytonaError {
  readonly feature: string;
  readonly alternative: string;
  constructor(feature: string, alternative: string, message?: string) {
    super(
      message ?? `${feature} is not supported on Runtime. ${alternative}`,
      undefined,
      undefined,
      "not_supported",
    );
    this.feature = feature;
    this.alternative = alternative;
  }
}

/** Which object a call was about, to name a 404 the way Daytona would. */
export type Subject = "sandbox" | "file" | "process" | "other";

const BY_STATUS: Record<number, typeof DaytonaError> = {
  400: DaytonaBadRequestError,
  401: DaytonaAuthenticationError,
  403: DaytonaForbiddenError,
  404: DaytonaNotFoundError,
  408: DaytonaTimeoutError,
  409: DaytonaConflictError,
  410: DaytonaGoneError,
  413: DaytonaBadRequestError,
  422: DaytonaUnprocessableEntityError,
  429: DaytonaRateLimitError,
  500: DaytonaInternalServerError,
  502: DaytonaBadGatewayError,
  503: DaytonaServiceUnavailableError,
  504: DaytonaTimeoutError,
};

/** Turns a Runtime SDK error into the Daytona error a caller written for
 * Daytona expects. Anything that is not a Runtime error passes through. */
export function translate(error: unknown, subject: Subject = "other"): unknown {
  if (!(error instanceof RuntimeError)) return error;
  const message = [
    error.message,
    error.hint ? `Hint: ${error.hint}` : "",
    error.requestId ? `Request: ${error.requestId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  let out: DaytonaError;
  if (error.status === 503 && error.code.endsWith("_unavailable"))
    out = new NotSupportedError(error.code.replace(/_unavailable$/, ""), error.hint ?? "", message);
  else if (error.code === "file_not_found" || (error.status === 404 && subject === "file"))
    out = new DaytonaFileNotFoundError(message);
  else if (error.status === 404 && subject === "process")
    out = new DaytonaProcessNotFoundError(message);
  else if (error.code === "command_timeout") out = new DaytonaProcessExecutionTimeoutError(message);
  else if (error.status === 0) out = new DaytonaConnectionError(message);
  else out = new (BY_STATUS[error.status] ?? DaytonaError)(message);
  if (error.status) out.statusCode = error.status;
  if (!(out instanceof NotSupportedError)) out.code = error.code;
  if (error.hint) out.hint = error.hint;
  if (error.requestId) out.requestId = error.requestId;
  out.cause = error;
  return out;
}

/** Runs `work`, turning any Runtime error into its Daytona counterpart. */
export async function guard<T>(subject: Subject, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translate(error, subject);
  }
}
