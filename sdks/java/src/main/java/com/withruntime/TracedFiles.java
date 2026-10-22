package com.withruntime;

import java.util.List;
import java.util.Map;

/**
 * The files a traced command opened ({@link ExecOptions#traceFiles()}): what it, and anything it
 * started, read and wrote.
 */
public final class TracedFiles extends JsonObject {
  TracedFiles(Map<String, Object> raw) {
    super(raw);
  }

  /**
   * Every file and directory it opened: sorted absolute paths with links resolved, directories
   * ending in "/".
   */
  public List<String> read() {
    return getStrings("read");
  }

  /** Every file it wrote. */
  public List<String> written() {
    return getStrings("written");
  }

  /** Some paths are missing, so do not treat the lists as complete. */
  public boolean truncated() {
    return getBoolean("truncated");
  }
}
