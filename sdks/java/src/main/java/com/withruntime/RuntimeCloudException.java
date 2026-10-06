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

  /** 503s that are a deliberate state, not a passing one: retrying cannot change them. */
  static final Set<String> DELIBERATE =
      Set.of(
          "unavailable",
          "unsupported",
          "fork_unavailable",
          "previews_unavailable",
          "network_unavailable",
          "network_rules_unavailable",
          "secrets_unavailable",
          "identity_unavailable",
          "env_unavailable");

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
          "no_capacity",
          "volume_releasing");

  private final String code;
  private final int status;
  private final String hint;
  private final String requestId;
  private final transient Map<String, Object> details;
  private final String idempotencyKey;
  private final Duration retryAfter;

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
    super(message, cause);
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

  /** Whether retrying this exact call, with the same idempotency key, is safe and may work. */
  public boolean retryable() {
    if (DELIBERATE.contains(code)) return false;
    if (PASSING.contains(code)) return !"count".equals(details().get("field"));
    return status == 0 || status == 429 || status == 502 || status == 503 || status == 504;
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
    Init a = new Init(message, code, status, e.getString("hint"), e.getString("requestId"), details, idempotencyKey, retryAfter, null);
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
      Throwable cause) {}

  RuntimeCloudException(Init a) {
    this(a.message, a.code, a.status, a.hint, a.requestId, a.details, a.idempotencyKey, a.retryAfter, a.cause);
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
      super(message, code, 0, hint, null, null, idempotencyKey, null, cause);
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
