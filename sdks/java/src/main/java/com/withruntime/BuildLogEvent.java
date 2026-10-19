package com.withruntime;

import java.util.Map;

/**
 * One event of a followed build log: a {@code line}, a {@code gap} (lines older than {@link
 * #earliestCursor()} are gone), or the {@code terminal} event the follow ends with.
 */
public final class BuildLogEvent extends BuildLog.Line {
  BuildLogEvent(Map<String, Object> raw) {
    super(raw);
  }

  /** line, gap or terminal. */
  public String type() {
    return getString("type");
  }

  /** A gap's oldest cursor still kept. */
  public String earliestCursor() {
    return getString("earliestCursor");
  }

  /** The terminal state: succeeded, failed, cancelled or superseded. */
  public String state() {
    return getString("state");
  }

  /** Why the build ended so. */
  public String reason() {
    return getString("reason");
  }

  /** The step that failed, or null. */
  public BuildLog.FailingStep failingStep() {
    return has("failingStep") ? new BuildLog.FailingStep(getObject("failingStep").raw()) : null;
  }
}
