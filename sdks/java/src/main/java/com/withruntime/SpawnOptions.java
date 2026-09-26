package com.withruntime;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/** A background process's options, every one optional. */
public final class SpawnOptions {
  public SpawnOptions() {}

  String cwd;
  Map<String, String> env;
  Duration timeout;
  byte[] stdin;
  boolean pipeStdin;
  Integer cols;
  Integer rows;
  String idempotencyKey;

  public SpawnOptions cwd(String cwd) {
    this.cwd = cwd;
    return this;
  }

  public SpawnOptions env(String name, String value) {
    if (env == null) env = new LinkedHashMap<>();
    env.put(name, value);
    return this;
  }

  public SpawnOptions timeout(Duration timeout) {
    this.timeout = timeout;
    return this;
  }

  /** Given once, then closed. */
  public SpawnOptions stdin(String text) {
    this.stdin = text.getBytes(StandardCharsets.UTF_8);
    return this;
  }

  /** Keep standard input open for {@link SandboxProcess#write}. */
  public SpawnOptions pipeStdin() {
    this.pipeStdin = true;
    return this;
  }

  /** Give the process a terminal of this size. */
  public SpawnOptions pty(int cols, int rows) {
    this.cols = cols;
    this.rows = rows;
    return this;
  }

  public SpawnOptions idempotencyKey(String key) {
    this.idempotencyKey = key;
    return this;
  }
}
