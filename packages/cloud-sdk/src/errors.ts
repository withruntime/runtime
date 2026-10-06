/** Every failure the SDK raises. `code` is stable and machine-readable,
 * `hint` says what to do next, and `requestId` is what to quote in a report
 * (runtime.feedback.submit, `runtime feedback`, or support). */
/** A product switched off on this deployment, or paused on purpose: the API
 * answers these 503s in fixed words (`serverFault` "off" in
 * packages/cloud/src/api/respond.ts) and retrying cannot change them.
 * host_unavailable and busy pass, and are retried. */
export const DELIBERATE: ReadonlySet<string> = new Set([
  "unavailable",
  "unsupported",
  "fork_unavailable",
  "previews_unavailable",
  "network_unavailable",
  "network_rules_unavailable",
  "secrets_unavailable",
  "identity_unavailable",
  "env_unavailable",
]);
/** Refusals that guarantee nothing ran: a sandbox running as many commands
 * as it can (`guest_busy`), and the API's own limits, which answer before any
 * work starts (`busy`, `rate_limited`). Sending such a call again is always
 * safe, so the SDK does, with backoff, until the call's deadline (five
 * minutes when it has none), however many retries it allows otherwise. */
export const NOTHING_RAN: ReadonlySet<string> = new Set(["guest_busy", "busy", "rate_limited"]);
/** Refusals that pass on their own: a host frees room, a sandbox of an
 * account without credit stops. */
const PASSING = new Set(["no_capacity", "no_credit_running_limit", "no_credit_total_limit"]);
/** Refusals of a create that clear when a sandbox stops or pauses, or a host
 * frees room: an account without credit's eight at once and its total, an
 * email domain's, the account's quota and the region's capacity. `sandboxes.create` waits them out, retrying
 * with the same key and input, for up to `waitForCapacityMs`. */
export const WAITS_FOR_ROOM: ReadonlySet<string> = new Set([
  "no_credit_running_limit",
  "no_credit_total_limit",
  "no_credit_domain_limit",
  "no_credit_capacity_full",
  "quota_exceeded",
  "no_capacity",
  // A volume whose last sandbox is stopping: free within seconds.
  "volume_releasing",
]);

export class RuntimeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  /** The key the SDK sent. A retry with it never repeats the effect. */
  readonly idempotencyKey?: string;
  readonly retryAfterMs?: number;
  constructor(init: {
    message: string;
    code: string;
    status: number;
    requestId?: string;
    hint?: string;
    details?: Record<string, unknown>;
    idempotencyKey?: string;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.code = init.code;
    this.status = init.status;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.hint !== undefined) this.hint = init.hint;
    if (init.details !== undefined) this.details = init.details;
    if (init.idempotencyKey !== undefined) this.idempotencyKey = init.idempotencyKey;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
  /** Retrying this exact call (the SDK keeps the key) is safe and may work.
   * True for no_capacity and no_credit_running_limit as well, which clear by themselves when
   * a host frees room or a sandbox without credit stops. `sandboxes.create` already
   * waits for those (see `waitForCapacityMs`), so seeing one from a create
   * means the wait ran out or was switched off. */
  get retryable(): boolean {
    if (DELIBERATE.has(this.code)) return false;
    // A fork asking for more copies than an account without credit runs at once never fits.
    if (PASSING.has(this.code)) return this.details?.field !== "count";
    return [0, 429, 502, 503, 504].includes(this.status);
  }
  toString(): string {
    return `${this.name} [${this.code}${this.status ? ` ${this.status}` : ""}]: ${this.message}${this.hint ? `\nHint: ${this.hint}` : ""}${this.requestId ? `\nRequest: ${this.requestId}` : ""}`;
  }
}
export class AuthenticationError extends RuntimeError {}
export class PermissionDeniedError extends RuntimeError {}
export class NotFoundError extends RuntimeError {}
export class ConflictError extends RuntimeError {}
export class InvalidRequestError extends RuntimeError {}
export class RateLimitError extends RuntimeError {}
export class ServiceUnavailableError extends RuntimeError {}
/** The account may not spend: a payment on it is disputed or under review
 * (`account_blocked`, 402). The message says which and what clears it; a
 * retry cannot, and adding credit alone may not. */
export class AccountBlockedError extends RuntimeError {}
/** No answer arrived. A write may or may not have happened; retrying with the
 * same idempotencyKey (the SDK does, automatically) settles it safely. */
export class ConnectionError extends RuntimeError {}
/** Raised by exec({ check: true }) when a command exits non-zero. */
export class CommandError extends RuntimeError {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  constructor(result: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  }) {
    super({
      message: result.timedOut
        ? "Command timed out."
        : `Command exited with ${result.exitCode}.${result.stderr ? ` ${result.stderr.trim().slice(-500)}` : ""}`,
      code: result.timedOut ? "command_timeout" : "command_failed",
      status: 0,
    });
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export function errorFor(status: number, body: unknown, idempotencyKey?: string): RuntimeError {
  const error = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const init = {
    message:
      typeof error.message === "string" ? error.message : `Runtime request failed (${status}).`,
    code: typeof error.code === "string" ? error.code : "request_failed",
    status,
    ...(typeof error.requestId === "string" ? { requestId: error.requestId } : {}),
    ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
    ...(error.details && typeof error.details === "object"
      ? { details: error.details as Record<string, unknown> }
      : {}),
    ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  if (init.code === "account_blocked") return new AccountBlockedError(init);
  if (status === 401) return new AuthenticationError(init);
  if (status === 403) return new PermissionDeniedError(init);
  if (status === 404) return new NotFoundError(init);
  if (status === 409) return new ConflictError(init);
  if (status === 400 || status === 422 || status === 413) return new InvalidRequestError(init);
  if (status === 429) return new RateLimitError(init);
  if (status >= 500) return new ServiceUnavailableError(init);
  return new RuntimeError(init);
}
