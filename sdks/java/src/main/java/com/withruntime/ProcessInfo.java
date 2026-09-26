package com.withruntime;

import java.util.Map;

/** A background process. */
public final class ProcessInfo extends JsonObject {
  ProcessInfo(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  /** running, exited, killed, timed_out or unknown. */
  public String state() {
    return getString("state");
  }

  public Integer exitCode() {
    Long code = getLong("exitCode");
    return code == null ? null : code.intValue();
  }

  public String command() {
    return getString("command");
  }

  public String cwd() {
    return getString("cwd");
  }

  public boolean pty() {
    return getBoolean("pty");
  }

  public boolean stdinOpen() {
    return getBoolean("stdinOpen");
  }

  public long stdinOffset() {
    return getLong("stdinOffset", 0);
  }
}
