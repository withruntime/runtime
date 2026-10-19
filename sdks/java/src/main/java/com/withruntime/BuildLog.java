package com.withruntime;

import java.util.List;
import java.util.Map;

/** One page of a build's log: its last lines, or a page of older ones, and how it ended. */
public final class BuildLog extends JsonObject {
  BuildLog(Map<String, Object> raw) {
    super(raw);
  }

  public List<Line> lines() {
    return getObjects("lines", Line::new);
  }

  /** Where a follow resumes after these lines. */
  public String cursor() {
    return getString("cursor");
  }

  public String state() {
    return getString("state");
  }

  public String reason() {
    return getString("reason");
  }

  /** The step that failed, or null. */
  public FailingStep failingStep() {
    return has("failingStep") ? new FailingStep(getObject("failingStep").raw()) : null;
  }

  public boolean hasMore() {
    return getBoolean("hasMore");
  }

  /** The pageCursor of the next page, or null. */
  public String nextCursor() {
    return getString("nextCursor");
  }

  /** One line the build wrote. */
  public static class Line extends JsonObject {
    Line(Map<String, Object> raw) {
      super(raw);
    }

    public String cursor() {
      return getString("cursor");
    }

    /** Unix milliseconds. */
    public long at() {
      return getLong("at", 0);
    }

    /** The step that wrote it, or null. */
    public String step() {
      return getString("step");
    }

    public String text() {
      return getString("text");
    }

    /** stdout or stderr. */
    public String stream() {
      return getString("stream");
    }
  }

  /** The step that failed: its name, exit code (null when it had none) and last lines. */
  public static final class FailingStep extends JsonObject {
    FailingStep(Map<String, Object> raw) {
      super(raw);
    }

    public String name() {
      return getString("name");
    }

    public Long exitCode() {
      return getLong("exitCode");
    }

    public List<String> lastLines() {
      return getStrings("lastLines");
    }
  }
}
