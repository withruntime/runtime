package com.withruntime;

import java.util.Map;

/**
 * A line of a repository's file that a CI/CD job's log reports, as the job's GitHub check run
 * shows it on the pull request.
 */
public final class CiAnnotation extends JsonObject {
  CiAnnotation(Map<String, Object> raw) {
    super(raw);
  }

  /** The file's path in the repository. */
  public String path() {
    return getString("path");
  }

  public long startLine() {
    return getLong("startLine", 1);
  }

  public long endLine() {
    return getLong("endLine", 1);
  }

  /** Present only for a single line; null otherwise. */
  public Long startColumn() {
    return getLong("startColumn");
  }

  /** notice, warning or failure. */
  public String level() {
    return getString("level");
  }

  public String message() {
    return getString("message");
  }

  /** null when the log gave none. */
  public String title() {
    return getString("title");
  }
}
