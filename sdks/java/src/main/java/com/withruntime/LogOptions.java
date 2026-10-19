package com.withruntime;

import java.time.Duration;

/** Where a build log is read from. Every field is optional. */
public final class LogOptions {
  public LogOptions() {}

  String cursor;
  String pageCursor;
  Duration timeout = Duration.ofMinutes(2);

  /** An opaque cursor: a follow resumes after it. */
  public LogOptions cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }

  /** Pages older search results; never with a follow. */
  public LogOptions pageCursor(String pageCursor) {
    this.pageCursor = pageCursor;
    return this;
  }

  /** A follow's whole deadline, reconnections included. Default 2 minutes; zero has none. */
  public LogOptions timeout(Duration timeout) {
    this.timeout = timeout;
    return this;
  }
}
