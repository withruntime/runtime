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

  /**
   * Standard output is not whole: {@link ExecOptions#maxOutputBytes} cut it, or (rarely) output was
   * lost. {@link #stdoutBytes()} says how much there was.
   */
  public boolean stdoutTruncated() {
    return getBoolean("stdoutTruncated");
  }

  public boolean stderrTruncated() {
    return getBoolean("stderrTruncated");
  }

  /** {@link #stdoutTruncated()} or {@link #stderrTruncated()}. */
  public boolean truncated() {
    return stdoutTruncated() || stderrTruncated();
  }

  /** Bytes the command wrote to standard output, returned or not; null from an older sandbox. */
  public Long stdoutBytes() {
    return getLong("stdoutBytes");
  }

  public Long stderrBytes() {
    return getLong("stderrBytes");
  }

  public Long durationMs() {
    return getLong("durationMs");
  }

  public String processId() {
    return getString("processId");
  }

  /** The files it read and wrote when it ran with {@link ExecOptions#traceFiles}; null otherwise. */
  public TracedFiles files() {
    return has("files") ? new TracedFiles(map(get("files"))) : null;
  }

  /** Exit code 0 and no timeout. */
  public boolean ok() {
    return !timedOut() && Integer.valueOf(0).equals(exitCode());
  }
}
