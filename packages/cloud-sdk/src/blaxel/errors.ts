import { RuntimeError } from "../errors.js";

/* Blaxel's error classes by the same names, so a
   `catch (e) { if (e instanceof ResponseError) ... }` or an
   `isGatewayError(e)` written for Blaxel keeps working. One made from a
   Runtime answer also carries Runtime's own code (`runtimeCode`), `hint` and
   `requestId`, and the original error as `cause`. */

const GATEWAY = new Set([502, 503, 504]);

/** An error answer. `status` is the HTTP status; `code` is the same number,
 * as Blaxel's control-plane errors carry it (`e.code === 404`); `data` is
 * `{ error, code, hint, requestId }`. */
export class ResponseError extends Error {
  response: Response;
  error: unknown;
  readonly status?: number;
  readonly statusText?: string;
  readonly data: unknown;
  code?: number;
  runtimeCode?: string;
  hint?: string;
  requestId?: string;
  constructor(response: Response, data: unknown, error: unknown) {
    const status = response.status || undefined;
    const detail =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : undefined;
    super(
      `Sandbox request failed with status ${status ?? "unknown"}${detail ? `: ${detail}` : ""}`,
    );
    this.name = new.target.name;
    this.response = response;
    this.error = error;
    this.data = data;
    if (status !== undefined) {
      this.status = status;
      this.code = status;
    }
    if (response.statusText) this.statusText = response.statusText;
  }
}

/** A 502, 503 or 504: nothing usable came back. Safe to retry an idempotent
 * call. */
export class SandboxGatewayError extends ResponseError {}

/** True when `err` carries a gateway status (502, 503 or 504). */
export function isGatewayError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    GATEWAY.has((err as { status?: unknown }).status as number)
  );
}

/** True when `err` is a gateway timeout (504). */
export function isGatewayTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 504;
}

/** No Runtime key was found. A Blaxel key (BL_API_KEY) is never sent. */
export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A call that Blaxel supports and Runtime does not, or not in the same way.
 * Thrown before anything is done, never after doing something different.
 * `feature` names what was asked for; `alternative` says what to use on
 * Runtime instead. */
export class NotSupportedError extends Error {
  readonly code = "not_supported";
  readonly feature: string;
  readonly alternative: string;
  constructor(feature: string, alternative: string, message?: string) {
    super(message ?? `${feature} is not supported on Runtime. ${alternative}`);
    this.name = new.target.name;
    this.feature = feature;
    this.alternative = alternative;
  }
}

/** Thrown by SandboxInstance.create / createIfNotExists when the sandbox was
 * not running within the `timeout` asked for. The sandbox is deleted first,
 * so its name is free and the creation can simply be started over, as on
 * Blaxel. */
export class SandboxCreationTimeoutError extends Error {
  readonly sandboxName: string | undefined;
  readonly timeout: number | undefined;
  readonly code = "CREATION_TIMEOUT";
  readonly status = 408;
  readonly data: unknown;
  constructor(sandboxName: string | undefined, timeout: number | undefined, data: unknown) {
    const detail =
      typeof data === "object" &&
      data !== null &&
      typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : undefined;
    const target = sandboxName ? `Sandbox ${sandboxName}` : "Sandbox";
    const deadline =
      timeout !== undefined ? ` within ${timeout}s` : " within the creation deadline";
    super(
      `${target} was not ready${deadline}; the creation was cancelled.${detail ? ` ${detail}` : ""}`,
    );
    this.name = "SandboxCreationTimeoutError";
    this.sandboxName = sandboxName;
    this.timeout = timeout;
    this.data = data;
  }
}

/** True when `err` is a sandbox creation timeout (408 CREATION_TIMEOUT). */
export function isCreationTimeoutError(err: unknown): err is SandboxCreationTimeoutError {
  return err instanceof SandboxCreationTimeoutError;
}

/** A ResponseError of this status and message, made here rather than by
 * Runtime: a process or preview that is not there, a wait that ran out. */
export function responseError(status: number, message: string): ResponseError {
  const data = { error: message };
  const Kind = GATEWAY.has(status) ? SandboxGatewayError : ResponseError;
  return new Kind(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
    data,
    data,
  );
}

const LS = "List the directory with sandbox.fs.ls(path).";
/** Runtime's hints that name Runtime's calls, in the Blaxel calls a Blaxel
 * program makes (the Python adapter uses the same words). */
