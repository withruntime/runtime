package com.withruntime;

import java.util.Map;

/** One build of a connected repository at a ref. */
public final class Build extends JsonObject {
  Build(Map<String, Object> raw) {
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

  /** queued, fetching, building, deploying, succeeded, failed, cancelled or superseded. */
  public String state() {
    return getString("state");
  }

  /** Why it ended as it did, or null. */
  public String reason() {
    return getString("reason");
  }

  /** Why it failed, with code and message; null when it has not. */
  public JsonObject error() {
    return has("error") ? getObject("error") : null;
  }

  public String repositoryId() {
    return getString("repositoryId");
  }

  public String ref() {
    return getString("ref");
  }

  /** The branch whose move asked for it, when the caller said. */
  public String branch() {
    return getString("branch");
  }

  /** The commit it built, once fetched. */
  public String commit() {
    return getString("commit");
  }

  /**
   * Milliseconds per step once the runner is done (install, build, mirror, fork, snapshot, total,
   * ...); null until then.
   */
  public Map<String, Long> timings() {
    if (!has("timings")) return null;
    Map<String, Long> out = new java.util.LinkedHashMap<>();
    JsonObject timings = getObject("timings");
    for (String step : timings.raw().keySet()) out.put(step, timings.getLong(step));
    return out;
  }

  /**
   * The saved server an App deploys, once a build of a repository with a start command
   * succeeded; null otherwise.
   */
  public String outputSnapshotId() {
    return getString("outputSnapshotId");
  }

  /**
   * The framework detected in the build folder for the commands its repository leaves unset
   * (nextjs, vite, fastapi, django, rails, go, docker, ...); null when none was or every command
   * is set.
   */
  public String framework() {
    return getString("framework");
  }

  /** Unix milliseconds. */
  public long createdAt() {
    return getLong("createdAt", 0);
  }

  public long updatedAt() {
    return getLong("updatedAt", 0);
  }
}
