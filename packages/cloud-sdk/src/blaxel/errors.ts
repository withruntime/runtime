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
  trial_busy:
    "The trial's sandboxes are all in use: delete one you no longer need (sandbox.delete()) or archive it (sandbox.archive()), then try again. Moving to paid credit is the account owner's decision.",
  public_preview_not_allowed:
    "On the trial, share the port privately: sandbox.previews.create({ metadata: { name }, spec: { port, public: false } }) and a token from preview.tokens.create(expiresAt). A public preview needs a paid sandbox, which is the account owner's decision.",
  busy: AGAIN,
  guest_busy: AGAIN,
  rate_limited: AGAIN,
  unauthorized:
    "Set RUNTIME_API_KEY to a Runtime key (https://withruntime.com/account/keys), or run `npx withruntime login` once. A Blaxel key (BL_API_KEY) is never sent.",
};
/** A trial create over the trial's size, in Blaxel's field. */
const TRIAL_CAP =
  "A trial sandbox has at most 4096 MB of memory (2 vCPUs); pass memory 4096 or add credit.";

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
  const trialCap = error.code === "invalid_trial";
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
