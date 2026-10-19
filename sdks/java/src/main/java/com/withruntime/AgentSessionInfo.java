package com.withruntime;

import java.time.Instant;
import java.util.Map;

/** A session as the API answers it: one piece of an agent's work, in its own sandbox. */
public final class AgentSessionInfo extends JsonObject {
  AgentSessionInfo(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String agentId() {
    return getString("agentId");
  }

  /** The agent's version it runs: an update reaches only later sessions. */
  public long agentVersion() {
    return getLong("agentVersion", 0);
  }

  /** The key that joins words to it (your own, such as {@code customer:42}), or null. */
  public String key() {
    return getString("key");
  }

  /** What started it: api, slack, github, schedule or webhook. */
  public String trigger() {
    return getString("trigger");
  }

  /** queued, running, waiting, done, failed or stopped. */
  public String state() {
    return getString("state");
  }

  /** Whether it has ended: done, failed or stopped. */
  public boolean ended() {
    String state = state();
    return "done".equals(state) || "failed".equals(state) || "stopped".equals(state);
  }

  /** Why it failed or stopped, or null. */
  public String reason() {
    return getString("reason");
  }

  /** What it ended with, as the agent said it (a pull request's address, an answer), or null. */
  public String result() {
    return getString("result");
  }

  /** Its sandbox, an ordinary sandbox of the account, or null before it runs. */
  public String sandboxId() {
    return getString("sandboxId");
  }

  /** The seq of its log's last event. */
  public long lastSeq() {
    return getLong("lastSeq", 0);
  }

  public Map<String, String> labels() {
    return getStringMap("labels");
  }

  public Instant createdAt() {
    return getInstant("createdAt");
  }

  public Instant startedAt() {
    return getInstant("startedAt");
  }

  public Instant endedAt() {
    return getInstant("endedAt");
  }

  /** The session that started this child session, or null (and null until the API sends it). */
  public String parentSessionId() {
    return getString("parentSessionId");
  }

  /** The session its tree began with, or null (and null until the API sends it). */
  public String rootSessionId() {
    return getString("rootSessionId");
  }

  /** What it has used so far, or null until the API sends it. */
  public Cost cost() {
    return get("cost") instanceof Map<?, ?> ? new Cost(getObject("cost").raw()) : null;
  }

  /** What it and its child sessions have used so far, or null until the API sends it. */
  public Cost treeCost() {
    return get("treeCost") instanceof Map<?, ?> ? new Cost(getObject("treeCost").raw()) : null;
  }

  /**
   * Its text history, counted as storage and kept until the session is deleted; null until the API
   * sends it.
   */
  public Long historyBytes() {
    return getLong("historyBytes");
  }

  /** Its files and screenshots, counted as storage; null until the API sends it. */
  public Long attachmentBytes() {
    return getLong("attachmentBytes");
  }

  /** What a session (or its tree) has used: dollars, vCPU-seconds and GiB-seconds. */
  public static final class Cost extends JsonObject {
    Cost(Map<String, Object> raw) {
      super(raw);
    }

    public double dollars() {
      Double value = getDouble("dollars");
      return value == null ? 0 : value;
    }

    public double vcpuSeconds() {
      Double value = getDouble("vcpuSeconds");
      return value == null ? 0 : value;
    }

    public double gibSeconds() {
      Double value = getDouble("gibSeconds");
      return value == null ? 0 : value;
    }
  }
}
