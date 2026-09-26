package com.withruntime;

import java.util.Map;

/** A finished command. A timeout is a result ({@link #timedOut()}), not an exception. */
public final class CommandResult extends JsonObject {
  CommandResult(Map<String, Object> raw) {
    super(raw);
  }

  /** The exit code, or null when there is none (a timeout, a signal). */
  public Integer exitCode() {
    Long code = getLong("exitCode");
    return code == null ? null : code.intValue();
  }

  public String stdout() {
    String text = getString("stdout");
    return text == null ? "" : text;
  }

  public String stderr() {
    String text = getString("stderr");
    return text == null ? "" : text;
  }

  public boolean timedOut() {
    return getBoolean("timedOut");
  }

  /** More than 64 KiB of standard output was dropped from a result that was not streamed. */
  public boolean stdoutTruncated() {
    return getBoolean("stdoutTruncated");
  }

  public boolean stderrTruncated() {
    return getBoolean("stderrTruncated");
  }

  public Long durationMs() {
    return getLong("durationMs");
  }

  public String processId() {
    return getString("processId");
  }

  /** Exit code 0 and no timeout. */
  public boolean ok() {
    return !timedOut() && Integer.valueOf(0).equals(exitCode());
  }
}
