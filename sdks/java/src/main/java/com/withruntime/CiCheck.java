package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One CI/CD check: a commit of a connected repository, run as its plan of jobs. Times are
 * milliseconds since the epoch.
 */
public class CiCheck extends JsonObject {
  CiCheck(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String repositoryId() {
    return getString("repositoryId");
  }

  /** owner/name on GitHub. */
  public String repository() {
    return getString("repository");
  }

  /** The full commit SHA. */
  public String commit() {
    return getString("commit");
  }

  public String branch() {
    return getString("branch");
  }

  /** push, pull_request, merge_group or rerun. */
  public String event() {
    return getString("event");
  }

  public Long pullRequest() {
    return getLong("pullRequest");
  }

  public String baseCommit() {
    return getString("baseCommit");
  }

  /** The GitHub login that pushed, opened or re-ran it. */
  public String actor() {
    return getString("actor");
  }

  /** The repository's writers' code. A fork's pull request is not. */
  public boolean trusted() {
    return getBoolean("trusted");
  }

  /** Queued for a writer's approval: nothing of it runs. */
  public boolean waiting() {
    return getBoolean("waiting");
  }

  public String approvedBy() {
    return getString("approvedBy");
  }

  public Long approvedAt() {
    return getLong("approvedAt");
  }

  /** Writers' code on the production branch, or a merge group. */
  public boolean landed() {
    return getBoolean("landed");
  }

  /** queued, running, passed, failed or cancelled. */
  public String state() {
    return getString("state");
  }

  /** Why it ended, or null. */
  public String reason() {
    return getString("reason");
  }

  /** How many of its jobs are in each job state. */
  public Map<String, Long> counts() {
    Map<String, Long> out = new LinkedHashMap<>();
    JsonObject counts = getObject("counts");
    for (String state : counts.raw().keySet()) out.put(state, counts.getLong(state, 0));
    return out;
  }

  /**
   * Where its machines came from and how soon, or null until the runner says: reused (its pull
   * request's own, paused since its last push), pooled, forked (in forks batch forks), created,
   * kept (for the next push), firstMs, readyMs, firstTestMs and lineMs (its wait in the account's
   * line).
   */
  public JsonObject machines() {
    return raw().get("machines") == null ? null : getObject("machines");
  }

  public long createdAt() {
    return getLong("createdAt", 0);
  }

  public long updatedAt() {
    return getLong("updatedAt", 0);
  }

  public Long startedAt() {
    return getLong("startedAt");
  }

  public Long endedAt() {
    return getLong("endedAt");
  }
}
