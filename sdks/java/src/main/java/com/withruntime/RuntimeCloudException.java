package com.withruntime;

import java.time.Duration;
import java.util.Map;
import java.util.Set;

/**
 * Every failure the SDK throws. {@link #code()} is stable and machine-readable, {@link #hint()}
 * says what to do next, and {@link #requestId()} is what to quote in a report. Subclasses name
 * the class of failure, as in the JavaScript and Python SDKs: {@link Authentication}, {@link
 * PermissionDenied}, {@link NotFound}, {@link Conflict}, {@link InvalidRequest}, {@link
 * RateLimited}, {@link ServiceUnavailable}, {@link Connection} and {@link Command}.
 */
public class RuntimeCloudException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /**
   * Products switched off on this deployment (501; 503 from an older server): retrying cannot
   * change them. Read only when the answer does not say {@code retryable} itself.
   */
  static final Set<String> DELIBERATE =
      Set.of(
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
          "storage_unavailable");

  /** Refusals that pass on their own: a host frees room, a sandbox of an account without credit stops. */
  static final Set<String> PASSING =
      Set.of("no_capacity", "no_credit_running_limit", "no_credit_total_limit");

  /** Refusals of a create that clear when a sandbox stops or a host frees room. */
  static final Set<String> WAITS_FOR_ROOM =
      Set.of(
          "no_credit_running_limit",
          "no_credit_total_limit",
          "no_credit_domain_limit",
          "no_credit_capacity_full",
          "quota_exceeded",
          "account_share_full",
          "no_capacity",
          "volume_releasing",
          "sandbox_moving");

  /**
   * Refusals that say nothing ran (the guest, the API or the caller's rate was busy): sent again
   * for any call, past maxRetries, with growing waits, until the call's deadline.
   */
  static final Set<String> NOTHING_RAN = Set.of("guest_busy", "busy", "rate_limited");

  private final String code;
  private final int status;
  private final String hint;
  private final String requestId;
  private final transient Map<String, Object> details;
  private final String idempotencyKey;
  private Duration retryAfter;
  /** The answer's own {@code retryable}, or null when it did not say (an older server). */
  private final Boolean sentRetryable;

  public RuntimeCloudException(
      String message,
      String code,
      int status,
      String hint,
      String requestId,
      Map<String, Object> details,
      String idempotencyKey,
      Duration retryAfter,
      Throwable cause) {
    this(message, code, status, hint, requestId, details, idempotencyKey, retryAfter, null, cause);
  }

  private RuntimeCloudException(
      String message,
      String code,
      int status,
      String hint,
      String requestId,
      Map<String, Object> details,
      String idempotencyKey,
      Duration retryAfter,
      Boolean sentRetryable,
      Throwable cause) {
    super(message, cause);
    this.sentRetryable = sentRetryable;
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.requestId = requestId;
    this.details = details == null ? Map.of() : details;
    this.idempotencyKey = idempotencyKey;
    this.retryAfter = retryAfter;
  }

  RuntimeCloudException(String message, String code, String hint) {
    this(message, code, 0, hint, null, null, null, null, null);
  }

  /** The API's error code, such as "not_found", "no_credit_running_limit" or "missing_api_key". */
  public String code() {
    return code;
  }

  /** The HTTP status, or 0 when no answer arrived or the error is the client's own. */
  public int status() {
    return status;
  }

  public String hint() {
    return hint;
  }

  public String requestId() {
    return requestId;
  }

  public Map<String, Object> details() {
    return details == null ? Map.of() : details;
  }

  /** The key the SDK sent. Retrying with it never repeats the effect. */
  public String idempotencyKey() {
    return idempotencyKey;
  }

  /** How long the server asked the client to wait, or null. */
  public Duration retryAfter() {
    return retryAfter;
  }

  /**
   * Whether retrying this exact call, with the same idempotency key, is safe and may work: the
   * answer's own {@code retryable} when it sent one, else judged from its code and status.
   */
  public boolean retryable() {
    if (sentRetryable != null) return sentRetryable;
    if (DELIBERATE.contains(code)) return false;
    if (PASSING.contains(code)) return !"count".equals(details().get("field"));
    // The account at one of its limits (a 429): some free when its own work ends, some only
    // when something is deleted, so the same call again is no answer by itself.
    if ("quota_exceeded".equals(code)) return false;
    return status == 0 || status == 429 || status == 502 || status == 503 || status == 504;
  }

  /** Takes the Retry-After header's wait when the body named none, for a caller to schedule by. */
  RuntimeCloudException waitNamed(Duration header) {
    if (retryAfter == null) retryAfter = header;
    return this;
  }

  /** The answer's own {@code retryable}, or null when it did not say (an older server). */
  Boolean sentRetryable() {
    return sentRetryable;
  }

  @Override
  public String toString() {
    StringBuilder out = new StringBuilder(getClass().getSimpleName()).append(" [").append(code);
    if (status != 0) out.append(' ').append(status);
    out.append("]: ").append(getMessage());
    if (hint != null) out.append("\nHint: ").append(hint);
    if (requestId != null) out.append("\nRequest: ").append(requestId);
    return out.toString();
  }

  /** The API's one error shape, as the right subclass. */
  static RuntimeCloudException from(int status, Object body, String idempotencyKey) {
    Map<String, Object> error = JsonObject.map(JsonObject.map(body).get("error"));
    JsonObject e = new JsonObject(error);
    String message = e.getString("message");
    if (message == null) message = "Runtime request failed (" + status + ").";
    String code = e.getString("code");
    if (code == null) code = "request_failed";
    Double retryMs = e.getDouble("retryAfterMs");
    Duration retryAfter = retryMs == null ? null : Duration.ofMillis(Math.round(retryMs));
    Map<String, Object> details = error.get("details") instanceof Map<?, ?> ? JsonObject.map(error.get("details")) : null;
    Boolean retryable = error.get("retryable") instanceof Boolean sent ? sent : null;
    Init a = new Init(message, code, status, e.getString("hint"), e.getString("requestId"), details, idempotencyKey, retryAfter, retryable, null);
    return switch (status) {
      case 401 -> new Authentication(a);
      case 403 -> new PermissionDenied(a);
      case 404 -> new NotFound(a);
      case 409 -> new Conflict(a);
      case 400, 413, 422 -> new InvalidRequest(a);
      case 429 -> new RateLimited(a);
      default -> status >= 500 ? new ServiceUnavailable(a) : new RuntimeCloudException(a);
    };
  }

  /** What every constructor takes. */
  record Init(
      String message,
      String code,
      int status,
      String hint,
      String requestId,
      Map<String, Object> details,
      String idempotencyKey,
      Duration retryAfter,
      Boolean retryable,
      Throwable cause) {}

  RuntimeCloudException(Init a) {
    this(a.message, a.code, a.status, a.hint, a.requestId, a.details, a.idempotencyKey, a.retryAfter, a.retryable, a.cause);
  }

  /**
   * This failure carrying the key of the write it belongs to, as the same subclass: a read that
   * failed while following a write keeps that write's key, so a caller can retry it safely.
   */
  RuntimeCloudException withIdempotencyKey(String key) {
    if (key == null || idempotencyKey != null) return this;
    if (this instanceof Connection)
      return new Connection(getMessage(), code, hint, key, details, this);
    if (this instanceof Command) return this;
    Init a = new Init(getMessage(), code, status, hint, requestId, details, key, retryAfter, sentRetryable(), this);
    if (this instanceof Authentication) return new Authentication(a);
    if (this instanceof PermissionDenied) return new PermissionDenied(a);
    if (this instanceof NotFound) return new NotFound(a);
    if (this instanceof Conflict) return new Conflict(a);
    if (this instanceof InvalidRequest) return new InvalidRequest(a);
    if (this instanceof RateLimited) return new RateLimited(a);
    if (this instanceof ServiceUnavailable) return new ServiceUnavailable(a);
    return new RuntimeCloudException(a);
  }

  static RuntimeCloudException missingKey() {
    return new Authentication(
        new Init(
            "No Runtime key found: RUNTIME_API_KEY is not set and this machine is not connected.",
            "missing_api_key",
            0,
            "Run `npx -y withruntime login` (a browser approval; nothing to copy), set RUNTIME_API_KEY to a key from https://withruntime.com/account/keys, or pass RuntimeClient.builder().apiKey(...).",
            null,
            null,
            null,
            null,
            null,
            null));
  }

  /** 401, or no key at all. */
  public static class Authentication extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;

    Authentication(Init a) {
      super(a);
    }
  }

  /** 403. */
  public static class PermissionDenied extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;

    PermissionDenied(Init a) {
      super(a);
    }
  }

  /** 404. */
  public static class NotFound extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;

    NotFound(Init a) {
      super(a);
    }
  }

  /** 409. */
  public static class Conflict extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;

    Conflict(Init a) {
      super(a);
    }
  }

  /** 400, 413 or 422. */
  public static class InvalidRequest extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;

    InvalidRequest(Init a) {
      super(a);
    }
  }

  /** 429. */
  public static class RateLimited extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;

    RateLimited(Init a) {
      super(a);
    }
  }

  /** 5xx. */
  public static class ServiceUnavailable extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;

    ServiceUnavailable(Init a) {
      super(a);
    }
  }

  /**
   * No answer arrived ({@code connection_error}) or the call ran past its deadline ({@code
   * timeout}). A write may or may not have happened; retrying with the same idempotency key
   * settles it safely.
   */
  public static class Connection extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;

    Connection(String message, String code, String hint, String idempotencyKey, Throwable cause) {
      this(message, code, hint, idempotencyKey, null, cause);
    }

    Connection(String message, String code, String hint, String idempotencyKey, Map<String, Object> details, Throwable cause) {
      super(message, code, 0, hint, null, details, idempotencyKey, null, cause);
    }
  }

  /** Thrown by exec with check when a command exits non-zero or times out. Carries the output. */
  public static class Command extends RuntimeCloudException {
    private static final long serialVersionUID = 1L;
    private final transient CommandResult result;

    Command(CommandResult result) {
      super(message(result), result.timedOut() ? "command_timeout" : "command_failed", null);
      this.result = result;
    }

    private static String message(CommandResult result) {
      if (result.timedOut()) return "Command timed out.";
      String tail = result.stderr().trim();
      if (tail.length() > 500) tail = tail.substring(tail.length() - 500);
      return "Command exited with " + result.exitCode() + "." + (tail.isEmpty() ? "" : " " + tail);
    }

    public CommandResult result() {
      return result;
    }

    public Integer exitCode() {
      return result.exitCode();
    }

    public String stdout() {
      return result.stdout();
    }

    public String stderr() {
      return result.stderr();
    }
  }
}
