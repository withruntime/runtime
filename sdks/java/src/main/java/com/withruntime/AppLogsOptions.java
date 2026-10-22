package com.withruntime;

/**
 * Which log lines of an App or a Function to read. Every field is optional; a page and a follow
 * take the same ones.
 */
public final class AppLogsOptions {
  public AppLogsOptions() {}

  String since;
  Integer version;
  String copy;
  String stream;
  Integer limit;
  String cursor;

  /**
   * How far back: an RFC 3339 time (2026-10-18T20:00:00Z) or a duration back from now, digits then
   * s, m, h or d (30s, 15m, 2h, 7d). Default 1h; at most 14 days back.
   */
  public AppLogsOptions since(String since) {
    this.since = since;
    return this;
  }

  /** Only that version's copies (1 or more). */
  public AppLogsOptions version(Integer version) {
    this.version = version;
    return this;
  }

  /** Only that copy, by its id. */
  public AppLogsOptions copy(String copy) {
    this.copy = copy;
    return this;
  }

  /** stdout or stderr. */
  public AppLogsOptions stream(String stream) {
    this.stream = stream;
    return this;
  }

  /** The newest this many lines (1 to 500, default 100): a page's size, or a follow's backlog. */
  public AppLogsOptions limit(Integer limit) {
    this.limit = limit;
    return this;
  }

  /**
   * An opaque cursor: a page's nextCursor reads the next older page (keep the same since, version,
   * copy and stream); a follow's cursor resumes just after that line.
   */
  public AppLogsOptions cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }
}
