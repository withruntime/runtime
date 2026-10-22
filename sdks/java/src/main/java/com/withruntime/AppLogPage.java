package com.withruntime;

import java.util.List;
import java.util.Map;

/** One page of an App's or a Function's log: the newest lines of the window, oldest first. */
public final class AppLogPage extends JsonObject {
  AppLogPage(Map<String, Object> raw) {
    super(raw);
  }

  public List<AppLogLine> lines() {
    return getObjects("lines", AppLogLine::new);
  }

  /**
   * The cursor of the next older page, or null: pass it as {@link AppLogsOptions#cursor(String)} with the
   * same since, version, copy and stream.
   */
  public String nextCursor() {
    return getString("nextCursor");
  }

  public boolean hasMore() {
    return getBoolean("hasMore");
  }
}
