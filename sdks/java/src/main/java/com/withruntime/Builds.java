package com.withruntime;

import java.time.Duration;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * {@code runtime.builds()}: builds of connected repositories ({@link #repositories()}). A build of
 * a repository with a start command ends as a saved server an App deploys.
 *
 * <p>In private beta: an account outside the beta is refused with {@link
 * RuntimeCloudException.PermissionDenied}, code product_in_beta (403).
 */
public final class Builds {
  private static final Set<String> TERMINAL = Set.of("succeeded", "failed", "cancelled", "superseded");

  private final Transport t;
  private final Repositories repositories;

  Builds(Transport transport) {
    this.t = transport;
    this.repositories = new Repositories(transport);
  }

  private static String path(String id, String rest) {
    return "/v1/builds/" + Transport.segment(id) + rest;
  }

  /** Connected repositories, whose pushes build. */
  public Repositories repositories() {
    return repositories;
  }

  /** Queues a build and returns at once. */
  public Build create(CreateBuild input) {
    return new Build(t.object(new Transport.Call("POST", "/v1/builds").body(input.toMap()).key(input.idempotencyKey)));
  }

  public Build get(String id) {
    return new Build(t.object(new Transport.Call("GET", path(id, ""))));
  }

  public Page<Build> list() {
    return list(null);
  }

  public Page<Build> list(ListResources filter) {
    return ListResources.read(t, "/v1/builds", filter, Build::new);
  }

  /** Cancels a build; one that ended stays as it is. */
  public Build cancel(String id) {
    return new Build(t.object(new Transport.Call("POST", path(id, ":cancel"))));
  }

  /** The last 200 lines and the failing step. */
  public BuildLog logs(String id) {
    return logs(id, null);
  }

  /** A page of the log: from cursor, or an older page by pageCursor. */
  public BuildLog logs(String id, LogOptions options) {
    LogOptions o = options == null ? new LogOptions() : options;
    return new BuildLog(t.object(new Transport.Call("GET", path(id, "/logs")).query("cursor", o.cursor).query("pageCursor", o.pageCursor)));
  }

  /**
   * Follows the log as the build writes it (the JavaScript SDK's {@code logs(id, {follow: true})}),
   * ending with its terminal event. A dropped connection is reopened from the last cursor, a line
   * seen twice is given once, and three failures in a row without a new line end it with
   * build_log_interrupted. Every failure carries {@code details.cursor} to resume from. Close it
   * to stop early.
   */
  public EventStream<BuildLogEvent> followLogs(String id) {
    return followLogs(id, null);
  }

  public EventStream<BuildLogEvent> followLogs(String id, LogOptions options) {
    LogOptions o = options == null ? new LogOptions() : options;
    if ((o.cursor != null && !validCursor(o.cursor)) || o.pageCursor != null)
      throw failure("invalid_log_options", "Use an opaque cursor for follow; pageCursor is only for search pages.", o.cursor);
    if (o.timeout == null || o.timeout.isNegative())
      throw failure("invalid_log_options", "The timeout must be zero or more.", o.cursor);
    return new LogFollow(id, o.cursor, o.timeout);
  }

  static RuntimeCloudException failure(String code, String hint, String cursor) {
    Map<String, Object> details = new java.util.HashMap<>();
    details.put("cursor", cursor);
    return new RuntimeCloudException(hint, code, 0, hint, null, details, null, null, null);
  }

  static boolean validCursor(Object value) {
    if (!(value instanceof String text) || text.isEmpty() || text.length() > 4096) return false;
    return text.chars().noneMatch(c -> c < 0x20 || c == 0x7f);
  }

  private static boolean safeInteger(Object value) {
    if (value instanceof Long || value instanceof Integer) return Math.abs(((Number) value).longValue()) <= (1L << 53) - 1;
    return false;
  }

  private static boolean validFailure(Map<String, Object> event) {
    if (!event.containsKey("failingStep")) return false;
    Object value = event.get("failingStep");
    if (value == null) return true;
    if (!(value instanceof Map<?, ?> step)) return false;
    Object exitCode = step.get("exitCode");
    return step.get("name") instanceof String
        && step.containsKey("exitCode")
        && (exitCode == null || safeInteger(exitCode))
        && step.get("lastLines") instanceof List<?> lines
        && lines.size() <= 20
        && lines.stream().allMatch(line -> line instanceof String);
  }

  private static boolean nonEmpty(Object value) {
    return value instanceof String text && !text.isEmpty();
  }

  /** A followed log: one connection at a time, reopened from the last cursor. */
  private final class LogFollow extends EventStream<BuildLogEvent> {
    private final String id;
    private final Transport.Cancellation cancellation = new Transport.Cancellation();
    private final long until;
    private final boolean bounded;
    private final CompletableFuture<Void> timer;
    // Opaque physical positions cannot be ordered or incremented: a line is known by its cursor.
    private final Set<String> seen = new LinkedHashSet<>();
    private String cursor;
    private int failures;
    private boolean ended;
    private EventStream<JsonObject> current;

    LogFollow(String id, String cursor, Duration timeout) {
      this.id = id;
      this.cursor = cursor;
      if (cursor != null) seen.add(cursor);
      this.bounded = !timeout.isZero();
      this.until = System.nanoTime() + timeout.toNanos();
      // Bounds the whole follow, reconnections included: each request's own deadline resets.
      this.timer =
          bounded
              ? CompletableFuture.runAsync(cancellation::cancel, CompletableFuture.delayedExecutor(timeout.toNanos(), TimeUnit.NANOSECONDS))
              : null;
    }

    private boolean expired() {
      return bounded && System.nanoTime() - until >= 0;
    }

    private RuntimeCloudException timeout(Throwable cause) {
      Map<String, Object> details = new java.util.HashMap<>();
      details.put("cursor", cursor);
      return new RuntimeCloudException.Connection(
          "Following the build log reached its deadline.",
          "timeout",
          "Reconnect with followLogs(id, new LogOptions().cursor(details.cursor)).",
          null,
          details,
          cause);
    }

    private RuntimeCloudException invalid(String hint) {
      return failure("build_log_invalid", hint, cursor);
    }

    @Override
    BuildLogEvent pull() {
      while (!isClosed() && !ended) {
        if (expired()) throw timeout(null);
        if (current == null) {
          Transport.Call call = new Transport.Call("GET", path(id, "/logs")).query("follow", "true").query("cursor", cursor).cancellation(cancellation);
          if (bounded) call.timeout(Duration.ofNanos(Math.max(1, until - System.nanoTime())));
          current = t.events(call, JsonObject::new);
        }
        JsonObject event;
        try {
          if (!current.hasNext()) {
            dropped(false);
            continue;
          }
          event = current.next();
        } catch (RuntimeCloudException.Connection lost) {
          if (isClosed()) return null;
          if (expired() || cancellation.cancelled()) throw timeout(lost);
          // HTTP refusals and protocol errors are actionable, not connection loss.
          if (!"connection_error".equals(lost.code())) throw lost;
          dropped(false);
          continue;
        } catch (RuntimeCloudException refused) {
          if (isClosed()) return null;
          if ("unexpected_answer".equals(refused.code()))
            throw invalid("The log contained invalid JSON; retry from details.cursor.");
          throw refused;
        }
        BuildLogEvent out = handle(event.raw());
        if (out != null) return out;
      }
      return null;
    }

    /** One event checked as the JavaScript SDK checks it; null when it is not given out. */
    private BuildLogEvent handle(Map<String, Object> event) {
      Object at = event.get("cursor");
      if (!(event.containsKey("cursor") && at == null) && !validCursor(at))
        throw invalid("Retry from the last received cursor.");
      String eventCursor = (String) at;
      String type = event.get("type") instanceof String text ? text : "";
      switch (type) {
        case "line" -> {
          Object step = event.get("step");
          if (!(event.get("text") instanceof String)
              || !("stdout".equals(event.get("stream")) || "stderr".equals(event.get("stream")))
              || !safeInteger(event.get("at"))
              || ((Number) event.get("at")).longValue() < 0
              || !event.containsKey("step")
              || (step != null && !(step instanceof String))
              || !validCursor(eventCursor))
            throw invalid("Retry the log from the last received cursor.");
          if (!seen.add(eventCursor)) return null;
          if (seen.size() > 10_000) {
            Iterator<String> oldest = seen.iterator();
            oldest.next();
            oldest.remove();
          }
          cursor = eventCursor;
          failures = 0;
          return new BuildLogEvent(event);
        }
        case "gap" -> {
          if (!validCursor(event.get("earliestCursor")) || (cursor != null && !Objects.equals(eventCursor, cursor)))
            throw invalid("Retry from the last received cursor.");
          cursor = eventCursor;
          return new BuildLogEvent(event);
        }
        case "terminal" -> {
          if ((cursor != null && !Objects.equals(eventCursor, cursor))
              || !TERMINAL.contains(event.get("state"))
              || !nonEmpty(event.get("reason"))
              || !validFailure(event)
              || (!"failed".equals(event.get("state")) && event.get("failingStep") != null))
            throw invalid("Retry the log from the last received cursor.");
          ended = true;
          current.close();
          return new BuildLogEvent(event);
        }
        case "continue" -> {
          if (cursor != null && !Objects.equals(eventCursor, cursor))
            throw failure("build_log_gap", "Resume from details.cursor; report a persistent missing log line.", cursor);
          cursor = eventCursor;
          dropped(true);
          return null;
        }
        case "error" -> {
          if (!Objects.equals(eventCursor, cursor) || !nonEmpty(event.get("code")) || !nonEmpty(event.get("hint")))
            throw invalid("Retry the log from the last received cursor.");
          throw failure((String) event.get("code"), (String) event.get("hint"), cursor);
        }
        default -> throw invalid("Retry the log from the last received cursor.");
      }
    }

    /** The connection ended: reopen it from the cursor after a pause, or give up. */
    private void dropped(boolean continued) {
      current.close();
      current = null;
      if (!continued && ++failures > 3)
        throw failure("build_log_interrupted", "Reconnect with followLogs(id, new LogOptions().cursor(details.cursor)).", cursor);
      // A disconnected service or repeated continuations must not busy-loop.
      try {
        if (!cancellation.await(Duration.ofMillis(50L * Math.max(1, failures)))) {
          if (isClosed()) return;
          throw timeout(null);
        }
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw timeout(interrupted);
      }
    }

    @Override
    public void close() {
      super.close();
      cancellation.cancel();
      if (timer != null) timer.cancel(false);
      EventStream<JsonObject> active = current;
      if (active != null) active.close();
    }
  }

  /**
   * {@code runtime.builds().repositories()}: connected repositories. Every push to a repository's
   * production branch builds it and deploys the build.
   */
  public static final class Repositories {
    private final Transport t;

    Repositories(Transport transport) {
      this.t = transport;
    }

    private static String path(String id, String rest) {
      return "/v1/repositories/" + Transport.segment(id) + rest;
    }

    public Repository connect(ConnectRepository input) {
      return new Repository(t.object(new Transport.Call("POST", "/v1/repositories").body(input.toMap()).key(input.idempotencyKey)));
    }

    public Page<Repository> list() {
      return list(null);
    }

    public Page<Repository> list(ListResources filter) {
      return ListResources.read(t, "/v1/repositories", filter, Repository::new);
    }

    /** Changes its settings in place; its id and builds stay. */
    public Repository update(String id, ChangeRepository change) {
      return new Repository(t.object(new Transport.Call("POST", path(id, ":update")).body(change.toMap()).key(change.idempotencyKey)));
    }

    public Repository disconnect(String id) {
      return new Repository(t.object(new Transport.Call("DELETE", path(id, ""))));
    }

    /**
     * A link to install Runtime's GitHub App, so private repositories build. Open it in a browser
     * within 15 minutes, install the App on the account and repositories Runtime may read, and
     * confirm the organization; then {@link #connect} the repository with provider github.
     */
    public GithubInstall installGithub() {
      return new GithubInstall(t.object(new Transport.Call("POST", "/v1/repositories/github:install")));
    }
  }

  /** A link to install Runtime's GitHub App, and when it expires. */
  public static final class GithubInstall extends JsonObject {
    GithubInstall(Map<String, Object> raw) {
      super(raw);
    }

    public String url() {
      return getString("url");
    }

    /** An ISO 8601 time. */
    public String expiresAt() {
      return getString("expiresAt");
    }
  }
}
