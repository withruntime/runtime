package com.withruntime;

import java.util.Map;

/**
 * One event of a followed App or Function log: a {@code line}, or a {@code gap} (lines the store
 * dropped before they could be read; the follow goes on). A continuation is followed and an error
 * event is thrown, so neither is given out.
 */
public final class AppLogEvent extends AppLogLine {
  AppLogEvent(Map<String, Object> raw) {
    super(raw);
  }

  /** line or gap. */
  public String type() {
    return getString("type");
  }

  /** Where a follow resumes after this event: pass it as {@link AppLogsOptions#cursor(String)}. */
  public String cursor() {
    return getString("cursor");
  }

  /** An error event's code; null on a line or a gap. */
  public String code() {
    return getString("code");
  }

  /** An error event's hint; null on a line or a gap. */
  public String hint() {
    return getString("hint");
  }
}