const AGAIN = "Try again in a moment.";
const BLAXEL_HINTS: Record<string, string> = {
  name_taken: "SandboxInstance.createIfNotExists({ name }) answers the sandbox that has the name.",
  file_not_found: LS,
  path_not_found: LS,
  is_a_directory:
    "That path is a directory: list it with sandbox.fs.ls(path), or name a file in it.",
  cwd_not_found:
    "Make the directory with sandbox.fs.mkdir(path), or pass an existing workingDir to sandbox.process.exec.",
  sandbox_paused: "Call sandbox.unarchive(), then try again.",
  not_running:
    "The sandbox is not running: call sandbox.unarchive() if it was archived, or make a new one with SandboxInstance.create if it was deleted.",
  no_credit_running_limit:
    "The sandboxes an account without credit runs at once are all in use: delete one you no longer need (sandbox.delete()) or archive it (sandbox.archive()), then try again. Moving to paid credit is the account owner's decision.",
  public_preview_not_allowed:
    "Without credit, share the port privately: sandbox.previews.create({ metadata: { name }, spec: { port, public: false } }) and a token from preview.tokens.create(expiresAt) on a server supporting absolute preview deadlines. A public preview needs a paid sandbox, which is the account owner's decision.",
  busy: AGAIN,
  guest_busy: AGAIN,
  rate_limited: AGAIN,
  unauthorized:
    "Set RUNTIME_API_KEY to a Runtime key (https://withruntime.com/account/keys), or run `npx withruntime login` once. A Blaxel key (BL_API_KEY) is never sent.",
};
/** A trial create over the trial's size, in Blaxel's field. */
const TRIAL_CAP =
  "Without credit, a sandbox has at most 4096 MB of memory (2 vCPUs); pass memory 4096 or add credit.";

/** A Runtime SDK error as Blaxel's: ResponseError (SandboxGatewayError for a
 * 502, 503 or 504), NotSupportedError for a product Runtime has switched off,
 * CredentialsError when there is no Runtime key. Anything else passes through
 * unchanged. */
