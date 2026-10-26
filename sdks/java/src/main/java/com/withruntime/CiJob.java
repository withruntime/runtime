package com.withruntime;

import java.util.List;
import java.util.Map;

/**
 * One job of a check's plan: a step, or one part of a step split in parts. Times are milliseconds
 * since the epoch.
 */
public class CiJob extends JsonObject {
  CiJob(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String checkId() {
    return getString("checkId");
  }

  public String repositoryId() {
    return getString("repositoryId");
  }

  public String name() {
    return getString("name");
  }

  public long part() {
    return getLong("part", 1);
  }

  public long parts() {
    return getLong("parts", 1);
  }

  /** The names of the jobs it waits for. */
  public List<String> needs() {
    return getStrings("needs");
  }

  public String command() {
    return getString("command");
  }

  public String cacheKey() {
    return getString("cacheKey");
  }

  /** queued, running, passed, failed, flaky, cached, cancelled or skipped. */
  public String state() {
    return getString("state");
  }

  /** The passed job a cached one stands on. */
  public String cachedFrom() {
    return getString("cachedFrom");
  }

  public Long exitCode() {
    return getLong("exitCode");
  }

  public String reason() {
    return getString("reason");
  }

  /**
   * The sandboxes it ran in. A failure's may be kept paused: wake it, or exec in it, with the
   * sandbox calls.
   */
  public List<String> sandboxIds() {
    return getStrings("sandboxIds");
  }

  /**
   * The ID of the job's own GitHub check run, {@code runtime / <name>}, created completed when the
   * job ends; null while it runs, for a reused pass, or when GitHub did not accept the run.
   */
  public Long githubCheckRun() {
    return getLong("githubCheckRun");
  }

  /**
   * Lines of the repository's files that the job's log reports as failing, or as warnings and
   * notices, as its GitHub check run shows them. At most 50, failures first; empty while it runs.
   */
  public List<CiAnnotation> annotations() {
    return getObjects("annotations", CiAnnotation::new);
  }

  /** A review step's verdict on the commit; null for a command's job. */
  public CiReview review() {
    return has("review") ? new CiReview(map(get("review"))) : null;
  }

  /** How long it took, in milliseconds. */
  public Long ms() {
    return getLong("ms");
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
