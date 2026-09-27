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
  const message = [
    error.message,
    error.hint ? `Hint: ${error.hint}` : "",
    error.requestId ? `Request: ${error.requestId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const data = {
    error: message,
    code: error.code,
    ...(error.hint ? { hint: error.hint } : {}),
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
  if (error.hint) out.hint = error.hint;
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
