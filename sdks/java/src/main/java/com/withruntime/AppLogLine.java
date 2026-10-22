package com.withruntime;

import java.util.Map;

/** One line a copy of an App or a Function printed. */
public class AppLogLine extends JsonObject {
  AppLogLine(Map<String, Object> raw) {
    super(raw);
  }

  /** When it was printed, in Unix milliseconds. */
  public long at() {
    return getLong("at", 0);
  }

  /** stdout or stderr. */
  public String stream() {
    return getString("stream");
  }

  /** The id of the copy that printed it, or null. */
  public String copy() {
    return getString("copy");
  }

  /** The version that copy runs, or null. */
  public Long version() {
    return getLong("version");
  }

  public String text() {
    return getString("text");
  }
}
