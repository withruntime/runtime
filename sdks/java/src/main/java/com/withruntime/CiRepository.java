package com.withruntime;

import java.util.Map;

/** A GitHub repository connected for CI/CD checks. */
public final class CiRepository extends JsonObject {
  CiRepository(Map<String, Object> raw) {
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

  /** Milliseconds since the epoch. */
  public long createdAt() {
    return getLong("createdAt", 0);
  }

  /** Milliseconds since the epoch. */
  public long updatedAt() {
    return getLong("updatedAt", 0);
  }

  /** Milliseconds since the epoch, or null. */
  public Long deletedAt() {
    return getLong("deletedAt");
  }

  /** owner/name on GitHub. */
  public String repository() {
    return getString("repository");
  }

  /** The branch whose pushes are checked as landed. */
  public String productionBranch() {
    return getString("productionBranch");
  }

  /**
   * Where in the repository its checks are written: a runtime.yml, or a cloudbuild.yaml or
   * buildspec.yml, run as Cloud Build or CodeBuild runs it.
   */
  public String configPath() {
    return getString("configPath");
  }

  /** The installation of Runtime's GitHub App it is read through. */
  public Long installation() {
    return getLong("installation");
  }

  public Long githubRepositoryId() {
    return getLong("githubRepositoryId");
  }

  /**
   * Whether a red production branch's culprit is undone by a pull request CI/CD opens: off until
   * {@code setUndo} turns it on.
   */
  public boolean undoCulprits() {
    return getBoolean("undoCulprits");
  }

  /** connected or disconnected. */
  public String state() {
    return getString("state");
  }
}
