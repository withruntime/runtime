package com.withruntime;

import java.util.Map;

/**
 * An App or a Function: copies of one server that wake on demand. A Function is an App that keeps
 * no copy awake ({@link #minCopies()} is 0). Its state is waiting (no version yet), live, failed,
 * deleting or deleted; a deploy is followed by its own record, {@link AppDeploy}.
 */
public final class App extends JsonObject {
  App(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String name() {
    return getString("name");
  }

  public Map<String, String> labels() {
    return getStringMap("labels");
  }

  /** waiting, live, failed, deleting or deleted. */
  public String state() {
    return getString("state");
  }

  /** Why it failed, with code and message; null when it has not. */
  public JsonObject error() {
    return has("error") ? getObject("error") : null;
  }

  /** The version serving now, or null before the first deploy goes live. */
  public Long liveVersion() {
    return getLong("liveVersion");
  }

  /** The version a rollback returns to, or null. */
  public Long previousVersion() {
    return getLong("previousVersion");
  }

  public int minCopies() {
    return (int) getLong("minCopies", 0);
  }

  public int maxCopies() {
    return (int) getLong("maxCopies", 0);
  }

  /** Requests one copy serves at once. */
  public int concurrency() {
    return (int) getLong("concurrency", 0);
  }

  /** Copies kept ready beyond those serving. */
  public int spares() {
    return (int) getLong("spares", 0);
  }

  public int vcpu() {
    return (int) getLong("vcpu", 0);
  }

  public int memoryMiB() {
    return (int) getLong("memoryMiB", 0);
  }

  public int port() {
    return (int) getLong("port", 0);
  }

  /** The path that answers 200 when a copy is healthy, or null to check the port accepts. */
  public String healthPath() {
    return getString("healthPath");
  }

  /** What a new version's failures after it went live do: rollback, alert or off; null if unset. */
  public String releaseWatch() {
    return getString("releaseWatch");
  }

  /** Unix milliseconds. */
  public long createdAt() {
    return getLong("createdAt", 0);
  }

  public long updatedAt() {
    return getLong("updatedAt", 0);
  }

  /** Unix milliseconds, or null while it is not deleted. */
  public Long deletedAt() {
    return getLong("deletedAt");
  }
}
