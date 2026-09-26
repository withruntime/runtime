package com.withruntime;

import java.util.Map;

/**
 * One event of a command's or a process's output: start, stdout, stderr, exit, truncated,
 * continue or error.
 */
public final class OutputEvent extends JsonObject {
  OutputEvent(Map<String, Object> raw) {
    super(raw);
  }

  public String type() {
    return getString("type");
  }

  public String processId() {
    return getString("processId");
  }

  /** The text of a stdout or stderr event. */
  public String data() {
    String text = getString("data");
    return text == null ? "" : text;
  }

  /** A stdout or stderr event's first byte's position in the stream. */
  public long offset() {
    return getLong("offset", 0);
  }

  /** An exit event's code, or null. */
  public Integer exitCode() {
    Long code = getLong("exitCode");
    return code == null ? null : code.intValue();
  }

  public boolean timedOut() {
    return getBoolean("timedOut");
  }

  public Long durationMs() {
    return getLong("durationMs");
  }

  /** A continue event's cursor: where to resume following. */
  public long cursor() {
    return getLong("cursor", 0);
  }
}
