/** Every failure the SDK raises. `code` is stable and machine-readable,
 * `hint` says what to do next, and `requestId` is what to quote in a report
 * (runtime.feedback.submit, `runtime feedback`, or support). */
/** A product switched off on this deployment, or paused on purpose: the API
 * answers these with 501 (503 from an older server) in fixed words, and
 * retrying cannot change them. host_unavailable and busy pass, and are
 * retried. The API also says so itself (`retryable: false`); this set is for
 * a server too old to. */
export const DELIBERATE: ReadonlySet<string> = new Set([
  "unavailable",
  "unsupported",
  "fork_unavailable",
  "previews_unavailable",
  "file_links_unavailable",
  "network_unavailable",
  "network_rules_unavailable",
  "secrets_unavailable",
  "identity_unavailable",
  "env_unavailable",
  "resize_unavailable",
  "feature_unavailable",
  "delete_unavailable",
  "switch_image_unavailable",
  "switching_paused",
  "schema_migration_required",
  "storage_unavailable",
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
 * frees room: an account without credit's four at once and its total, an
 * email domain's, the account's quota, its share of the region's servers and the region's capacity. `sandboxes.create` waits them out, retrying
 * with the same key and input, for up to `waitForCapacityMs`. */
export const WAITS_FOR_ROOM: ReadonlySet<string> = new Set([
  "no_credit_running_limit",
  "no_credit_total_limit",
  "no_credit_domain_limit",
  "no_credit_capacity_full",
  "quota_exceeded",
  // The account holds its share of every server that could run it: clears
  // as its own sandboxes end.
  "account_share_full",
  "no_capacity",
  // A volume whose last sandbox is stopping: free once the stop lets go of
  // its disk, up to about a minute (measured 50 to 60 s, 6 October 2026).
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
  /** What the API said of this answer: whether the same request, sent again
   * unchanged, may succeed. Undefined from a server too old to say, or for a
   * failure the SDK made itself; `retryable` then judges by code and status. */
  readonly sentRetryable?: boolean;
  constructor(init: {
    message: string;
    code: string;
    status: number;
    requestId?: string;
    hint?: string;
    details?: Record<string, unknown>;
    idempotencyKey?: string;
    retryAfterMs?: number;
    sentRetryable?: boolean;
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
    if (init.sentRetryable !== undefined) this.sentRetryable = init.sentRetryable;
  }
  /** Retrying this exact call (the SDK keeps the key) is safe and may work.
   * True for no_capacity and no_credit_running_limit as well, which clear by themselves when
   * a host frees room or a sandbox without credit stops. `sandboxes.create` already
   * waits for those (see `waitForCapacityMs`), so seeing one from a create
   * means the wait ran out or was switched off. The API's own word
   * (`sentRetryable`) wins; the rest is for an older server. */
  get retryable(): boolean {
    if (this.sentRetryable !== undefined) return this.sentRetryable;
    if (DELIBERATE.has(this.code)) return false;
    // A fork asking for more copies than an account without credit runs at once never fits.
    if (PASSING.has(this.code)) return this.details?.field !== "count";
    // The account at one of its limits (a 429 since 17 October 2026): some
    // free when its own work ends, some only when something is deleted, so
    // the same call again is no answer by itself.
    if (this.code === "quota_exceeded") return false;
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
/** Raised by exec({ check: true }) when a command exits non-zero. Its code
 * is `out_of_memory` when the sandbox's out-of-memory killer ended it, with
 * the result's message and hint. */
export class CommandError extends RuntimeError {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  constructor(result: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
    outOfMemory?: { code: string; message: string; hint: string };
  }) {
    const memory = result.outOfMemory;
    super({
      message: result.timedOut
        ? "Command timed out."
        : memory
          ? `Command exited with ${result.exitCode}. ${memory.message}`
          : `Command exited with ${result.exitCode}.${result.stderr ? ` ${result.stderr.trim().slice(-500)}` : ""}`,
      code: result.timedOut ? "command_timeout" : memory ? memory.code : "command_failed",
      status: 0,
      ...(memory && !result.timedOut ? { hint: memory.hint } : {}),
    });
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
  /** The same command in the same sandbox runs out of memory again. */
  override get retryable(): boolean {
    return this.code === "out_of_memory" ? false : super.retryable;
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
    ...(typeof error.retryable === "boolean" ? { sentRetryable: error.retryable } : {}),
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
