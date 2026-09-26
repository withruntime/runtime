package com.withruntime;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;

/** A command's options, every one optional. */
public final class ExecOptions {
  public ExecOptions() {}

  String cwd;
  Map<String, String> env;
  byte[] stdin;
  Duration timeout;
  Consumer<String> onStdout;
  Consumer<String> onStderr;
  boolean check;
  String idempotencyKey;

  /** The working directory. Default /workspace. */
  public ExecOptions cwd(String cwd) {
    this.cwd = cwd;
    return this;
  }

  /** Merged over the sandbox's environment. Put secrets here, never in the command. */
  public ExecOptions env(String name, String value) {
    if (env == null) env = new LinkedHashMap<>();
    env.put(name, value);
    return this;
  }

  public ExecOptions env(Map<String, String> values) {
    if (env == null) env = new LinkedHashMap<>();
    env.putAll(values);
    return this;
  }

  /** Given to standard input, then closed. */
  public ExecOptions stdin(byte[] data) {
    this.stdin = data.clone();
    return this;
  }

  public ExecOptions stdin(String text) {
    return stdin(text.getBytes(StandardCharsets.UTF_8));
  }

  /** Default 60 seconds; up to 24 hours. A timeout is a result, not an exception. */
  public ExecOptions timeout(Duration timeout) {
    this.timeout = timeout;
    return this;
  }

  /** Receives standard output as it happens. Streams the command; the result keeps everything. */
  public ExecOptions onStdout(Consumer<String> callback) {
    this.onStdout = callback;
    return this;
  }

  public ExecOptions onStderr(Consumer<String> callback) {
    this.onStderr = callback;
    return this;
  }

  /** Throw {@link RuntimeCloudException.Command} when the exit code is not 0 or it timed out. */
  public ExecOptions check(boolean check) {
    this.check = check;
    return this;
  }

  public ExecOptions idempotencyKey(String key) {
    this.idempotencyKey = key;
    return this;
  }
}