export function translate(error: unknown): unknown {
  if (!(error instanceof RuntimeError)) return error;
  if (error.code === "missing_api_key")
    return Object.assign(
      new CredentialsError(
        "No Runtime key found. A Blaxel key (BL_API_KEY) is never sent anywhere: set RUNTIME_API_KEY to a " +
          "Runtime key (https://withruntime.com/account/keys), put a Runtime key (rtcloud_...) in BL_API_KEY, " +
          "or run `npx withruntime login` once.",
      ),
      { cause: error },
    );
  if (error.status === 503 && error.code.endsWith("_unavailable"))
    return new NotSupportedError(
      error.code.replace(/_unavailable$/, ""),
      error.hint ?? "",
      error.message,
    );
  if (error.status < 200 || error.status > 599) return error;
  const trialCap = error.code === "no_credit_size_limit";
  const hint = trialCap ? undefined : (BLAXEL_HINTS[error.code] ?? error.hint);
  const message = [
    trialCap ? TRIAL_CAP : error.message,
    hint ? `Hint: ${hint}` : "",
    error.requestId ? `Request: ${error.requestId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const data = {
    error: message,
    code: error.code,
    ...(hint ? { hint } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
  const Kind = GATEWAY.has(error.status) ? SandboxGatewayError : ResponseError;
  const out = new Kind(
    new Response(JSON.stringify(data), {
      status: error.status,
      headers: { "content-type": "application/json" },
    }),
    data,
    data,
  );
  out.runtimeCode = error.code;
  if (hint) out.hint = hint;
  if (error.requestId) out.requestId = error.requestId;
  out.cause = error;
  return out;
}

/** Runs `work`, turning any Runtime error into Blaxel's. */
export async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translate(error);
  }
}

/** True for a 404 in either shape: Runtime's or Blaxel's. */
export function isNotFound(error: unknown): boolean {
  if (error instanceof RuntimeError) return error.status === 404;
  return error instanceof ResponseError && error.status === 404;
}

/** Runtime's error code on either shape. */
export function codeOf(error: unknown): string | undefined {
  if (error instanceof RuntimeError) return error.code;
  if (error instanceof ResponseError) return error.runtimeCode;
  return undefined;
}

/* @blaxel/core 0.3.29's error helpers (common/error-types), over the errors
   this package throws. They read what an error already carries and never
   throw. On Runtime a ResponseError's `code` is its HTTP status, as above, and
   its request id is Runtime's (`requestId`), read when no Blaxel header has
   one. */

/** Codes Blaxel's edge gateway returns. */
export type BlaxelGatewayErrorCode =
  | "ROUTE_NOT_FOUND"
  | "WORKLOAD_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "WORKLOAD_UNAVAILABLE"
  | "WORKLOAD_FAILED"
  | "ROUTING_UNAVAILABLE"
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_FAILED"
  | "TOKEN_REVOKED"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "USAGE_LIMIT_EXCEEDED"
  | "POLICY_VIOLATION"
  | "UPSTREAM_CONNECT_FAILED"
  | "UPSTREAM_CONNECT_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "GATEWAY_INTERNAL_ERROR";
/** Blaxel's authentication codes from sandbox creation and fork. */
export type BlaxelAuthErrorCode =
  | "TOKEN_REVOKED"
  | "UNAUTHORIZED"
  | "UNAUTHORIZED_WORKSPACE"
  | "AUTHENTICATION_UNAVAILABLE"
  | "WORKSPACE_REQUIRED";
/** Blaxel's codes for creating or forking a sandbox. */
export type BlaxelSandboxCreationErrorCode =
  | "READ_FAILED"
  | "PARSE_FAILED"
  | "VALIDATION_FAILED"
  | "VALIDATION_ERROR"
  | "INVALID_INPUT"
  | "INVALID_IMAGE"
  | "IMAGE_NOT_FOUND"
  | "UPLOAD_NOT_SUPPORTED"
  | "UNSUPPORTED_GENERATION"
  | "KERNEL_GENERATION_MISMATCH"
  | "INVALID_PORTS"
  | "INVALID_REGION"
  | "REGION_MISMATCH"
  | "INVALID_VOLUME"
  | "INVALID_VOLUME_COUNT"
  | "INVALID_VOLUME_REGION"
  | "VOLUME_ALREADY_ATTACHED"
  | "VOLUME_PROVIDER_MISMATCH"
  | "VOLUME_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "ACCOUNT_NOT_FOUND"
  | "SANDBOX_ALREADY_EXISTS"
  | "SANDBOX_DELETION_IN_PROGRESS"
  | "SANDBOX_DELETED"
  | "VOLUME_DELETED"
  | "CREATION_TIMEOUT"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMIT_EXCEEDED"
  | "WORKSPACE_RATE_LIMIT_EXCEEDED"
  | "SERVICE_UNAVAILABLE"
  | "DATABASE_ERROR"
  | "LOCK_ACQUISITION_FAILED"
  | "VOLUME_LOOKUP_FAILED"
  | "BUILD_TRIGGER_ERROR"
  | "PRESIGNED_URL_ERROR"
  | "UPLOAD_UNAVAILABLE"
  | "DEPLOYMENT_FAILED"
  | "CLUSTER_GATEWAY_ERROR"
  | "LOCKDOWN_ERROR"
  | "PROXY_CONFIG_ERROR"
  | "VALIDATED_DATA_ERROR"
  | "WORKSPACE_DATA_MISSING"
  | "CALLBACK_SEND_FAILED"
  | "FORK_FAILED"
  | "HANDLER_ERROR"
  | "INTERNAL_ERROR"
  | "UNKNOWN_ERROR";
export type BlaxelErrorCode =
  BlaxelGatewayErrorCode | BlaxelAuthErrorCode | BlaxelSandboxCreationErrorCode;
export type BlaxelErrorCodeValue = BlaxelErrorCode | (string & Record<never, never>) | number;
export type BlaxelApiErrorBody = { error: string; code: number };
export type BlaxelActionErrorBody = {
  code: BlaxelSandboxCreationErrorCode | BlaxelAuthErrorCode | (string & Record<never, never>);
  message: string;
  status_code: number;
  reason?: string;
  step?: string;
  workspace?: string;
  sandbox_name?: string;
  timestamp?: string;
  cause?: string;
  details?: Record<string, unknown>;
};
export type BlaxelPlatformErrorBody = {
  error: {
    code: BlaxelGatewayErrorCode | (string & Record<never, never>);
    message: string;
    status: number;
    origin?: "platform";
    retryable?: boolean;
    dispatch_state?: "not_dispatched" | "dispatched_unknown";
    safe_to_retry_request?: boolean;
    action?: string;
    do_not?: string;
    docs_url?: string;
    timestamp?: string;
  };
};
export type BlaxelSandboxApiErrorBody = { error: string };
export type BlaxelErrorLike =
  | ResponseError
  | SandboxCreationTimeoutError
  | BlaxelApiErrorBody
  | Pick<BlaxelActionErrorBody, "code" | "message" | "status_code">
  | { error: Pick<BlaxelPlatformErrorBody["error"], "code" | "message" | "status"> };

function readProperty(value: unknown, key: string): unknown {
  try {
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}
const isCode = (value: unknown): value is string | number =>
  (typeof value === "string" && value.length > 0) ||
  (typeof value === "number" && Number.isFinite(value));
const isStatus = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;

/** True for an error this package throws for an API failure (ResponseError,
 * SandboxGatewayError, SandboxCreationTimeoutError) or a raw Blaxel error body
 * (`{ error, code }`, `{ code, message, status_code }`,
 * `{ error: { code, message, status } }`). False for plain errors, strings and
 * NotSupportedError, which is a refusal made here, not an API failure. Never
 * throws. */
export function isBlaxelError(err: unknown): err is BlaxelErrorLike {
  try {
    if (err instanceof Error)
      return err instanceof ResponseError || err instanceof SandboxCreationTimeoutError;
    if (typeof err !== "object" || err === null || Array.isArray(err)) return false;
    const error = readProperty(err, "error");
    if (typeof error === "string") return isStatus(readProperty(err, "code"));
    if (
      typeof readProperty(err, "code") === "string" &&
      typeof readProperty(err, "message") === "string" &&
      isStatus(readProperty(err, "status_code"))
    )
      return true;
    return (
      typeof error === "object" &&
      error !== null &&
      !Array.isArray(error) &&
      typeof readProperty(error, "code") === "string" &&
      typeof readProperty(error, "message") === "string" &&
      isStatus(readProperty(error, "status"))
    );
  } catch {
    return false;
  }
}

function errorCandidates(err: unknown): unknown[] {
  const bodies = [err, readProperty(err, "error"), readProperty(err, "data")];
  return bodies.flatMap((body) => [body, readProperty(body, "error")]);
}

function readHeader(err: unknown, name: string): string | undefined {
  try {
    const headers = readProperty(readProperty(err, "response"), "headers");
    const get = readProperty(headers, "get");
    if (typeof get !== "function") return undefined;
    const value: unknown = Reflect.apply(get, headers, [name]);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The error's code, then its body's, then the X-Blaxel-Error-Code header. A
 * ResponseError from Runtime answers its HTTP status (its `code`); Runtime's
 * own code is `runtimeCode`. Never throws. */
export function getBlaxelErrorCode(err: unknown): BlaxelErrorCodeValue | undefined {
  for (const candidate of errorCandidates(err)) {
    const code = readProperty(candidate, "code");
    if (isCode(code)) return code;
  }
  return readHeader(err, "x-blaxel-error-code");
}

/** The HTTP status: the error's, its response's, then its body's (`status`,
 * `status_code` or a numeric `code`). Never throws. */
export function getBlaxelErrorStatus(err: unknown): number | undefined {
  const status = readProperty(err, "status");
  if (isStatus(status)) return status;
  const responseStatus = readProperty(readProperty(err, "response"), "status");
  if (isStatus(responseStatus)) return responseStatus;
  for (const candidate of errorCandidates(err))
    for (const key of ["status", "status_code", "code"]) {
      const value = readProperty(candidate, key);
      if (isStatus(value)) return value;
    }
  return undefined;
}

/** The error's message, else its body's message or error text. Never throws. */
export function getBlaxelErrorMessage(err: unknown): string | undefined {
  for (const candidate of errorCandidates(err)) {
    const message = typeof candidate === "string" ? candidate : readProperty(candidate, "message");
    if (typeof message === "string" && message.length > 0) return message;
  }
  return undefined;
}

/** Blaxel's request id headers (X-Cf-Request-Id, X-Amz-Cf-Id, CF-Ray) on the
 * error's response, else the Runtime request id a ResponseError carries
 * (`requestId`). Never throws. */
export function getBlaxelErrorRequestId(err: unknown): string | undefined {
  for (const name of ["x-cf-request-id", "x-amz-cf-id", "cf-ray"]) {
    const value = readHeader(err, name);
    if (value !== undefined) return value;
  }
  try {
    const runtime = err instanceof ResponseError ? err.requestId : undefined;
    return typeof runtime === "string" && runtime.length > 0 ? runtime : undefined;
  } catch {
    return undefined;
  }
}
